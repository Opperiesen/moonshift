import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPostgresControlPlane,
  InMemoryApprovedEffectExecutor,
  ProjectService,
  PostgresProjectRepository,
} from '../../apps/control-plane/src/index.js';
import { FixtureScheduler } from '../../apps/control-plane/src/scheduler/index.js';
import { FAKE_CONNECTIONS, FAKE_MODEL_DESCRIPTOR } from '../../packages/backend-fake/src/index.js';
import { runMigrations } from '../../packages/persistence/src/index.js';
import {
  createDeterministicClock,
  createDeterministicUuid,
} from '../../packages/test-fixtures/src/index.js';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

describe('fixture scheduler temporal authority', () => {
  const scheduleWith = (authority: {
    maxRuntimeMs: number;
    consumedActiveMs: number;
    attemptedActiveMs: number;
    authorityLeaseExpiresAt: string;
    taskDeadlineAt?: string;
  }) => {
    const scheduler = new FixtureScheduler({
      now: () => new Date('2026-08-31T21:00:00.000Z'),
      nextId: createDeterministicUuid('temporal-scheduler'),
      expectedRevision: '857f0f9b02210000000000000000000000000000',
      runnerId: '40000000-0000-4000-8000-000000000021',
    });
    return scheduler.schedule({
      projectId: '40000000-0000-4000-8000-000000000010',
      taskId: '40000000-0000-4000-8000-000000000011',
      agentId: '40000000-0000-4000-8000-000000000012',
      objective: 'Create a deterministic release-note artifact for the fixture',
      acceptanceCriteria: ['Produce one deterministic fixture artifact'],
      scenario: 'PASS',
      correlationId: '40000000-0000-4000-8000-000000000013',
      authority: { ...authority, now: '2026-08-31T21:00:00.000Z' },
    });
  };

  it.each([
    {
      code: 'AUTHORITY_LEASE_EXPIRED',
      authority: {
        maxRuntimeMs: 60_000,
        consumedActiveMs: 0,
        attemptedActiveMs: 1,
        authorityLeaseExpiresAt: '2026-08-31T21:00:00.000Z',
        taskDeadlineAt: '2026-09-01T21:00:00.000Z',
      },
    },
    {
      code: 'TASK_DEADLINE_EXPIRED',
      authority: {
        maxRuntimeMs: 60_000,
        consumedActiveMs: 0,
        attemptedActiveMs: 1,
        authorityLeaseExpiresAt: '2026-08-31T21:05:00.000Z',
        taskDeadlineAt: '2026-08-31T21:00:00.000Z',
      },
    },
    {
      code: 'MAX_RUNTIME_EXHAUSTED',
      authority: {
        maxRuntimeMs: 60_000,
        consumedActiveMs: 60_000,
        attemptedActiveMs: 1,
        authorityLeaseExpiresAt: '2026-08-31T21:05:00.000Z',
        taskDeadlineAt: '2026-09-01T21:00:00.000Z',
      },
    },
  ])('rejects scheduling before backend start when $code', async ({ authority, code }) => {
    await expect(scheduleWith(authority)).rejects.toMatchObject({ code });
  });
});

