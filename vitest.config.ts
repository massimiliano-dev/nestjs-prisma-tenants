import { defineConfig } from 'vitest/config';

// The "@massimiliano-dev/source" export condition maps workspace packages to their TypeScript sources,
// so tests never depend on a previous build.
const conditions = ['@massimiliano-dev/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/*/test/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
