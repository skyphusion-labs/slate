# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Slate: the Vivijure Screenwriter's Assistant for Discord.** A collaborative film-planning bot that
maintains a storyboard brief, generates character portraits and scene thumbnails, searches the web,
and submits projects to the Vivijure render pipeline. Currently **v0.3.0** (full studio API parity +
control-panel conformance). The GitHub repo is named `slate` (it was
`skyphusion-slate`; redirects still work). Production runs as a Docker stack on the deploy host.

**Full command reference:** [docs/commands.md](docs/commands.md)

## Where it sits (the Vivijure constellation)

```
   friends + Slate (Discord)  <-- THIS REPO
            |
            v
        vivijure (studio control plane / JSON API)
            |
            v
        vivijure-backend + modules (GPU render: keyframes -> i2v -> assemble)
```

Slate is the upstream, human-facing surface. The group writes a film in Discord; Slate keeps the
brief and ships it to the Vivijure studio API. Slate has **full control-panel parity**: every hook,
cast workflow, render setting, and HTTP route the web UI exposes is reachable from Discord. Module
choices are projected live from `GET /api/modules` via `registry.mjs`; commands are gated on what is
actually installed.

## Structure

```
bot.mjs                  Discord bot (main entry, message + slash handlers)
lib.mjs                  Pure helpers (brief transforms, registry mapping, preflight formatting)
registry.mjs             GET /api/modules projection (hooks, gates, formatters)
studio.mjs               HTTP client for all studio API routes (69: 68 CONTRACT + retry)
contract.mjs             Route-to-command matrix; STUDIO_COMMAND_ALIASES; CI validation
studio-api.mjs           !api action registry (65 actions) + executeStudioAction()
contract.test.ts         Vitest: zero-drift conformance gate
lib.test.ts              Vitest unit tests for lib.mjs
registry.test.ts         Vitest unit tests for registry.mjs
search-worker/           Cloudflare Worker slate-search: web search + knowledge base
log-worker/              Cloudflare Worker slate-logs: log sink
stacks/compose.prod.yml  Docker Compose stack (production)
docs/commands.md         Canonical command + studio parity reference
docs/CONTRACT-conformance.md  69-route API matrix (CI-enforced)
```

## Commands (developer)

```bash
npm run lint         # node --check bot.mjs -- CI gate for the bot
npm run bot          # node bot.mjs (needs env from slate.env or stacks/.env)
npm test             # vitest: lib + registry + contract conformance
npm run smoke:studio # offline gate + optional live studio probes
npx vitest run       # same as npm test
cd search-worker && npm run typecheck && npm run deploy
cd log-worker && npm run typecheck && npm run deploy
```

### Verifying changes

`node --check bot.mjs` (`npm run lint`) is the bot gate. Workers typecheck separately. `npm test` runs
`lib.test.ts`, `registry.test.ts`, and `contract.test.ts` (69-route zero-drift gate). `bot.test.ts`
is a boot smoke against mocked env. CI: `ci.yml` lints bot + typechecks search-worker;
`code-coverage.yml` runs Vitest; `deploy.yml` deploys Workers on green push to `main`. Bot image
builds on `v*` tags (`image.yml`).

## Running (production)

Bot runs as Docker on the stack host (tag-driven GHCR image). Workers deploy from CI on push to
`main`. See README "Run your own Slate" and stacks/compose.prod.yml.

## Key architecture

- **Claude Sonnet via CF AI Gateway** (native Anthropic SDK). Falls back to ollama when
  `CF_AIG_TOKEN` is unset.
- **Tool-use loop** (5 rounds max): web_search, research, fetch_page, search_knowledge via
  slate-search Worker.
- **Vision**: image attachments as base64 to Claude (ollama path strips to text).
- **D1 session state**: brief, history, briefHistory, render_settings, cast_bindings,
  studio_project_id, render_jobs.
- **Registry projection**: `registry.mjs` mirrors planner-registry.js + planner-render-config.js.
  Hook catalog, pick_one choosers, module config, and command gates all from `GET /api/modules`.
- **Studio client**: `studio.mjs` implements every route in the conformance matrix (`contract.mjs`).
  `studio-api.mjs` maps 65 friendly action names for `!api`. `bot.mjs` adds ergonomic `!` commands,
  `STUDIO_COMMAND_ALIASES`, and attachment upload flows. `!conformance` prints the live matrix.
- **Render submit**: bundle -> preflight -> `POST /api/render/film` with mapped configs; polls every 30s.
- **Module-gated commands**: `commandAvailability()` in registry.mjs; `!commands` lists live gates.

## Discord commands (summary)

See [docs/commands.md](docs/commands.md) for the full table. Highlights:

| Area | Commands |
|------|----------|
| Storyboard | `!brief`, `!undo`, `!reset`, `!autodirect` |
| Render settings | `!tier`, `!keyframe`, `!backend`, `!keyframes-only`, `!titlecard`, `!subtitles`, `!config`, `!install-config`, `!hooks` |
| Submit | `!render`, `!ship`, `!preflight` |
| Cast / LoRA | `!cast`, `!bind`, `!train`, `!genrefs`, `!voices`, `!voice` |
| Uploads | `!importcast`, `!upload`, `!audioupload`, `!addref`, `!addsource`, `!characterref` |
| Studio | `!saveproject`, `!loadproject`, `!renders`, `!score`, `!api`, `!conformance` |
| Meta | `!commands` (module-gated live list) |

Every command has a slash equivalent where practical. Slash commands register globally on startup.

## Conventions

- **No em-dashes (U+2014) or en-dashes (U+2013)** in source, comments, or docs.
- **Handle / username is `skyphusion`** across services.
- **Minimal dependencies**: vanilla Node.js + discord.js + Anthropic SDK.
- **Secrets never committed**; config via environment variables.
- **Trust the studio registry** over hardcoded module names, tiers, or hook lists.

## Crew + identity

Crew members work as their own Unix + gh identity (`sudo -u <member> bash -lc '...'`). Crew commits
use `skyphusion-<member>` identity, never Conrad's. Conrad devs only on his laptop
(`Conrad Rockenhaus <conrad@skyphusion.org>`).

## Commits & versioning

Conventional Commits; SemVer `0.MINOR.PATCH` pre-1.0. Release bumps `package.json` + `CHANGELOG.md`.
