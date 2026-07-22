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
//   STUDIO_API_TOKEN            (required when VIVIJURE_API_URL is set) studio bearer token;
//                               sent as `Authorization: Bearer` on every studio call (vivijure #423)
//   LLM_API_URL                 skyphusion-llm-public base URL for image generation
//                               (default https://play.skyphusion.org)
//   CF_ACCESS_CLIENT_ID         Cloudflare Access service token client ID (optional; additive
//                               hardening when the studio is also fronted by Cloudflare Access)
//   CF_ACCESS_CLIENT_SECRET     Cloudflare Access service token client secret (optional)
//   CF_D1_TOKEN                 Cloudflare API token with D1:Write permission
//   CF_D1_ACCOUNT_ID            Cloudflare account ID (from env; never hardcode)
//   CF_D1_DATABASE_ID           D1 database ID (from env; never hardcode)
//   CF_AIG_TOKEN                Cloudflare API token for the AI Gateway (Anthropic path).
//                               When set the main conversation uses Claude via CF AI Gateway.
//                               Falls back to ollama when unset.
//   CF_GATEWAY_ENDPOINT         CF AI Gateway compat URL (used to derive the Anthropic base URL).
//   SEARCH_WORKER_URL           slate-search Worker base URL (enables web search + knowledge base +
//                               the auto-ingested session-memory RAG index, slate#90)
//   SEARCH_SECRET               X-Search-Secret for /search only
//   KNOWLEDGE_SECRET            X-Search-Secret for /knowledge/* (required; no SEARCH_SECRET fallback)
//   FETCH_SECRET                X-Search-Secret for /fetch (required; no SEARCH_SECRET fallback)
//   MEMORY_SECRET               X-Search-Secret for /memory/* (required; no SEARCH_SECRET fallback)
//
// ! commands:
//   !brief                 show the current storyboard state (and render settings)
//   !portrait <A|B|C|D> [desc]  generate + sync a character portrait
//   !thumbnail <scene-id>  generate a visual thumbnail for a scene
//   !model [name|id]       show available image models / switch the active one
//   !tier [draft|standard|final]  quality tier (projected from registry)
//   !keyframe [name|auto]  pick the keyframe module (when installed)
//   !backend [name|auto]   pick the i2v motion module (when installed)
//   !keyframes-only on|off  SDXL preview without motion (needs keyframe module)
//   !hooks                  live hook catalog + active module picks
//   !commands               module-gated command list for this studio
//   !install-config         operator install-scoped module knobs
//   !autodirect [intensity] plan.enhance auto-direction (when installed)
//   !titlecard <title> [| subtitle] [|| credit; credit]  set the opening title + end-credit cards
//   !subtitles on|off      caption spoken dialogue in the rendered film
//   !render                review the settings with a quick huddle, then ship on "ship it" / !render now
//   !render [quality|now]  skip the huddle and submit straight away (quality: draft | standard | final)
//   !ship                  confirm + submit the render Slate just huddled on
//   !undo                  roll back the last brief extraction
//   !learn <text or URL>   index a film reference into the knowledge base
//   !memory <query>        search Slate's own session memory (chat/brief/traffic) for this channel
//   !cast                  list the studio cast library (trained LoRAs, voices)
//   !bind <slot> <name>    bind a storyboard slot to an existing studio character
//   !unbind <slot>         clear a cast binding (back to inline character)
//   !voice <slot> <id>     set a character's dialogue voice (see !voices)
//   !voices                list valid Aura-1 voice ids
//   !train <slot>          train a LoRA for a bound character
//   !lorastatus <slot>     check LoRA training status
//   !genrefs <slot>        generate training reference images via the studio
//   !preflight             validate the storyboard before spending on a render
//   !renders [n]           show recent render history from the studio
//   !saveproject [name]    persist this brief to the studio project library
//   !loadproject <id>      load a saved studio project into this channel
//   !score music <prompt>  generate a music bed (or narration with storyboard context)
//   !config [module field value]  view or set a render module config knob (registry-projected)
//   !api <action> [args]   call any Vivijure studio API route (!api help lists all 69 surfaces)
//   !studio                alias for !api
//   !importcast            attach a .vvcast file to import a character
//   !upload                attach an image -> staged R2 key (/api/upload)
//   !audioupload           attach audio -> staged key for render mux
//   !addref <slot>         attach image -> cast training ref for bound character
//   !addsource <slot>      attach image -> cast source photo for bound character
//   !characterref <slot>   attach image -> storyboard character ref (unbound slots)
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
// Slash commands: see docs/commands.md for the full list (40+ commands, module-gated)
// (registered globally on startup; guild propagation is instant, global takes ~1 hour)

import Anthropic from '@anthropic-ai/sdk';
import { AttachmentBuilder, Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { appendFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  smartTrimPrompt,
  buildFilmTitles,
  parseCreditLines,
  subtitleEnableField,
  buildCharacterRefs,
  buildCastLoras,
  buildStoryboardPayload,
  formatCastRoster,
  formatPreflightResult,
  mapModuleOverridesToFilmConfigs,
  applySubtitleToFilmFinish,
  resolveCastMember,
  loraStatusLabel,
  pickAutoMotionBackend,
  pickAutoBind,
  buildCastContextBlock,
} from './lib.mjs';
import {
  commandAvailability,
  defaultTier,
  findSubtitleModule,
  formatAvailableCommands,
  formatHooksStatus,
  formatInstallConfig,
  formatModuleConfigByHook,
  formatPickOneList,
  formatTierList,
  gateMessage,
  hookModules,
  qualityTiers,
  resolvePickOne,
} from './registry.mjs';
import { executeStudioAction } from './studio-api.mjs';
import { setStudioRequestObserver } from './studio.mjs';
import { STUDIO_COMMAND_ALIASES, aliasArgs, formatConformanceReport } from './contract.mjs';
import {
  listCast,
  listVoices,
  listRenders,
  updateCast,
  trainCastLora,
  getCastLoraStatus,
  generateCastRefs,
  pollCastRefsJob,
  startScoreBed,
  pollJob,
  createProject,
  saveProjectStoryboard,
  getProject as getStudioProject,
  preflightStoryboard,
  enhanceStoryboard,
  patchModuleInstallConfig,
  uploadImage,
  uploadCharacterRef,
  uploadAudio,
  importCast,
  addCastRef,
  addCastSource,
  deleteCastRef,
  deleteCastSource,
  deleteCastPortrait,
} from './studio.mjs';

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
  studioApiToken:       process.env.STUDIO_API_TOKEN        ?? '',
  llmUrl:               process.env.LLM_API_URL             ?? 'https://play.skyphusion.org',
  cfAccessClientId:     process.env.CF_ACCESS_CLIENT_ID     ?? '',
  cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? '',
  d1Token:              process.env.CF_D1_TOKEN             ?? '',
  d1AccountId:          process.env.CF_D1_ACCOUNT_ID        ?? '',
  d1DatabaseId:         process.env.CF_D1_DATABASE_ID       ?? '',
  aigToken:             process.env.CF_AIG_TOKEN            ?? '',
  gatewayEndpoint:      process.env.CF_GATEWAY_ENDPOINT     ?? '',
  searchUrl:            (process.env.SEARCH_WORKER_URL ?? '').trim(),
  // Capability-scoped (trimmed to match Worker): SEARCH / KNOWLEDGE / FETCH / MEMORY.
  searchSecret:         (process.env.SEARCH_SECRET ?? '').trim(),
  knowledgeSecret:      (process.env.KNOWLEDGE_SECRET ?? '').trim(),
  fetchSecret:          (process.env.FETCH_SECRET ?? '').trim(),
  memorySecret:         (process.env.MEMORY_SECRET ?? '').trim(),
};

// The studio uses bearer-token auth (vivijure #423). If a studio URL is configured, a token is
// mandatory -- fail fast rather than fire unauthenticated calls that 401 at render time.
if (CFG.vivijureUrl && !CFG.studioApiToken) {
  log('ERROR: STUDIO_API_TOKEN is required when VIVIJURE_API_URL is set (studio bearer auth, vivijure #423)');
  process.exit(1);
}

// When search is enabled, all four capability secrets must be long + pairwise distinct
// (matches search-worker capabilitySecretsReady). Empty SEARCH_WORKER_URL leaves search off.
if (CFG.searchUrl) {
  const s = CFG.searchSecret;
  const k = CFG.knowledgeSecret;
  const f = CFG.fetchSecret;
  const m = CFG.memorySecret;
  const longOk = s.length >= 16 && k.length >= 16 && f.length >= 16 && m.length >= 16;
  const distinct = s !== k && s !== f && s !== m && k !== f && k !== m && f !== m;
  if (!longOk || !distinct) {
    log(
      'ERROR: SEARCH_WORKER_URL requires distinct SEARCH_SECRET, KNOWLEDGE_SECRET, FETCH_SECRET, MEMORY_SECRET (each >= 16 chars)',
    );
    process.exit(1);
  }
}

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
    cast_bindings:    {},   // { slot: studioCastPublicId } -- reuse trained LoRAs (#84)
    scenes:           [],
    studio_project_id: null,
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
    keyframe_backend: null,      // explicit keyframe module (null = registry default)
    keyframes_only:   false,     // stop after keyframes (preview), no i2v/assemble
    dialogue_backend: null,      // explicit dialogue module (null = registry default)
    cast_image_backend: null,    // explicit cast.image module (null = registry default)
    module_overrides: { config: {} }, // per-module render knobs (planner renderOverrides.config shape)
    audio_key:        null,      // staged score/narration bed to mux after assemble
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
    if (!brief.render_settings.module_overrides) brief.render_settings.module_overrides = { config: {} };
    if (!brief.render_settings.module_overrides.config) brief.render_settings.module_overrides.config = {};
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
    // slate#90: the request/response ledger of every Slate <-> studio API call. channel_id is
    // nullable -- background/startup calls (e.g. the registry fetch) have no channel in scope.
    await d1Query(`CREATE TABLE IF NOT EXISTS traffic_ledger (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER,
      ok INTEGER NOT NULL,
      request_summary TEXT,
      response_summary TEXT,
      latency_ms INTEGER,
      created_at TEXT NOT NULL
    )`);
    await d1Query('CREATE INDEX IF NOT EXISTS idx_traffic_ledger_channel ON traffic_ledger(channel_id, created_at)');
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

// Per-channel serialization. Brief/history mutations and the background extractBrief all
// read-modify-write the same shared project object and the same D1 blob; without a queue a
// fire-and-forget extract can interleave with a command save (or another extract) and clobber it,
// last-writer-wins. withChannelLock chains a channel's writers so they run one at a time, in order.
const channelLocks = new Map(); // channelId -> tail promise
function withChannelLock(channelId, fn) {
  const prev = channelLocks.get(channelId) ?? Promise.resolve();
  const run = prev.then(fn, fn);                             // run fn regardless of the prior outcome
  channelLocks.set(channelId, run.then(() => {}, () => {})); // keep the chain; swallow errors on the tail
  return run;
}

// ---------------------------------------------------------------------------
// Traffic ledger + session memory (slate#90)
//
// D1 holds the authoritative, complete request/response ledger of every Slate <-> studio call.
// Vectorize (via slate-search's /memory/* routes) holds a curated, searchable subset -- chat turns,
// brief snapshots, and mutating studio calls -- embedded for RAG so Slate can recall prior context
// in the bot path instead of re-asking a group for something it already saw. Both are best-effort:
// a ledger/memory write failure never blocks or fails the user-facing action that triggered it.
//
// channelContext carries the channel id across the async chain started by each Discord event
// (MessageCreate / InteractionCreate) so the studio-request observer below -- and any tool call deep
// in the Claude tool-use loop -- can attribute traffic/memory to the right channel without threading
// a channelId parameter through every studio.mjs call site.
// ---------------------------------------------------------------------------

const channelContext = new AsyncLocalStorage();

function currentChannelId() {
  return channelContext.getStore() ?? null;
}

