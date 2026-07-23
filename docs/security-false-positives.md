# Security audit false positives

Documented dismissals for adversarial-audit (K2.7/K3) findings that are not actionable bugs in this repo's threat model.

## Discord channel trust boundary

Slate's `studio-api.mjs` exposes install-scoped module config and cast operations to authenticated Discord channel users. That is intentional: Slate is a Discord bot for a trusted studio operator channel, not a multi-tenant public API. Cloudflare Access and studio bearer auth gate the upstream studio; the bot token gates who can invoke the bot. Per-user RBAC inside a single-operator Discord guild is out of scope.

## Operator deploy and homelab surfaces

Prod deploy workflows (`deploy.yml`) and compose pins are operator-controlled release artifacts, not tenant-facing attack surfaces. Smoke probes create ephemeral studio rows in a trusted operator channel; observer/RAG indexing is intentional for single-operator Discord guild memory.

## Record

| Date | Audit | Finding | Rationale |
| --- | --- | --- | --- |
| 2026-07-23 | K3 repo | !api surface grants full studio admin to any channel user | Discord guild + bot auth trust boundary; single-operator studio |
| 2026-07-23 | K3 verify ~18:04 | log-worker deploy uses npm install | Operator release workflow; log-worker has no lockfile by design (minimal deps) |
| 2026-07-23 | K3 verify ~18:04 | Stale compose.prod.yml image pin | Operator repins on release; not a runtime vuln |
| 2026-07-23 | K3 verify ~18:04 | Smoke --mutations leaves studio rows | Trusted operator smoke harness; ephemeral `slate-smoke-*` prefix |
| 2026-07-23 | K3 verify ~18:04 | Observer indexes full request bodies | Single-operator guild RAG; MEMORY_CHANNEL_ALLOWLIST gates scope |
