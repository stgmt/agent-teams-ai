import { defineConfig } from 'vitest/config';

import baseConfig from './vitest.config';

// L3: the real app, the real runtime and real models in a sandbox team. Slow and billed, so
// it is never part of `pnpm test`; run it with `pnpm test:live`. No setup file: test/setup.ts
// is for the unit suites (happy-dom, console guards).
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    globals: true,
    environment: 'node',
    include: ['test/live/**/*.live.test.ts'],
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 15 * 60 * 1000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
