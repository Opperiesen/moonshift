import { createFixtureControlPlane } from '../../apps/control-plane/src/index.js';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { expect, test } from './fixtures.js';

const bootstrapSecret = 'u'.repeat(48);
const origin = 'http://127.0.0.1:4174';
const supervisorId = '63000000-0000-4000-8000-000000000001';
let controlPlane: ReturnType<typeof createFixtureControlPlane>;
let vite: ViteDevServer;

test.beforeAll(async () => {
  controlPlane = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  await controlPlane.server.listen({ host: '127.0.0.1', port: 4311 });
  vite = await createViteServer({
    root: 'apps/web',
    cacheDir: 'node_modules/.vite-acceptance-supervise',
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 4174,
      strictPort: true,
      proxy: { '/v1': 'http://127.0.0.1:4311' },
    },
  });
  await vite.listen();
});

test.afterAll(async () => {
  await vite?.close();
  await controlPlane?.server.close();
});

test.beforeEach(async () => {
  controlPlane.repository.clear();
  controlPlane.sessions.reset(bootstrapSecret);
  controlPlane.scheduler.setFixtureCapacity({});
  controlPlane.resetTime();
});

async function startAndSupervise(page: import('@playwright/test').Page) {
  await page.goto(`${origin}/#bootstrap=${bootstrapSecret}`);
  await page
    .getByLabel('Software objective')
    .fill('Apply one approval-gated deterministic fixture marker');
  await page.getByRole('button', { name: 'Start project' }).click();
  await page.getByRole('button', { name: 'Supervise' }).click();
  await expect(page.getByRole('heading', { name: 'Supervise' })).toBeVisible();
}

test('shows immutable approval detail and applies an approved effect exactly once', async ({
  page,
}) => {
  await startAndSupervise(page);
  await expect(page.getByTestId('approval-digest')).toContainText('sha256:');
  await expect(page.getByText('fixture:repository/approved-marker')).toBeVisible();
  await expect(page.getByText(/Requester:/)).toBeVisible();
  await expect(page.getByText(/Risk:/)).toBeVisible();
  await expect(page.getByTestId('supervision-budget')).toContainText('1 invocation remaining');
  await page.getByLabel('Decision reason').fill('The exact deterministic marker is approved');
  await page.getByRole('button', { name: 'Approve action' }).click();
  await expect(page.getByRole('status')).toContainText('Approval recorded');
  await expect(page.getByTestId('effect-state')).toHaveText('Applied');
  await expect(page.getByTestId('supervision-budget')).toContainText('0 invocations remaining');
});

test('rejects or expires approval without applying the effect and exposes the blocked reason', async ({
  page,
}) => {
  await startAndSupervise(page);
  await page.getByLabel('Decision reason').fill('The effect is not authorized');
  await page.getByRole('button', { name: 'Reject action' }).click();
  await expect(page.getByRole('status')).toContainText('Rejection recorded');
  await expect(page.getByTestId('effect-state')).toHaveText('Not applied');
  await expect(page.getByTestId('blocked-reasons')).toContainText('Approval rejected');

  controlPlane.repository.clear();
  await page.goto(origin);
  await page
    .getByLabel('Software objective')
    .fill('Apply one approval-gated deterministic fixture marker');
  await page.getByRole('button', { name: 'Start project' }).click();
  await page.getByRole('button', { name: 'Supervise' }).click();
  controlPlane.advanceTime(301_000);
  await page.getByRole('button', { name: 'Refresh supervision' }).click();
  await expect(page.getByTestId('approval-state')).toHaveText('Expired');
  await expect(page.getByTestId('effect-state')).toHaveText('Not applied');
});

test('keeps pause, stop, resume, and terminal cancel visibly distinct', async ({ page }) => {
  await startAndSupervise(page);
  await page.getByLabel('Control reason').fill('Inspect the safe checkpoint');
  await page.getByRole('button', { name: 'Pause project' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Paused');
  await expect(page.getByTestId('approval-state')).toHaveText(
    'Requested · unavailable while paused',
  );

  await page.getByRole('button', { name: 'Resume project' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Active');
  await page.getByRole('button', { name: 'Stop project' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Stopped · resumable');
  await expect(page.getByTestId('authority-state')).toContainText('revoked');

  await page.getByRole('button', { name: 'Resume project' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Active');
  await expect(page.getByTestId('authority-state')).toContainText('fresh successor');
  await page.getByRole('button', { name: 'Cancel project' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Cancelled · terminal');
  await expect(page.getByRole('button', { name: 'Resume project' })).toBeDisabled();
});
