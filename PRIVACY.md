# Privacy Policy

**Effective date:** 2026-06-14
**Service:** Slate, a Discord application
**Operator:** Conrad Rockenhaus (SkyPhusion), the operator of the official hosted instance.

This policy explains what data Slate processes, why, who it is shared with, and how long it is
kept. Slate is open-source software (AGPL-3.0); anyone may run their own instance, in which case
that operator is the data controller for their instance and this policy describes the
SkyPhusion-operated instance.

> The product-wide commitment this policy is written against is
> [`PRIVACY-COMMITMENT.md`](PRIVACY-COMMITMENT.md), a pointer to the canonical copy at the
> constellation hub. Slate is **self-host only**: Skyphusion Labs ships the code and does not run
> Slate as a service, so the operator of an instance holds its data and carries the controller's
> duties.

## What Slate is

Slate is an AI assistant that participates in a Discord channel to help a team plan and develop
films. It reads conversation in the channels it is added to, maintains a structured "storyboard
brief" in the background, generates images, searches the web, and submits projects to the Vivijure
render pipeline. To do this it uses the Discord **Message Content** intent, which means it can read
the text of messages in the channels where it is active.

## Data Slate processes

- **Message content** in channels Slate is configured to listen in, plus direct messages to the bot
  and messages that @mention it. This is used as the input to the AI model and to build the
  storyboard brief.
- **Discord identifiers and display names** as they appear in conversation (so Slate can address
  people and attribute lines), and **channel IDs** (used as the key for a project's stored state).
- **Image attachments** you post (mood boards, reference stills, concept art). These are fetched
  from Discord's CDN over HTTPS and passed to the AI model for the current turn only. They are
  **not** written to disk and **not** stored in the conversation history (only a text placeholder
  is stored).
- **Storyboard data** that Slate derives from the conversation: the storyboard brief, a rolling
  window of recent conversation history, a brief "undo" history, and pending render jobs.
- **Knowledge base entries** you add with `!learn` (text or fetched URL content), which are embedded
  and stored for later semantic recall.

## Where the data goes (subprocessors)

To provide the service, Slate sends data to the following third parties:

| Provider | What is sent | Why |
|----------|--------------|-----|
| **Anthropic** (Claude, via Cloudflare AI Gateway) | message content, attached images | generate the assistant's responses |
| **Cloudflare** (D1, Vectorize, AI Gateway, Browser Rendering) | storyboard state, knowledge entries, fetched pages | storage, embeddings, model routing, headless page fetches |
| **Brave Search** and **Tavily** | search queries the model chooses to run | web search and research |
| **skyphusion-llm-public** | image generation prompts | character portraits and scene thumbnails |
| **Vivijure API** | storyboard bundle, cast data | render submission and cast sync |

If the operator runs Slate in its **ollama fallback** mode (no Cloudflare AI Gateway token), message
content is sent to a self-hosted model instead of Anthropic, and image attachments are reduced to a
text placeholder.

Slate does **not** sell your data or use it for advertising.

## Storage and retention

- Project state (brief, recent history, undo stack, render jobs) is stored in **Cloudflare D1**,
  scoped per Discord channel. It persists so the project survives a restart.
- Knowledge base entries are stored in **Cloudflare Vectorize** until removed.
- `!reset` clears the calling channel's project and conversation state.
- To request deletion of a channel's stored data or knowledge entries, contact the operator (below).

## Data scoping and security

- D1 session data is scoped per Discord channel ID; Slate does not read another channel's project.
- Secrets and API tokens are never stored in conversation data. See
  [SECURITY.md](SECURITY.md) for the security design and how to report a vulnerability.

## Children

Slate is not directed to children. You must meet Discord's minimum age (at least 13, or older where
your jurisdiction requires) to use Discord and therefore Slate.

## Changes to this policy

We may update this policy as Slate evolves. Material changes will be noted in
[CHANGELOG.md](CHANGELOG.md) and reflected in the effective date above.

## Contact

Questions or data-deletion requests: **conrad@skyphusion.org**, subject
`[PRIVACY] skyphusion-slate`.
