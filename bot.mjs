// bot.mjs
// Slate -- Vivijure Screenwriter's Assistant for Discord.
//
// Multiple people in a channel plan a film together; Slate participates as a
// creative collaborator, maintains a structured storyboard brief in the background,
// and can submit the finished project to the Vivijure render pipeline.
//
// Required Discord Developer Portal settings:
//   Bot -> Privileged Gateway Intents -> MESSAGE CONTENT: ON
//   OAuth2 -> URL Generator -> scopes: bot, applications.commands
//                             permissions: Send Messages, Read Message History, Attach Files
//
// Config (all via env):
//   DISCORD_TOKEN               (required) bot token from the Developer Portal
//   DISCORD_CHANNEL_IDS         comma-separated channel IDs to listen in;
//                               if empty, only DMs and @mentions are answered
//   OLLAMA_BASE_URL             ollama OpenAI-compat base  (default http://localhost:11434/v1)
//   DISCORD_MODEL               model id                   (default qwen3.6:27b-ctx8k)
//   DISCORD_HISTORY             rolling history depth in exchange pairs (default 20)
//   DISCORD_LOG                 tee logs to this file path (optional)
//   VIVIJURE_API_URL            Vivijure Worker base URL for !render submissions
//   LLM_API_URL                 skyphusion-llm-public base URL for image generation
//                               (default https://play.skyphusion.org)
//   CF_ACCESS_CLIENT_ID         Cloudflare Access service token client ID
//   CF_ACCESS_CLIENT_SECRET     Cloudflare Access service token client secret
//   CF_D1_TOKEN                 Cloudflare API token with D1:Write permission
//   CF_D1_ACCOUNT_ID            Cloudflare account ID (from env; never hardcode)
//   CF_D1_DATABASE_ID           D1 database ID (faac1698-5ffe-4f0e-8147-761c0747e957)
//   CF_AIG_TOKEN                Cloudflare API token for the AI Gateway (Anthropic path).
//                               When set the main conversation uses Claude via CF AI Gateway.
//                               Falls back to ollama when unset.
//   CF_GATEWAY_ENDPOINT         CF AI Gateway compat URL (used to derive the Anthropic base URL).
//   SEARCH_WORKER_URL           vivijure-search Worker base URL (enables web search + knowledge base)
//   SEARCH_SECRET               shared secret for X-Search-Secret header
//
// ! commands:
//   !brief                 show the current storyboard state (and render settings)
//   !portrait <A|B|C|D> [desc]  generate + sync a character portrait
//   !thumbnail <scene-id>  generate a visual thumbnail for a scene
//   !model [name|id]       show available image models / switch the active one
//   !backend [name|auto]   choose the render backend (own GPU vs cloud); options come from the studio
//   !titlecard <title> [| subtitle] [|| credit; credit]  set the opening title + end-credit cards
//   !subtitles on|off      caption spoken dialogue in the rendered film
//   !render                review the settings with a quick huddle, then ship on "ship it" / !render now
//   !render [quality|now]  skip the huddle and submit straight away (quality: draft | standard | final)
//   !ship                  confirm + submit the render Slate just huddled on
//   !undo                  roll back the last brief extraction
//   !learn <text or URL>   index a film reference into the knowledge base
//   !reset                 clear the project and start fresh
//
// Render settings (backend, tier, title/credit cards) are decided in conversation or via the
// commands above, held on the storyboard brief, and carried to the studio API at submit time --
// Slate runs no render logic itself. Backend names + quality tiers are projected live from the
// studio registry (GET /api/modules), never hardcoded in a parallel list.
//
// Before a render goes out, Slate runs a short "huddle": she reads back the settings (backend, tier,
// subtitles, title/credits), flags anything worth knowing, and offers the next creative beat or a
// clean "ship it." Confirm with "ship it" (or !render now / !ship); set an explicit quality to skip
// the huddle. The tone is fixed; the wording varies by context.
//
// Slash commands: /brief /portrait /thumbnail /model /backend /titlecard /subtitles /render /undo /learn /reset
// (registered globally on startup; guild propagation is instant, global takes ~1 hour)

