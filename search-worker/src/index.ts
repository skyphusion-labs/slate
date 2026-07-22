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
  capabilitySecretsReady,
  channelAllowed,
  isNonEmptyChannelId,
  MAX_KNOWLEDGE_CONTENT_LENGTH,
  sanitizeMemoryMeta,
  sanitizeSearchQuery,
  secretsMatch,
} from "./search-input";
import {
  isSsrfSafeResolved,
  MAX_FETCH_URL_LENGTH,
  resolvePublicRedirectChain,
} from "./ssrf";

interface Env {
  BROWSER: Fetcher;
  AI: Ai;
  KNOWLEDGE: VectorizeIndex;
  MEMORY: VectorizeIndex;
  BRAVE_API_KEY: string;
  TAVILY_API_KEY: string;
  /** Auth for /search and /knowledge/* (X-Search-Secret). */
  SEARCH_SECRET: string;
  /** Auth for /fetch — required, no fallback (limits lateral movement). */
  FETCH_SECRET: string;
  /** Auth for /memory/* — required, no fallback (limits lateral movement). */
  MEMORY_SECRET: string;
  /** Optional comma-separated Discord channel IDs allowed for /memory/*. When set, others 403. */
  MEMORY_CHANNEL_ALLOWLIST?: string;
}

/** Capability-scoped secret for exact known routes (no prefix matching / no fallback). */
function secretForPath(pathname: string, env: Env): string {
  if (pathname === "/fetch") return (env.FETCH_SECRET || "").trim();
  if (pathname === "/memory/index" || pathname === "/memory/search") {
    return (env.MEMORY_SECRET || "").trim();
  }
  if (
    pathname === "/search" ||
    pathname === "/knowledge/index" ||
    pathname === "/knowledge/search"
  ) {
    return (env.SEARCH_SECRET || "").trim();
  }
  // Unknown path: no secret maps → 401 (never authenticate-then-404 with SEARCH_SECRET).
  return "";
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

    // Capability-scoped Wrangler secrets (never source literals). Header name stays
    // X-Search-Secret for bot compat; value must match the secret for this path.
    // All three secrets required, >=16 chars, pairwise distinct (no SEARCH_SECRET fallback).
    if (req.method !== "POST") return err("Method not allowed", 405);

    if (!capabilitySecretsReady(env)) {
      return err(
        "capability secrets not configured: set distinct SEARCH_SECRET, FETCH_SECRET, MEMORY_SECRET (each >= 16 chars)",
        503,
      );
    }

    const providedHeader = req.headers.get("X-Search-Secret") ?? "";
    const configured = secretForPath(url.pathname, env);
    if (!configured || !(await secretsMatch(providedHeader, configured))) {
      return err("Unauthorized", 401);
    }

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
    if (!env.TAVILY_API_KEY) return err("Research not configured", 503);
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
    if (!res.ok) return err("Search upstream error", 502);
    const data = await res.json() as { answer?: string; results?: TavilyResult[] };
    return json({
      answer:  data.answer ?? null,
      results: (data.results ?? []).map(r => ({ title: r.title, url: r.url, content: r.content?.slice(0, 800) })),
    });
  }

  if (!env.BRAVE_API_KEY) return err("Search not configured", 503);
  const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6&text_decorations=false`;
  const res = await fetch(braveUrl, {
    headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": env.BRAVE_API_KEY },
  });
  if (!res.ok) return err("Search upstream error", 502);
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

  // Pre-walk redirects in the Worker (DoH + Location/Refresh). Then fetch the
  // final HTML in the Worker and render via setContent so Chromium never dials
  // the target (no meta-refresh / DNS-rebinding browser navigation).
  const targetUrl = await resolvePublicRedirectChain(url);
  if (!targetUrl) {
    return err("URL not allowed: must be a public http/https address", 400);
  }
  // Re-check immediately before the Worker GET (rebinding TOCTOU).
  if (!(await isSsrfSafeResolved(targetUrl))) {
    return err("URL not allowed: must be a public http/https address", 400);
  }

  const MAX_HTML_BYTES = 1_500_000;
  let html: string;
  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "slate-search-fetch/1.0" },
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return err("URL not allowed: unexpected redirect", 400);
    }
    if (!upstream.ok) return err("Fetch upstream error", 502);
    const ctype = (upstream.headers.get("content-type") || "").toLowerCase();
    if (ctype && !ctype.includes("html") && !ctype.includes("text/plain") && !ctype.includes("xml")) {
      return err("URL not allowed: unsupported content type", 400);
    }
    const declared = Number(upstream.headers.get("content-length") || "0");
    if (declared > MAX_HTML_BYTES) return err("Fetch upstream error", 502);
    html = await upstream.text();
    if (html.length > MAX_HTML_BYTES) return err("Fetch upstream error", 502);
  } catch (e: unknown) {
    console.error("worker fetch failed:", e instanceof Error ? e.message : String(e));
    return err("Fetch upstream error", 502);
  }

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    // Offline + intercept: Chromium must not dial anything while parsing setContent HTML.
    // Always abort (never continue). shouldAbortBrowserRequestResolved still runs so any
    // future continue() path keeps DNS re-check coverage, and the helper stays live.
    await page.setOfflineMode(true);
    await page.setRequestInterception(true);
    page.on("request", async (r) => {
      // Always abort — never continue(). Offline setContent must not dial.
      try { await r.abort(); } catch { /* ignore */ }
    });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("meta[http-equiv]")) {
        if ((el.getAttribute("http-equiv") || "").toLowerCase() === "refresh") {
          el.remove();
        }
      }
    });
    const { title, content } = await page.evaluate(() => {
      ["script", "style", "nav", "header", "footer", "aside", "noscript"]
        .forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));
      return {
        title:   document.title ?? "",
        content: (document.body?.innerText ?? "").replace(/\s{3,}/g, "\n\n").trim().slice(0, 10_000),
      };
    });
    return json({ url: targetUrl, title, content });
  } catch (e: unknown) {
    console.error("browser render failed:", e instanceof Error ? e.message : String(e));
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
  const channelId =
    typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!isNonEmptyChannelId(channelId)) {
    return err("channelId is required (Discord snowflake)", 400);
  }
  if (!channelAllowed(env.MEMORY_CHANNEL_ALLOWLIST, channelId)) {
    return err("Forbidden", 403);
  }
  const kind = typeof body.kind === "string" ? body.kind : "chat";
  // Trusted fields last so sanitizeMemoryMeta can never clobber channelId / kind / content.
  const safeMeta = sanitizeMemoryMeta(body.meta);

  const vector = await embed(env, body.content.slice(0, 4_000));
  const id = crypto.randomUUID();

  await env.MEMORY.upsert([{
    id,
    values: vector,
    metadata: {
      ...safeMeta,
      kind:      String(kind).slice(0, 40),
      channelId,
      content:   body.content.slice(0, 2_000),
      createdAt: new Date().toISOString(),
    },
  }]);

  return json({ id });
}

async function handleMemorySearch(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { query?: unknown; channelId?: unknown; topK?: unknown };
  const query = sanitizeSearchQuery(body.query);
  if (!query) return err("query is required");
  const channelId =
    typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!isNonEmptyChannelId(channelId)) {
    return err("channelId is required (Discord snowflake)", 400);
  }
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

  // Defense in depth: drop any match whose stored channelId disagrees with the
  // request (Vectorize filter bug / metadata pollution must not cross tenants).
  // Response omits method/path meta entirely.
  return json({
    results: results.matches
      .filter((m) => (m.metadata as Record<string, string> | undefined)?.channelId === channelId)
      .map((m) => ({
        id:        m.id,
        score:     m.score,
        kind:      (m.metadata as Record<string, string>)?.kind      ?? "",
        content:   (m.metadata as Record<string, string>)?.content   ?? "",
        createdAt: (m.metadata as Record<string, string>)?.createdAt ?? "",
      })),
  });
}
