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
//   OLLAMA_BASE_URL             ollama OpenAI-compat base  (default http://wendy.internal:11434/v1)
//   DISCORD_MODEL               model id                   (default qwen3.6:27b-ctx8k)
//   DISCORD_HISTORY             rolling history depth in exchange pairs (default 20)
//   DISCORD_LOG                 tee logs to this file path (optional)
//   VIVIJURE_API_URL            Vivijure Worker base URL for !render submissions
//   LLM_API_URL                 skyphusion-llm-public base URL for image generation
//                               (default https://play.skyphusion.org)
//   CF_ACCESS_CLIENT_ID         Cloudflare Access service token client ID
//   CF_ACCESS_CLIENT_SECRET     Cloudflare Access service token client secret
//   CF_D1_TOKEN                 Cloudflare API token with D1:Write permission
//   CF_D1_ACCOUNT_ID            Cloudflare account ID (fabcb25d9c7eb087110ec474a03e50d2)
//   CF_D1_DATABASE_ID           D1 database ID (faac1698-5ffe-4f0e-8147-761c0747e957)
//   CF_AIG_TOKEN                Cloudflare API token for the AI Gateway (Anthropic path).
//                               When set the main conversation uses Claude via CF AI Gateway.
//                               Falls back to ollama when unset.
//   CF_GATEWAY_ENDPOINT         CF AI Gateway compat URL (used to derive the Anthropic base URL).
//   SEARCH_WORKER_URL           vivijure-search Worker base URL (enables web search + knowledge base)
//   SEARCH_SECRET               shared secret for X-Search-Secret header
//
// ! commands:
//   !brief                 show the current storyboard state
//   !portrait <A|B|C|D> [desc]  generate + sync a character portrait
//   !thumbnail <scene-id>  generate a visual thumbnail for a scene
//   !model [name|id]       show available image models / switch the active one
//   !render [quality]      submit to Vivijure (quality: draft | standard | final)
//   !undo                  roll back the last brief extraction
//   !learn <text or URL>   index a film reference into the knowledge base
//   !reset                 clear the project and start fresh
//
// Slash commands: /brief /portrait /thumbnail /model /render /undo /learn /reset
// (registered globally on startup; guild propagation is instant, global takes ~1 hour)

