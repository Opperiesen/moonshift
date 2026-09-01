import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { chromium, type Browser } from '@playwright/test';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresControlPlane,
  InMemoryApprovedEffectExecutor,
  recoverPostgresDeliveryState,
  type ProjectEvent,
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
import { planningValidators } from '../../packages/contracts/src/index.js';
import {
  collectPostgresObservability,
  createFixtureBackup,
  restoreFixtureBackup,
  runMigrations,
} from '../../packages/persistence/src/index.js';
import { createDeterministicUuid } from '../../packages/test-fixtures/src/index.js';

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
  }, 120_000);

  afterAll(async () => {
    await sourcePool?.end();
    await restorePool?.end();
    await embedded?.stop();
    if (testRoot !== undefined) await rm(testRoot, { recursive: true, force: true });
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

    const scheduledObservationsByConcurrency: Record<
      string,
      readonly Readonly<Record<string, unknown>>[]
    > = {};
    const schedulerBatchMsByConcurrency: Record<string, number> = {};
    for (const concurrency of [1, 3, 5] as const) {
      const scheduler = new FixtureScheduler({
        now: () => new Date(),
        nextId: createDeterministicUuid(`capacity-direct-${String(concurrency)}`),
        expectedRevision: revision,
        cognitiveRunLimit: concurrency,
      });
      const startedAt = performance.now();
      const results = await Promise.all(
        Array.from({ length: concurrency }, async (_, index) =>
          scheduler.schedule({
            projectId: `78000000-0000-4000-8001-${String(index).padStart(12, '0')}`,
            taskId: `78000000-0000-4000-8002-${String(index).padStart(12, '0')}`,
            agentId: `78000000-0000-4000-8003-${String(index).padStart(12, '0')}`,
            objective: 'Run one bounded deterministic capacity fixture',
            acceptanceCriteria: ['Observe deterministic fixture events'],
            scenario: 'PASS',
            correlationId: `78000000-0000-4000-8004-${String(index).padStart(12, '0')}`,
            authority: {
              maxRuntimeMs: 10_000,
              consumedActiveMs: 0,
              attemptedActiveMs: 1_000,
              authorityLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              now: new Date().toISOString(),
            },
            capacity: { activeSpecialists: 0, activeCognitiveRuns: 0, activeRunnerJobs: 0 },
          }),
        ),
      );
      const elapsed = performance.now() - startedAt;
      expect(results).toHaveLength(concurrency);
      expect(results.every(({ execution }) => execution.state === 'WAITING_FOR_APPROVAL')).toBe(
        true,
      );
      expect(results.every(({ queueReason }) => queueReason === 'WAITING_FOR_APPROVAL')).toBe(true);
      const observations = results.flatMap(({ observations: executionObservations }) =>
        executionObservations.map((observation) => observation),
      );
      expect(observations).not.toHaveLength(0);
      scheduledObservationsByConcurrency[String(concurrency)] = Object.freeze(observations);
      schedulerBatchMsByConcurrency[String(concurrency)] = elapsed;
    }

    const controlPlanePort = await unusedLoopbackPort();
    const controlPlaneOrigin = `http://127.0.0.1:${String(controlPlanePort)}`;
    const webPort = await unusedLoopbackPort();
    const origin = `http://127.0.0.1:${String(webPort)}`;
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
    let browser: Browser | undefined;
    let vite: ViteDevServer | undefined;
    let postgres: Awaited<ReturnType<typeof collectPostgresObservability>> | undefined;
    const eventLatencyByConcurrency: Record<string, readonly number[]> = {};
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

      for (let index = 0; index < 4; index += 1) {
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
        projects.push(JSON.parse(responseBody) as ProjectView);
      }
      const projectRecords = await Promise.all(
        projects.map(({ projectId }) => controlPlane.repository.get(projectId)),
      );
      expect(
        projectRecords
          .slice(0, 3)
          .every((record) => record?.scheduling.queueReason === 'WAITING_FOR_APPROVAL'),
      ).toBe(true);
      expect(projectRecords[3]?.scheduling.queueReason).toBe('COGNITIVE_CAPACITY');

      postgres = await collectPostgresObservability(sourcePool);
      expect(postgres.connections).toBeLessThanOrEqual(20);
      expect(postgres.waitingLocks).toBe(0);
      expect(postgres.pendingOutboxEvents).toBe(0);
      expect(postgres.outboxLagMs).toBe(0);
      expect(postgres.queuedExecutions).toBe(1);
      expect(postgres.queueReasons).toMatchObject({ COGNITIVE_CAPACITY: 1 });

      vite = await createViteServer({
        root: 'apps/web',
        logLevel: 'silent',
        server: {
          host: '127.0.0.1',
          port: webPort,
          strictPort: true,
          proxy: { '/v1': `http://127.0.0.1:${String(controlPlanePort)}` },
        },
      });
      await vite.listen();
      browser = await chromium.launch();
      const browserContext = await browser.newContext();
      const cookieSeparator = cookie.indexOf('=');
      if (cookieSeparator <= 0) throw new Error('Capacity session cookie is malformed');
      await browserContext.addCookies([
        {
          name: cookie.slice(0, cookieSeparator),
          value: cookie.slice(cookieSeparator + 1),
          url: origin,
        },
      ]);
      const connectedProject = projects[0];
      if (connectedProject === undefined) throw new Error('Expected a connected capacity project');
      await browserContext.addInitScript((projectId) => {
        localStorage.setItem('moonshift.activeProjectId', projectId);
      }, connectedProject.projectId);
      const page = await browserContext.newPage();
      await page.goto(origin);
      await page.getByRole('heading', { name: 'Observe' }).waitFor();
      await page.getByText('Connection: Live').waitFor();

      const validators = planningValidators();
      const nextVisibleEventId = createDeterministicUuid('capacity-visible-event');
      for (const concurrency of [1, 3, 5] as const) {
        const observations = scheduledObservationsByConcurrency[String(concurrency)] ?? [];
        const summaries = observations.map(
          (_, index) =>
            `Capacity ${String(concurrency)} execution observable event ${String(index + 1)}`,
        );
        const commitTimes: number[] = [];
        for (let index = 0; index < summaries.length; index += 1) {
          const summary = summaries[index];
          if (summary === undefined) throw new Error('Expected capacity event summary');
          await controlPlane.repository.mutate({
            scope: 'capacity-browser-event',
            idempotencyKey: `capacity-browser-${String(concurrency)}-${String(index)}`,
            requestHash: sha256(Buffer.from(summary)),
            projectId: connectedProject.projectId,
            mutate: async (record, authorityNow) => {
              const sequence = record.view.lastSequence + 1;
              const version = record.view.version + 1;
              const event: ProjectEvent = Object.freeze({
                schemaVersion: '1.0',
                eventId: nextVisibleEventId(),
                projectId: connectedProject.projectId,
                sequence,
                kind: 'audit.notice',
                occurredAt: authorityNow,
                actor: Object.freeze({ type: 'SYSTEM', id: nextVisibleEventId() }),
                aggregate: Object.freeze({
                  type: 'PROJECT',
                  id: connectedProject.projectId,
                  version,
                }),
                correlationId: nextVisibleEventId(),
                classification: 'PUBLIC_FIXTURE',
                payload: Object.freeze({
                  code: 'CAPACITY_BROWSER_VISIBILITY',
                  severity: 'INFO',
                  summary,
                }),
              });
              validators.eventEnvelope.assert(event);
              return {
                record: Object.freeze({
                  ...record,
                  view: Object.freeze({ ...record.view, version, lastSequence: sequence }),
                  events: Object.freeze([...record.events, event]),
                }),
                response: Object.freeze({ sequence }),
              };
            },
          });
          commitTimes.push(performance.now());
        }
        const displayedAt = await Promise.all(
          summaries.map(async (summary) => {
            await page
              .getByRole('log', { name: 'Project activity' })
              .getByText(summary, { exact: true })
              .waitFor({ state: 'visible', timeout: 10_000 });
            return performance.now();
          }),
        );
        const latencies = displayedAt.map((displayed, index) =>
          Math.max(0, displayed - (commitTimes[index] ?? displayed)),
        );
        expect(latencies).toHaveLength(summaries.length);
        expect(latencies).not.toHaveLength(0);
        for (const summary of summaries) {
          expect(
            await page
              .getByRole('log', { name: 'Project activity' })
              .getByText(summary, { exact: true })
              .count(),
          ).toBe(1);
        }
        eventLatencyByConcurrency[String(concurrency)] = Object.freeze(latencies);
      }
      const activitySequences = await page
        .getByRole('log', { name: 'Project activity' })
        .getByRole('listitem')
        .evaluateAll((items) => items.map((item) => Number(item.getAttribute('data-sequence'))));
      expect(activitySequences).toEqual([...activitySequences].sort((left, right) => left - right));
      expect(new Set(activitySequences).size).toBe(activitySequences.length);

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
      const firstProjectId = projects[0]?.projectId;
      if (firstProjectId === undefined) throw new Error('Expected first capacity project');
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
      await measureHttpCommand(
        'STOP',
        `/v1/projects/${firstProjectId}/commands/stop`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-stop',
            'x-correlation-id': '78000000-0000-4000-8040-000000000003',
            'if-match': `"${String(firstRecord.view.version)}"`,
          },
          body: JSON.stringify({ reason: 'Measure durable fixture stop acknowledgement' }),
        },
        202,
      );

      for (const [projectIndex, decision] of [
        [1, 'APPROVE'],
        [2, 'REJECT'],
      ] as const) {
        const projectId = projects[projectIndex]?.projectId;
        if (projectId === undefined) throw new Error('Expected approval capacity project');
        const record = await controlPlane.repository.get(projectId);
        const approval = record?.supervision.approvals[0];
        if (approval === undefined) throw new Error('Expected capacity approval');
        await measureHttpCommand(
          decision,
          `/v1/projects/${projectId}/approvals/${approval.approvalId}/decision`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie,
              'idempotency-key': `capacity-command-${decision.toLocaleLowerCase('en-US')}`,
              'x-correlation-id':
                decision === 'APPROVE'
                  ? '78000000-0000-4000-8040-000000000004'
                  : '78000000-0000-4000-8040-000000000005',
              'if-match': `"${String(approval.version)}"`,
            },
            body: JSON.stringify({
              decision,
              actionDigest: approval.actionDigest,
              reason: `Measure durable fixture ${decision.toLocaleLowerCase('en-US')} acknowledgement`,
            }),
          },
          200,
        );
      }

      const fourthProjectId = projects[3]?.projectId;
      if (fourthProjectId === undefined) throw new Error('Expected queued capacity project');
      const fourthRecord = await controlPlane.repository.get(fourthProjectId);
      if (fourthRecord === null) throw new Error('Expected queued capacity project record');
      await measureHttpCommand(
        'CANCEL',
        `/v1/projects/${fourthProjectId}/commands/cancel`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie,
            'idempotency-key': 'capacity-command-cancel',
            'x-correlation-id': '78000000-0000-4000-8040-000000000006',
            'if-match': `"${String(fourthRecord.view.version)}"`,
          },
          body: JSON.stringify({ reason: 'Measure durable fixture cancel acknowledgement' }),
        },
        202,
      );
    } finally {
      await browser?.close();
      await vite?.close();
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
      'STOP',
      'APPROVE',
      'REJECT',
      'CANCEL',
    ]);
    expect(commandP95).toBeLessThanOrEqual(profile.goals.commandDurabilityP95Ms);

    expect(postgres.connections).toBeLessThanOrEqual(20);
    expect(postgres.waitingLocks).toBe(0);
    expect(postgres.pendingOutboxEvents).toBe(0);
    expect(postgres.outboxLagMs).toBe(0);
    expect(postgres.queuedExecutions).toBe(1);
    expect(postgres.queueReasons).toMatchObject({ COGNITIVE_CAPACITY: 1 });

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
      schedulerStopped: true,
      expectedConfigurationReferences: configurationReferences,
      expectedContractHashes: contractHashes,
      validateRestoredState: async () => {
        const report = await recoverPostgresDeliveryState(restorePool);
        expect(report.projectionReplayBlockedProjectIds).toEqual([]);
        restoredStateValidated = true;
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
    ).toMatchObject({ rows: [{ count: 4 }] });

    const report = {
      schemaVersion: '1.0',
      profile: 'foundation-16gb-pve-evaluation',
      measurement: {
        eventVisibility:
          'PostgreSQL commit completion to connected Chromium DOM visibility over loopback SSE',
        commandDurability:
          'Loopback HTTP request to response after PostgreSQL transaction and outbox drain',
      },
      concurrency: {
        one: {
          cognitiveExecutions: 1,
          schedulerBatchMs: schedulerBatchMsByConcurrency['1'],
          committedObservableEvents: eventLatencyByConcurrency['1']?.length ?? 0,
          eventVisibilityP50Ms: percentile(eventLatencyByConcurrency['1'] ?? [], 0.5),
          eventVisibilityP95Ms: percentile(eventLatencyByConcurrency['1'] ?? [], 0.95),
        },
        three: {
          cognitiveExecutions: 3,
          schedulerBatchMs: schedulerBatchMsByConcurrency['3'],
          committedObservableEvents: eventLatencyByConcurrency['3']?.length ?? 0,
          eventVisibilityP50Ms: percentile(eventLatencyByConcurrency['3'] ?? [], 0.5),
          eventVisibilityP95Ms: eventP95AtThree,
        },
        five: {
          cognitiveExecutions: 5,
          schedulerBatchMs: schedulerBatchMsByConcurrency['5'],
          committedObservableEvents: eventLatencyByConcurrency['5']?.length ?? 0,
          eventVisibilityP50Ms: percentile(eventLatencyByConcurrency['5'] ?? [], 0.5),
          eventVisibilityP95Ms: eventP95AtFive,
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
        reasons: postgres.queueReasons,
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