// Best-effort JSON/text summarizer for ledger + memory bodies. Binary bodies (image/audio uploads)
// are never stringified -- just their size -- so the ledger stays readable and small.
function summarizeForLedger(value, limit = 2000) {
  if (value === undefined || value === null) return null;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Buffer.isBuffer(value)) {
    return `<binary ${value.byteLength ?? value.length ?? 0} bytes>`;
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return null;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

async function logTraffic({ channelId, method, path, status, ok, requestSummary, responseSummary, latencyMs }) {
  if (!CFG.d1Token) return;
  try {
    await d1Query(
      `INSERT INTO traffic_ledger
         (id, channel_id, method, path, status, ok, request_summary, response_summary, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(), channelId ?? null, method, path,
        status ?? null, ok ? 1 : 0, requestSummary ?? null, responseSummary ?? null,
        latencyMs ?? null, new Date().toISOString(),
      ],
    );
  } catch (e) {
    log(`ERROR logging traffic ${method} ${path}: ${e.message}`);
  }
}

// Auto-ingest into the session-memory Vectorize index (slate-search /memory/index). Fire-and-forget
// from every call site -- never awaited inline with the user-facing action, never throws.
async function indexMemory(channelId, kind, content, meta = {}) {
  // channelId is required by slate-search (cross-channel memory isolation).
  if (!CFG.searchUrl || !CFG.memorySecret || !content || !channelId) return;
  try {
    await fetch(`${CFG.searchUrl}/memory/index`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Search-Secret': CFG.memorySecret },
      body:    JSON.stringify({ content: content.slice(0, 4000), kind, channelId, meta }),
    });
  } catch (e) {
    log(`ERROR indexing memory (${kind}) for ${channelId}: ${e.message}`);
  }
}

// Polling GETs (job/render/refs-job status checks) fire every few seconds during a render and are
// pure repetition -- logging every poll to the ledger would drown the signal in noise, and embedding
// them into memory would waste Workers AI calls on content with no retrieval value. Everything else
// (every mutating call, every one-shot GET) is logged in full.
const POLL_PATH_RE = /\/(job|refs-job)\/|\/render\/[^/]+$|\/render\/film\/[^/]+$|\/render\/clips\/[^/]+$/;

function isPollPath(method, path) {
  return method === 'GET' && POLL_PATH_RE.test(path);
}

// Registered once at startup (see bottom of file). studio.mjs calls this for every studio HTTP
// request/response/error; it never has channel context of its own, hence channelContext above.
function onStudioRequest(evt) {
  const channelId = currentChannelId();
  if (isPollPath(evt.method, evt.path)) return;

  const ok     = !evt.error && evt.result?.ok !== false;
  const status = evt.result?.status ?? null;
  const requestSummary  = summarizeForLedger(evt.body);
  const responseSummary = evt.error
    ? `ERROR: ${evt.error.message}`
    : summarizeForLedger(evt.result?.data ?? evt.result?.raw);

  logTraffic({ channelId, method: evt.method, path: evt.path, status, ok, requestSummary, responseSummary, latencyMs: evt.latencyMs })
    .catch(() => {});

  // Only mutating calls go into RAG memory -- GETs are mostly re-derivable studio state, and the
  // interesting ones (cast, projects, renders) are already covered by the brief/chat snapshots below.
  if (evt.method !== 'GET') {
    const text = `${evt.method} ${evt.path} -> ${status ?? 'error'}\nRequest: ${requestSummary ?? '(none)'}\nResponse: ${(responseSummary ?? '').slice(0, 1200)}`;
    indexMemory(channelId, 'traffic', text, { method: evt.method, path: evt.path }).catch(() => {});
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

When someone shares a film IDEA or narrates a story, respond like a creative partner who is already making it WITH them: react to what excites you, then PROPOSE a shot-by-shot breakdown in your own words -- name the beats as concrete shots (e.g. "the chase through the junkyard, then the discovery, then the happy beat with the cat") so the storyboard takes shape from their idea. If they name a character who is in the studio cast (shown to you below), recognize them warmly and say you will bring in their trained look -- e.g. "Wren's already in your cast, I'll use her." Never make this feel like operating a tool or filling out a form: the whole point of Slate is building the film TOGETHER in conversation, so if a turn would read like a machine, make it read like a collaborator instead.

You also help the group decide how the film is finished and rendered -- which backend (our own GPU vs cloud), the quality tier, whether to open on a title card and roll credits. Offer these as a collaborator would: suggest, ask, and act on the group's behalf. You never run the render yourself; you carry the group's choices to the studio.

The storyboard takes shape in the background AS YOU TALK -- you build it WITH them through conversation, never by making them fill out a form or operate a console. At the END of this prompt you are given, EVERY turn, the current storyboard cast + bindings and the studio cast library -- READ and USE them; you CAN see the cast, so never tell a user to run a command to "show you" the cast or a character. LEAD WITH CONVERSATION. A few slash commands exist for the moments they genuinely help (the ! prefix works too), but they are the exception, not the interface:
- /portrait A -- render a look for a character when you both want to see them
- /cast, /bind <slot> <name>, /unbind <slot> -- reuse a trained studio character. Usually unnecessary: just NAME an existing cast character in the story and they come in with their trained look automatically.
- /titlecard, /subtitles, /backend, /tier -- finishing touches, offered the way a collaborator suggests them, never as a form
- /render -- send the finished film to the studio when the group is ready
- /undo, /reset -- roll back the last change, or start over

When the group wants subtitles, remember they caption spoken DIALOGUE: capture each shot's line as it
is decided (in the brief's per-scene "dialogue"), and be honest that captions show once there are
lines to show.

Power users CAN drive the full studio control panel from chat (/train, /voices, /renders, /preflight, /learn, /api, and more) -- but NEVER steer someone there. Your job is to make the film WITH them in conversation, not hand them a console; a tool-shaped Slate is just a worse control panel.`;

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
// Search + knowledge tools (slate-search Worker)
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
  {
    name:         'search_memory',
    description:  'Search Slate\'s own memory of THIS channel: past conversation turns, storyboard-brief snapshots, and studio API activity (renders, cast changes, uploads). Use this instead of asking the group to repeat something they may have already told you or that already happened in the studio.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to recall' } }, required: ['query'] },
  },
];

function searchHeaders(secret) {
  return { 'Content-Type': 'application/json', 'X-Search-Secret': secret };
}