import Anthropic from '@anthropic-ai/sdk';
import { AttachmentBuilder, Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { appendFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_FILE = process.env.DISCORD_LOG ?? '';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (LOG_FILE) try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
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
  ollamaBase:           process.env.OLLAMA_BASE_URL         ?? 'http://wendy.internal:11434/v1',
  model:                process.env.DISCORD_MODEL           ?? 'qwen3.6:27b-ctx8k',
  channelIds:           new Set((process.env.DISCORD_CHANNEL_IDS ?? '').split(',').filter(Boolean)),
  trustedBots:          new Set((process.env.TRUSTED_BOT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  historyLen:           parseInt(process.env.DISCORD_HISTORY ?? '20', 10),
  vivijureUrl:          process.env.VIVIJURE_API_URL        ?? '',
  llmUrl:               process.env.LLM_API_URL             ?? 'https://play.skyphusion.org',
  cfAccessClientId:     process.env.CF_ACCESS_CLIENT_ID     ?? '',
  cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? '',
  d1Token:              process.env.CF_D1_TOKEN             ?? '',
  d1AccountId:          process.env.CF_D1_ACCOUNT_ID        ?? 'fabcb25d9c7eb087110ec474a03e50d2',
  d1DatabaseId:         process.env.CF_D1_DATABASE_ID       ?? 'faac1698-5ffe-4f0e-8147-761c0747e957',
  aigToken:             process.env.CF_AIG_TOKEN            ?? '',
  gatewayEndpoint:      process.env.CF_GATEWAY_ENDPOINT     ?? '',
  searchUrl:            process.env.SEARCH_WORKER_URL       ?? '',
  searchSecret:         process.env.SEARCH_SECRET           ?? '',
};

// Anthropic client via CF AI Gateway (native path, not OpenAI compat).
const anthropicBase = CFG.gatewayEndpoint
  ? CFG.gatewayEndpoint.replace('/compat/chat/completions', '') + '/anthropic'
  : 'https://gateway.ai.cloudflare.com/v1/fabcb25d9c7eb087110ec474a03e50d2/skyphusion-llm/anthropic';
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
  };
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

The storyboard brief updates automatically in the background. Available commands:
- !brief / /brief               -- see the current storyboard state
- !portrait A [desc] / /portrait -- generate a character portrait for slot A, B, C, or D
- !thumbnail <scene-id> / /thumbnail -- generate a visual thumbnail for a scene
- !render / /render             -- submit to Vivijure for rendering
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
  "scenes": [{ "id": string, "prompt": string, "act": string | null, "character_slots": string[], "target_seconds": number | null }]
}`;

  try {
    const raw = await callAI(extractPrompt, recentHistory.filter(m => m.role !== 'system'));
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
    }
  }

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

async function submitToVivijure(brief, quality) {
  if (!CFG.vivijureUrl || !CFG.cfAccessClientId || !CFG.cfAccessClientSecret) {
    return { ok: false, error: 'VIVIJURE_API_URL or Access credentials not configured' };
  }

  const accessHeaders = { 'CF-Access-Client-Id': CFG.cfAccessClientId, 'CF-Access-Client-Secret': CFG.cfAccessClientSecret };
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

  const storyboard = {
    title:            brief.title ?? 'Untitled',
    full_prompt:      brief.full_prompt  ?? undefined,
    style_prefix:     brief.style_prefix ? brief.style_prefix.slice(0, 256) : undefined,
    style_category:   brief.style_category ?? 'None',
    duration_seconds: brief.duration_seconds ?? undefined,
    clip_seconds:     brief.clip_seconds ?? undefined,
    use_characters:   [...new Set(brief.scenes.flatMap(s => s.character_slots))],
    scenes:           brief.scenes.map(s => ({
      id: s.id, prompt: s.prompt, act: s.act ?? undefined,
      character_slots: s.character_slots, target_seconds: s.target_seconds ?? undefined,
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

  // Staged module-host pipeline (keyframe -> clips -> finish -> assemble). Send just the bundle
  // (the studio derives `project` from bundle_key) plus the scenes; the quality tier rides
  // keyframe_config. finish-rife is held off (interpolate / face_restore disabled) until
  // vivijure-backend#76 lands -- disabled, it no-ops synchronously, so films still complete via
  // keyframe -> clips -> assemble. Flip it on once #76 is fixed.
  const filmRes = await fetch(`${CFG.vivijureUrl}/api/render/film`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...accessHeaders },
    body: JSON.stringify({
      bundle_key: bundleKey,
      scenes: brief.scenes.map(s => ({
        shot_id: s.id,
        prompt:  s.prompt,
        seconds: s.target_seconds ?? brief.clip_seconds ?? 5,
      })),
      keyframe_config: { quality_tier: quality },
      finish_config:   { 'finish-rife': { interpolate: false, face_restore: 'none' } },
    }),
  });
  if (!filmRes.ok) {
    const body = await filmRes.text().catch(() => '');
    return { ok: false, error: `film submit failed ${filmRes.status}: ${body}` };
  }
  const film = await filmRes.json();
  return { ok: true, jobId: film.film_id, status: film.phase };
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

// In-memory pending render map (populated from D1 on startup; survives bot restarts via D1).
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
    .setDescription('Submit the storyboard to Vivijure for rendering')
    .addStringOption(o => o.setName('quality').setDescription('Quality tier (default: draft)').setRequired(false)
      .addChoices({ name: 'draft', value: 'draft' }, { name: 'standard', value: 'standard' }, { name: 'final', value: 'final' })),
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
        const quality = interaction.options.getString('quality') ?? 'draft';
        const project = await getProject(channelId);

        if (project.brief.scenes.length === 0) {
          await interaction.reply("The storyboard doesn't have any scenes yet -- keep planning!");
          return;
        }
        await interaction.deferReply();

        const result = await submitToVivijure(project.brief, quality);
        if (result.ok) {
          pendingRenders.set(result.jobId, { channelId, quality });
          await d1Query(
            "INSERT OR IGNORE INTO render_jobs (job_id, channel_id, quality, submitted_at, status) VALUES (?, ?, ?, ?, 'pending')",
            [result.jobId, channelId, quality, new Date().toISOString()],
          ).catch(() => {});
          await interaction.editReply(`Render submitted! Job \`${result.jobId}\` -- I'll let you know when it's done.`);
        } else {
          await interaction.editReply(`Render failed: ${result.error}`);
        }
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

  if (rawText.startsWith('!render')) {
    const parts   = rawText.split(/\s+/);
    const quality = ['draft', 'standard', 'final'].includes(parts[1]) ? parts[1] : 'draft';
    const project = await getProject(channelId);

    if (project.brief.scenes.length === 0) {
      await message.reply("The storyboard doesn't have any scenes yet -- keep planning!").catch(() => {});
      return;
    }

    const withPortraits = project.brief.cast.filter(c => c.portraitUrl).length;
    await message.reply(
      `Submitting to Vivijure at **${quality}** quality` +
      (withPortraits ? ` with ${withPortraits} character portrait(s)` : ' (no portraits -- run !portrait to add character refs)') +
      '...'
    ).catch(() => {});

    let result;
    try {
      result = await submitToVivijure(project.brief, quality);
    } catch (e) {
      log(`[render] submitToVivijure threw: ${e.message}`);
      await message.reply(`Render submission errored: ${e.message}`).catch(() => {});
      return;
    }
    log(`[render] result: ${JSON.stringify(result).slice(0, 200)}`);
    if (result.ok) {
      pendingRenders.set(result.jobId, { channelId, quality });
      await d1Query(
        "INSERT OR IGNORE INTO render_jobs (job_id, channel_id, quality, submitted_at, status) VALUES (?, ?, ?, ?, 'pending')",
        [result.jobId, channelId, quality, new Date().toISOString()],
      ).catch(() => {});
      await message.reply(`Render submitted! Job \`${result.jobId}\` -- I'll let you know when it's done.`).catch(() => {});
    } else {
      const json = '```json\n' + JSON.stringify(project.brief, null, 2).slice(0, 1400) + '\n```';
      for (const chunk of splitMessage(`Render submission failed: ${result.error}\n\nStoryboard JSON:\n${json}`)) {
        await message.reply(chunk).catch(() => {});
      }
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
// Startup
// ---------------------------------------------------------------------------

await initD1();
client.login(CFG.token);
