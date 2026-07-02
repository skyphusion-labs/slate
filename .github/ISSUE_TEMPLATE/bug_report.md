---
name: Bug report
about: Something in Slate or the search Worker is not behaving
title: 'bug: '
labels: bug
---

**What happened**
A clear description of the bug.

**Expected**
What you expected instead.

**Repro**
Steps, the command used (`!brief`, `/render`, ...), and the channel context if relevant.

**Environment**
- Backend: Claude (CF AI Gateway) or ollama fallback?
- Where: the production container, local `node bot.mjs`, or the `slate-search` Worker?

**Logs**
Relevant lines from the bot log or `wrangler tail` (redact tokens).
