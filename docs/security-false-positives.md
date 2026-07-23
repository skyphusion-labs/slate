# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Discord channel trust boundary

Slate's `studio-api.mjs` exposes install-scoped module config and cast operations to authenticated Discord channel users. That is intentional: Slate is a Discord bot for a trusted studio operator channel, not a multi-tenant public API. Cloudflare Access and studio bearer auth gate the upstream studio; the bot token gates who can invoke the bot. Per-user RBAC inside a single-operator Discord guild is out of scope.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 repo | !api surface grants full studio admin to any channel user | Discord guild + bot auth trust boundary; single-operator studio |
