# Security Policy

## Supported Versions

Slate is pre-1.0 software under active development. Security fixes are applied to the `main` branch only.

| Version | Supported |
|---------|-----------|
| `main`  | Yes |
| older tags | No |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately to **security@skyphusion.org** (subject line:
`[SECURITY] slate -- <brief description>`). If you would rather use GitHub, open the repository's
**Security** tab and click **"Report a vulnerability"** to file a private advisory that only you and
the maintainers can see.

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if safe to share)
- Any suggested mitigations

What to expect:

- **Acknowledgment** within a reasonable window (target: 5 business days).
- A **fix** in the latest `main` once we confirm the issue; time-sensitive reports should say so.
- **Credit** for your report when the fix ships, unless you would rather stay anonymous.

Please give us a chance to ship a fix before any public disclosure.

## Scope

In scope:
- Secrets/credentials exposed via the bot, Worker, or repository
- Authentication bypass on the `vivijure-search` Worker (`X-Search-Secret` header)
- Prompt injection attacks that cause the bot to exfiltrate secrets or take unintended actions
- D1 session data exposure or cross-channel data leakage
- Vectorize knowledge base pollution via unauthenticated writes

Out of scope:
- Denial-of-service via Discord rate limits or model quota exhaustion
- Social engineering of the Discord bot's conversation responses
- Issues in third-party services (Discord, Cloudflare, Anthropic, Brave, Tavily)

## Security Design Notes

- **Secrets are never committed.** The `.gitignore` excludes `stacks/.env` and all credential files. Cloudflare Worker secrets are set via `wrangler secret put`, not in `wrangler.toml`.
- **`X-Search-Secret` header** authenticates all requests from the Discord bot to the `vivijure-search` Worker. This should be a long random string.
- **Cloudflare Access service token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) gates all requests to the Vivijure API and the skyphusion-llm-public image generation API.
- **D1 session data** is scoped per Discord channel ID. No cross-channel reads occur.
- **Image attachments** are fetched directly from Discord's CDN over HTTPS, base64-encoded for the current turn, and never persisted to disk or D1.
