// lib.mjs
// Slate -- pure, side-effect-free helpers extracted from bot.mjs so they can be unit-tested
// directly (no Discord client, no network, no process env). Every function here is a pure
// transform: same input -> same output, no I/O. bot.mjs imports these; the async wrappers that
// need the live registry (e.g. resolveBackend) stay in bot.mjs and call into matchBackend here.
//
// Behaviour is byte-for-byte the same as the original in-bot definitions; this file only moves
// them out. Keep it dependency-free.

// Smart prompt clamp (issue #16). The pod's bg-pass feeds scene prompts to SDXL verbatim and the
// API caps a scene prompt at 50 words (CLIP truncates at 77 tokens after triggers + style_prefix),
// so an over-length prompt bounces the submit. Rather than a blind tail-truncate, keep the FIRST
// sentence (usually the motion-critical clause -- subject + action) and fill the remaining word
// budget from what follows, so the trim preserves the beat that drives the shot. Returns the
// trimmed text plus a flag so the caller can give the group a heads-up instead of silently
// dropping words.
export const PROMPT_WORD_CAP = 50;
export function smartTrimPrompt(text) {
  const raw = (text ?? '').trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length <= PROMPT_WORD_CAP) return { text: raw, trimmed: false };

  // First sentence = the motion-critical clause we never want to lose.
  const firstSentence = (raw.match(/^[^.!?]*[.!?]/)?.[0] ?? '').trim();
  const headWords = firstSentence ? firstSentence.split(/\s+/).filter(Boolean) : [];
  let kept;
  if (headWords.length && headWords.length <= PROMPT_WORD_CAP) {
    // Keep the opening clause whole, then top up from the rest until the cap.
    const rest = words.slice(headWords.length);
    kept = headWords.concat(rest.slice(0, PROMPT_WORD_CAP - headWords.length));
  } else {
    // No usable leading sentence (or it alone exceeds the cap): fall back to a hard head slice.
    kept = words.slice(0, PROMPT_WORD_CAP);
  }
  return { text: kept.join(' '), trimmed: true };
}

// Shape film_titles for the API exactly as the studio planner does (vivijure PR #273): a subtitle
// alone is dropped (the title card requires text), blank credit lines are stripped, and the whole
// field is omitted when empty so the submit body never widens needlessly. Single source of the
// title/credit contract so a film carded in Slate and one carded in the planner come out identical.
export function buildFilmTitles(rs) {
  if (!rs) return undefined;
  const out = {};
  const titleText = (rs.titles?.text ?? '').trim();
  if (titleText) {
    out.title = { text: titleText };
    const sub = (rs.titles?.subtitle ?? '').trim();
    if (sub) out.title.subtitle = sub;
  }
  const lines = Array.isArray(rs.credits?.lines)
    ? rs.credits.lines.map((l) => (l ?? '').trim()).filter(Boolean)
    : [];
  if (lines.length) out.credits = { lines };
  return (out.title || out.credits) ? out : undefined;
}

// Parse credit lines from a single string: split on | or ; or newlines, trim, drop blanks.
export function parseCreditLines(raw) {
  return (raw ?? '').split(/[|;\n]/).map(s => s.trim()).filter(Boolean);
}

// The boolean "enable" field key in a subtitle module's config_schema. Modules name it differently
// (enabled / enable / burn / on); pick the first bool field whose key looks like an enable switch,
// else the first bool field, else "enabled" as a last resort. Projection over assumption.
export function subtitleEnableField(mod) {
  const schema = (mod && mod.config_schema) || {};
  const bools = Object.keys(schema).filter((k) => schema[k] && schema[k].type === 'bool');
  return bools.find((k) => /enabl|^on$|burn|subtitle|caption/i.test(k)) || bools[0] || 'enabled';
}

// Build the characterRefs map from synced cast (member with a studio cast id + uploaded portrait
// key). Slots without a real ref are dropped from use_characters / scene slots so the bundle does
// not 400 on a slot with no ref. Issue #17's auto-fill (generating missing portraits) runs BEFORE
// submit in ensureCharacterRefs; by the time we get here the cast that can have refs, does.
export function buildCharacterRefs(brief) {
  const characterRefs = {};
  for (const c of brief.cast) {
    if (c.castId && c.portraitKey) {
      characterRefs[c.slot] = {
        name:           c.name,
        portrait:       { key: c.portraitKey },
        trainingImages: [{ key: c.portraitKey }],
      };
    }
  }
  return characterRefs;
}

// Pure core of resolveBackend: match a user backend choice against a known list of registry names.
// 'auto'/'default'/'' -> { value: null } (omit on submit). Exact case-insensitive match wins, else
// the first substring match. An unknown name returns { error } with the valid options so the handler
// can show them. resolveBackend in bot.mjs fetches the live names then delegates here.
export function matchBackend(names, input) {
  const v = (input ?? '').trim().toLowerCase();
  if (!v || v === 'auto' || v === 'default') return { value: null };
  const list = Array.isArray(names) ? names : [];
  const found = list.find(n => n.toLowerCase() === v) || list.find(n => n.toLowerCase().includes(v));
  if (!found) return { error: `Unknown backend \`${input}\`. Options: auto, ${list.join(', ') || '(none reported)'}.` };
  return { value: found };
}
