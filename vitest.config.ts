import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000,
    coverage: {
      provider: 'istanbul',
      reporter: ['cobertura'],
      reportsDirectory: './coverage'
    }
  }
});
