// studio.mjs
// Complete Vivijure studio HTTP client (docs/CONTRACT.md). Slate is a thin projection client.

function buildUrl(base, path, query) {
  const url = new URL(base.replace(/\/+$/, '') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function readResponse(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text().catch(() => '');
  if (ct.includes('json') && text) {
    try {
      return { ok: res.ok, status: res.status, data: JSON.parse(text), raw: text };
    } catch {
      return { ok: res.ok, status: res.status, data: null, raw: text };
    }
  }
  return { ok: res.ok, status: res.status, data: text, raw: text };
}

// Observer hook (slate#90): every studio call flows through this one function, so it is the single
// choke point for a full traffic ledger without threading channel/session context through 100+ call
// sites. bot.mjs registers an observer that logs each request/response to D1 and, for mutating calls,
// indexes a summary into Vectorize for RAG. Kept optional and side-effect-free by default so studio.mjs
// stays a plain, bot-agnostic HTTP client (unit-testable, no D1/Vectorize awareness).
let requestObserver = null;
export function setStudioRequestObserver(fn) { requestObserver = fn; }
function notifyObserver(event) {
  if (!requestObserver) return;
  try { requestObserver(event); } catch { /* observer failures never affect the studio call */ }
}

export async function studioRequest(baseUrl, headers, method, path, opts = {}) {
  const init = { method, headers: { ...headers } };
  if (opts.body !== undefined && !(opts.body instanceof ArrayBuffer) && !ArrayBuffer.isView(opts.body)) {
    if (typeof opts.body === 'string') {
      init.body = opts.body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
  } else if (opts.body !== undefined) {
    init.body = opts.body;
  }
  if (opts.contentType) init.headers['Content-Type'] = opts.contentType;

  const startedAt = Date.now();
  try {
    const res = await fetch(buildUrl(baseUrl, path, opts.query), init);
    const result = await readResponse(res);
    notifyObserver({ method, path, query: opts.query, body: opts.body, result, latencyMs: Date.now() - startedAt });
    return result;
  } catch (e) {
    notifyObserver({ method, path, query: opts.query, body: opts.body, error: e, latencyMs: Date.now() - startedAt });
    throw e;
  }
}

export async function studioGet(baseUrl, headers, path, query) {
  return studioRequest(baseUrl, headers, 'GET', path, { query });
}

export async function studioPost(baseUrl, headers, path, body, opts = {}) {
  return studioRequest(baseUrl, headers, 'POST', path, { body, ...opts });
}

export async function studioPatch(baseUrl, headers, path, body) {
  return studioRequest(baseUrl, headers, 'PATCH', path, { body });
}

export async function studioDelete(baseUrl, headers, path, body) {
  return studioRequest(baseUrl, headers, 'DELETE', path, body ? { body } : {});
}

export async function studioUploadBinary(baseUrl, headers, path, buffer, mime) {
  return studioPost(baseUrl, headers, path, buffer, { contentType: mime });
}

// --- system -------------------------------------------------------------------

export const getHealth = (c) => studioGet(c.vivijureUrl, c.headers, '/health');
export const getModules = (c) => studioGet(c.vivijureUrl, c.headers, '/api/modules');
export const getWhoami = (c) => studioGet(c.vivijureUrl, c.headers, '/api/whoami');
export const getPrefs = (c) => studioGet(c.vivijureUrl, c.headers, '/api/prefs');
export const patchPrefs = (c, body) => studioPatch(c.vivijureUrl, c.headers, '/api/prefs', body);
export const getModuleInstallConfig = (c, name) =>
  studioGet(c.vivijureUrl, c.headers, `/api/modules/${encodeURIComponent(name)}/config`);
export const patchModuleInstallConfig = (c, name, body) =>
  studioPatch(c.vivijureUrl, c.headers, `/api/modules/${encodeURIComponent(name)}/config`, body);

// --- voices / models ----------------------------------------------------------

export const listVoices = (c) => studioGet(c.vivijureUrl, c.headers, '/api/voices');
export const getStoryboardModels = (c) => studioGet(c.vivijureUrl, c.headers, '/api/storyboard/models');

// --- cast ---------------------------------------------------------------------

export const listCast = (c) => studioGet(c.vivijureUrl, c.headers, '/api/cast');
export const getCast = (c, id) => studioGet(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}`);
export const createCast = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/cast', body);
export const updateCast = (c, id, body) => studioPatch(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}`, body);
export const deleteCast = (c, id) => studioDelete(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}`);
export const setCastPortrait = (c, id, body) =>
  studioPost(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/portrait`, body);
export const deleteCastPortrait = (c, id) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/portrait`);
export const addCastRef = (c, id, body) =>
  studioPost(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/ref`, body);
export const deleteCastRef = (c, id, body) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/ref`, body);
export const deleteCastRefByKey = (c, id, refKey) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/refs/${encodeURIComponent(refKey)}`);
export const addCastSource = (c, id, body) =>
  studioPost(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/source`, body);
export const deleteCastSource = (c, id, body) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/source`, body);
export const deleteCastSourceByKey = (c, id, sourceKey) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/source/${encodeURIComponent(sourceKey)}`);
export const generateCastRefs = (c, id, body = {}) =>
  studioPost(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/generate-refs`, body);
export const pollCastRefsJob = (c, id, jobId) =>
  studioGet(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/refs-job/${encodeURIComponent(jobId)}`);
export const trainCastLora = (c, id, body = {}) =>
  studioPost(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/train-lora`, body);
export const getCastLoraStatus = (c, id) =>
  studioGet(c.vivijureUrl, c.headers, `/api/cast/${encodeURIComponent(id)}/lora-status`);