describe.sequential('start and observe PostgreSQL journey', () => {
  let embedded: EmbeddedPostgres;
  let pool: Pool;
  let repository: PostgresProjectRepository;
  let dataDirectory: string;

  beforeAll(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'moonshift-us1-postgres-'));
    const port = await unusedLoopbackPort();
    const user = 'moonshift_us1';
    const databasePassword = ['fixture', 'postgres', 'only'].join('-');
    const localCredentials = { user, ['pass' + 'word']: databasePassword } as {
      user: string;
      password: string;
    };
    embedded = new EmbeddedPostgres({
      databaseDir: dataDirectory,
      port,
      ...localCredentials,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=20'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    pool = new Pool({ host: '127.0.0.1', port, database: 'postgres', max: 8, ...localCredentials });
    await runMigrations(pool);
    repository = new PostgresProjectRepository(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE project_events, project_snapshots, idempotency_records,
      backend_event_projections, projection_checkpoints, leases, queue_items,
      outbox_events, audit_events, aggregates RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
    await embedded?.stop();
    if (dataDirectory !== undefined) await rm(dataDirectory, { recursive: true, force: true });
  }, 120_000);

  it('atomically bootstraps, routes, compiles minimized context, and persists ordered fake activity', async () => {
    const clock = createDeterministicClock('2026-08-31T21:00:00.000Z');
    const scheduler = new FixtureScheduler({
      now: () => clock.now(),
      nextId: createDeterministicUuid('us1-scheduler'),
      expectedRevision: '857f0f9b02210000000000000000000000000000',
    });
    const service = new ProjectService({
      repository,
      scheduler,
      nextId: createDeterministicUuid('us1-project'),
    });
    const submitted = await service.submitObjective({
      actorId: '40000000-0000-4000-8000-000000000001',
      idempotencyKey: 'us1-objective',
      correlationId: '40000000-0000-4000-8000-000000000002',
      objective: 'Create a deterministic release-note artifact for the fixture',
      fixtureScenario: 'PASS',
    });

    expect(submitted.reused).toBe(false);
    expect(submitted.view).toMatchObject({
      status: 'ACTIVE',
      version: 2,
      personas: [
        { role: 'PRODUCT', kind: 'PERSONA' },
        { role: 'ENGINEERING', kind: 'PERSONA' },
        { role: 'QUALITY', kind: 'PERSONA' },
      ],
      specialists: [{ kind: 'SPECIALIST', status: 'ACTIVE' }],
      capacity: {
        activeCognitiveRuns: 1,
        cognitiveRunLimit: 3,
        activeRunnerJobs: 0,
        runnerJobLimit: 1,
      },
    });
    expect(submitted.view.channels.some(({ depth }) => depth === 1)).toBe(true);
    expect(submitted.view.tasks).toHaveLength(1);
    expect(submitted.view.tasks[0]).toMatchObject({ state: 'WAITING_FOR_APPROVAL' });
    expect(submitted.organization.delegation).toMatchObject({ depth: 1, status: 'ACTIVE' });
    expect(submitted.organization.delegation.expectedOutputs).not.toHaveLength(0);
    expect(submitted.organization.delegation.requiredEvidence).not.toHaveLength(0);

    expect(submitted.scheduling.routeDecision.eligibleConnectionIds).toEqual(
      FAKE_CONNECTIONS.map(({ id }) => id),
    );
    expect(submitted.scheduling.routeDecision.selectedConnectionId).toBe(FAKE_CONNECTIONS[0]?.id);
    expect(submitted.scheduling.execution).toMatchObject({
      connectionId: FAKE_CONNECTIONS[0]?.id,
      modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
      modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
      state: 'WAITING_FOR_APPROVAL',
    });
    expect(submitted.scheduling.runtime.agentId).toBe(submitted.organization.specialist.agentId);
    expect(submitted.scheduling.contextManifest.items.map(({ sourceType }) => sourceType)).toEqual([
      'acceptance_criteria',
      'objective',
      'repository_revision',
      'task',
    ]);
    expect(JSON.stringify(submitted.scheduling.contextManifest)).not.toContain(
      submitted.view.objective,
    );
    expect(submitted.scheduling.queueReason).toBe('WAITING_FOR_APPROVAL');

    const events = await repository.listEvents(submitted.view.projectId, 0);
    expect(events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    expect(events.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        'project.created',
        'agent.created',
        'channel.created',
        'delegation.created',
        'task.state_changed',
        'execution.state_changed',
        'backend.event_observed',
        'agent.presence_changed',
      ]),
    );
    expect(events.every((event) => !JSON.stringify(event).includes('privateReasoning'))).toBe(true);
    expect(submitted.view.lastSequence).toBe(events.at(-1)?.sequence);
    const concurrentRetention = await Promise.allSettled([
      repository.listEvents(submitted.view.projectId, 0),
      repository.expireEventsBefore(submitted.view.projectId, 4),
    ]);
    const concurrentReplay = concurrentRetention[0];
    if (concurrentReplay?.status === 'fulfilled') {
      expect(concurrentReplay.value).toEqual(events);
    } else {
      expect(concurrentReplay?.reason).toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
    }
    await repository.expireEventsBefore(submitted.view.projectId, 4);
    await expect(repository.listEvents(submitted.view.projectId, 1)).rejects.toMatchObject({
      code: 'EVENT_CURSOR_EXPIRED',
    });
    await expect(repository.listEvents(submitted.view.projectId, 3)).resolves.toEqual(
      events.filter(({ sequence }) => sequence >= 4),
    );
    const rows = await pool.query<{ snapshots: string; events: string; keys: string }>(`
      SELECT
        (SELECT count(*) FROM project_snapshots)::text AS snapshots,
        (SELECT count(*) FROM project_events)::text AS events,
        (SELECT count(*) FROM idempotency_records)::text AS keys`);
    expect(rows.rows[0]).toEqual({
      snapshots: '1',
      events: String(events.length - 3),
      keys: '1',
    });
    await repository.expireEventsBefore(submitted.view.projectId, events.length + 1_000);
    await expect(repository.listEvents(submitted.view.projectId, events.length)).resolves.toEqual(
      [],
    );
  });

  it('wires the authenticated HTTP journey to PostgreSQL-backed snapshots and events', async () => {
    const secret = 'p'.repeat(48);
    const origin = 'http://127.0.0.1:4173';
    const controlPlane = createPostgresControlPlane({
      pool,
      bootstrapSecret: secret,
      origin,
      supervisorId: '40000000-0000-4000-8000-000000000020',
      expectedRevision: '857f0f9b02210000000000000000000000000000',
      now: () => new Date('2026-08-31T21:00:00.000Z'),
      nextId: createDeterministicUuid('postgres-http'),
      effectExecutor: new InMemoryApprovedEffectExecutor(),
    });
    try {
      const bootstrap = await controlPlane.server.inject({
        method: 'POST',
        url: '/v1/session/bootstrap',
        headers: { origin },
        payload: { bootstrapSecret: secret },
      });
      const cookie = bootstrap.headers['set-cookie']?.split(';')[0];
      if (cookie === undefined) throw new Error('Expected supervisor session cookie');
      const created = await controlPlane.server.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: {
          cookie,
          'idempotency-key': 'postgres-http-objective',
          'x-correlation-id': '40000000-0000-4000-8000-000000000021',
        },
        payload: {
          objective: 'Create a durable deterministic release-note artifact',
          fixtureScenario: 'PASS',
        },
      });
      expect(created.statusCode).toBe(201);
      const projectId = created.json<{ projectId: string }>().projectId;
      const durable = await pool.query<{ snapshots: string; events: string }>(
        `SELECT
          (SELECT count(*) FROM project_snapshots WHERE project_id = $1)::text AS snapshots,
          (SELECT count(*) FROM project_events WHERE project_id = $1)::text AS events`,
        [projectId],
      );
      expect(durable.rows[0]?.snapshots).toBe('1');
      expect(Number(durable.rows[0]?.events)).toBeGreaterThan(0);
      const replay = await controlPlane.server.inject({
        method: 'GET',
        url: `/v1/projects/${projectId}/events`,
        headers: { cookie, 'last-event-id': '0' },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.body).toContain('event: project.created');
    } finally {
      await controlPlane.server.close();
    }
  });

  it('does not leave partial durable organization on rejected input or capacity denial', async () => {
    const makeService = (activeSpecialists: number) =>
      new ProjectService({
        repository,
        scheduler: new FixtureScheduler({
          now: () => new Date('2026-08-31T21:00:00.000Z'),
          nextId: createDeterministicUuid(`capacity-${activeSpecialists}`),
          expectedRevision: '857f0f9b02210000000000000000000000000000',
          activeSpecialists,
        }),
        nextId: createDeterministicUuid(`project-${activeSpecialists}`),
      });

    await expect(
      makeService(0).submitObjective({
        actorId: '40000000-0000-4000-8000-000000000003',
        idempotencyKey: 'invalid-objective',
        correlationId: '40000000-0000-4000-8000-000000000004',
        objective: '   ',
        fixtureScenario: 'PASS',
      }),
    ).rejects.toMatchObject({ code: 'OBJECTIVE_INVALID' });
    await expect(
      makeService(4).submitObjective({
        actorId: '40000000-0000-4000-8000-000000000003',
        idempotencyKey: 'capacity-objective',
        correlationId: '40000000-0000-4000-8000-000000000005',
        objective: 'Create a deterministic release-note artifact for the fixture',
        fixtureScenario: 'PASS',
      }),
    ).rejects.toMatchObject({ code: 'SPECIALIST_CEILING' });

    const counts = await pool.query<{ projects: string; events: string }>(`
      SELECT
        (SELECT count(*) FROM project_snapshots)::text AS projects,
        (SELECT count(*) FROM project_events)::text AS events`);
    expect(counts.rows[0]).toEqual({ projects: '0', events: '0' });
  });

  it('serializes concurrent PostgreSQL reservations at cognitive and specialist ceilings', async () => {
    const submissions = Array.from({ length: 9 }, (_, index) => {
      const scheduler = new FixtureScheduler({
        now: () => new Date('2026-08-31T21:00:00.000Z'),
        nextId: createDeterministicUuid(`concurrent-scheduler-${index}`),
        expectedRevision: '857f0f9b02210000000000000000000000000000',
      });
      const service = new ProjectService({
        repository,
        scheduler,
        nextId: createDeterministicUuid(`concurrent-project-${index}`),
      });
      return service.submitObjective({
        actorId: '40000000-0000-4000-8000-000000000006',
        idempotencyKey: `concurrent-objective-${index}`,
        correlationId: createDeterministicUuid(`concurrent-correlation-${index}`)(),
        objective: 'Create a deterministic release-note artifact for the fixture',
        fixtureScenario: 'PASS',
      });
    });

    const settled = await Promise.allSettled(submissions);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<(typeof submissions)[number]>> =>
        result.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(5);
    expect(rejected.every(({ reason }) => reason.code === 'SPECIALIST_CEILING')).toBe(true);
    expect(
      fulfilled.filter(({ value }) => value.scheduling.execution.state === 'WAITING_FOR_APPROVAL'),
    ).toHaveLength(3);
    expect(
      fulfilled.filter(({ value }) => value.scheduling.queueReason === 'COGNITIVE_CAPACITY'),
    ).toHaveLength(1);
    const persisted = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM project_snapshots',
    );
    expect(persisted.rows[0]?.count).toBe('4');
  });
});
