import { describe, it } from 'vitest';

describe('Slate Orchestrated Studio Suite', () => {
  it('should verify bot initialization loops', async () => {
    process.env.DISCORD_TOKEN = 'mock-discord-token';
    process.env.ANTHROPIC_API_KEY = 'mock-anthropic-key';

    process.env.LOG_SECRET = 'mock-log-secret-16+';
    process.env.LOG_WORKER_URL = 'http://localhost:8787';
    // Leave SEARCH_WORKER_URL unset so search stays disabled (no mock capability secrets).

    await import('./bot.mjs');
  });
});
