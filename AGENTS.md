# Slate

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

Slate is the Vivijure screenwriter assistant for Discord. It keeps a storyboard brief. It can generate character portraits and scene thumbnails. It can search the web. It submits projects to the Vivijure render pipeline.

The GitHub repo is `slate`. The old name `skyphusion-slate` still redirects.

Slate is one Discord bot pointed at one studio `VIVIJURE_API_URL`. It is not a multi-tenant host. It is not the control plane.

See root `package.json`, the latest `v*` tag, and [CHANGELOG.md](CHANGELOG.md). Do not freeze a number here.

The command reference is [docs/commands.md](docs/commands.md).

## Where it sits

```
friends + Discord  <-- this repo (slate)
        |
        v
vivijure-cf / vivijure-local  (studio panels; core: vivijure-core)
        |
        v
vivijure-backend + satellites (GPU render)
```

The group writes a film in Discord. Slate keeps the brief and sends it to the studio API. Hook, cast, render, and HTTP routes the web UI exposes are reachable from Discord. `registry.mjs` reads `GET /api/modules`. Commands follow what is installed.

## Structure

```
bot.mjs                  Discord bot (message and slash handlers)
lib.mjs                  Brief transforms, registry mapping, preflight text
registry.mjs             GET /api/modules projection
studio.mjs               HTTP client for studio API routes
contract.mjs             Route-to-command matrix and aliases
studio-api.mjs           !api action registry
contract.test.ts         Vitest zero-drift gate
lib.test.ts              Unit tests for lib.mjs
registry.test.ts         Unit tests for registry.mjs
search-worker/           Worker: web search and knowledge base
log-worker/              Worker: log sink
stacks/compose.prod.yml  Docker Compose stack
docs/commands.md         Command and studio parity reference
docs/CONTRACT-conformance.md  Route matrix (CI-enforced)
```

The route count and the action count live in those tests and in [docs/CONTRACT-conformance.md](docs/CONTRACT-conformance.md). Do not copy a count into this file.

## Commands

```bash
npm run lint
npm run bot
npm test
npm run smoke:studio
npx vitest run
cd search-worker && npm run typecheck && npm run deploy
cd log-worker && npm run typecheck && npm run deploy
```

`npm run lint` is `node --check bot.mjs`. That is the bot gate. `npm run bot` is `node bot.mjs`. `./run.sh` sources `slate.env`. `npm test` is vitest.

Workers typecheck on their own. Run `npm run typecheck` in `search-worker/` and in `log-worker/` before you push.

## Verify

`npm test` covers `lib.test.ts`, `registry.test.ts`, `contract.test.ts`, `bot.test.ts`, and the other root `*.test.ts` files. `contract.test.ts` is the zero-drift gate. See [docs/CONTRACT-conformance.md](docs/CONTRACT-conformance.md).

`.github/workflows/ci.yml` lints the bot, runs that vitest suite, and typechecks both Workers. `coverage.yml` is the required `coverage` context. It currently echoes. It does not run the tests. The vitest gate is `ci.yml`.

`deploy.yml` deploys Workers only on a pushed `v*` tag. A merge to `main` runs CI only. `image.yml` builds the bot image on a `v*.*.*` tag.

## Run

Run the bot as Docker. See the README section "Run your own Slate" and [stacks/compose.prod.yml](stacks/compose.prod.yml). Workers deploy from CI only on a `v*` tag.

`stacks/compose.prod.yml` must pin the bot image to an explicit version tag, such as `ghcr.io/skyphusion-labs/slate:X.Y.Z`. Do not leave compose on `:latest` as the production contract. When you cut a release, bump `package.json` and [CHANGELOG.md](CHANGELOG.md). Bump the compose pin in the same wave, or right after the GHCR publish.

## Architecture

`bot.mjs` defaults `DISCORD_MODEL` to `qwen3.6:27b-ctx8k`. With `CF_AIG_TOKEN` unset, chat uses Ollama at that id. With `CF_AIG_TOKEN` set, that same id is sent through the Cloudflare AI Gateway with the Anthropic SDK. The Claude path needs a Claude model id. [stacks/compose.prod.yml](stacks/compose.prod.yml) and `slate.env.example` default `DISCORD_MODEL` to `claude-sonnet-4-6`.

