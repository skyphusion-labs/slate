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

// Build the characterRefs map. Bound studio cast (cast_bindings) uses portrait + ref_keys from the
// catalog; session-created cast uses castId + portraitKey from Slate's own sync. Slots without a
// real ref are dropped so the bundle does not 400.
export function buildCharacterRefs(brief, castCatalog = []) {
  const catalogById = new Map((castCatalog || []).map((c) => [c.id, c]));
  const bindings = brief.cast_bindings || {};
  const characterRefs = {};

  for (const c of brief.cast || []) {
    const boundId = bindings[c.slot];
    if (boundId) {
      const member = catalogById.get(boundId);
      const ref = characterRefFromStudioMember(member, c.name);
      if (ref) characterRefs[c.slot] = ref;
      continue;
    }
    if (c.castId && c.portraitKey) {
      characterRefs[c.slot] = {
        name: c.name,
        portrait: { key: c.portraitKey },
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

// Pick the concrete motion.backend module name to send on an AUTO full-render submit (slate#58).
// The studio defaults an OMITTED motion_backend to serving[0] (its ui.order-first motion.backend
// module, locality-blind); with the local-consumer doors live that can be a bound-but-non-operational
// gpu-door (a local door whose ephemeral tunnel URL is not seeded server-side), so the keyframe phase
// burns and the film dies at assemble ("no clips rendered to assemble"). So Slate resolves auto here
// and always sends an explicit, serving name instead of relying on the studio default.
//
// `registry` is the GET /api/modules payload. Serving names come from hooks["motion.backend"], which
// the studio already sorts by ui.order then name, so the first match within a class is that class's
// order-first module. Each serving module is classified by its declared ui.locality (the same field
// the studio classifies on): "cloud" (or undeclared) = pay-per-render provider, "byo" = the operator's
// own GPU endpoint, "local" = a homelab door. Preference: a cloud module, then the operator's own GPU,
// then a local door (the door is chosen only when it is the sole thing serving, e.g. a pure self-host).
// Returns { value } with the chosen name, or { error } when nothing serves motion.backend (the caller
// fails the render loudly; it never falls back to omitting).
// LoRA status label for roster display.
export function loraStatusLabel(status) {
  switch (status) {
    case 'ready': return 'LoRA ready';
    case 'training': return 'training...';
    case 'failed': return 'LoRA failed';
    default: return 'no LoRA';
  }
}

// Resolve a cast member from the studio catalog by public id or case-insensitive name match.
export function resolveCastMember(catalog, query) {
  const q = (query ?? '').trim();
  if (!q || !Array.isArray(catalog)) return null;
  const byId = catalog.find((c) => c.id === q);
  if (byId) return byId;
  const lower = q.toLowerCase();
  return catalog.find((c) => (c.name ?? '').toLowerCase() === lower)
    || catalog.find((c) => (c.name ?? '').toLowerCase().includes(lower))
    || null;
}

// Build characterRefs entry from a persisted studio cast member (portrait + ref_keys).
export function characterRefFromStudioMember(member, fallbackName) {
  if (!member) return null;
  const trainingImages = [];
  if (member.portrait_key) trainingImages.push({ key: member.portrait_key });
  for (const rk of member.ref_keys || []) {
    // studio ref_keys are { key, mime } objects (or bare strings); pull out the R2 key string.
    // Pushing the whole object made trainingImages[i].key = [object Object] -> studio 400 (slate #88).
    const key = typeof rk === 'string' ? rk : (rk && rk.key);
    if (key && !trainingImages.some((t) => t.key === key)) trainingImages.push({ key });
  }
  if (!trainingImages.length) return null;
  const ref = {
    name: member.name || fallbackName,
    prompt: member.bible || '',
    trainingImages,
  };
  if (member.portrait_key) ref.portrait = { key: member.portrait_key };
  return ref;
}

// cast_bindings: { [slot]: castPublicId } -> cast_loras for POST /api/render/film.
export function buildCastLoras(castBindings) {
  const out = {};
  if (!castBindings || typeof castBindings !== 'object') return out;
  for (const [slot, id] of Object.entries(castBindings)) {
    if (typeof slot === 'string' && slot && typeof id === 'string' && id) out[slot] = id;
  }
  return out;
}

// Format the studio cast roster for Discord.
export function formatCastRoster(castList) {
  if (!Array.isArray(castList) || !castList.length) {
    return 'No characters in the studio cast library yet. Use `!portrait` to create one, or add them at the control panel.';
  }
  const lines = ['**Studio cast library** (`!bind <slot> <name>` to reuse)\n'];
  for (const c of castList) {
    const portrait = c.portrait_key ? 'portrait' : 'no portrait';
    const refs = (c.ref_keys || []).length;
    const lora = loraStatusLabel(c.lora_status);
    const voice = c.voice_id ? `voice: ${c.voice_id}` : 'default voice';
    lines.push(`  \`${c.id.slice(0, 8)}…\` **${c.name}** -- ${lora}, ${portrait}, ${refs} ref(s), ${voice}`);
  }
  return lines.join('\n');
}

// Format preflight issues for Discord.
export function formatPreflightResult(result) {
  if (!result) return 'Preflight returned nothing.';
  const counts = result.counts || {};
  const header = result.ok
    ? `Preflight **OK** (${counts.warning || 0} warning(s), ${counts.info || 0} note(s)).`
    : `Preflight **blocked** (${counts.error || 0} error(s), ${counts.warning || 0} warning(s)).`;
  const issues = Array.isArray(result.issues) ? result.issues : [];
  if (!issues.length) return header;
  const lines = [header, ''];
  for (const i of issues.slice(0, 12)) {
    const tag = i.level === 'error' ? '**ERROR**' : i.level === 'warning' ? 'warn' : 'info';
    lines.push(`  [${tag}] ${i.message}`);
  }
  if (issues.length > 12) lines.push(`  ... and ${issues.length - 12} more`);
  return lines.join('\n');
}

// Storyboard payload for bundle / preflight (mirrors bot submit shape).
export function buildStoryboardPayload(brief, characterRefs = {}) {
  const refSlots = new Set(Object.keys(characterRefs));
  const sceneSlots = (slots) => (slots ?? []).filter((slot) => refSlots.has(slot));
  return {
    title: brief.title ?? 'Untitled',
    full_prompt: brief.full_prompt ?? undefined,
    style_prefix: brief.style_prefix ? brief.style_prefix.slice(0, 256) : undefined,
    style_category: brief.style_category ?? 'None',
    duration_seconds: brief.duration_seconds ?? undefined,
    clip_seconds: brief.clip_seconds ?? undefined,
    use_characters: [...new Set(brief.scenes.flatMap((s) => sceneSlots(s.character_slots)))],
    scenes: (brief.scenes || []).map((s) => ({
      id: s.id,
      prompt: s.prompt ?? '',
      act: s.act ?? undefined,
      character_slots: sceneSlots(s.character_slots),
      target_seconds: s.target_seconds ?? undefined,
      dialogue: s.dialogue ?? undefined,
    })),
  };
}

// Group module_overrides.config by hook for /api/render/film body fields.
export function mapModuleOverridesToFilmConfigs(registry, rs, qualityTier) {
  const mods = Array.isArray(registry?.modules) ? registry.modules : [];
  const hooks = registry?.hooks || {};
  const cfg = rs?.module_overrides?.config || {};
  const byHook = (hook) => (hooks[hook] || [])
    .map((name) => mods.find((m) => m.name === name))
    .filter(Boolean);

  const pickOneConfig = (hook, choice) => {
    const serving = byHook(hook);
    const mod = (choice && serving.find((m) => m.name === choice)) || serving[0];
    if (!mod) return {};
    const c = { ...(cfg[mod.name] || {}) };
    if (hook === 'keyframe') c.quality_tier = qualityTier;
    if (hook === 'motion.backend' && mod.config_schema?.quality) c.quality = qualityTier;
    return { mod, config: c };
  };

  const chainConfig = (hook) => {
    const out = {};
    for (const mod of byHook(hook)) {
      const c = cfg[mod.name];
      if (c && typeof c === 'object' && Object.keys(c).length) out[mod.name] = { ...c };
    }
    return out;
  };

  const kf = pickOneConfig('keyframe', rs?.keyframe_backend);
  const motionChoice = rs?.motion_backend || rs?.module_overrides?.motion_backend;
  const motion = pickOneConfig('motion.backend', motionChoice);

  return {
    keyframe_backend: kf.mod?.name,
    keyframe_config: kf.mod ? kf.config : { quality_tier: qualityTier },
    motion_backend: motion.mod?.name,
    motion_config: motion.mod ? motion.config : {},
    finish_config: chainConfig('finish'),
    speech_config: chainConfig('speech'),
    film_finish_config: chainConfig('film.finish'),
    master_config: chainConfig('master'),
  };
}

// Merge film_finish subtitle toggle into mapped configs (registry-projected enable field).
export function applySubtitleToFilmFinish(filmFinishConfig, subMod, enabled) {
  if (!enabled || !subMod) return filmFinishConfig;
  const field = subtitleEnableField(subMod);
  return {
    ...filmFinishConfig,
    [subMod.name]: { ...(filmFinishConfig[subMod.name] || {}), [field]: true },
  };
}

export function pickAutoMotionBackend(registry) {
  const serving = registry?.hooks?.['motion.backend'];
  const names = Array.isArray(serving) ? serving.filter(Boolean) : [];
  if (!names.length) {
    return { error: 'the studio has no motion backend installed to render with' };
  }
  const mods = Array.isArray(registry?.modules) ? registry.modules : [];
  // Undeclared locality classifies as cloud, mirroring the studio's own default.
  const localityOf = (name) => {
    const m = mods.find((x) => x && x.name === name);
    return m?.ui?.locality ?? 'cloud';
  };
  const firstOfClass = (cls) => names.find((n) => localityOf(n) === cls);
  const chosen = firstOfClass('cloud') ?? firstOfClass('byo') ?? firstOfClass('local') ?? names[0];
  return { value: chosen };
}