export const exportCastUrl = (c, id) => `${c.vivijureUrl.replace(/\/+$/, '')}/api/cast/export/${encodeURIComponent(id)}`;
export const importCast = (c, buffer) =>
  studioUploadBinary(c.vivijureUrl, c.headers, '/api/cast/import', buffer, 'application/x-tar');

// --- uploads ------------------------------------------------------------------

export const uploadImage = (c, buffer, mime) =>
  studioUploadBinary(c.vivijureUrl, c.headers, '/api/upload', buffer, mime);
export const uploadCharacterRef = (c, buffer, mime) =>
  studioUploadBinary(c.vivijureUrl, c.headers, '/api/storyboard/character-ref', buffer, mime);
export const uploadAudio = (c, buffer, mime) =>
  studioUploadBinary(c.vivijureUrl, c.headers, '/api/storyboard/audio-upload', buffer, mime);
export const artifactUrl = (c, key) =>
  `${c.vivijureUrl.replace(/\/+$/, '')}/api/artifact/${key.split('/').map(encodeURIComponent).join('/')}`;

// --- projects -----------------------------------------------------------------

export const listProjects = (c) => studioGet(c.vivijureUrl, c.headers, '/api/storyboard/projects');
export const getProject = (c, id) =>
  studioGet(c.vivijureUrl, c.headers, `/api/storyboard/projects/${encodeURIComponent(id)}`);
export const createProject = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/storyboard/projects', body);
export const updateProject = (c, id, body) =>
  studioPatch(c.vivijureUrl, c.headers, `/api/storyboard/projects/${encodeURIComponent(id)}`, body);
export const saveProjectStoryboard = (c, id, storyboard) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/projects/${encodeURIComponent(id)}/storyboard`, { storyboard });
export const deleteProject = (c, id) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/storyboard/projects/${encodeURIComponent(id)}`);

// --- planning -----------------------------------------------------------------

export const planStoryboard = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/storyboard/plan', body);
export const refineStoryboard = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/storyboard/refine', body);
export const preflightStoryboard = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/storyboard/preflight', body);
export const enhanceStoryboard = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/storyboard/enhance', body);
export const bundleStoryboard = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/storyboard/bundle', body);
export const storyboardYaml = (c, storyboard) =>
  studioPost(c.vivijureUrl, c.headers, '/api/storyboard/yaml', { storyboard });
export const storyboardMarkers = (c, body) =>
  studioPost(c.vivijureUrl, c.headers, '/api/storyboard/markers', body);
export const studioChat = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/chat', body);

// --- score / audio ------------------------------------------------------------

export const startScoreBed = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/storyboard/score-bed', body);
export const pollJob = (c, jobId, moduleName) =>
  studioGet(c.vivijureUrl, c.headers, `/api/job/${encodeURIComponent(jobId)}`, { module: moduleName });
export const analyzeAudio = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/audio/analyze', body);

// --- storyboard render bridge -------------------------------------------------

export const submitStoryboardRender = (c, body) =>
  studioPost(c.vivijureUrl, c.headers, '/api/storyboard/render', body);
export const submitRenderPlan = (c, body) =>
  studioPost(c.vivijureUrl, c.headers, '/api/storyboard/render-plan', body);
export const submitRenderFromKeyframes = (c, body) =>
  studioPost(c.vivijureUrl, c.headers, '/api/storyboard/render-from-keyframes', body);
export const submitScatterRender = (c, body) =>
  studioPost(c.vivijureUrl, c.headers, '/api/storyboard/render/scatter', body);
export const pollStoryboardRender = (c, jobId) =>
  studioGet(c.vivijureUrl, c.headers, `/api/storyboard/render/${encodeURIComponent(jobId)}`);
export const cancelStoryboardRender = (c, jobId) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/storyboard/render/${encodeURIComponent(jobId)}`);

// --- film / clips orchestrator ------------------------------------------------

export const submitFilm = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/render/film', body);
export const pollFilm = (c, filmId) =>
  studioGet(c.vivijureUrl, c.headers, `/api/render/film/${encodeURIComponent(filmId)}`);
export const submitClips = (c, body) => studioPost(c.vivijureUrl, c.headers, '/api/render/clips', body);
export const pollClips = (c, jobId) =>
  studioGet(c.vivijureUrl, c.headers, `/api/render/clips/${encodeURIComponent(jobId)}`);

// --- render library -----------------------------------------------------------

export const listRenders = (c, query) => studioGet(c.vivijureUrl, c.headers, '/api/storyboard/renders', query);
export const listRenderTags = (c) => studioGet(c.vivijureUrl, c.headers, '/api/storyboard/renders/tags');
export const patchRender = (c, id, body) =>
  studioPatch(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}`, body);
export const deleteRender = (c, id) =>
  studioDelete(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}`);
export const regenShot = (c, id, body) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}/regen-shot`, body);
export const retryRender = (c, id, body = {}) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}/retry`, body);
export const addRenderAudio = (c, id, body) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}/add-audio`, body);
export const addRenderNarration = (c, id, body) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}/add-narration`, body);
export const finalizeRender = (c, id, body = {}) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}/finalize`, body);
export const animateRenderCloud = (c, id, body = {}) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}/animate-cloud`, body);
export const animateRenderHybrid = (c, id, body = {}) =>
  studioPost(c.vivijureUrl, c.headers, `/api/storyboard/renders/${encodeURIComponent(id)}/animate-hybrid`, body);
export const adoptRender = (c, body) =>
  studioPost(c.vivijureUrl, c.headers, '/api/storyboard/renders/adopt', body);
