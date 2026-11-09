// slate#209: `!api film-submit` on a keyframes-only brief must go to the keyframes-only door.
//
// POST /api/render/film has no keyframes-only mode and never read `keyframes_only`, so this action used
// to start, and pay for, a full film. The studio now refuses a field a door does not read
// (vivijure-cf#896), so the same request would also fail. Both cases drive the real action with a
// stubbed fetch and read the request it actually sent.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_ACTIONS } from './studio-api.mjs';

type Sent = { url: string; body: Record<string, unknown> };

function ctx(keyframesOnly: boolean) {
  return {
    cfg: { vivijureUrl: 'https://studio.example', headers: {} },
    brief: {
      scenes: [{ id: 'shot_01', prompt: 'a cat on a roof', target_seconds: 4 }],
      clip_seconds: 5,
      cast_bindings: { hero: 'cast-public-id' },
      render_settings: {
        quality_tier: 'standard', motion_backend: 'seedance', keyframes_only: keyframesOnly,
        module_overrides: { config: {} }, subtitles: false, audio_key: null,
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
    return new Response(JSON.stringify({ jobId: 'film-1', film_id: 'film-1' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    });
  });
  return sent;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('film-submit and keyframes-only (slate#209)', () => {
  it('a keyframes-only brief goes to /api/storyboard/render with keyframesOnly, never to the film door', async () => {
    const sent = stubFetch();
    await STUDIO_ACTIONS['film-submit'].run(ctx(true), { bundleKey: 'bundles/b.tar.gz' });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0].url).pathname).toBe('/api/storyboard/render');
    expect(sent[0].body).toEqual({
      bundleKey: 'bundles/b.tar.gz',
      scenes: [{ shot_id: 'shot_01', prompt: 'a cat on a roof', seconds: 4 }],
      qualityTier: 'standard',
      castLoras: { hero: 'cast-public-id' },
      keyframesOnly: true,
    });
  });

  it('a full brief still goes to /api/render/film, and carries no keyframes_only field', async () => {
    const sent = stubFetch();
    await STUDIO_ACTIONS['film-submit'].run(ctx(false), { bundleKey: 'bundles/b.tar.gz' });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0].url).pathname).toBe('/api/render/film');
    expect(sent[0].body.bundle_key).toBe('bundles/b.tar.gz');
    expect(sent[0].body).not.toHaveProperty('keyframes_only');
  });
});
