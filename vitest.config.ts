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
          include: ['tests/integration/**/*.test.ts'],
        },
      },
      { test: { name: 'recovery', include: ['tests/recovery/**/*.test.ts'] } },
      { test: { name: 'security', include: ['tests/security/**/*.test.ts'] } },
      { test: { name: 'performance', include: ['tests/performance/**/*.test.ts'] } },
    ],
  },
});
