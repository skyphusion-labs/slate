// slate-search Worker
//
// Endpoints (all require X-Search-Secret header except /health):
//   GET  /health
//   POST /search  { query, type?: "web"|"research" }
//   POST /fetch   { url }
//   POST /knowledge/index   { content, title?, author? }
//   POST /knowledge/search  { query, topK?: number }
//   POST /memory/index   { content, kind, channelId?, meta? }
//   POST /memory/search  { query, channelId?, topK?: number }
//
// `knowledge/*` is the manual, cross-channel `!learn` corpus (film references a user explicitly
// submits). `memory/*` (slate#90) is Slate's own auto-ingested session memory -- conversation turns,
// storyboard-brief snapshots, and studio API traffic -- written by bot.mjs on meaningful events, not
// by user command. Separate Vectorize index so a channel's session memory never pollutes (or leaks
// into) another channel's search results or the shared knowledge base; same embedding model + shape.

import puppeteer from "@cloudflare/puppeteer";
import { isSsrfSafeResolved, shouldAbortBrowserRequestResolved } from "./ssrf";

interface Env {
  BROWSER: Fetcher;
  AI: Ai;
  KNOWLEDGE: VectorizeIndex;
  MEMORY: VectorizeIndex;
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
    if (url.pathname === "/memory/index")     return handleMemoryIndex(req, env);
    if (url.pathname === "/memory/search")    return handleMemorySearch(req, env);

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

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const { url } = await req.json() as { url: string };
  if (!url) return err("url is required");

  // Per-navigation DNS cache: every intercepted hop (including 30x redirects) re-checks
  // the request URL and resolves the hostname so public names cannot rebind to metadata.
  const dnsCache = new Map<string, string[]>();
  if (!(await isSsrfSafeResolved(url, { cache: dnsCache }))) {
    return err("URL not allowed: must be a public http/https address", 400);
  }

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      void (async () => {
        try {
          if (await shouldAbortBrowserRequestResolved(r.url(), r.resourceType(), { cache: dnsCache })) {
            await r.abort();
          } else {
            await r.continue();
          }
        } catch {
          try { await r.abort(); } catch { /* already handled / closed */ }
        }
      })();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const finalUrl = page.url();
    if (!(await isSsrfSafeResolved(finalUrl, { cache: dnsCache }))) {
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

// ---------------------------------------------------------------------------
// Session memory (Vectorize + Workers AI embeddings) -- slate#90
//
// Auto-ingested RAG over conversation, storyboard-brief, and studio API traffic, so Slate never has
// to re-ask a group for something it already saw pass through it. Same embed() / index shape as the
// knowledge base above, but a distinct index (MEMORY) so this never mixes with the manual, shared
// !learn corpus. `kind` tags what was ingested ("chat" | "brief" | "traffic") for observability.
// ---------------------------------------------------------------------------

async function handleMemoryIndex(req: Request, env: Env): Promise<Response> {
  const { content, kind = "chat", channelId = "", meta = {} } = await req.json() as {
    content: string; kind?: string; channelId?: string; meta?: Record<string, string>;
  };
  if (!content) return err("content is required");

  const vector = await embed(env, content.slice(0, 4_000));
  const id = crypto.randomUUID();

  await env.MEMORY.upsert([{
    id,
    values: vector,
    metadata: {
      kind:      String(kind).slice(0, 40),
      channelId: channelId.slice(0, 64),
      content:   content.slice(0, 2_000),
      createdAt: new Date().toISOString(),
      ...Object.fromEntries(Object.entries(meta).slice(0, 10).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 200)])),
    },
  }]);

  return json({ id });
}

async function handleMemorySearch(req: Request, env: Env): Promise<Response> {
  const { query, channelId, topK = 5 } = await req.json() as { query: string; channelId?: string; topK?: number };
  if (!query) return err("query is required");

  const vector  = await embed(env, query);
  const results = await env.MEMORY.query(vector, {
    topK:           Math.min(topK, 10),
    returnMetadata: "all",
    ...(channelId ? { filter: { channelId } } : {}),
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