The tool loop allows 5 rounds. Tools: `web_search`, `research`, `fetch_page`, `search_knowledge`, `search_memory`. They use the search Worker.

Vision sends an image attachment as base64 on the Claude path. The Ollama path keeps text only.

D1 holds session state: brief, history, briefHistory, render settings, cast bindings, studio project id, render jobs, and the traffic ledger.

Every `studio.mjs` call goes through `studioRequest`. An observer logs the request and the response to D1 `traffic_ledger`. A mutating call also embeds a summary in the `slate-memory` Vectorize index. Chat turns and brief snapshots are embedded the same way. `channelContext` is an `AsyncLocalStorage`. It is entered at the top of the message and interaction handlers. It stamps the Discord channel without a channel id argument on every call.

Retrieval uses the `search_memory` tool, and the `!memory` or `/memory` commands. `slate-memory` is a separate index from `slate-knowledge`. Per-channel context does not leak across channels. It does not mix into the shared knowledge base.

`registry.mjs` mirrors the planner registry and the render-config script. Catalog, choosers, module config, and command gates come from `GET /api/modules`.

`studio.mjs` implements every route in the conformance matrix. `studio-api.mjs` maps friendly names for `!api`. `bot.mjs` adds `!` commands, aliases, and attachment uploads. `!conformance` prints the live matrix.

Render submit is bundle, then preflight, then `POST /api/render/film`. The bot polls about every 30 seconds.

`commandAvailability()` in `registry.mjs` gates commands. `!commands` lists the live gates.

## Discord commands

The full table is [docs/commands.md](docs/commands.md).

| Area | Commands |
|------|----------|
| Storyboard | `!brief`, `!undo`, `!reset`, `!autodirect` |
| Render settings | `!tier`, `!keyframe`, `!backend`, `!keyframes-only`, `!titlecard`, `!subtitles`, `!config`, `!install-config`, `!hooks` |
| Submit | `!render`, `!ship`, `!preflight` |
| Cast | `!cast`, `!bind`, `!train`, `!genrefs`, `!voices`, `!voice` |
| Uploads | `!importcast`, `!upload`, `!audioupload`, `!addref`, `!addsource`, `!characterref` |
| Studio | `!saveproject`, `!loadproject`, `!renders`, `!score`, `!api`, `!conformance` |
| Meta | `!commands` |

A practical command also has a slash form. Slash commands register globally on startup.

## Release

Three ship paths share one SemVer cut. The release pull request bumps `package.json` and adds `## vX.Y.Z` to [CHANGELOG.md](CHANGELOG.md).

| Trigger | Workflow | Effect |
|---------|----------|--------|
| push `v*` tag | `deploy.yml` | Deploy search and log Workers |
| push `v*.*.*` tag | `image.yml` | Build and push the bot GHCR image |
| GitHub Release published on that tag | `publish-npm.yml` | Publish `@skyphusion/slate` to npm |

A merge to `main` does not deploy Workers, push the image, or publish npm.

A version moves only in a release pull request. A feature pull request does not bump. A fix pull request does not bump.

The version of record is `package.json` (and the lockfile). The tag shape is `v*`. The npm tag `vX.Y.Z` must equal `package.json` version `X.Y.Z`. The tag must be an ancestor of `origin/main`.

Before a release pull request, check tags. If the current manifest version already has a tag, the cycle is closed, so the release pull request bumps. If it has no tag, stop. Read why before you bump again.

1. Land the release pull request.
2. An org admin tags that merge commit:

```bash
git fetch origin main --tags
sha="$(gh pr view <release-pr> --json mergeCommit -q .mergeCommit.oid)"
git tag -a vX.Y.Z -m "vX.Y.Z" "$sha"
git push origin vX.Y.Z
```

3. Confirm `deploy.yml` and `image.yml` are green.
4. Publish npm by creating the GitHub Release:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

Use a Conventional Commit. The body says why. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Docs language and safety

Write Simplified Technical English. Use short sentences. Put one idea in each sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). This rule covers source, comments, and docs. Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

Keep dependencies small: Node.js, discord.js, and the Anthropic SDK.

Do not commit a secret. Configure with environment variables.

Trust `GET /api/modules` over a hardcoded module name, tier, or hook list.

The CSAM ban includes synthetic images. Do not weaken that check.

The public handle is `skyphusion`. Do not freeze an endpoint id in this file.
