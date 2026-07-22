// slate-search Worker
//
// Endpoints (all require X-Search-Secret header except /health):
//   GET  /health
//   POST /search  { query, type?: "web"|"research" }
//   POST /fetch   { url }
//   POST /knowledge/index   { content, title?, author? }
//   POST /knowledge/search  { query, topK?: number }
//   POST /memory/index   { content, kind, channelId, meta? }   // channelId required
//   POST /memory/search  { query, channelId, topK?: number }   // channelId required
//
// `knowledge/*` is the manual, cross-channel `!learn` corpus (film references a user explicitly
// submits). `memory/*` (slate#90) is Slate's own auto-ingested session memory -- conversation turns,
// storyboard-brief snapshots, and studio API traffic -- written by bot.mjs on meaningful events, not
// by user command. Separate Vectorize index so a channel's session memory never pollutes (or leaks
// into) another channel's search results or the shared knowledge base; same embedding model + shape.

import puppeteer from "@cloudflare/puppeteer";
import {
  channelAllowed,
  isNonEmptyChannelId,
  MAX_KNOWLEDGE_CONTENT_LENGTH,
  sanitizeSearchQuery,
  timingSafeEqualString,
} from "./search-input";
import {
  isSsrfSafeResolved,
  MAX_FETCH_URL_LENGTH,
  resolvePublicRedirectChain,
  shouldAbortBrowserRequestResolved,
} from "./ssrf";

interface Env {
  BROWSER: Fetcher;
  AI: Ai;
  KNOWLEDGE: VectorizeIndex;
  MEMORY: VectorizeIndex;
  BRAVE_API_KEY: string;
  TAVILY_API_KEY: string;
  SEARCH_SECRET: string;
  /** Optional comma-separated Discord channel IDs allowed for /memory/*. When set, others 403. */
  MEMORY_CHANNEL_ALLOWLIST?: string;
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

// No CORS: slate-search is called only by the Discord bot (server-side). Browser
// origins must not be able to attach X-Search-Secret via a malicious page.

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return err("Method not allowed", 405);
    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true });

    // Auth is the Wrangler secret env.SEARCH_SECRET only -- never a source literal.
    // Single shared secret is intentional (one Discord bot caller); rotate via wrangler
    // if leaked. Optional MEMORY_CHANNEL_ALLOWLIST scopes memory to known channels.
    const providedHeader = req.headers.get("X-Search-Secret") ?? "";
    const configured = env.SEARCH_SECRET ?? "";
    if (
      configured.length < 16 ||
      providedHeader.length < 16 ||
      !timingSafeEqualString(providedHeader, configured)
    ) {
      return err("Unauthorized", 401);
    }
    if (req.method !== "POST") return err("Method not allowed", 405);

    if (url.pathname === "/search")           return handleSearch(req, env);
    if (url.pathname === "/fetch")            return handleFetch(req, env);
    if (url.pathname === "/knowledge/index")  return handleKnowledgeIndex(req, env);
    if (url.pathname === "/knowledge/search") return handleKnowledgeSearch(req, env);
    if (url.pathname === "/memory/index")     return handleMemoryIndex(req, env);
    if (url.pathname === "/memory/search")    return handleMemorySearch(req, env);

    return err("Not found", 404);
  },
};

// ---------------------------------------------------------------------------
// Web search (Brave) + deep research (Tavily)
// ---------------------------------------------------------------------------

