// registry.mjs
// Projection of GET /api/modules for Slate -- mirrors vivijure/public/planner-registry.js and
// planner-render-config.js. Hook lists, pick_one choosers, and command availability are never
// hardcoded; they follow whatever modules are installed on the studio.

import { matchBackend } from './lib.mjs';
import { STUDIO_API_ROUTE_COUNT } from './contract.mjs';

export const PANEL_SKIP_HOOKS = new Set([
  'plan.enhance',
  'score',
  'dialogue',
  'cast.image',
  'notify',
]);

export const PANEL_ORDER = [
  'keyframe',
  'motion.backend',
  'speech',
  'finish',
  'master',
  'film.finish',
];

export const FALLBACK_TIERS = [
  { value: 'draft', label: 'draft', blurb: 'fastest, lowest quality' },
  { value: 'standard', label: 'standard', blurb: 'balanced' },
  { value: 'final', label: 'final', blurb: 'production quality' },
];

const PICK_ONE_HOOKS = new Set(['keyframe', 'motion.backend', 'dialogue', 'cast.image']);

/** Brief field storing the explicit pick_one choice per hook (null = registry default). */
export const PICK_ONE_BRIEF_FIELDS = {
  keyframe: 'keyframe_backend',
  'motion.backend': 'motion_backend',
  dialogue: 'dialogue_backend',
  'cast.image': 'cast_image_backend',
};

export function byName(registry) {
  return Object.fromEntries((registry?.modules || []).map((m) => [m.name, m]));
}

export function hookModules(registry, hook, filter) {
  if (!registry) return [];
  const order = registry.hooks?.[hook];
  const names = Array.isArray(order) ? order.filter(Boolean) : [];
  const named = byName(registry);
  const mods = names.map((n) => named[n]).filter(Boolean);
  return filter ? mods.filter(filter) : mods;
}

export function panelHooks(registry) {
  const catalog = Array.isArray(registry?.catalog) ? registry.catalog : [];
  const rank = (name) => {
    const i = PANEL_ORDER.indexOf(name);
    return i === -1 ? PANEL_ORDER.length : i;
  };
  return catalog
    .filter((h) => h?.name && !PANEL_SKIP_HOOKS.has(h.name))
    .map((h, i) => ({ hook: h.name, pickOne: h.cardinality === 'pick_one', blurb: h.blurb || '', _i: i }))
    .sort((a, b) => rank(a.hook) - rank(b.hook) || a._i - b._i)
    .map(({ hook, pickOne, blurb }) => ({ hook, pickOne, blurb }));
}

export function moduleLabel(mod) {
  if (!mod) return '';
  const l = mod.provides?.[0]?.label;
  return (l && String(l).trim()) || mod.name;
}

export function qualityTiers(registry) {
  const tiers = registry?.render?.quality_tiers;
  return Array.isArray(tiers) && tiers.length ? tiers : FALLBACK_TIERS;
}

export function defaultTier(registry) {
  return registry?.render?.default_tier ?? 'draft';
}

export function scoreMusicModules(registry) {
  return hookModules(registry, 'score', (m) => m.config_schema?.prompt);
}

export function scoreNarrationModules(registry) {
  return hookModules(registry, 'score', (m) => m.config_schema?.text);
}

export function planEnhanceInstalled(registry) {
  return hookModules(registry, 'plan.enhance').length > 0;
}

