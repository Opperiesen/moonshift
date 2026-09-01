import { createFixtureControlPlane } from '../../apps/control-plane/src/index.js';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { expect, test } from './fixtures.js';

const bootstrapSecret = 'u'.repeat(48);
const origin = 'http://127.0.0.1:4179';
const supervisorId = '76000000-0000-4000-8000-000000000001';
let controlPlane: ReturnType<typeof createFixtureControlPlane>;
let vite: ViteDevServer;

test.beforeAll(async () => {
  controlPlane = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  await controlPlane.server.listen({ host: '127.0.0.1', port: 4316 });
  vite = await createViteServer({
    root: 'apps/web',
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 4179,
      strictPort: true,
      proxy: { '/v1': 'http://127.0.0.1:4316' },
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

async function createVerifiedFixture(
  page: import('@playwright/test').Page,
  disposition: 'PASS' | 'FAIL' = 'PASS',
): Promise<string> {
  await page.goto(`${origin}/#bootstrap=${bootstrapSecret}`);
  await page
    .getByLabel('Software objective')
    .fill('Publish a complete deterministic result and audit trail');
  await page.getByRole('button', { name: 'Start project' }).click();
  const projectId = controlPlane.repository.ids()[0];
  if (projectId === undefined) throw new Error('Expected fixture project');
  controlPlane.verification.setFixtureDisposition(projectId, disposition);

  const initial = await controlPlane.repository.get(projectId);
  if (initial === null) throw new Error('Expected initial fixture project');
  await controlPlane.supervision.controlProject({
    actorId: supervisorId,
    projectId,
    command: 'PAUSE',
    reason: 'Capture a recovery checkpoint for complete result inspection',
    expectedVersion: initial.view.version,
    idempotencyKey: 'results-audit-pause',
    correlationId: '76000000-0000-4000-8000-000000000002',
  });
  const paused = await controlPlane.repository.get(projectId);
  if (paused === null) throw new Error('Expected paused fixture project');
  await controlPlane.supervision.controlProject({
    actorId: supervisorId,
    projectId,
    command: 'RESUME',
    reason: 'Resume the fixture while retaining its recovery history',
    expectedVersion: paused.view.version,
    idempotencyKey: 'results-audit-resume',
    correlationId: '76000000-0000-4000-8000-000000000003',
  });

  await page.getByRole('button', { name: 'Supervise' }).click();
  await page.getByLabel('Decision reason').fill('Approve the exact deterministic fixture action');
  await page.getByRole('button', { name: 'Approve action' }).click();
  await expect(page.getByRole('status')).toContainText('Approval recorded');
  await page.getByRole('button', { name: 'Results' }).click();
  await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
  await expect(page.getByTestId('results-status')).toHaveText('Results ready');
  return projectId;
}

async function resultView(page: import('@playwright/test').Page, projectId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/v1/projects/${encodeURIComponent(id)}/results`);
    if (!response.ok) throw new Error(`Unable to load fixture results: ${response.status}`);
    return response.json();
  }, projectId) as Promise<{
    task: { taskId: string };
    artifacts: Array<{ artifactId: string; executionId: string }>;
    evidence: Array<{ evidenceId: string }>;
    approvals: Array<{ approvalId: string }>;
    executions: Array<{
      executionId: string;
      backendConnectionId: string;
      modelDescriptorId: string;
      modelDescriptorVersion: number;
    }>;
    checkpoints: Array<{ checkpointId: string }>;
    effects: Array<{ effectId: string }>;
    organizationLineage: { authorAgentId: string; authorLineageId: string };
    blockedReasons: string[];
    recovery: { state: string; progress: string };
    audit: Array<{
      auditEventId: string;
      projectEventId: string;
      sequence: number;
      action: string;
    }>;
  }>;
}

test('reconnects to a complete linked Results surface with durable provenance and ordered audit history', async ({
  page,
}) => {
  const projectId = await createVerifiedFixture(page);
  const beforeReload = await resultView(page, projectId);
  await expect(page.getByTestId('verification-state')).toHaveText('Verified');

  // Every durable record identity must remain visible and linked from one result surface.
  await expect(page.getByRole('region', { name: 'Result records' })).toBeVisible();
  for (const id of [
    beforeReload.task.taskId,
    beforeReload.artifacts[0]?.artifactId,
    beforeReload.evidence[0]?.evidenceId,
    beforeReload.approvals[0]?.approvalId,
    beforeReload.executions[0]?.executionId,
    beforeReload.checkpoints[0]?.checkpointId,
    beforeReload.effects[0]?.effectId,
    beforeReload.organizationLineage.authorAgentId,
    beforeReload.organizationLineage.authorLineageId,
    beforeReload.audit[0]?.auditEventId,
  ]) {
    if (id === undefined) throw new Error('Expected complete fixture record');
    await expect(page.getByText(id, { exact: false }).first()).toBeVisible();
  }

  const execution = beforeReload.executions[0];
  if (execution === undefined) throw new Error('Expected execution provenance');
  await expect(page.getByTestId('execution-provenance')).toContainText(
    execution.backendConnectionId,
  );
  await expect(page.getByTestId('execution-provenance')).toContainText(execution.modelDescriptorId);
  await expect(page.getByTestId('execution-provenance')).toContainText(
    `v${execution.modelDescriptorVersion}`,
  );

  const timeline = page.getByRole('region', { name: 'Audit timeline' });
  await expect(timeline).toBeVisible();
  const auditItems = timeline.getByRole('listitem');
  const sequences = await auditItems.evaluateAll((items) =>
    items.map((item) => Number(item.getAttribute('data-sequence'))),
  );
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  expect(new Set(sequences).size).toBe(sequences.length);

  // A browser reconnect must reconstruct the same projection, not a second copy of the history.
  await page.reload();
  await page.getByRole('button', { name: 'Results' }).click();
  await expect(page.getByTestId('results-status')).toHaveText('Results ready');
  const afterReload = await resultView(page, projectId);
  expect(afterReload.audit.map((item) => item.auditEventId)).toEqual(
    beforeReload.audit.map((item) => item.auditEventId),
  );
  await expect(page.getByTestId('verified-flag')).toHaveText('Verified: Yes');
});

test('reloads the durable Results projection after an expired activity cursor without duplicates', async ({
  page,
}) => {
  const projectId = await createVerifiedFixture(page);
  await page.getByRole('button', { name: 'Observe' }).click();
  await expect(page.getByText('Connection: Live')).toBeVisible();
  const record = await controlPlane.repository.get(projectId);
  if (record === null) throw new Error('Expected durable fixture record');
  await page.getByRole('button', { name: 'Results' }).click();
  await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();

  controlPlane.repository.appendFixtureNotice(
    projectId,
    'Result projection survived cursor expiry',
  );
  controlPlane.repository.expireBefore(projectId, record.view.lastSequence + 2);
  await page.getByRole('button', { name: 'Observe' }).click();
  await expect(page.getByText('Connection: Reloaded after expired cursor')).toBeVisible();

  const durable = await resultView(page, projectId);
  const activityItems = page.getByRole('log', { name: 'Project activity' }).getByRole('listitem');
  const activityEventIds = await activityItems.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-event-id')),
  );
  expect(activityEventIds).toEqual(durable.audit.map(({ projectEventId }) => projectEventId));
  expect(new Set(activityEventIds).size).toBe(activityEventIds.length);

  await page.getByRole('button', { name: 'Results' }).click();
  await expect(page.getByRole('region', { name: 'Audit timeline' })).toBeVisible();
  const auditItems = page.getByRole('region', { name: 'Audit timeline' }).getByRole('listitem');
  const eventIds = await auditItems.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-event-id')),
  );
  expect(eventIds.every((id) => id !== null)).toBe(true);
  expect(new Set(eventIds).size).toBe(eventIds.length);
});

test('renders truthful suspended, stopping, stopped, failed, cancelled, and blocked summaries', async ({
  page,
}) => {
  const projectId = await createVerifiedFixture(page);
  for (const state of ['SUSPENDED', 'STOPPING', 'STOPPED', 'FAILED', 'CANCELLED'] as const) {
    controlPlane.repository.setFixtureExecutionState(projectId, state);
    await page.getByRole('button', { name: 'Refresh results' }).click();
    await expect(page.getByTestId('result-state-summary')).toContainText(state);
    await expect(page.getByTestId('result-state-summary')).not.toContainText('Completed');
    await expect(page.getByTestId('verified-flag')).toHaveText('Verified: No');
  }
  controlPlane.repository.setFixtureExecutionState(projectId, 'LOST');
  await page.getByRole('button', { name: 'Refresh results' }).click();
  await expect(page.getByTestId('result-state-summary')).toContainText('BLOCKED');
  await expect(page.getByTestId('verified-flag')).toHaveText('Verified: No');
  await expect(page.getByTestId('blocking-reasons')).not.toContainText('No blocking reasons');
});

test('renders authoritative verification blockers and recovery progress', async ({ page }) => {
  const projectId = await createVerifiedFixture(page, 'FAIL');
  const result = await resultView(page, projectId);
  expect(result.blockedReasons).not.toHaveLength(0);
  await expect(page.getByTestId('result-state-summary')).toContainText('BLOCKED');
  await expect(page.getByTestId('verified-flag')).toHaveText('Verified: No');
  for (const reason of result.blockedReasons) {
    await expect(page.getByTestId('blocking-reasons')).toContainText(reason);
  }
  await expect(page.getByTestId('recovery-summary')).toContainText(result.recovery.progress);
});
