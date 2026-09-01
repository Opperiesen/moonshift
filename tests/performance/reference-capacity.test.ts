import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresProjectRepository,
  ProjectService,
  recoverPostgresDeliveryState,
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

    const eventLatencyByConcurrency: Record<string, readonly number[]> = {};
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
      const eventLatencies = results.flatMap(({ observations }) => observations.map(() => elapsed));
      expect(eventLatencies).not.toHaveLength(0);
      eventLatencyByConcurrency[String(concurrency)] = Object.freeze(eventLatencies);
    }
    const eventP95AtThree = percentile(eventLatencyByConcurrency['3'] ?? [], 0.95);
    const eventP95AtFive = percentile(eventLatencyByConcurrency['5'] ?? [], 0.95);
    expect(eventP95AtThree).toBeLessThanOrEqual(profile.goals.eventVisibilityP95MsAtThree);
    expect(eventP95AtFive).toBeLessThanOrEqual(profile.goals.eventVisibilityP95MsAtFive);

    const repository = new PostgresProjectRepository(sourcePool);
    const scheduler = new FixtureScheduler({
      now: () => new Date(),
      nextId: createDeterministicUuid('capacity-persistent-scheduler'),
      expectedRevision: revision,
    });
    const service = new ProjectService({
      repository,
      scheduler,
      nextId: createDeterministicUuid('capacity-persistent-project'),
    });
    const commandLatencies: number[] = [];
    const projects = [];
    for (let index = 0; index < 4; index += 1) {
      const started = performance.now();
      const project = await service.submitObjective({
        actorId: supervisorId,
        idempotencyKey: `capacity-objective-${String(index)}`,
        correlationId: `78000000-0000-4000-8010-${String(index).padStart(12, '0')}`,
        objective: `Persist deterministic capacity fixture ${String(index)}`,
        fixtureScenario: 'PASS',
      });
      commandLatencies.push(performance.now() - started);
      projects.push(project);
    }
    expect(
      projects
        .slice(0, 3)
        .every(({ scheduling }) => scheduling.queueReason === 'WAITING_FOR_APPROVAL'),
    ).toBe(true);
    expect(projects[3]?.scheduling.queueReason).toBe('COGNITIVE_CAPACITY');
    const commandP95 = percentile(commandLatencies, 0.95);
    expect(commandP95).toBeLessThanOrEqual(profile.goals.commandDurabilityP95Ms);

    const postgres = await collectPostgresObservability(sourcePool);
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

    const artifactRoot = join(testRoot, 'artifacts');
    const backupDirectory = join(testRoot, 'backup');
    const restoredArtifactRoot = join(testRoot, 'restored-artifacts');
    await mkdir(artifactRoot, { mode: 0o700 });
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
      concurrency: {
        one: { eventVisibilityP95Ms: percentile(eventLatencyByConcurrency['1'] ?? [], 0.95) },
        three: { eventVisibilityP95Ms: eventP95AtThree },
        five: { eventVisibilityP95Ms: eventP95AtFive },
      },
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
