// vivijure-search Worker
//
// Endpoints (all require X-Search-Secret header except /health):
//   GET  /health
//   POST /search  { query, type?: "web"|"research" }
//   POST /fetch   { url }
//   POST /knowledge/index   { content, title?, author? }
//   POST /knowledge/search  { query, topK?: number }

import puppeteer from "@cloudflare/puppeteer";

interface Env {
  BROWSER: Fetcher;
  AI: Ai;
  KNOWLEDGE: VectorizeIndex;
  BRAVE_API_KEY: string;
  TAVILY_API_KEY: string;
  SEARCH_SECRET: string;
}

interface BraveResult {
  title: string;
  url: string;
  description?: string;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Search-Secret",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });

    const secret = req.headers.get("X-Search-Secret");
    if (!secret || secret !== env.SEARCH_SECRET) return err("Unauthorized", 401);
    if (req.method !== "POST") return err("Method not allowed", 405);

    if (url.pathname === "/search")           return handleSearch(req, env);
    if (url.pathname === "/fetch")            return handleFetch(req, env);
    if (url.pathname === "/knowledge/index")  return handleKnowledgeIndex(req, env);
    if (url.pathname === "/knowledge/search") return handleKnowledgeSearch(req, env);

    return err("Not found", 404);
  },
};

// ---------------------------------------------------------------------------
// Web search (Brave) + deep research (Tavily)
// ---------------------------------------------------------------------------

async function handleSearch(req: Request, env: Env): Promise<Response> {
  const { query, type = "web" } = await req.json() as { query: string; type?: string };
  if (!query) return err("query is required");

  if (type === "research") {
    const res = await fetch("https://api.tavily.com/search", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ api_key: env.TAVILY_API_KEY, query, search_depth: "advanced", include_answer: true, max_results: 6 }),
    });
    if (!res.ok) return err(`Tavily error: ${res.status}`);
    const data = await res.json() as { answer?: string; results?: TavilyResult[] };
    return json({
      answer:  data.answer ?? null,
      results: (data.results ?? []).map(r => ({ title: r.title, url: r.url, content: r.content?.slice(0, 800) })),
    });
  }

  const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6&text_decorations=false`;
  const res = await fetch(braveUrl, {
    headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": env.BRAVE_API_KEY },
  });
  if (!res.ok) return err(`Brave error: ${res.status}`);
  const data = await res.json() as { web?: { results?: BraveResult[] } };
  return json({
    results: (data.web?.results ?? []).map(r => ({ title: r.title, url: r.url, description: r.description?.slice(0, 400) })),
  });
}

// ---------------------------------------------------------------------------
// CF Browser Rendering (puppeteer)
// ---------------------------------------------------------------------------

// Returns false for schemes other than http/https, and for hosts that map to
// loopback, private, link-local, metadata, or mesh-internal addresses.
// Covers literal IPs -- decimal/hex/short-form normalize to dotted-quad via the
// WHATWG URL parser before our check -- and reserved names. Residual gap: DNS
// rebinding (public name -> private A record) requires resolving the host first.
function isSsrfSafe(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();

  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) return false;

  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    if (
      a === 0                              ||  // 0/8 unspecified
      a === 10                             ||  // 10/8 RFC1918
      a === 127                            ||  // 127/8 loopback
      (a === 100 && b >= 64 && b <= 127)   ||  // 100.64/10 CGNAT / WARP mesh
      (a === 169 && b === 254)             ||  // 169.254/16 link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31)    ||  // 172.16/12 RFC1918
      (a === 192 && b === 168)             ||  // 192.168/16 RFC1918
      (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmark
      a >= 240                                  // 240/4 reserved
    ) return false;
  }

  // Literal IPv6: URL.hostname KEEPS the brackets ("[::1]"), so strip them before matching --
  // otherwise none of these checks ever fire (the original bug let [::1] / [fe80::1] / [fc00::1] /
  // [::ffff:169.254.169.254] through). Scoping to the bracketed literal also avoids false-positives
  // on real domains like fconline.com / fd-cdn.com.
  if (host.startsWith("[") && host.endsWith("]")) {
    const h6 = host.slice(1, -1);
    if (
      h6 === "::" || h6 === "::1"                 ||  // unspecified / loopback
      h6.startsWith("::ffff:")                    ||  // IPv4-mapped (covers mapped loopback/metadata)
      h6.startsWith("fe80:")                      ||  // link-local
      h6.startsWith("fc") || h6.startsWith("fd")      // unique local fc00::/7
    ) return false;
  }

  return true;
}

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const { url } = await req.json() as { url: string };
  if (!url) return err("url is required");
  if (!isSsrfSafe(url)) return err("URL not allowed: must be a public http/https address", 400);

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (["image", "stylesheet", "font", "media"].includes(r.resourceType())) r.abort();
      else r.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const { title, content } = await page.evaluate(() => {
      ["script", "style", "nav", "header", "footer", "aside", "noscript"]
        .forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));
      return {
        title:   document.title ?? "",
        content: (document.body?.innerText ?? "").replace(/\s{3,}/g, "\n\n").trim().slice(0, 10_000),
      };
    });
    return json({ url, title, content });
  } catch (e: unknown) {
    return err(`Browser fetch failed: ${e instanceof Error ? e.message : String(e)}`, 500);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Knowledge base (Vectorize + Workers AI embeddings)
// ---------------------------------------------------------------------------

async function embed(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run("@cf/baai/bge-large-en-v1.5" as Parameters<typeof env.AI.run>[0], { text: [text] }) as { data: number[][] };
  return result.data[0];
}

async function handleKnowledgeIndex(req: Request, env: Env): Promise<Response> {
  const { content, title = "", author = "" } = await req.json() as { content: string; title?: string; author?: string };
  if (!content) return err("content is required");

  const vector = await embed(env, content.slice(0, 4_000));
  const id = crypto.randomUUID();

  await env.KNOWLEDGE.upsert([{
    id,
    values: vector,
    metadata: {
      title:     title.slice(0, 200),
      content:   content.slice(0, 2_000),
      author:    author.slice(0, 100),
      createdAt: new Date().toISOString(),
    },
  }]);

  return json({ id });
}

async function handleKnowledgeSearch(req: Request, env: Env): Promise<Response> {
  const { query, topK = 5 } = await req.json() as { query: string; topK?: number };
  if (!query) return err("query is required");

  const vector  = await embed(env, query);
  const results = await env.KNOWLEDGE.query(vector, { topK: Math.min(topK, 10), returnMetadata: "all" });

  return json({
    results: results.matches.map(m => ({
      id:      m.id,
      score:   m.score,
      title:   (m.metadata as Record<string, string>)?.title   ?? "",
      content: (m.metadata as Record<string, string>)?.content ?? "",
    })),
  });
}
