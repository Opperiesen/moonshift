import { createFixtureControlPlane } from '../../apps/control-plane/src/index.js';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { expect, test } from './fixtures.js';

const bootstrapSecret = 'w'.repeat(48);
const origin = 'http://127.0.0.1:4175';
const supervisorId = '75000000-0000-4000-8000-000000000001';
let controlPlane: ReturnType<typeof createFixtureControlPlane>;
let vite: ViteDevServer;

test.beforeAll(async () => {
  controlPlane = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  await controlPlane.server.listen({ host: '127.0.0.1', port: 4312 });
  vite = await createViteServer({
    root: 'apps/web',
    cacheDir: 'node_modules/.vite-acceptance-verification',
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 4175,
      strictPort: true,
      proxy: { '/v1': 'http://127.0.0.1:4312' },
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

async function openResult(
  page: import('@playwright/test').Page,
  disposition: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'WRONG_LINEAGE' | 'TAMPERED' | 'STALE',
) {
  await page.goto(`${origin}/#bootstrap=${bootstrapSecret}`);
  await page
    .getByLabel('Software objective')
    .fill('Publish and independently verify one deterministic fixture artifact');
  await page.getByRole('button', { name: 'Start project' }).click();
  const projectId = controlPlane.repository.ids()[0];
  if (projectId === undefined) throw new Error('Expected fixture project');
  controlPlane.verification.setFixtureDisposition(projectId, disposition);
  await page.getByRole('button', { name: 'Supervise' }).click();
  await page.getByLabel('Decision reason').fill('Approve the exact deterministic fixture action');
  await page.getByRole('button', { name: 'Approve action' }).click();
  await expect(page.getByRole('status')).toContainText('Approval recorded');
  await page.getByRole('button', { name: 'Results' }).click();
  await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
  await expect(page.getByTestId('results-status')).not.toContainText('Loading');
}

test('shows a passing revision as VERIFIED with independent Quality lineage', async ({ page }) => {
  await openResult(page, 'PASS');
  await expect(page.getByTestId('verification-state')).toHaveText('Verified');
  await expect(page.getByTestId('artifact-integrity')).toContainText('Integrity matched');
  await expect(page.getByTestId('reviewer-lineage')).toContainText('Independent review: Yes');
  await expect(page.getByRole('table', { name: 'Evidence matrix' })).toContainText('PASS');
  await expect(page.getByTestId('blocking-reasons')).toContainText('No blocking reasons');
});

test('shows failing evidence and explicit remediation without completion inflation', async ({
  page,
}) => {
  await openResult(page, 'FAIL');
  await expect(page.getByTestId('verification-state')).toHaveText('Blocked');
  await expect(page.getByRole('table', { name: 'Evidence matrix' })).toContainText('FAIL');
  await expect(page.getByTestId('blocking-reasons')).toContainText(
    'Required TEST evidence did not pass',
  );
  await expect(page.getByTestId('verified-flag')).toHaveText('Verified: No');
});

test('keeps a specialist claim visibly unverified until Quality evaluates it', async ({ page }) => {
  await openResult(page, 'UNVERIFIED');
  await expect(page.getByTestId('verification-state')).toHaveText('Claimed complete');
  await expect(page.getByTestId('verified-flag')).toHaveText('Verified: No');
  await expect(page.getByTestId('reviewer-lineage')).toContainText('Reviewer not assigned');
  await expect(page.getByTestId('blocking-reasons')).toContainText(
    'Awaiting independent verification',
  );
});

test('rejects review from the authoring lineage and exposes that lineage', async ({ page }) => {
  await openResult(page, 'WRONG_LINEAGE');
  await expect(page.getByTestId('verification-state')).toHaveText('Blocked');
  await expect(page.getByTestId('reviewer-lineage')).toContainText('Independent review: No');
  await expect(page.getByTestId('blocking-reasons')).toContainText(
    'Quality reviewer must be outside the author lineage',
  );
});

test('shows tampered integrity evidence as blocked rather than verified', async ({ page }) => {
  await openResult(page, 'TAMPERED');
  await expect(page.getByTestId('verification-state')).toHaveText('Blocked');
  await expect(page.getByTestId('artifact-integrity')).toContainText('Integrity mismatch');
  await expect(page.getByTestId('blocking-reasons')).toContainText(
    'Artifact integrity evidence does not match the published content hash',
  );
});

test('shows a stale compare-and-commit decision as requiring reevaluation', async ({ page }) => {
  await openResult(page, 'STALE');
  await expect(page.getByTestId('verification-state')).toHaveText('Stale · reevaluation required');
  await expect(page.getByTestId('verified-flag')).toHaveText('Verified: No');
  await expect(page.getByTestId('blocking-reasons')).toContainText(
    'Evidence membership changed after snapshot capture',
  );
});
