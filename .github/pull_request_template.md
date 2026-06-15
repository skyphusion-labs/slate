<!-- CONTRIBUTING.md references this template. Keep it short and factual. -->

## What changed

<!-- A clear summary of the change. -->

## Why

<!-- The motivation / the problem this solves. Link the issue: Closes #NN -->

## How it was tested

<!-- Slate has no unit suite for the bot (too coupled to live Discord + APIs); verify against a
     test channel. For the search Worker, `npm run typecheck` is the gate, plus `wrangler dev`. -->

- [ ] `node --check bot.mjs` passes
- [ ] `cd search-worker && npm run typecheck` passes (if the Worker changed)
- [ ] Verified manually in a Discord test channel (if the bot changed)

## Notes

- [ ] No secrets committed (`.env` stays out of git)
- [ ] No em-dashes / en-dashes in new source, comments, or docs (house style)
