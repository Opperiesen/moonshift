import { createFixtureControlPlane } from '../../apps/control-plane/src/index.js';
import { PRESENCE_SOURCE_TYPES, PRESENCE_STATES } from '../../packages/contracts/src/index.js';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

import { expect, test } from './fixtures.js';

const bootstrapSecret = 'c'.repeat(48);
const origin = 'http://127.0.0.1:4173';
const supervisorId = '50000000-0000-4000-8000-000000000001';
let controlPlane: ReturnType<typeof createFixtureControlPlane>;
let vite: ViteDevServer;

test.beforeAll(async () => {
  controlPlane = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  await controlPlane.server.listen({ host: '127.0.0.1', port: 4310 });
  vite = await createViteServer({
    root: 'apps/web',
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: { '/v1': 'http://127.0.0.1:4310' },
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
});

test('submits one objective and observes the bounded organization plus replayed activity', async ({
  page,
}) => {
  await page.goto(`/#bootstrap=${bootstrapSecret}`);
  await expect(page).toHaveURL(origin + '/');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page
    .getByLabel('Software objective')
    .fill('Create a deterministic release-note artifact for the fixture');
  await page.getByRole('button', { name: 'Start project' }).click();

  await expect(page.getByRole('status')).toContainText('Project active');
  await expect(page.getByRole('heading', { name: 'Observe' })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Organization' })).toContainText('Product');
  await expect(page.getByRole('tree', { name: 'Organization' })).toContainText('Engineering');
  await expect(page.getByRole('tree', { name: 'Organization' })).toContainText('Quality');
  await expect(page.getByRole('tree', { name: 'Organization' })).toContainText(
    'Release-note specialist',
  );
  await expect(page.getByRole('tree', { name: 'Channels' })).toContainText('Implementation');
  await expect(page.getByRole('region', { name: 'Tasks and dependencies' })).toContainText(
    'Waiting for approval',
  );
  await expect(page.getByTestId('queue-reason')).toHaveText('Waiting for approval');
  await expect(page.getByRole('log', { name: 'Project activity' })).toContainText(
    'Deterministic fixture execution started',
  );
  const activityItems = page.getByRole('log', { name: 'Project activity' }).getByRole('listitem');
  expect(await activityItems.count()).toBeGreaterThan(4);
  const sequences = await activityItems.evaluateAll((items) =>
    items.map((item) => Number(item.getAttribute('data-sequence'))),
  );
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  await expect(page.getByText('Connection: Live')).toBeVisible();
  const projectId = controlPlane.repository.ids()[0];
  if (projectId === undefined) throw new Error('Expected project');
  controlPlane.repository.appendFixtureNotice(projectId, 'Live fixture update observed');
  await expect(page.getByRole('log', { name: 'Project activity' })).toContainText(
    'Live fixture update observed',
  );
});

test('shows actionable validation without creating a partial project', async ({ page }) => {
  await page.goto(`/#bootstrap=${bootstrapSecret}`);
  await page.getByLabel('Software objective').fill('   ');
  await page.getByRole('button', { name: 'Start project' }).click();
  await expect(page.getByRole('alert')).toContainText('Enter an objective');
  expect(controlPlane.repository.size()).toBe(0);

  controlPlane.scheduler.setFixtureCapacity({ activeSpecialists: 4 });
  await page.getByLabel('Software objective').fill('Create a bounded fixture project');
  await page.getByRole('button', { name: 'Start project' }).click();
  await expect(page.getByRole('alert')).toContainText('specialist capacity is exhausted');
  expect(controlPlane.repository.size()).toBe(0);
});

test('shows whether queued work waits for cognitive or runner capacity', async ({ page }) => {
  await page.goto(`/#bootstrap=${bootstrapSecret}`);
  for (const fixture of [
    { activeCognitiveRuns: 3, expected: 'Waiting for cognitive capacity' },
    { activeRunnerJobs: 1, expected: 'Waiting for runner capacity' },
  ]) {
    controlPlane.repository.clear();
    controlPlane.scheduler.setFixtureCapacity(fixture);
    await page.goto('/');
    await page
      .getByLabel('Software objective')
      .fill('Create a deterministic release-note artifact for the fixture');
    await page.getByRole('button', { name: 'Start project' }).click();
    await expect(page.getByTestId('queue-reason')).toHaveText(fixture.expected);
    await expect(page.getByTestId('fixture-specialist-presence')).toContainText('QUEUED');
    await expect(page.getByTestId('fixture-specialist-presence')).toContainText('CAPACITY');
  }
});

test('renders every defined presence state with a bounded durable source', async ({ page }) => {
  await page.goto(`/#bootstrap=${bootstrapSecret}`);
  await page
    .getByLabel('Software objective')
    .fill('Create a deterministic release-note artifact for the fixture');
  await page.getByRole('button', { name: 'Start project' }).click();
  const projectId = controlPlane.repository.ids()[0];
  if (projectId === undefined) throw new Error('Expected project');

  for (let index = 0; index < PRESENCE_STATES.length; index += 1) {
    const state = PRESENCE_STATES[index];
    const sourceType = PRESENCE_SOURCE_TYPES[index % PRESENCE_SOURCE_TYPES.length];
    if (state === undefined || sourceType === undefined)
      throw new Error('Presence fixture missing');
    controlPlane.repository.setFixturePresence(projectId, state, sourceType);
    await page.getByRole('button', { name: 'Reload durable view' }).click();
    await expect(page.getByTestId('fixture-specialist-presence')).toContainText(
      state.replaceAll('_', ' '),
    );
    await expect(page.getByTestId('fixture-specialist-presence')).toContainText(sourceType);
  }
});

test('reloads ProjectView when retention overtakes a live stream before resubscription', async ({
  page,
}) => {
  await page.goto(`/#bootstrap=${bootstrapSecret}`);
  await page
    .getByLabel('Software objective')
    .fill('Create a deterministic release-note artifact for the fixture');
  await page.getByRole('button', { name: 'Start project' }).click();
  const projectId = controlPlane.repository.ids()[0];
  if (projectId === undefined) throw new Error('Expected project');
  await expect(page.getByText('Connection: Live')).toBeVisible();
  await expect(page.getByRole('log', { name: 'Project activity' })).toContainText(
    'Deterministic fixture execution started',
  );
  const record = await controlPlane.repository.get(projectId);
  if (record === null) throw new Error('Expected durable project view');
  controlPlane.repository.appendFixtureNotice(projectId, 'Event overtaken by fixture retention');
  controlPlane.repository.expireBefore(projectId, record.view.lastSequence + 2);
  await expect(page.getByText('Connection: Reloaded after expired cursor')).toBeVisible();
  await expect(page.getByRole('log', { name: 'Project activity' })).not.toContainText(
    'Duplicate event',
  );
  await expect(page.getByTestId('fixture-specialist-presence')).toContainText(
    'WAITING FOR APPROVAL',
  );
});
