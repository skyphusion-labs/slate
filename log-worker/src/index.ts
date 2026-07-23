// log-worker
//
// Lightweight log-ingestion Worker backed by R2. Services POST batches of log
// lines; operators read them back with /tail. R2 has no append, so each flush
// is its own time-sortable object and /tail stitches the most recent ones.
//
// Endpoints (all except /health require X-Log-Secret):
//   GET  /health
//   POST /ingest?service=<name>     body = raw text, one log line per \n
//   GET  /tail?service=<name>&limit=<n>&hours=<h>&grep=<substr>

interface Env {
  LOGS: R2Bucket;
  LOG_SECRET: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Log-Secret",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/** Constant-time secret compare (K3: pad both sides to same length; no length short-circuit). */
function secretsMatch(provided: string, configured: string, minLength = 16): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(configured);
  const n = Math.max(a.length, b.length, 1);
  const pa = new Uint8Array(n);
  const pb = new Uint8Array(n);
  pa.set(a);
  pb.set(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= pa[i]! ^ pb[i]!;
  const longEnough = configured.length >= minLength ? 0 : 1;
  return (diff | longEnough) === 0;
}

const MAX_INGEST_BYTES = 1_048_576; // 1 MiB cap per flush (K3: unbounded R2 writes)

// Sanitize a caller-supplied service name to a safe R2 key segment.
function safeService(raw: string | null): string {
  const s = (raw ?? "slate").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return s || "slate";
}

// UTC YYYY-MM-DD/HH bucket for a given epoch-ms.
function hourBucket(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}/${p(d.getUTCHours())}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });

    const secret = req.headers.get("X-Log-Secret");
    if (!secret || !secretsMatch(secret, env.LOG_SECRET)) return json({ error: "Unauthorized" }, 401);

    if (req.method === "POST" && url.pathname === "/ingest") return handleIngest(req, env, url);
    if (req.method === "GET" && url.pathname === "/tail") return handleTail(env, url);

    return json({ error: "Not found" }, 404);
  },
};

async function handleIngest(req: Request, env: Env, url: URL): Promise<Response> {
  const service = safeService(url.searchParams.get("service"));
  const declared = parseInt(req.headers.get("content-length") ?? "0", 10) || 0;
  if (declared > MAX_INGEST_BYTES) {
    return json({ error: "Payload too large", max_bytes: MAX_INGEST_BYTES }, 413);
  }
  const body = await req.text();
  if (body.length > MAX_INGEST_BYTES) {
    return json({ error: "Payload too large", max_bytes: MAX_INGEST_BYTES }, 413);
  }
  if (!body.trim()) return json({ ok: true, bytes: 0, skipped: "empty" });

  const now = Date.now();
  // Random suffix keeps concurrent flushes in the same ms from colliding.
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `${service}/${hourBucket(now)}/${String(now).padStart(15, "0")}-${rand}.log`;

  await env.LOGS.put(key, body, {
    httpMetadata: { contentType: "text/plain" },
  });

  return json({ ok: true, key, bytes: body.length });
}

async function handleTail(env: Env, url: URL): Promise<Response> {
  const service = safeService(url.searchParams.get("service"));
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 2000);
  const hours = Math.min(parseInt(url.searchParams.get("hours") ?? "6", 10) || 6, 72);
  const grep = url.searchParams.get("grep");

  // Walk back hour-by-hour collecting object keys (each hour prefix is small),
  // newest hour first, until we have enough objects to satisfy the limit.
  const now = Date.now();
  const keys: string[] = [];
  for (let h = 0; h < hours; h++) {
    const prefix = `${service}/${hourBucket(now - h * 3_600_000)}/`;
    let cursor: string | undefined;
    do {
      const listed = await env.LOGS.list({ prefix, cursor, limit: 1000 });
      for (const o of listed.objects) keys.push(o.key);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    // Keys sort lexicographically by epoch-ms, so once we plausibly have far
    // more objects than lines requested, stop reaching further back.
    if (keys.length >= limit) break;
  }

  keys.sort(); // ascending by time

  // Fetch newest-first until we have enough lines, then return the last `limit`.
  const lines: string[] = [];
  for (let i = keys.length - 1; i >= 0 && lines.length < limit; i--) {
    const obj = await env.LOGS.get(keys[i]);
    if (!obj) continue;
    const text = await obj.text();
    const objLines = text.split("\n").filter(Boolean);
    lines.unshift(...objLines);
  }

  let out = lines;
  if (grep) out = out.filter((l) => l.includes(grep));
  out = out.slice(-limit);

  return json({ service, count: out.length, lines: out });
}
