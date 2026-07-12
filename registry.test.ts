import { describe, it, expect } from 'vitest';
import {
  hookModules,
  panelHooks,
  commandAvailability,
  resolvePickOne,
  formatTierList,
  planEnhanceInstalled,
  findSubtitleModule,
  scoreMusicModules,
} from './registry.mjs';

const registry = {
  catalog: [
    { name: 'keyframe', cardinality: 'pick_one', blurb: 'keyframes' },
    { name: 'motion.backend', cardinality: 'pick_one', blurb: 'i2v' },
    { name: 'finish', cardinality: 'chain', blurb: 'finish' },
    { name: 'score', cardinality: 'chain' },
    { name: 'dialogue', cardinality: 'pick_one' },
    { name: 'plan.enhance', cardinality: 'chain' },
    { name: 'cast.image', cardinality: 'pick_one' },
    { name: 'notify', cardinality: 'chain' },
    { name: 'film.finish', cardinality: 'chain' },
  ],
  hooks: {
    keyframe: ['keyframe-mod'],
    'motion.backend': ['own-gpu', 'kling'],
    finish: ['finish-rife'],
    score: ['score-music'],
    dialogue: ['aura-dialogue'],
    'plan.enhance': ['shot-director'],
    'cast.image': ['cast-sdxl'],
    'film.finish': ['film-titles', 'subtitles-burn'],
  },
  modules: [
    { name: 'keyframe-mod', hooks: ['keyframe'], config_schema: { steps: { type: 'int', scope: 'render' } } },
    { name: 'own-gpu', hooks: ['motion.backend'], ui: { locality: 'byo' } },
    { name: 'kling', hooks: ['motion.backend'], ui: { locality: 'cloud' }, config_schema: { quality: { type: 'enum', values: ['draft'], scope: 'render' } } },
    { name: 'finish-rife', hooks: ['finish'] },
    { name: 'score-music', hooks: ['score'], config_schema: { prompt: { type: 'string', scope: 'render' } } },
    { name: 'aura-dialogue', hooks: ['dialogue'] },
    { name: 'shot-director', hooks: ['plan.enhance'] },
    { name: 'cast-sdxl', hooks: ['cast.image'] },
    { name: 'film-titles', hooks: ['film.finish'] },
    { name: 'subtitles-burn', hooks: ['film.finish'], config_schema: { burn_subtitles: { type: 'bool', scope: 'render' } } },
    { name: 'notify-email', hooks: ['notify'], config_schema: { notify_email: { type: 'string', scope: 'install' } } },
  ],
  render: {
    quality_tiers: [{ value: 'draft', label: 'draft' }, { value: 'final', label: 'final' }],
    default_tier: 'draft',
  },
};

describe('hookModules', () => {
  it('returns modules in registry hook order', () => {
    expect(hookModules(registry, 'motion.backend').map((m) => m.name)).toEqual(['own-gpu', 'kling']);
  });
});

describe('panelHooks', () => {
  it('skips bespoke-surface hooks like score and plan.enhance', () => {
    const names = panelHooks(registry).map((h) => h.hook);
    expect(names).toContain('keyframe');
    expect(names).toContain('motion.backend');
    expect(names).not.toContain('score');
    expect(names).not.toContain('plan.enhance');
    expect(names).not.toContain('dialogue');
  });
});

describe('commandAvailability', () => {
  it('gates backend on motion.backend modules', () => {
    const a = commandAvailability(registry, true);
    expect(a.backend.ok).toBe(true);
    expect(a.backend.modules).toEqual(['own-gpu', 'kling']);
  });

  it('blocks score-music when no score module with prompt', () => {
    const empty = commandAvailability({ modules: [], hooks: {}, catalog: [] }, true);
    expect(empty['score-music'].ok).toBe(false);
    expect(scoreMusicModules(registry).length).toBe(1);
  });

  it('enables autodirect when plan.enhance is installed', () => {
    expect(planEnhanceInstalled(registry)).toBe(true);
    expect(commandAvailability(registry, true).autodirect.ok).toBe(true);
  });

  it('finds subtitle module in film.finish chain', () => {
    expect(findSubtitleModule(registry)?.name).toBe('subtitles-burn');
  });
});

describe('resolvePickOne', () => {
  it('resolves auto to null', () => {
    expect(resolvePickOne(registry, 'motion.backend', 'auto')).toEqual({ value: null });
  });

  it('errors on unknown backend', () => {
    expect(resolvePickOne(registry, 'motion.backend', 'nope').error).toContain('Unknown backend');
  });
});

describe('formatTierList', () => {
  it('marks the active tier', () => {
    expect(formatTierList(registry, 'draft')).toContain('**<-- active**');
  });
});
