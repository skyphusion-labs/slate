#!/usr/bin/env node
// scripts/studio-smoke.mjs
// Studio API parity smoke test: offline CONTRACT conformance + optional live probes.
//
// Usage:
//   npm run smoke:studio              # offline + live (needs slate.env or env vars)
//   npm run smoke:studio -- --offline-only
//   VIVIJURE_API_URL=... STUDIO_API_TOKEN=... node scripts/studio-smoke.mjs
//
// Live mode exercises read-only routes against your studio. Mutation routes are skipped
// unless --mutations is passed (still skips spend/GPU submits). Attachment routes are
// always skipped (Discord file upload only).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_ROUTES,
  STUDIO_API_ROUTE_COUNT,
  validateContractConformance,
} from '../contract.mjs';
import * as studio from '../studio.mjs';
import { STUDIO_ACTIONS, executeStudioAction } from '../studio-api.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ATTACHMENT_ROUTE_IDS = new Set([25, 38, 39, 68]);
const SPEND_ROUTE_IDS = new Set([
  23, 28, 30, 31, 41, 42, 43, 45, 47, 48, 49, 56, 57, 58, 59, 60, 61, 69,
]);

function loadSlateEnv() {
  const path = join(ROOT, 'slate.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function parseArgs(argv) {
  return {
    offlineOnly: argv.includes('--offline-only'),
    mutations: argv.includes('--mutations'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function studioCfg() {
  const headers = {};
  const token = process.env.STUDIO_API_TOKEN || '';
  if (token) headers.Authorization = `Bearer ${token}`;
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    headers['CF-Access-Client-Id'] = id;
    headers['CF-Access-Client-Secret'] = secret;
  }
  return {
    vivijureUrl: (process.env.VIVIJURE_API_URL || '').replace(/\/+$/, ''),
    headers,
  };
}

function emptyBrief() {
  return {
    title: 'Smoke Test',
    logline: '',
    cast: [],
    scenes: [{ id: 'shot_01', prompt: 'smoke test frame', target_seconds: 3 }],
    cast_bindings: {},
    render_settings: { quality_tier: 'draft' },
  };
}

function buildActionCtx(cfg) {
  let registryCache = null;
  return {
    cfg,
    brief: emptyBrief(),
    async fetchCastCatalog() {
      const res = await studio.listCast(cfg);
      return res.ok && Array.isArray(res.data?.cast) ? res.data.cast : [];
    },
    async fetchRegistry() {
      if (registryCache) return registryCache;
      const res = await studio.getModules(cfg);
      registryCache = res.ok ? res.data : null;
      return registryCache;
    },
    async getSubtitleModule() {
      const reg = await this.fetchRegistry();
      const names = reg?.hooks?.['film.finish'] || [];
      const mods = Object.fromEntries((reg?.modules || []).map((m) => [m.name, m]));
      return names.map((n) => mods[n]).find((m) => m?.config_schema?.burn_subtitles) || null;
    },
    emptyRenderSettings: () => ({}),
  };
}

function classifyHttp(res, { allow4xx = true } = {}) {
  if (!res || typeof res.status !== 'number') return { ok: false, detail: 'no response' };
  if (res.ok) return { ok: true, detail: `HTTP ${res.status}` };
  if (allow4xx && res.status >= 400 && res.status < 500) {
    return { ok: true, detail: `HTTP ${res.status} (route reachable)` };
  }
  const err = res.data?.error || res.raw || `HTTP ${res.status}`;
  return { ok: false, detail: String(err).slice(0, 200) };
}

function classifyUrl(url, { requireId = false, hasId = true } = {}) {
  if (requireId && !hasId) return { ok: true, skipped: true, detail: 'no id in studio (skip)' };
  if (typeof url === 'string' && url.startsWith('http')) return { ok: true, detail: 'url built' };
  return { ok: false, detail: 'bad url' };
}

async function fetchLiveHints(cfg) {
  const hints = {
    cfg,
    castId: null,
    projectId: null,
    renderId: null,
    moduleName: null,
    fakeJobId: '00000000-0000-4000-8000-000000000099',
  };
  const mods = await studio.getModules(cfg);
  if (mods.ok && mods.data?.modules?.[0]?.name) hints.moduleName = mods.data.modules[0].name;
  const cast = await studio.listCast(cfg);
  if (cast.ok && cast.data?.cast?.[0]?.id) hints.castId = cast.data.cast[0].id;
  const projects = await studio.listProjects(cfg);
  if (projects.ok && projects.data?.projects?.[0]?.id) hints.projectId = projects.data.projects[0].id;
  const renders = await studio.listRenders(cfg, { limit: 1 });
  if (renders.ok && renders.data?.renders?.[0]?.id) hints.renderId = renders.data.renders[0].id;
  return hints;
}

function probePlan(route, hints, opts) {
  const { cfg, castId, projectId, renderId, moduleName, fakeJobId } = hints;

  if (ATTACHMENT_ROUTE_IDS.has(route.id)) {
    return { mode: 'skip', reason: 'attachment-only (Discord upload)' };
  }

  if (route.id === 26) {
    return {
      mode: 'url',
      run: () => classifyUrl(studio.artifactUrl(cfg, 'smoke/nonexistent.png')),
    };
  }
  if (route.id === 67) {
    return {
      mode: 'url',
      run: () => classifyUrl(studio.exportCastUrl(cfg, castId || fakeJobId), { requireId: true, hasId: !!castId }),
    };
  }

  const isMutation = !route.method.startsWith('GET');
  if (isMutation && !opts.mutations) {
    return { mode: 'skip', reason: 'mutation (pass --mutations to probe)' };
  }
  if (isMutation && SPEND_ROUTE_IDS.has(route.id)) {
    return { mode: 'skip', reason: 'spend/GPU route (never auto-probed)' };
  }

  const live = {
    mode: 'live',
    run: null,
  };

  switch (route.id) {
    case 1: live.run = () => studio.getHealth(cfg); break;
    case 2: live.run = () => studio.getModules(cfg); break;
    case 3: live.run = () => studio.listVoices(cfg); break;
    case 4: live.run = () => studio.listProjects(cfg); break;
    case 5: live.run = () => studio.createProject(cfg, { name: `slate-smoke-${Date.now()}` }); break;
    case 6: live.run = () => studio.getProject(cfg, projectId || fakeJobId); break;
    case 7: live.run = () => studio.updateProject(cfg, projectId || fakeJobId, { name: 'smoke' }); break;
    case 8: live.run = () => studio.saveProjectStoryboard(cfg, projectId || fakeJobId, { shots: [] }); break;
    case 9: live.run = () => studio.deleteProject(cfg, fakeJobId); break;
    case 10: live.run = () => studio.listCast(cfg); break;
    case 11: live.run = () => studio.createCast(cfg, { name: `smoke-${Date.now()}`, bible: 'smoke' }); break;
    case 12: live.run = () => studio.getCast(cfg, castId || fakeJobId); break;
    case 13: live.run = () => studio.updateCast(cfg, castId || fakeJobId, {}); break;
    case 14: live.run = () => studio.deleteCast(cfg, fakeJobId); break;
    case 15: live.run = () => studio.setCastPortrait(cfg, castId || fakeJobId, { key: 'smoke/missing.png' }); break;
    case 16: live.run = () => studio.deleteCastPortrait(cfg, castId || fakeJobId); break;
    case 17: live.run = () => studio.addCastRef(cfg, castId || fakeJobId, { key: 'smoke/missing.png', mime: 'image/png' }); break;
    case 18: live.run = () => studio.deleteCastRef(cfg, castId || fakeJobId, { key: 'smoke/missing.png' }); break;
    case 19: live.run = () => studio.addCastSource(cfg, castId || fakeJobId, { key: 'smoke/missing.png', mime: 'image/png' }); break;
    case 20: live.run = () => studio.deleteCastSource(cfg, castId || fakeJobId, { key: 'smoke/missing.png' }); break;
    case 21: live.run = () => studio.generateCastRefs(cfg, castId || fakeJobId, {}); break;
    case 22: live.run = () => studio.pollCastRefsJob(cfg, castId || fakeJobId, fakeJobId); break;
    case 24: live.run = () => studio.getCastLoraStatus(cfg, castId || fakeJobId); break;
    case 27: live.run = () => studio.preflightStoryboard(cfg, { storyboard: { shots: [] } }); break;
    case 29: live.run = () => studio.refineStoryboard(cfg, { storyboard: { shots: [] }, message: 'smoke' }); break;
    case 32: live.run = () => studio.pollJob(cfg, fakeJobId, moduleName || 'score'); break;
    case 33: live.run = () => studio.enhanceStoryboard(cfg, { storyboard: { shots: [] } }); break;
    case 34: live.run = () => studio.getStoryboardModels(cfg); break;
    case 35: live.run = () => studio.storyboardYaml(cfg, { shots: [] }); break;
    case 36: live.run = () => studio.storyboardMarkers(cfg, { storyboard: { shots: [] }, format: 'premiere_csv' }); break;
    case 37: live.run = () => studio.bundleStoryboard(cfg, { storyboard: { shots: [] }, characterRefs: {} }); break;
    case 40: live.run = () => studio.analyzeAudio(cfg, { audioKey: 'smoke/missing.wav' }); break;
    case 44: live.run = () => studio.pollClips(cfg, fakeJobId); break;
    case 46: live.run = () => studio.pollFilm(cfg, fakeJobId); break;
    case 50: live.run = () => studio.pollStoryboardRender(cfg, fakeJobId); break;
    case 51: live.run = () => studio.cancelStoryboardRender(cfg, fakeJobId); break;
    case 52: live.run = () => studio.listRenders(cfg, { limit: 5 }); break;
    case 53: live.run = () => studio.listRenderTags(cfg); break;
    case 54: live.run = () => studio.patchRender(cfg, renderId || fakeJobId, { label: 'smoke' }); break;
    case 55: live.run = () => studio.deleteRender(cfg, fakeJobId); break;
    case 62: live.run = () => studio.getWhoami(cfg); break;
    case 63: live.run = () => studio.getPrefs(cfg); break;
    case 64: live.run = () => studio.patchPrefs(cfg, {}); break;
    case 65: live.run = () => studio.getModuleInstallConfig(cfg, moduleName || 'missing-module'); break;
    case 66: live.run = () => studio.patchModuleInstallConfig(cfg, moduleName || 'missing-module', {}); break;
    default:
      return { mode: 'skip', reason: 'no live probe defined' };
  }

  return live;
}

async function runOfflineChecks() {
  const lines = [];
  let ok = true;

  const conf = validateContractConformance(studio, STUDIO_ACTIONS);
  if (conf.ok) {
    lines.push(`[offline] CONTRACT conformance OK (${STUDIO_API_ROUTE_COUNT} routes)`);
  } else {
    ok = false;
    lines.push('[offline] CONTRACT conformance FAILED');
    for (const e of conf.errors) lines.push(`  - ${e}`);
  }

  for (const route of CONTRACT_ROUTES) {
    if (!route.commands.length && !route.actions.length) {
      ok = false;
      lines.push(`[offline] #${route.id} has no surface`);
    }
  }

  const actionKeys = Object.keys(STUDIO_ACTIONS).filter((k) => k !== 'help');
  lines.push(`[offline] STUDIO_ACTIONS: ${actionKeys.length} actions registered`);
  return { ok, lines };
}

async function runApiDispatcherSmoke(cfg) {
  const ctx = buildActionCtx(cfg);
  const readActions = [
    'health', 'modules', 'voices', 'whoami', 'prefs', 'models', 'cast-list', 'projects-list',
    'renders-list', 'renders-tags',
  ];
  const lines = [];
  let ok = true;
  for (const action of readActions) {
    const res = await executeStudioAction(action, '', ctx);
    if (res.ok) {
      lines.push(`[api] ${action} OK`);
    } else {
      ok = false;
      lines.push(`[api] ${action} FAIL: ${String(res.text).slice(0, 120)}`);
    }
  }
  return { ok, lines };
}

async function runLiveRouteProbes(cfg, opts) {
  const hints = await fetchLiveHints(cfg);
  const lines = [];
  let ok = true;
  let skipped = 0;
  let passed = 0;
  let failed = 0;

  for (const route of CONTRACT_ROUTES) {
    const plan = probePlan(route, hints, opts);
    const label = `#${route.id} ${route.method} ${route.path}`;

    if (plan.mode === 'skip') {
      skipped += 1;
      lines.push(`[skip] ${label} -- ${plan.reason}`);
      continue;
    }

    try {
      let result;
      if (plan.mode === 'url') {
        result = plan.run();
      } else {
        const res = await plan.run();
        result = classifyHttp(res);
      }

      if (result.skipped) {
        skipped += 1;
        lines.push(`[skip] ${label} -- ${result.detail}`);
      } else if (result.ok) {
        passed += 1;
        lines.push(`[pass] ${label} -- ${result.detail}`);
      } else {
        failed += 1;
        ok = false;
        lines.push(`[fail] ${label} -- ${result.detail}`);
      }
    } catch (e) {
      failed += 1;
      ok = false;
      lines.push(`[fail] ${label} -- ${e.message}`);
    }
  }

  lines.push(`[live] summary: ${passed} passed, ${skipped} skipped, ${failed} failed`);
  return { ok, lines };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Slate studio smoke test

  npm run smoke:studio                 offline + live probes
  npm run smoke:studio -- --offline-only
  npm run smoke:studio -- --mutations  also probe safe mutations (no GPU spend)

Requires VIVIJURE_API_URL + STUDIO_API_TOKEN for live mode (loads slate.env when present).
`);
    process.exit(0);
  }

  loadSlateEnv();
  const cfg = studioCfg();
  const allLines = [];
  let exitCode = 0;

  const offline = await runOfflineChecks();
  allLines.push(...offline.lines);
  if (!offline.ok) exitCode = 1;

  if (opts.offlineOnly) {
    console.log(allLines.join('\n'));
    process.exit(exitCode);
  }

  if (!cfg.vivijureUrl || !cfg.headers.Authorization) {
    allLines.push('[live] SKIP: set VIVIJURE_API_URL + STUDIO_API_TOKEN (or slate.env)');
    console.log(allLines.join('\n'));
    process.exit(exitCode);
  }

  allLines.push(`[live] probing ${cfg.vivijureUrl}`);

  const health = await studio.getHealth(cfg);
  const healthCheck = classifyHttp(health, { allow4xx: false });
  if (!healthCheck.ok) {
    allLines.push(`[live] ABORT: health check failed -- ${healthCheck.detail}`);
    console.log(allLines.join('\n'));
    process.exit(1);
  }
  allLines.push(`[live] health OK (${healthCheck.detail})`);

  const api = await runApiDispatcherSmoke(cfg);
  allLines.push(...api.lines);
  if (!api.ok) exitCode = 1;

  const live = await runLiveRouteProbes(cfg, opts);
  allLines.push(...live.lines);
  if (!live.ok) exitCode = 1;

  console.log(allLines.join('\n'));
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(`smoke fatal: ${e.message}`);
  process.exit(1);
});