export function findSubtitleModule(registry) {
  const mods = Array.isArray(registry?.modules) ? registry.modules : [];
  const serving = registry?.hooks?.['film.finish'] || [];
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

export function pickOneChoice(rs, hook) {
  const field = PICK_ONE_BRIEF_FIELDS[hook];
  if (!field || !rs) return null;
  return rs[field] ?? null;
}

export function setPickOneChoice(rs, hook, value) {
  const field = PICK_ONE_BRIEF_FIELDS[hook];
  if (!field || !rs) return;
  rs[field] = value;
}

export function resolvePickOne(registry, hook, input) {
  const names = hookModules(registry, hook).map((m) => m.name);
  const v = (input ?? '').trim().toLowerCase();
  if (!v || v === 'auto' || v === 'default') return { value: null };
  return matchBackend(names, input);
}

export function renderScopeFields(mod) {
  const schema = mod?.config_schema || {};
  return Object.keys(schema).filter(
    (k) => schema[k]?.scope !== 'install' && k !== 'quality_tier' && k !== 'quality',
  );
}

export function installScopeFields(mod) {
  const schema = mod?.config_schema || {};
  return Object.keys(schema).filter((k) => schema[k]?.scope === 'install');
}

/** Which Slate commands are live for this registry snapshot. */
export function commandAvailability(registry, studioConfigured) {
  const kf = hookModules(registry, 'keyframe');
  const motion = hookModules(registry, 'motion.backend');
  const dialogue = hookModules(registry, 'dialogue');
  const castImage = hookModules(registry, 'cast.image');
  const scoreMusic = scoreMusicModules(registry);
  const scoreNarr = scoreNarrationModules(registry);
  const subMod = findSubtitleModule(registry);
  const panel = panelHooks(registry);
  const chainHooks = panel.filter((h) => !h.pickOne);

  return {
    studio: { ok: !!studioConfigured, reason: 'Studio not configured (VIVIJURE_API_URL + STUDIO_API_TOKEN).' },
    tier: { ok: !!studioConfigured, reason: 'Studio not configured.' },
    hooks: { ok: !!studioConfigured && !!registry, reason: 'Could not load the studio registry.' },
    keyframe: {
      ok: kf.length > 0,
      modules: kf.map((m) => m.name),
      reason: 'No `keyframe` module installed on the studio.',
    },
    backend: {
      ok: motion.length > 0,
      modules: motion.map((m) => m.name),
      reason: 'No `motion.backend` (i2v) module installed on the studio.',
    },
    'keyframes-only': {
      ok: kf.length > 0,
      modules: kf.map((m) => m.name),
      reason: 'No `keyframe` module installed (keyframes-only preview needs one).',
    },
    subtitles: {
      ok: !!subMod,
      module: subMod?.name,
      reason: 'No subtitle module in the `film.finish` chain.',
    },
    config: {
      ok: !!studioConfigured && panel.some((h) => hookModules(registry, h.hook).length > 0),
      reason: 'No render modules with configurable knobs installed.',
    },
    'install-config': {
      ok: !!studioConfigured && (registry?.modules || []).some((m) => installScopeFields(m).length > 0),
      reason: 'No modules with install-scoped config on the studio.',
    },
    'score-music': {
      ok: scoreMusic.length > 0,
      modules: scoreMusic.map((m) => m.name),
      reason: 'No `score` module with a music prompt knob installed.',
    },
    'score-narration': {
      ok: scoreNarr.length > 0,
      modules: scoreNarr.map((m) => m.name),
      reason: 'No `score` module with narration text installed.',
    },
    autodirect: {
      ok: planEnhanceInstalled(registry),
      modules: hookModules(registry, 'plan.enhance').map((m) => m.name),
      reason: 'No `plan.enhance` module installed.',
    },
    voices: {
      ok: !!studioConfigured && dialogue.length > 0,
      modules: dialogue.map((m) => m.name),
      reason: 'No `dialogue` (TTS) module installed.',
    },
    cast: { ok: !!studioConfigured, reason: 'Studio not configured.' },
    'cast-image': {
      ok: castImage.length > 0,
      modules: castImage.map((m) => m.name),
      reason: 'No `cast.image` module installed.',
    },
    api: { ok: !!studioConfigured, reason: 'Studio not configured.' },
    chain: { ok: chainHooks.some((h) => hookModules(registry, h.hook).length > 0) },
  };
}

export function gateMessage(gate) {
  return gate?.reason || 'That command is not available on this studio.';
}

export function formatPickOneList(hook, registry, rs, command) {
  const mods = hookModules(registry, hook);
  const current = pickOneChoice(rs, hook);
  const lines = [`**${hook}** (\`${command} <name|auto>\`)\n`];
  const autoActive = !current ? ' **<-- active**' : '';
  lines.push(`  \`auto\` -- registry default (first serving module)${autoActive}`);
  for (const m of mods) {
    const active = m.name === current ? ' **<-- active**' : '';
    lines.push(`  \`${m.name}\` -- ${moduleLabel(m)}${active}`);
  }
  return lines.join('\n');
}

export function formatTierList(registry, current) {
  const tiers = qualityTiers(registry);
  const lines = ['**Quality tier** (`!tier <name>` / `/tier`)\n'];
  for (const t of tiers) {
    const active = t.value === current ? ' **<-- active**' : '';
    const blurb = t.blurb ? ` (${t.blurb})` : '';
    lines.push(`  \`${t.value}\`${blurb}${active}`);
  }
  return lines.join('\n');
}

export function formatHooksStatus(registry, rs) {
  if (!registry) return 'Could not load the studio registry.';
  const catalog = Array.isArray(registry.catalog) ? registry.catalog : [];
  const lines = ['**Studio hook catalog** (live from `GET /api/modules`)\n'];
  for (const h of catalog) {
    const mods = hookModules(registry, h.name);
    const card = h.cardinality === 'pick_one' ? 'pick_one' : 'chain';
    if (!mods.length) {
      lines.push(`\n**${h.name}** (${card}) -- *(no modules installed)*`);
      continue;
    }
    lines.push(`\n**${h.name}** (${card})${h.blurb ? ` -- ${h.blurb}` : ''}`);
    if (PICK_ONE_HOOKS.has(h.name)) {
      const cur = pickOneChoice(rs, h.name) || mods[0]?.name || 'auto';
      lines.push(`  active: \`${cur}\``);
    }
    for (const m of mods) {
      const knobs = renderScopeFields(m);
      const knobHint = knobs.length ? ` [${knobs.length} knob(s)]` : '';
      lines.push(`  \`${m.name}\` -- ${moduleLabel(m)}${knobHint}`);
    }
  }
  lines.push('\nPick_one hooks: `!keyframe`, `!backend`, `!dialogue`, `!castimage`');
  lines.push('Chain knobs: `!config <module> <field> <value>`');
  lines.push('Install knobs: `!install-config`');
  return lines.join('\n');
}

export function formatModuleConfigByHook(registry, rs, moduleFilter) {
  if (!registry) return 'Could not load the studio module registry.';
  const cfg = rs?.module_overrides?.config || {};
  const hooks = panelHooks(registry);
  const lines = ['**Render module config** (`!config <module> <field> <value>`)\n'];

  for (const h of hooks) {
    const mods = hookModules(registry, h.hook);
    const visible = moduleFilter
      ? mods.filter((m) => m.name === moduleFilter || m.name.includes(moduleFilter))
      : mods;
    if (!visible.length) continue;
    lines.push(`\n### ${h.hook}${h.pickOne ? ' (pick_one)' : ' (chain)'}`);
    for (const mod of visible) {
      const keys = renderScopeFields(mod);
      if (!keys.length) {
        lines.push(`\n**${mod.name}** -- ${moduleLabel(mod)} (no per-render knobs)`);
        continue;
      }
      lines.push(`\n**${mod.name}** -- ${moduleLabel(mod)}`);
      for (const k of keys) {
        const cur = cfg[mod.name]?.[k];
        const def = mod.config_schema[k]?.default;
        const val = cur !== undefined ? cur : `(default: ${def})`;
        lines.push(`  \`${k}\` = ${val}`);
      }
    }
  }
  return lines.length > 1 ? lines.join('\n') : 'No configurable render modules installed.';
}

export function formatInstallConfig(registry, modFilter) {
  if (!registry) return 'Could not load the studio module registry.';
  const mods = Array.isArray(registry.modules) ? registry.modules : [];
  const lines = ['**Install config** (`!install-config <module> <field> <value>`)\n'];
  let any = false;
  for (const mod of mods) {
    if (modFilter && mod.name !== modFilter && !mod.name.includes(modFilter)) continue;
    const keys = installScopeFields(mod);
    if (!keys.length) continue;
    any = true;
    lines.push(`\n**${mod.name}** (${(mod.hooks || []).join(', ')})`);
    for (const k of keys) {
      const f = mod.config_schema[k];
      lines.push(`  \`${k}\` -- ${f?.label || k}`);
    }
  }
  return any ? lines.join('\n') : 'No install-scoped module config on this studio.';
}

/** Dynamic help: only commands whose gates pass. */
export function formatAvailableCommands(avail) {
  const lines = ['**Available commands** (module-gated; changes when the studio registry changes)\n'];
  const add = (cmd, desc, key) => {
    if (avail[key]?.ok !== false) lines.push(`  \`${cmd}\` -- ${desc}`);
  };

  lines.push('\n**Storyboard**');
  add('!brief', 'current storyboard + render settings', 'studio');
  add('!reset', 'clear project', 'studio');
  add('!undo', 'roll back last extraction', 'studio');
  add('!portrait', 'generate character portrait', 'studio');
  add('!thumbnail', 'scene thumbnail', 'studio');

  lines.push('\n**Render**');
  add('!tier', 'quality tier (draft/standard/final)', 'tier');
  add('!keyframe', 'pick keyframe module', 'keyframe');
  add('!backend', 'pick i2v / motion module', 'backend');
  add('!keyframes-only on|off', 'SDXL preview without motion', 'keyframes-only');
  add('!titlecard', 'opening title + credits', 'studio');
  add('!subtitles on|off', 'burn dialogue captions', 'subtitles');
  add('!config', 'per-render module knobs', 'config');
  add('!install-config', 'operator install knobs', 'install-config');
  add('!preflight', 'validate before render', 'studio');
  add('!render / !ship', 'submit to Vivijure', 'studio');

  lines.push('\n**Cast**');
  add('!cast / !bind / !train', 'studio cast library + LoRA', 'cast');
  add('!voices / !voice', 'dialogue TTS voices', 'voices');
  add('!castimage', 'pick cast.image module', 'cast-image');
  add('!importcast / !addref / !addsource', 'cast uploads', 'cast');

  lines.push('\n**Score & enhance**');
  add('!score music', 'music bed', 'score-music');
  add('!score narration', 'narration bed', 'score-narration');
  add('!autodirect', 'plan.enhance auto-direction', 'autodirect');

  lines.push('\n**Studio API**');
  add('!api help', `full API surface (${STUDIO_API_ROUTE_COUNT} routes)`, 'api');
  add('!conformance', 'route-to-command conformance matrix', 'api');
  add('!hooks', 'hook catalog + active picks', 'hooks');
  add('!commands', 'this list', 'studio');

  return lines.join('\n');
}