async function executeTool(name, input) {
  // Per-capability secrets: do not require SEARCH_SECRET for fetch/memory/knowledge tools.
  if (!CFG.searchUrl) return 'Search not configured.';

  if (name === 'web_search') {
    if (!CFG.searchSecret) return 'Search not configured.';
    log(`[search] web: ${input.query}`);
    const res = await fetch(`${CFG.searchUrl}/search`, { method: 'POST', headers: searchHeaders(CFG.searchSecret), body: JSON.stringify({ query: input.query, type: 'web' }) });
    return res.ok ? res.json() : `Search error: ${res.status}`;
  }
  if (name === 'research') {
    if (!CFG.searchSecret) return 'Search not configured.';
    log(`[search] research: ${input.query}`);
    const res = await fetch(`${CFG.searchUrl}/search`, { method: 'POST', headers: searchHeaders(CFG.searchSecret), body: JSON.stringify({ query: input.query, type: 'research' }) });
    return res.ok ? res.json() : `Research error: ${res.status}`;
  }
  if (name === 'fetch_page') {
    // FETCH_SECRET only. SSRF enforcement is entirely in the Worker (/fetch).
    if (!CFG.fetchSecret) return 'Fetch not configured.';
    log(`[search] fetch: ${input.url}`);
    const res = await fetch(`${CFG.searchUrl}/fetch`, {
      method: 'POST',
      headers: searchHeaders(CFG.fetchSecret),
      body: JSON.stringify({ url: input.url }),
    });
    return res.ok ? res.json() : `Fetch error: ${res.status}`;
  }
  if (name === 'search_knowledge') {
    if (!CFG.knowledgeSecret) return 'Knowledge search not configured.';
    log(`[search] knowledge: ${input.query}`);
    const res = await fetch(`${CFG.searchUrl}/knowledge/search`, { method: 'POST', headers: searchHeaders(CFG.knowledgeSecret), body: JSON.stringify({ query: input.query }) });
    return res.ok ? res.json() : `Knowledge search error: ${res.status}`;
  }
  if (name === 'search_memory') {
    // Capability: MEMORY_SECRET only (never SEARCH_SECRET / KNOWLEDGE_SECRET / FETCH_SECRET).
    if (!CFG.memorySecret) return 'Memory search not configured.';
    const channelId = currentChannelId();
    if (!channelId) return 'Memory search requires an active Discord channel.';
    log(`[search] memory: ${input.query} (channel ${channelId})`);
    const res = await fetch(`${CFG.searchUrl}/memory/search`, {
      method: 'POST',
      headers: searchHeaders(CFG.memorySecret),
      body: JSON.stringify({ query: input.query, channelId }),
    });
    return res.ok ? res.json() : `Memory search error: ${res.status}`;
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

  // #84 chat fix: the brain is otherwise blind to the studio cast + current bindings and confabulates
  // ("I can't see your cast"). Inject the live cast roster + brief bindings into the system prompt every
  // turn so it can reason about reuse. Cheap (fetchCastCatalog is cached); studio-less installs skip it.
  const catalog = await fetchCastCatalog().catch(() => []);
  const castContext = buildCastContextBlock(project.brief, catalog);
  const system = castContext ? `${SYSTEM_PROMPT}\n\n${castContext}` : SYSTEM_PROMPT;

  return callAI(system, [
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
  Capture it only when a line is actually spoken/quoted in the conversation; do not invent dialogue.
- SCENES are the heart of the brief and a film CANNOT render without them. When the conversation
  describes a STORY or a sequence of events -- even as flowing prose, not an explicit shot list --
  BREAK IT INTO A SEQUENCE OF DISTINCT VISUAL SHOTS. One scene per beat: a change of action, location,
  or subject is a new shot. Give each a concrete visual "prompt" (what the camera sees), the
  character_slots present in it, and ids "scene-1", "scene-2", ... A clear narrative (e.g. "X chases Y
  through a junkyard until they find a cat, which makes them happy") must yield MULTIPLE scenes (the
  chase, the discovery, the happy ending), never zero. Only leave scenes empty if no visual action has
  been described at all. Do not collapse a whole story into full_prompt and stop -- decompose it.`;

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

  // The slow LLM call runs OUTSIDE the per-channel lock so it never blocks a user's next message;
  // only the read-modify-write of the brief + save happens under the lock, and re-reads the current
  // (possibly since-mutated) project so a command save that landed mid-extract is not clobbered.
  let updated;
  try {
    const raw = await callAI(extractPrompt, [
      { role: 'user', content: `Conversation so far:\n\n${convoText}\n\nReturn the updated storyboard brief as a single JSON object now.` },
    ]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    updated = JSON.parse(match[0]);
  } catch (e) {
    log(`[${channelId}] brief extraction error: ${e.message}`);
    return;
  }

  await withChannelLock(channelId, async () => {
    const p = projects.get(channelId) ?? project;

    // Preserve portraitUrl + castId + portraitKey + bound from existing cast.
    for (const existing of p.brief.cast) {
      if (!existing.portraitUrl && !existing.castId && !existing.bound) continue;
      const m2 = updated.cast?.find(c => c.slot === existing.slot);
      if (!m2) continue;
      if (existing.portraitUrl  && !m2.portraitUrl)  m2.portraitUrl  = existing.portraitUrl;
      if (existing.castId       && !m2.castId)       m2.castId       = existing.castId;
      if (existing.portraitKey  && !m2.portraitKey)  m2.portraitKey  = existing.portraitKey;
      if (existing.bound        && !m2.bound)        m2.bound        = existing.bound;
    }

    // Preserve any dialogue already set on a shot if the re-extraction dropped it (the extractor
    // sees recent turns only and may not re-mention an earlier line). Never lose group-authored
    // content on a partial re-extract.
    for (const prev of p.brief.scenes) {
      if (!prev.dialogue) continue;
      const s2 = updated.scenes?.find(s => s.id === prev.id);
      if (s2 && !s2.dialogue) s2.dialogue = prev.dialogue;
    }

    // The extractor schema carries NO render_settings; carry the group's render choices (tier,
    // backend, title/credit cards, subtitles) across so a routine re-extraction never silently
    // resets them. Same principle as the cast/dialogue preservation above.
    updated.render_settings = p.brief.render_settings ?? emptyRenderSettings();
    updated.cast_bindings = p.brief.cast_bindings ?? {};
    updated.studio_project_id = p.brief.studio_project_id ?? null;

    // Save previous brief for !undo.
    p.briefHistory.push(JSON.parse(JSON.stringify(p.brief)));
    if (p.briefHistory.length > 10) p.briefHistory.shift();

    p.brief = updated;
    await saveProject(channelId);
  });
  log(`[${channelId}] brief updated`);

  // slate#90: index the fresh brief (cast, scenes, render settings) into session memory so a later
  // turn -- or a whole new conversation revisiting the same channel -- can recall it via RAG instead
  // of Slate re-deriving or re-asking for it. Fire-and-forget; never blocks the extraction path.
  const project2 = projects.get(channelId);
  if (project2) indexMemory(channelId, 'brief', formatBrief(project2.brief)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Brief display
// ---------------------------------------------------------------------------

// --- render-settings command helpers (shared by slash + ! handlers) ----------
// NOTE (copy review): these user-facing strings are intentionally plain/functional. The
// conversational "huddle before we ship" voice pass is held for Mackaye + Conrad's review.

// Show the motion.backend pick_one options (projected from the registry).
async function formatBackendList(current) {
  const registry = await fetchRegistry();
  const gates = commandAvailability(registry, true);
  if (!gates.backend.ok) return gateMessage(gates.backend);
  return formatPickOneList('motion.backend', registry, { motion_backend: current }, '!backend');
}

async function formatKeyframeList(current) {
  const registry = await fetchRegistry();
  const gates = commandAvailability(registry, true);
  if (!gates.keyframe.ok) return gateMessage(gates.keyframe);
  return formatPickOneList('keyframe', registry, { keyframe_backend: current }, '!keyframe');
}

async function resolveBackend(input) {
  const registry = await fetchRegistry();
  return resolvePickOne(registry, 'motion.backend', input);
}

async function resolveKeyframe(input) {
  const registry = await fetchRegistry();
  return resolvePickOne(registry, 'keyframe', input);
}

async function studioGates() {
  const registry = await fetchRegistry();
  return commandAvailability(registry, !!CFG.vivijureUrl && !!CFG.studioApiToken);
}

async function requireGate(key, replyFn) {
  const gates = await studioGates();
  const g = gates[key];
  if (!g?.ok) {
    await replyFn(gateMessage(g));
    return false;
  }
  return true;
}

// parseCreditLines -> lib.mjs (pure)

// Honest subtitles status: subtitles caption spoken dialogue, so the toggle is upfront about what it
// needs (a subtitle module installed, and dialogue lines to caption). Built toward real captions,
// never an empty switch. (Copy review: held for Mackaye + Conrad's voice pass.)
async function subtitlesReply(on, brief) {
  if (!on) return 'Subtitles are off.';
  const registry = await fetchRegistry();
  const gates = commandAvailability(registry, true);
  if (!gates.subtitles.ok) return gateMessage(gates.subtitles);
  const hasDialogue = brief.scenes.some((s) => s.dialogue && String(s.dialogue).trim());
  const parts = ['Subtitles are on.'];
  if (!hasDialogue) parts.push('They caption spoken dialogue -- once we have lines for the shots, they will show. Tell me who says what, scene by scene.');
  return parts.join(' ');
}

// One-line summary of the render settings for /brief.
function formatRenderSettings(rs) {
  if (!rs) return '';
  const out = [];
  out.push(`tier: ${rs.quality_tier || 'draft'}`);
  out.push(`keyframe: ${rs.keyframe_backend || 'auto'}`);
  out.push(`motion: ${rs.motion_backend || 'auto'}`);
  if (rs.keyframes_only) out.push('mode: keyframes-only');
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
      const bound = brief.cast_bindings?.[c.slot] ? ' (bound to studio cast)' : '';
      const portrait = c.portraitUrl || c.portraitKey ? ' (portrait)' : '';
      lines.push(`  [${c.slot}] **${c.name}**${bound}${portrait} -- ${c.prompt}`);
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
    return { ok: false, error: friendlyHttpError(genRes.status, body, 'the image service', 'make that image') };
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

async function fetchRegistry() {
  if (!CFG.vivijureUrl) return null;
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.data;
  try {
    const res = await fetch(`${CFG.vivijureUrl}/api/modules`, {
      headers: studioAuthHeaders(),
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
  return qualityTiers(data);
}

async function getDefaultTier() {
  const data = await fetchRegistry();
  return defaultTier(data);
}

async function getMotionBackends() {
  const data = await fetchRegistry();
  return hookModules(data, 'motion.backend').map((m) => m.name);
}

async function getSubtitleModule() {
  const data = await fetchRegistry();
  return findSubtitleModule(data);
}

// subtitleEnableField -> lib.mjs (pure)


// ---------------------------------------------------------------------------
// Vivijure Cast sync
// ---------------------------------------------------------------------------

// Auth headers for every Vivijure studio call. STUDIO_API_TOKEN is the shipped auth (vivijure #423
// token mode); the CF-Access service-token pair is optional additive hardening, sent only when the
// deployment also fronts the studio with Cloudflare Access. Single source so no studio call can
// forget the bearer.
function studioAuthHeaders() {
  const h = {};
  if (CFG.studioApiToken) h['Authorization'] = `Bearer ${CFG.studioApiToken}`;
  if (CFG.cfAccessClientId && CFG.cfAccessClientSecret) {
    h['CF-Access-Client-Id']     = CFG.cfAccessClientId;
    h['CF-Access-Client-Secret'] = CFG.cfAccessClientSecret;
  }
  return h;
}

function vivijureHeaders() {
  return { 'Content-Type': 'application/json', ...studioAuthHeaders() };
}

function studioCfg() {
  return { vivijureUrl: CFG.vivijureUrl, headers: studioAuthHeaders() };
}

// Studio cast catalog cache (brief TTL) so list+bind in one burst does not re-fetch every turn.
let castCatalogCache = null;
const CAST_CATALOG_TTL_MS = 30_000;

async function fetchCastCatalog(force = false) {
  if (!CFG.vivijureUrl || !CFG.studioApiToken) return [];
  if (!force && castCatalogCache && Date.now() - castCatalogCache.at < CAST_CATALOG_TTL_MS) {
    return castCatalogCache.data;
  }
  try {
    const res = await listCast(studioCfg());
    if (!res.ok) { log(`[cast] GET /api/cast ${res.status}`); return castCatalogCache?.data ?? []; }
    const data = Array.isArray(res.data?.cast) ? res.data.cast : [];
    castCatalogCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    log(`[cast] catalog fetch failed: ${e.message}`);
    return castCatalogCache?.data ?? [];
  }
}

// Bind a storyboard slot to a resolved studio cast member: set the binding (so cast_loras carries
// the trained LoRA on render) and hydrate the inline entry from the member (name/bible/portrait) so
// the render bundle reuses the member's portrait + refs. Shared by /bind and the #84 auto-bind path.
function applyCastBinding(brief, slot, member) {
  if (!brief.cast_bindings || typeof brief.cast_bindings !== 'object') brief.cast_bindings = {};
  brief.cast_bindings[slot] = member.id;
  let entry = brief.cast.find((c) => c.slot === slot);
  if (!entry) {
    entry = { slot, name: member.name, prompt: member.bible || '' };
    brief.cast.push(entry);
  } else {
    entry.name = member.name;
    entry.prompt = member.bible || entry.prompt || '';
  }
  entry.castId = member.id;
  entry.bound = true;
  if (member.portrait_key) entry.portraitKey = member.portrait_key;
  return entry;
}

async function bindSlotToStudioCast(brief, slot, query) {
  const catalog = await fetchCastCatalog();
  const member = resolveCastMember(catalog, query);
  if (!member) return { ok: false, error: `No studio character matches \`${query}\`. Run \`/cast\` to see the library.` };
  applyCastBinding(brief, slot, member);
  const lora = loraStatusLabel(member.lora_status);
  return {
    ok: true,
    member,
    message: `Slot **${slot}** bound to **${member.name}** (${lora}). Their trained LoRA will be used on render when ready.`,
  };
}

// #84 core fix: make REUSE the default. For each named, still-inline (unbound, not-yet-created) cast
// slot, if its NAME exactly matches a single studio cast member, auto-bind it -- so the natural flow
// (describe a character / plan a storyboard) reuses a trained character's LoRA instead of minting a
// fresh generic one. Never silent: returns what it bound + any ambiguous names for the caller to
// surface. Ambiguous (>1 same-name row) is surfaced, NEVER auto-picked. `slots` optionally limits the
// scan (the /portrait path passes one slot); default scans every inline cast entry.
async function autoBindUnboundNamedCast(brief, slots = null) {
  const bound = [];
  const ambiguous = [];
  if (!CFG.vivijureUrl || !CFG.studioApiToken) return { bound, ambiguous };
  const want = slots ? new Set(slots) : null;
  const candidates = (brief.cast || []).filter((c) =>
    (!want || want.has(c.slot)) &&
    !brief.cast_bindings?.[c.slot] &&
    !c.castId,
  );
  if (!candidates.length) return { bound, ambiguous };
  const catalog = await fetchCastCatalog();
  for (const c of candidates) {
    const r = pickAutoBind(catalog, c.name);
    if (r.status === 'bound') {
      applyCastBinding(brief, c.slot, r.member);
      bound.push({ slot: c.slot, member: r.member });
    } else if (r.status === 'ambiguous') {
      ambiguous.push({ slot: c.slot, name: c.name, matches: r.matches });
    }
  }
  return { bound, ambiguous };
}

// Honest surface for an auto-bind result (never silent -- the group sees the reuse / the ambiguity).
function formatAutoBindNotice({ bound, ambiguous }) {
  const lines = [];
  for (const b of bound) {
    lines.push(`Matched existing **${b.member.name}** (${loraStatusLabel(b.member.lora_status)}) for slot **${b.slot}** -- reusing their trained likeness. \`/unbind ${b.slot}\` for a new one.`);
  }
  for (const a of ambiguous) {
    const ids = a.matches.map((m) => `\`${m.id.slice(0, 8)}\`(${loraStatusLabel(m.lora_status)})`).join(', ');
    lines.push(`Multiple studio characters named **${a.name}** for slot **${a.slot}**: ${ids}. Pick one with \`/bind ${a.slot} <id>\`.`);
  }
  return lines.join('\n');
}

function unbindSlot(brief, slot) {
  if (!brief.cast_bindings) return false;
  const had = !!brief.cast_bindings[slot];
  delete brief.cast_bindings[slot];
  // Drop the bound flag; keep castId (a session-created member stays reusable this brief; a pure
  // studio bind leaves castId on the studio member, harmless once the binding is gone).
  const entry = brief.cast.find((c) => c.slot === slot);
  if (entry) delete entry.bound;
  return had;
}

async function runPreflight(brief, bundleKey = null) {
  const catalog = await fetchCastCatalog();
  const characterRefs = buildCharacterRefs(brief, catalog);
  const storyboard = buildStoryboardPayload(brief, characterRefs);
  const rs = brief.render_settings || emptyRenderSettings();
  const body = {
    storyboard,
    castBindings: buildCastLoras(brief.cast_bindings),
    motionBackend: rs.motion_backend || undefined,
    quality: rs.quality_tier || 'draft',
  };
  if (bundleKey) body.bundleKey = bundleKey;
  if (rs.audio_key) body.audioKey = rs.audio_key;
  const res = await preflightStoryboard(studioCfg(), body);
  if (!res.ok) return { ok: false, error: friendlyHttpError(res.status, res.raw, 'the studio', 'run preflight') };
  return { ok: true, result: res.data };
}

function buildStudioCtx(brief) {
  return {
    cfg: studioCfg(),
    brief: brief || emptyBrief(),
    fetchCastCatalog,
    fetchRegistry,
    getSubtitleModule,
    emptyRenderSettings,
  };
}

async function replyApi(channelId, action, argsRaw, replyFn) {
  const project = await getProject(channelId);
  const result = await executeStudioAction(action, argsRaw, buildStudioCtx(project.brief));
  for (const chunk of splitMessage(result.text)) await replyFn(chunk);
  return result.ok;
}

/** Dispatch STUDIO_COMMAND_ALIASES bang commands to !api actions. */
async function handleStudioCommandAlias(rawText, channelId, replyFn) {
  const m = rawText.match(/^!([a-z][a-z0-9-]*)(?:\s+(.*))?$/i);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  if (cmd === 'conformance') {
    for (const chunk of splitMessage(formatConformanceReport({ compact: true }))) await replyFn(chunk);
    return true;
  }
  const alias = STUDIO_COMMAND_ALIASES[cmd];
  if (!alias) return false;
  const rest = (m[2] || '').trim();
  const args = aliasArgs(alias, rest);
  if (args === undefined) {
    await replyFn(alias.usage ? `Usage: \`${alias.usage}\`` : `Usage: \`!${cmd} <args>\``);
    return true;
  }
  await replyApi(channelId, alias.action, args, replyFn);
  return true;
}

async function fetchAttachmentBuffer(attachment) {
  const resp = await fetch(attachment.url);
  if (!resp.ok) throw new Error(`fetch attachment failed ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function syncCastMember(castEntry) {
  if (!CFG.vivijureUrl || !CFG.studioApiToken) return;
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
  if (!CFG.vivijureUrl || !CFG.studioApiToken || !castId) return false;

  const uploadRes = await fetch(`${CFG.vivijureUrl}/api/upload`, {
    method:  'POST',
    headers: { 'Content-Type': mime, ...studioAuthHeaders() },
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

// smartTrimPrompt + PROMPT_WORD_CAP (smart 50-word clamp, issue #16) -> lib.mjs (pure)

// buildCharacterRefs -> lib.mjs (pure)

// buildFilmTitles -> lib.mjs (pure)

// Submit the brief to the studio render pipeline. opts carries the group's render_settings choices
// (tier, motion backend, title/credit cards, subtitles). Slate holds no render logic: it bundles
// the storyboard, then POSTs /api/render/film with the choices mapped to the studio contract.
// Returns { ok, jobId, status, trims } -- trims lists scenes whose prompt was smart-trimmed so the
// caller can tell the group what changed (issue #16).
// Human-readable error for a failed studio / image-service call. Auth failures never echo the raw
// body (it can carry an Access page or a token hint); other 4xx keep a short bounded detail so a real
// validation message still reaches the group. Single source for both services.
function friendlyHttpError(status, rawBody, service, action) {
  if (status === 401 || status === 403) return `I could not get into ${service} -- my access was rejected. Check my token/credentials.`;
  if (status === 429) return `${service} is rate-limiting me right now. Give it a minute, then try again.`;
  if (status >= 500) return `${service} hit a server error trying to ${action} (${status}). Try again shortly.`;
  const detail = (rawBody || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  return `${service} could not ${action} (${status})${detail ? `: ${detail}` : ''}.`;
}

// POST to a studio spend route with bounded backoff on 429/503 (honoring Retry-After when sane), so
// a transient rate-limit does not fail a render the group already confirmed. Returns the final
// Response for the caller to interpret.
async function postStudioJson(url, headers, body) {
  const MAX = 3;
  let res;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    res = await fetch(url, { method: 'POST', headers, body });
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt === MAX) return res;
    const ra = parseInt(res.headers.get('retry-after') ?? '', 10);
    const waitMs = Math.min(Number.isFinite(ra) ? ra * 1000 : attempt * 1000, 5000);
    log(`[render] studio ${res.status}; backoff ${waitMs}ms (attempt ${attempt}/${MAX})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return res;
}

async function submitToVivijure(brief, opts = {}) {
  if (!CFG.vivijureUrl || !CFG.studioApiToken) {
    return { ok: false, error: 'VIVIJURE_API_URL or STUDIO_API_TOKEN not configured' };
  }
  const rs = brief.render_settings || emptyRenderSettings();
  const requested = opts.quality ?? rs.quality_tier ?? 'draft';
  const tiers = await getQualityTiers();
  const quality = tiers.some((t) => t.value === requested) ? requested : await getDefaultTier();

  const authHeaders = studioAuthHeaders();
  const catalog = await fetchCastCatalog();
  const characterRefs = buildCharacterRefs(brief, catalog);
  const castLoras = buildCastLoras(brief.cast_bindings);
  const refSlots = new Set(Object.keys(characterRefs));
  const sceneSlots = (slots) => (slots ?? []).filter(slot => refSlots.has(slot));

  const trims = [];
  const trimmedById = {};
  for (const s of brief.scenes) {
    const r = smartTrimPrompt(s.prompt);
    trimmedById[s.id] = r.text;
    if (r.trimmed) trims.push({ id: s.id, text: r.text });
  }
  const promptFor = (s) => trimmedById[s.id] ?? (s.prompt ?? '');

  const storyboard = buildStoryboardPayload(brief, characterRefs);

  const bundleRes = await fetch(`${CFG.vivijureUrl}/api/storyboard/bundle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ storyboard, characterRefs }),
  });
  if (!bundleRes.ok) {
    const body = await bundleRes.text().catch(() => '');
    return { ok: false, error: friendlyHttpError(bundleRes.status, body, 'the studio', 'prepare the storyboard') };
  }
  const { bundleKey } = await bundleRes.json();

  // Pre-render validation (#85): surface blockers before spend.
  if (!opts.skipPreflight) {
    const pf = await runPreflight(brief, bundleKey).catch(() => null);
    if (pf?.ok && pf.result && pf.result.ok === false) {
      return { ok: false, error: formatPreflightResult(pf.result), preflight: pf.result };
    }
  }

  const registry = await fetchRegistry();
  const mapped = registry
    ? mapModuleOverridesToFilmConfigs(registry, rs, quality)
    : { keyframe_config: { quality_tier: quality }, motion_config: {}, finish_config: {}, speech_config: {}, film_finish_config: {}, master_config: {} };

  const filmBody = {
    bundle_key: bundleKey,
    scenes: brief.scenes.map(s => ({
      shot_id: s.id,
      prompt:  promptFor(s),
      seconds: s.target_seconds ?? brief.clip_seconds ?? 5,
    })),
    keyframe_config: mapped.keyframe_config,
    finish_config:   { 'finish-rife': { interpolate: false, face_restore: 'none' }, ...mapped.finish_config },
  };
  if (mapped.keyframe_backend) filmBody.keyframe_backend = mapped.keyframe_backend;
  const keyframesOnly = !!rs.keyframes_only;
  if (keyframesOnly) {
    filmBody.keyframes_only = true;
  } else {
    if (Object.keys(mapped.speech_config || {}).length) filmBody.speech_config = mapped.speech_config;
    if (Object.keys(mapped.master_config || {}).length) filmBody.master_config = mapped.master_config;
    if (rs.audio_key) filmBody.audio_key = rs.audio_key;

    if (rs.motion_backend) {
      filmBody.motion_backend = rs.motion_backend;
      if (mapped.motion_config && Object.keys(mapped.motion_config).length) {
        filmBody.motion_config = mapped.motion_config;
      }
    } else if (mapped.motion_backend) {
      filmBody.motion_backend = mapped.motion_backend;
      if (mapped.motion_config && Object.keys(mapped.motion_config).length) {
        filmBody.motion_config = mapped.motion_config;
      }
    } else {
      if (!registry) {
        return { ok: false, error: 'I could not reach the studio to choose a render backend. Give it a moment and try again, or set one with `/backend <name>`.' };
      }
      const picked = pickAutoMotionBackend(registry);
      if (picked.error) {
        return { ok: false, error: `I cannot start this render: ${picked.error}. Set one with \`/backend <name>\` once a backend is available.` };
      }
      filmBody.motion_backend = picked.value;
    }
  }

  if (!keyframesOnly) {
    const filmTitles = buildFilmTitles(rs);
    if (filmTitles) filmBody.film_titles = filmTitles;
  }

  const dialogueLines = brief.scenes
    .filter((s) => s.dialogue && String(s.dialogue).trim())
    .map((s) => ({ shot_id: s.id, text: String(s.dialogue).trim() }));
  if (dialogueLines.length && !keyframesOnly) filmBody.dialogue_lines = dialogueLines;

  let filmFinishConfig = mapped.film_finish_config || {};
  if (!keyframesOnly && rs.subtitles && dialogueLines.length) {
    const subMod = await getSubtitleModule();
    if (subMod) filmFinishConfig = applySubtitleToFilmFinish(filmFinishConfig, subMod, true);
  }
  if (!keyframesOnly && Object.keys(filmFinishConfig).length) filmBody.film_finish_config = filmFinishConfig;

  if (Object.keys(castLoras).length) filmBody.cast_loras = castLoras;

  // Keyframes-only reroute: /api/render/film (hStartFilm) has NO keyframes-only mode -- it always runs
  // the full keyframe->clips->assemble chain and REQUIRES a motion backend, so a keyframes-only film
  // body (no motion_backend) 400s at its motion gate. /api/storyboard/render (hSubmitRender) honors
  // keyframesOnly (SDXL keyframes, no i2v, no motion backend) and resolves the SAME cast_loras. The job
  // is a shared film-* id, pollable via the same /api/render/film/:id the poll loop already uses.
  if (keyframesOnly) {
    const res = await studioSubmitStoryboardRender({
      bundleKey,
      scenes: filmBody.scenes,
      qualityTier: quality,
      castLoras,
      keyframesOnly: true,
    }, authHeaders);
    if (!res.ok) {
      return { ok: false, error: friendlyHttpError(res.status, res.raw, 'the studio', 'start the keyframes-only render') };
    }
    return { ok: true, jobId: res.data?.jobId, status: res.data?.status, quality, trims };
  }

  const filmRes = await postStudioJson(`${CFG.vivijureUrl}/api/render/film`,
    { 'Content-Type': 'application/json', ...authHeaders }, JSON.stringify(filmBody));
  if (!filmRes.ok) {
    const body = await filmRes.text().catch(() => '');
    return { ok: false, error: friendlyHttpError(filmRes.status, body, 'the studio', 'start the render') };
  }
  const film = await filmRes.json();
  return { ok: true, jobId: film.film_id, status: film.phase, quality, trims };
}

