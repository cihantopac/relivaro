import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
      { extends: true, test: { name: 'security', include: ['tests/security/**/*.test.ts'] } },
      { extends: true, test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], fileParallelism: false } },
    ],
  },
});
