// contract.mjs
// Canonical 1:1 mapping: Vivijure docs/CONTRACT.md section 2.1 (68 routes) plus control-panel
// supplements -> Slate surfaces. CI asserts zero drift via contract.test.ts.

/** @typedef {{ id: number, method: string, path: string, section: string, studioFn: string|string[], actions: string[], commands: string[], notes?: string }} ContractRoute */

/** Routes in vivijure/docs/CONTRACT.md section 2.1. */
export const CONTRACT_MD_ROUTE_COUNT = 68;

/** Studio HTTP routes Slate must surface (CONTRACT + control-panel parity). */
export const STUDIO_API_ROUTE_COUNT = 69;
export const CONTRACT_ROUTES = [
  { id: 1, method: 'GET', path: '/health', section: '2.2', studioFn: 'getHealth', actions: ['health'], commands: ['!health', '!api health'] },
  { id: 2, method: 'GET', path: '/api/modules', section: '2.3', studioFn: 'getModules', actions: ['modules'], commands: ['!hooks', '!api modules'] },
  { id: 3, method: 'GET', path: '/api/voices', section: '2.4', studioFn: 'listVoices', actions: ['voices'], commands: ['!voices', '/voices'] },
  { id: 4, method: 'GET', path: '/api/storyboard/projects', section: '2.5', studioFn: 'listProjects', actions: ['projects-list'], commands: ['!projects', '!api projects-list'] },
  { id: 5, method: 'POST', path: '/api/storyboard/projects', section: '2.5', studioFn: 'createProject', actions: ['project-create'], commands: ['!saveproject (create)', '!api project-create'] },
  { id: 6, method: 'GET', path: '/api/storyboard/projects/:id', section: '2.5', studioFn: 'getProject', actions: ['project-get'], commands: ['!loadproject', '!api project-get'] },
  { id: 7, method: 'PATCH', path: '/api/storyboard/projects/:id', section: '2.5', studioFn: 'updateProject', actions: ['project-patch'], commands: ['!patchproject', '!api project-patch'] },
  { id: 8, method: 'POST', path: '/api/storyboard/projects/:id/storyboard', section: '2.5', studioFn: 'saveProjectStoryboard', actions: ['project-save-storyboard'], commands: ['!saveproject (update)', '!api project-save-storyboard'] },
  { id: 9, method: 'DELETE', path: '/api/storyboard/projects/:id', section: '2.5', studioFn: 'deleteProject', actions: ['project-delete'], commands: ['!deleteproject', '!api project-delete'] },
  { id: 10, method: 'GET', path: '/api/cast', section: '2.6', studioFn: 'listCast', actions: ['cast-list'], commands: ['!cast', '/cast'] },
  { id: 11, method: 'POST', path: '/api/cast', section: '2.6', studioFn: 'createCast', actions: ['cast-create'], commands: ['!castcreate', '!api cast-create'] },
  { id: 12, method: 'GET', path: '/api/cast/:id', section: '2.6', studioFn: 'getCast', actions: ['cast-get'], commands: ['!castget', '!api cast-get'] },
  { id: 13, method: 'PATCH', path: '/api/cast/:id', section: '2.6', studioFn: 'updateCast', actions: ['cast-update'], commands: ['!voice', '!api cast-update'] },
  { id: 14, method: 'DELETE', path: '/api/cast/:id', section: '2.6', studioFn: 'deleteCast', actions: ['cast-delete'], commands: ['!castdelete', '!api cast-delete'] },
  { id: 15, method: 'POST', path: '/api/cast/:id/portrait', section: '2.7', studioFn: 'setCastPortrait', actions: ['cast-portrait-set'], commands: ['!portrait (sync)', '!api cast-portrait-set'] },
  { id: 16, method: 'DELETE', path: '/api/cast/:id/portrait', section: '2.7', studioFn: 'deleteCastPortrait', actions: ['cast-portrait-clear'], commands: ['!clearportrait', '!api cast-portrait-clear'] },
  { id: 17, method: 'POST', path: '/api/cast/:id/ref', section: '2.7', studioFn: 'addCastRef', actions: ['cast-ref-add'], commands: ['!addref', '!api cast-ref-add'] },
  { id: 18, method: 'DELETE', path: '/api/cast/:id/ref', section: '2.7', studioFn: ['deleteCastRef', 'deleteCastRefByKey'], actions: ['cast-ref-del'], commands: ['!delref', '!api cast-ref-del'] },
  { id: 19, method: 'POST', path: '/api/cast/:id/source', section: '2.7', studioFn: 'addCastSource', actions: ['cast-source-add'], commands: ['!addsource', '!api cast-source-add'] },
  { id: 20, method: 'DELETE', path: '/api/cast/:id/source', section: '2.7', studioFn: ['deleteCastSource', 'deleteCastSourceByKey'], actions: ['cast-source-del'], commands: ['!delsource', '!api cast-source-del'] },
  { id: 21, method: 'POST', path: '/api/cast/:id/generate-refs', section: '2.8', studioFn: 'generateCastRefs', actions: ['cast-generate-refs'], commands: ['!genrefs', '/genrefs'] },
  { id: 22, method: 'GET', path: '/api/cast/:id/refs-job/:jobId', section: '2.8', studioFn: 'pollCastRefsJob', actions: ['cast-refs-poll'], commands: ['!genrefs (polls)', '!api cast-refs-poll'] },
  { id: 23, method: 'POST', path: '/api/cast/:id/train-lora', section: '2.9', studioFn: 'trainCastLora', actions: ['cast-train-lora'], commands: ['!train', '/train'] },
  { id: 24, method: 'GET', path: '/api/cast/:id/lora-status', section: '2.9', studioFn: 'getCastLoraStatus', actions: ['cast-lora-status'], commands: ['!lorastatus', '/lorastatus'] },
  { id: 25, method: 'POST', path: '/api/upload', section: '2.10', studioFn: 'uploadImage', actions: [], commands: ['!upload'], notes: 'attachment command' },
  { id: 26, method: 'GET', path: '/api/artifact/*key', section: '2.11', studioFn: 'artifactUrl', actions: ['artifact-url'], commands: ['!api artifact-url'] },
  { id: 27, method: 'POST', path: '/api/storyboard/preflight', section: '2.12', studioFn: 'preflightStoryboard', actions: ['preflight'], commands: ['!preflight', '/preflight'] },
  { id: 28, method: 'POST', path: '/api/storyboard/plan', section: '2.13', studioFn: 'planStoryboard', actions: ['plan'], commands: ['!plan', '!api plan'] },
  { id: 29, method: 'POST', path: '/api/storyboard/refine', section: '2.13', studioFn: 'refineStoryboard', actions: ['refine'], commands: ['!refine', '!api refine'] },
  { id: 30, method: 'POST', path: '/api/chat', section: '2.13', studioFn: 'studioChat', actions: ['chat'], commands: ['!chat', '!api chat'] },
  { id: 31, method: 'POST', path: '/api/storyboard/score-bed', section: '2.14', studioFn: 'startScoreBed', actions: ['score-bed'], commands: ['!score', '/score'] },
  { id: 32, method: 'GET', path: '/api/job/:id', section: '2.14', studioFn: 'pollJob', actions: ['job-poll'], commands: ['!poll', '!score (polls)', '!api job-poll'] },
  { id: 33, method: 'POST', path: '/api/storyboard/enhance', section: '2.15', studioFn: 'enhanceStoryboard', actions: ['enhance'], commands: ['!autodirect', '/autodirect'] },
  { id: 34, method: 'GET', path: '/api/storyboard/models', section: '2.16', studioFn: 'getStoryboardModels', actions: ['models'], commands: ['!models', '!api models'] },
  { id: 35, method: 'POST', path: '/api/storyboard/yaml', section: '2.16', studioFn: 'storyboardYaml', actions: ['yaml'], commands: ['!yaml', '!api yaml'] },
  { id: 36, method: 'POST', path: '/api/storyboard/markers', section: '2.16', studioFn: 'storyboardMarkers', actions: ['markers'], commands: ['!markers', '!api markers'] },
  { id: 37, method: 'POST', path: '/api/storyboard/bundle', section: '2.16', studioFn: 'bundleStoryboard', actions: ['bundle'], commands: ['!bundle', '!render (bundles)', '!api bundle'] },
  { id: 38, method: 'POST', path: '/api/storyboard/audio-upload', section: '2.10', studioFn: 'uploadAudio', actions: [], commands: ['!audioupload'], notes: 'attachment command' },
  { id: 39, method: 'POST', path: '/api/storyboard/character-ref', section: '2.10', studioFn: 'uploadCharacterRef', actions: [], commands: ['!characterref'], notes: 'attachment command' },
  { id: 40, method: 'POST', path: '/api/audio/analyze', section: '2.17', studioFn: 'analyzeAudio', actions: ['audio-analyze'], commands: ['!analyze', '!api audio-analyze'] },
  { id: 41, method: 'POST', path: '/api/storyboard/render', section: '2.18', studioFn: 'submitStoryboardRender', actions: ['storyboard-render'], commands: ['!storyboard-render', '!api storyboard-render'] },
  { id: 42, method: 'POST', path: '/api/storyboard/render-plan', section: '2.18', studioFn: 'submitRenderPlan', actions: ['render-plan'], commands: ['!render-plan', '!api render-plan'] },
  { id: 43, method: 'POST', path: '/api/render/clips', section: '2.19', studioFn: 'submitClips', actions: ['clips-submit'], commands: ['!clips', '!api clips-submit'] },
  { id: 44, method: 'GET', path: '/api/render/clips/:id', section: '2.19', studioFn: 'pollClips', actions: ['clips-poll'], commands: ['!clipspoll', '!api clips-poll'] },
  { id: 45, method: 'POST', path: '/api/render/film', section: '2.20', studioFn: 'submitFilm', actions: ['film-submit'], commands: ['!render', '!ship', '/render'] },
  { id: 46, method: 'GET', path: '/api/render/film/:id', section: '2.21', studioFn: 'pollFilm', actions: ['film-poll'], commands: ['!filmpoll', '!render (polls)', '!api film-poll'] },
  { id: 47, method: 'POST', path: '/api/storyboard/renders/:id/regen-shot', section: '2.22', studioFn: 'regenShot', actions: ['render-regen-shot'], commands: ['!regen', '!api render-regen-shot'] },
  { id: 48, method: 'POST', path: '/api/storyboard/render/scatter', section: '2.23', studioFn: 'submitScatterRender', actions: ['scatter'], commands: ['!scatter', '!api scatter'] },
  { id: 49, method: 'POST', path: '/api/storyboard/render-from-keyframes', section: '2.18', studioFn: 'submitRenderFromKeyframes', actions: ['render-from-keyframes'], commands: ['!render-keyframes', '!api render-from-keyframes'] },
  { id: 50, method: 'GET', path: '/api/storyboard/render/:jobId', section: '2.24', studioFn: 'pollStoryboardRender', actions: ['render-poll'], commands: ['!renderpoll', '!api render-poll'] },
  { id: 51, method: 'DELETE', path: '/api/storyboard/render/:jobId', section: '2.24', studioFn: 'cancelStoryboardRender', actions: ['render-cancel'], commands: ['!cancel', '!api render-cancel'] },
  { id: 52, method: 'GET', path: '/api/storyboard/renders', section: '2.25', studioFn: 'listRenders', actions: ['renders-list'], commands: ['!renders', '/renders'] },
  { id: 53, method: 'GET', path: '/api/storyboard/renders/tags', section: '2.25', studioFn: 'listRenderTags', actions: ['renders-tags'], commands: ['!rendertags', '!api renders-tags'] },
  { id: 54, method: 'PATCH', path: '/api/storyboard/renders/:id', section: '2.25', studioFn: 'patchRender', actions: ['render-patch'], commands: ['!patch-render', '!api render-patch'] },
  { id: 55, method: 'DELETE', path: '/api/storyboard/renders/:id', section: '2.25', studioFn: 'deleteRender', actions: ['render-delete'], commands: ['!delete-render', '!api render-delete'] },
  { id: 56, method: 'POST', path: '/api/storyboard/renders/:id/add-audio', section: '2.26', studioFn: 'addRenderAudio', actions: ['render-add-audio'], commands: ['!add-audio', '!api render-add-audio'] },
  { id: 57, method: 'POST', path: '/api/storyboard/renders/:id/add-narration', section: '2.26', studioFn: 'addRenderNarration', actions: ['render-add-narration'], commands: ['!add-narration', '!api render-add-narration'] },
  { id: 58, method: 'POST', path: '/api/storyboard/renders/:id/finalize', section: '2.27', studioFn: 'finalizeRender', actions: ['render-finalize'], commands: ['!finalize', '!api render-finalize'] },
  { id: 59, method: 'POST', path: '/api/storyboard/renders/:id/animate-cloud', section: '2.27', studioFn: 'animateRenderCloud', actions: ['render-animate-cloud'], commands: ['!animate-cloud', '!api render-animate-cloud'] },
  { id: 60, method: 'POST', path: '/api/storyboard/renders/:id/animate-hybrid', section: '2.27', studioFn: 'animateRenderHybrid', actions: ['render-animate-hybrid'], commands: ['!animate-hybrid', '!api render-animate-hybrid'] },
  { id: 61, method: 'POST', path: '/api/storyboard/renders/adopt', section: '2.28', studioFn: 'adoptRender', actions: ['render-adopt'], commands: ['!adopt', '!api render-adopt'] },
  { id: 62, method: 'GET', path: '/api/whoami', section: '2.29', studioFn: 'getWhoami', actions: ['whoami'], commands: ['!whoami', '!api whoami'] },
  { id: 63, method: 'GET', path: '/api/prefs', section: '2.29', studioFn: 'getPrefs', actions: ['prefs'], commands: ['!prefs', '!api prefs'] },
  { id: 64, method: 'PATCH', path: '/api/prefs', section: '2.29', studioFn: 'patchPrefs', actions: ['prefs-patch'], commands: ['!api prefs-patch'] },
  { id: 65, method: 'GET', path: '/api/modules/:name/config', section: '4.1.2', studioFn: 'getModuleInstallConfig', actions: ['module-config-get'], commands: ['!install-config', '!api module-config-get'] },
  { id: 66, method: 'PATCH', path: '/api/modules/:name/config', section: '4.1.2', studioFn: 'patchModuleInstallConfig', actions: ['module-config-patch'], commands: ['!install-config', '!api module-config-patch'] },
  { id: 67, method: 'GET/POST', path: '/api/cast/export/:id', section: '2.9a', studioFn: 'exportCastUrl', actions: ['cast-export-url'], commands: ['!exportcast', '!api cast-export-url'] },
  { id: 68, method: 'POST', path: '/api/cast/import', section: '2.9a', studioFn: 'importCast', actions: [], commands: ['!importcast'], notes: 'attachment command' },
  // Control-panel route (planner-history-row.js v0.60.0); studio handler ships separately from CONTRACT.md table.
  { id: 69, method: 'POST', path: '/api/storyboard/renders/:id/retry', section: '2.25', studioFn: 'retryRender', actions: ['render-retry'], commands: ['!retry', '!api render-retry'], notes: 'control panel retry failed render row' },
];

