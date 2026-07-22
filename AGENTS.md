# AGENTS.md

## Cursor Cloud specific instructions

Standard scripts are in `package.json` (and `CLAUDE.md`). Non-obvious VM gotchas:

- **Requires Node 24** (`engines.node >=24`). The VM's default `node` is a wrapper
  (`/exec-daemon/node`, v22.14) that shadows nvm, so put Node 24 (installed via nvm
  by the environment update script) first on PATH:
  `export PATH="$HOME/.nvm/versions/node/v24"*"/bin:$PATH"`.
- `npm run lint` is just `node --check bot.mjs` (syntax check); `npm test` runs vitest.

Verified in this environment (Node 24): `npm ci`, `npm run lint`,
`npm test` (71 passed) all pass.
