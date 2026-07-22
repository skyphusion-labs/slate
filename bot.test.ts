import { describe, it, expect } from 'vitest';

// Intentionally does not import bot.mjs (that module connects to Discord and
// requires live env). Keep this file free of process.env secret assignments so
// adversarial redaction cannot flag mock tokens as committed credentials.
describe('Slate package surface', () => {
  it('exposes a package name', async () => {
    const pkg = await import('./package.json', { with: { type: 'json' } });
    expect(pkg.default.name).toBe('slate');
  });
});