export const CONTRACT_ROUTE_COUNT = CONTRACT_ROUTES.length;

/**
 * Bang-command aliases -> !api action. Parsed before the LLM path in bot.mjs.
 * `args(rest)` builds key:value args; default passes rest through.
 */
export const STUDIO_COMMAND_ALIASES = {
  health: { action: 'health' },
  whoami: { action: 'whoami' },
  prefs: { action: 'prefs' },
  models: { action: 'models' },
  projects: { action: 'projects-list' },
  rendertags: { action: 'renders-tags' },
  plan: { action: 'plan', passRest: true },
  refine: { action: 'refine', restKey: 'message' },
  bundle: { action: 'bundle' },
  yaml: { action: 'yaml' },
  markers: { action: 'markers', passRest: true },
  chat: { action: 'chat', passRest: true },
  scatter: { action: 'scatter', passRest: true },
  'storyboard-render': { action: 'storyboard-render', passRest: true },
  'render-keyframes': { action: 'render-from-keyframes', passRest: true },
  'render-plan': { action: 'render-plan', passRest: true },
  clips: { action: 'clips-submit', passRest: true },
  poll: {
    action: 'job-poll',
    args(rest) {
      const [id, mod] = rest.trim().split(/\s+/);
      if (!id) return null;
      return mod ? `id:${id} module:${mod}` : `id:${id}`;
    },
    usage: '!poll <job-id> [module]',
  },
  renderpoll: { action: 'render-poll', argKey: 'jobId', usage: '!renderpoll <job-id>' },
  filmpoll: { action: 'film-poll', argKey: 'id', usage: '!filmpoll <film-id>' },
  clipspoll: { action: 'clips-poll', argKey: 'id', usage: '!clipspoll <clips-job-id>' },
  cancel: { action: 'render-cancel', argKey: 'jobId', usage: '!cancel <job-id>' },
  regen: {
    action: 'render-regen-shot',
    args(rest) {
      const [id, shotId] = rest.trim().split(/\s+/);
      if (!id || !shotId) return null;
      return `id:${id} shotId:${shotId}`;
    },
    usage: '!regen <render-id> <shot-id>',
  },
  retry: { action: 'render-retry', argKey: 'id', usage: '!retry <render-id>' },
  finalize: { action: 'render-finalize', leadArgKey: 'id', passRest: true, usage: '!finalize <render-id> [audioKey:...]' },
  'animate-cloud': { action: 'render-animate-cloud', leadArgKey: 'id', passRest: true, usage: '!animate-cloud <render-id> [model:...]' },
  'animate-hybrid': { action: 'render-animate-hybrid', leadArgKey: 'id', passRest: true, usage: '!animate-hybrid <render-id> [backends:...]' },
  adopt: { action: 'render-adopt', passRest: true, usage: '!adopt <json-or-key:value-args>' },
  'add-audio': {
    action: 'render-add-audio',
    args(rest) {
      const [id, ...keyParts] = rest.trim().split(/\s+/);
      if (!id || !keyParts.length) return null;
      return `id:${id} audioKey:${keyParts.join(' ')}`;
    },
    usage: '!add-audio <render-id> <audio-key>',
  },
  'add-narration': {
    action: 'render-add-narration',
    args(rest) {
      const [id, ...textParts] = rest.trim().split(/\s+/);
      if (!id || !textParts.length) return null;
      return `id:${id} text:${textParts.join(' ')}`;
    },
    usage: '!add-narration <render-id> <text>',
  },
  'delete-render': { action: 'render-delete', argKey: 'id', usage: '!delete-render <render-id>' },
  'patch-render': { action: 'render-patch', leadArgKey: 'id', passRest: true, usage: '!patch-render <render-id> label:...' },
  deleteproject: { action: 'project-delete', argKey: 'id', usage: '!deleteproject <project-id>' },
  patchproject: { action: 'project-patch', leadArgKey: 'id', passRest: true, usage: '!patchproject <project-id> name:...' },
  castget: { action: 'cast-get', argKey: 'id', usage: '!castget <cast-id>' },
  castcreate: { action: 'cast-create', passRest: true, usage: '!castcreate name:<name> bible:<text>' },
  castdelete: { action: 'cast-delete', argKey: 'id', usage: '!castdelete <cast-id>' },
  exportcast: { action: 'cast-export-url', argKey: 'id', usage: '!exportcast <cast-id>' },
  analyze: { action: 'audio-analyze', passRest: true, usage: '!analyze audioKey:<key>' },
  'audio-analyze': { action: 'audio-analyze', passRest: true },
};

