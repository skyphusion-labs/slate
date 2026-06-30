# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**Slate: the Vivijure Screenwriter's Assistant for Discord.** A collaborative film-planning bot that
maintains a storyboard brief, generates character portraits and scene thumbnails, searches the web,
and submits projects to the Vivijure render pipeline. Currently **v0.2.0**. The GitHub repo is now
named `slate` (it was `skyphusion-slate`; redirects still work, but use `slate`). Production runs as a
Docker stack on the `<deploy-host>`.

## Where it sits (the Vivijure constellation)

```
   friends + Slate (Discord)  <-- THIS REPO
            |
            v
        vivijure (studio control plane / JSON API)
            |
            v
        vivijure-backend (GPU render: keyframes -> i2v -> assemble)
```

Slate is the upstream, human-facing surface: the group writes a film in Discord, Slate keeps the
brief, and `!render` ships it to the Vivijure studio API. Backend/quality choices Slate offers are
projected live from the studio registry, never hardcoded (see `!backend`).

## Structure

```
bot.mjs                  Node 24+ Discord bot (main entry point, ~93KB)
package.json             Bot deps (@anthropic-ai/sdk, discord.js); scripts: bot, lint
bot.test.ts              Vitest smoke (imports bot.mjs against mocked env + local workers)
search-worker/           Cloudflare Worker `vivijure-search`: web search + knowledge base
  src/index.ts           Worker source
  wrangler.toml          Bindings: BROWSER, AI, KNOWLEDGE (Vectorize: slate-knowledge)
log-worker/              Cloudflare Worker `slate-logs`: log sink
  wrangler.toml          Binding: LOGS (R2 bucket: slate-logs)
stacks/
  compose.prod.yml           Docker Compose stack for the `<deploy-host>` (production)
  .env                   Secrets (never committed; see the compose.prod.yml header for the keys)
```

## Commands

```bash
npm run lint         # node --check bot.mjs -- the CI gate for the bot (parse check)
npm run bot          # node bot.mjs (run the bot locally; needs the env from stacks/.env)
npx vitest run       # the smoke suite (bot.test.ts); there is no `test` npm script
cd search-worker && npm run typecheck && npm run deploy   # the search worker
cd log-worker && npm run typecheck && npm run deploy       # the log worker
```

### Verifying changes

The bot is dependency-free at parse time, so `node --check bot.mjs` (`npm run lint`) is the gate, and
the two Workers each typecheck (`npm run typecheck`). `bot.test.ts` (Vitest) is a boot smoke that
imports `bot.mjs` against mocked tokens; the coverage workflow first brings up `log-worker` (:8787)
and `search-worker` (:8788) via `wrangler dev` so the import path that talks to them resolves. CI is
GitHub Actions on GitHub-hosted `ubuntu-latest` (public repo, fork-safe): `ci.yml` lints the bot +
typechecks `search-worker`; `code-coverage.yml` runs the Vitest smoke against the two local workers;
`deploy.yml` deploys `vivijure-search` and `slate-logs` on a green push to `main`. The bot itself is
NOT deployed by CI: it is a deliberate host-side Docker step on the `<deploy-host>`.

## Running (production: the deploy-host stack)

```bash
# Initial setup on the `<deploy-host>`
ssh <deploy-user>@<deploy-host> "
  cd ~/dev && git clone git@github.com:skyphusion-labs/slate.git
  cp ~/dev/slate/stacks/.env.example ~/dev/slate/stacks/.env   # then fill in secrets
  cd slate/stacks && docker compose -p slate -f compose.prod.yml up -d
"

# Redeploy after code changes
rsync -az ~/dev/slate/ <deploy-user>@<deploy-host>:/root/dev/slate/ --exclude node_modules --exclude .git --exclude stacks/.env
ssh <deploy-user>@<deploy-host> "docker compose -p slate -f ~/dev/slate/stacks/compose.prod.yml up -d --force-recreate slate"
```

`search-worker` (Vectorize, one-time) and the worker secrets are set via wrangler:
```bash
npx wrangler vectorize create slate-knowledge --dimensions=1024 --metric=cosine
npx wrangler secret put BRAVE_API_KEY   # and TAVILY_API_KEY, SEARCH_SECRET
```

## Key architecture

