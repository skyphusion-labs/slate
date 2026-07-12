# Contributing to Slate

Slate is developed under the SkyPhusion AI-collaborative model: human vision drives the roadmap; Claude (as Strummer) handles implementation. External contributions are welcome, but please read this first.

## How to Contribute

1. **Open an issue before writing code.** Describe the bug or feature. This avoids duplicate work and lets us discuss the right approach.
2. **Fork the repo and create a branch** from `main`. Branch names: `fix/<thing>`, `feat/<thing>`, `ci/<thing>`.
3. **Write your changes.** See the development setup below.
4. **Open a pull request** against `main`. Fill in the PR template -- what changed, why, and how you tested it.

## Development Setup

### Discord bot

```bash
npm install
cp stacks/compose.prod.yml .          # reference for required env vars
# create a local .env with your test bot token + channel IDs
node bot.mjs
```

There is no integration test suite for the full Discord bot (too tightly coupled to live Discord
and external APIs). Automated coverage:

```bash
npm test             # lib.mjs + registry.mjs + contract conformance (69 routes)
npm run lint         # node --check bot.mjs
```

If you add or change a Vivijure studio API surface, update `contract.mjs` first; `contract.test.ts`
is the zero-drift gate. See [docs/CONTRACT-conformance.md](docs/CONTRACT-conformance.md).

Verify bot behavior manually against a test channel after changes to `bot.mjs`.

### slate-search Worker

```bash
cd search-worker
npm install
npm run typecheck    # must pass before any PR
npm run dev          # local wrangler dev server
npm run deploy       # deploy to Cloudflare
```

**`npm run typecheck` is the CI gate.** TypeScript errors are not caught by `wrangler dev`, so always run it before pushing.

## Code Style

- **No em-dashes (U+2014) or en-dashes (U+2013).** Use commas, semicolons, or parentheses instead. This is a hard lint rule across all SkyPhusion repos.
- Minimal dependencies. The bot uses only `discord.js` and `@anthropic-ai/sdk`. Do not add framework dependencies.
- No build step for the bot (`bot.mjs` is plain ESM, runs directly with `node`).
- No comments that describe *what* the code does -- only comments that explain *why* (hidden constraints, non-obvious invariants). No multi-line comment blocks.
- Secrets never in source. All runtime config via environment variables.

## Conventional Commits

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(scope): short description of what was fixed
feat(scope): short description of what was added
ci(scope): CI or deployment changes
docs: documentation only
chore: dependency updates, housekeeping
```

Body explains the *why*; keep it factual. One scoped commit per PR where practical.

## What We're Looking For

Good contributions:
- Bug fixes with a clear reproduction case
- New image model entries in the `IMAGE_MODELS` catalog (alias + full ID + label)
- Improvements to the `SYSTEM_PROMPT` that make Slate a better creative collaborator
- Additional search tool integrations in the `slate-search` Worker
- Documentation improvements

Less likely to merge:
- Large refactors without prior discussion
- New runtime dependencies
- Features that duplicate existing commands or Claude's autonomous capabilities
- Changes that break the ollama fallback path

## Licensing

By contributing, you agree that your contributions are licensed under AGPL-3.0, the same license as this project. See [LICENSE](LICENSE).

## Sign your work (Developer Certificate of Origin)

Sign off every commit with `git commit -s`. That appends a `Signed-off-by:` line certifying the
[Developer Certificate of Origin](https://developercertificate.org/) (DCO): a lightweight,
per-commit affirmation that you wrote the patch or otherwise have the right to submit it under the
project's license. We use the DCO instead of a CLA. The name and email must be real and match the
commit author; unsigned commits may be asked to amend with `git commit --amend -s` (or
`git rebase --signoff` for a series) before merge.