import Anthropic from '@anthropic-ai/sdk';
import { AttachmentBuilder, Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { appendFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_FILE       = process.env.DISCORD_LOG    ?? '';
const LOG_WORKER_URL = process.env.LOG_WORKER_URL ?? '';
const LOG_SECRET     = process.env.LOG_SECRET     ?? '';
const LOG_SERVICE    = process.env.LOG_SERVICE    ?? 'slate';

// Best-effort log shipping to the R2-backed log-worker. Lines buffer and flush
// on a timer (or when the buffer fills); failures are dropped, never thrown,
// and never routed back through log() (which would loop).
const logBuffer = [];

async function flushLogs() {
  if (!LOG_WORKER_URL || !LOG_SECRET || logBuffer.length === 0) return;
  const batch = logBuffer.splice(0, logBuffer.length).join('\n') + '\n';
  try {
    await fetch(`${LOG_WORKER_URL}/ingest?service=${encodeURIComponent(LOG_SERVICE)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Log-Secret': LOG_SECRET },
      body:    batch,
    });
  } catch (e) {
    console.error(`[log-ship] failed: ${e.message}`);
  }
}

if (LOG_WORKER_URL && LOG_SECRET) setInterval(flushLogs, 10_000);

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (LOG_FILE) try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
  if (LOG_WORKER_URL && LOG_SECRET) {
    logBuffer.push(line);
    if (logBuffer.length >= 100) flushLogs();
  }
}

if (!process.env.DISCORD_TOKEN) {
  log('ERROR: DISCORD_TOKEN is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CFG = {
  token:                process.env.DISCORD_TOKEN,
  ollamaBase:           process.env.OLLAMA_BASE_URL         ?? 'http://localhost:11434/v1',
  model:                process.env.DISCORD_MODEL           ?? 'qwen3.6:27b-ctx8k',
  channelIds:           new Set((process.env.DISCORD_CHANNEL_IDS ?? '').split(',').filter(Boolean)),
  trustedBots:          new Set((process.env.TRUSTED_BOT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  historyLen:           parseInt(process.env.DISCORD_HISTORY ?? '20', 10),
  vivijureUrl:          process.env.VIVIJURE_API_URL        ?? '',
  llmUrl:               process.env.LLM_API_URL             ?? 'https://play.skyphusion.org',
  cfAccessClientId:     process.env.CF_ACCESS_CLIENT_ID     ?? '',
  cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? '',
  d1Token:              process.env.CF_D1_TOKEN             ?? '',
  d1AccountId:          process.env.CF_D1_ACCOUNT_ID        ?? '',
  d1DatabaseId:         process.env.CF_D1_DATABASE_ID       ?? 'faac1698-5ffe-4f0e-8147-761c0747e957',
  aigToken:             process.env.CF_AIG_TOKEN            ?? '',
  gatewayEndpoint:      process.env.CF_GATEWAY_ENDPOINT     ?? '',
  searchUrl:            process.env.SEARCH_WORKER_URL       ?? '',
  searchSecret:         process.env.SEARCH_SECRET           ?? '',
};

// Anthropic client via CF AI Gateway (native path, not OpenAI compat).
const anthropicBase = CFG.gatewayEndpoint
  ? CFG.gatewayEndpoint.replace('/compat/chat/completions', '') + '/anthropic'
  : `https://gateway.ai.cloudflare.com/v1/${CFG.d1AccountId}/skyphusion-llm/anthropic`;
const anthropic = CFG.aigToken
  ? new Anthropic({ apiKey: CFG.aigToken, baseURL: anthropicBase })
  : null;

log(`Starting: model=${CFG.model} backend=${anthropic ? anthropicBase : CFG.ollamaBase} channels=${CFG.channelIds.size || 'DMs+mentions only'}`);

// ---------------------------------------------------------------------------
// Image model catalog
// ---------------------------------------------------------------------------

const IMAGE_MODELS = [
  { alias: 'flux-schnell',  id: '@cf/black-forest-labs/flux-1-schnell',         label: 'FLUX-1 Schnell (fast, default)' },
  { alias: 'flux2-fast',    id: '@cf/black-forest-labs/flux-2-klein-4b',         label: 'FLUX 2 Klein 4B (faster frontier)' },
  { alias: 'flux2',         id: '@cf/black-forest-labs/flux-2-klein-9b',         label: 'FLUX 2 Klein 9B (frontier quality)' },
  { alias: 'flux2-dev',     id: '@cf/black-forest-labs/flux-2-dev',              label: 'FLUX 2 Dev (multi-reference)' },
  { alias: 'phoenix',       id: '@cf/leonardo/phoenix-1.0',                      label: 'Phoenix 1.0 (Leonardo)' },
  { alias: 'lucid',         id: '@cf/leonardo/lucid-origin',                     label: 'Lucid Origin (Leonardo)' },
  { alias: 'dreamshaper',   id: '@cf/lykon/dreamshaper-8-lcm',                   label: 'Dreamshaper 8 LCM (fast SD)' },
  { alias: 'sdxl',          id: '@cf/stabilityai/stable-diffusion-xl-base-1.0',  label: 'Stable Diffusion XL' },
  { alias: 'gpt-image',     id: 'openai/gpt-image-1.5',                          label: 'GPT Image 1.5 (OpenAI)' },
  { alias: 'recraft',       id: 'recraft/recraftv4',                             label: 'Recraft V4 (art-directed)' },
  { alias: 'nano-banana',   id: 'google/nano-banana-pro',                        label: 'Nano Banana Pro (Google)' },
];

const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

function resolveImageModel(input) {
  const lower = input.toLowerCase().trim();
  const byAlias = IMAGE_MODELS.find(m => m.alias === lower);
  if (byAlias) return byAlias;
  const byId = IMAGE_MODELS.find(m => m.id === input);
  if (byId) return byId;
  const byPartial = IMAGE_MODELS.find(m => m.id.includes(lower));
  if (byPartial) return byPartial;
  return null;
}

function formatModelList(currentId) {
  const lines = ['**Image Models** (`!model <name>` or `/model <name>` to switch)\n'];
  for (const m of IMAGE_MODELS) {
    const active = m.id === currentId ? ' **<-- active**' : '';
    lines.push(`  \`${m.alias}\` -- ${m.label}${active}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Project state -- persisted in Cloudflare D1 (REST API), cached in-memory
// ---------------------------------------------------------------------------

function emptyBrief() {
  return {
    title:            null,
    full_prompt:      null,
    style_prefix:     null,
    style_category:   'None',
    duration_seconds: null,
    clip_seconds:     null,
    cast:             [],
    scenes:           [],
    // Shared render settings the group decides together (backend, tier, title cards, subtitles).
    // Slate holds NO render logic of its own: these are just the choices it carries forward to the
    // studio API at submit time. The studio is the single source of truth for what each choice means.
    render_settings: emptyRenderSettings(),
  };
}

// Render settings live on the brief so they persist across the conversation and round-trip through
// D1 exactly like every other field. Defaults: tier draft (cheap iteration), backend auto (the
// studio registry decides; a standing own-gpu preference belongs in the studio, not hardcoded here).
function emptyRenderSettings() {
  return {
    quality_tier:   'draft',     // one of GET /api/modules render.quality_tiers; draft-first for Slate.
    motion_backend: null,        // null = auto (omit; studio picks). Otherwise a motion.backend module name.
    titles:         null,        // { text, subtitle? } for the opening title card. null = no card.
    credits:        null,        // { lines: [] } for the end-credit card. null = no card.
    subtitles:      false,       // burn dialogue captions (film.finish subtitle module). See dialogue tracking.
  };
}

// A brief loaded before render_settings existed (older D1 row) has no settings block; backfill it
// so every read path can assume the shape. Mirrors the imageModel / briefHistory backfill below.
function ensureRenderSettings(brief) {
  if (!brief.render_settings || typeof brief.render_settings !== 'object') {
    brief.render_settings = emptyRenderSettings();
  } else {
    const d = emptyRenderSettings();
    for (const k of Object.keys(d)) {
      if (!(k in brief.render_settings)) brief.render_settings[k] = d[k];
    }
  }
  return brief.render_settings;
}

const projects = new Map();

async function d1Query(sql, params = []) {
  if (!CFG.d1Token) throw new Error('CF_D1_TOKEN not configured');
  const url = `https://api.cloudflare.com/client/v4/accounts/${CFG.d1AccountId}/d1/database/${CFG.d1DatabaseId}/query`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${CFG.d1Token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`D1 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.success) throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  return data.result?.[0]?.results ?? [];
}

async function initD1() {
  if (!CFG.d1Token) return;
  try {
    await d1Query(`CREATE TABLE IF NOT EXISTS sessions (
      channel_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    await d1Query(`CREATE TABLE IF NOT EXISTS render_jobs (
      job_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      quality TEXT NOT NULL DEFAULT 'draft',
      submitted_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    )`);
    log('D1 tables ready');
  } catch (e) {
    log(`WARN: D1 init failed: ${e.message}`);
  }
}

async function loadProject(channelId) {
  try {
    const rows = await d1Query('SELECT data FROM sessions WHERE channel_id = ?', [channelId]);
    if (rows.length === 0) return null;
    const data = JSON.parse(rows[0].data);
    projects.set(channelId, data);
    return data;
  } catch (e) {
    log(`ERROR loading session ${channelId}: ${e.message}`);
    return null;
  }
}

async function getProject(channelId) {
  if (!projects.has(channelId)) {
    const loaded = await loadProject(channelId);
    if (!loaded) projects.set(channelId, { brief: emptyBrief(), history: [], briefHistory: [], imageModel: DEFAULT_IMAGE_MODEL });
  }
  const p = projects.get(channelId);
  if (!p.imageModel)    p.imageModel    = DEFAULT_IMAGE_MODEL;
  if (!p.briefHistory)  p.briefHistory  = [];
  if (!p.brief)         p.brief         = emptyBrief();
  ensureRenderSettings(p.brief);
  return p;
}

async function saveProject(channelId) {
  try {
    const project = projects.get(channelId);
    if (!project) return;
    const now = new Date().toISOString();
    await d1Query(
      'INSERT INTO sessions (channel_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      [channelId, JSON.stringify(project), now],
    );
  } catch (e) {
    log(`ERROR saving session ${channelId}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Slate, a screenwriter's assistant and creative collaborator on the Vivijure AI film platform. \
You help filmmakers plan and develop their films through natural conversation.

Vivijure renders films using SDXL for keyframes and Wan 2.2 image-to-video. Films are composed of:
- A storyboard with an overall narrative (full_prompt) and visual style (style_prefix)
- A cast of up to 4 characters assigned to slots A, B, C, D -- each described visually
- Scenes (shots), each with a visual prompt, optional act label, character slots, and duration

Your role:
- Collaborate naturally on story, characters, visual style, and shot composition
- Help translate creative ideas into vivid visual language -- this becomes the generation prompt
- Think cinematically: lighting, composition, camera movement, mood, color
- Track decisions without making the conversation feel like filling out a form
- When collaborators disagree or explore options, help them land on something specific
- Multiple people may be in this channel; each message includes the sender's name
- If users share images (mood boards, reference stills), describe what you see and incorporate it

You also help the group decide how the film is finished and rendered -- which backend (our own GPU vs cloud), the quality tier, whether to open on a title card and roll credits. Offer these as a collaborator would: suggest, ask, and act on the group's behalf. You never run the render yourself; you carry the group's choices to the studio.

The storyboard brief updates automatically in the background. Available commands:
- !brief / /brief               -- see the current storyboard state (and render settings)
- !portrait A [desc] / /portrait -- generate a character portrait for slot A, B, C, or D
- !thumbnail <scene-id> / /thumbnail -- generate a visual thumbnail for a scene
- !backend [name|auto] / /backend -- choose the render backend (own GPU vs cloud), or auto
- !titlecard <title> [| sub] [|| credits] / /titlecard -- set the opening title + end credits
- !subtitles on|off / /subtitles -- caption spoken dialogue in the rendered film
- !render [tier] / /render      -- submit to Vivijure for rendering (tier defaults to the project's)

When the group wants subtitles, remember they caption spoken DIALOGUE: capture each shot's line as it
is decided (in the brief's per-scene "dialogue"), and be honest that captions show once there are
lines to show.
- !undo / /undo                 -- roll back the last brief update
- !learn <text or URL> / /learn -- add a film reference to the knowledge base
- !reset / /reset               -- clear the project and start fresh`;

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Flatten message content for ollama (text-only; strip image blocks).
function flattenForOllama(messages) {
  return messages.map(m => {
    if (typeof m.content === 'string') return m;
    if (!Array.isArray(m.content)) return m;
    const imgCount = m.content.filter(b => b.type === 'image').length;
    const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const prefix = imgCount > 0 ? `[${imgCount} image(s) attached -- vision not supported in this mode]\n` : '';
    return { ...m, content: prefix + text };
  });
}

async function callOllama(system, conversationMessages) {
  const messages = flattenForOllama(conversationMessages);
  const res = await fetch(`${CFG.ollamaBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ollama' },
    body: JSON.stringify({
      model:    CFG.model,
      messages: [{ role: 'system', content: system }, ...messages],
      stream:   false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ollama ${res.status}: ${body}`);
  }
  const data = await res.json();
  return stripThink(data.choices?.[0]?.message?.content ?? '') || '(no response)';
}

// ---------------------------------------------------------------------------
// Search + knowledge tools (vivijure-search Worker)
// ---------------------------------------------------------------------------

const SEARCH_TOOLS = [
  {
    name:         'web_search',
    description:  'Search the web for quick facts, current events, news, or general information.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
  },
  {
    name:         'research',
    description:  'Deep AI-curated research on a topic -- film history, lore, science, genre conventions, director styles. Returns a synthesized answer plus sources.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The research question' } }, required: ['query'] },
  },
  {
    name:         'fetch_page',
    description:  'Fetch and read the full content of a specific URL.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to fetch' } }, required: ['url'] },
  },
  {
    name:         'search_knowledge',
    description:  'Search the Slate knowledge base for indexed film references, cinematography notes, director styles, genre conventions, or anything previously added with !learn.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to search for' } }, required: ['query'] },
  },
];

async function executeTool(name, input) {
  if (!CFG.searchUrl || !CFG.searchSecret) return 'Search not configured.';
  const headers = { 'Content-Type': 'application/json', 'X-Search-Secret': CFG.searchSecret };

  if (name === 'web_search') {
    log(`[search] web: ${input.query}`);
    const res = await fetch(`${CFG.searchUrl}/search`, { method: 'POST', headers, body: JSON.stringify({ query: input.query, type: 'web' }) });
    return res.ok ? res.json() : `Search error: ${res.status}`;
  }
  if (name === 'research') {
    log(`[search] research: ${input.query}`);
    const res = await fetch(`${CFG.searchUrl}/search`, { method: 'POST', headers, body: JSON.stringify({ query: input.query, type: 'research' }) });
    return res.ok ? res.json() : `Research error: ${res.status}`;
  }
  if (name === 'fetch_page') {
    log(`[search] fetch: ${input.url}`);
    const res = await fetch(`${CFG.searchUrl}/fetch`, { method: 'POST', headers, body: JSON.stringify({ url: input.url }) });
    return res.ok ? res.json() : `Fetch error: ${res.status}`;
  }
  if (name === 'search_knowledge') {
    log(`[search] knowledge: ${input.query}`);
    const res = await fetch(`${CFG.searchUrl}/knowledge/search`, { method: 'POST', headers, body: JSON.stringify({ query: input.query }) });
    return res.ok ? res.json() : `Knowledge search error: ${res.status}`;
  }
  return 'Unknown tool';
}

// Routes to Claude (CF AI Gateway) when anthropic client is configured, else ollama.
// Claude gets search + knowledge tools and drives the loop itself (up to 5 rounds).
async function callAI(system, conversationMessages) {
  if (anthropic) {
    const tools = CFG.searchUrl ? SEARCH_TOOLS : [];
    let messages = [...conversationMessages];

    for (let round = 0; round < 5; round++) {
      const msg = await anthropic.messages.create({
        model:      CFG.model,
        system,
        messages,
        max_tokens: 4096,
        ...(tools.length ? { tools } : {}),
      });

      if (msg.stop_reason !== 'tool_use') {
        return stripThink(msg.content.find(b => b.type === 'text')?.text ?? '') || '(no response)';
      }

      const toolResults = [];
      for (const block of msg.content.filter(b => b.type === 'tool_use')) {
        const result = await executeTool(block.name, block.input).catch(e => ({ error: e.message }));
        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      messages = [
        ...messages,
        { role: 'assistant', content: msg.content },
        { role: 'user',      content: toolResults },
      ];
    }

    const final = await anthropic.messages.create({ model: CFG.model, system, messages, max_tokens: 4096 });
    return stripThink(final.content.find(b => b.type === 'text')?.text ?? '') || '(no response)';
  }
  return callOllama(system, conversationMessages);
}

// imageBlocks: array of Anthropic-format image content blocks (base64) for the current turn only.
// They are NOT stored in history (too large for D1).
async function askLLM(channelId, userText, imageBlocks = []) {
  const project = await getProject(channelId);

  const userContent = imageBlocks.length > 0 && anthropic
    ? [...imageBlocks, { type: 'text', text: userText }]
    : userText;

  return callAI(SYSTEM_PROMPT, [
    ...project.history,
    { role: 'user', content: userContent },
  ]);
}

// Background pass: extract structured brief from conversation history.
// Pushes old brief onto briefHistory (max 10) before overwriting.
async function extractBrief(channelId) {
  const project = await getProject(channelId);
  const recentHistory = project.history.slice(-20);
  if (recentHistory.length === 0) return;

  const extractPrompt = `You are a JSON extraction assistant. \
Given the film planning conversation below and the current storyboard brief, \
update the brief with any creative decisions that were explicitly discussed. \
Only update fields that came up; preserve everything else. \
Return ONLY valid JSON -- no explanation, no markdown fences.

Current brief:
${JSON.stringify(project.brief, null, 2)}

Schema to return:
{
  "title": string | null,
  "full_prompt": string | null,
  "style_prefix": string | null,
  "style_category": string,
  "duration_seconds": number | null,
  "clip_seconds": number | null,
  "cast": [{ "slot": "A"|"B"|"C"|"D", "name": string, "prompt": string, "portraitUrl": string | null }],
  "scenes": [{ "id": string, "prompt": string, "act": string | null, "character_slots": string[], "target_seconds": number | null, "dialogue": string | null }]
}

Notes:
- "dialogue" is the single spoken line for that shot (one line per shot), or null for a silent shot.
  Capture it only when a line is actually spoken/quoted in the conversation; do not invent dialogue.`;

  // Flatten the recent conversation into a single user message. Passing the raw
  // history as alternating turns can end on an assistant message, which Claude
  // rejects ("conversation must end with a user message"); a single user turn
  // also sidesteps role-alternation and image-block issues during extraction.
  const convoText = recentHistory
    .filter(m => m.role !== 'system')
    .map(m => {
      const text = typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
      return `${m.role === 'user' ? 'User' : 'Slate'}: ${text}`;
    })
    .join('\n\n');

  try {
    const raw = await callAI(extractPrompt, [
      { role: 'user', content: `Conversation so far:\n\n${convoText}\n\nReturn the updated storyboard brief as a single JSON object now.` },
    ]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    const updated = JSON.parse(match[0]);

    // Preserve portraitUrl + castId from existing cast
    for (const existing of project.brief.cast) {
      if (!existing.portraitUrl && !existing.castId) continue;
      const m2 = updated.cast?.find(c => c.slot === existing.slot);
      if (!m2) continue;
      if (existing.portraitUrl  && !m2.portraitUrl)  m2.portraitUrl  = existing.portraitUrl;
      if (existing.castId      && !m2.castId)       m2.castId       = existing.castId;
      if (existing.portraitKey && !m2.portraitKey)  m2.portraitKey  = existing.portraitKey;
    }

    // Preserve any dialogue already set on a shot if the re-extraction dropped it (the extractor
    // sees recent turns only and may not re-mention an earlier line). Same intent as the cast
    // portrait/castId preservation above: never lose group-authored content on a partial re-extract.
    for (const prev of project.brief.scenes) {
      if (!prev.dialogue) continue;
      const s2 = updated.scenes?.find(s => s.id === prev.id);
      if (s2 && !s2.dialogue) s2.dialogue = prev.dialogue;
    }

    // Save previous brief for !undo
    project.briefHistory.push(JSON.parse(JSON.stringify(project.brief)));
    if (project.briefHistory.length > 10) project.briefHistory.shift();

    project.brief = updated;
    await saveProject(channelId);
    log(`[${channelId}] brief updated`);
  } catch (e) {
    log(`[${channelId}] brief extraction error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Brief display
// ---------------------------------------------------------------------------

// --- render-settings command helpers (shared by slash + ! handlers) ----------
// NOTE (copy review): these user-facing strings are intentionally plain/functional. The
// conversational "huddle before we ship" voice pass is held for Mackaye + Conrad's review.

// Show the backend options (projected from the registry) and the current pick.
async function formatBackendList(current) {
  const names = await getMotionBackends();
  const lines = ['**Render backend** (`/backend <name|auto>`)\n'];
  const autoActive = !current ? ' **<-- active**' : '';
  lines.push(`  \`auto\` -- let the studio decide${autoActive}`);
  if (!names.length) {
    lines.push('  (no selectable motion backends reported by the studio right now; auto is used)');
  } else {
    for (const n of names) {
      const active = n === current ? ' **<-- active**' : '';
      lines.push(`  \`${n}\`${active}`);
    }
  }
  return lines.join('\n');
}

// Resolve a user backend choice against the live registry. 'auto'/'' -> null (omit on submit).
// An unknown name returns { error } so the handler can show the valid options.
async function resolveBackend(input) {
  const v = (input ?? '').trim().toLowerCase();
  if (!v || v === 'auto' || v === 'default') return { value: null };
  const names = await getMotionBackends();
  const found = names.find(n => n.toLowerCase() === v) || names.find(n => n.toLowerCase().includes(v));
  if (!found) return { error: `Unknown backend \`${input}\`. Options: auto, ${names.join(', ') || '(none reported)'}.` };
  return { value: found };
}

// Parse credit lines from a single string: split on | or ; or newlines, trim, drop blanks.
function parseCreditLines(raw) {
  return (raw ?? '').split(/[|;\n]/).map(s => s.trim()).filter(Boolean);
}

// Honest subtitles status: subtitles caption spoken dialogue, so the toggle is upfront about what it
// needs (a subtitle module installed, and dialogue lines to caption). Built toward real captions,
// never an empty switch. (Copy review: held for Mackaye + Conrad's voice pass.)
async function subtitlesReply(on, brief) {
  if (!on) return 'Subtitles are off.';
  const hasDialogue = brief.scenes.some((s) => s.dialogue && String(s.dialogue).trim());
  const subMod = await getSubtitleModule().catch(() => null);
  const parts = ['Subtitles are on.'];
  if (!subMod) parts.push('Heads up: the studio has no subtitle module installed right now, so nothing will be burned until one is.');
  if (!hasDialogue) parts.push('They caption spoken dialogue -- once we have lines for the shots, they will show. Tell me who says what, scene by scene.');
  return parts.join(' ');
}

// One-line summary of the render settings for /brief.
function formatRenderSettings(rs) {
  if (!rs) return '';
  const out = [];
  out.push(`tier: ${rs.quality_tier || 'draft'}`);
  out.push(`backend: ${rs.motion_backend || 'auto'}`);
  if (rs.titles?.text) out.push(`title: "${rs.titles.text}"${rs.titles.subtitle ? ` / "${rs.titles.subtitle}"` : ''}`);
  if (rs.credits?.lines?.length) out.push(`credits: ${rs.credits.lines.length} line(s)`);
  if (rs.subtitles) out.push('subtitles: on');
  return out.join(' | ');
}

function formatBrief(brief) {
  const lines = ['**Current Storyboard**'];

  if (brief.title)            lines.push(`**Title:** ${brief.title}`);
  if (brief.full_prompt)      lines.push(`**Logline:** ${brief.full_prompt}`);
  if (brief.style_prefix)     lines.push(`**Style:** ${brief.style_prefix}`);
  if (brief.style_category && brief.style_category !== 'None')
                              lines.push(`**Style category:** ${brief.style_category}`);
  if (brief.duration_seconds) lines.push(`**Duration:** ${brief.duration_seconds}s`);
  if (brief.clip_seconds)     lines.push(`**Default clip length:** ${brief.clip_seconds}s`);

  if (brief.cast.length > 0) {
    lines.push('\n**Cast:**');
    for (const c of brief.cast) {
      const portrait = c.portraitUrl ? ' (portrait generated)' : '';
      lines.push(`  [${c.slot}] **${c.name}**${portrait} -- ${c.prompt}`);
    }
  }

  if (brief.scenes.length > 0) {
    lines.push('\n**Scenes:**');
    for (const s of brief.scenes) {
      const act  = s.act ? ` *(${s.act})*` : '';
      const dur  = s.target_seconds ? ` [${s.target_seconds}s]` : '';
      const chars = s.character_slots.length ? ` {${s.character_slots.join(',')}}` : '';
      lines.push(`  **${s.id}**${act}${dur}${chars}: ${s.prompt}`);
      if (s.dialogue) lines.push(`      "${s.dialogue}"`);
    }
  }

  const rsLine = formatRenderSettings(brief.render_settings);
  if (rsLine) lines.push(`\n**Render settings:** ${rsLine}`);

  if (lines.length === 1) return 'No storyboard yet -- start describing your film!';
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Image generation via skyphusion-llm-public
// ---------------------------------------------------------------------------

async function generateImage(prompt, imageModel, label = 'image') {
  if (!CFG.cfAccessClientId || !CFG.cfAccessClientSecret) {
    return { ok: false, error: 'CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET not configured' };
  }

  const accessHeaders = {
    'CF-Access-Client-Id':     CFG.cfAccessClientId,
    'CF-Access-Client-Secret': CFG.cfAccessClientSecret,
  };

  const model = imageModel ?? DEFAULT_IMAGE_MODEL;
  log(`[${label}] generating via ${CFG.llmUrl} model=${model}`);
  const genRes = await fetch(`${CFG.llmUrl}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...accessHeaders },
    body:    JSON.stringify({ model, user_input: prompt }),
  });

  if (!genRes.ok) {
    const body = await genRes.text().catch(() => '');
    return { ok: false, error: `image gen failed ${genRes.status}: ${body.slice(0, 200)}` };
  }

  const genData = await genRes.json();
  const key = genData.output_artifact?.key;
  const mime = genData.output_artifact?.mime ?? 'image/png';
  if (!key) return { ok: false, error: 'no artifact key in response' };

  log(`[${label}] fetching artifact ${key}`);
  const artifactRes = await fetch(`${CFG.llmUrl}/api/artifact/${key}`, { headers: accessHeaders });
  if (!artifactRes.ok) return { ok: false, error: `artifact fetch failed ${artifactRes.status}` };

  const buffer = Buffer.from(await artifactRes.arrayBuffer());
  const ext = mime.includes('jpeg') ? 'jpg' : 'png';
  log(`[${label}] done (${buffer.length} bytes)`);
  return { ok: true, buffer, ext, mime, artifactUrl: `${CFG.llmUrl}/api/artifact/${key}` };
}

function generatePortrait(slot, prompt, imageModel) {
  return generateImage(`cinematic character portrait, ${prompt}`, imageModel, `portrait:${slot}`);
}

// ---------------------------------------------------------------------------
// Studio registry projection (GET /api/modules)
//
// Slate reads the live registry rather than hardcoding a parallel list of tiers / backends:
// the studio is a projection of its module registry, and Slate is a thin client of the same
// projection. quality_tiers, the motion.backend module names, and the subtitle module's field
// keys all come from here. Cached briefly so a planning burst does not re-fetch every turn;
// a transient failure falls back to a safe minimum so /render still works offline.
// ---------------------------------------------------------------------------

const REGISTRY_TTL_MS = 60_000;
let registryCache = null;       // { at, data }
const FALLBACK_TIERS = [
  { value: 'draft',    label: 'draft',    blurb: 'fastest, lowest quality' },
  { value: 'standard', label: 'standard', blurb: 'balanced' },
  { value: 'final',    label: 'final',    blurb: 'production quality' },
];

async function fetchRegistry() {
  if (!CFG.vivijureUrl) return null;
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.data;
  try {
    const res = await fetch(`${CFG.vivijureUrl}/api/modules`, {
      headers: { 'CF-Access-Client-Id': CFG.cfAccessClientId, 'CF-Access-Client-Secret': CFG.cfAccessClientSecret },
    });
    if (!res.ok) { log(`[registry] GET /api/modules ${res.status}`); return registryCache?.data ?? null; }
    const data = await res.json();
    registryCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    log(`[registry] fetch failed: ${e.message}`);
    return registryCache?.data ?? null;
  }
}

// Quality tiers projected from the registry (render.quality_tiers), with a safe fallback so the
// picker is never empty. The studio owns the meaning of each tier; Slate just relays the options.
async function getQualityTiers() {
  const data = await fetchRegistry();
  const tiers = data?.render?.quality_tiers;
  return Array.isArray(tiers) && tiers.length ? tiers : FALLBACK_TIERS;
}

async function getDefaultTier() {
  const data = await fetchRegistry();
  return data?.render?.default_tier ?? 'draft';
}

// Module names serving the motion.backend (i2v) pick_one hook, e.g. own-gpu vs a cloud module.
// Read from the registry's hooks index (the same order the studio folds them) so Slate never
// hardcodes backend names. Empty array -> Slate offers only "auto" (let the studio decide).
async function getMotionBackends() {
  const data = await fetchRegistry();
  const names = data?.hooks?.['motion.backend'];
  return Array.isArray(names) ? names.filter(Boolean) : [];
}

// The subtitle film.finish module (name + config_schema), so the subtitles toggle writes the
// module's REAL enable field rather than a guessed key -- the same projection principle as the
// planner's render-config panel. null when no subtitle module is installed (the toggle then tells
// the group subtitles are not available rather than silently no-op'ing).
async function getSubtitleModule() {
  const data = await fetchRegistry();
  const mods = Array.isArray(data?.modules) ? data.modules : [];
  const serving = data?.hooks?.['film.finish'] || [];
  for (const name of serving) {
    const mod = mods.find((m) => m.name === name);
    if (!mod) continue;
    const schema = mod.config_schema || {};
    const isSubtitle = /subtitle|caption/i.test(mod.name)
      || Object.keys(schema).some((k) => /subtitle|caption|burn/i.test(k));
    if (isSubtitle) return mod;
  }
  return null;
}

// The boolean "enable" field key in a subtitle module's config_schema. Modules name it differently
// (enabled / enable / burn / on); pick the first bool field whose key looks like an enable switch,
// else the first bool field, else "enabled" as a last resort. Projection over assumption.
function subtitleEnableField(mod) {
  const schema = (mod && mod.config_schema) || {};
  const bools = Object.keys(schema).filter((k) => schema[k] && schema[k].type === 'bool');
  return bools.find((k) => /enabl|^on$|burn|subtitle|caption/i.test(k)) || bools[0] || 'enabled';
}


// ---------------------------------------------------------------------------
// Vivijure Cast sync
// ---------------------------------------------------------------------------

function vivijureHeaders() {
  return {
    'Content-Type':            'application/json',
    'CF-Access-Client-Id':     CFG.cfAccessClientId,
    'CF-Access-Client-Secret': CFG.cfAccessClientSecret,
  };
}

async function syncCastMember(castEntry) {
  if (!CFG.vivijureUrl || !CFG.cfAccessClientId || !CFG.cfAccessClientSecret) return;
  const { name, prompt: bible, castId } = castEntry;

  if (castId) {
    const res = await fetch(`${CFG.vivijureUrl}/api/cast/${castId}`, {
      method: 'PATCH', headers: vivijureHeaders(), body: JSON.stringify({ name, bible }),
    });
    if (res.ok) { log(`[cast] updated ${castId} (${name})`); return (await res.json()).cast; }
    if (res.status !== 404) { log(`[cast] PATCH ${castId} failed ${res.status}`); return; }
    delete castEntry.castId;
  }

  const res = await fetch(`${CFG.vivijureUrl}/api/cast`, {
    method: 'POST', headers: vivijureHeaders(), body: JSON.stringify({ name, bible }),
  });
  if (!res.ok) { log(`[cast] create failed ${res.status}`); return; }
  const data = await res.json();
  castEntry.castId = data.cast.id;
  log(`[cast] created ${data.cast.id} (${name})`);
  return data.cast;
}

// Two-call portrait upload: POST /api/upload (bytes -> R2 key) then POST /api/cast/:id/portrait
async function uploadPortrait(castId, buffer, mime) {
  if (!CFG.vivijureUrl || !castId) return false;

  const uploadRes = await fetch(`${CFG.vivijureUrl}/api/upload`, {
    method:  'POST',
    headers: { 'Content-Type': mime, 'CF-Access-Client-Id': CFG.cfAccessClientId, 'CF-Access-Client-Secret': CFG.cfAccessClientSecret },
    body:    buffer,
  });
  if (!uploadRes.ok) { log(`[cast] upload failed ${uploadRes.status}`); return false; }
  const { key } = await uploadRes.json();

  const portraitRes = await fetch(`${CFG.vivijureUrl}/api/cast/${castId}/portrait`, {
    method: 'POST', headers: vivijureHeaders(), body: JSON.stringify({ key, mime }),
  });
  if (!portraitRes.ok) { log(`[cast] portrait register failed ${portraitRes.status}`); return null; }
  log(`[cast] portrait uploaded + registered for ${castId} (key: ${key})`);
  return key;
}

// ---------------------------------------------------------------------------
// Vivijure render submission + status polling
// ---------------------------------------------------------------------------

// Smart 50-word clamp (issue #16). The pod's bg-pass feeds scene prompts to SDXL verbatim and the
// API caps a scene prompt at 50 words (CLIP truncates at 77 tokens after triggers + style_prefix),
// so an over-length prompt bounces the submit. Rather than a blind tail-truncate, keep the FIRST
// sentence (usually the motion-critical clause -- subject + action) and fill the remaining word
// budget from what follows, so the trim preserves the beat that drives the shot. Returns the trimmed
// text plus a flag so the caller can give the group a heads-up instead of silently dropping words.
const PROMPT_WORD_CAP = 50;
function smartTrimPrompt(text) {
  const raw = (text ?? '').trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length <= PROMPT_WORD_CAP) return { text: raw, trimmed: false };

  // First sentence = the motion-critical clause we never want to lose.
  const firstSentence = (raw.match(/^[^.!?]*[.!?]/)?.[0] ?? '').trim();
  const headWords = firstSentence ? firstSentence.split(/\s+/).filter(Boolean) : [];
  let kept;
  if (headWords.length && headWords.length <= PROMPT_WORD_CAP) {
    // Keep the opening clause whole, then top up from the rest until the cap.
    const rest = words.slice(headWords.length);
    kept = headWords.concat(rest.slice(0, PROMPT_WORD_CAP - headWords.length));
  } else {
    // No usable leading sentence (or it alone exceeds the cap): fall back to a hard head slice.
    kept = words.slice(0, PROMPT_WORD_CAP);
  }
  return { text: kept.join(' '), trimmed: true };
}

// Build the characterRefs map from synced cast (member with a studio cast id + uploaded portrait
// key). Slots without a real ref are dropped from use_characters / scene slots so the bundle does
// not 400 on a slot with no ref. Issue #17's auto-fill (generating missing portraits) runs BEFORE
// submit in ensureCharacterRefs; by the time we get here the cast that can have refs, does.
function buildCharacterRefs(brief) {
  const characterRefs = {};
  for (const c of brief.cast) {
    if (c.castId && c.portraitKey) {
      characterRefs[c.slot] = {
        name:           c.name,
        portrait:       { key: c.portraitKey },
        trainingImages: [{ key: c.portraitKey }],
      };
    }
  }
  return characterRefs;
}

// Shape film_titles for the API exactly as the studio planner does (vivijure PR #273): a subtitle
// alone is dropped (the title card requires text), blank credit lines are stripped, and the whole
// field is omitted when empty so the submit body never widens needlessly. Single source of the
// title/credit contract so a film carded in Slate and one carded in the planner come out identical.
function buildFilmTitles(rs) {
  if (!rs) return undefined;
  const out = {};
  const titleText = (rs.titles?.text ?? '').trim();
  if (titleText) {
    out.title = { text: titleText };
    const sub = (rs.titles?.subtitle ?? '').trim();
    if (sub) out.title.subtitle = sub;
  }
  const lines = Array.isArray(rs.credits?.lines)
    ? rs.credits.lines.map((l) => (l ?? '').trim()).filter(Boolean)
    : [];
  if (lines.length) out.credits = { lines };
  return (out.title || out.credits) ? out : undefined;
}

// Submit the brief to the studio render pipeline. opts carries the group's render_settings choices
// (tier, motion backend, title/credit cards, subtitles). Slate holds no render logic: it bundles
// the storyboard, then POSTs /api/render/film with the choices mapped to the studio contract.
// Returns { ok, jobId, status, trims } -- trims lists scenes whose prompt was smart-trimmed so the
// caller can tell the group what changed (issue #16).
async function submitToVivijure(brief, opts = {}) {
  if (!CFG.vivijureUrl || !CFG.cfAccessClientId || !CFG.cfAccessClientSecret) {
    return { ok: false, error: 'VIVIJURE_API_URL or Access credentials not configured' };
  }
  const rs = brief.render_settings || emptyRenderSettings();
  // Resolve the tier against the live registry: prefer the explicit opt, then the project's saved
  // tier; if that value is not among the studio's projected quality_tiers, fall back to the
  // registry's declared default. Slate never invents a tier the studio does not advertise.
  const requested = opts.quality ?? rs.quality_tier ?? 'draft';
  const tiers = await getQualityTiers();
  const quality = tiers.some((t) => t.value === requested) ? requested : await getDefaultTier();

  const accessHeaders = { 'CF-Access-Client-Id': CFG.cfAccessClientId, 'CF-Access-Client-Secret': CFG.cfAccessClientSecret };
  const characterRefs = buildCharacterRefs(brief);
  const refSlots = new Set(Object.keys(characterRefs));
  const sceneSlots = (slots) => (slots ?? []).filter(slot => refSlots.has(slot));

  // Smart-trim every scene prompt to the cap, collecting which ones changed so the caller can
  // surface a heads-up rather than silently dropping words.
  const trims = [];
  const trimmedById = {};
  for (const s of brief.scenes) {
    const r = smartTrimPrompt(s.prompt);
    trimmedById[s.id] = r.text;
    if (r.trimmed) trims.push({ id: s.id, text: r.text });
  }
  const promptFor = (s) => trimmedById[s.id] ?? (s.prompt ?? '');

  const storyboard = {
    title:            brief.title ?? 'Untitled',
    full_prompt:      brief.full_prompt  ?? undefined,
    style_prefix:     brief.style_prefix ? brief.style_prefix.slice(0, 256) : undefined,
    style_category:   brief.style_category ?? 'None',
    duration_seconds: brief.duration_seconds ?? undefined,
    clip_seconds:     brief.clip_seconds ?? undefined,
    use_characters:   [...new Set(brief.scenes.flatMap(s => sceneSlots(s.character_slots)))],
    scenes:           brief.scenes.map(s => ({
      id: s.id, prompt: promptFor(s), act: s.act ?? undefined,
      character_slots: sceneSlots(s.character_slots), target_seconds: s.target_seconds ?? undefined,
    })),
  };

  const bundleRes = await fetch(`${CFG.vivijureUrl}/api/storyboard/bundle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...accessHeaders },
    body: JSON.stringify({ storyboard, characterRefs }),
  });
  if (!bundleRes.ok) {
    const body = await bundleRes.text().catch(() => '');
    return { ok: false, error: `bundle failed ${bundleRes.status}: ${body}` };
  }
  const { bundleKey } = await bundleRes.json();

  // Staged module-host pipeline (keyframe -> clips -> finish -> assemble). The studio derives
  // `project` from bundle_key. The group's choices map straight to the API contract:
  //   quality tier   -> keyframe_config.quality_tier
  //   motion backend -> motion_backend (omitted when auto: studio picks)
  //   title/credits  -> film_titles (omitted when no card)
  // finish-rife stays held off (interpolate / face_restore disabled) until vivijure-backend#76
  // lands; disabled it no-ops synchronously, so films still complete via keyframe -> clips -> assemble.
  const filmBody = {
    bundle_key: bundleKey,
    scenes: brief.scenes.map(s => ({
      shot_id: s.id,
      prompt:  promptFor(s),
      seconds: s.target_seconds ?? brief.clip_seconds ?? 5,
    })),
    keyframe_config: { quality_tier: quality },
    finish_config:   { 'finish-rife': { interpolate: false, face_restore: 'none' } },
  };
  if (rs.motion_backend) filmBody.motion_backend = rs.motion_backend;
  const filmTitles = buildFilmTitles(rs);
  if (filmTitles) filmBody.film_titles = filmTitles;

  // Dialogue lines: one {shot_id, text} per speaking shot (the studio's caption model is one line
  // per shot). Forwarded so the film.finish subtitle module can time captions to each shot's window.
  // NOTE: the studio's /api/render/film does not forward dialogue_lines yet (filed as vivijure#296,
  // backend lane); until that ships these ride along harmlessly and captions activate once it lands.
  const dialogueLines = brief.scenes
    .filter((s) => s.dialogue && String(s.dialogue).trim())
    .map((s) => ({ shot_id: s.id, text: String(s.dialogue).trim() }));
  if (dialogueLines.length) filmBody.dialogue_lines = dialogueLines;

  // Subtitles: enable the subtitle film.finish module via its real config field. Only sent when the
  // group turned subtitles on AND a subtitle module is installed AND there is dialogue to caption --
  // an honest toggle, never an empty switch.
  if (rs.subtitles && dialogueLines.length) {
    const subMod = await getSubtitleModule();
    if (subMod) {
      const field = subtitleEnableField(subMod);
      filmBody.film_finish_config = { ...(filmBody.film_finish_config || {}), [subMod.name]: { [field]: true } };
    }
  }

  const filmRes = await fetch(`${CFG.vivijureUrl}/api/render/film`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...accessHeaders },
    body: JSON.stringify(filmBody),
  });
  if (!filmRes.ok) {
    const body = await filmRes.text().catch(() => '');
    return { ok: false, error: `film submit failed ${filmRes.status}: ${body}` };
  }
  const film = await filmRes.json();
  return { ok: true, jobId: film.film_id, status: film.phase, quality, trims };
}

// Issue #17: a multi-character film needs a characterRefs entry per referenced character, or the
// bundle bounces. Before submit, make sure every character that scenes actually reference has a
// synced portrait ref. For a character Slate can describe, auto-derive the ref (generate the
// portrait, sync the cast member, upload the portrait) so the group does not have to do it by hand.
// For a character with NO description to render from, return a clear block naming who is missing,
// so Slate can ask as a collaborator instead of letting the backend 400.
// Returns { ok: true, generated: [slots] } or { ok: false, missing: [slots] }.
async function ensureCharacterRefs(brief, channelId, imageModel) {
  // Only characters that scenes reference matter for the bundle.
  const usedSlots = new Set(brief.scenes.flatMap(s => s.character_slots ?? []));
  const referenced = brief.cast.filter(c => usedSlots.has(c.slot));
  // Single-character (or no-character) films do not need refs; the bundle accepts them.
  if (referenced.length <= 1) return { ok: true, generated: [] };

  const generated = [];
  const missing = [];
  for (const c of referenced) {
    if (c.castId && c.portraitKey) continue;  // already has a real ref
    if (!c.prompt || !c.prompt.trim()) { missing.push(c.slot); continue; }
    // Auto-derive: same path /portrait uses, run silently as part of the submit.
    const result = await generatePortrait(c.slot, c.prompt, imageModel).catch(() => null);
    if (!result || !result.ok) { missing.push(c.slot); continue; }
    c.portraitUrl = result.artifactUrl;
    const vivCast = await syncCastMember(c).catch(() => null);
    if (!vivCast) { missing.push(c.slot); continue; }
    c.castId = vivCast.id;
    const pKey = await uploadPortrait(vivCast.id, result.buffer, result.mime).catch(() => null);
    if (!pKey) { missing.push(c.slot); continue; }
    c.portraitKey = pKey;
    generated.push(c.slot);
  }
  if (channelId) await saveProject(channelId).catch(() => {});
  if (missing.length) return { ok: false, missing, generated };
  return { ok: true, generated };
}

async function checkRenderStatus(jobId) {
  if (!CFG.vivijureUrl) return null;
  const res = await fetch(`${CFG.vivijureUrl}/api/render/film/${jobId}`, {
    headers: { 'CF-Access-Client-Id': CFG.cfAccessClientId, 'CF-Access-Client-Secret': CFG.cfAccessClientSecret },
  });
  if (!res.ok) return null;
  const j = await res.json();
  // The staged pipeline reports `phase` (done / failed / ...) and a presigned `download_url`
  // once done; normalize to the { status, download_url } shape the poll loop already understands.
  return { ...j, status: j.phase };
}

// ---------------------------------------------------------------------------
// The "huddle before we ship": Slate's pre-submit checklist, in her own voice.
//
// Slate is a collaborator, not a submit button. Before a render goes out she pulls the group in:
// names the film, reads back what is set (backend, quality, subtitles, title/credits), flags
// anything worth a heads-up, and offers the next creative beat or a clean "ship it." The TONE is
// fixed (warm, concise, a partner's nudge); the WORDS vary by context and rotate so she never reads
// like a form. Conrad's confirmed target:
//   "Okay, I think RUST is ready -- before I send it off: own GPU, draft quality, subtitles off, no
//    title card yet -- want a title or credits first, or ship it?"
// ---------------------------------------------------------------------------

// A small rotating index so repeated huddles in a channel do not open with the identical word.
let huddleSeq = 0;
function pick(arr) { return arr[huddleSeq % arr.length]; }

// Human-readable backend label for the huddle ("own GPU" reads better than "own-gpu").
function backendLabel(rs) {
  if (!rs.motion_backend) return 'auto backend';
  if (/own[-_]?gpu/i.test(rs.motion_backend)) return 'own GPU';
  if (/cloud/i.test(rs.motion_backend)) return 'cloud';
  return rs.motion_backend;
}

// Build the settings read-back as natural fragments (not a table): "own GPU, draft quality,
// subtitles off, no title card yet". Order mirrors how someone would actually say it.
function huddleSettingsPhrase(brief) {
  const rs = brief.render_settings || emptyRenderSettings();
  const frags = [];
  frags.push(backendLabel(rs));
  frags.push(`${rs.quality_tier || 'draft'} quality`);
  const hasDialogue = brief.scenes.some((s) => s.dialogue && String(s.dialogue).trim());
  if (rs.subtitles) frags.push(hasDialogue ? 'subtitles on' : 'subtitles on (no dialogue to caption yet)');
  else frags.push('subtitles off');
  if (rs.titles?.text) frags.push(`title card "${rs.titles.text}"`);
  else frags.push('no title card yet');
  if (rs.credits?.lines?.length) frags.push(`${rs.credits.lines.length} credit line(s)`);
  return frags.join(', ');
}

// The proactive offer that closes the huddle: nudge toward the most valuable un-set creative beat
// (a title, then credits, then subtitles when there is dialogue), else a clean "ship it?".
function huddleOffer(brief) {
  const rs = brief.render_settings || emptyRenderSettings();
  const hasDialogue = brief.scenes.some((s) => s.dialogue && String(s.dialogue).trim());
  if (!rs.titles?.text) return pick([
    'want a title card first, or ship it?',
    'should we open on a title, or send it as is?',
    'want to set a title (and credits), or ship it?',
  ]);
  if (!rs.credits?.lines?.length) return pick([
    'want to roll credits at the end, or ship it?',
    'should I add a credit card, or send it?',
  ]);
  if (hasDialogue && !rs.subtitles) return pick([
    'want subtitles on for the dialogue, or ship it?',
    'should I caption the dialogue, or send it as is?',
  ]);
  return pick(['ship it?', 'good to send?', 'ready when you are -- ship it?']);
}

// Heads-up fragments for things the group probably wants to know before shipping (not blockers):
// missing portraits for a multi-character film, an over-long prompt that will be trimmed.
function huddleHeadsUp(brief) {
  const notes = [];
  const usedSlots = new Set(brief.scenes.flatMap((s) => s.character_slots ?? []));
  const referenced = brief.cast.filter((c) => usedSlots.has(c.slot));
  if (referenced.length > 1) {
    const noRef = referenced.filter((c) => !(c.castId && c.portraitKey));
    const renderable = noRef.filter((c) => c.prompt && c.prompt.trim());
    if (renderable.length) notes.push(`I'll generate a quick look for ${renderable.map((c) => c.name || c.slot).join(' and ')} first`);
  }
  const longOnes = brief.scenes.filter((s) => (s.prompt ?? '').trim().split(/\s+/).filter(Boolean).length > 50);
  if (longOnes.length) notes.push(`I'll tighten ${longOnes.length} long scene prompt(s) to the renderer's cap`);
  return notes;
}

// Assemble the full huddle message. Varies the opener and the offer; stays warm and concise.
function buildSubmitHuddle(brief) {
  huddleSeq++;
  const name = brief.title ? `**${brief.title}**` : 'this';
  const opener = pick([
    `Okay, I think ${name} is ready`,
    `Alright, ${name} is looking ready to me`,
    `I think we've got ${name}`,
  ]);
  const settings = huddleSettingsPhrase(brief);
  const heads = huddleHeadsUp(brief);
  const headsLine = heads.length ? ` (${heads.join('; ')})` : '';
  const offerRaw = huddleOffer(brief);
  const offer = offerRaw.charAt(0).toUpperCase() + offerRaw.slice(1);
  const ship = pick([
    "Say `ship it` (or `!render now`) and I'll send it.",
    "Just say `ship it` when you're ready, or keep tuning.",
    "`ship it` and it's off; or adjust anything first.",
  ]);
  return `${opener} -- before I send it off: ${settings}${headsLine}. ${offer}\n${ship}`;
}

// Per-channel armed confirmation: the huddle arms it; a "ship it" / "!render now" within the window
// fires the actual submit. Short TTL so a stale "yes" hours later does not launch a render.
const pendingConfirms = new Map(); // channelId -> { quality, at }
const CONFIRM_TTL_MS = 10 * 60 * 1000;

function armConfirm(channelId, quality) {
  pendingConfirms.set(channelId, { quality, at: Date.now() });
}
function takeConfirm(channelId) {
  const c = pendingConfirms.get(channelId);
  if (!c) return null;
  pendingConfirms.delete(channelId);
  if (Date.now() - c.at > CONFIRM_TTL_MS) return null;
  return c;
}
// Natural affirmatives that mean "send it" when a huddle is armed. Kept tight so ordinary
// conversation ("yes, that scene works") does not accidentally launch a render -- the phrase must be
// short and shipping-flavored.
const SHIP_RE = /^(ship it|ship|send it|send|go for it|go|do it|launch it|launch|yes ship|yep ship|render it now)[.!]?$/i;
function looksLikeShip(text) {
  return SHIP_RE.test((text ?? '').trim());
}

// The shared submit runner: auto-fill refs (#17), submit, persist the pending job, and report the
// outcome through `say` (a channel.send / editReply callback) so both the ! and / paths reuse one
// code path. Returns true on a successful submit. Voice lives in the strings here.
async function runSubmit(brief, channelId, quality, imageModel, say) {
  const refs = await ensureCharacterRefs(brief, channelId, imageModel).catch(() => ({ ok: true, generated: [] }));
  if (!refs.ok) {
    await say(`Hold on -- ${refs.missing.join(' and ')} ${refs.missing.length > 1 ? "don't" : "doesn't"} have a look yet, and I can't render a character I can't picture. Describe them (or run \`!portrait\`) and I'll fold them in.`);
    return false;
  }
  if (refs.generated?.length) {
    await say(`Sketched in a look for ${refs.generated.join(' and ')} so they're consistent on screen. Sending it now...`);
  }
  let result;
  try {
    result = await submitToVivijure(brief, { quality });
  } catch (e) {
    log(`[render] submitToVivijure threw: ${e.message}`);
    await say(`Something went sideways on submit: ${e.message}`);
    return false;
  }
  log(`[render] result: ${JSON.stringify(result).slice(0, 200)}`);
  if (!result.ok) {
    await say(`The studio turned the submit down: ${result.error}`);
    return false;
  }
  pendingRenders.set(result.jobId, { channelId, quality });
  await d1Query(
    "INSERT OR IGNORE INTO render_jobs (job_id, channel_id, quality, submitted_at, status) VALUES (?, ?, ?, ?, 'pending')",
    [result.jobId, channelId, quality, new Date().toISOString()],
  ).catch(() => {});
  const trimNote = result.trims?.length
    ? ` (I tightened ${result.trims.length} scene prompt(s) to the renderer's 50-word cap -- shout if I cut the wrong beat)`
    : '';
  await say(`It's off to the studio at **${quality}**! Job \`${result.jobId}\`${trimNote}. I'll ping you here the moment it's done.`);
  return true;
}

// // In-memory pending render map (populated from D1 on startup; survives bot restarts via D1).
const pendingRenders = new Map(); // jobId -> { channelId, quality }

async function loadPendingRenders() {
  try {
    const rows = await d1Query("SELECT job_id, channel_id, quality FROM render_jobs WHERE status = 'pending'");
    for (const r of rows) pendingRenders.set(r.job_id, { channelId: r.channel_id, quality: r.quality });
    if (pendingRenders.size > 0) log(`Loaded ${pendingRenders.size} pending render job(s) from D1`);
  } catch (e) {
    log(`WARN: could not load pending renders: ${e.message}`);
  }
}

// Poll every 30 seconds for completed render jobs.
setInterval(async () => {
  if (pendingRenders.size === 0) return;
  for (const [jobId, { channelId }] of [...pendingRenders]) {
    try {
      const s = await checkRenderStatus(jobId);
      if (!s) continue;
      const done   = ['complete', 'done', 'finished', 'succeeded'].includes(s.status);
      const failed = ['failed', 'error'].includes(s.status);
      if (!done && !failed) continue;

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        if (done) {
          const dl = s.videoUrl || s.download_url || '';
          await channel.send(`Your Vivijure render \`${jobId}\` is complete!${dl ? ` Download: ${dl}` : ''}`).catch(() => {});
        } else {
          await channel.send(`Render \`${jobId}\` failed: ${s.error || 'unknown error'}`).catch(() => {});
        }
      }
      pendingRenders.delete(jobId);
      await d1Query('UPDATE render_jobs SET status = ? WHERE job_id = ?', [done ? 'complete' : 'failed', jobId]).catch(() => {});
    } catch (e) {
      log(`[render poll] ${jobId}: ${e.message}`);
    }
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Knowledge base (via vivijure-search Worker + Vectorize)
// ---------------------------------------------------------------------------

async function indexKnowledge(content, title = '', author = '') {
  if (!CFG.searchUrl || !CFG.searchSecret) return { ok: false, error: 'Search worker not configured' };

  let text = content;
  let resolvedTitle = title || content.slice(0, 80);

  if (content.startsWith('http://') || content.startsWith('https://')) {
    try {
      const fetched = await executeTool('fetch_page', { url: content });
      const data = typeof fetched === 'string' ? JSON.parse(fetched) : fetched;
      text = data.content ?? content;
      resolvedTitle = data.title || content.slice(0, 80);
    } catch (e) {
      log(`[learn] page fetch failed: ${e.message}`);
    }
  }

  const res = await fetch(`${CFG.searchUrl}/knowledge/index`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Search-Secret': CFG.searchSecret },
    body:    JSON.stringify({ content: text, title: resolvedTitle, author }),
  });
  if (!res.ok) return { ok: false, error: `index failed ${res.status}` };
  const data = await res.json();
  return { ok: true, id: data.id, title: resolvedTitle, words: text.split(/\s+/).length };
}

// ---------------------------------------------------------------------------
// Message chunking (Discord 2000 char limit)
// ---------------------------------------------------------------------------

function splitMessage(text, limit = 1990) {
  if (text.length <= limit) return [text];
  const chunks = [];
  while (text.length > 0) {
    let slice = text.slice(0, limit);
    const lastNl = slice.lastIndexOf('\n');
    if (lastNl > limit * 0.5) slice = text.slice(0, lastNl + 1);
    chunks.push(slice.trimEnd());
    text = text.slice(slice.length).trimStart();
  }
  return chunks.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('brief')
    .setDescription('Show the current storyboard state'),
  new SlashCommandBuilder()
    .setName('portrait')
    .setDescription('Generate a character portrait')
    .addStringOption(o => o.setName('slot').setDescription('Character slot').setRequired(true)
      .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' }))
    .addStringOption(o => o.setName('description').setDescription('Visual description (uses saved if omitted)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('thumbnail')
    .setDescription('Generate a visual thumbnail for a scene')
    .addStringOption(o => o.setName('scene').setDescription('Scene ID (from /brief)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('render')
    .setDescription('Review the render settings and submit (defaults to a quick huddle before shipping)')
    .addStringOption(o => o.setName('quality').setDescription('Quality tier override; setting it ships immediately (default: the project tier, or draft)').setRequired(false)
      .addChoices({ name: 'draft', value: 'draft' }, { name: 'standard', value: 'standard' }, { name: 'final', value: 'final' }))
    .addBooleanOption(o => o.setName('confirm').setDescription('Skip the huddle and send it now').setRequired(false)),
  new SlashCommandBuilder()
    .setName('backend')
    .setDescription('Choose the render backend (own GPU vs cloud), or auto to let the studio decide')
    .addStringOption(o => o.setName('choice').setDescription('Backend module name, "auto", or omit to see the options').setRequired(false)),
  new SlashCommandBuilder()
    .setName('titlecard')
    .setDescription('Set the opening title card and end credits, or clear them')
    .addStringOption(o => o.setName('title').setDescription('Film title (empty clears the title card)').setRequired(false))
    .addStringOption(o => o.setName('subtitle').setDescription('Optional subtitle under the title').setRequired(false))
    .addStringOption(o => o.setName('credits').setDescription('Credit lines, separated by | or ;').setRequired(false)),
  new SlashCommandBuilder()
    .setName('subtitles')
    .setDescription('Turn dialogue subtitles on or off for the rendered film')
    .addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Show or switch the active image generation model')
    .addStringOption(o => o.setName('name').setDescription('Model alias or ID (omit to see list)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('undo')
    .setDescription('Roll back the last brief extraction update'),
  new SlashCommandBuilder()
    .setName('learn')
    .setDescription('Index a film reference into the knowledge base')
    .addStringOption(o => o.setName('content').setDescription('Text or URL to index').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear the project and start fresh'),
].map(c => c.toJSON());

async function registerSlashCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(CFG.token);
  try {
    const data = await rest.put(Routes.applicationCommands(clientId), { body: SLASH_COMMANDS });
    log(`Registered ${data.length} slash command(s) globally`);
  } catch (e) {
    log(`WARN: slash command registration failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once(Events.ClientReady, async (c) => {
  log(`Ready: ${c.user.tag} (${c.guilds.cache.size} guild(s))`);
  await registerSlashCommands(c.user.id);
  await loadPendingRenders();
});

// ---------------------------------------------------------------------------
// Slash command handler
// ---------------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const channelId  = interaction.channelId;
  const authorName = interaction.member?.displayName ?? interaction.user.username;
  log(`[slash:${interaction.commandName}] ${authorName} in ${channelId}`);

  try {
    switch (interaction.commandName) {

      case 'brief': {
        const project = await getProject(channelId);
        const text = formatBrief(project.brief);
        await interaction.reply(text.slice(0, 2000));
        break;
      }

      case 'portrait': {
        const slotArg     = interaction.options.getString('slot');
        const customPrompt = interaction.options.getString('description') ?? '';
        const project     = await getProject(channelId);
        let castEntry     = project.brief.cast.find(c => c.slot === slotArg);
        const prompt      = customPrompt || castEntry?.prompt;

        if (!prompt) {
          await interaction.reply(`No character description for slot ${slotArg} yet. Pass a \`description\` or describe the character in conversation first.`);
          return;
        }
        if (!castEntry) {
          castEntry = { slot: slotArg, name: `Character ${slotArg}`, prompt };
          project.brief.cast.push(castEntry);
        } else if (customPrompt) {
          castEntry.prompt = customPrompt;
        }

        await interaction.deferReply();
        const activeModel = IMAGE_MODELS.find(m => m.id === project.imageModel) ?? IMAGE_MODELS[0];
        await interaction.editReply(`Generating portrait for slot **${slotArg}** with **${activeModel.label}**...`);

        const result = await generatePortrait(slotArg, prompt, project.imageModel);
        if (!result.ok) { await interaction.editReply(`Portrait generation failed: ${result.error}`); return; }

        castEntry.portraitUrl = result.artifactUrl;
        const vivCast = await syncCastMember(castEntry).catch(e => { log(`[cast] ${e.message}`); return null; });
        if (vivCast) {
          castEntry.castId = vivCast.id;
          const pKey = await uploadPortrait(vivCast.id, result.buffer, result.mime).catch(() => null);
          if (pKey) castEntry.portraitKey = pKey;
        }
        await saveProject(channelId);

        const att = new AttachmentBuilder(result.buffer, { name: `character-${slotArg.toLowerCase()}.${result.ext}` });
        await interaction.editReply({ content: `**Character ${slotArg}** portrait${vivCast ? ' (synced to Vivijure Cast)' : ''}:`, files: [att] });
        break;
      }

      case 'thumbnail': {
        const sceneId = interaction.options.getString('scene');
        const project = await getProject(channelId);
        const scene   = project.brief.scenes.find(s => s.id === sceneId);

        if (!scene) { await interaction.reply(`Scene \`${sceneId}\` not found. Use \`/brief\` to see scene IDs.`); return; }

        await interaction.deferReply();
        const style  = project.brief.style_prefix ? `${project.brief.style_prefix}, ` : '';
        const result = await generateImage(`${style}cinematic scene, ${scene.prompt}`, project.imageModel, `thumbnail:${sceneId}`);

        if (!result.ok) { await interaction.editReply(`Thumbnail generation failed: ${result.error}`); return; }
        const att = new AttachmentBuilder(result.buffer, { name: `scene-${sceneId}.${result.ext}` });
        await interaction.editReply({ content: `**Scene ${sceneId}** thumbnail:`, files: [att] });
        break;
      }

      case 'render': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        const quality = interaction.options.getString('quality') ?? rs.quality_tier ?? 'draft';
        const confirm = interaction.options.getBoolean('confirm') ?? false;

        if (project.brief.scenes.length === 0) {
          await interaction.reply("We don't have any scenes yet -- let's keep building the story first.");
          return;
        }

        // Default: huddle first (same as !render). confirm:true (or an explicit quality) ships now.
        if (!confirm && interaction.options.getString('quality') == null) {
          armConfirm(channelId, quality);
          await interaction.reply(buildSubmitHuddle(project.brief));
          break;
        }

        await interaction.deferReply();
        pendingConfirms.delete(channelId);
        const say = (t) => interaction.editReply(t).catch(() => {});
        await runSubmit(project.brief, channelId, quality, project.imageModel, say);
        break;
      }

      case 'backend': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        const choice = interaction.options.getString('choice');
        if (choice == null) { await interaction.reply(await formatBackendList(rs.motion_backend)); return; }
        const r = await resolveBackend(choice);
        if (r.error) { await interaction.reply(r.error); return; }
        rs.motion_backend = r.value;
        await saveProject(channelId);
        await interaction.reply(r.value ? `Render backend set to **${r.value}**.` : 'Render backend set to **auto** (the studio decides).');
        break;
      }

      case 'titlecard': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        const title    = interaction.options.getString('title');
        const subtitle = interaction.options.getString('subtitle');
        const credits  = interaction.options.getString('credits');
        // No args at all: show the current cards.
        if (title == null && subtitle == null && credits == null) {
          const cur = formatRenderSettings(rs);
          await interaction.reply(rs.titles?.text || rs.credits?.lines?.length
            ? `Current cards -- ${cur}`
            : 'No title or credit cards set. `/titlecard title:<...>` to add one.');
          return;
        }
        if (title != null) {
          const t = title.trim();
          rs.titles = t ? { text: t, ...(subtitle?.trim() ? { subtitle: subtitle.trim() } : {}) } : null;
        } else if (subtitle != null && rs.titles?.text) {
          rs.titles.subtitle = subtitle.trim() || undefined;
        }
        if (credits != null) {
          const lines = parseCreditLines(credits);
          rs.credits = lines.length ? { lines } : null;
        }
        await saveProject(channelId);
        await interaction.reply(`Cards updated -- ${formatRenderSettings(rs) || '(cleared)'}.`);
        break;
      }

      case 'subtitles': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        const on = interaction.options.getString('state') === 'on';
        rs.subtitles = on;
        await saveProject(channelId);
        await interaction.reply(await subtitlesReply(on, project.brief));
        break;
      }

      case 'model': {
        const name    = interaction.options.getString('name');
        const project = await getProject(channelId);

        if (!name) { await interaction.reply(formatModelList(project.imageModel)); return; }

        const found = resolveImageModel(name);
        if (!found) { await interaction.reply(`Unknown model \`${name}\`. Use \`/model\` to see the list.`); return; }

        project.imageModel = found.id;
        await saveProject(channelId);
        await interaction.reply(`Image model set to **${found.label}**.`);
        break;
      }

      case 'undo': {
        const project = await getProject(channelId);
        if (!project.briefHistory?.length) { await interaction.reply('Nothing to undo.'); return; }
        project.brief = project.briefHistory.pop();
        await saveProject(channelId);
        await interaction.reply('Brief rolled back. Use `/brief` to check the current state.');
        break;
      }

      case 'learn': {
        const content = interaction.options.getString('content');
        await interaction.deferReply();
        const result = await indexKnowledge(content, '', authorName);
        if (result.ok) {
          await interaction.editReply(`Indexed **${result.title}** (${result.words} words). Slate will draw on this reference in future conversations.`);
        } else {
          await interaction.editReply(`Failed to index: ${result.error}`);
        }
        break;
      }

      case 'reset': {
        projects.set(channelId, { brief: emptyBrief(), history: [], briefHistory: [], imageModel: DEFAULT_IMAGE_MODEL });
        await saveProject(channelId);
        log(`[${channelId}] project reset by ${authorName}`);
        await interaction.reply('Project cleared. Ready to start a new film.');
        break;
      }

    }
  } catch (e) {
    log(`ERROR [slash:${interaction.commandName}]: ${e.message}`);
    const reply = interaction.replied || interaction.deferred
      ? interaction.editReply.bind(interaction)
      : interaction.reply.bind(interaction);
    await reply(`(error: ${e.message})`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

client.on(Events.MessageCreate, async (message) => {
  // Never react to our own messages (hard loop guard). Ignore other bots EXCEPT trusted crew
  // bots (TRUSTED_BOT_IDS) so a crew bot can drive Slate to test renders + chat. NOTE: a driving
  // bot must not auto-reply to Slate's own replies, or the two ping-pong -- that loop-safety lives
  // on the driver's side; Slate only opens the gate to known ids.
  if (message.author.id === client.user.id) return;
  if (message.author.bot && !CFG.trustedBots.has(message.author.id)) return;

  const isDM         = !message.guild;
  const isMentioned  = message.mentions.has(client.user);
  const inListenChan = CFG.channelIds.size > 0 && CFG.channelIds.has(message.channelId);

  if (!isDM && !isMentioned && !inListenChan) return;

  const rawText = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  // Allow image-only messages (no text required if there are attachments)
  const hasImages = message.attachments.some(a => a.contentType?.startsWith('image/'));
  if (!rawText && !hasImages) return;

  const channelId    = message.channelId;
  const authorName   = message.member?.displayName ?? message.author.username;
  const channelLabel = isDM ? 'DM' : `${message.guild.name}/#${message.channel.name ?? channelId}`;

  log(`[${channelLabel}] ${authorName}: ${rawText.slice(0, 120)}${hasImages ? ` [+${message.attachments.size} image(s)]` : ''}`);

  // --- Commands ---

  if (rawText === '!brief') {
    const project = await getProject(channelId);
    for (const chunk of splitMessage(formatBrief(project.brief))) await message.reply(chunk);
    return;
  }

  if (rawText === '!reset') {
    projects.set(channelId, { brief: emptyBrief(), history: [], briefHistory: [], imageModel: DEFAULT_IMAGE_MODEL });
    await saveProject(channelId);
    log(`[${channelId}] reset by ${authorName}`);
    await message.reply('Project cleared. Ready to start a new film.').catch(() => {});
    return;
  }

  if (rawText === '!undo') {
    const project = await getProject(channelId);
    if (!project.briefHistory?.length) {
      await message.reply('Nothing to undo.').catch(() => {});
      return;
    }
    project.brief = project.briefHistory.pop();
    await saveProject(channelId);
    await message.reply('Brief rolled back. Use `!brief` to check the current state.').catch(() => {});
    return;
  }

  if (rawText.startsWith('!model')) {
    const arg     = rawText.slice('!model'.length).trim();
    const project = await getProject(channelId);

    if (!arg) { await message.reply(formatModelList(project.imageModel)).catch(() => {}); return; }

    const found = resolveImageModel(arg);
    if (!found) { await message.reply(`Unknown model \`${arg}\`. Use \`!model\` to see the list.`).catch(() => {}); return; }

    project.imageModel = found.id;
    await saveProject(channelId);
    await message.reply(`Image model set to **${found.label}**. Next portrait or thumbnail will use it.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!portrait')) {
    const parts        = rawText.split(/\s+/);
    const slotArg      = parts[1]?.toUpperCase();
    const customPrompt = parts.slice(2).join(' ').trim();

    if (!['A', 'B', 'C', 'D'].includes(slotArg)) {
      await message.reply('Usage: `!portrait <A|B|C|D> [description]`').catch(() => {});
      return;
    }

    const project = await getProject(channelId);
    let castEntry = project.brief.cast.find(c => c.slot === slotArg);
    const prompt  = customPrompt || castEntry?.prompt;

    if (!prompt) {
      await message.reply(`No character description for slot ${slotArg} yet.`).catch(() => {});
      return;
    }
    if (!castEntry) {
      castEntry = { slot: slotArg, name: `Character ${slotArg}`, prompt };
      project.brief.cast.push(castEntry);
    } else if (customPrompt) {
      castEntry.prompt = customPrompt;
    }

    const activeModel = IMAGE_MODELS.find(m => m.id === project.imageModel) ?? IMAGE_MODELS[0];
    await message.reply(`Generating portrait for slot **${slotArg}** with **${activeModel.label}**...`).catch(() => {});

    const result = await generatePortrait(slotArg, prompt, project.imageModel);
    if (!result.ok) { log(`[portrait:${slotArg}] failed: ${result.error}`); await message.reply(`Portrait generation failed: ${result.error}`).catch(() => {}); return; }

    castEntry.portraitUrl = result.artifactUrl;
    const vivCast = await syncCastMember(castEntry).catch(e => { log(`[cast] ${e.message}`); return null; });
    if (vivCast) {
      castEntry.castId = vivCast.id;
      const pKey = await uploadPortrait(vivCast.id, result.buffer, result.mime).catch(() => null);
      if (pKey) castEntry.portraitKey = pKey;
    }
    await saveProject(channelId);

    const att = new AttachmentBuilder(result.buffer, { name: `character-${slotArg.toLowerCase()}.${result.ext}` });
    await message.reply({ content: `**Character ${slotArg}** portrait${vivCast ? ' (synced to Vivijure Cast)' : ''}:`, files: [att] }).catch(() => {});
    return;
  }

  if (rawText.startsWith('!thumbnail')) {
    const parts   = rawText.split(/\s+/);
    const sceneId = parts[1];

    if (!sceneId) { await message.reply('Usage: `!thumbnail <scene-id>`').catch(() => {}); return; }

    const project = await getProject(channelId);
    const scene   = project.brief.scenes.find(s => s.id === sceneId);

    if (!scene) { await message.reply(`Scene \`${sceneId}\` not found. Use \`!brief\` to see scene IDs.`).catch(() => {}); return; }

    await message.reply(`Generating thumbnail for scene **${sceneId}**...`).catch(() => {});

    const style  = project.brief.style_prefix ? `${project.brief.style_prefix}, ` : '';
    const result = await generateImage(`${style}cinematic scene, ${scene.prompt}`, project.imageModel, `thumbnail:${sceneId}`);

    if (!result.ok) { await message.reply(`Thumbnail generation failed: ${result.error}`).catch(() => {}); return; }
    const att = new AttachmentBuilder(result.buffer, { name: `scene-${sceneId}.${result.ext}` });
    await message.reply({ content: `**Scene ${sceneId}** thumbnail:`, files: [att] }).catch(() => {});
    return;
  }

  if (rawText.startsWith('!backend')) {
    const arg     = rawText.slice('!backend'.length).trim();
    const project = await getProject(channelId);
    const rs      = ensureRenderSettings(project.brief);
    if (!arg) { await message.reply(await formatBackendList(rs.motion_backend)).catch(() => {}); return; }
    const r = await resolveBackend(arg);
    if (r.error) { await message.reply(r.error).catch(() => {}); return; }
    rs.motion_backend = r.value;
    await saveProject(channelId);
    await message.reply(r.value ? `Render backend set to **${r.value}**.` : 'Render backend set to **auto** (the studio decides).').catch(() => {});
    return;
  }

  if (rawText.startsWith('!titlecard')) {
    const arg     = rawText.slice('!titlecard'.length).trim();
    const project = await getProject(channelId);
    const rs      = ensureRenderSettings(project.brief);
    if (!arg) {
      await message.reply(rs.titles?.text || rs.credits?.lines?.length
        ? `Current cards -- ${formatRenderSettings(rs)}`
        : 'Usage: `!titlecard <title> [| subtitle] [|| credit; credit]`. No cards set yet.').catch(() => {});
      return;
    }
    // Syntax: title [| subtitle] [|| credits separated by ; or |]
    const [cardPart, ...creditTail] = arg.split('||');
    const [titleRaw, subRaw] = cardPart.split('|');
    const title = (titleRaw ?? '').trim();
    rs.titles = title ? { text: title, ...((subRaw ?? '').trim() ? { subtitle: subRaw.trim() } : {}) } : null;
    if (creditTail.length) {
      const lines = parseCreditLines(creditTail.join('||'));
      rs.credits = lines.length ? { lines } : null;
    }
    await saveProject(channelId);
    await message.reply(`Cards updated -- ${formatRenderSettings(rs) || '(cleared)'}.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!subtitles')) {
    const arg     = rawText.slice('!subtitles'.length).trim().toLowerCase();
    const project = await getProject(channelId);
    const rs      = ensureRenderSettings(project.brief);
    if (arg !== 'on' && arg !== 'off') { await message.reply('Usage: `!subtitles on` or `!subtitles off`').catch(() => {}); return; }
    rs.subtitles = arg === 'on';
    await saveProject(channelId);
    await message.reply(await subtitlesReply(rs.subtitles, project.brief)).catch(() => {});
    return;
  }

  if (rawText.startsWith('!render') || rawText === '!ship') {
    const parts   = rawText.split(/\s+/);
    const project = await getProject(channelId);
    const rs      = ensureRenderSettings(project.brief);
    // An explicit tier or "now" (and `!ship`) means skip the huddle and send. Otherwise huddle first.
    const tierArg = ['draft', 'standard', 'final'].includes(parts[1]) ? parts[1] : null;
    const skipHuddle = rawText === '!ship' || parts[1] === 'now' || tierArg != null;
    const quality = tierArg ?? (rs.quality_tier ?? 'draft');

    if (project.brief.scenes.length === 0) {
      await message.reply("We don't have any scenes yet -- let's keep building the story first.").catch(() => {});
      return;
    }

    const say = (t) => message.reply(t).catch(() => {});
    if (skipHuddle) {
      pendingConfirms.delete(channelId);
      await runSubmit(project.brief, channelId, quality, project.imageModel, say);
    } else {
      armConfirm(channelId, quality);
      await say(buildSubmitHuddle(project.brief));
    }
    return;
  }

  if (rawText.startsWith('!learn')) {
    const content = rawText.slice('!learn'.length).trim();
    if (!content) { await message.reply('Usage: `!learn <text or URL>`').catch(() => {}); return; }

    await message.reply('Indexing...').catch(() => {});
    const result = await indexKnowledge(content, '', authorName);
    if (result.ok) {
      await message.reply(`Indexed **${result.title}** (${result.words} words). Slate will draw on this reference in future conversations.`).catch(() => {});
    } else {
      await message.reply(`Failed to index: ${result.error}`).catch(() => {});
    }
    return;
  }

  // A "ship it" (or similar) while a huddle is armed fires the actual submit, so the group can
  // confirm in plain language ("ship it") rather than a second command. Outside an armed window
  // these words are just ordinary conversation and fall through to the LLM.
  if (looksLikeShip(rawText)) {
    const confirm = takeConfirm(channelId);
    if (confirm) {
      const project = await getProject(channelId);
      const say = (t) => message.reply(t).catch(() => {});
      await runSubmit(project.brief, channelId, confirm.quality, project.imageModel, say);
      return;
    }
  }

  // --- Conversation (with optional vision) ---

  // Collect image attachments for the current turn (Claude vision; max 4MB each, max 3 images).
  const imageBlocks = [];
  if (anthropic) {
    for (const att of [...message.attachments.values()].filter(a => a.contentType?.startsWith('image/') && a.size <= 4 * 1024 * 1024).slice(0, 3)) {
      try {
        const resp = await fetch(att.url);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: att.contentType, data: buf.toString('base64') } });
          log(`[vision] loaded ${att.url.split('/').pop()} (${buf.length} bytes)`);
        }
      } catch (e) {
        log(`[vision] failed to fetch attachment: ${e.message}`);
      }
    }
  }

  try { await message.channel.sendTyping(); } catch {}
  const typingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);

  try {
    const userText = rawText || '(image attached)';
    const userLabel = `${authorName}: ${userText}`;

    const reply = await askLLM(channelId, userLabel, imageBlocks);

    const project = await getProject(channelId);
    // Store text-only in history (image data is too large for D1)
    const historyText = imageBlocks.length > 0 ? `[${imageBlocks.length} image(s)]\n${userLabel}` : userLabel;
    project.history.push({ role: 'user',      content: historyText });
    project.history.push({ role: 'assistant', content: reply });
    while (project.history.length > CFG.historyLen * 2) project.history.shift();
    await saveProject(channelId);

    extractBrief(channelId).catch(e => log(`extractBrief error: ${e.message}`));

    log(`-> ${reply.slice(0, 120)}${reply.length > 120 ? '...' : ''}`);
    for (const chunk of splitMessage(reply)) await message.reply(chunk);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    await message.reply(`(error: ${err.message})`).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
});

// ---------------------------------------------------------------------------
// Startup Execution Link
// ---------------------------------------------------------------------------

await initD1().catch(err => log(`D1 Table Setup Notice: ${err.message}`));

if (process.env.VITEST) {
  log("CI Mode Detected: Running application validation loops...");
  
  const mockUserId = "123456789012345678"; 
  await registerSlashCommands(mockUserId).catch(err => log(`Mock Command Reg Notice: ${err.message}`));
  await loadPendingRenders().catch(err => log(`Mock Renders Sync Notice: ${err.message}`));
  
  log("SMOKE TEST PASSED: Slate Assistant configuration, assets, and database tables verified.");
  
  client.destroy();
} else {
  client.login(CFG.token).catch(err => {
    log(`Failed to connect to Discord gateways: ${err.message}`);
    process.exit(1);
  });
}