- **Claude Sonnet via the CF AI Gateway** (native Anthropic SDK on the `/anthropic` path). Production
  sets `DISCORD_MODEL=claude-sonnet-4-6`; the bot.mjs code default is an ollama model
  (`qwen3.6:27b-ctx8k`), and it falls back to ollama when `CF_AIG_TOKEN` is unset.
- **Tool-use loop** (up to 5 rounds): `web_search` (Brave), `research` (Tavily), `fetch_page` (CF
  Browser Rendering), `search_knowledge` (Vectorize) -- all via the `vivijure-search` worker.
- **Vision**: image attachments fetched as base64 and passed to Claude as image content blocks (the
  ollama path strips to text).
- **D1 session state**: `sessions` (channel storyboard + history + briefHistory) and `render_jobs`
  (pending render polling).
- **Brief undo**: a `briefHistory` array (max 10) pushed before each brief update; `!undo` rolls back.
- **Render polling**: a 30s interval polls Vivijure `/api/storyboard/render/:jobId` and notifies the
  channel on completion.
- **Registry-projected backends**: `!backend` lists motion backends live from the studio registry
  (`GET /api/modules`, `hooks["motion.backend"]`); names are never hardcoded.
- **Knowledge base**: Vectorize index `slate-knowledge` (1024-dim, cosine), embedded via
  `@cf/baai/bge-large-en-v1.5`. Logs sink to the `slate-logs` worker (R2).

## Commands (Discord)

Both a bang prefix (`!cmd`) and a registered slash command are supported; slash options noted.

| Command | Slash | Description |
|---------|-------|-------------|
| `!brief` | `/brief` | Show the current storyboard |
| `!portrait <slot> [desc]` | `/portrait slot:<A-D> [description]` | Generate + sync a character portrait |
| `!thumbnail <scene>` | `/thumbnail scene:<id>` | Generate a scene thumbnail |
| `!render [quality]` | `/render [quality] [confirm]` | Submit to Vivijure (confirm skips the huddle) |
| `!backend [choice]` | `/backend [choice]` | Pick a motion backend, `auto`, or list them |
| `!titlecard ...` | `/titlecard [title] [subtitle] [credits]` | Set/clear opening title + end credits |
| `!subtitles <on\|off>` | `/subtitles state:<on\|off>` | Toggle burned-in subtitles |
| `!model [name]` | `/model [name]` | Show/switch image model |
| `!undo` | `/undo` | Roll back the last brief extraction |
| `!learn <text\|url>` | `/learn content:<text\|url>` | Index a film reference into the knowledge base |
| `!reset` | `/reset` | Clear the project |

Slash commands register globally on startup via `Routes.applicationCommands`.

## Conventions

- **No em-dashes (U+2014) or en-dashes (U+2013)** in source, comments, or docs. Use commas,
  semicolons, parentheses, or `--`.
- **Handle / username is `skyphusion`** across all services.
- **Minimal dependencies**: vanilla Node.js + discord.js + the Anthropic SDK only. Justify any new
  one.
- **Mirror every `wrangler.toml` binding in the hand-authored `Env`** in each worker's `src/index.ts`.
- **Secrets never committed**; all state lives in D1 / R2 / Vectorize (cloud-first). `account_id` and
  tokens come from the environment, never hardcoded.

## Crew + identity

- Crew members work as their own Unix + gh identity. The FIRST command in any op is the member's own
  login shell: `sudo -u <member> bash -lc '<ops>'` (loads their `$HOME`, their `~/dev/slate` clone,
  their gh/CF creds).
- Crew commits land under the member's own `skyphusion-<member>` identity, never Conrad's. (Conrad
  devs ONLY on his laptop, where his commits author as `Conrad Rockenhaus <conrad@skyphusion.org>`
  -- his real name kept, the in-house `@skyphusion.org` email; his name is never scrubbed and his
  history never rewritten. On the crew host the `conrad` user is the god process and commits as
  `Mackaye <mackaye@skyphusion.org>`.)
- Cross-project operating context lives in the main auto-memory
  (`~/.claude/projects/-home-conrad/memory/`); load it before acting.

## Commits & versioning

Conventional Commits (`feat(scope):` / `fix(scope):` / `docs:` / `ci:`); the body explains the why.
SemVer-style `0.MINOR.PATCH` while pre-1.0 (PATCH for fixes / backend tweaks, MINOR for new
features); a release commit bumps `package.json` `version` and adds a top-of-file `CHANGELOG.md`
entry.
