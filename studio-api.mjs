// studio-api.mjs
// Slate surfaces for every Vivijure studio API route (docs/CONTRACT.md). Each action maps to one
// HTTP call or a brief-aware wrapper. Dispatch via !api <action> [args].

import * as studio from './studio.mjs';
import { CONTRACT_ROUTES, STUDIO_API_ROUTE_COUNT } from './contract.mjs';
import {
  buildCastLoras,
  buildCharacterRefs,
  buildStoryboardPayload,
  buildFilmTitles,
  formatCastRoster,
  formatPreflightResult,
  mapModuleOverridesToFilmConfigs,
  applySubtitleToFilmFinish,
} from './lib.mjs';

/** Parse `key:value` pairs or JSON into an object. */
export function parseApiArgs(raw) {
  const s = (raw ?? '').trim();
  if (!s) return {};
  if (s.startsWith('{')) {
    return JSON.parse(s);
  }
  const out = {};
  const re = /(\w+):(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  if (Object.keys(out).length) return out;
  throw new Error('args must be JSON or key:value pairs (e.g. name:Wren bible:"a pilot")');
}

export function formatApiResult(res) {
  if (!res) return '(no response)';
  if (!res.ok) {
    const err = res.data?.error || res.raw || `HTTP ${res.status}`;
    return `**Error ${res.status}:** ${String(err).slice(0, 1800)}`;
  }
  const d = res.data;
  if (typeof d === 'string') {
    return d.length > 1900 ? d.slice(0, 1900) + '…' : d;
  }
  return '```json\n' + JSON.stringify(d, null, 2).slice(0, 1850) + '\n```';
}

async function briefStoryboard(ctx) {
  const catalog = await ctx.fetchCastCatalog();
  const refs = buildCharacterRefs(ctx.brief, catalog);
  return buildStoryboardPayload(ctx.brief, refs);
}

async function briefBundleKey(ctx) {
  const catalog = await ctx.fetchCastCatalog();
  const characterRefs = buildCharacterRefs(ctx.brief, catalog);
  const storyboard = buildStoryboardPayload(ctx.brief, characterRefs);
  const res = await studio.bundleStoryboard(ctx.cfg, { storyboard, characterRefs });
  if (!res.ok) throw new Error(res.data?.error || res.raw || `bundle failed ${res.status}`);
  return res.data?.bundleKey;
}

function filmScenes(brief) {
  return brief.scenes.map((s) => ({
    shot_id: s.id,
    prompt: s.prompt ?? '',
    seconds: s.target_seconds ?? brief.clip_seconds ?? 5,
  }));
}

async function buildFilmBody(ctx, opts = {}) {
  const { brief } = ctx;
  const rs = brief.render_settings || ctx.emptyRenderSettings();
  const quality = opts.quality ?? rs.quality_tier ?? 'draft';
  const bundleKey = opts.bundleKey ?? await briefBundleKey(ctx);
  const registry = await ctx.fetchRegistry();
  const mapped = registry
    ? mapModuleOverridesToFilmConfigs(registry, rs, quality)
    : { keyframe_config: { quality_tier: quality }, motion_config: {}, finish_config: {}, speech_config: {}, film_finish_config: {}, master_config: {} };

  const body = {
    bundle_key: bundleKey,
    scenes: filmScenes(brief),
    keyframe_config: mapped.keyframe_config,
    finish_config: { 'finish-rife': { interpolate: false, face_restore: 'none' }, ...mapped.finish_config },
    motion_backend: rs.motion_backend || mapped.motion_backend,
    motion_config: mapped.motion_config,
  };
  if (mapped.keyframe_backend) body.keyframe_backend = mapped.keyframe_backend;
  if (Object.keys(mapped.speech_config || {}).length) body.speech_config = mapped.speech_config;
  if (Object.keys(mapped.master_config || {}).length) body.master_config = mapped.master_config;
  if (rs.audio_key) body.audio_key = rs.audio_key;
  const titles = buildFilmTitles(rs);
  if (titles) body.film_titles = titles;
  const dialogueLines = brief.scenes
    .filter((s) => s.dialogue && String(s.dialogue).trim())
    .map((s) => ({ shot_id: s.id, text: String(s.dialogue).trim() }));
  if (dialogueLines.length) body.dialogue_lines = dialogueLines;
  let filmFinish = mapped.film_finish_config || {};
  if (rs.subtitles && dialogueLines.length) {
    const subMod = await ctx.getSubtitleModule();
    if (subMod) filmFinish = applySubtitleToFilmFinish(filmFinish, subMod, true);
  }
  if (Object.keys(filmFinish).length) body.film_finish_config = filmFinish;
  const castLoras = buildCastLoras(brief.cast_bindings);
  if (Object.keys(castLoras).length) body.cast_loras = castLoras;
  if (rs.keyframes_only) body.keyframes_only = true;
  return body;
}

/** Every studio API surface. `run` may use brief context from ctx. */
export const STUDIO_ACTIONS = {
  help: {
    help: 'List all API actions',
    async run() {
      return { ok: true, data: formatStudioHelp() };
    },
  },

  health: { help: 'GET /health', run: (ctx) => studio.getHealth(ctx.cfg) },
  modules: { help: 'GET /api/modules', run: (ctx) => studio.getModules(ctx.cfg) },
  voices: { help: 'GET /api/voices', run: (ctx) => studio.listVoices(ctx.cfg) },
  whoami: { help: 'GET /api/whoami', run: (ctx) => studio.getWhoami(ctx.cfg) },
  prefs: { help: 'GET /api/prefs', run: (ctx) => studio.getPrefs(ctx.cfg) },
  models: { help: 'GET /api/storyboard/models', run: (ctx) => studio.getStoryboardModels(ctx.cfg) },
  'cast-list': {
    help: 'GET /api/cast',
    async run(ctx) {
      const res = await studio.listCast(ctx.cfg);
      if (!res.ok) return res;
      return { ok: true, data: formatCastRoster(res.data?.cast) };
    },
  },
  'cast-get': { help: 'GET /api/cast/:id  args: id:<uuid>', run: (ctx, a) => studio.getCast(ctx.cfg, a.id) },
  'projects-list': { help: 'GET /api/storyboard/projects', run: (ctx) => studio.listProjects(ctx.cfg) },
  'project-get': { help: 'GET /api/storyboard/projects/:id  args: id:<uuid>', run: (ctx, a) => studio.getProject(ctx.cfg, a.id) },
  'renders-list': { help: 'GET /api/storyboard/renders  args: limit:10 project_id:<uuid>', run: (ctx, a) => studio.listRenders(ctx.cfg, a) },
  'renders-tags': { help: 'GET /api/storyboard/renders/tags', run: (ctx) => studio.listRenderTags(ctx.cfg) },
  'module-config-get': { help: 'GET /api/modules/:name/config  args: name:<module>', run: (ctx, a) => studio.getModuleInstallConfig(ctx.cfg, a.name) },
  'cast-lora-status': { help: 'GET /api/cast/:id/lora-status  args: id:<uuid>', run: (ctx, a) => studio.getCastLoraStatus(ctx.cfg, a.id) },
  'cast-refs-poll': { help: 'GET refs-job  args: id:<uuid> jobId:<id>', run: (ctx, a) => studio.pollCastRefsJob(ctx.cfg, a.id, a.jobId) },
  'render-poll': { help: 'GET /api/storyboard/render/:jobId  args: jobId:', run: (ctx, a) => studio.pollStoryboardRender(ctx.cfg, a.jobId) },
  'film-poll': { help: 'GET /api/render/film/:id  args: id:', run: (ctx, a) => studio.pollFilm(ctx.cfg, a.id) },
  'clips-poll': { help: 'GET /api/render/clips/:id  args: id:', run: (ctx, a) => studio.pollClips(ctx.cfg, a.id) },
  'job-poll': { help: 'GET /api/job/:id  args: id: module:', run: (ctx, a) => studio.pollJob(ctx.cfg, a.id, a.module) },
  'artifact-url': { help: 'artifact URL  args: key:', run: (ctx, a) => ({ ok: true, data: { url: studio.artifactUrl(ctx.cfg, a.key) } }) },
  'cast-export-url': { help: 'export URL  args: id:', run: (ctx, a) => ({ ok: true, data: { url: studio.exportCastUrl(ctx.cfg, a.id) } }) },

  'prefs-patch': { help: 'PATCH /api/prefs  args: JSON', run: (ctx, a) => studio.patchPrefs(ctx.cfg, a) },
  'module-config-patch': {
    help: 'PATCH module install config  args: name:<mod> field:value ...',
    run: (ctx, a) => {
      const { name, ...rest } = a;
      return studio.patchModuleInstallConfig(ctx.cfg, name, rest);
    },
  },
  'cast-create': { help: 'POST /api/cast  args: name: bible:', run: (ctx, a) => studio.createCast(ctx.cfg, a) },
  'cast-update': {
    help: 'PATCH /api/cast/:id  args: id: name: bible: voice_id:',
    run: (ctx, a) => {
      const { id, ...body } = a;
      return studio.updateCast(ctx.cfg, id, body);
    },
  },
  'cast-delete': { help: 'DELETE /api/cast/:id  args: id:', run: (ctx, a) => studio.deleteCast(ctx.cfg, a.id) },
  'cast-portrait-set': {
    help: 'POST portrait  args: id: key: | from_chat_artifact:',
    run: (ctx, a) => {
      const { id, ...body } = a;
      return studio.setCastPortrait(ctx.cfg, id, body);
    },
  },
  'cast-portrait-clear': { help: 'DELETE portrait  args: id:', run: (ctx, a) => studio.deleteCastPortrait(ctx.cfg, a.id) },
  'cast-ref-add': { help: 'POST ref  args: id: key:', run: (ctx, a) => studio.addCastRef(ctx.cfg, a.id, { key: a.key, mime: a.mime || 'image/png' }) },
  'cast-ref-del': { help: 'DELETE ref  args: id: key:', run: (ctx, a) => studio.deleteCastRef(ctx.cfg, a.id, { key: a.key }) },
  'cast-source-add': { help: 'POST source  args: id: key:', run: (ctx, a) => studio.addCastSource(ctx.cfg, a.id, { key: a.key, mime: a.mime || 'image/png' }) },
  'cast-source-del': { help: 'DELETE source  args: id: key:', run: (ctx, a) => studio.deleteCastSource(ctx.cfg, a.id, { key: a.key }) },
  'cast-generate-refs': {
    help: 'POST generate-refs  args: id: [art_style:]',
    run: (ctx, a) => {
      const { id, ...body } = a;
      return studio.generateCastRefs(ctx.cfg, id, body);
    },
  },
  'cast-train-lora': { help: 'POST train-lora  args: id:', run: (ctx, a) => studio.trainCastLora(ctx.cfg, a.id, {}) },
  'project-create': { help: 'POST project  args: name:', run: (ctx, a) => studio.createProject(ctx.cfg, a) },
  'project-patch': {
    help: 'PATCH project  args: id: name:',
    run: (ctx, a) => {
      const { id, ...body } = a;
      return studio.updateProject(ctx.cfg, id, body);
    },
  },
  'project-delete': { help: 'DELETE project  args: id:', run: (ctx, a) => studio.deleteProject(ctx.cfg, a.id) },
  'project-save-storyboard': {
    help: 'Save current brief to project  args: id:',
    async run(ctx, a) {
      return studio.saveProjectStoryboard(ctx.cfg, a.id, await briefStoryboard(ctx));
    },
  },
  plan: { help: 'POST plan  args: brief: model:', run: (ctx, a) => studio.planStoryboard(ctx.cfg, a) },
  refine: {
    help: 'POST refine  args: message: model:',
    async run(ctx, a) {
      return studio.refineStoryboard(ctx.cfg, { storyboard: await briefStoryboard(ctx), message: a.message, model: a.model });
    },
  },
  enhance: {
    help: 'POST enhance  args: brief:',
    async run(ctx, a) {
      return studio.enhanceStoryboard(ctx.cfg, { storyboard: await briefStoryboard(ctx), brief: a.brief });
    },
  },
  preflight: {
    help: 'POST preflight (current brief)',
    async run(ctx) {
      const catalog = await ctx.fetchCastCatalog();
      const characterRefs = buildCharacterRefs(ctx.brief, catalog);
      const storyboard = buildStoryboardPayload(ctx.brief, characterRefs);
      const rs = ctx.brief.render_settings || {};
      const res = await studio.preflightStoryboard(ctx.cfg, {
        storyboard,
        castBindings: buildCastLoras(ctx.brief.cast_bindings),
        motionBackend: rs.motion_backend,
        quality: rs.quality_tier,
        audioKey: rs.audio_key,
      });
      if (res.ok) return { ok: true, data: formatPreflightResult(res.data) };
      return res;
    },
  },
  bundle: {
    help: 'POST bundle (current brief)',
    async run(ctx) {
      const catalog = await ctx.fetchCastCatalog();
      const characterRefs = buildCharacterRefs(ctx.brief, catalog);
      return studio.bundleStoryboard(ctx.cfg, { storyboard: buildStoryboardPayload(ctx.brief, characterRefs), characterRefs });
    },
  },
  yaml: {
    help: 'POST yaml export (current brief)',
    async run(ctx) {
      return studio.storyboardYaml(ctx.cfg, await briefStoryboard(ctx));
    },
  },
  markers: {
    help: 'POST markers  args: format:premiere_csv|resolve_csv fps:24',
    async run(ctx, a) {
      return studio.storyboardMarkers(ctx.cfg, {
        storyboard: await briefStoryboard(ctx),
        format: a.format || 'premiere_csv',
        fps: a.fps ? Number(a.fps) : undefined,
      });
    },
  },
  chat: { help: 'POST /api/chat  args: model: user_input:', run: (ctx, a) => studio.studioChat(ctx.cfg, a) },
  'score-bed': { help: 'POST score-bed  args: kind:music|narration prompt: text:', run: (ctx, a) => studio.startScoreBed(ctx.cfg, a) },
  'audio-analyze': { help: 'POST audio/analyze  args: audioKey:', run: (ctx, a) => studio.analyzeAudio(ctx.cfg, a) },
  'render-plan': { help: 'POST render-plan  args: selection:JSON', run: (ctx, a) => studio.submitRenderPlan(ctx.cfg, a) },
  'storyboard-render': {
    help: 'POST /api/storyboard/render  args: keyframesOnly:true|false',
    async run(ctx, a) {
      const rs = ctx.brief.render_settings || {};
      return studio.submitStoryboardRender(ctx.cfg, {
        bundleKey: await briefBundleKey(ctx),
        scenes: filmScenes(ctx.brief),
        qualityTier: rs.quality_tier || 'draft',
        motion_backend: rs.motion_backend,
        castLoras: buildCastLoras(ctx.brief.cast_bindings),
        audioKey: rs.audio_key,
        keyframesOnly: a.keyframesOnly === true || a.keyframesOnly === 'true',
        renderOverrides: rs.module_overrides,
      });
    },
  },
  'render-from-keyframes': { help: 'POST render-from-keyframes  args: bundleKey:', run: (ctx, a) => studio.submitRenderFromKeyframes(ctx.cfg, a) },
  scatter: {
    help: 'POST scatter render  args: shardCount:2',
    async run(ctx, a) {
      const rs = ctx.brief.render_settings || {};
      return studio.submitScatterRender(ctx.cfg, {
        bundleKey: await briefBundleKey(ctx),
        shotIds: ctx.brief.scenes.map((s) => s.id),
        shardCount: a.shardCount ? Number(a.shardCount) : 2,
        qualityTier: rs.quality_tier || 'draft',
        castLoras: buildCastLoras(ctx.brief.cast_bindings),
        motion_backend: rs.motion_backend,
        renderOverrides: rs.module_overrides,
        audioKey: rs.audio_key,
        film_titles: buildFilmTitles(rs),
      });
    },
  },
  'film-submit': {
    help: 'POST /api/render/film (current brief)',
    async run(ctx, a) {
      return studio.submitFilm(ctx.cfg, await buildFilmBody(ctx, a));
    },
  },
  'clips-submit': {
    help: 'POST /api/render/clips  args: shots:JSON',
    run: (ctx, a) => studio.submitClips(ctx.cfg, typeof a.shots === 'string' ? { ...a, shots: JSON.parse(a.shots) } : a),
  },
  'render-cancel': { help: 'DELETE render job  args: jobId:', run: (ctx, a) => studio.cancelStoryboardRender(ctx.cfg, a.jobId) },
  'render-patch': {
    help: 'PATCH render row  args: id: label: tags:JSON',
    run: (ctx, a) => {
      const { id, ...body } = a;
      if (typeof body.tags === 'string') body.tags = JSON.parse(body.tags);
      return studio.patchRender(ctx.cfg, id, body);
    },
  },
  'render-delete': { help: 'DELETE render row  args: id:', run: (ctx, a) => studio.deleteRender(ctx.cfg, a.id) },
  'render-regen-shot': { help: 'POST regen-shot  args: id: shotId:', run: (ctx, a) => studio.regenShot(ctx.cfg, a.id, { shotId: a.shotId }) },
  'render-retry': { help: 'POST /api/storyboard/renders/:id/retry  args: id:', run: (ctx, a) => studio.retryRender(ctx.cfg, a.id, a) },
  'render-add-audio': { help: 'POST add-audio  args: id: audioKey:', run: (ctx, a) => studio.addRenderAudio(ctx.cfg, a.id, { audioKey: a.audioKey }) },
  'render-add-narration': { help: 'POST add-narration  args: id: text:', run: (ctx, a) => studio.addRenderNarration(ctx.cfg, a.id, a) },
  'render-finalize': {
    help: 'POST finalize  args: id: [audioKey:]',
    run: (ctx, a) => {
      const { id, ...body } = a;
      return studio.finalizeRender(ctx.cfg, id, body);
    },
  },
  'render-animate-cloud': {
    help: 'POST animate-cloud  args: id: [model:]',
    run: (ctx, a) => {
      const { id, ...body } = a;
      return studio.animateRenderCloud(ctx.cfg, id, body);
    },
  },
  'render-animate-hybrid': {
    help: 'POST animate-hybrid  args: id: [backends:JSON]',
    run: (ctx, a) => {
      const { id, ...body } = a;
      if (typeof body.backends === 'string') body.backends = JSON.parse(body.backends);
      return studio.animateRenderHybrid(ctx.cfg, id, body);
    },
  },
  'render-adopt': { help: 'POST renders/adopt  args: JSON body', run: (ctx, a) => studio.adoptRender(ctx.cfg, a) },
};

export function formatStudioHelp() {
  const lines = [`**Vivijure studio API** (${STUDIO_API_ROUTE_COUNT} routes, \`!api <action> [args]\`)\n`];
  const actionRoute = Object.fromEntries(
    CONTRACT_ROUTES.flatMap((r) => r.actions.map((a) => [a, r])),
  );
  for (const [k, v] of Object.entries(STUDIO_ACTIONS)) {
    if (k === 'help') continue;
    const route = actionRoute[k];
    const tag = route ? `#${route.id}` : '(extra)';
    lines.push(`  \`${k}\` ${tag} -- ${v.help}`);
  }
  lines.push('\nUploads (attach file to message): `!importcast`, `!upload`, `!audioupload`, `!characterref <slot>`, `!addref <slot>`, `!addsource <slot>`');
  lines.push('Conformance matrix: `!conformance` or `docs/CONTRACT-conformance.md`');
  return lines.join('\n');
}

export async function executeStudioAction(action, argsRaw, ctx) {
  const key = (action ?? '').trim().toLowerCase();
  if (!key || key === 'help') {
    return { ok: true, text: formatStudioHelp() };
  }
  const def = STUDIO_ACTIONS[key];
  if (!def) {
    return { ok: false, text: `Unknown action \`${key}\`. Try \`!api help\`.` };
  }
  if (!ctx.cfg?.vivijureUrl) {
    return { ok: false, text: 'Studio not configured (VIVIJURE_API_URL + STUDIO_API_TOKEN).' };
  }
  let args = {};
  if (argsRaw?.trim()) {
    try {
      args = parseApiArgs(argsRaw);
    } catch (e) {
      return { ok: false, text: `Bad args: ${e.message}` };
    }
  }
  try {
    const res = await def.run(ctx, args);
    if (typeof res?.data === 'string' && !res.data.startsWith('{')) {
      return { ok: res.ok !== false, text: res.data };
    }
    return { ok: res?.ok !== false, text: formatApiResult(res) };
  } catch (e) {
    return { ok: false, text: `Action failed: ${e.message}` };
  }
}
