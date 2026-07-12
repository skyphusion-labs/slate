import { describe, it, expect } from 'vitest';
import {
  PROMPT_WORD_CAP,
  smartTrimPrompt,
  buildFilmTitles,
  parseCreditLines,
  subtitleEnableField,
  buildCharacterRefs,
  buildCastLoras,
  characterRefFromStudioMember,
  resolveCastMember,
  formatPreflightResult,
  matchBackend,
  pickAutoMotionBackend,
} from './lib.mjs';

// Real unit tests over the pure helpers extracted from bot.mjs. No Discord client, no network,
// no env: each asserts the exact transform contract these functions promise to the render path.

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('smartTrimPrompt', () => {
  it('leaves a prompt at or under the cap untouched', () => {
    const r = smartTrimPrompt(words(PROMPT_WORD_CAP));
    expect(r.trimmed).toBe(false);
    expect(r.text.split(' ').length).toBe(PROMPT_WORD_CAP);
  });

  it('normalizes whitespace and trims edges without flagging a trim', () => {
    expect(smartTrimPrompt('  a   b\tc  ')).toEqual({ text: 'a   b\tc', trimmed: false });
  });

  it('clamps to the cap and flags a trim when over', () => {
    const r = smartTrimPrompt(words(PROMPT_WORD_CAP + 20));
    expect(r.trimmed).toBe(true);
    expect(r.text.split(/\s+/).length).toBe(PROMPT_WORD_CAP);
  });

  it('keeps the leading sentence whole, then tops up from the rest', () => {
    const head = 'A hero runs fast.'; // 4 words, motion-critical clause
    const tail = words(PROMPT_WORD_CAP + 30);
    const r = smartTrimPrompt(`${head} ${tail}`);
    expect(r.trimmed).toBe(true);
    expect(r.text.startsWith('A hero runs fast.')).toBe(true);
    expect(r.text.split(/\s+/).length).toBe(PROMPT_WORD_CAP);
  });

  it('hard-slices when the leading sentence alone exceeds the cap', () => {
    const longSentence = words(PROMPT_WORD_CAP + 10) + '.';
    const r = smartTrimPrompt(longSentence + ' ' + words(5));
    expect(r.trimmed).toBe(true);
    expect(r.text.split(/\s+/).length).toBe(PROMPT_WORD_CAP);
    // Falls back to a plain head slice: first PROMPT_WORD_CAP tokens of the whole text.
    expect(r.text.startsWith('w0 w1 w2')).toBe(true);
  });

  it('treats null/undefined/empty as an empty untrimmed prompt', () => {
    expect(smartTrimPrompt(undefined)).toEqual({ text: '', trimmed: false });
    expect(smartTrimPrompt(null)).toEqual({ text: '', trimmed: false });
    expect(smartTrimPrompt('')).toEqual({ text: '', trimmed: false });
  });
});

describe('buildFilmTitles', () => {
  it('returns undefined for a null/empty render-settings', () => {
    expect(buildFilmTitles(null)).toBeUndefined();
    expect(buildFilmTitles(undefined)).toBeUndefined();
    expect(buildFilmTitles({})).toBeUndefined();
  });

  it('emits a title card from title text', () => {
    expect(buildFilmTitles({ titles: { text: '  The Reel  ' } })).toEqual({ title: { text: 'The Reel' } });
  });

  it('includes a subtitle only when the title text is present', () => {
    expect(buildFilmTitles({ titles: { text: 'The Reel', subtitle: '  A short  ' } }))
      .toEqual({ title: { text: 'The Reel', subtitle: 'A short' } });
    // Subtitle alone (no title text) is dropped -- the card requires text.
    expect(buildFilmTitles({ titles: { subtitle: 'orphan' } })).toBeUndefined();
  });

  it('strips blank credit lines and omits credits when all blank', () => {
    expect(buildFilmTitles({ credits: { lines: ['Dir: X', '  ', '', 'DP: Y'] } }))
      .toEqual({ credits: { lines: ['Dir: X', 'DP: Y'] } });
    expect(buildFilmTitles({ credits: { lines: ['  ', ''] } })).toBeUndefined();
  });

  it('combines title and credits', () => {
    expect(buildFilmTitles({ titles: { text: 'T' }, credits: { lines: ['a'] } }))
      .toEqual({ title: { text: 'T' }, credits: { lines: ['a'] } });
  });

  it('ignores a non-array credits.lines', () => {
    expect(buildFilmTitles({ credits: { lines: 'not-an-array' } })).toBeUndefined();
  });
});

