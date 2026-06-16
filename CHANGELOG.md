# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

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
