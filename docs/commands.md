# Slate commands reference

Slate exposes every Vivijure Studio capability from Discord. You do not need the web control
panel to plan, configure, cast, score, or render a film.

Two invocation styles:

| Style | Example | Notes |
|-------|---------|-------|
| Bang | `!brief` | Works in DMs, listen channels, and @mention replies |
| Slash | `/brief` | Registered globally on startup; may take up to an hour to appear after a new deploy |

Run **`!commands`** or **`/commands`** to see which commands are **live on your studio right now**.
Slate gates module-specific commands: if a hook has no installed module, the command explains what
is missing instead of failing at render time.

For env vars and Workers, see [configuration.md](configuration.md). For the Vivijure map, see
[constellation.md](constellation.md).

---

## How Slate talks to the Studio

Slate is a thin client of the Vivijure Studio API (`VIVIJURE_API_URL` + `STUDIO_API_TOKEN`). It
holds no render logic of its own.

```
Discord  -->  bot.mjs  -->  studio.mjs (HTTP client, 69 routes)
                         -->  contract.mjs (route matrix + CI gate)
                         -->  registry.mjs (GET /api/modules projection)
                         -->  studio-api.mjs (!api action dispatcher, 65 actions)
```

**Registry projection:** backend names, quality tiers, hook catalog, and module config knobs all
come from `GET /api/modules`. Slate never hardcodes a parallel list. When you install a new module
on the Studio, the matching commands light up automatically.

**Render settings** live on the channel's storyboard brief and round-trip through D1:

| Field | Set by | Sent on render as |
|-------|--------|-------------------|
| `quality_tier` | `!tier` | `keyframe_config.quality_tier` |
| `keyframe_backend` | `!keyframe` | `keyframe_backend` |
| `motion_backend` | `!backend` | `motion_backend` |
| `keyframes_only` | `!keyframes-only` | `keyframes_only` |
| `titles` / `credits` | `!titlecard` | `film_titles` |
| `subtitles` | `!subtitles` | `film_finish_config` (subtitle module enable field) |
| `module_overrides.config` | `!config` | per-module render configs |
| `cast_bindings` | `!bind` | `cast_loras` |
| `audio_key` | `!score` / `!audioupload` | `audio_key` |

---

## Module-gated commands

Commands below are only **usable** when the studio registry serves the required module(s). Use
`!hooks` to inspect the live catalog.

| Gate | Commands | Requires |
|------|----------|----------|
| `studio` | most commands | `VIVIJURE_API_URL` + `STUDIO_API_TOKEN` |
| `keyframe` | `!keyframe`, `!keyframes-only` | `keyframe` hook module installed |
| `backend` | `!backend` | `motion.backend` hook module installed |
| `subtitles` | `!subtitles on` | subtitle module in `film.finish` chain |
| `voices` | `!voices`, `!voice`, `!dialogue` | `dialogue` hook module installed |
| `cast-image` | `!castimage` | `cast.image` hook module installed |
| `score-music` | `!score music` | `score` module with `prompt` knob |
| `score-narration` | `!score narration` | `score` module with `text` knob |
| `autodirect` | `!autodirect` | `plan.enhance` module installed |
| `config` | `!config` | any module with per-render config knobs |
| `install-config` | `!install-config` | any module with `scope: install` fields |

Slash commands are always registered in Discord's picker; runtime checks block use with a clear
message when the gate fails. **`!commands`** is the accurate live list.

---

## Storyboard

| Command | Slash | Description |
|---------|-------|-------------|
| `!brief` | `/brief` | Show title, logline, cast, scenes, dialogue lines, and render settings |
| `!undo` | `/undo` | Roll back the last automatic brief extraction (max 10 in history) |
| `!reset` | `/reset` | Clear the project and start fresh |
| `!autodirect [low\|medium\|high]` | `/autodirect` | Run `plan.enhance` auto-direction on the current storyboard (gated) |

Slate maintains the brief silently while you chat. Each scene can carry a `dialogue` line (one
spoken line per shot) used for subtitles and TTS.

---

## Creative tools (portraits, thumbnails, knowledge)

