import {
  createControlPlaneServer,
  createFixtureControlPlane,
} from '../../apps/control-plane/src/index.js';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { expect, test } from './fixtures.js';

const bootstrapSecret = 'r'.repeat(48);
const origin = 'http://127.0.0.1:4177';
const supervisorId = '73000000-0000-4000-8000-000000000001';
let controlPlane: ReturnType<typeof createFixtureControlPlane>;
let vite: ViteDevServer;

test.beforeAll(async () => {
  controlPlane = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  await controlPlane.server.listen({ host: '127.0.0.1', port: 4314 });
  vite = await createViteServer({
    root: 'apps/web',
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 4177,
      strictPort: true,
      proxy: { '/v1': 'http://127.0.0.1:4314' },
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

async function startRecoveryProject(page: import('@playwright/test').Page): Promise<string> {
  await page.goto(`${origin}/#bootstrap=${bootstrapSecret}`);
  await page
    .getByLabel('Software objective')
    .fill('Recover the bounded fixture without duplicate work');
  await page.getByRole('button', { name: 'Start project' }).click();
  await page.getByRole('button', { name: 'Supervise' }).click();
  await expect(page.getByRole('heading', { name: 'Supervise' })).toBeVisible();
  const projectId = await page.locator('main').getAttribute('data-project-id');
  if (projectId === null) throw new Error('Expected durable project identity');
  return projectId;
}

async function restartFixtureServer(): Promise<void> {
  await controlPlane.server.close();
  const server = createControlPlaneServer({
    service: controlPlane.service,
    repository: controlPlane.repository,
    supervision: controlPlane.supervision,
    verification: controlPlane.verification,
    sessions: controlPlane.sessions,
  });
  await server.listen({ host: '127.0.0.1', port: 4314 });
  controlPlane = { ...controlPlane, server };
}

test('reconnects after a control-plane restart to a durable paused checkpoint', async ({
  page,
}) => {
  await startRecoveryProject(page);
  await page.getByLabel('Control reason').fill('Inspect recovery checkpoint');
  await page.getByRole('button', { name: 'Pause project' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Paused');
  await expect(page.getByTestId('recovery-checkpoint')).toContainText('sha256:');

  await restartFixtureServer();
  await page.reload();
  await page.getByRole('button', { name: 'Supervise' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Paused');
  await expect(page.getByTestId('recovery-status')).toContainText('Safe checkpoint preserved');

  await page.getByLabel('Control reason').fill('Resume from inspected checkpoint');
  await page.getByRole('button', { name: 'Resume project' }).click();
  await expect(page.getByTestId('project-control-state')).toHaveText('Active');
});

test('shows runtime-loss replanning at the authorization boundary on the second fake backend', async ({
  page,
}) => {
  const projectId = await startRecoveryProject(page);
  const before = await controlPlane.repository.get(projectId);
  if (before === null) throw new Error('Expected project record');

  await controlPlane.recovery.recoverLostRuntime({
    projectId,
    sourceExecutionId: before.supervision.authority.executionId,
    correlationId: '73000000-0000-4000-8000-000000000002',
  });
  await page.getByRole('button', { name: 'Refresh supervision' }).click();

  await expect(page.getByTestId('recovery-status')).toContainText(
    'Replanned on fake-secondary before the effect; supervisor approval is required',
  );
  await expect(page.getByTestId('recovery-checkpoint')).toContainText('sha256:');
  const after = await controlPlane.repository.get(projectId);
  expect(after?.organization.specialist.agentId).toBe(before.organization.specialist.agentId);
  expect(after?.view.tasks[0]?.taskId).toBe(before.view.tasks[0]?.taskId);
  expect(after?.scheduling.execution.executionId).not.toBe(before.scheduling.execution.executionId);
  expect(after?.supervision.effects[0]?.semanticKey).toBe(
    before.supervision.effects[0]?.semanticKey,
  );
  expect(after?.supervision.checkpoint?.continuation).toMatchObject({
    cursor: 'BEFORE_EFFECT',
    nextSequence: 6,
  });
});

test('keeps indeterminate effect recovery blocked with an actionable supervisor message', async ({
  page,
}) => {
  const projectId = await startRecoveryProject(page);
  const record = await controlPlane.repository.get(projectId);
  const effectId = record?.supervision.effects[0]?.effectId;
  if (effectId === undefined) throw new Error('Expected fixture effect');
  controlPlane.repository.setFixtureEffectState(projectId, 'UNKNOWN');
  controlPlane.effectExecutor.setFixtureGroundTruth(effectId, {
    outcome: 'INDETERMINATE',
    groundTruthDigest: null,
  });

  await controlPlane.recovery.recoverLostRuntime({
    projectId,
    sourceExecutionId: record.supervision.authority.executionId,
    correlationId: '73000000-0000-4000-8000-000000000003',
  });
  await page.getByRole('button', { name: 'Refresh supervision' }).click();

  await expect(page.getByTestId('recovery-status')).toContainText('ground truth remains unknown');
  await expect(page.getByTestId('blocked-reasons')).toContainText('remains unknown');
  await expect(
    page.getByText('Inspect the effect ledger, establish ground truth, then retry reconciliation.'),
  ).toBeVisible();
  const blocked = await controlPlane.repository.get(projectId);
  expect(blocked?.supervision.authority.executionState).toBe('RECONCILING');
  expect(blocked?.scheduling.execution.state).toBe('RECONCILING');
  expect(blocked?.supervision.authority.fencingToken).toBe(
    record.supervision.authority.fencingToken + 1,
  );
  expect(
    blocked?.events
      .filter(({ aggregate }) => aggregate.id === effectId)
      .map(({ payload }) => payload.toState),
  ).toEqual(expect.arrayContaining(['RECONCILING', 'UNKNOWN']));
});

test('shows an actionable fail-closed message for invalid durable recovery state', async ({
  page,
}) => {
  const projectId = await startRecoveryProject(page);
  const record = await controlPlane.repository.get(projectId);
  if (record === null) throw new Error('Expected project record');
  await controlPlane.recovery.blockUnrecoverableProject({
    projectId,
    sourceExecutionId: record.supervision.authority.executionId,
    reason: 'Durable checkpoint failed integrity validation',
    correlationId: '73000000-0000-4000-8000-000000000004',
  });
  await page.getByRole('button', { name: 'Refresh supervision' }).click();

  await expect(page.getByTestId('project-control-state')).toHaveText('Blocked');
  await expect(page.getByTestId('recovery-status')).toContainText('checkpoint');
  await expect(page.getByTestId('blocked-reasons')).toContainText('checkpoint');
  await expect(
    page.getByText(
      'Inspect or restore the durable checkpoint and event history before retrying recovery.',
    ),
  ).toBeVisible();
});
