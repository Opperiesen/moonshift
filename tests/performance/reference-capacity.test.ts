import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { chromium } from '@playwright/test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresControlPlane,
  InMemoryApprovedEffectExecutor,
  recoverPostgresDeliveryState,
  recoverPostgresDeliveryStateWithMaintenance,
  type ProjectView,
} from '../../apps/control-plane/src/index.js';
import { FixtureScheduler } from '../../apps/control-plane/src/scheduler/index.js';
import {
  collectProcessResourceSnapshot,
  DEFAULT_FIXTURE_CAPACITY,
  discoverRunnerHost,
  evaluateFixtureEligibility,
  FixtureLeaseRegistry,
} from '../../apps/runner/src/index.js';
import {
  collectPostgresObservability,
  createFixtureBackup,
  restoreFixtureBackup,
  runMigrations,
} from '../../packages/persistence/src/index.js';
import { DEFAULT_POLICY_PROFILE } from '../../packages/policy/src/index.js';
import { createDeterministicUuid } from '../../packages/test-fixtures/src/index.js';
import { materializeSingleProjectCognitiveLoad } from './fixtures/single-project-cognitive-load.js';
import { stopEmbeddedPostgres } from '../fixtures/postgres.js';

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe.sequential('16 GB PVE-equivalent reference capacity', () => {
  const supervisorId = '78000000-0000-4000-8000-000000000001';
  const revision = '7800000000000000000000000000000000000000';
  const databaseUser = 'moonshift_capacity';
  const password = ['fixture', 'postgres', 'capacity'].join('-');
  const restoreDatabase = 'moonshift_capacity_restore';
  let embedded: EmbeddedPostgres;
  let sourcePool: Pool;
  let restorePool: Pool;
  const journeyPools = new Map<number, Pool>();
  let testRoot: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'moonshift-capacity-'));
    const port = await unusedLoopbackPort();
    embedded = new EmbeddedPostgres({
      databaseDir: join(testRoot, 'postgres'),
      port,
      user: databaseUser,
      password,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=20'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    const connection = { host: '127.0.0.1', port, user: databaseUser, password };
    sourcePool = new Pool({ ...connection, database: 'postgres', max: 8 });
    await sourcePool.query(`CREATE DATABASE ${restoreDatabase}`);
    restorePool = new Pool({ ...connection, database: restoreDatabase, max: 4 });
    await runMigrations(sourcePool);
    await runMigrations(restorePool);
    for (const concurrency of [1, 3, 5] as const) {
      const database = `moonshift_capacity_journey_${String(concurrency)}`;
      await sourcePool.query(`CREATE DATABASE ${database}`);
      const pool = new Pool({ ...connection, database, max: concurrency + 1 });
      await runMigrations(pool);
      journeyPools.set(concurrency, pool);
    }
  }, 120_000);

  afterAll(async () => {
    const pools = [...journeyPools.values(), sourcePool, restorePool].filter(
      (pool): pool is Pool => pool !== undefined,
    );
    try {
      await stopEmbeddedPostgres(embedded, pools);
    } finally {
      if (testRoot !== undefined) await rm(testRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('meets one/three/five execution, durability, recovery, and storage envelopes', async () => {
    const profile = JSON.parse(
      await readFile(
        new URL('../../config/observability/reference-capacity.json', import.meta.url),
        'utf8',
      ),
    ) as {
      controlPlane: {
        memoryEnvelopeBytes: number;
        cognitiveRunsDefault: number;
        cognitiveRunsMaximum: number;
      };
      storage: { backupTemporaryBytesMaximum: number; restoreTemporaryBytesMaximum: number };
      goals: {
        eventVisibilityP95MsAtThree: number;
        eventVisibilityP95MsAtFive: number;
        commandDurabilityP95Ms: number;
        restartInspectionMs: number;
      };
    };
    expect(profile.controlPlane).toMatchObject({
      cognitiveRunsDefault: 3,
      cognitiveRunsMaximum: 5,
    });
    expect(
      () =>
        new FixtureScheduler({
          now: () => new Date(),
          nextId: createDeterministicUuid('capacity-invalid-ceiling'),
          expectedRevision: revision,
          cognitiveRunLimit: 6,
        }),
    ).toThrow('constitutional ceiling');

    const eventLatencyByConcurrency: Record<string, readonly number[]> = {};
    const executionEventCountByConcurrency: Record<string, number> = {};
    const queueReasonByConcurrency: Record<string, string> = {};
    const journeyMsByConcurrency: Record<string, number> = {};
    const journeyPostgresByConcurrency: Record<
      string,
      Awaited<ReturnType<typeof collectPostgresObservability>>
    > = {};
    const browser = await chromium.launch();
    try {
      for (const concurrency of [1, 3, 5] as const) {
        const pool = journeyPools.get(concurrency);
        if (pool === undefined) throw new Error('Capacity journey database is unavailable');
        const controlPlanePort = await unusedLoopbackPort();
        const controlPlaneOrigin = `http://127.0.0.1:${String(controlPlanePort)}`;
        const webPort = await unusedLoopbackPort();
        const origin = `http://127.0.0.1:${String(webPort)}`;
        const bootstrapSecret = String(concurrency).repeat(48);
        const cognitiveRunLimit =
          concurrency === profile.controlPlane.cognitiveRunsMaximum
            ? profile.controlPlane.cognitiveRunsMaximum
            : profile.controlPlane.cognitiveRunsDefault;
        const controlPlane = createPostgresControlPlane({
          pool,
          bootstrapSecret,
          origin,
          supervisorId,
          expectedRevision: revision,
          runnerId: `78000000-0000-4000-803${String(concurrency)}-000000000001`,
          nextId: createDeterministicUuid(`capacity-journey-${String(concurrency)}`),
          effectExecutor: new InMemoryApprovedEffectExecutor(),
          artifactRoot: join(testRoot, `journey-${String(concurrency)}-artifacts`),
          ...(concurrency === profile.controlPlane.cognitiveRunsMaximum
            ? { cognitiveRunLimit }
            : {}),
          recoveryScanIntervalMs: 60_000,
        });
        let vite: ViteDevServer | undefined;
        const context = await browser.newContext();
        try {
          await controlPlane.server.listen({ host: '127.0.0.1', port: controlPlanePort });
          const bootstrap = await fetch(`${controlPlaneOrigin}/v1/session/bootstrap`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: JSON.stringify({ bootstrapSecret }),
          });
          expect(bootstrap.status).toBe(204);
          const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
          if (cookie === undefined) throw new Error('Expected journey supervisor session cookie');
          const cookieSeparator = cookie.indexOf('=');
          if (cookieSeparator <= 0) throw new Error('Journey session cookie is malformed');
          vite = await createViteServer({
            root: 'apps/web',
            logLevel: 'silent',
            server: {
              host: '127.0.0.1',
              port: webPort,
              strictPort: true,
              proxy: { '/v1': controlPlaneOrigin },
            },
          });
          await vite.listen();
          await context.addCookies([
            {
              name: cookie.slice(0, cookieSeparator),
              value: cookie.slice(cookieSeparator + 1),
              url: origin,
            },
          ]);
          const page = await context.newPage();
          await page.goto(origin);
          await page.getByRole('heading', { name: 'Projects' }).waitFor();
          const objective = `Chromium PostgreSQL single-project capacity ${String(concurrency)}`;
          await page.getByLabel('Software objective').fill(objective);
          const journeyStartedAt = performance.now();
          const projectResponse = page.waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              new URL(response.url()).pathname === '/v1/projects',
          );
          await page.getByRole('button', { name: 'Start project' }).click();
          const response = await projectResponse;
          const responseBody = await response.text();
          expect(response.status(), responseBody).toBe(201);
          const submitted = JSON.parse(responseBody) as ProjectView;
          await page.getByRole('heading', { name: 'Observe' }).waitFor();

          const load = await materializeSingleProjectCognitiveLoad({
            repository: controlPlane.repository,
            scheduler: controlPlane.scheduler,
            projectId: submitted.projectId,
            targetConcurrency: concurrency,
            nextId: createDeterministicUuid(`capacity-load-${String(concurrency)}`),
          });
          const records = await controlPlane.repository.list();
          expect(records).toHaveLength(1);
          const record = records[0];
          if (record === undefined) throw new Error('Chromium journey project is missing');
          expect(record.view.objective).toBe(objective);
          expect(record.scheduling.execution.state).toBe('WAITING_FOR_APPROVAL');
          expect(record.scheduling.queueReason).toBe('WAITING_FOR_APPROVAL');
          expect(record.view.specialists).toHaveLength(1);
          expect(controlPlane.scheduler.specialistLimit).toBe(
            DEFAULT_POLICY_PROFILE.specialists.defaultProjectMaximum,
          );
          expect(controlPlane.scheduler.cognitiveRunLimit).toBe(cognitiveRunLimit);
          expect(record.view.capacity.cognitiveRunLimit).toBe(cognitiveRunLimit);
          expect(record.view.capacity.activeCognitiveRuns).toBe(concurrency);
          expect(load.executionIds).toHaveLength(concurrency);
          expect(new Set(load.executionIds).size).toBe(concurrency);
          expect(load.backendEventIds).toHaveLength(concurrency * 4);
          expect(load.queueProbe.reason).toBe('COGNITIVE_CAPACITY');
          expect(load.executionIds).not.toContain(load.queueProbe.executionId);
          const executionEvents = record.events.filter(
            ({ aggregate, kind }) =>
              kind === 'backend.event_observed' && load.executionIds.includes(aggregate.id),
          );
          expect(executionEvents).toHaveLength(concurrency * 4);
          const latencies = await Promise.all(
            record.events.map(async (event) => {
              await page.locator(`[data-event-id="${event.eventId}"]`).waitFor({
                state: 'visible',
                timeout: 10_000,
              });
              return Math.max(0, Date.now() - Date.parse(event.occurredAt));
            }),
          );
          const activity = await page
            .getByRole('log', { name: 'Project activity' })
            .getByRole('listitem')
            .evaluateAll((items) =>
              items.map((item) => ({
                eventId: item.getAttribute('data-event-id'),
                sequence: Number(item.getAttribute('data-sequence')),
              })),
            );
          expect(activity).toEqual(
            record.events.map((event) => ({
              eventId: event.eventId,
              sequence: event.sequence,
            })),
          );
          expect(latencies).not.toHaveLength(0);
          const postgres = await collectPostgresObservability(pool);
          expect(postgres.pendingOutboxEvents).toBe(0);
          expect(postgres.queuedExecutions).toBe(0);
          expect(postgres.queueReasons).toEqual({ WAITING_FOR_APPROVAL: 1 });
          eventLatencyByConcurrency[String(concurrency)] = Object.freeze(latencies);
          executionEventCountByConcurrency[String(concurrency)] = executionEvents.length;
          queueReasonByConcurrency[String(concurrency)] = load.queueProbe.reason;
          journeyMsByConcurrency[String(concurrency)] = performance.now() - journeyStartedAt;
          journeyPostgresByConcurrency[String(concurrency)] = postgres;
        } finally {
          await context.close();
          await vite?.close();
          await controlPlane.server.close();
        }
      }
    } finally {
      await browser.close();
    }

    const controlPlanePort = await unusedLoopbackPort();
    const controlPlaneOrigin = `http://127.0.0.1:${String(controlPlanePort)}`;
    const origin = 'http://127.0.0.1:4173';
    const bootstrapSecret = 'z'.repeat(48);
    const artifactRoot = join(testRoot, 'control-plane-artifacts');
    const controlPlane = createPostgresControlPlane({
      pool: sourcePool,
      bootstrapSecret,
      origin,
      supervisorId,
      expectedRevision: revision,
      runnerId: '78000000-0000-4000-8030-000000000001',
      nextId: createDeterministicUuid('capacity-postgres-control-plane'),
      effectExecutor: new InMemoryApprovedEffectExecutor(),
      artifactRoot,
      recoveryScanIntervalMs: 60_000,
    });
    let postgres: Awaited<ReturnType<typeof collectPostgresObservability>> | undefined;
    const submissionLatencies: number[] = [];
    const commandLatencies: Array<{ readonly command: string; readonly milliseconds: number }> = [];
    const projects: ProjectView[] = [];
    try {
      await controlPlane.server.listen({ host: '127.0.0.1', port: controlPlanePort });
      const bootstrap = await fetch(`${controlPlaneOrigin}/v1/session/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ bootstrapSecret }),
      });
      expect(bootstrap.status).toBe(204);
      const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
      if (cookie === undefined) throw new Error('Expected capacity supervisor session cookie');

      const submitProject = async (index: number): Promise<ProjectView> => {
        const started = performance.now();
        const response = await fetch(`${controlPlaneOrigin}/v1/projects`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': `capacity-objective-${String(index)}`,
            'x-correlation-id': `78000000-0000-4000-8010-${String(index).padStart(12, '0')}`,
          },
          body: JSON.stringify({
            objective: `Persist deterministic capacity fixture ${String(index)}`,
            fixtureScenario: 'PASS',
          }),
        });
        submissionLatencies.push(performance.now() - started);
        const responseBody = await response.text();
        expect(response.status, responseBody).toBe(201);
        const project = JSON.parse(responseBody) as ProjectView;
        projects.push(project);
        return project;
      };

      const measureHttpCommand = async (
        command: string,
        path: string,
        request: NonNullable<Parameters<typeof fetch>[1]>,
        expectedStatus: number,
      ) => {
        const started = performance.now();
        const response = await fetch(`${controlPlaneOrigin}${path}`, request);
        const milliseconds = performance.now() - started;
        const responseBody = await response.text();
        expect(response.status, responseBody).toBe(expectedStatus);
        commandLatencies.push(Object.freeze({ command, milliseconds }));
      };
      const expectActiveProjectCount = async (expected: number): Promise<void> => {
        expect(
          (await controlPlane.repository.list()).filter(({ view }) => view.status === 'ACTIVE'),
        ).toHaveLength(expected);
      };
      const firstProject = await submitProject(0);
      await expectActiveProjectCount(1);
      const firstProjectId = firstProject.projectId;
      let firstRecord = await controlPlane.repository.get(firstProjectId);
      if (firstRecord === null) throw new Error('Expected first capacity project record');
      await measureHttpCommand(
        'PAUSE',
        `/v1/projects/${firstProjectId}/commands/pause`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-pause',
            'x-correlation-id': '78000000-0000-4000-8040-000000000001',
            'if-match': `"${String(firstRecord.view.version)}"`,
          },
          body: JSON.stringify({ reason: 'Measure durable fixture pause acknowledgement' }),
        },
        202,
      );
      firstRecord = await controlPlane.repository.get(firstProjectId);
      if (firstRecord === null) throw new Error('Expected paused capacity project');
      await measureHttpCommand(
        'RESUME',
        `/v1/projects/${firstProjectId}/commands/resume`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-resume',
            'x-correlation-id': '78000000-0000-4000-8040-000000000002',
            'if-match': `"${String(firstRecord.view.version)}"`,
          },
          body: JSON.stringify({ reason: 'Measure durable fixture resume acknowledgement' }),
        },
        202,
      );
      firstRecord = await controlPlane.repository.get(firstProjectId);
      if (firstRecord === null) throw new Error('Expected resumed capacity project');
      const firstApproval = firstRecord.supervision.approvals.find(
        ({ state }) => state === 'REQUESTED',
      );
      if (firstApproval === undefined) throw new Error('Expected first capacity approval');
      await measureHttpCommand(
        'APPROVE',
        `/v1/projects/${firstProjectId}/approvals/${firstApproval.approvalId}/decision`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-approve',
            'x-correlation-id': '78000000-0000-4000-8040-000000000003',
            'if-match': `"${String(firstApproval.version)}"`,
          },
          body: JSON.stringify({
            decision: 'APPROVE',
            actionDigest: firstApproval.actionDigest,
            reason: 'Measure durable fixture approve acknowledgement',
          }),
        },
        200,
      );
      firstRecord = await controlPlane.repository.get(firstProjectId);
      if (firstRecord === null) throw new Error('Expected approved capacity project');
      await measureHttpCommand(
        'STOP',
        `/v1/projects/${firstProjectId}/commands/stop`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-stop',
            'x-correlation-id': '78000000-0000-4000-8040-000000000004',
            'if-match': `"${String(firstRecord.view.version)}"`,
          },
          body: JSON.stringify({ reason: 'Measure durable fixture stop acknowledgement' }),
        },
        202,
      );
      expect((await controlPlane.repository.get(firstProjectId))?.view.status).toBe('STOPPED');
      await expectActiveProjectCount(0);

      const secondProject = await submitProject(1);
      await expectActiveProjectCount(1);
      const secondRecord = await controlPlane.repository.get(secondProject.projectId);
      const secondApproval = secondRecord?.supervision.approvals[0];
      if (secondApproval === undefined) throw new Error('Expected second capacity approval');
      await measureHttpCommand(
        'REJECT',
        `/v1/projects/${secondProject.projectId}/approvals/${secondApproval.approvalId}/decision`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-reject',
            'x-correlation-id': '78000000-0000-4000-8040-000000000005',
            'if-match': `"${String(secondApproval.version)}"`,
          },
          body: JSON.stringify({
            decision: 'REJECT',
            actionDigest: secondApproval.actionDigest,
            reason: 'Measure durable fixture reject acknowledgement',
          }),
        },
        200,
      );
      expect((await controlPlane.repository.get(secondProject.projectId))?.view.status).toBe(
        'BLOCKED',
      );
      await expectActiveProjectCount(0);

      const thirdProject = await submitProject(2);
      await expectActiveProjectCount(1);
      const thirdRecord = await controlPlane.repository.get(thirdProject.projectId);
      if (thirdRecord === null) throw new Error('Expected third capacity project record');
      await measureHttpCommand(
        'CANCEL',
        `/v1/projects/${thirdProject.projectId}/commands/cancel`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-cancel',
            'x-correlation-id': '78000000-0000-4000-8040-000000000006',
            'if-match': `"${String(thirdRecord.view.version)}"`,
          },
          body: JSON.stringify({ reason: 'Measure durable fixture cancel acknowledgement' }),
        },
        202,
      );
      expect((await controlPlane.repository.get(thirdProject.projectId))?.view.status).toBe(
        'CANCELLED',
      );
      await expectActiveProjectCount(0);

      postgres = await collectPostgresObservability(sourcePool);
      expect(postgres.connections).toBeLessThanOrEqual(20);
      expect(postgres.waitingLocks).toBe(0);
      expect(postgres.pendingOutboxEvents).toBe(0);
      expect(postgres.outboxLagMs).toBe(0);
      expect(postgres.queuedExecutions).toBe(0);
      expect(postgres.queueReasons).toEqual({ WAITING_FOR_APPROVAL: 2 });
    } finally {
      await controlPlane.server.close();
    }

    if (postgres === undefined) throw new Error('PostgreSQL capacity metrics were not collected');
    const eventP95AtThree = percentile(eventLatencyByConcurrency['3'] ?? [], 0.95);
    const eventP95AtFive = percentile(eventLatencyByConcurrency['5'] ?? [], 0.95);
    expect(eventP95AtThree).toBeLessThanOrEqual(profile.goals.eventVisibilityP95MsAtThree);
    expect(eventP95AtFive).toBeLessThanOrEqual(profile.goals.eventVisibilityP95MsAtFive);
    const commandMilliseconds = commandLatencies.map(({ milliseconds }) => milliseconds);
    const commandP50 = percentile(commandMilliseconds, 0.5);
    const commandP95 = percentile(commandMilliseconds, 0.95);
    expect(commandLatencies.map(({ command }) => command)).toEqual([
      'PAUSE',
      'RESUME',
      'APPROVE',
      'STOP',
      'REJECT',
      'CANCEL',
    ]);
    expect(commandP95).toBeLessThanOrEqual(profile.goals.commandDurabilityP95Ms);

    expect(postgres.connections).toBeLessThanOrEqual(20);
    expect(postgres.waitingLocks).toBe(0);
    expect(postgres.pendingOutboxEvents).toBe(0);
    expect(postgres.outboxLagMs).toBe(0);
    expect(postgres.queuedExecutions).toBe(0);
    expect(postgres.queueReasons).toEqual({ WAITING_FOR_APPROVAL: 2 });

    const processResources = collectProcessResourceSnapshot();
    expect(processResources.rssBytes).toBeLessThan(profile.controlPlane.memoryEnvelopeBytes);
    expect(processResources.maxRssBytes).toBeLessThan(profile.controlPlane.memoryEnvelopeBytes);
    const discoveryFiles = new Map<string, string>([
      ['/proc/self/cgroup', '0::/user.slice/moonshift.scope\n'],
      ['/proc/self/mountinfo', '27 20 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n'],
      ['/sys/fs/cgroup/user.slice/moonshift.scope/cgroup.controllers', 'cpu memory pids\n'],
      ['/sys/fs/cgroup/user.slice/moonshift.scope/cgroup.subtree_control', '+cpu +memory +pids\n'],
      ['/etc/subuid', 'fixture:100000:65536\n'],
      ['/etc/subgid', 'fixture:100000:65536\n'],
    ]);
    const runnerDiscovery = await discoverRunnerHost({
      identity: 'fixture',
      platform: 'linux',
      readText: async (path) => {
        const value = discoveryFiles.get(path);
        if (value === undefined) throw new Error('missing fixture probe');
        return value;
      },
      isWritable: async () => true,
      podmanInfo: {
        host: { security: { rootless: true }, networkBackend: 'pasta' },
        store: { graphDriverName: 'overlay' },
      },
    });
    expect(runnerDiscovery).toMatchObject({
      cgroupVersion: 'V2',
      subordinateUidRange: true,
      subordinateGidRange: true,
      rootlessRuntime: 'PODMAN',
      rootlessNetwork: 'PASTA',
      supportsRootlessOci: false,
      enforceable: { cpu: true, memory: true, process: true },
    });
    const resourceRequest = {
      memoryBytes: 1,
      cpuUnits: 1,
      processLimit: 1,
      diskBytes: 1,
      maxRuntimeMs: 1,
      networkMode: 'DENY' as const,
      gpuUnits: 0,
    };
    expect(evaluateFixtureEligibility(resourceRequest, DEFAULT_FIXTURE_CAPACITY)).toEqual({
      eligible: false,
      reason: 'MEMORY_NOT_ENFORCEABLE',
    });
    const leaseRegistry = new FixtureLeaseRegistry();
    leaseRegistry.offer(
      {
        leaseId: '78000000-0000-4000-8020-000000000001',
        executionId: '78000000-0000-4000-8020-000000000002',
        fencingToken: 1,
        effectId: '78000000-0000-4000-8020-000000000003',
        actionDigest: `sha256:${'a'.repeat(64)}`,
        authorizedAt: '2026-09-01T00:00:00.000Z',
        approvalExpiresAt: '2026-09-01T00:05:00.000Z',
        expiresAt: '2026-09-01T00:10:00.000Z',
        resources: resourceRequest,
      },
      'runner-capacity-fixture',
    );
    const runnerLeaseUtilization = leaseRegistry.isCurrent(
      '78000000-0000-4000-8020-000000000001',
      '78000000-0000-4000-8020-000000000002',
      1,
    )
      ? 1
      : 0;
    expect(runnerLeaseUtilization).toBeLessThanOrEqual(DEFAULT_FIXTURE_CAPACITY.maxJobs);

    const restartStarted = performance.now();
    const recovery = await recoverPostgresDeliveryState(sourcePool);
    const restartInspectionMs = performance.now() - restartStarted;
    expect(recovery.projectionReplayBlockedProjectIds).toEqual([]);
    expect(restartInspectionMs).toBeLessThanOrEqual(profile.goals.restartInspectionMs);

    const backupDirectory = join(testRoot, 'backup');
    const restoredArtifactRoot = join(testRoot, 'restored-artifacts');
    await mkdir(artifactRoot, { mode: 0o700, recursive: true });
    await writeFile(join(artifactRoot, 'capacity.bin'), 'capacity-fixture', { mode: 0o600 });
    const contractBytes = await readFile(
      new URL(
        '../../specs/001-supervised-autonomous-loop/contracts/event-envelope.schema.json',
        import.meta.url,
      ),
    );
    const configurationReferences = { database: 'env:MOONSHIFT_DATABASE_URL' } as const;
    const contractHashes = { 'event-envelope.schema.json': sha256(contractBytes) } as const;
    const backup = await createFixtureBackup({
      pool: sourcePool,
      artifactRoot,
      outputDirectory: backupDirectory,
      configurationReferences,
      contractHashes,
    });
    let restoredStateValidated = false;
    const restored = await restoreFixtureBackup({
      pool: restorePool,
      backupDirectory,
      artifactRoot: restoredArtifactRoot,
      expectedConfigurationReferences: configurationReferences,
      expectedContractHashes: contractHashes,
      rebuildAndValidateProjections: async (context) => {
        const report = await recoverPostgresDeliveryStateWithMaintenance(
          restorePool,
          context.client,
        );
        expect(report.projectionReplayBlockedProjectIds).toEqual([]);
        restoredStateValidated = true;
        return {
          schemaVersion: '1.0',
          projection: 'project-events',
          validatedProjectIds: report.projectionValidatedProjectIds,
          blockedProjectIds: report.projectionReplayBlockedProjectIds,
        };
      },
    });
    expect(restoredStateValidated).toBe(true);
    expect(restored.schedulingMayResume).toBe(true);
    expect(backup.metrics.temporaryDiskBytesHighWater).toBeLessThanOrEqual(
      profile.storage.backupTemporaryBytesMaximum,
    );
    expect(restored.metrics.temporaryDiskBytesHighWater).toBeLessThanOrEqual(
      profile.storage.restoreTemporaryBytesMaximum,
    );
    expect(restored.metrics.schedulingDowntimeMs).toBeLessThanOrEqual(
      profile.goals.restartInspectionMs,
    );
    expect(await readFile(join(restoredArtifactRoot, 'capacity.bin'), 'utf8')).toBe(
      'capacity-fixture',
    );
    expect(
      await restorePool.query('SELECT count(*)::integer AS count FROM project_snapshots'),
    ).toMatchObject({ rows: [{ count: 3 }] });

    const journeyOne = journeyPostgresByConcurrency['1'];
    const journeyThree = journeyPostgresByConcurrency['3'];
    const journeyFive = journeyPostgresByConcurrency['5'];
    if (journeyOne === undefined || journeyThree === undefined || journeyFive === undefined) {
      throw new Error('Concurrent PostgreSQL-to-Chromium journey evidence is incomplete');
    }

    const report = {
      schemaVersion: '1.0',
      profile: 'foundation-16gb-pve-evaluation',
      measurement: {
        eventVisibility:
          'Conservative upper bound from PostgreSQL-authored event time before commit through loopback SSE replay to one submitting Chromium DOM',
        cognitiveLoad:
          'One browser-submitted PostgreSQL project and its one bounded specialist; additional slots execute through FixtureScheduler and persist its exact sanitized fake-backend observations through the project repository/outbox',
        commandDurability:
          'Loopback HTTP request to response after PostgreSQL transaction and outbox drain',
      },
      concurrency: {
        one: {
          cognitiveExecutions: 1,
          activeProjects: 1,
          activeSpecialists: 1,
          configuredSpecialistLimit: DEFAULT_POLICY_PROFILE.specialists.defaultProjectMaximum,
          configuredCognitiveRunLimit: profile.controlPlane.cognitiveRunsDefault,
          journeyMs: journeyMsByConcurrency['1'],
          committedObservableEvents: eventLatencyByConcurrency['1']?.length ?? 0,
          executionProducedEvents: executionEventCountByConcurrency['1'],
          eventVisibilityP50Ms: percentile(eventLatencyByConcurrency['1'] ?? [], 0.5),
          eventVisibilityP95Ms: percentile(eventLatencyByConcurrency['1'] ?? [], 0.95),
          postgres: journeyOne,
        },
        three: {
          cognitiveExecutions: 3,
          activeProjects: 1,
          activeSpecialists: 1,
          configuredSpecialistLimit: DEFAULT_POLICY_PROFILE.specialists.defaultProjectMaximum,
          configuredCognitiveRunLimit: profile.controlPlane.cognitiveRunsDefault,
          journeyMs: journeyMsByConcurrency['3'],
          committedObservableEvents: eventLatencyByConcurrency['3']?.length ?? 0,
          executionProducedEvents: executionEventCountByConcurrency['3'],
          eventVisibilityP50Ms: percentile(eventLatencyByConcurrency['3'] ?? [], 0.5),
          eventVisibilityP95Ms: eventP95AtThree,
          postgres: journeyThree,
        },
        five: {
          cognitiveExecutions: 5,
          activeProjects: 1,
          activeSpecialists: 1,
          configuredSpecialistLimit: DEFAULT_POLICY_PROFILE.specialists.defaultProjectMaximum,
          configuredCognitiveRunLimit: profile.controlPlane.cognitiveRunsMaximum,
          journeyMs: journeyMsByConcurrency['5'],
          committedObservableEvents: eventLatencyByConcurrency['5']?.length ?? 0,
          executionProducedEvents: executionEventCountByConcurrency['5'],
          eventVisibilityP50Ms: percentile(eventLatencyByConcurrency['5'] ?? [], 0.5),
          eventVisibilityP95Ms: eventP95AtFive,
          postgres: journeyFive,
        },
      },
      projectSubmission: {
        count: submissionLatencies.length,
        p50Ms: percentile(submissionLatencies, 0.5),
        p95Ms: percentile(submissionLatencies, 0.95),
      },
      commandDurability: {
        commands: commandLatencies,
        p50Ms: commandP50,
        p95Ms: commandP95,
      },
      commandDurabilityP50Ms: commandP50,
      commandDurabilityP95Ms: commandP95,
      queue: {
        reasonsByConcurrency: queueReasonByConcurrency,
        persistedProjectReasons: postgres.queueReasons,
        queuedExecutions: postgres.queuedExecutions,
        waitMs: postgres.queueWaitMs,
      },
      postgres,
      process: processResources,
      runner: {
        activeLeases: runnerLeaseUtilization,
        maximumJobs: DEFAULT_FIXTURE_CAPACITY.maxJobs,
        capacity: DEFAULT_FIXTURE_CAPACITY,
        discovery: runnerDiscovery,
      },
      restartInspectionMs,
      backup: backup.metrics,
      restore: restored.metrics,
      unresolvedFindings: [],
    };
    const reportPath = process.env.MOONSHIFT_CAPACITY_REPORT;
    if (reportPath !== undefined) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  }, 120_000);
});
