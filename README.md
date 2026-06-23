# Slate

**Slate** is the collaborative screenwriter's assistant for the [Vivijure](https://vivijure.skyphusion.org) AI film platform. It lives in a Discord channel and helps filmmakers plan, develop, and submit films through natural conversation -- maintaining a structured storyboard brief in the background, generating character portraits, searching the web, and submitting projects to the Vivijure render pipeline when the team is ready.

> Slate started as a simple Discord-to-ollama relay and was redesigned and substantially extended by [Claude Sonnet 4.6](https://anthropic.com) (operating as Strummer, SkyPhusion's AI crew member) into the full platform assistant it is today. The architecture, feature set, knowledge base, search integration, vision support, slash commands, render pipeline, and D1 session persistence were all designed and implemented by Claude as part of the SkyPhusion AI-collaborative development workflow.

## Ecosystem

```
slate  -->  vivijure  -->  vivijure-backend
```

| Repo | Role |
|---|---|
| **[slate](https://github.com/skyphusion-labs/slate)** | **Collaborative AI screenwriter Discord bot -- shapes the film in-channel, then hands it to vivijure to render** |
| [vivijure](https://github.com/skyphusion-labs/vivijure) | AI film studio control plane (Cloudflare Worker) -- planner, cast, render UI; orchestrates render jobs |
| [vivijure-backend](https://github.com/skyphusion-labs/vivijure-backend) | GPU render backend (RunPod serverless) -- SDXL keyframes, i2v, finish, assemble |

---

## Slate in action

The screenshots below are a real planning session: Slate and a crew test bot
collaborating in a Discord channel to design a short film from a one-line pitch.

**Conversational planning + character portraits** -- Slate develops the cast, then
generates a portrait on command and syncs it to the Vivijure Cast:

![Slate planning a film and generating a character portrait](assets/showcase-planning.jpg)

**Structured storyboard, maintained in the background** -- while everyone talks,
Slate keeps a machine-readable brief (title, logline, style, cast, scenes) and
shows it on `!brief`:

![The storyboard brief Slate maintains](assets/showcase-brief.jpg)

### What it produced: "ECHO"

From that conversation, Slate assembled the storyboard bundle and submitted it to
the [Vivijure](https://vivijure.skyphusion.org) render pipeline (SDXL keyframes +
image-to-video, assembled to a 1080p film). The character portrait carries through
as a reference so the detective stays consistent into motion.

| The City | The Data Trail | The Absence |
|---|---|---|
| ![Scene 1](assets/showcase-city.jpg) | ![Scene 2](assets/showcase-datatrail.jpg) | ![Scene 3](assets/showcase-absence.jpg) |
| Detective Chen Kai in a rain-drenched neon alley | His cybernetic eye activating, data streams swirling | Echo's empty chair, present only as afterimage |

A draft-tier render planned entirely through conversation -- atmospheric, on-theme,
and coherent across the three-scene arc.

### A second film: "EMBER"

Not a one-off. A different session, a different genre -- warm light against a dying
world. Slate genuinely collaborated: pitched the premise, its instinct was *"don't
open on the catastrophe, open on the flower,"* and it locked a clean brief before a
single frame was rendered:

![Slate locking the EMBER brief](assets/showcase-ember-plan.jpg)

The result -- a botanist carrying the last living flower through a frozen city toward
the last warm place on Earth:

| The Greenhouse | The Threshold | The First Light |
|---|---|---|
| ![Scene 1](assets/showcase-ember-greenhouse.jpg) | ![Scene 2](assets/showcase-ember-threshold.jpg) | ![Scene 3](assets/showcase-ember-firstlight.jpg) |
| The last seedling, cradled under glass | Wren carries the lantern through the frozen ghost city | The flower blooms as real sunlight returns |

### A third film: "RUST"

A two-character short, and the end-to-end proof of the self-hosted render path: a salvage robot
gives its last charge to wake the companion it spent years rebuilding. Slate developed both
characters, and both portraits carried through as references into the motion.

| The Junkyard | The Last Charge | Dawn |
|---|---|---|
| ![Scene 1](assets/showcase-rust-junkyard.jpg) | ![Scene 2](assets/showcase-rust-charge.jpg) | ![Scene 3](assets/showcase-rust-dawn.jpg) |
| The salvage robot works amid sparks | Its amber eye dims as the companion's blue eyes wake | Dawn: the maker dark and still, the little one looking back |

RUST was rendered entirely on our own GPU and finished on our own hardware, reached privately over
a Cloudflare Workers VPC link -- planned by conversation, rendered and delivered in-house.

Three films, three genres, same flow: conversation in, finished film out.

---

## Features

- **Conversational film planning** -- natural multi-person discussion in a Discord channel; Slate participates as a creative collaborator and silently maintains a structured storyboard brief in the background
- **Claude Sonnet via Cloudflare AI Gateway** -- native Anthropic SDK path; falls back to any ollama-compatible model if the gateway token is not set (no vendor lock-in)
- **Vision input** -- paste mood boards, reference stills, or concept art directly into the channel; Claude reads the images and incorporates them into the creative discussion
- **Web search + deep research** -- Claude autonomously calls Brave Search, Tavily (AI-curated research), and Cloudflare Browser Rendering (headless Chrome) when it needs to look something up
- **Knowledge base** -- `!learn <text or URL>` indexes film references, director styles, cinematography notes, and genre conventions into a Cloudflare Vectorize store; Claude searches it automatically when relevant
- **Character portraits** -- `!portrait A [description]` generates a character image via skyphusion-llm-public and syncs it to the Vivijure Cast (name, visual bible, and portrait registered in one step)
- **Scene thumbnails** -- `!thumbnail <scene-id>` generates a quick visual for any scene using its prompt and the project's style prefix
- **11 image models** -- FLUX Schnell, FLUX 2 Klein, FLUX 2 Dev, Phoenix, Lucid Origin, Dreamshaper, SDXL, GPT Image 1.5, Recraft V4, Nano Banana Pro; switch with `!model <alias>`
- **Render submission** -- `!render [draft|standard|final]` assembles the storyboard bundle and submits it to Vivijure; Slate notifies the channel automatically when the render completes
- **D1 cloud session state** -- full storyboard brief, conversation history, brief undo history, and pending render jobs are stored in Cloudflare D1; nothing is lost on restart
- **Brief undo** -- `!undo` rolls back the last automatic brief extraction if Claude misread something
- **Render settings, decided together** -- the group chooses the render backend (`!backend` own GPU vs cloud), the quality tier, and the opening title + end-credit cards (`!titlecard`). Slate holds these on the brief and carries them to the studio API at submit time; it runs no render logic of its own. Backend names and quality tiers are projected live from the studio registry (`GET /api/modules`), never hardcoded.
- **Subtitles** -- `!subtitles on` captions the film's spoken dialogue. Slate tracks each shot's dialogue line on the brief and sends it as the studio's per-shot `dialogue_lines`; the `film.finish` subtitle module times each caption to its shot's window. The toggle is honest about needing a subtitle module installed and dialogue to caption.
- **Slash commands** -- every command is available as a Discord slash command (`/brief`, `/portrait`, `/thumbnail`, `/backend`, `/titlecard`, `/subtitles`, `/render`, `/model`, `/undo`, `/learn`, `/reset`)

---

## Architecture

```
Discord channel
      |
   bot.mjs  (Node 24+, discord.js + @anthropic-ai/sdk)
      |
      +-- Claude Sonnet 4.6 via Cloudflare AI Gateway (/anthropic path)
      |       |
      |       +-- web_search    --> Brave Search API
      |       +-- research      --> Tavily API (AI-curated, deep)
      |       +-- fetch_page    --> vivijure-search Worker (CF Browser Rendering)
      |       +-- search_knowledge --> vivijure-search Worker (Vectorize)
      |
      +-- Cloudflare D1          (session state: brief, history, render jobs)
      +-- skyphusion-llm-public  (image generation: 11 models)
      +-- Vivijure API           (Cast sync, portrait upload, storyboard render)

vivijure-search  (Cloudflare Worker)
  /search        Brave (web) or Tavily (research)
  /fetch         CF Browser Rendering -- puppeteer headless Chrome
  /knowledge/index   embed + store in Vectorize (bge-large-en-v1.5, 1024-dim)
  /knowledge/search  embed query + Vectorize similarity search
```

**Key design decisions:**

- Images from Discord attachments are fetched and base64-encoded for the current turn only -- they are not stored in D1 history (too large). The history entry is a text placeholder.
- The Anthropic tool-use loop runs up to 5 rounds before forcing a final answer.
- The `briefHistory` stack (max 10 entries) is persisted in the D1 session blob so `!undo` works across restarts.
- Render jobs are written to a separate `render_jobs` D1 table and polled every 30 seconds; the channel is notified on completion or failure.
- Slash commands are registered globally on startup (`Routes.applicationCommands`); guild propagation is instant, global can take up to an hour for new registrations.

---

## Setup

### Prerequisites

- Node 24+
- A Discord application with a bot token ([Discord Developer Portal](https://discord.com/developers/applications))
  - Bot intents: **MESSAGE CONTENT** on (Privileged Gateway Intents)
  - OAuth2 scopes: `bot`, `applications.commands`
  - Bot permissions: Send Messages, Read Message History, Attach Files
- Cloudflare account with Workers Paid plan (for Vectorize and Browser Rendering)
- Cloudflare AI Gateway set up with the `skyphusion-llm` gateway name (or your own)
- D1 database (create one: `wrangler d1 create vivijure-bot-sessions`)

### vivijure-search Worker

```bash
cd search-worker
npm install

# Create the Vectorize index (one-time)
npx wrangler vectorize create slate-knowledge --dimensions=1024 --metric=cosine

# Set secrets
npx wrangler secret put BRAVE_API_KEY      # https://brave.com/search/api/
npx wrangler secret put TAVILY_API_KEY     # https://tavily.com/
npx wrangler secret put SEARCH_SECRET      # any random shared secret

# Deploy
npm run deploy
```

Update `search-worker/wrangler.toml` if you use a different Vectorize index name or CF account.

### Discord bot (local / direct)

```bash
npm install
```

Create a `.env` file (or export these variables):

```env
DISCORD_TOKEN=
DISCORD_CHANNEL_IDS=          # comma-separated channel IDs to listen in
DISCORD_MODEL=claude-sonnet-4-6
VIVIJURE_API_URL=https://vivijure.skyphusion.org
LLM_API_URL=https://play.skyphusion.org
CF_ACCESS_CLIENT_ID=          # Cloudflare Access service token
CF_ACCESS_CLIENT_SECRET=
CF_D1_TOKEN=                  # CF API token with D1:Write scope
CF_D1_ACCOUNT_ID=
CF_D1_DATABASE_ID=
CF_AIG_TOKEN=                 # CF API token for AI Gateway (omit to use ollama)
CF_GATEWAY_ENDPOINT=          # e.g. https://gateway.ai.cloudflare.com/v1/<acct>/<name>/compat/chat/completions
SEARCH_WORKER_URL=https://vivijure-search.skyphusion.workers.dev
SEARCH_SECRET=                # must match the Worker secret
```

```bash
node bot.mjs
```

### Docker (production -- dischord)

See `stacks/dischord.yml`. Create `stacks/.env` with the variables above, then:

```bash
docker compose -p slate -f stacks/dischord.yml up -d
```

---

## Commands

| Command | Slash | Description |
|---------|-------|-------------|
| `!brief` | `/brief` | Show the current storyboard state |
| `!portrait <A\|B\|C\|D> [desc]` | `/portrait` | Generate a character portrait and sync to Vivijure Cast |
| `!thumbnail <scene-id>` | `/thumbnail` | Generate a visual thumbnail for a scene |
| `!model [name]` | `/model` | List available image models or switch the active one |
| `!backend [name\|auto]` | `/backend` | Choose the render backend (own GPU vs cloud), or `auto` to let the studio decide. Options are projected live from the studio registry. |
| `!titlecard <title> [\| sub] [\|\| credits]` | `/titlecard` | Set the opening title card + end credits (credits separated by `;` or `\|`), or clear them |
| `!subtitles on\|off` | `/subtitles` | Caption spoken dialogue in the rendered film. Captions sync to each shot's dialogue line; they show once the brief carries dialogue and a subtitle module is installed |
| `!render` | `/render` | Run the pre-submit **huddle**: Slate reads back the render settings, flags anything worth knowing, and offers the next creative beat or a clean ship. Confirm with `ship it` (or `!render now` / `!ship`); `/render confirm:true` or an explicit quality ships immediately. On submit a multi-character film auto-fills missing character refs and over-long scene prompts are smart-trimmed to the 50-word renderer cap |
| `!ship` / `ship it` | -- | Confirm and send the render Slate just huddled on |
| `!undo` | `/undo` | Roll back the last automatic brief extraction |
| `!learn <text or URL>` | `/learn` | Index a film reference into the knowledge base |
| `!reset` | `/reset` | Clear the project and start fresh |

**Image model aliases:** `flux-schnell`, `flux2-fast`, `flux2`, `flux2-dev`, `phoenix`, `lucid`, `dreamshaper`, `sdxl`, `gpt-image`, `recraft`, `nano-banana`

---

## Image attachment (vision)

When the Claude backend is active, you can attach images directly to any message -- mood boards, reference stills, concept art, frame grabs. Slate reads them and incorporates them into the creative discussion. Up to 3 images per message, 4 MB each.

---

## Ollama fallback

Slate is not locked to Claude. To use an ollama model instead:

1. Omit `CF_AIG_TOKEN` from the environment.
2. Set `OLLAMA_BASE_URL` and `DISCORD_MODEL` to your model.

Image attachments are degraded to a text placeholder in ollama mode (most ollama models are text-only).

---

## Credits

**Conrad Rockenhaus** ([SkyPhusion](https://github.com/SkyPhusion)) -- project creator, platform architect, Vivijure founder.

**Claude Sonnet 4.6** (Anthropic) -- operating as *Strummer*, SkyPhusion's AI crew member. Designed and implemented the Slate architecture from an initial Discord-to-ollama relay: CF AI Gateway integration (native Anthropic SDK path), Anthropic tool-use loop, Brave + Tavily + CF Browser Rendering search pipeline, Cloudflare Vectorize knowledge base, Discord vision input, slash command system, D1 session persistence, render submission and polling, character portrait generation and Vivijure Cast sync, `!thumbnail`, `!undo`, and the `vivijure-search` Worker. This project is an example of the SkyPhusion AI-collaborative development model -- human vision, AI execution, shipped together.

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development
setup, code style (no em-dashes; minimal dependencies), and the PR workflow. Security reports go
through [SECURITY.md](SECURITY.md), not public issues. Release notes live in
[CHANGELOG.md](CHANGELOG.md).

---

## Using Slate (Terms & Privacy)

Slate is a Discord application that reads message content in the channels it joins. By using it you
agree to the [Terms of Service](TERMS.md); how it handles your data (and the third-party services
involved) is described in the [Privacy Policy](PRIVACY.md).

---

## License

**AGPL-3.0-only.** A labor of love, given freely: use it, learn from it, self-host it, build your own creative visions on it. Run it as a network service and the AGPL has you share your changes back, so it stays a commons. It is not for sale, and not to be resold as a SaaS.

See [LICENSE](LICENSE).