/** Build !api args from a studio command alias definition. */
export function aliasArgs(alias, rest) {
  if (alias.args) {
    const built = alias.args(rest);
    return built === null ? undefined : built;
  }
  if (alias.restKey) {
    return rest ? `${alias.restKey}:${rest}` : '';
  }
  if (alias.argKey) {
    const id = rest.trim().split(/\s+/)[0];
    return id ? `${alias.argKey}:${id}` : undefined;
  }
  if (alias.leadArgKey) {
    const [id, ...more] = rest.trim().split(/\s+/);
    if (!id) return undefined;
    const tail = more.join(' ').trim();
    return tail ? `${alias.leadArgKey}:${id} ${tail}` : `${alias.leadArgKey}:${id}`;
  }
  if (alias.passRest) return rest;
  return '';
}

export function routeById(id) {
  return CONTRACT_ROUTES.find((r) => r.id === id);
}

export function routeForAction(action) {
  return CONTRACT_ROUTES.find((r) => r.actions.includes(action));
}

export function routeForStudioFn(fn) {
  return CONTRACT_ROUTES.find((r) => {
    const fns = Array.isArray(r.studioFn) ? r.studioFn : [r.studioFn];
    return fns.includes(fn);
  });
}

/** Human-readable conformance matrix for Discord or docs. */
export function formatConformanceReport({ compact = false } = {}) {
  const lines = [
    `**Vivijure studio API conformance** (${CONTRACT_ROUTE_COUNT} routes: ${CONTRACT_MD_ROUTE_COUNT} CONTRACT + supplements)`,
    'Source: `vivijure/docs/CONTRACT.md` section 2.1 + control-panel parity\n',
  ];
  for (const r of CONTRACT_ROUTES) {
    const fns = Array.isArray(r.studioFn) ? r.studioFn.join('|') : r.studioFn;
    const surfaces = [
      ...r.commands,
      ...r.actions.map((a) => `!api ${a}`),
    ].filter(Boolean);
    if (compact) {
      lines.push(`**#${r.id}** \`${r.method} ${r.path}\` -> ${surfaces[0] || '(none)'}${surfaces.length > 1 ? ` (+${surfaces.length - 1})` : ''}`);
    } else {
      lines.push(`### #${r.id} ${r.method} ${r.path}`);
      lines.push(`studio: \`${fns}\` | actions: ${r.actions.map((a) => `\`${a}\``).join(', ') || '*(attachment)*'}`);
      lines.push(`commands: ${surfaces.join(', ')}`);
      if (r.notes) lines.push(`_${r.notes}_`);
      lines.push('');
    }
  }
  lines.push('\nRun `npx vitest run contract.test.ts` in CI to assert this matrix stays current.');
  return lines.join('\n');
}

/**
 * Validate studio.mjs + studio-api.mjs against CONTRACT_ROUTES.
 * Returns { ok, errors }.
 */
export function validateContractConformance(studioExports, studioActions) {
  const errors = [];
  const actionKeys = new Set(Object.keys(studioActions || {}).filter((k) => k !== 'help'));

  if (CONTRACT_ROUTES.length !== STUDIO_API_ROUTE_COUNT) {
    errors.push(`CONTRACT_ROUTES length is ${CONTRACT_ROUTES.length}, expected ${STUDIO_API_ROUTE_COUNT}`);
  }

  const contractMdRoutes = CONTRACT_ROUTES.filter((r) => r.id <= CONTRACT_MD_ROUTE_COUNT);
  if (contractMdRoutes.length !== CONTRACT_MD_ROUTE_COUNT) {
    errors.push(`expected ${CONTRACT_MD_ROUTE_COUNT} CONTRACT.md routes, found ${contractMdRoutes.length}`);
  }

  for (const route of CONTRACT_ROUTES) {
    const fns = Array.isArray(route.studioFn) ? route.studioFn : [route.studioFn];
    for (const fn of fns) {
      if (typeof studioExports[fn] !== 'function' && typeof studioExports[fn] !== 'string') {
        errors.push(`#${route.id} missing studio.mjs export: ${fn}`);
      }
    }

    const hasSurface = route.commands.length > 0 || route.actions.length > 0;
    if (!hasSurface) {
      errors.push(`#${route.id} has no Slate command or !api action`);
    }

    for (const action of route.actions) {
      if (!actionKeys.has(action)) {
        errors.push(`#${route.id} missing STUDIO_ACTIONS.${action}`);
      }
    }
  }

  for (const action of actionKeys) {
    if (!routeForAction(action)) {
      errors.push(`STUDIO_ACTIONS.${action} is not mapped to any studio route`);
    }
  }

  const infra = new Set([
    'studioRequest', 'studioGet', 'studioPost', 'studioPatch', 'studioDelete', 'studioUploadBinary',
    'setStudioRequestObserver', // slate#90: traffic-ledger/RAG observer hook, not an HTTP route
  ]);

  for (const [name, exp] of Object.entries(studioExports)) {
    if (infra.has(name)) continue;
    if (typeof exp !== 'function' && typeof exp !== 'string') continue;
    if (!routeForStudioFn(name)) {
      errors.push(`studio.mjs export ${name} is not mapped in CONTRACT_ROUTES`);
    }
  }

  for (const [cmd, alias] of Object.entries(STUDIO_COMMAND_ALIASES)) {
    if (alias.action && !studioActions[alias.action] && alias.action !== 'help') {
      errors.push(`STUDIO_COMMAND_ALIASES.${cmd} points to missing action ${alias.action}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
