// slate#211: `!api scatter` must not promise a split render or send shardCount.
//
// vivijure-cf CONTRACT 2.23 (vivijure-cf#720) retired film scatter. The studio accepts shardCount
// and ignores it, and a submit is always one film-* job. The old help text said
// "POST scatter render  args: shardCount:2" and the body defaulted shardCount to 2. An explicit
// shardCount from the caller is dropped too: the studio ignores it, so sending it only restates
// the retired split.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_ACTIONS } from './studio-api.mjs';

type Sent = { url: string; body: Record<string, unknown> };

function ctx() {
  return {
    cfg: { vivijureUrl: 'https://studio.example', headers: {} },
    brief: {
      scenes: [{ id: 'shot_01', prompt: 'a cat on a roof', target_seconds: 4 }],
      clip_seconds: 5,
      cast_bindings: { hero: 'cast-public-id' },
      render_settings: {
        quality_tier: 'standard',
        motion_backend: 'seedance',
        module_overrides: { config: {} },
        audio_key: null,
      },
    },
    emptyRenderSettings: () => ({}),
    fetchRegistry: async () => null,
    getSubtitleModule: async () => null,
    fetchCastCatalog: async () => [],
  };
}

function stubFetch(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
    const path = new URL(String(url)).pathname;
    if (path === '/api/storyboard/bundle') {
      return new Response(JSON.stringify({ bundleKey: 'bundles/b.tar.gz' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ jobId: 'film-1', film_id: 'film-1' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
  });
  return sent;
}

function scatterBody(sent: Sent[]) {
  const hit = sent.filter((s) => new URL(s.url).pathname === '/api/storyboard/render/scatter');
  expect(hit).toHaveLength(1);
  return hit[0].body;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('scatter is one film job (slate#211)', () => {
  it('help text does not promise a scatter split or a shardCount default', () => {
    const help = STUDIO_ACTIONS.scatter.help;
    expect(help.toLowerCase()).not.toContain('scatter');
    expect(help).not.toContain('shardCount');
    expect(help).toMatch(/one film/i);
  });

  it('sends no shardCount when the caller passes none', async () => {
    const sent = stubFetch();
    await STUDIO_ACTIONS.scatter.run(ctx(), {});
    const body = scatterBody(sent);
    expect(body).not.toHaveProperty('shardCount');
    expect(body.bundleKey).toBe('bundles/b.tar.gz');
    expect(body.shotIds).toEqual(['shot_01']);
    expect(body.qualityTier).toBe('standard');
  });

  it('drops an explicit shardCount instead of forwarding it', async () => {
    const sent = stubFetch();
    await STUDIO_ACTIONS.scatter.run(ctx(), { shardCount: '4' });
    expect(scatterBody(sent)).not.toHaveProperty('shardCount');
  });
});
