import { defineConfig } from 'vitest/config';

// Root tests cover src/ only. packages/* run their own tests (npm run test:all).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // The engine loads shared knowledge packs from ~/.firelab/knowledge by default: tests must not depend on them.
    env: { FIRELAB_NO_KNOWLEDGE: '1' },
  },
});