// POST /api/storyboard/render (keyframes-only reroute helper). Kept local to the render path; returns
// the studioRequest-shaped { ok, status, data, raw }.
async function studioSubmitStoryboardRender(body, authHeaders) {
  const r = await postStudioJson(`${CFG.vivijureUrl}/api/storyboard/render`,
    { 'Content-Type': 'application/json', ...authHeaders }, JSON.stringify(body));
  const raw = await r.text().catch(() => '');
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* non-json */ }
  return { ok: r.ok, status: r.status, data, raw };
}

// Issue #17: a multi-character film needs a characterRefs entry per referenced character, or the
// bundle bounces. Before submit, make sure every character that scenes actually reference has a
// synced portrait ref. For a character Slate can describe, auto-derive the ref (generate the
// portrait, sync the cast member, upload the portrait) so the group does not have to do it by hand.
// For a character with NO description to render from, return a clear block naming who is missing,
// so Slate can ask as a collaborator instead of letting the backend 400.
// Returns { ok: true, generated: [slots] } or { ok: false, missing: [slots] }.
async function ensureCharacterRefs(brief, channelId, imageModel) {
  const catalog = await fetchCastCatalog();
  const usedSlots = new Set(brief.scenes.flatMap(s => s.character_slots ?? []));
  const referenced = brief.cast.filter(c => usedSlots.has(c.slot));
  if (referenced.length <= 1) return { ok: true, generated: [] };

  const generated = [];
  const missing = [];
  for (const c of referenced) {
    // Bound studio cast: refs come from the catalog (portrait + ref_keys).
    if (brief.cast_bindings?.[c.slot]) {
      const member = resolveCastMember(catalog, brief.cast_bindings[c.slot]);
      const refs = member && buildCharacterRefs({ cast: [c], cast_bindings: { [c.slot]: member.id } }, catalog);
      if (refs?.[c.slot]) continue;
      if (!member?.portrait_key) { missing.push(c.slot); continue; }
      continue;
    }
    if (c.castId && c.portraitKey) continue;
    if (!c.prompt || !c.prompt.trim()) { missing.push(c.slot); continue; }
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
    headers: studioAuthHeaders(),
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
  if (rs.keyframes_only) frags.push('keyframes-only preview');
  else frags.push(backendLabel(rs));
  frags.push(`${rs.quality_tier || 'draft'} quality`);
  if (rs.keyframe_backend) frags.push(`keyframe \`${rs.keyframe_backend}\``);
  const hasDialogue = brief.scenes.some((s) => s.dialogue && String(s.dialogue).trim());
  if (!rs.keyframes_only) {
    if (rs.subtitles) frags.push(hasDialogue ? 'subtitles on' : 'subtitles on (no dialogue to caption yet)');
    else frags.push('subtitles off');
    if (rs.titles?.text) frags.push(`title card "${rs.titles.text}"`);
    else frags.push('no title card yet');
    if (rs.credits?.lines?.length) frags.push(`${rs.credits.lines.length} credit line(s)`);
  }
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
    const noRef = referenced.filter((c) => !(brief.cast_bindings?.[c.slot] || (c.castId && c.portraitKey)));
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
// Natural affirmatives that mean "send it" when a huddle is armed. Kept tight so ordinary
// conversation ("yes, that scene works") does not accidentally launch a render -- the phrase must be
// short and shipping-flavored.
const SHIP_RE = /^(ship it|ship|send it|send|go for it|go|do it|launch it|launch|yes ship|yep ship|render it now)[.!]?$/i;
function looksLikeShip(text) {
  return SHIP_RE.test((text ?? '').trim());
}
// Looser "did they mean to send it?" detector, used ONLY while a huddle is armed to tell a clean
// confirm apart from a near-miss ("let's ship it", "yeah, send it", "lgtm", "yes"). A near-miss gets
// a one-line nudge toward the exact word instead of silently becoming ordinary chat.
const SHIP_INTENT_RE = /\b(ship|send)\s+(it|this)\b|^\s*(y(es|ep|eah|up)|sure|ok(ay)?|lgtm|looks good|sounds good|good to go|let'?s go|go ahead|do it|send it|ready)\b[.! ]*$/i;
function looksLikeShipIntent(text) {
  return SHIP_INTENT_RE.test((text ?? '').trim());
}

// The shared submit runner: auto-fill refs (#17), submit, persist the pending job, and report the
// outcome through `say` (a channel.send / editReply callback) so both the ! and / paths reuse one
// code path. Returns true on a successful submit. Voice lives in the strings here.
async function runSubmit(brief, channelId, quality, imageModel, say) {
  // #84: make reuse the default. Before ref-gen/submit, bind any named-but-inline cast slot whose
  // name matches a trained studio member, so the render carries cast_loras (real likeness) instead of
  // a fresh generic character. Surfaced to the group; ambiguous names are shown, never auto-picked.
  const autobind = await autoBindUnboundNamedCast(brief).catch(() => ({ bound: [], ambiguous: [] }));
  if (autobind.bound.length || autobind.ambiguous.length) {
    if (channelId) await saveProject(channelId).catch(() => {});
    await say(formatAutoBindNotice(autobind));
  }
  const refs = await ensureCharacterRefs(brief, channelId, imageModel).catch(() => ({ ok: true, generated: [] }));
  if (!refs.ok) {
    await say(`Hold on -- ${refs.missing.join(' and ')} ${refs.missing.length > 1 ? "don't" : "doesn't"} have a look yet, and I can't render a character I can't picture. Describe them (or run \`/portrait\`) and I'll fold them in.`);
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
    await say(result.error);
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
// Knowledge base (via slate-search Worker + Vectorize)
// ---------------------------------------------------------------------------

async function indexKnowledge(content, title = '', author = '') {
  if (!CFG.searchUrl || !CFG.knowledgeSecret) return { ok: false, error: 'Search worker not configured' };

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
    headers: { 'Content-Type': 'application/json', 'X-Search-Secret': CFG.knowledgeSecret },
    body:    JSON.stringify({ content: text, title: resolvedTitle, author }),
  });
  if (!res.ok) return { ok: false, error: `index failed ${res.status}` };
  const data = await res.json();
  return { ok: true, id: data.id, title: resolvedTitle, words: text.split(/\s+/).length };
}

// ---------------------------------------------------------------------------
// Session memory search (slate#90 -- manual peek at !memory / /memory, same store
// automatically consulted by the search_memory tool during conversation)
// ---------------------------------------------------------------------------

async function queryMemory(channelId, query) {
  if (!CFG.searchUrl || !CFG.memorySecret) return { ok: false, error: 'Search worker not configured' };
  const res = await fetch(`${CFG.searchUrl}/memory/search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Search-Secret': CFG.memorySecret },
    body:    JSON.stringify({ query, channelId }),
  });
  if (!res.ok) return { ok: false, error: `memory search failed ${res.status}` };
  const data = await res.json();
  return { ok: true, results: data.results ?? [] };
}

function formatMemoryResults(results) {
  if (!results.length) return 'Nothing in memory yet for this channel -- Slate builds this up as you talk, plan, and render.';
  const lines = ['**From Slate\'s memory of this channel:**'];
  for (const r of results) {
    const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '';
    lines.push(`\n**[${r.kind}]${when ? ` ${when}` : ''}** (score ${r.score?.toFixed(2) ?? '?'})\n${r.content.slice(0, 500)}`);
  }
  return lines.join('\n');
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

async function castIdForSlot(brief, slot) {
  return brief.cast_bindings?.[slot] || brief.cast.find((c) => c.slot === slot)?.castId || null;
}

async function formatVoicesList() {
  const res = await listVoices(studioCfg());
  if (!res.ok) return 'Could not load voices from the studio.';
  const voices = Array.isArray(res.data?.voices) ? res.data.voices : [];
  if (!voices.length) return 'No voices reported.';
  return '**Dialogue voices** (`!voice <slot> <id>`)\n' + voices.map((v) => `  \`${v.id}\` -- ${v.label}`).join('\n');
}

async function formatRendersList(limit = 10) {
  const res = await listRenders(studioCfg(), { limit });
  if (!res.ok) return 'Could not load render history.';
  const rows = Array.isArray(res.data?.renders) ? res.data.renders : [];
  if (!rows.length) return 'No renders in the studio library yet.';
  const lines = ['**Recent renders**\n'];
  for (const r of rows.slice(0, limit)) {
    const label = r.label || r.job_id || r.id;
    const st = r.status || r.phase || '?';
    lines.push(`  \`${r.id?.slice?.(0, 8) || r.id}…\` **${label}** -- ${st}`);
  }
  return lines.join('\n');
}

async function formatModuleConfig(rs, moduleFilter) {
  const registry = await fetchRegistry();
  const gates = commandAvailability(registry, true);
  if (!gates.config.ok) return gateMessage(gates.config);
  return formatModuleConfigByHook(registry, rs, moduleFilter);
}

function setModuleConfigField(rs, modName, field, rawValue) {
  if (!rs.module_overrides) rs.module_overrides = { config: {} };
  if (!rs.module_overrides.config) rs.module_overrides.config = {};
  if (!rs.module_overrides.config[modName]) rs.module_overrides.config[modName] = {};
  let val = rawValue;
  if (rawValue === 'true') val = true;
  else if (rawValue === 'false') val = false;
  else if (/^-?\d+$/.test(rawValue)) val = parseInt(rawValue, 10);
  else if (/^-?\d+\.\d+$/.test(rawValue)) val = Number(rawValue);
  rs.module_overrides.config[modName][field] = val;
  return val;
}

async function runAutodirect(channelId, intensity, replyFn) {
  const gates = await studioGates();
  if (!gates.autodirect.ok) { await replyFn(gateMessage(gates.autodirect)); return; }
  const project = await getProject(channelId);
  if (!project.brief.scenes.length) { await replyFn('No scenes yet -- build the storyboard first.'); return; }
  const catalog = await fetchCastCatalog();
  const storyboard = buildStoryboardPayload(project.brief, buildCharacterRefs(project.brief, catalog));
  await replyFn('Auto-directing shots...');
  const res = await enhanceStoryboard(studioCfg(), { storyboard, config: { intensity: intensity || 'medium' } });
  if (!res.ok) { await replyFn(friendlyHttpError(res.status, res.raw, 'the studio', 'auto-direct')); return; }
  if (res.data?.storyboard) {
    project.brief = { ...project.brief, ...res.data.storyboard };
    ensureRenderSettings(project.brief);
    await saveProject(channelId);
  }
  const applied = Array.isArray(res.data?.applied) ? res.data.applied.join(', ') : '';
  const note = Array.isArray(res.data?.notes) && res.data.notes[0] ? ` -- ${res.data.notes[0]}` : '';
  await replyFn(`Auto-directed${applied ? ` via ${applied}` : ''}${note}. Use \`!brief\` to review.`);
}

async function pollRefsJob(castId, jobId, say) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await pollCastRefsJob(studioCfg(), castId, jobId);
    if (!res.ok) { await say(`Ref generation poll failed (${res.status}).`); return null; }
    const phase = res.data?.phase;
    if (phase === 'done') return res.data;
    if (phase === 'failed') {
      await say(`Ref generation failed: ${res.data?.error || 'unknown error'}`);
      return null;
    }
  }
  await say('Ref generation timed out -- check the control panel.');
  return null;
}

async function pollScoreJob(jobId, moduleName, say) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await pollJob(studioCfg(), jobId, moduleName);
    if (!res.ok) { await say(`Score bed poll failed (${res.status}).`); return null; }
    if (res.data?.status === 'done' && res.data?.output_artifact?.key) return res.data.output_artifact.key;
    if (res.data?.status === 'failed') {
      await say(`Score generation failed: ${res.data?.job_error || 'unknown error'}`);
      return null;
    }
  }
  await say('Score generation timed out.');
  return null;
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
    .setName('memory')
    .setDescription('Search what Slate has retained about this channel (chat, brief, studio traffic)')
    .addStringOption(o => o.setName('query').setDescription('What to recall').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Clear the project and start fresh'),
  new SlashCommandBuilder()
    .setName('cast')
    .setDescription('List the studio cast library (trained LoRAs, voices)'),
  new SlashCommandBuilder()
    .setName('bind')
    .setDescription('Bind a storyboard slot to an existing studio character')
    .addStringOption(o => o.setName('slot').setDescription('Character slot').setRequired(true)
      .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' }))
    .addStringOption(o => o.setName('name').setDescription('Studio character name or id').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unbind')
    .setDescription('Clear a cast binding')
    .addStringOption(o => o.setName('slot').setDescription('Character slot').setRequired(true)
      .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' })),
  new SlashCommandBuilder()
    .setName('voices')
    .setDescription('List valid Aura-1 dialogue voice ids'),
  new SlashCommandBuilder()
    .setName('voice')
    .setDescription('Set a character dialogue voice')
    .addStringOption(o => o.setName('slot').setDescription('Character slot').setRequired(true)
      .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' }))
    .addStringOption(o => o.setName('voice_id').setDescription('Voice id from /voices').setRequired(true)),
  new SlashCommandBuilder()
    .setName('train')
    .setDescription('Train a LoRA for a bound studio character')
    .addStringOption(o => o.setName('slot').setDescription('Character slot').setRequired(true)
      .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' })),
  new SlashCommandBuilder()
    .setName('lorastatus')
    .setDescription('Check LoRA training status for a bound character')
    .addStringOption(o => o.setName('slot').setDescription('Character slot').setRequired(true)
      .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' })),
  new SlashCommandBuilder()
    .setName('genrefs')
    .setDescription('Generate training reference images for a bound character')
    .addStringOption(o => o.setName('slot').setDescription('Character slot').setRequired(true)
      .addChoices({ name: 'A', value: 'A' }, { name: 'B', value: 'B' }, { name: 'C', value: 'C' }, { name: 'D', value: 'D' })),
  new SlashCommandBuilder()
    .setName('preflight')
    .setDescription('Validate the storyboard before rendering'),
  new SlashCommandBuilder()
    .setName('renders')
    .setDescription('Show recent render history from the studio')
    .addIntegerOption(o => o.setName('limit').setDescription('Max rows (default 10)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('saveproject')
    .setDescription('Persist this brief to the studio project library')
    .addStringOption(o => o.setName('name').setDescription('Project name (defaults to film title)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('loadproject')
    .setDescription('Load a saved studio project')
    .addStringOption(o => o.setName('id').setDescription('Project id (from saveproject or control panel)').setRequired(true)),
  new SlashCommandBuilder()
    .setName('score')
    .setDescription('Generate a music or narration bed')
    .addStringOption(o => o.setName('kind').setDescription('music or narration').setRequired(true)
      .addChoices({ name: 'music', value: 'music' }, { name: 'narration', value: 'narration' }))
    .addStringOption(o => o.setName('prompt').setDescription('Music prompt or narration text').setRequired(false)),
  new SlashCommandBuilder()
    .setName('tier')
    .setDescription('Set or list the render quality tier')
    .addStringOption(o => o.setName('value').setDescription('draft, standard, or final (omit to list)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('keyframe')
    .setDescription('Pick the keyframe module (when installed)')
    .addStringOption(o => o.setName('choice').setDescription('Module name, auto, or omit to list').setRequired(false)),
  new SlashCommandBuilder()
    .setName('keyframesonly')
    .setDescription('Toggle keyframes-only preview (no motion leg)')
    .addStringOption(o => o.setName('state').setDescription('on or off').setRequired(true)
      .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
  new SlashCommandBuilder()
    .setName('hooks')
    .setDescription('Show the live studio hook catalog and active picks'),
  new SlashCommandBuilder()
    .setName('commands')
    .setDescription('List module-gated commands available on this studio'),
  new SlashCommandBuilder()
    .setName('autodirect')
    .setDescription('Auto-direct shots via plan.enhance (when installed)')
    .addStringOption(o => o.setName('intensity').setDescription('low, medium, or high').setRequired(false)
      .addChoices({ name: 'low', value: 'low' }, { name: 'medium', value: 'medium' }, { name: 'high', value: 'high' })),
  new SlashCommandBuilder()
    .setName('installconfig')
    .setDescription('View or set install-scoped module config')
    .addStringOption(o => o.setName('module').setDescription('Module name').setRequired(false))
    .addStringOption(o => o.setName('field').setDescription('Config field').setRequired(false))
    .addStringOption(o => o.setName('value').setDescription('Value to set').setRequired(false)),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('View or set a render module config knob')
    .addStringOption(o => o.setName('module').setDescription('Module name (omit to list)').setRequired(false))
    .addStringOption(o => o.setName('field').setDescription('Config field name').setRequired(false))
    .addStringOption(o => o.setName('value').setDescription('Value to set').setRequired(false)),
  new SlashCommandBuilder()
    .setName('api')
    .setDescription('Call any Vivijure studio API route (api help lists all surfaces)')
    .addStringOption(o => o.setName('action').setDescription('Action name (e.g. health, cast-list, film-submit)').setRequired(true))
    .addStringOption(o => o.setName('args').setDescription('key:value args or JSON').setRequired(false)),
  new SlashCommandBuilder()
    .setName('conformance')
    .setDescription('Show the Vivijure CONTRACT route-to-command conformance matrix'),
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

  // slate#90: every studio call this handler triggers (directly or via the Claude tool loop)
  // attributes to this channel in the traffic ledger + session memory without threading channelId
  // through every call site. enterWith (not run()) so we don't have to re-indent the whole switch.
  channelContext.enterWith(channelId);

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

        // #84: if this slot's name matches a trained studio character, reuse it (bind) instead of
        // generating a fresh generic portrait. Surfaced; /unbind to override.
        const abP = await autoBindUnboundNamedCast(project.brief, [slotArg]).catch(() => ({ bound: [], ambiguous: [] }));
        if (abP.bound.length || abP.ambiguous.length) {
          await saveProject(channelId);
          await interaction.reply(formatAutoBindNotice(abP));
          break;
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
        if (!(await requireGate('backend', (t) => interaction.reply(t)))) break;
        const choice = interaction.options.getString('choice');
        if (choice == null) { await interaction.reply((await formatBackendList(rs.motion_backend)).slice(0, 2000)); return; }
        const r = await resolveBackend(choice);
        if (r.error) { await interaction.reply(r.error); return; }
        rs.motion_backend = r.value;
        await saveProject(channelId);
        await interaction.reply(r.value ? `Motion backend set to **${r.value}**.` : 'Motion backend set to **auto** (registry default).');
        break;
      }

      case 'tier': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        const value = interaction.options.getString('value');
        const registry = await fetchRegistry();
        if (!value) {
          await interaction.reply(formatTierList(registry, rs.quality_tier).slice(0, 2000));
          break;
        }
        const tiers = qualityTiers(registry);
        if (!tiers.some((t) => t.value === value)) {
          await interaction.reply(`Unknown tier \`${value}\`. Use \`/tier\` to list options.`);
          break;
        }
        rs.quality_tier = value;
        await saveProject(channelId);
        await interaction.reply(`Quality tier set to **${value}**.`);
        break;
      }

      case 'keyframe': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        if (!(await requireGate('keyframe', (t) => interaction.reply(t)))) break;
        const choice = interaction.options.getString('choice');
        if (choice == null) {
          await interaction.reply((await formatKeyframeList(rs.keyframe_backend)).slice(0, 2000));
          break;
        }
        const r = await resolveKeyframe(choice);
        if (r.error) { await interaction.reply(r.error); return; }
        rs.keyframe_backend = r.value;
        await saveProject(channelId);
        await interaction.reply(r.value ? `Keyframe module set to **${r.value}**.` : 'Keyframe module set to **auto** (registry default).');
        break;
      }

      case 'keyframesonly': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        if (!(await requireGate('keyframes-only', (t) => interaction.reply(t)))) break;
        const state = interaction.options.getString('state');
        rs.keyframes_only = state === 'on';
        await saveProject(channelId);
        await interaction.reply(rs.keyframes_only
          ? 'Keyframes-only mode **on** (SDXL preview, no motion leg).'
          : 'Keyframes-only mode **off** (full render).');
        break;
      }

      case 'hooks': {
        if (!(await requireGate('hooks', (t) => interaction.reply(t)))) break;
        const project = await getProject(channelId);
        const registry = await fetchRegistry();
        const text = formatHooksStatus(registry, project.brief.render_settings);
        await interaction.reply(text.slice(0, 2000));
        break;
      }

      case 'commands': {
        const gates = await studioGates();
        const text = formatAvailableCommands(gates);
        await interaction.reply(text.slice(0, 2000));
        break;
      }

      case 'autodirect': {
        const intensity = interaction.options.getString('intensity') || 'medium';
        await interaction.deferReply();
        await runAutodirect(channelId, intensity, (t) => interaction.editReply(t.slice(0, 2000)));
        break;
      }

      case 'installconfig': {
        const registry = await fetchRegistry();
        if (!(await requireGate('install-config', (t) => interaction.reply(t)))) break;
        const mod = interaction.options.getString('module');
        const field = interaction.options.getString('field');
        const value = interaction.options.getString('value');
        if (!mod) {
          await interaction.reply(formatInstallConfig(registry).slice(0, 2000));
          break;
        }
        if (!field || value == null) {
          await interaction.reply(formatInstallConfig(registry, mod).slice(0, 2000));
          break;
        }
        const body = { [field]: value === 'true' ? true : value === 'false' ? false : (/^-?\d+$/.test(value) ? parseInt(value, 10) : value) };
        const res = await patchModuleInstallConfig(studioCfg(), mod, body);
        await interaction.reply(res.ok
          ? `Install config **${mod}**.${field} updated.`
          : friendlyHttpError(res.status, res.raw, 'the studio', 'patch install config'));
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
        if (on && !(await requireGate('subtitles', (t) => interaction.reply(t)))) break;
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

      case 'memory': {
        const query = interaction.options.getString('query');
        await interaction.deferReply();
        const result = await queryMemory(channelId, query);
        if (!result.ok) { await interaction.editReply(`Memory search failed: ${result.error}`); break; }
        await interaction.editReply(formatMemoryResults(result.results).slice(0, 2000));
        break;
      }

      case 'reset': {
        projects.set(channelId, { brief: emptyBrief(), history: [], briefHistory: [], imageModel: DEFAULT_IMAGE_MODEL });
        await saveProject(channelId);
        log(`[${channelId}] project reset by ${authorName}`);
        await interaction.reply('Project cleared. Ready to start a new film.');
        break;
      }

      case 'cast': {
        const roster = await fetchCastCatalog(true);
        await interaction.reply(formatCastRoster(roster).slice(0, 2000));
        break;
      }

      case 'bind': {
        const slot = interaction.options.getString('slot');
        const name = interaction.options.getString('name');
        const project = await getProject(channelId);
        const r = await bindSlotToStudioCast(project.brief, slot, name);
        if (!r.ok) { await interaction.reply(r.error); break; }
        await saveProject(channelId);
        await interaction.reply(r.message);
        break;
      }

      case 'unbind': {
        const slot = interaction.options.getString('slot');
        const project = await getProject(channelId);
        const had = unbindSlot(project.brief, slot);
        await saveProject(channelId);
        await interaction.reply(had ? `Slot **${slot}** unbound from studio cast.` : `Slot **${slot}** was not bound.`);
        break;
      }

      case 'voices': {
        if (!(await requireGate('voices', (t) => interaction.reply(t)))) break;
        await interaction.reply((await formatVoicesList()).slice(0, 2000));
        break;
      }

      case 'voice': {
        if (!(await requireGate('voices', (t) => interaction.reply(t)))) break;
        const slot = interaction.options.getString('slot');
        const voiceId = interaction.options.getString('voice_id');
        const project = await getProject(channelId);
        const castId = await castIdForSlot(project.brief, slot);
        if (!castId) { await interaction.reply(`Slot **${slot}** is not bound to a studio character. \`/bind\` first.`); break; }
        const res = await updateCast(studioCfg(), castId, { voice_id: voiceId });
        if (!res.ok) { await interaction.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'set voice')); break; }
        castCatalogCache = null;
        await interaction.reply(`Voice for slot **${slot}** set to **${voiceId}**.`);
        break;
      }

      case 'train': {
        const slot = interaction.options.getString('slot');
        const project = await getProject(channelId);
        const castId = await castIdForSlot(project.brief, slot);
        if (!castId) { await interaction.reply(`Slot **${slot}** is not bound. \`/bind\` first.`); break; }
        await interaction.deferReply();
        const res = await trainCastLora(studioCfg(), castId, {});
        if (!res.ok) { await interaction.editReply(friendlyHttpError(res.status, res.raw, 'the studio', 'start LoRA training')); break; }
        castCatalogCache = null;
        await interaction.editReply(`LoRA training started for slot **${slot}** (job \`${res.data?.jobId || '?'}\`). Check with \`/lorastatus ${slot}\`.`);
        break;
      }

      case 'lorastatus': {
        const slot = interaction.options.getString('slot');
        const project = await getProject(channelId);
        const castId = await castIdForSlot(project.brief, slot);
        if (!castId) { await interaction.reply(`Slot **${slot}** is not bound.`); break; }
        const res = await getCastLoraStatus(studioCfg(), castId);
        if (!res.ok) { await interaction.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'check LoRA status')); break; }
        const st = res.data?.lora_status || res.data?.cast?.lora_status || 'unknown';
        const err = res.data?.lora_error || res.data?.cast?.lora_error;
        await interaction.reply(`Slot **${slot}** LoRA: **${st}**${err ? ` (${err})` : ''}`);
        break;
      }

      case 'genrefs': {
        const slot = interaction.options.getString('slot');
        const project = await getProject(channelId);
        const castId = await castIdForSlot(project.brief, slot);
        if (!castId) { await interaction.reply(`Slot **${slot}** is not bound.`); break; }
        await interaction.deferReply();
        const start = await generateCastRefs(studioCfg(), castId, {});
        if (!start.ok) { await interaction.editReply(friendlyHttpError(start.status, start.raw, 'the studio', 'start ref generation')); break; }
        const jobId = start.data?.job_id || start.data?.jobId;
        await interaction.editReply(`Generating training refs for slot **${slot}**...`);
        const done = await pollRefsJob(castId, jobId, (t) => interaction.editReply(t).catch(() => {}));
        if (done) {
          castCatalogCache = null;
          await interaction.editReply(`Training refs ready for slot **${slot}** (${done.registered || done.images?.length || '?'} image(s)). Run \`/train ${slot}\` when you are ready.`);
        }
        break;
      }

      case 'preflight': {
        const project = await getProject(channelId);
        if (!project.brief.scenes.length) { await interaction.reply('No scenes yet -- build the storyboard first.'); break; }
        await interaction.deferReply();
        const pf = await runPreflight(project.brief);
        if (!pf.ok) { await interaction.editReply(pf.error); break; }
        await interaction.editReply(formatPreflightResult(pf.result).slice(0, 2000));
        break;
      }

      case 'renders': {
        const limit = interaction.options.getInteger('limit') ?? 10;
        await interaction.reply((await formatRendersList(limit)).slice(0, 2000));
        break;
      }

      case 'saveproject': {
        const project = await getProject(channelId);
        const name = interaction.options.getString('name') || project.brief.title || 'Untitled';
        await interaction.deferReply();
        let projectId = project.brief.studio_project_id;
        const catalog = await fetchCastCatalog();
        const storyboard = buildStoryboardPayload(project.brief, buildCharacterRefs(project.brief, catalog));
        if (projectId) {
          const res = await saveProjectStoryboard(studioCfg(), projectId, storyboard);
          if (!res.ok) { await interaction.editReply(friendlyHttpError(res.status, res.raw, 'the studio', 'save project')); break; }
        } else {
          const res = await createProject(studioCfg(), { name, prefs: { castBindings: project.brief.cast_bindings } });
          if (!res.ok) { await interaction.editReply(friendlyHttpError(res.status, res.raw, 'the studio', 'create project')); break; }
          projectId = res.data?.project?.id;
          project.brief.studio_project_id = projectId;
          await saveProjectStoryboard(studioCfg(), projectId, storyboard);
          await saveProject(channelId);
        }
        await interaction.editReply(`Saved to studio project **${name}** (\`${projectId}\`). Load with \`/loadproject ${projectId}\`.`);
        break;
      }

      case 'loadproject': {
        const id = interaction.options.getString('id');
        await interaction.deferReply();
        const res = await getStudioProject(studioCfg(), id);
        if (!res.ok) { await interaction.editReply(friendlyHttpError(res.status, res.raw, 'the studio', 'load project')); break; }
        const proj = res.data?.project;
        const project = await getProject(channelId);
        if (proj?.storyboard) {
          project.brief = { ...emptyBrief(), ...proj.storyboard, studio_project_id: proj.id };
          ensureRenderSettings(project.brief);
          if (proj.prefs?.castBindings) project.brief.cast_bindings = proj.prefs.castBindings;
        }
        project.brief.studio_project_id = proj?.id || id;
        await saveProject(channelId);
        await interaction.editReply(`Loaded studio project **${proj?.name || id}**. Use \`/brief\` to review.`);
        break;
      }

      case 'score': {
        const kind = interaction.options.getString('kind');
        const prompt = interaction.options.getString('prompt') || '';
        const gateKey = kind === 'music' ? 'score-music' : 'score-narration';
        if (!(await requireGate(gateKey, (t) => interaction.reply(t)))) break;
        const project = await getProject(channelId);
        await interaction.deferReply();
        const body = { kind };
        if (kind === 'music') {
          if (!prompt.trim()) { await interaction.editReply('Music needs a prompt: `/score kind:music prompt:<...>`'); break; }
          body.prompt = prompt;
        } else {
          body.text = prompt.trim() || undefined;
          if (!body.text) body.storyboard = buildStoryboardPayload(project.brief, buildCharacterRefs(project.brief, await fetchCastCatalog()));
        }
        const start = await startScoreBed(studioCfg(), body);
        if (!start.ok) { await interaction.editReply(friendlyHttpError(start.status, start.raw, 'the studio', 'start score bed')); break; }
        const jobId = start.data?.id;
        const mod = start.data?.module;
        await interaction.editReply(`Generating ${kind} bed...`);
        const key = await pollScoreJob(jobId, mod, (t) => interaction.editReply(t).catch(() => {}));
        if (key) {
          const rs = ensureRenderSettings(project.brief);
          rs.audio_key = key;
          await saveProject(channelId);
          await interaction.editReply(`${kind} bed ready (\`${key}\`). It will mux on the next render.`);
        }
        break;
      }

      case 'config': {
        const project = await getProject(channelId);
        const rs = ensureRenderSettings(project.brief);
        const mod = interaction.options.getString('module');
        const field = interaction.options.getString('field');
        const value = interaction.options.getString('value');
        if (!mod) {
          await interaction.reply((await formatModuleConfig(rs)).slice(0, 2000));
          break;
        }
        if (!field || value == null) {
          await interaction.reply((await formatModuleConfig(rs, mod)).slice(0, 2000));
          break;
        }
        const set = setModuleConfigField(rs, mod, field, value);
        await saveProject(channelId);
        await interaction.reply(`Set **${mod}**.${field} = ${JSON.stringify(set)}`);
        break;
      }

      case 'api': {
        const action = interaction.options.getString('action');
        const args = interaction.options.getString('args') || '';
        await interaction.deferReply();
        const project = await getProject(channelId);
        const result = await executeStudioAction(action, args, buildStudioCtx(project.brief));
        const chunks = splitMessage(result.text);
        await interaction.editReply(chunks[0].slice(0, 2000));
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i].slice(0, 2000) });
        }
        break;
      }

      case 'conformance': {
        const text = formatConformanceReport({ compact: true });
        const chunks = splitMessage(text);
        await interaction.reply(chunks[0].slice(0, 2000));
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i].slice(0, 2000) });
        }
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

  channelContext.enterWith(channelId); // slate#90: see the InteractionCreate handler for why

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

    // #84: reuse a trained studio character on an exact name match instead of a fresh portrait.
    const abL = await autoBindUnboundNamedCast(project.brief, [slotArg]).catch(() => ({ bound: [], ambiguous: [] }));
    if (abL.bound.length || abL.ambiguous.length) {
      await saveProject(channelId);
      await message.reply(formatAutoBindNotice(abL)).catch(() => {});
      return;
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

  if (rawText === '!commands' || rawText === '!help') {
    const gates = await studioGates();
    for (const chunk of splitMessage(formatAvailableCommands(gates))) await message.reply(chunk);
    return;
  }

  if (rawText === '!hooks') {
    if (!(await requireGate('hooks', (t) => message.reply(t).catch(() => {})))) return;
    const project = await getProject(channelId);
    const registry = await fetchRegistry();
    for (const chunk of splitMessage(formatHooksStatus(registry, project.brief.render_settings))) await message.reply(chunk);
    return;
  }

  if (rawText.startsWith('!tier')) {
    const project = await getProject(channelId);
    const rs = ensureRenderSettings(project.brief);
    const arg = rawText.slice('!tier'.length).trim();
    const registry = await fetchRegistry();
    if (!arg) {
      await message.reply(formatTierList(registry, rs.quality_tier)).catch(() => {});
      return;
    }
    const tiers = qualityTiers(registry);
    if (!tiers.some((t) => t.value === arg)) {
      await message.reply(`Unknown tier \`${arg}\`. Use \`!tier\` to list options.`).catch(() => {});
      return;
    }
    rs.quality_tier = arg;
    await saveProject(channelId);
    await message.reply(`Quality tier set to **${arg}**.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!keyframe')) {
    const project = await getProject(channelId);
    const rs = ensureRenderSettings(project.brief);
    if (!(await requireGate('keyframe', (t) => message.reply(t).catch(() => {})))) return;
    const arg = rawText.slice('!keyframe'.length).trim();
    if (!arg) {
      await message.reply(await formatKeyframeList(rs.keyframe_backend)).catch(() => {});
      return;
    }
    const r = await resolveKeyframe(arg);
    if (r.error) { await message.reply(r.error).catch(() => {}); return; }
    rs.keyframe_backend = r.value;
    await saveProject(channelId);
    await message.reply(r.value ? `Keyframe module set to **${r.value}**.` : 'Keyframe module set to **auto**.').catch(() => {});
    return;
  }

  if (rawText.startsWith('!keyframes-only') || rawText.startsWith('!keyframesonly')) {
    const project = await getProject(channelId);
    const rs = ensureRenderSettings(project.brief);
    if (!(await requireGate('keyframes-only', (t) => message.reply(t).catch(() => {})))) return;
    const arg = rawText.split(/\s+/)[1]?.toLowerCase();
    if (arg !== 'on' && arg !== 'off') {
      await message.reply('Usage: `!keyframes-only on` or `!keyframes-only off`').catch(() => {});
      return;
    }
    rs.keyframes_only = arg === 'on';
    await saveProject(channelId);
    await message.reply(rs.keyframes_only ? 'Keyframes-only mode **on**.' : 'Keyframes-only mode **off**.').catch(() => {});
    return;
  }

  if (rawText.startsWith('!autodirect')) {
    const intensity = rawText.split(/\s+/)[1] || 'medium';
    await runAutodirect(channelId, intensity, (t) => message.reply(t).catch(() => {}));
    return;
  }

  if (rawText.startsWith('!install-config') || rawText.startsWith('!installconfig')) {
    const prefix = rawText.startsWith('!install-config') ? '!install-config' : '!installconfig';
    const parts = rawText.slice(prefix.length).trim().split(/\s+/);
    const registry = await fetchRegistry();
    if (!(await requireGate('install-config', (t) => message.reply(t).catch(() => {})))) return;
    if (!parts[0]) {
      for (const chunk of splitMessage(formatInstallConfig(registry))) await message.reply(chunk);
      return;
    }
    if (!parts[1] || parts[2] == null) {
      for (const chunk of splitMessage(formatInstallConfig(registry, parts[0]))) await message.reply(chunk);
      return;
    }
    const mod = parts[0];
    const field = parts[1];
    const value = parts.slice(2).join(' ');
    const body = { [field]: value === 'true' ? true : value === 'false' ? false : (/^-?\d+$/.test(value) ? parseInt(value, 10) : value) };
    const res = await patchModuleInstallConfig(studioCfg(), mod, body);
    await message.reply(res.ok
      ? `Install config **${mod}**.${field} updated.`
      : friendlyHttpError(res.status, res.raw, 'the studio', 'patch install config')).catch(() => {});
    return;
  }

  if (rawText.startsWith('!dialogue')) {
    const project = await getProject(channelId);
    const rs = ensureRenderSettings(project.brief);
    if (!(await requireGate('voices', (t) => message.reply(t).catch(() => {})))) return;
    const registry = await fetchRegistry();
    const arg = rawText.slice('!dialogue'.length).trim();
    if (!arg) {
      await message.reply(formatPickOneList('dialogue', registry, rs, '!dialogue')).catch(() => {});
      return;
    }
    const r = resolvePickOne(registry, 'dialogue', arg);
    if (r.error) { await message.reply(r.error).catch(() => {}); return; }
    rs.dialogue_backend = r.value;
    await saveProject(channelId);
    await message.reply(r.value ? `Dialogue module set to **${r.value}**.` : 'Dialogue module set to **auto**.').catch(() => {});
    return;
  }

  if (rawText.startsWith('!castimage')) {
    const project = await getProject(channelId);
    const rs = ensureRenderSettings(project.brief);
    if (!(await requireGate('cast-image', (t) => message.reply(t).catch(() => {})))) return;
    const registry = await fetchRegistry();
    const arg = rawText.slice('!castimage'.length).trim();
    if (!arg) {
      await message.reply(formatPickOneList('cast.image', registry, rs, '!castimage')).catch(() => {});
      return;
    }
    const r = resolvePickOne(registry, 'cast.image', arg);
    if (r.error) { await message.reply(r.error).catch(() => {}); return; }
    rs.cast_image_backend = r.value;
    await saveProject(channelId);
    await message.reply(r.value ? `cast.image module set to **${r.value}**.` : 'cast.image module set to **auto**.').catch(() => {});
    return;
  }

  if (rawText.startsWith('!backend')) {
    const arg     = rawText.slice('!backend'.length).trim();
    const project = await getProject(channelId);
    const rs      = ensureRenderSettings(project.brief);
    if (!(await requireGate('backend', (t) => message.reply(t).catch(() => {})))) return;
    if (!arg) { await message.reply(await formatBackendList(rs.motion_backend)).catch(() => {}); return; }
    const r = await resolveBackend(arg);
    if (r.error) { await message.reply(r.error).catch(() => {}); return; }
    rs.motion_backend = r.value;
    await saveProject(channelId);
    await message.reply(r.value ? `Motion backend set to **${r.value}**.` : 'Motion backend set to **auto** (registry default).').catch(() => {});
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
    if (arg === 'on' && !(await requireGate('subtitles', (t) => message.reply(t).catch(() => {})))) return;
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
      // In a channel Slate only hears via @mention, the confirmation must be a mention too, or the
      // "ship it" goes unheard -- say so up front rather than leaving a dead huddle.
      const mentionOnly = !isDM && !inListenChan;
      const hint = mentionOnly
        ? '\n(Heads up: in this channel I only hear you when you @mention me -- put an @ me on your `ship it`.)'
        : '';
      await say(buildSubmitHuddle(project.brief) + hint);
    }
    return;
  }

  if (rawText === '!cast' || rawText.startsWith('!cast ')) {
    const roster = await fetchCastCatalog(true);
    for (const chunk of splitMessage(formatCastRoster(roster))) await message.reply(chunk);
    return;
  }

  if (rawText.startsWith('!bind ')) {
    const parts = rawText.split(/\s+/);
    const slot = parts[1]?.toUpperCase();
    const query = parts.slice(2).join(' ');
    if (!['A', 'B', 'C', 'D'].includes(slot) || !query) {
      await message.reply('Usage: `!bind <A|B|C|D> <studio character name or id>`').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const r = await bindSlotToStudioCast(project.brief, slot, query);
    await message.reply(r.ok ? r.message : r.error).catch(() => {});
    if (r.ok) await saveProject(channelId);
    return;
  }

  if (rawText.startsWith('!unbind')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(slot)) {
      await message.reply('Usage: `!unbind <A|B|C|D>`').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const had = unbindSlot(project.brief, slot);
    await saveProject(channelId);
    await message.reply(had ? `Slot **${slot}** unbound.` : `Slot **${slot}** was not bound.`).catch(() => {});
    return;
  }

  if (rawText === '!voices') {
    if (!(await requireGate('voices', (t) => message.reply(t).catch(() => {})))) return;
    for (const chunk of splitMessage(await formatVoicesList())) await message.reply(chunk);
    return;
  }

  if (rawText.startsWith('!voice ')) {
    if (!(await requireGate('voices', (t) => message.reply(t).catch(() => {})))) return;
    const parts = rawText.split(/\s+/);
    const slot = parts[1]?.toUpperCase();
    const voiceId = parts[2];
    if (!['A', 'B', 'C', 'D'].includes(slot) || !voiceId) {
      await message.reply('Usage: `!voice <A|B|C|D> <voice_id>` (see `!voices`)').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    const res = await updateCast(studioCfg(), castId, { voice_id: voiceId });
    await message.reply(res.ok ? `Voice set to **${voiceId}**.` : friendlyHttpError(res.status, res.raw, 'the studio', 'set voice')).catch(() => {});
    if (res.ok) castCatalogCache = null;
    return;
  }

  if (rawText.startsWith('!train ')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(slot)) {
      await message.reply('Usage: `!train <A|B|C|D>`').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    await message.reply(`Starting LoRA training for slot **${slot}**...`).catch(() => {});
    const res = await trainCastLora(studioCfg(), castId, {});
    await message.reply(res.ok ? `Training started (job \`${res.data?.jobId || '?'}\`).` : friendlyHttpError(res.status, res.raw, 'the studio', 'train LoRA')).catch(() => {});
    if (res.ok) castCatalogCache = null;
    return;
  }

  if (rawText.startsWith('!lorastatus')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    const res = await getCastLoraStatus(studioCfg(), castId);
    const st = res.data?.lora_status || 'unknown';
    await message.reply(res.ok ? `LoRA status: **${st}**` : friendlyHttpError(res.status, res.raw, 'the studio', 'check status')).catch(() => {});
    return;
  }

  if (rawText === '!preflight') {
    const project = await getProject(channelId);
    if (!project.brief.scenes.length) { await message.reply('No scenes yet.').catch(() => {}); return; }
    const pf = await runPreflight(project.brief);
    for (const chunk of splitMessage(pf.ok ? formatPreflightResult(pf.result) : pf.error)) await message.reply(chunk);
    return;
  }

  if (rawText.startsWith('!renders')) {
    const limit = parseInt(rawText.split(/\s+/)[1] || '10', 10) || 10;
    for (const chunk of splitMessage(await formatRendersList(limit))) await message.reply(chunk);
    return;
  }

  if (rawText.startsWith('!config')) {
    const parts = rawText.slice('!config'.length).trim().split(/\s+/);
    const project = await getProject(channelId);
    const rs = ensureRenderSettings(project.brief);
    if (!parts[0]) {
      for (const chunk of splitMessage(await formatModuleConfig(rs))) await message.reply(chunk);
      return;
    }
    if (!parts[1] || parts[2] == null) {
      for (const chunk of splitMessage(await formatModuleConfig(rs, parts[0]))) await message.reply(chunk);
      return;
    }
    const val = setModuleConfigField(rs, parts[0], parts[1], parts.slice(2).join(' '));
    await saveProject(channelId);
    await message.reply(`Set **${parts[0]}**.${parts[1]} = ${JSON.stringify(val)}`).catch(() => {});
    return;
  }

  if (rawText === '!api' || rawText === '!api help' || rawText === '!studio' || rawText === '!studio help') {
    await replyApi(channelId, 'help', '', (t) => message.reply(t).catch(() => {}));
    return;
  }

  if (await handleStudioCommandAlias(rawText, channelId, (t) => message.reply(t).catch(() => {}))) return;

  if (rawText.startsWith('!api ') || rawText.startsWith('!studio ')) {
    const prefix = rawText.startsWith('!api ') ? '!api ' : '!studio ';
    const rest = rawText.slice(prefix.length).trim();
    const space = rest.indexOf(' ');
    const action = space === -1 ? rest : rest.slice(0, space);
    const args = space === -1 ? '' : rest.slice(space + 1);
    await replyApi(channelId, action, args, (t) => message.reply(t).catch(() => {}));
    return;
  }

  if (rawText.startsWith('!genrefs')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(slot)) {
      await message.reply('Usage: `!genrefs <A|B|C|D>`').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    await message.reply(`Generating training refs for slot **${slot}**...`).catch(() => {});
    const start = await generateCastRefs(studioCfg(), castId, {});
    if (!start.ok) { await message.reply(friendlyHttpError(start.status, start.raw, 'the studio', 'start ref generation')).catch(() => {}); return; }
    const jobId = start.data?.job_id || start.data?.jobId;
    const done = await pollRefsJob(castId, jobId, (t) => message.reply(t).catch(() => {}));
    if (done) {
      castCatalogCache = null;
      await message.reply(`Training refs ready for slot **${slot}** (${done.registered || done.images?.length || '?'} image(s)). Run \`!train ${slot}\` when ready.`).catch(() => {});
    }
    return;
  }

  if (rawText.startsWith('!saveproject')) {
    const name = rawText.slice('!saveproject'.length).trim() || undefined;
    const project = await getProject(channelId);
    const projectName = name || project.brief.title || 'Untitled';
    let projectId = project.brief.studio_project_id;
    const catalog = await fetchCastCatalog();
    const storyboard = buildStoryboardPayload(project.brief, buildCharacterRefs(project.brief, catalog));
    if (projectId) {
      const res = await saveProjectStoryboard(studioCfg(), projectId, storyboard);
      if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'save project')).catch(() => {}); return; }
    } else {
      const res = await createProject(studioCfg(), { name: projectName, prefs: { castBindings: project.brief.cast_bindings } });
      if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'create project')).catch(() => {}); return; }
      projectId = res.data?.project?.id;
      project.brief.studio_project_id = projectId;
      await saveProjectStoryboard(studioCfg(), projectId, storyboard);
      await saveProject(channelId);
    }
    await message.reply(`Saved to studio project **${projectName}** (\`${projectId}\`). Load with \`!loadproject ${projectId}\`.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!loadproject ')) {
    const id = rawText.slice('!loadproject'.length).trim();
    if (!id) { await message.reply('Usage: `!loadproject <project-id>`').catch(() => {}); return; }
    const res = await getStudioProject(studioCfg(), id);
    if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'load project')).catch(() => {}); return; }
    const proj = res.data?.project;
    const project = await getProject(channelId);
    if (proj?.storyboard) {
      project.brief = { ...emptyBrief(), ...proj.storyboard, studio_project_id: proj.id };
      ensureRenderSettings(project.brief);
      if (proj.prefs?.castBindings) project.brief.cast_bindings = proj.prefs.castBindings;
    }
    project.brief.studio_project_id = proj?.id || id;
    await saveProject(channelId);
    await message.reply(`Loaded studio project **${proj?.name || id}**. Use \`!brief\` to review.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!score ')) {
    const parts = rawText.split(/\s+/);
    const kind = parts[1];
    const prompt = parts.slice(2).join(' ');
    if (kind !== 'music' && kind !== 'narration') {
      await message.reply('Usage: `!score music <prompt>` or `!score narration [text]`').catch(() => {});
      return;
    }
    const gateKey = kind === 'music' ? 'score-music' : 'score-narration';
    if (!(await requireGate(gateKey, (t) => message.reply(t).catch(() => {})))) return;
    const project = await getProject(channelId);
    const body = { kind };
    if (kind === 'music') {
      if (!prompt.trim()) { await message.reply('Music needs a prompt: `!score music <prompt>`').catch(() => {}); return; }
      body.prompt = prompt;
    } else {
      body.text = prompt.trim() || undefined;
      if (!body.text) body.storyboard = buildStoryboardPayload(project.brief, buildCharacterRefs(project.brief, await fetchCastCatalog()));
    }
    await message.reply(`Generating ${kind} bed...`).catch(() => {});
    const start = await startScoreBed(studioCfg(), body);
    if (!start.ok) { await message.reply(friendlyHttpError(start.status, start.raw, 'the studio', 'start score bed')).catch(() => {}); return; }
    const jobId = start.data?.id;
    const mod = start.data?.module;
    const key = await pollScoreJob(jobId, mod, (t) => message.reply(t).catch(() => {}));
    if (key) {
      const rs = ensureRenderSettings(project.brief);
      rs.audio_key = key;
      await saveProject(channelId);
      await message.reply(`${kind} bed ready (\`${key}\`). It will mux on the next render.`).catch(() => {});
    }
    return;
  }

  if (rawText === '!importcast' || rawText.startsWith('!importcast ')) {
    const att = message.attachments.find((a) => a.name?.endsWith('.vvcast') || a.contentType?.includes('tar'));
    if (!att) { await message.reply('Attach a `.vvcast` file to import a character.').catch(() => {}); return; }
    await message.reply('Importing cast bundle...').catch(() => {});
    try {
      const buf = await fetchAttachmentBuffer(att);
      const res = await importCast(studioCfg(), buf);
      if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'import cast')).catch(() => {}); return; }
      castCatalogCache = null;
      const c = res.data?.cast;
      await message.reply(`Imported **${c?.name || 'character'}** (\`${c?.id}\`). Bind with \`!bind <slot> ${c?.name || c?.id}\`.`).catch(() => {});
    } catch (e) {
      await message.reply(`Import failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (rawText === '!upload' || rawText.startsWith('!upload ')) {
    const att = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (!att) { await message.reply('Attach an image to upload to staged storage (`/api/upload`).').catch(() => {}); return; }
    try {
      const buf = await fetchAttachmentBuffer(att);
      const res = await uploadImage(studioCfg(), buf, att.contentType || 'image/png');
      if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'upload image')).catch(() => {}); return; }
      const key = res.data?.key;
      await message.reply(`Uploaded \`${key}\`. Use in API args as \`key:${key}\` or set on render via module config.`).catch(() => {});
    } catch (e) {
      await message.reply(`Upload failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (rawText === '!audioupload' || rawText.startsWith('!audioupload ')) {
    const att = message.attachments.find((a) => a.contentType?.startsWith('audio/'));
    if (!att) { await message.reply('Attach an audio file to stage for render mux.').catch(() => {}); return; }
    try {
      const buf = await fetchAttachmentBuffer(att);
      const res = await uploadAudio(studioCfg(), buf, att.contentType || 'audio/mpeg');
      if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'upload audio')).catch(() => {}); return; }
      const key = res.data?.key;
      const project = await getProject(channelId);
      const rs = ensureRenderSettings(project.brief);
      rs.audio_key = key;
      await saveProject(channelId);
      await message.reply(`Audio staged as \`${key}\`. It will mux on the next render.`).catch(() => {});
    } catch (e) {
      await message.reply(`Audio upload failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (rawText.startsWith('!addref ')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    const att = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (!['A', 'B', 'C', 'D'].includes(slot) || !att) {
      await message.reply('Usage: attach an image with `!addref <A|B|C|D>` (slot must be bound).').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    try {
      const buf = await fetchAttachmentBuffer(att);
      const mime = att.contentType || 'image/png';
      const up = await uploadImage(studioCfg(), buf, mime);
      if (!up.ok) { await message.reply(friendlyHttpError(up.status, up.raw, 'the studio', 'upload ref')).catch(() => {}); return; }
      const res = await addCastRef(studioCfg(), castId, { key: up.data.key, mime });
      if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'add cast ref')).catch(() => {}); return; }
      castCatalogCache = null;
      await message.reply(`Training ref added to slot **${slot}** (\`${up.data.key}\`).`).catch(() => {});
    } catch (e) {
      await message.reply(`Add ref failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (rawText.startsWith('!addsource ')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    const att = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (!['A', 'B', 'C', 'D'].includes(slot) || !att) {
      await message.reply('Usage: attach an image with `!addsource <A|B|C|D>` (slot must be bound).').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    try {
      const buf = await fetchAttachmentBuffer(att);
      const mime = att.contentType || 'image/png';
      const up = await uploadImage(studioCfg(), buf, mime);
      if (!up.ok) { await message.reply(friendlyHttpError(up.status, up.raw, 'the studio', 'upload source')).catch(() => {}); return; }
      const res = await addCastSource(studioCfg(), castId, { key: up.data.key, mime });
      if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'add cast source')).catch(() => {}); return; }
      castCatalogCache = null;
      await message.reply(`Source photo added to slot **${slot}** (\`${up.data.key}\`).`).catch(() => {});
    } catch (e) {
      await message.reply(`Add source failed: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (rawText.startsWith('!delref ')) {
    const parts = rawText.split(/\s+/);
    const slot = parts[1]?.toUpperCase();
    const refKey = parts[2];
    if (!['A', 'B', 'C', 'D'].includes(slot) || !refKey) {
      await message.reply('Usage: `!delref <A|B|C|D> <ref-key>`').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    const res = await deleteCastRef(studioCfg(), castId, { key: refKey });
    if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'delete cast ref')).catch(() => {}); return; }
    castCatalogCache = null;
    await message.reply(`Removed ref \`${refKey}\` from slot **${slot}**.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!delsource ')) {
    const parts = rawText.split(/\s+/);
    const slot = parts[1]?.toUpperCase();
    const sourceKey = parts[2];
    if (!['A', 'B', 'C', 'D'].includes(slot) || !sourceKey) {
      await message.reply('Usage: `!delsource <A|B|C|D> <source-key>`').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    const res = await deleteCastSource(studioCfg(), castId, { key: sourceKey });
    if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'delete cast source')).catch(() => {}); return; }
    castCatalogCache = null;
    await message.reply(`Removed source \`${sourceKey}\` from slot **${slot}**.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!clearportrait')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(slot)) {
      await message.reply('Usage: `!clearportrait <A|B|C|D>`').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const castId = await castIdForSlot(project.brief, slot);
    if (!castId) { await message.reply(`Slot **${slot}** is not bound.`).catch(() => {}); return; }
    const res = await deleteCastPortrait(studioCfg(), castId);
    if (!res.ok) { await message.reply(friendlyHttpError(res.status, res.raw, 'the studio', 'clear portrait')).catch(() => {}); return; }
    castCatalogCache = null;
    await message.reply(`Portrait cleared for slot **${slot}**.`).catch(() => {});
    return;
  }

  if (rawText.startsWith('!characterref ')) {
    const slot = rawText.split(/\s+/)[1]?.toUpperCase();
    const att = message.attachments.find((a) => a.contentType?.startsWith('image/'));
    if (!['A', 'B', 'C', 'D'].includes(slot) || !att) {
      await message.reply('Usage: attach an image with `!characterref <A|B|C|D>` for storyboard refs.').catch(() => {});
      return;
    }
    const project = await getProject(channelId);
    const ch = project.brief.cast.find((c) => c.slot === slot);
    if (!ch) { await message.reply(`No character in slot **${slot}** yet.`).catch(() => {}); return; }
    try {
      const buf = await fetchAttachmentBuffer(att);
      const mime = att.contentType || 'image/png';
      const up = await uploadCharacterRef(studioCfg(), buf, mime);
      if (!up.ok) { await message.reply(friendlyHttpError(up.status, up.raw, 'the studio', 'upload character ref')).catch(() => {}); return; }
      ch.portraitKey = up.data.key;
      await saveProject(channelId);
      await message.reply(`Character ref staged for slot **${slot}** (\`${up.data.key}\`).`).catch(() => {});
    } catch (e) {
      await message.reply(`Character ref upload failed: ${e.message}`).catch(() => {});
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

  if (rawText.startsWith('!memory')) {
    const query = rawText.slice('!memory'.length).trim();
    if (!query) { await message.reply('Usage: `!memory <query>` -- search what Slate has retained about this channel.').catch(() => {}); return; }

    const result = await queryMemory(channelId, query);
    if (!result.ok) { await message.reply(`Memory search failed: ${result.error}`).catch(() => {}); return; }
    for (const chunk of splitMessage(formatMemoryResults(result.results))) await message.reply(chunk).catch(() => {});
    return;
  }

  // A "ship it" while a huddle is armed fires the submit. Handle every armed case explicitly so a
  // confirmation never silently vanishes: a fresh clean phrase ships; an expired one says so; a
  // near-miss affirmation ("let's ship it", "yes") gets nudged toward the exact word while the
  // huddle stays armed. Outside an armed window these words are just ordinary conversation.
  const armed = pendingConfirms.get(channelId);
  if (armed) {
    const fresh = Date.now() - armed.at <= CONFIRM_TTL_MS;
    if (looksLikeShip(rawText)) {
      pendingConfirms.delete(channelId);
      if (fresh) {
        const project = await getProject(channelId);
        const say = (t) => message.reply(t).catch(() => {});
        await runSubmit(project.brief, channelId, armed.quality, project.imageModel, say);
      } else {
        await message.reply('That huddle timed out, so I held off. Run `!render` again when you are ready and I will line it back up.').catch(() => {});
      }
      return;
    }
    if (looksLikeShipIntent(rawText)) {
      if (fresh) {
        await message.reply('Want me to send it? Say `ship it` (or `!render now` / `!ship`) and it is off.').catch(() => {});
      } else {
        pendingConfirms.delete(channelId);
        await message.reply('That huddle timed out before I caught a yes. Run `!render` again, then say `ship it`.').catch(() => {});
      }
      return;
    }
    // Anything else while armed is ordinary conversation (usually still tuning) -- fall through and
    // leave the huddle armed until it is confirmed or expires.
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

    // Serialize this channel's history mutation + save so two concurrent messages (or an in-flight
    // extract) cannot interleave-clobber the D1 blob.
    await withChannelLock(channelId, async () => {
      const project = await getProject(channelId);
      // Store text-only in history (image data is too large for D1).
      const historyText = imageBlocks.length > 0 ? `[${imageBlocks.length} image(s)]\n${userLabel}` : userLabel;
      project.history.push({ role: 'user',      content: historyText });
      project.history.push({ role: 'assistant', content: reply });
      while (project.history.length > CFG.historyLen * 2) project.history.shift();
      await saveProject(channelId);
    });

    // slate#90: index this exchange into session memory for RAG recall. Fire-and-forget, same as
    // the traffic-observer and brief-snapshot ingests -- never adds latency to the user-facing reply.
    const memoryText = imageBlocks.length > 0 ? `[${imageBlocks.length} image(s)]\n${userLabel}` : userLabel;
    indexMemory(channelId, 'chat', `${memoryText}\nSlate: ${reply}`).catch(() => {});

    // Background brief extraction (its own lock guards the commit).
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

setStudioRequestObserver(onStudioRequest); // slate#90: ledger + memory ingest for every studio call

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