| Command | Slash | Description |
|---------|-------|-------------|
| `!portrait <A\|B\|C\|D> [desc]` | `/portrait` | Generate a character portrait and sync to Vivijure Cast |
| `!thumbnail <scene-id>` | `/thumbnail` | Generate a scene thumbnail from the scene prompt + style |
| `!model [alias]` | `/model` | List or switch the active image model (FLUX, SDXL, GPT Image, etc.) |
| `!learn <text or URL>` | `/learn` | Index a film reference into the Vectorize knowledge base |

**Vision:** attach up to 3 images (4 MB each) when Claude is active; Slate reads them for the turn.

---

## Render settings

These mirror the Studio web render panel (`planner-render-config.js`). All options are projected
from `GET /api/modules`.

| Command | Slash | Description |
|---------|-------|-------------|
| `!tier [draft\|standard\|final]` | `/tier` | List or set quality tier (`render.quality_tiers`) |
| `!keyframe [name\|auto]` | `/keyframe` | Pick the `keyframe` module (gated) |
| `!backend [name\|auto]` | `/backend` | Pick the `motion.backend` i2v module (gated) |
| `!keyframes-only on\|off` | `/keyframesonly` | SDXL preview without motion leg (gated) |
| `!titlecard <title> [\| sub] [\|\| credits]` | `/titlecard` | Opening title card + end credits |
| `!subtitles on\|off` | `/subtitles` | Burn dialogue captions (`film.finish` subtitle module, gated) |
| `!config [module field value]` | `/config` | View or set per-render module knobs, grouped by hook |
| `!install-config [module field value]` | `/installconfig` | View or set operator install-scoped knobs |
| `!hooks` | `/hooks` | Live hook catalog, serving modules, and active picks |
| `!commands` / `!help` | `/commands` | Module-gated command list for this studio |

**`!backend auto`:** on full render, Slate resolves explicitly against the registry (cloud first,
then BYO/own-gpu, then local door) rather than omitting `motion_backend` and letting the studio
pick blindly.

**Chain hooks** (`finish`, `speech`, `master`, `film.finish`): the studio runs all serving modules
in `ui.order`. You tune knobs with `!config`; you cannot disable individual chain members from
Slate (same as the web control panel).

**Bang-only pick_one helpers:**

| Command | Hook | Description |
|---------|------|-------------|
| `!dialogue [name\|auto]` | `dialogue` | Pick dialogue/TTS module (gated) |
| `!castimage [name\|auto]` | `cast.image` | Pick cast image generation module (gated) |

---

## Submitting a render

| Command | Slash | Description |
|---------|-------|-------------|
| `!render` | `/render` | Pre-submit **huddle**: Slate reads back settings and waits for confirmation |
| `!render now` / `!ship` | `/render confirm:true` | Skip huddle and submit immediately |
| `!render draft` | `/render quality:draft` | Set tier and submit immediately |
| `!preflight` | `/preflight` | Validate storyboard before spending (studio preflight API) |

**Huddle flow:** Slate names the film, reads tier/keyframe/motion/subtitles/title settings, flags
heads-ups (missing portraits, prompt trims), and asks for `ship it`. In channels where Slate only
hears @mentions, say `ship it` with an @mention.

**On submit**, Slate:

1. Smart-trims scene prompts to the 50-word renderer cap (issue #16)
2. Auto-fills missing multi-character refs (issue #17)
3. Bundles the storyboard (`POST /api/storyboard/bundle`)
4. Runs preflight unless skipped
5. Submits `POST /api/render/film` with all render settings mapped from the brief
6. Polls job status every 30s and notifies the channel on completion

---

## Cast library and LoRA training

| Command | Slash | Description |
|---------|-------|-------------|
| `!cast` | `/cast` | List studio cast (trained LoRAs, voices, ref counts) |
| `!bind <slot> <name\|id>` | `/bind` | Bind storyboard slot A-D to an existing studio character |
| `!unbind <slot>` | `/unbind` | Clear a cast binding |
| `!voices` | `/voices` | List valid dialogue voice ids (gated) |
| `!voice <slot> <voice_id>` | `/voice` | Set a bound character's TTS voice (gated) |
| `!train <slot>` | `/train` | Start LoRA training for a bound character |
| `!lorastatus <slot>` | `/lorastatus` | Check LoRA training status |
| `!genrefs <slot>` | `/genrefs` | Generate training reference images for a bound character |

Bound characters send `cast_loras` on render so trained LoRAs carry through to motion.

---

## File uploads (attach to message)

| Command | Attachment | API route |
|---------|------------|-----------|
| `!importcast` | `.vvcast` tar | `POST /api/cast/import` |
| `!upload` | image | `POST /api/upload` (returns staged R2 key) |
| `!audioupload` | audio | `POST /api/storyboard/audio-upload` (sets `audio_key` on brief) |
| `!characterref <slot>` | image | `POST /api/storyboard/character-ref` (unbound slot ref) |
| `!addref <slot>` | image | upload + `POST /api/cast/:id/ref` (bound character training ref) |
| `!addsource <slot>` | image | upload + `POST /api/cast/:id/source` (bound character source photo) |

---

## Studio projects and history

| Command | Slash | Description |
|---------|-------|-------------|
| `!saveproject [name]` | `/saveproject` | Persist brief to studio project library |
| `!loadproject <id>` | `/loadproject` | Load a saved studio project into this channel |
| `!renders [n]` | `/renders` | Show recent render history from the studio (default 10) |

---

## Score beds

| Command | Slash | Description |
|---------|-------|-------------|
| `!score music <prompt>` | `/score kind:music` | Generate a music bed (gated) |
| `!score narration [text]` | `/score kind:narration` | Generate narration from text or storyboard (gated) |

Completed beds set `audio_key` on the brief and mux on the next full render.

---

## Universal API dispatcher

| Command | Slash | Description |
|---------|-------|-------------|
| `!api help` | `/api action:help` | List all 65 named API actions (tagged #1..#69) |
| `!api <action> [args]` | `/api` | Call any studio route |
| `!studio` | -- | Alias for `!api` |

Args format: `key:value` pairs or JSON. Examples:

```
!api health
!api cast-list
!api film-submit
!api render-poll jobId:abc123
!api module-config-get name:own-gpu
!api enhance
!api scatter shardCount:2
```

Brief-aware actions (`preflight`, `bundle`, `yaml`, `storyboard-render`, `film-submit`, etc.) use
the current channel storyboard automatically.

Full route list: 68 routes in Vivijure `docs/CONTRACT.md` section 2.1 plus control-panel supplements
(69 total; see [CONTRACT-conformance.md](CONTRACT-conformance.md)). Upload routes use the
attachment commands above; everything else is reachable via `!api` or the dedicated aliases in
[CONTRACT-conformance.md](CONTRACT-conformance.md).

Run **`!conformance`** to print the live matrix in Discord.

---

## Control panel parity commands

These bang aliases mirror the Vivijure web control panel without memorizing `!api` action names:

| Command | API route |
|---------|-----------|
| `!plan` | POST `/api/storyboard/plan` |
| `!refine <message>` | POST `/api/storyboard/refine` |
| `!bundle` | POST `/api/storyboard/bundle` |
| `!yaml` | POST `/api/storyboard/yaml` |
| `!markers [format:...]` | POST `/api/storyboard/markers` |
| `!chat` | POST `/api/chat` |
| `!projects` | GET `/api/storyboard/projects` |
| `!models` | GET `/api/storyboard/models` |
| `!scatter [shardCount:N]` | POST `/api/storyboard/render/scatter` |
| `!storyboard-render` | POST `/api/storyboard/render` |
| `!render-keyframes` | POST `/api/storyboard/render-from-keyframes` |
| `!regen <render-id> <shot-id>` | POST `.../regen-shot` |
| `!retry <render-id>` | POST `.../renders/:id/retry` |
| `!finalize`, `!animate-cloud`, `!animate-hybrid` | render library row actions |
| `!poll`, `!renderpoll`, `!filmpoll`, `!cancel` | job polling / cancel |
| `!exportcast <id>` | GET `/api/cast/export/:id` |
| `!delref`, `!delsource`, `!clearportrait` | cast ref/source/portrait delete |

---

## Quick workflow example

```
# Plan in conversation, then inspect
!brief

# Pick render path (only shows installed modules)
!tier draft
!backend own-gpu
!keyframe auto

# Optional finishing
!titlecard MY FILM || Director Name; Producer Name
!subtitles on

# Validate, then ship
!preflight
!render          # huddle -> "ship it"
!render now      # or skip huddle
```

For keyframes-only SDXL preview (no motion spend):

```
!keyframes-only on
!render now
!keyframes-only off
```