describe('parseCreditLines', () => {
  it('splits on pipe, semicolon, and newline', () => {
    expect(parseCreditLines('a | b ; c\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('trims each line and drops blanks', () => {
    expect(parseCreditLines('  a  ||  ; \n b ')).toEqual(['a', 'b']);
  });

  it('returns an empty array for null/undefined/empty', () => {
    expect(parseCreditLines(null)).toEqual([]);
    expect(parseCreditLines(undefined)).toEqual([]);
    expect(parseCreditLines('')).toEqual([]);
  });
});

describe('subtitleEnableField', () => {
  it('prefers a bool key that looks like an enable switch', () => {
    const mod = { config_schema: { quality: { type: 'string' }, burn_in: { type: 'bool' } } };
    expect(subtitleEnableField(mod)).toBe('burn_in');
  });

  it('matches enable/on/subtitle/caption name shapes', () => {
    expect(subtitleEnableField({ config_schema: { on: { type: 'bool' } } })).toBe('on');
    expect(subtitleEnableField({ config_schema: { captions: { type: 'bool' } } })).toBe('captions');
  });

  it('falls back to the first bool field when none match the enable shape', () => {
    const mod = { config_schema: { alpha: { type: 'bool' }, beta: { type: 'bool' } } };
    expect(subtitleEnableField(mod)).toBe('alpha');
  });

  it('falls back to "enabled" when there are no bool fields or no schema', () => {
    expect(subtitleEnableField({ config_schema: { size: { type: 'string' } } })).toBe('enabled');
    expect(subtitleEnableField({})).toBe('enabled');
    expect(subtitleEnableField(null)).toBe('enabled');
  });
});

describe('buildCharacterRefs', () => {
  it('includes only cast with both a studio castId and an uploaded portraitKey (inline path)', () => {
    const brief = {
      cast: [
        { slot: 'A', name: 'Ada', castId: 'c1', portraitKey: 'k1' },
        { slot: 'B', name: 'Ben', castId: 'c2' },
        { slot: 'C', name: 'Cy', portraitKey: 'k3' },
      ],
    };
    expect(buildCharacterRefs(brief)).toEqual({
      A: { name: 'Ada', portrait: { key: 'k1' }, trainingImages: [{ key: 'k1' }] },
    });
  });

  it('builds refs from bound studio cast members (portrait + ref_keys)', () => {
    const brief = {
      cast_bindings: { A: 'cast-uuid' },
      cast: [{ slot: 'A', name: 'Wren', prompt: 'a pilot' }],
    };
    const catalog = [{
      id: 'cast-uuid',
      name: 'Wren',
      bible: 'brave pilot',
      portrait_key: 'p1',
      ref_keys: ['r1', 'r2'],
    }];
    expect(buildCharacterRefs(brief, catalog)).toEqual({
      A: {
        name: 'Wren',
        prompt: 'brave pilot',
        portrait: { key: 'p1' },
        trainingImages: [{ key: 'p1' }, { key: 'r1' }, { key: 'r2' }],
      },
    });
  });

  it('returns an empty map when no cast qualifies', () => {
    expect(buildCharacterRefs({ cast: [] })).toEqual({});
    expect(buildCharacterRefs({ cast: [{ slot: 'A', name: 'Ada' }] })).toEqual({});
  });
});

describe('buildCastLoras', () => {
  it('maps slot bindings to cast ids', () => {
    expect(buildCastLoras({ A: 'id-a', B: 'id-b' })).toEqual({ A: 'id-a', B: 'id-b' });
    expect(buildCastLoras({})).toEqual({});
  });
});

describe('resolveCastMember', () => {
  const catalog = [{ id: 'uuid-wren', name: 'Wren' }, { id: 'uuid-mara', name: 'Mara' }];
  it('matches by id or name', () => {
    expect(resolveCastMember(catalog, 'uuid-wren')).toEqual(catalog[0]);
    expect(resolveCastMember(catalog, 'wren')).toEqual(catalog[0]);
  });
});

describe('formatPreflightResult', () => {
  it('summarizes ok and blocked runs', () => {
    expect(formatPreflightResult({ ok: true, counts: { error: 0, warning: 1, info: 0 }, issues: [] }))
      .toContain('OK');
    expect(formatPreflightResult({
      ok: false,
      counts: { error: 1, warning: 0, info: 0 },
      issues: [{ level: 'error', message: 'LoRA not ready' }],
    })).toContain('blocked');
  });
});

describe('matchBackend', () => {
  const names = ['CogVideoX', 'LTX', 'Wan22'];

  it('maps auto/default/empty to a null value (omit on submit)', () => {
    expect(matchBackend(names, 'auto')).toEqual({ value: null });
    expect(matchBackend(names, 'default')).toEqual({ value: null });
    expect(matchBackend(names, '')).toEqual({ value: null });
    expect(matchBackend(names, '   ')).toEqual({ value: null });
    expect(matchBackend(names, undefined)).toEqual({ value: null });
  });

  it('matches a name case-insensitively (exact wins)', () => {
    expect(matchBackend(names, 'ltx')).toEqual({ value: 'LTX' });
    expect(matchBackend(names, 'CogVideoX')).toEqual({ value: 'CogVideoX' });
  });

  it('falls back to a substring match', () => {
    expect(matchBackend(names, 'cog')).toEqual({ value: 'CogVideoX' });
    expect(matchBackend(names, 'wan')).toEqual({ value: 'Wan22' });
  });

  it('returns an error with the valid options for an unknown backend', () => {
    const r = matchBackend(names, 'nope');
    expect(r.value).toBeUndefined();
    expect(r.error).toContain('Unknown backend `nope`');
    expect(r.error).toContain('auto, CogVideoX, LTX, Wan22');
  });

  it('reports "(none reported)" when the registry list is empty', () => {
    expect(matchBackend([], 'x').error).toContain('(none reported)');
    expect(matchBackend(undefined, 'x').error).toContain('(none reported)');
  });
});
describe('pickAutoMotionBackend', () => {
  // A GET /api/modules payload: `hooks['motion.backend']` is the serving list the studio already
  // sorts by ui.order then name; `modules[].ui.locality` classifies each (undeclared = cloud).
  const reg = (order, localities) => ({
    hooks: { 'motion.backend': order },
    modules: order.map((name) =>
      localities[name] === undefined ? { name } : { name, ui: { locality: localities[name] } },
    ),
  });

  it('prefers a cloud module over an order-first local gpu-door (the #58 bug)', () => {
    const r = pickAutoMotionBackend(reg(['local-gpu', 'alibaba-wan'], { 'local-gpu': 'local', 'alibaba-wan': 'cloud' }));
    expect(r).toEqual({ value: 'alibaba-wan' });
  });

  it('prefers the operator own-gpu (byo) over a local door when no cloud serves', () => {
    const r = pickAutoMotionBackend(reg(['local-gpu', 'own-gpu'], { 'local-gpu': 'local', 'own-gpu': 'byo' }));
    expect(r).toEqual({ value: 'own-gpu' });
  });

  it('prefers cloud over byo', () => {
    const r = pickAutoMotionBackend(reg(['own-gpu', 'alibaba-wan'], { 'own-gpu': 'byo', 'alibaba-wan': 'cloud' }));
    expect(r).toEqual({ value: 'alibaba-wan' });
  });

  it('within a class, respects the studio ui.order (first serving name wins)', () => {
    const r = pickAutoMotionBackend(reg(['alibaba-wan', 'google-veo'], { 'alibaba-wan': 'cloud', 'google-veo': 'cloud' }));
    expect(r).toEqual({ value: 'alibaba-wan' });
  });

  it('treats an undeclared locality as cloud', () => {
    const r = pickAutoMotionBackend(reg(['own-gpu', 'mystery'], { 'own-gpu': 'byo', 'mystery': undefined }));
    expect(r).toEqual({ value: 'mystery' });
  });

  it('sends a lone local door when it is the only thing serving (pure self-host)', () => {
    const r = pickAutoMotionBackend(reg(['local-gpu'], { 'local-gpu': 'local' }));
    expect(r).toEqual({ value: 'local-gpu' });
  });

  it('classifies as cloud when the modules array is absent', () => {
    const r = pickAutoMotionBackend({ hooks: { 'motion.backend': ['x'] } });
    expect(r).toEqual({ value: 'x' });
  });

  it('errors (never omits) when nothing serves motion.backend', () => {
    expect(pickAutoMotionBackend(reg([], {})).error).toContain('no motion backend');
    expect(pickAutoMotionBackend({}).error).toContain('no motion backend');
    expect(pickAutoMotionBackend({ hooks: {} }).error).toContain('no motion backend');
  });
});


describe('characterRefFromStudioMember (slate #88: ref_keys are {key,mime} objects)', () => {
  it('extracts the R2 key STRING from object ref_keys, never pushes [object Object]', () => {
    const ref = characterRefFromStudioMember({
      name: 'Wren', bible: 'a botanist', portrait_key: 'cast/4/portrait.jpg',
      ref_keys: [{ key: 'cast-gen/4/ref_01.jpg', mime: 'image/jpeg' }, { key: 'cast-gen/4/ref_02.jpg', mime: 'image/jpeg' }],
    }, 'A');
    const keys = ref.trainingImages.map((t) => t.key);
    expect(keys).toEqual(['cast/4/portrait.jpg', 'cast-gen/4/ref_01.jpg', 'cast-gen/4/ref_02.jpg']);
    expect(keys.every((k) => typeof k === 'string')).toBe(true);
    expect(JSON.stringify(ref)).not.toContain('[object Object]');
  });
  it('still accepts bare-string ref_keys (defensive)', () => {
    const ref = characterRefFromStudioMember({ name: 'X', ref_keys: ['cast-gen/9/ref_01.jpg'] }, 'A');
    expect(ref.trainingImages.map((t) => t.key)).toEqual(['cast-gen/9/ref_01.jpg']);
  });
});