async function handleSearch(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { query?: unknown; type?: unknown };
  const query = sanitizeSearchQuery(body.query);
  if (!query) return err("query is required");
  const type = body.type === "research" ? "research" : "web";

  if (type === "research") {
    // Tavily documents Bearer auth; keep the key out of the JSON body.
    const res = await fetch("https://api.tavily.com/search", {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        include_answer: true,
        max_results: 6,
      }),
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

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { url?: unknown };
  const url = typeof body.url === "string" ? body.url : "";
  if (url.length === 0) return err("url is required");
  if (url.length > MAX_FETCH_URL_LENGTH) return err("url exceeds maximum length", 400);

  // Pre-walk HTTP redirects (+ Refresh headers) in the Worker so Chromium never
  // dials a Location we have not already DoH-validated. Browser intercept is the
  // second line of defense for meta-refresh / unexpected document hops.
  const targetUrl = await resolvePublicRedirectChain(url);
  if (!targetUrl) {
    return err("URL not allowed: must be a public http/https address", 400);
  }

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    // Kill inline JS navigations / XHR SSRF side-channels; we only need static DOM text.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    // Async listener is awaited by Puppeteer before the request proceeds -- do not
    // fire-and-forget; abort/continue must settle before Chromium dials out.
    page.on("request", async (r) => {
      let settled = false;
      const settle = async (action: "abort" | "continue"): Promise<void> => {
        if (settled) return;
        settled = true;
        if (action === "abort") await r.abort();
        else await r.continue();
      };
      try {
        if (await shouldAbortBrowserRequestResolved(r.url(), r.resourceType())) {
          await settle("abort");
        } else {
          await settle("continue");
        }
      } catch {
        try { await settle("abort"); } catch { /* already handled / closed */ }
      }
    });
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
    // Strip meta-refresh before Chromium can navigate away from the validated URL.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("meta[http-equiv]")) {
        if ((el.getAttribute("http-equiv") || "").toLowerCase() === "refresh") {
          el.remove();
        }
      }
    });
    // Brief settle so any already-queued refresh attempt surfaces in page.url().
    await new Promise((r) => setTimeout(r, 300));
    const finalUrl = page.url();
    if (!(await isSsrfSafeResolved(finalUrl))) {
      return err("URL not allowed: navigation landed on a non-public address", 400);
    }
    const { title, content } = await page.evaluate(() => {
      ["script", "style", "nav", "header", "footer", "aside", "noscript"]
        .forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));
      return {
        title:   document.title ?? "",
        content: (document.body?.innerText ?? "").replace(/\s{3,}/g, "\n\n").trim().slice(0, 10_000),
      };
    });
    return json({ url: finalUrl, title, content });
  } catch (e: unknown) {
    console.error("browser fetch failed:", e instanceof Error ? e.message : String(e));
    return err("Browser fetch failed", 500);
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
  const body = await req.json() as { content?: unknown; title?: unknown; author?: unknown };
  if (typeof body.content !== "string" || body.content.length === 0) {
    return err("content is required");
  }
  if (body.content.length > MAX_KNOWLEDGE_CONTENT_LENGTH) {
    return err("content exceeds maximum length", 400);
  }
  const title = typeof body.title === "string" ? body.title : "";
  const author = typeof body.author === "string" ? body.author : "";

  const vector = await embed(env, body.content.slice(0, 4_000));
  const id = crypto.randomUUID();

  await env.KNOWLEDGE.upsert([{
    id,
    values: vector,
    metadata: {
      title:     title.slice(0, 200),
      content:   body.content.slice(0, 2_000),
      author:    author.slice(0, 100),
      createdAt: new Date().toISOString(),
    },
  }]);

  return json({ id });
}

async function handleKnowledgeSearch(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { query?: unknown; topK?: unknown };
  const query = sanitizeSearchQuery(body.query);
  if (!query) return err("query is required");
  const topK = typeof body.topK === "number" && Number.isFinite(body.topK) ? body.topK : 5;

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

// ---------------------------------------------------------------------------
// Session memory (Vectorize + Workers AI embeddings) -- slate#90
//
// Auto-ingested RAG over conversation, storyboard-brief, and studio API traffic, so Slate never has
// to re-ask a group for something it already saw pass through it. Same embed() / index shape as the
// knowledge base above, but a distinct index (MEMORY) so this never mixes with the manual, shared
// !learn corpus. `kind` tags what was ingested ("chat" | "brief" | "traffic") for observability.
// ---------------------------------------------------------------------------

async function handleMemoryIndex(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as {
    content?: unknown; kind?: unknown; channelId?: unknown; meta?: unknown;
  };
  if (typeof body.content !== "string" || body.content.length === 0) {
    return err("content is required");
  }
  if (body.content.length > MAX_KNOWLEDGE_CONTENT_LENGTH) {
    return err("content exceeds maximum length", 400);
  }
  if (!isNonEmptyChannelId(body.channelId)) {
    return err("channelId is required (non-empty string)", 400);
  }
  const channelId = body.channelId.trim();
  if (!channelAllowed(env.MEMORY_CHANNEL_ALLOWLIST, channelId)) {
    return err("Forbidden", 403);
  }
  const kind = typeof body.kind === "string" ? body.kind : "chat";
  const meta =
    body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
      ? body.meta as Record<string, string>
      : {};

  const vector = await embed(env, body.content.slice(0, 4_000));
  const id = crypto.randomUUID();

  await env.MEMORY.upsert([{
    id,
    values: vector,
    metadata: {
      kind:      String(kind).slice(0, 40),
      channelId,
      content:   body.content.slice(0, 2_000),
      createdAt: new Date().toISOString(),
      ...Object.fromEntries(Object.entries(meta).slice(0, 10).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 200)])),
    },
  }]);

  return json({ id });
}

async function handleMemorySearch(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { query?: unknown; channelId?: unknown; topK?: unknown };
  const query = sanitizeSearchQuery(body.query);
  if (!query) return err("query is required");
  if (!isNonEmptyChannelId(body.channelId)) {
    return err("channelId is required (non-empty string)", 400);
  }
  const channelId = body.channelId.trim();
  if (!channelAllowed(env.MEMORY_CHANNEL_ALLOWLIST, channelId)) {
    return err("Forbidden", 403);
  }
  const topK = typeof body.topK === "number" && Number.isFinite(body.topK) ? body.topK : 5;

  const vector  = await embed(env, query);
  const results = await env.MEMORY.query(vector, {
    topK:           Math.min(topK, 10),
    returnMetadata: "all",
    filter:         { channelId },
  });

  return json({
    results: results.matches.map(m => ({
      id:        m.id,
      score:     m.score,
      kind:      (m.metadata as Record<string, string>)?.kind      ?? "",
      content:   (m.metadata as Record<string, string>)?.content   ?? "",
      createdAt: (m.metadata as Record<string, string>)?.createdAt ?? "",
    })),
  });
}
