import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    sequence: { concurrent: false },
    pool: 'forks',
    projects: [
      { test: { name: 'unit', include: ['packages/**/src/**/*.test.ts'] } },
      { test: { name: 'contract', include: ['tests/contract/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'tests/recovery/**/*.test.ts'],
        },
      },
    ],
  },
});
