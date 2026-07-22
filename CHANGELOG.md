## v0.5.3

PATCH: fix Worker deploy typecheck (exclude `*.test.ts`) so the v0.5.2 security wave can ship to Cloudflare.

## v0.5.2

PATCH: security grind after the v0.5.1 sync bump.

- **fix(security):** SSRF harden on `/fetch` (DNS pin, redirect walk, CNAME recursion) (#121/#124)
- **fix(security):** capability secrets + sharp 0.35.3 overrides (#124)
- **fix(security):** prod compose uses pinned GHCR image (no root `npm ci` bind-mount) (#125)
- **fix(security):** split coverage so fork PRs run with read-only token (#126)
- **ci:** adversarial security audit workflow

## v0.5.1

Release sync bump (2026-07-21). No functional changes in this tag.

# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

## v0.5.0 (2026-07-21)

- **feat(memory): studio traffic ledger + session-memory RAG (#90).** Half of this epic (D1 session
  state -- brief, history, cast bindings) already shipped as infra; this lands the other half. Every
  `studio.mjs` call now flows through a request observer that (1) writes a complete request/response
  record to a new D1 `traffic_ledger` table -- method, path, status, truncated bodies, latency,
  Discord channel -- and (2) for mutating calls, embeds a summary into a new Vectorize index
  (`slate-memory`, bound in `search-worker`) for RAG. Chat turns and storyboard-brief snapshots are
  embedded into the same index on save / on `extractBrief`, so Slate accumulates a searchable memory
  of conversation, cast, and studio activity per channel without any manual step. A new
  `search_memory` tool lets Slate consult that memory mid-conversation instead of re-asking a group
  for something it already saw; `!memory <query>` / `/memory` expose the same search directly.
  `slate-memory` is a separate index from the manual `!learn` knowledge base (`slate-knowledge`) so
  per-channel session context never leaks across channels or pollutes the shared corpus.
  `channelContext` (`AsyncLocalStorage`, entered at the top of the Discord event handlers) attributes
  every ledger/memory write to the right channel without threading a channelId through the ~100
  `studio.mjs` call sites in `bot.mjs` / `studio-api.mjs`.
- **ci: tag-gated Worker deploy + image publish guard (#111, #112, #113).** Cloudflare Workers
  (`slate-search`, `slate-logs`) deploy only on a pushed `v*` tag (not every merge to `main`). The
  GHCR bot image workflow refuses to publish unless the tagged commit is on `origin/main`.
- **deps:** `@anthropic-ai/sdk` 0.112.x (#114); Cloudflare toolchain bumps in search-worker and
  log-worker (#115, #116).
- **docs(legal):** `PRIVACY-COMMITMENT.md` pointer stub (#110).

## v0.4.4 (2026-07-12)

- **fix(contract): stop sending scene.dialogue as a bare string; the studio requires an object.**
  `buildStoryboardPayload` put the brief spoken line on `scenes[].dialogue` as a plain string, but the
  studio storyboard validator (vivijure `storyboard-validate.ts`) accepts `dialogue` ONLY as
  `{ slot, text }`, and `assembleBundle` re-validates -- so EVERY dialogue-bearing render 400d at the
  bundle step (a silent user failure that route-level conformance never caught). The line is now
  attributed to the shot single speaking slot as `{ slot, text }` (so the studio voices it in that cast
  member voice, #582), or omitted when the speaker is ambiguous/absent (the line still ships via the
  top-level `dialogue_lines`, never a hard bundle failure). Field-level tests pin the on-the-wire shape
  so the regression fails CI. Found in the slate<->studio field-by-field contract audit.

## v0.4.3 (2026-07-12)

- **fix(chat): restore the pre-#86 conversational posture (#84).** The v0.3.0 control-panel API-parity
  work (#86) ballooned the assistant's SYSTEM_PROMPT command list from ~10 film-creation commands to
  25+, including "call any studio API route (/api help lists all 69)", a route-conformance matrix, and
  install-config knobs. That made the brain behave like a control-panel operator instead of a creative
  collaborator -- which is why it stopped proposing shot breakdowns (so the extractor got no shots ->
  scenes:0) and felt tool-like. The extractBrief prompt itself was UNCHANGED by #86; the regression was
  the tool-shaped posture. Trimmed the command block back to the lean, conversation-first set (portrait,
  cast/bind reuse, finishing touches, render, undo/reset), explicitly de-emphasized the control-panel
  surface ("never steer someone there; a tool-shaped Slate is just a worse control panel"), and kept the
  cast-awareness (v0.4.1) + shot-breakdown behaviour (v0.4.2). The power-user commands still work; they
  are just no longer the interface the brain leads with.

## v0.4.2 (2026-07-12)

- **fix(brief): the assistant now BUILDS the storyboard from a plain-English idea (#84).** `extractBrief`
  only recorded "explicitly discussed" fields, so a narrated story populated `full_prompt` but produced
  ZERO scenes -- and a film cannot render without scenes. A real user who narrated their film in plain
  English got nothing to render. The extract prompt now DECOMPOSES a narrated story into distinct visual
  shots (one scene per beat -- a change of action, location, or subject), each with a concrete visual
  prompt + character_slots. Proven on the real "Happy Chase" input: 0 scenes -> 4 (chase, discovery,
  cat, happy ending).
- **feat(chat): collaborator behaviour.** SYSTEM_PROMPT now nudges the brain to react like a creative
  partner -- propose the shot-by-shot breakdown in its own words and recognize a named studio-cast
  character warmly ("Wren's already in your cast, I'll use her") -- so the flow reads as building the
  film together, not operating a tool. Pairs with v0.4.1 cast-awareness.

## v0.4.1 (2026-07-12)

- **fix(chat): the assistant brain can now see the studio cast (#84).** `askLLM` injected only the
  static system prompt + chat history, so the brain was BLIND to the studio cast library and the
  current storyboard bindings. It confabulated ("I don't have a direct view into your saved cast
  library"), told users to run `!cast` (whose output it never ingests), and looped -- a real user
  could bind a trained character and still never get the brain to acknowledge it, so they never
  reached a render. Now the live cast roster (name + LoRA readiness + voice) and the current cast
  slots + bindings are injected into the brain every turn, so it reasons about reuse instead of
  denying it can see the cast.
- **SYSTEM_PROMPT:** the brain is told it CAN see the cast (provided every turn), must not tell users
  to run a command to "show" it, and the command list is now slash-first (the `!` prefix still works).
- **fix(copy): slash-first prompts** -- the bind-not-found and refs-missing replies now point at
  `/cast` / `/portrait` (was `!cast` / `!portrait`).

## v0.4.0 (2026-07-12)

- **Reuse trained studio cast by name (#84)** -- the natural flow (describe a character / `!portrait`
  / plan a storyboard) now AUTO-BINDS a cast slot to an existing studio character on an exact
  (case-insensitive) name match, so the render carries that character's trained LoRA (`cast_loras`)
  instead of minting a fresh generic member every session. Surfaced to the group (never silent);
  ambiguous same-name rows are shown for `/bind <slot> <id>`, never auto-picked. Closes the "builds
  from scratch / paste the description by hand" gap and stops duplicate-member proliferation. `/bind`
  stays as the explicit override, `/unbind` opts back out to a fresh character.
- **fix(render): keyframes-only reroute** -- a keyframes-only render now POSTs to
  `/api/storyboard/render` (which honors `keyframesOnly`; SDXL keyframes, no motion backend) instead
  of `/api/render/film` (no keyframes-only mode -> 400 at the motion gate). Same `cast_loras`
  resolution, same pollable `film-*` job.
- **fix(cast): unbindSlot** -- drop the dead post-delete branch; clear only the `bound` flag (keep
  `castId` so a session-created member stays reusable this brief).

## v0.3.0 (2026-07-12)

- **Full studio API parity** -- `studio.mjs` HTTP client for all 68 Vivijure CONTRACT routes;
  `studio-api.mjs` action registry; `!api` / `/api` universal dispatcher.
- **Cast workflows** -- `!cast`, `!bind`, `!unbind`, `!train`, `!lorastatus`, `!genrefs`, `!voices`,
  `!voice`; cast bindings send `cast_loras` on render; attachment uploads for import/refs/sources.
- **Registry projection** -- `registry.mjs` mirrors planner-registry.js; hook catalog, pick_one
  choosers, module config formatters, and command availability gates from `GET /api/modules`.
- **Module-gated commands** -- `!commands` / `/commands` lists only what installed modules support;
  gated commands (`!backend`, `!keyframe`, `!subtitles`, `!score`, `!voices`, `!autodirect`, ...)
  fail fast with a clear reason when the module is missing.
- **Render settings parity** -- `!tier`, `!keyframe`, `!keyframes-only`, `!config`,
  `!install-config`, `!hooks`; keyframes-only submits `keyframes_only` on film render.
- **Studio projects** -- `!saveproject`, `!loadproject`, `!renders`, `!preflight`.
- **Score + enhance** -- `!score music|narration`, `!autodirect` (plan.enhance).
- **CONTRACT conformance** -- `contract.mjs` maps 69 studio routes (68 CONTRACT + `render-retry`);
  `contract.test.ts` CI gate; `!conformance` / `/conformance`; control-panel bang aliases
  (`!plan`, `!refine`, `!scatter`, render-library ops, etc.); [docs/CONTRACT-conformance.md](docs/CONTRACT-conformance.md).
- **Documentation** -- canonical [docs/commands.md](docs/commands.md), [docs/CONTRACT-conformance.md](docs/CONTRACT-conformance.md);
  README, CLAUDE.md, configuration, constellation, CONTRIBUTING updated for v0.3.0 parity.
- **Smoke test** -- `npm run smoke:studio` (`scripts/studio-smoke.mjs`): offline CONTRACT gate plus live studio probes.

## v0.2.1

- **Explicit motion backend on full renders** (#58) -- Slate now always sends an explicit, serving
  `motion_backend` on a full render instead of omitting it on `auto` and letting the studio default
  to its `ui.order`-first `motion.backend` module (locality-blind). With the local-consumer doors
  live that default could be a bound-but-non-operational local gpu-door, so the film burned keyframes
  and died deep at assemble (`no clips rendered to assemble`). On `auto`, Slate resolves the choice
  against the live registry (`GET /api/modules`), preferring a cloud module, then the operator's own
  GPU, then a local door; a registry it cannot read, or one that serves no motion backend, fails the
  render loudly rather than silently omitting. Aligns the Slate caller with the vivijure #500
  submit-time preflight.

## v0.2.0


The assistant gains render range. Slate can now carry the group's full finishing choices to the
studio API, so the web control panel is not needed to render a film:

- **Render backend** (`!backend` / `/backend`) -- choose own GPU vs cloud i2v, or `auto` to let the
  studio decide (the default). Backend names are projected live from the studio registry
  (`GET /api/modules` `hooks["motion.backend"]`), never hardcoded.
- **Title + credit cards** (`!titlecard` / `/titlecard`) -- set an opening title (with optional
  subtitle) and end credits; mapped to the studio `film_titles` contract (matches vivijure PR #273).
- **Quality tier on the brief** -- the project's tier (draft-first) is the `!render` default; the
  tier is validated against the registry's projected `quality_tiers` at submit time, falling back to
  the registry default rather than inventing a tier the studio does not advertise.
- **Multi-character refs auto-fill** (issue #17) -- a `>1`-character film auto-derives any missing
  `characterRefs` before submit (generate + sync + upload the portrait), or blocks with a clear
  message naming who still needs a look, instead of letting the backend bounce the bundle.
- **Smart prompt trim** (issue #16) -- over-long scene prompts are trimmed to the 50-word renderer
  cap keeping the opening (motion-critical) clause, with a heads-up to the group instead of a silent
  truncate.
- **Subtitles + dialogue tracking** (`!subtitles` / `/subtitles`) -- the brief now tracks each shot's
  spoken dialogue line, sent on submit as the studio's per-shot `dialogue_lines`; the `film.finish`
  subtitle module times each caption to its shot. The toggle writes the subtitle module's real enable
  field (projected from `GET /api/modules`) and is honest about needing a module installed and
  dialogue to caption. (The studio's `/api/render/film` `dialogue_lines` forward is filed as
  vivijure#296; until it ships the lines ride along and captions activate once it lands.)
- **The pre-submit huddle** -- before a render goes out, Slate pulls the group in: she reads back the
  settings (backend, tier, subtitles, title/credits), flags heads-ups (a portrait she'll generate, a
  prompt she'll trim), and offers the next creative beat or a clean ship, in her own warm-collaborator
  voice (varying by context, never a fixed script). Confirm with `ship it` / `!render now` / `!ship`
  / `/render confirm:true`; an explicit quality skips the huddle. The submit path is now a single
  shared runner across the `!` and `/` surfaces.

Render settings (backend, tier, title/credit cards) live on the storyboard brief and round-trip
through D1. Slate runs no render logic of its own; it is a thin, registry-projecting client of the
studio API.

## v0.1.0

First public release of **Slate**, the collaborative screenwriter's assistant for the Vivijure AI
film platform. Slate began as a simple Discord-to-ollama relay and was redesigned and substantially
extended (by Claude, operating as *Strummer*) into a full platform assistant. This release is that
assistant, end to end:

- **Conversational film planning** -- Slate participates in a Discord channel as a creative
  collaborator and silently maintains a structured storyboard brief in the background.
- **Claude Sonnet via Cloudflare AI Gateway** (native Anthropic SDK path) with an **ollama
  fallback** when the gateway token is unset -- no vendor lock-in.
- **Autonomous tool use** (up to 5 rounds): `web_search` (Brave), `research` (Tavily),
  `fetch_page` (CF Browser Rendering), and `search_knowledge` (Vectorize).
- **Knowledge base** -- `!learn <text|URL>` embeds references into a Cloudflare Vectorize store
  (`bge-large-en-v1.5`, 1024-dim) that Claude searches automatically.
- **Vision input** -- up to 3 image attachments per message are base64-fed to Claude for the turn;
  degraded to a text placeholder in ollama mode.
- **Character portraits** (`!portrait`) generated via skyphusion-llm-public and synced to the
  Vivijure Cast; **scene thumbnails** (`!thumbnail`); **11 switchable image models** (`!model`).
- **Render submission** (`!render [draft|standard|final]`) with a `render_jobs` D1 table polled
  every 30s and channel notification on completion.
- **D1 cloud session state** -- brief, conversation history, `briefHistory` undo stack (max 10),
  and pending render jobs persist across restarts; `!undo` rolls back the last brief extraction.
- **Slash commands** -- every command is also a global Discord slash command.
- **`vivijure-search` Worker** -- the search/knowledge backend (`/search`, `/fetch`,
  `/knowledge/index`, `/knowledge/search`).
- Full documentation surface: `README`, `SECURITY`, `CONTRIBUTING`, AGPL-3.0 `LICENSE`, and CI.

### Known issues (tracked)

- `fetch_page` (Browser Rendering) has no URL allowlist -- an SSRF surface to harden (#2).
- Render submission still uses the legacy path; migration to the staged `/api/render/film`
  module-host pipeline is planned (#1).