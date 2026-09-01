import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_CONNECTIONS } from '../../packages/backend-fake/src/index.js';
import {
  type ApprovedEffectExecutor,
  createPostgresControlPlane,
  InMemoryApprovedEffectExecutor,
  PostgresProjectRepository,
  ProjectService,
} from '../../apps/control-plane/src/index.js';
import { FixtureScheduler } from '../../apps/control-plane/src/scheduler/index.js';
import { runMigrations } from '../../packages/persistence/src/index.js';
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

describe.sequential('PostgreSQL control-plane restart recovery', () => {
  const supervisorId = '76000000-0000-4000-8000-000000000001';
  const runnerId = '76000000-0000-4000-8000-000000000002';
  const revision = '857f0f9b02210000000000000000000000000000';
  const effectExecutor = new InMemoryApprovedEffectExecutor();
  let embedded: EmbeddedPostgres;
  let pool: Pool;
  let databaseDirectory: string;
  let artifactRoot: string;

  beforeAll(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), 'moonshift-us4-postgres-'));
    artifactRoot = join(await mkdtemp(join(tmpdir(), 'moonshift-us4-artifacts-')), 'store');
    const port = await unusedLoopbackPort();
    const user = 'moonshift_us4';
    const password = ['fixture', 'postgres', 'us4'].join('-');
    embedded = new EmbeddedPostgres({
      databaseDir: databaseDirectory,
      port,
      user,
      password,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=12'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    pool = new Pool({ host: '127.0.0.1', port, database: 'postgres', user, password, max: 4 });
    await runMigrations(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await embedded?.stop();
    if (databaseDirectory !== undefined)
      await rm(databaseDirectory, { recursive: true, force: true });
    if (artifactRoot !== undefined)
      await rm(join(artifactRoot, '..'), { recursive: true, force: true });
  }, 120_000);

  beforeEach(async () => {
    effectExecutor.clear();
    await pool.query(`TRUNCATE TABLE
      verification_evaluations, verification_rules, verification_evidence, verification_artifacts,
      verification_policies,
      project_events, project_snapshots, idempotency_records, backend_event_projections,
      projection_checkpoints, leases, queue_items, outbox_events, audit_events, aggregates
      RESTART IDENTITY CASCADE`);
  });

  type RestartOverrides = Pick<
    Parameters<typeof createPostgresControlPlane>[0],
    'afterRemoteRecovery' | 'effectExecutor' | 'heartbeatTimeoutMs' | 'recoveryBackendConnections'
  >;
  const restartedControlPlane = (seed: string, overrides: RestartOverrides = {}) =>
    createPostgresControlPlane({
      pool,
      bootstrapSecret: 'u'.repeat(48),
      origin: 'http://127.0.0.1:4178',
      supervisorId,
      expectedRevision: revision,
      runnerId,
      nextId: createDeterministicUuid(seed),
      effectExecutor: overrides.effectExecutor ?? effectExecutor,
      artifactRoot,
      ...(overrides.afterRemoteRecovery === undefined
        ? {}
        : { afterRemoteRecovery: overrides.afterRemoteRecovery }),
      ...(overrides.heartbeatTimeoutMs === undefined
        ? {}
        : { heartbeatTimeoutMs: overrides.heartbeatTimeoutMs }),
      ...(overrides.recoveryBackendConnections === undefined
        ? {}
        : { recoveryBackendConnections: overrides.recoveryBackendConnections }),
    });

  it('reconstructs an interrupted active runtime, switches backend, and remains replay-safe', async () => {
    const repository = new PostgresProjectRepository(pool);
    const scheduler = new FixtureScheduler({
      now: () => new Date('2026-09-01T08:00:00.000Z'),
      nextId: createDeterministicUuid('us4-restart-scheduler'),
      expectedRevision: revision,
    });
    const service = new ProjectService({
      repository,
      scheduler,
      nextId: createDeterministicUuid('us4-restart-project'),
    });
    const submitted = await service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-restart-objective',
      correlationId: '76000000-0000-4000-8000-000000000003',
      objective: 'Recover an interrupted deterministic fixture task without duplicate work',
      fixtureScenario: 'PASS',
    });
    const before = await repository.get(submitted.view.projectId);
    if (before === null) throw new Error('Expected durable project before restart');
    expect(before.supervision.checkpoint).toBeNull();

    scheduler.setFixtureCapacity({ activeCognitiveRuns: 3 });
    const queued = await service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-restart-queued-objective',
      correlationId: '76000000-0000-4000-8000-000000000005',
      objective: 'Retain one claimed queue item across the restart boundary',
      fixtureScenario: 'PASS',
    });
    expect(queued.scheduling.execution.state).toBe('QUEUED');
    await pool.query(
      `UPDATE queue_items
       SET status = 'CLAIMED', claimed_by = 'crashed-worker', claimed_at = clock_timestamp(),
           claim_expires_at = clock_timestamp() - interval '1 second'
       WHERE queue_item_id = $1`,
      [queued.scheduling.execution.executionId],
    );
    await pool.query(
      `UPDATE outbox_events
       SET status = 'CLAIMED',
           published_at = NULL,
           claimed_by = 'crashed-projector',
           claimed_at = clock_timestamp() - interval '2 seconds',
           claim_expires_at = clock_timestamp() - interval '1 second',
           claim_token = claim_token + 1
       WHERE project_id = $1 AND project_sequence = $2`,
      [queued.view.projectId, queued.view.lastSequence],
    );
    await pool.query(
      `INSERT INTO projection_checkpoints (projection_name, project_id, last_sequence)
       VALUES ('project-events', $1, 0)
       ON CONFLICT (projection_name, project_id) DO UPDATE SET last_sequence = 0`,
      [submitted.view.projectId],
    );
    await pool.query(`DELETE FROM outbox_events WHERE project_id = $1 AND project_sequence = 2`, [
      submitted.view.projectId,
    ]);
    const retainedBeforeRestart = await pool.query<{ event_id: string; project_sequence: string }>(
      `SELECT event_id, project_sequence::text FROM project_events
       WHERE project_id = $1 ORDER BY project_events.project_sequence`,
      [submitted.view.projectId],
    );
    expect(retainedBeforeRestart.rows).toEqual(
      before.events.map((event) => ({
        event_id: event.eventId,
        project_sequence: String(event.sequence),
      })),
    );

    const firstRestart = restartedControlPlane('us4-control-plane-restart-one');
    await firstRestart.server.ready();
    const recovered = await firstRestart.repository.get(submitted.view.projectId);
    if (recovered === null) throw new Error('Expected recovered project');
    expect(recovered.view.projectId).toBe(before.view.projectId);
    expect(recovered.view.tasks[0]?.taskId).toBe(before.view.tasks[0]?.taskId);
    expect(recovered.organization.specialist.agentId).toBe(before.organization.specialist.agentId);
    expect(recovered.supervision.blockedReasons).toEqual([]);
    expect(recovered.supervision.recovery).toMatchObject({
      state: 'RESUMED',
      sourceExecutionId: before.supervision.authority.executionId,
      successorExecutionId: recovered.supervision.authority.executionId,
      sourceConnectionId: before.scheduling.execution.connectionId,
      targetConnectionId: recovered.scheduling.execution.connectionId,
    });
    expect(recovered.supervision.checkpoint?.execution.executionId).toBe(
      recovered.supervision.authority.executionId,
    );
    expect(recovered.supervision.checkpoint?.reason).toBe('BACKEND_SWITCH');
    expect(recovered.supervision.checkpoint?.continuation).toMatchObject({
      scenario: 'PASS',
      cursor: 'BEFORE_EFFECT',
      nextSequence: 6,
    });
    expect(recovered.supervision.authority.fencingToken).toBe(
      before.supervision.authority.fencingToken + 1,
    );
    const recoveredDelivery = await pool.query<{
      outbox_count: string;
      pending_count: string;
      projection_sequence: string;
      queued_status: string;
    }>(
      `SELECT
         (SELECT count(*) FROM outbox_events WHERE project_id = $1)::text AS outbox_count,
         (SELECT count(*) FROM outbox_events WHERE project_id = $1 AND status <> 'PUBLISHED')::text
           AS pending_count,
         (SELECT last_sequence::text FROM projection_checkpoints
          WHERE projection_name = 'project-events' AND project_id = $1) AS projection_sequence,
         (SELECT status FROM queue_items WHERE queue_item_id = $2) AS queued_status`,
      [submitted.view.projectId, queued.scheduling.execution.executionId],
    );
    expect(recoveredDelivery.rows[0]).toEqual({
      outbox_count: String(recovered.events.length),
      pending_count: '0',
      projection_sequence: String(recovered.view.lastSequence),
      queued_status: 'AVAILABLE',
    });
    const recoveredAppliedBeforeAck = await pool.query<{
      checkpoint_sequence: string;
      status: string;
    }>(
      `SELECT
         (SELECT last_sequence::text FROM projection_checkpoints
          WHERE projection_name = 'project-events' AND project_id = $1) AS checkpoint_sequence,
         (SELECT status FROM outbox_events
          WHERE project_id = $1 AND project_sequence = $2) AS status`,
      [queued.view.projectId, queued.view.lastSequence],
    );
    expect(recoveredAppliedBeforeAck.rows[0]).toEqual({
      checkpoint_sequence: String(queued.view.lastSequence),
      status: 'PUBLISHED',
    });
    expect(
      recovered.events
        .filter(
          ({ kind, aggregate }) =>
            kind === 'execution.state_changed' &&
            aggregate.id === before.supervision.authority.executionId,
        )
        .map(({ payload }) => payload.toState),
    ).toEqual(expect.arrayContaining(['LOST', 'RECONCILING']));

    const recoveredVersion = recovered.view.version;
    const replayed = await firstRestart.recovery.recoverLostRuntime({
      projectId: recovered.view.projectId,
      sourceExecutionId: before.supervision.authority.executionId,
      correlationId: '76000000-0000-4000-8000-000000000004',
    });
    expect(replayed).toEqual(recovered.supervision.recovery);
    expect((await firstRestart.repository.get(recovered.view.projectId))?.view.version).toBe(
      recoveredVersion,
    );
    await firstRestart.server.close();

    const secondRestart = restartedControlPlane('us4-control-plane-restart-two');
    await secondRestart.server.ready();
    const recoveredAgain = await secondRestart.repository.get(recovered.view.projectId);
    if (recoveredAgain === null) throw new Error('Expected second recovered project');
    expect(recoveredAgain.supervision.recovery.sourceExecutionId).toBe(
      recovered.supervision.authority.executionId,
    );
    expect(recoveredAgain.supervision.authority.executionId).not.toBe(
      recovered.supervision.authority.executionId,
    );
    expect(recoveredAgain.scheduling.observations).toHaveLength(
      recovered.scheduling.observations.length,
    );
    expect(recoveredAgain.supervision.checkpoint?.execution.executionId).toBe(
      recoveredAgain.supervision.authority.executionId,
    );
    expect(recoveredAgain.supervision.checkpoint?.continuation.normalizedWorkHash).toBe(
      recovered.supervision.checkpoint?.continuation.normalizedWorkHash,
    );
    expect(recoveredAgain.scheduling.execution.connectionId).toBe(
      before.scheduling.execution.connectionId,
    );
    expect(recoveredAgain.supervision.authority.fencingToken).toBe(
      recovered.supervision.authority.fencingToken + 1,
    );
    const uncertainEffect = recoveredAgain.supervision.effects[0];
    if (uncertainEffect === undefined) throw new Error('Expected fixture effect');
    await secondRestart.repository.mutate({
      scope: `us4-unknown-effect:${recoveredAgain.view.projectId}`,
      idempotencyKey: 'us4-unknown-effect-fixture',
      requestHash: `sha256:${'4'.repeat(64)}`,
      projectId: recoveredAgain.view.projectId,
      mutate: async (record) => ({
        record: Object.freeze({
          ...record,
          view: Object.freeze({ ...record.view, version: record.view.version + 1 }),
          supervision: Object.freeze({
            ...record.supervision,
            effects: Object.freeze(
              record.supervision.effects.map((effect) =>
                effect.effectId === uncertainEffect.effectId
                  ? Object.freeze({
                      ...effect,
                      state: 'UNKNOWN' as const,
                      reconciliationOutcome: 'RECONCILIATION_REQUIRED',
                      version: effect.version + 1,
                    })
                  : effect,
              ),
            ),
          }),
        }),
        response: { seeded: true },
      }),
    });
    await secondRestart.server.close();

    const reconciliationRestart = restartedControlPlane('us4-control-plane-reconcile');
    await reconciliationRestart.server.ready();
    const reconciled = await reconciliationRestart.repository.get(recoveredAgain.view.projectId);
    expect(reconciled?.supervision.effects[0]).toMatchObject({
      effectId: uncertainEffect.effectId,
      state: 'RECONCILED',
      reconciliationOutcome: 'GROUND_TRUTH_NOT_APPLIED',
    });
    expect(
      reconciled?.events
        .filter(({ aggregate }) => aggregate.id === uncertainEffect.effectId)
        .map(({ payload }) => payload.toState),
    ).toEqual(expect.arrayContaining(['RECONCILING', 'RECONCILED']));
    const staleApproval = recoveredAgain.supervision.approvals[0];
    if (staleApproval === undefined) throw new Error('Expected stale-runtime approval fixture');
    await expect(
      effectExecutor.execute({
        messageId: '76000000-0000-4000-8000-000000000006',
        correlationId: '76000000-0000-4000-8000-000000000007',
        effectId: uncertainEffect.effectId,
        actionDigest: uncertainEffect.actionDigest,
        operation: recoveredAgain.supervision.action.operation,
        executionId: recoveredAgain.supervision.authority.executionId,
        leaseId: recoveredAgain.supervision.authority.runnerLeaseId,
        fencingToken: recoveredAgain.supervision.authority.fencingToken,
        approval: {
          state: 'APPROVED',
          actionDigest: staleApproval.actionDigest,
          expiresAt: staleApproval.expiresAt,
        },
        authority: {
          authorizedAt: recoveredAgain.supervision.recovery.updatedAt,
          leaseExpiresAt: recoveredAgain.supervision.authority.runnerLeaseExpiresAt,
        },
      }),
    ).rejects.toThrow('STALE_RUNTIME_FENCE');
    await reconciliationRestart.server.close();
  });

  it('replays stable remote recovery identities after a crash before final commit', async () => {
    const delegate = new InMemoryApprovedEffectExecutor();
    const revokeMessageIds: string[] = [];
    const recordingExecutor = {
      execute: (input) => delegate.execute(input),
      lookup: (input) => delegate.lookup(input),
      revoke: (input) => {
        revokeMessageIds.push(input.messageId);
        return delegate.revoke(input);
      },
    } satisfies ApprovedEffectExecutor;
    let remoteSuccessorExecutionId: string | null = null;
    let interruptAfterRemote = true;
    const initial = restartedControlPlane('us4-remote-crash-initial', {
      effectExecutor: recordingExecutor,
      afterRemoteRecovery: ({ successorExecutionId }) => {
        remoteSuccessorExecutionId = successorExecutionId;
        if (interruptAfterRemote) {
          interruptAfterRemote = false;
          throw new Error('FIXTURE_CRASH_AFTER_REMOTE_RECOVERY');
        }
      },
    });
    await initial.server.ready();
    const submitted = await initial.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-remote-crash-objective',
      correlationId: '76000000-0000-4000-8000-000000000012',
      objective: 'Resume recovery safely when remote work completed before a process crash',
      fixtureScenario: 'INTERRUPT_DURING_EFFECT',
    });
    const source = await initial.repository.get(submitted.view.projectId);
    if (source === null) throw new Error('Expected remote recovery source project');
    const uncertainEffect = source.supervision.effects[0];
    if (uncertainEffect === undefined) throw new Error('Expected remote recovery effect');
    await initial.repository.mutate({
      scope: `us4-remote-crash-fixture:${source.view.projectId}`,
      idempotencyKey: 'us4-remote-crash-unknown-effect',
      requestHash: `sha256:${'7'.repeat(64)}`,
      projectId: source.view.projectId,
      mutate: async (record) => ({
        record: Object.freeze({
          ...record,
          view: Object.freeze({ ...record.view, version: record.view.version + 1 }),
          supervision: Object.freeze({
            ...record.supervision,
            effects: Object.freeze(
              record.supervision.effects.map((effect) =>
                effect.effectId === uncertainEffect.effectId
                  ? Object.freeze({
                      ...effect,
                      state: 'UNKNOWN' as const,
                      reconciliationOutcome: 'RECONCILIATION_REQUIRED',
                      version: effect.version + 1,
                    })
                  : effect,
              ),
            ),
          }),
        }),
        response: { uncertain: true },
      }),
    });

    await expect(
      initial.recovery.recoverLostRuntime({
        projectId: source.view.projectId,
        sourceExecutionId: source.supervision.authority.executionId,
        correlationId: '76000000-0000-4000-8000-000000000013',
      }),
    ).rejects.toThrow('FIXTURE_CRASH_AFTER_REMOTE_RECOVERY');
    const prepared = await initial.repository.get(source.view.projectId);
    expect(prepared?.supervision).toMatchObject({
      checkpoint: { reason: 'RUNTIME_LOST' },
      authority: {
        executionId: source.supervision.authority.executionId,
        executionState: 'RECONCILING',
        runnerLeaseState: 'REVOKED',
        fencingToken: source.supervision.authority.fencingToken + 1,
      },
      recovery: { state: 'RECONCILING' },
    });
    expect(remoteSuccessorExecutionId).toEqual(expect.any(String));
    expect(revokeMessageIds).toHaveLength(1);
    const durableIntent = await pool.query<{ response: { backendSwitchIds: string[] } }>(
      `SELECT response FROM idempotency_records
       WHERE scope = $1 AND idempotency_key = $2`,
      [
        `runtime-recovery-prepare:${source.view.projectId}`,
        source.supervision.authority.executionId,
      ],
    );
    expect(durableIntent.rows[0]?.response.backendSwitchIds).toHaveLength(5);
    await initial.server.close();

    const restarted = restartedControlPlane('us4-remote-crash-restart', {
      effectExecutor: recordingExecutor,
    });
    await restarted.server.ready();
    const recovered = await restarted.repository.get(source.view.projectId);
    expect(recovered?.supervision.recovery).toMatchObject({
      state: 'RESUMED',
      sourceExecutionId: source.supervision.authority.executionId,
      successorExecutionId: remoteSuccessorExecutionId,
      progress: expect.stringContaining('supervisor approval'),
    });
    expect(recovered?.supervision.checkpoint?.continuation).toMatchObject({
      scenario: 'PASS',
      cursor: 'BEFORE_EFFECT',
      nextSequence: 6,
    });
    expect(
      recovered?.scheduling.observations.some(
        (observation) =>
          observation.accepted &&
          observation.event.executionId === remoteSuccessorExecutionId &&
          observation.event.eventType === 'FAILED',
      ),
    ).toBe(false);
    expect(recovered?.supervision.effects).toHaveLength(2);
    expect(recovered?.supervision.effects[0]).toMatchObject({
      effectId: uncertainEffect.effectId,
      state: 'RECONCILED',
      reconciliationOutcome: 'GROUND_TRUTH_NOT_APPLIED',
    });
    expect(recovered?.supervision.effects[1]).toMatchObject({
      state: 'REQUESTED',
      semanticKey: uncertainEffect.semanticKey,
    });
    expect(recovered?.supervision.effects[1]?.effectId).not.toBe(uncertainEffect.effectId);
    expect(recovered?.supervision.approvals.at(-1)).toMatchObject({
      state: 'REQUESTED',
      usable: true,
    });
    expect(recovered?.supervision.toolInvocationState).toBe('WAITING_FOR_APPROVAL');
    expect(revokeMessageIds).toEqual([revokeMessageIds[0], revokeMessageIds[0]]);
    expect(
      recovered?.events.filter(
        ({ kind, aggregate }) =>
          kind === 'effect.state_changed' && aggregate.id === uncertainEffect.effectId,
      ),
    ).toHaveLength(2);
    const finalized = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM idempotency_records
       WHERE scope = $1 AND idempotency_key = $2`,
      [
        `runtime-recovery-finalize:${source.view.projectId}`,
        source.supervision.authority.executionId,
      ],
    );
    expect(finalized.rows[0]?.count).toBe('1');
    await restarted.server.close();
  });

  it('continues after reconciled APPLIED ground truth without replaying an interruption', async () => {
    const controlPlane = restartedControlPlane('us4-applied-continuation');
    await controlPlane.server.ready();
    const submitted = await controlPlane.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-applied-continuation-objective',
      correlationId: '76000000-0000-4000-8000-000000000014',
      objective: 'Continue after a recovered effect without dispatching the semantic effect twice',
      fixtureScenario: 'INTERRUPT_DURING_EFFECT',
    });
    const source = await controlPlane.repository.get(submitted.view.projectId);
    if (source === null) throw new Error('Expected applied-continuation source project');
    const uncertainEffect = source.supervision.effects[0];
    if (uncertainEffect === undefined) throw new Error('Expected applied-continuation effect');
    effectExecutor.setFixtureGroundTruth(uncertainEffect.effectId, {
      outcome: 'APPLIED',
      groundTruthDigest: `sha256:${'8'.repeat(64)}`,
    });
    await controlPlane.repository.mutate({
      scope: `us4-applied-continuation-fixture:${source.view.projectId}`,
      idempotencyKey: 'us4-applied-continuation-unknown-effect',
      requestHash: `sha256:${'9'.repeat(64)}`,
      projectId: source.view.projectId,
      mutate: async (record) => ({
        record: Object.freeze({
          ...record,
          view: Object.freeze({ ...record.view, version: record.view.version + 1 }),
          supervision: Object.freeze({
            ...record.supervision,
            effects: Object.freeze(
              record.supervision.effects.map((effect) =>
                effect.effectId === uncertainEffect.effectId
                  ? Object.freeze({
                      ...effect,
                      state: 'UNKNOWN' as const,
                      reconciliationOutcome: 'RECONCILIATION_REQUIRED',
                      version: effect.version + 1,
                    })
                  : effect,
              ),
            ),
          }),
        }),
        response: { uncertain: true },
      }),
    });

    const result = await controlPlane.recovery.recoverLostRuntime({
      projectId: source.view.projectId,
      sourceExecutionId: source.supervision.authority.executionId,
      correlationId: '76000000-0000-4000-8000-000000000015',
    });
    expect(result.state).toBe('RESUMED');
    const recovered = await controlPlane.repository.get(source.view.projectId);
    expect(recovered?.supervision.effects).toHaveLength(1);
    expect(recovered?.supervision.effects[0]).toMatchObject({
      effectId: uncertainEffect.effectId,
      state: 'RECONCILED',
      reconciliationOutcome: 'GROUND_TRUTH_APPLIED',
    });
    expect(recovered?.supervision.checkpoint?.continuation).toMatchObject({
      scenario: 'PASS',
      cursor: 'AFTER_EFFECT',
      nextSequence: 9,
    });
    expect(recovered?.supervision.toolInvocationState).toBe('APPLIED');
    const successorExecutionId = recovered?.supervision.authority.executionId;
    expect(
      recovered?.scheduling.observations
        .filter(
          (observation) =>
            observation.accepted && observation.event.executionId === successorExecutionId,
        )
        .map((observation) => (observation.accepted ? observation.event.eventType : null)),
    ).toEqual(['COMPLETED']);
    await controlPlane.server.close();
  });

  it('persists an actionable block and still becomes ready without a replacement backend', async () => {
    const initial = restartedControlPlane('us4-no-backend-initial');
    await initial.server.ready();
    const submitted = await initial.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-no-backend-objective',
      correlationId: '76000000-0000-4000-8000-000000000016',
      objective: 'Fail closed per project when no compatible recovery backend is available',
      fixtureScenario: 'PASS',
    });
    const source = await initial.repository.get(submitted.view.projectId);
    if (source === null) throw new Error('Expected no-backend recovery source project');
    await initial.server.close();

    const restarted = restartedControlPlane('us4-no-backend-restart', {
      recoveryBackendConnections: [FAKE_CONNECTIONS[0]!],
    });
    await restarted.server.ready();
    const blocked = await restarted.repository.get(source.view.projectId);
    expect(blocked?.view.status).toBe('BLOCKED');
    expect(blocked?.supervision.recovery).toMatchObject({
      state: 'BLOCKED_RECOVERY',
      sourceExecutionId: source.supervision.authority.executionId,
      successorExecutionId: null,
      targetConnectionId: null,
      progress: 'Recovery blocked because backend continuation was not authoritative',
    });
    expect(blocked?.supervision.blockedReasons).toEqual([
      'No authoritative compatible replacement backend is available',
    ]);
    expect(blocked?.supervision.authority).toMatchObject({
      executionId: source.supervision.authority.executionId,
      runnerLeaseState: 'REVOKED',
      capabilityLeaseState: 'REVOKED',
      successor: false,
    });
    await restarted.server.close();
  });

  it('persists an actionable block when restart validation finds a corrupt checkpoint', async () => {
    const initial = restartedControlPlane('us4-corrupt-initial');
    await initial.server.ready();
    const submitted = await initial.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-corrupt-objective',
      correlationId: '76000000-0000-4000-8000-000000000008',
      objective: 'Block recovery when the durable checkpoint fails integrity validation',
      fixtureScenario: 'PASS',
    });
    const source = await initial.repository.get(submitted.view.projectId);
    if (source === null) throw new Error('Expected source project');
    await initial.recovery.recoverLostRuntime({
      projectId: source.view.projectId,
      sourceExecutionId: source.supervision.authority.executionId,
      correlationId: '76000000-0000-4000-8000-000000000009',
    });
    await initial.server.close();

    await pool.query(
      `UPDATE project_snapshots
       SET record = jsonb_set(
         record,
         '{supervision,checkpoint,contentHash}',
         to_jsonb($2::text)
       )
       WHERE project_id = $1`,
      [submitted.view.projectId, `sha256:${'0'.repeat(64)}`],
    );

    const restarted = restartedControlPlane('us4-corrupt-restart');
    await restarted.server.ready();
    const blocked = await restarted.repository.get(submitted.view.projectId);
    expect(blocked?.view.status).toBe('BLOCKED');
    expect(blocked?.supervision.recovery).toMatchObject({
      state: 'BLOCKED_RECOVERY',
      progress: expect.stringContaining('checkpoint'),
    });
    expect(blocked?.supervision.blockedReasons.join(' ')).toContain('checkpoint');
    expect(blocked?.supervision.authority).toMatchObject({
      capabilityLeaseState: 'REVOKED',
      runnerLeaseState: 'REVOKED',
    });
    await restarted.server.close();
  });

  it('renews a live runtime heartbeat under its exact durable fence before scanning', async () => {
    const controlPlane = restartedControlPlane('us4-heartbeat-renewal');
    await controlPlane.server.ready();
    const submitted = await controlPlane.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-heartbeat-renewal-objective',
      correlationId: '76000000-0000-4000-8000-000000000011',
      objective: 'Keep a live runtime authoritative while it continues bounded work',
      fixtureScenario: 'PASS',
    });
    const source = await controlPlane.repository.get(submitted.view.projectId);
    if (source === null) throw new Error('Expected heartbeat renewal source project');
    await controlPlane.repository.mutate({
      scope: `us4-heartbeat-renewal-fixture:${source.view.projectId}`,
      idempotencyKey: 'us4-heartbeat-renewal-running',
      requestHash: `sha256:${'6'.repeat(64)}`,
      projectId: source.view.projectId,
      mutate: async (record) => ({
        record: Object.freeze({
          ...record,
          view: Object.freeze({ ...record.view, version: record.view.version + 1 }),
          scheduling: Object.freeze({
            ...record.scheduling,
            execution: Object.freeze({ ...record.scheduling.execution, state: 'RUNNING' as const }),
            runtime: Object.freeze({ ...record.scheduling.runtime, status: 'RUNNING' as const }),
            queueReason: null,
          }),
          supervision: Object.freeze({
            ...record.supervision,
            authority: Object.freeze({
              ...record.supervision.authority,
              executionState: 'RUNNING' as const,
              runnerLeaseExpiresAt: '2999-09-01T08:00:00.000Z',
              runnerLastHeartbeatAt: '2000-01-01T00:00:00.000Z',
            }),
          }),
        }),
        response: { running: true },
      }),
    });
    const running = await controlPlane.repository.get(source.view.projectId);
    if (running === null) throw new Error('Expected running heartbeat fixture');
    const heartbeat = await controlPlane.recovery.recordRuntimeHeartbeat({
      projectId: running.view.projectId,
      executionId: running.supervision.authority.executionId,
      leaseId: running.supervision.authority.runnerLeaseId,
      ownerId: running.scheduling.runtime.connectionId,
      fencingToken: running.supervision.authority.fencingToken,
    });

    expect(heartbeat).toMatchObject({ accepted: true, leaseExpiresAt: expect.any(String) });
    await expect(controlPlane.scanRuntimeRecovery()).resolves.toEqual([]);
    await expect(
      controlPlane.recovery.recordRuntimeHeartbeat({
        projectId: running.view.projectId,
        executionId: running.supervision.authority.executionId,
        leaseId: running.supervision.authority.runnerLeaseId,
        ownerId: running.scheduling.runtime.connectionId,
        fencingToken: running.supervision.authority.fencingToken - 1,
      }),
    ).rejects.toThrow('STALE_RUNTIME_FENCE');
    const renewed = await controlPlane.repository.get(running.view.projectId);
    expect(renewed?.supervision.authority).toMatchObject({
      executionId: running.supervision.authority.executionId,
      runnerLastHeartbeatAt: heartbeat.authorityNow,
      runnerLeaseExpiresAt: heartbeat.leaseExpiresAt,
    });
    const durableLease = await pool.query<{ expires_at: Date; status: string }>(
      `SELECT expires_at, status FROM leases WHERE lease_id = $1`,
      [running.supervision.authority.runnerLeaseId],
    );
    expect(durableLease.rows[0]).toMatchObject({ expires_at: expect.any(Date), status: 'ACTIVE' });
    expect(durableLease.rows[0]?.expires_at.toISOString()).toBe(heartbeat.leaseExpiresAt);
    await controlPlane.server.close();
  });

  it('detects a stale live heartbeat, fences the durable lease, and creates fresh authority', async () => {
    const controlPlane = restartedControlPlane('us4-heartbeat-monitor');
    await controlPlane.server.ready();
    const submitted = await controlPlane.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us4-heartbeat-objective',
      correlationId: '76000000-0000-4000-8000-000000000010',
      objective: 'Recover a live runtime whose heartbeat becomes stale',
      fixtureScenario: 'PASS',
    });
    const source = await controlPlane.repository.get(submitted.view.projectId);
    if (source === null) throw new Error('Expected heartbeat source project');
    await controlPlane.repository.mutate({
      scope: `us4-heartbeat-fixture:${source.view.projectId}`,
      idempotencyKey: 'us4-heartbeat-stale',
      requestHash: `sha256:${'5'.repeat(64)}`,
      projectId: source.view.projectId,
      mutate: async (record) => ({
        record: Object.freeze({
          ...record,
          view: Object.freeze({ ...record.view, version: record.view.version + 1 }),
          scheduling: Object.freeze({
            ...record.scheduling,
            execution: Object.freeze({ ...record.scheduling.execution, state: 'RUNNING' as const }),
            runtime: Object.freeze({ ...record.scheduling.runtime, status: 'RUNNING' as const }),
            queueReason: null,
          }),
          supervision: Object.freeze({
            ...record.supervision,
            authority: Object.freeze({
              ...record.supervision.authority,
              executionState: 'RUNNING' as const,
              runnerLeaseExpiresAt: '2999-09-01T08:00:00.000Z',
              runnerLastHeartbeatAt: '2000-01-01T00:00:00.000Z',
            }),
          }),
        }),
        response: { stale: true },
      }),
    });

    await expect(controlPlane.scanRuntimeRecovery()).resolves.toEqual([source.view.projectId]);
    const recovered = await controlPlane.repository.get(source.view.projectId);
    if (recovered === null) throw new Error('Expected heartbeat recovery result');
    expect(recovered.supervision.recovery).toMatchObject({
      state: 'RESUMED',
      sourceExecutionId: source.supervision.authority.executionId,
    });
    expect(recovered.supervision.authority).toMatchObject({
      fencingToken: source.supervision.authority.fencingToken + 1,
      runnerLeaseState: 'ACTIVE',
      successor: true,
    });
    expect(recovered.supervision.authority.runnerLeaseId).not.toBe(
      source.supervision.authority.runnerLeaseId,
    );
    const leases = await pool.query<{
      lease_id: string;
      fence: string;
      status: string;
    }>(
      `SELECT lease_id, fencing_token::text AS fence, status FROM leases
       WHERE resource_type = 'PROJECT_RUNTIME' AND resource_id = $1
       ORDER BY fencing_token`,
      [source.view.projectId],
    );
    expect(leases.rows).toEqual([
      {
        lease_id: source.supervision.authority.runnerLeaseId,
        fence: String(source.supervision.authority.fencingToken),
        status: 'REVOKED',
      },
      {
        lease_id: recovered.supervision.authority.runnerLeaseId,
        fence: String(recovered.supervision.authority.fencingToken),
        status: 'ACTIVE',
      },
    ]);
    await controlPlane.server.close();
  });
});
