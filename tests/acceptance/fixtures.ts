import { test as base } from '@playwright/test';

export const test = base.extend<{ fixtureScenario: string }>({
  fixtureScenario: [
    async ({}, use) => use(process.env.MOONSHIFT_SCENARIO ?? 'PASS'),
    { option: true },
  ],
});

export { expect } from '@playwright/test';
