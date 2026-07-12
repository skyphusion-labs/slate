# CONTRACT conformance matrix

Slate maintains **zero drift** against the Vivijure Studio HTTP contract
(`vivijure/docs/CONTRACT.md` section 2.1, 68 routes, plus control-panel supplements). The machine-readable source of truth is
`contract.mjs`; CI enforces it via `contract.test.ts`.

## Surfaces

Every route is reachable through one or more of:

| Surface | Example |
|---------|---------|
| **Bang command** | `!preflight`, `!plan`, `!scatter` |
| **Slash command** | `/render`, `/cast`, `/api` |
| **Attachment command** | `!upload`, `!importcast` |
| **Universal dispatcher** | `!api <action>` (every non-upload route) |

Run **`!conformance`** or **`/conformance`** in Discord for the live matrix.

## Full route map

| # | Method | Path | studio.mjs | !api action | Primary commands |
|---|--------|------|------------|-------------|------------------|
| 1 | GET | `/health` | `getHealth` | `health` | `!health`, `!api health` |
| 2 | GET | `/api/modules` | `getModules` | `modules` | `!hooks`, `!api modules` |
| 3 | GET | `/api/voices` | `listVoices` | `voices` | `!voices` |
| 4 | GET | `/api/storyboard/projects` | `listProjects` | `projects-list` | `!projects` |
| 5 | POST | `/api/storyboard/projects` | `createProject` | `project-create` | `!saveproject` (create) |
| 6 | GET | `/api/storyboard/projects/:id` | `getProject` | `project-get` | `!loadproject` |
| 7 | PATCH | `/api/storyboard/projects/:id` | `updateProject` | `project-patch` | `!patchproject` |
| 8 | POST | `.../storyboard` | `saveProjectStoryboard` | `project-save-storyboard` | `!saveproject` (update) |
| 9 | DELETE | `/api/storyboard/projects/:id` | `deleteProject` | `project-delete` | `!deleteproject` |
| 10 | GET | `/api/cast` | `listCast` | `cast-list` | `!cast` |
| 11 | POST | `/api/cast` | `createCast` | `cast-create` | `!castcreate` |
| 12 | GET | `/api/cast/:id` | `getCast` | `cast-get` | `!castget` |
| 13 | PATCH | `/api/cast/:id` | `updateCast` | `cast-update` | `!voice` |
| 14 | DELETE | `/api/cast/:id` | `deleteCast` | `cast-delete` | `!castdelete` |
| 15 | POST | `.../portrait` | `setCastPortrait` | `cast-portrait-set` | `!portrait` (sync) |
| 16 | DELETE | `.../portrait` | `deleteCastPortrait` | `cast-portrait-clear` | `!clearportrait` |
| 17 | POST | `.../ref` | `addCastRef` | `cast-ref-add` | `!addref` |
| 18 | DELETE | `.../ref` | `deleteCastRef` | `cast-ref-del` | `!delref` |
| 19 | POST | `.../source` | `addCastSource` | `cast-source-add` | `!addsource` |
| 20 | DELETE | `.../source` | `deleteCastSource` | `cast-source-del` | `!delsource` |
| 21 | POST | `.../generate-refs` | `generateCastRefs` | `cast-generate-refs` | `!genrefs` |
| 22 | GET | `.../refs-job/:jobId` | `pollCastRefsJob` | `cast-refs-poll` | `!genrefs` (polls) |
| 23 | POST | `.../train-lora` | `trainCastLora` | `cast-train-lora` | `!train` |
| 24 | GET | `.../lora-status` | `getCastLoraStatus` | `cast-lora-status` | `!lorastatus` |
| 25 | POST | `/api/upload` | `uploadImage` | *(attachment)* | `!upload` |
| 26 | GET | `/api/artifact/*key` | `artifactUrl` | `artifact-url` | `!api artifact-url` |
| 27 | POST | `/api/storyboard/preflight` | `preflightStoryboard` | `preflight` | `!preflight` |
| 28 | POST | `/api/storyboard/plan` | `planStoryboard` | `plan` | `!plan` |
| 29 | POST | `/api/storyboard/refine` | `refineStoryboard` | `refine` | `!refine` |
| 30 | POST | `/api/chat` | `studioChat` | `chat` | `!chat` |
| 31 | POST | `/api/storyboard/score-bed` | `startScoreBed` | `score-bed` | `!score` |
| 32 | GET | `/api/job/:id` | `pollJob` | `job-poll` | `!poll`, `!score` (polls) |
| 33 | POST | `/api/storyboard/enhance` | `enhanceStoryboard` | `enhance` | `!autodirect` |
| 34 | GET | `/api/storyboard/models` | `getStoryboardModels` | `models` | `!models` |
| 35 | POST | `/api/storyboard/yaml` | `storyboardYaml` | `yaml` | `!yaml` |
| 36 | POST | `/api/storyboard/markers` | `storyboardMarkers` | `markers` | `!markers` |
| 37 | POST | `/api/storyboard/bundle` | `bundleStoryboard` | `bundle` | `!bundle`, `!render` |
| 38 | POST | `/api/storyboard/audio-upload` | `uploadAudio` | *(attachment)* | `!audioupload` |
| 39 | POST | `/api/storyboard/character-ref` | `uploadCharacterRef` | *(attachment)* | `!characterref` |
| 40 | POST | `/api/audio/analyze` | `analyzeAudio` | `audio-analyze` | `!analyze` |
| 41 | POST | `/api/storyboard/render` | `submitStoryboardRender` | `storyboard-render` | `!storyboard-render` |
| 42 | POST | `/api/storyboard/render-plan` | `submitRenderPlan` | `render-plan` | `!render-plan` |
| 43 | POST | `/api/render/clips` | `submitClips` | `clips-submit` | `!clips` |
| 44 | GET | `/api/render/clips/:id` | `pollClips` | `clips-poll` | `!clipspoll` |
| 45 | POST | `/api/render/film` | `submitFilm` | `film-submit` | `!render`, `!ship` |
| 46 | GET | `/api/render/film/:id` | `pollFilm` | `film-poll` | `!filmpoll`, `!render` (polls) |
| 47 | POST | `.../regen-shot` | `regenShot` | `render-regen-shot` | `!regen` |
| 48 | POST | `/api/storyboard/render/scatter` | `submitScatterRender` | `scatter` | `!scatter` |
| 49 | POST | `/api/storyboard/render-from-keyframes` | `submitRenderFromKeyframes` | `render-from-keyframes` | `!render-keyframes` |
| 50 | GET | `/api/storyboard/render/:jobId` | `pollStoryboardRender` | `render-poll` | `!renderpoll` |
| 51 | DELETE | `/api/storyboard/render/:jobId` | `cancelStoryboardRender` | `render-cancel` | `!cancel` |
| 52 | GET | `/api/storyboard/renders` | `listRenders` | `renders-list` | `!renders` |
| 53 | GET | `/api/storyboard/renders/tags` | `listRenderTags` | `renders-tags` | `!rendertags` |
| 54 | PATCH | `/api/storyboard/renders/:id` | `patchRender` | `render-patch` | `!patch-render` |
| 55 | DELETE | `/api/storyboard/renders/:id` | `deleteRender` | `render-delete` | `!delete-render` |
| 56 | POST | `.../add-audio` | `addRenderAudio` | `render-add-audio` | `!add-audio` |
| 57 | POST | `.../add-narration` | `addRenderNarration` | `render-add-narration` | `!add-narration` |
| 58 | POST | `.../finalize` | `finalizeRender` | `render-finalize` | `!finalize` |
| 59 | POST | `.../animate-cloud` | `animateRenderCloud` | `render-animate-cloud` | `!animate-cloud` |
| 60 | POST | `.../animate-hybrid` | `animateRenderHybrid` | `render-animate-hybrid` | `!animate-hybrid` |
| 61 | POST | `/api/storyboard/renders/adopt` | `adoptRender` | `render-adopt` | `!adopt` |
| 62 | GET | `/api/whoami` | `getWhoami` | `whoami` | `!whoami` |
| 63 | GET | `/api/prefs` | `getPrefs` | `prefs` | `!prefs` |
| 64 | PATCH | `/api/prefs` | `patchPrefs` | `prefs-patch` | `!api prefs-patch` |
| 65 | GET | `/api/modules/:name/config` | `getModuleInstallConfig` | `module-config-get` | `!install-config` |
| 66 | PATCH | `/api/modules/:name/config` | `patchModuleInstallConfig` | `module-config-patch` | `!install-config` |
| 67 | GET/POST | `/api/cast/export/:id` | `exportCastUrl` | `cast-export-url` | `!exportcast` |
| 68 | POST | `/api/cast/import` | `importCast` | *(attachment)* | `!importcast` |
| 69 | POST | `/api/storyboard/renders/:id/retry` | `retryRender` | `render-retry` | `!retry` |

Route **#69** is used by the Vivijure control panel (`planner-history-row.js`) to re-submit a failed
render row; it is not yet listed in `CONTRACT.md` section 2.1 but is part of the Slate parity matrix.

## CI gate

```bash
npm test   # runs contract.test.ts among others
```

`validateContractConformance()` fails if:

- Any CONTRACT route lacks a `studio.mjs` export
- Any route lacks a command or `!api` action
- Any `STUDIO_ACTIONS` key (except `help`) is unmapped
- Any `studio.mjs` HTTP export is unmapped
- Any `STUDIO_COMMAND_ALIASES` entry points at a missing action

## Route count

| Set | Count |
|-----|-------|
| `CONTRACT.md` section 2.1 | 68 |
| Control-panel supplements | 1 (`render-retry`) |
| **Total Slate matrix** | **69** |

When Vivijure adds a route, add it to `contract.mjs` first; CI will fail until
`studio.mjs`, `STUDIO_ACTIONS`, and commands are updated together.
