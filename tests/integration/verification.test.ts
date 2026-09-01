import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPostgresControlPlane,
  InMemoryApprovedEffectExecutor,
} from '../../apps/control-plane/src/index.js';
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

describe.sequential('PostgreSQL verification persistence and compare-and-commit', () => {
  const supervisorId = '74000000-0000-4000-8000-000000000001';
  const revision = '857f0f9b02210000000000000000000000000000';
  let embedded: EmbeddedPostgres;
  let pool: Pool;
  let databaseDirectory: string;
  let artifactRoot: string;

  beforeAll(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), 'moonshift-us3-postgres-'));
    artifactRoot = join(await mkdtemp(join(tmpdir(), 'moonshift-us3-artifacts-parent-')), 'store');
    const port = await unusedLoopbackPort();
    const user = 'moonshift_us3';
    const password = ['fixture', 'postgres', 'us3'].join('-');
    embedded = new EmbeddedPostgres({
      databaseDir: databaseDirectory,
      port,
      user,
      password,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=20'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    pool = new Pool({ host: '127.0.0.1', port, database: 'postgres', user, password, max: 6 });
    await runMigrations(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE project_events, project_snapshots, idempotency_records,
      backend_event_projections, projection_checkpoints, leases, queue_items,
      outbox_events, audit_events, aggregates RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
    await embedded?.stop();
    if (databaseDirectory !== undefined)
      await rm(databaseDirectory, { recursive: true, force: true });
    if (artifactRoot !== undefined)
      await rm(join(artifactRoot, '..'), { recursive: true, force: true });
  }, 120_000);

  async function approvedControlPlane(seed: string, storeRoot: string) {
    const controlPlane = createPostgresControlPlane({
      pool,
      bootstrapSecret: 'v'.repeat(48),
      origin: 'http://127.0.0.1:4173',
      supervisorId,
      expectedRevision: revision,
      runnerId: '74000000-0000-4000-8000-000000000002',
      nextId: createDeterministicUuid(seed),
      effectExecutor: new InMemoryApprovedEffectExecutor(),
      artifactRoot: storeRoot,
    });
    const submitted = await controlPlane.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: `${seed}-objective`,
      correlationId: '74000000-0000-4000-8000-000000000011',
      objective: 'Publish and verify one deterministic fixture result',
      fixtureScenario: 'PASS',
    });
    const approval = (await controlPlane.supervision.getProjection(submitted.view.projectId))
      .approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    await controlPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: submitted.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Approve the exact fixture marker',
      expectedVersion: approval.version,
      idempotencyKey: `${seed}-approval`,
      correlationId: '74000000-0000-4000-8000-000000000012',
    });
    return { controlPlane, submitted };
  }

  it('persists attribution and immutable inputs atomically, rejects a stale commit, then accepts a fresh evaluation', async () => {
    const nextId = createDeterministicUuid('us3-verification-persistence');
    const controlPlane = createPostgresControlPlane({
      pool,
      bootstrapSecret: 'v'.repeat(48),
      origin: 'http://127.0.0.1:4173',
      supervisorId,
      expectedRevision: revision,
      runnerId: '74000000-0000-4000-8000-000000000002',
      nextId,
      effectExecutor: new InMemoryApprovedEffectExecutor(),
      artifactRoot,
    });
    const submitted = await controlPlane.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'us3-verification-objective',
      correlationId: '74000000-0000-4000-8000-000000000003',
      objective: 'Publish and verify one deterministic fixture result',
      fixtureScenario: 'PASS',
    });
    const approval = (await controlPlane.supervision.getProjection(submitted.view.projectId))
      .approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    await controlPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: submitted.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Approve the exact fixture marker',
      expectedVersion: approval.version,
      idempotencyKey: 'us3-verification-approval',
      correlationId: '74000000-0000-4000-8000-000000000004',
    });

    const prepared = await controlPlane.verification.prepareFixtureEvaluation({
      projectId: submitted.view.projectId,
      correlationId: '74000000-0000-4000-8000-000000000005',
      disposition: 'PASS',
    });
    expect(prepared.taskState).toBe('VERIFYING');
    expect(prepared.artifact).toMatchObject({
      projectId: submitted.view.projectId,
      taskId: submitted.view.tasks[0]?.taskId,
      executionId: submitted.scheduling.execution.executionId,
      gitRevision: revision,
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(prepared.evidence.every(({ gitRevision }) => gitRevision === revision)).toBe(true);
    expect(prepared.evaluation.snapshot.materialHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(
      controlPlane.artifactStore.get(prepared.artifact.contentHash, {
        artifactId: prepared.artifact.artifactId,
        projectId: prepared.artifact.projectId,
        taskId: prepared.artifact.taskId,
        executionId: prepared.artifact.executionId,
        gitRevision: prepared.artifact.gitRevision,
        kind: prepared.artifact.kind,
        mediaType: prepared.artifact.mediaType,
      }),
    ).resolves.toHaveLength(prepared.artifact.size);

    const persisted = await pool.query<{
      artifacts: number;
      evidence: number;
      policies: number;
      rules: number;
      evaluations: number;
    }>(`SELECT
      (SELECT count(*)::integer FROM verification_artifacts) AS artifacts,
      (SELECT count(*)::integer FROM verification_evidence) AS evidence,
      (SELECT count(*)::integer FROM verification_policies) AS policies,
      (SELECT count(*)::integer FROM verification_rules) AS rules,
      (SELECT count(*)::integer FROM verification_evaluations) AS evaluations`);
    expect(persisted.rows[0]).toEqual({
      artifacts: 1,
      evidence: prepared.evidence.length,
      policies: 1,
      rules: prepared.evaluation.snapshot.policy.rules.length,
      evaluations: 1,
    });

    await controlPlane.verification.recordEvidence({
      projectId: submitted.view.projectId,
      correlationId: '74000000-0000-4000-8000-000000000006',
      evidence: {
        ...prepared.evidence[0]!,
        evidenceId: '74000000-0000-4000-8000-000000000007',
        type: 'RECONCILIATION',
        observedAt: '2026-09-01T09:10:00.000Z',
      },
    });
    const stale = await controlPlane.verification.commitEvaluation({
      projectId: submitted.view.projectId,
      evaluationId: prepared.evaluation.evaluationId,
      correlationId: '74000000-0000-4000-8000-000000000008',
    });
    expect(stale.evaluation.state).toBe('STALE');
    expect(stale.taskState).toBe('VERIFYING');
    expect(stale.requiresFreshEvaluation).toBe(true);
    expect(
      (
        await pool.query<{ state: string }>(
          'SELECT state FROM verification_evaluations WHERE evaluation_id = $1',
          [prepared.evaluation.evaluationId],
        )
      ).rows[0]?.state,
    ).toBe('STALE');

    const fresh = await controlPlane.verification.beginFreshEvaluation({
      projectId: submitted.view.projectId,
      correlationId: '74000000-0000-4000-8000-000000000009',
    });
    expect(fresh.evaluationId).not.toBe(prepared.evaluation.evaluationId);
    const committed = await controlPlane.verification.commitEvaluation({
      projectId: submitted.view.projectId,
      evaluationId: fresh.evaluationId,
      correlationId: '74000000-0000-4000-8000-000000000010',
    });
    expect(committed.evaluation.state).toBe('PASSED');
    expect(committed.taskState).toBe('VERIFIED');
    expect(committed.requiresFreshEvaluation).toBe(false);

    const durable = await controlPlane.repository.get(submitted.view.projectId);
    expect(durable?.view.tasks[0]?.state).toBe('VERIFIED');
    expect(durable?.verification.evaluations.map(({ state }) => state)).toEqual([
      'STALE',
      'PASSED',
    ]);
    expect(durable?.verification.artifacts[0]?.contentHash).toBe(prepared.artifact.contentHash);
    await controlPlane.server.close();
  }, 60_000);

  it('fails closed when physical artifact bytes change after snapshot capture', async () => {
    const { controlPlane, submitted } = await approvedControlPlane(
      'us3-physical-tamper',
      join(artifactRoot, 'physical-tamper'),
    );
    try {
      const prepared = await controlPlane.verification.prepareFixtureEvaluation({
        projectId: submitted.view.projectId,
        correlationId: '74000000-0000-4000-8000-000000000013',
        disposition: 'PASS',
      });
      await writeFile(
        controlPlane.artifactStore.pathFor(prepared.artifact.contentHash),
        'tampered',
      );

      const committed = await controlPlane.verification.commitEvaluation({
        projectId: submitted.view.projectId,
        evaluationId: prepared.evaluation.evaluationId,
        correlationId: '74000000-0000-4000-8000-000000000014',
      });
      expect(committed.evaluation.state).toBe('STALE');
      expect(committed.taskState).toBe('VERIFYING');
      expect(committed.blockingReasons).toContain(
        'Published artifact hash changed or bytes failed integrity validation after snapshot capture',
      );

      const durable = await controlPlane.repository.get(submitted.view.projectId);
      expect(durable?.view.tasks[0]?.state).toBe('VERIFYING');
      expect(durable?.verification.evaluations.at(-1)?.state).toBe('STALE');
      const persisted = await pool.query<{ state: string }>(
        'SELECT state FROM verification_evaluations WHERE evaluation_id = $1',
        [prepared.evaluation.evaluationId],
      );
      expect(persisted.rows[0]?.state).toBe('STALE');
    } finally {
      await controlPlane.server.close();
    }
  }, 60_000);

  it('atomically stales an evaluating snapshot on pause and verifies only a fresh post-resume evaluation', async () => {
    const { controlPlane, submitted } = await approvedControlPlane(
      'us3-pause-resume',
      join(artifactRoot, 'pause-resume'),
    );
    try {
      const prepared = await controlPlane.verification.prepareFixtureEvaluation({
        projectId: submitted.view.projectId,
        correlationId: '74000000-0000-4000-8000-000000000015',
        disposition: 'PASS',
      });
      const beforePause = await controlPlane.repository.get(submitted.view.projectId);
      if (beforePause === null) throw new Error('Expected project before pause');
      const bootstrap = await controlPlane.server.inject({
        method: 'POST',
        url: '/v1/session/bootstrap',
        headers: { origin: 'http://127.0.0.1:4173' },
        payload: { bootstrapSecret: 'v'.repeat(48) },
      });
      const cookie = bootstrap.headers['set-cookie']?.split(';')[0];
      if (cookie === undefined) throw new Error('Expected supervisor session cookie');
      const pause = await controlPlane.server.inject({
        method: 'POST',
        url: `/v1/projects/${submitted.view.projectId}/commands/pause`,
        headers: {
          cookie,
          'idempotency-key': 'us3-verification-pause',
          'x-correlation-id': '74000000-0000-4000-8000-000000000016',
          'if-match': `"${beforePause.view.version}"`,
        },
        payload: { reason: 'Serialize pause against the evaluating verification snapshot' },
      });
      expect(pause.statusCode, pause.body).toBe(202);

      const paused = await controlPlane.repository.get(submitted.view.projectId);
      expect(paused?.view.status).toBe('PAUSED');
      expect(paused?.view.tasks[0]?.state).toBe('VERIFYING');
      expect(paused?.verification.evaluations.at(-1)).toMatchObject({
        evaluationId: prepared.evaluation.evaluationId,
        state: 'STALE',
        blockingReasons: ['Project reached PAUSED before verification commit'],
      });
      expect(paused?.supervision.audit.at(-1)).toMatchObject({
        action: 'verification.decided',
        outcome: 'STALE',
      });
      const pausedEvaluation = await pool.query<{ state: string }>(
        'SELECT state FROM verification_evaluations WHERE evaluation_id = $1',
        [prepared.evaluation.evaluationId],
      );
      expect(pausedEvaluation.rows[0]?.state).toBe('STALE');

      if (paused === null) throw new Error('Expected paused project');
      const resume = await controlPlane.server.inject({
        method: 'POST',
        url: `/v1/projects/${submitted.view.projectId}/commands/resume`,
        headers: {
          cookie,
          'idempotency-key': 'us3-verification-resume',
          'x-correlation-id': '74000000-0000-4000-8000-000000000017',
          'if-match': `"${paused.view.version}"`,
        },
        payload: { reason: 'Resume under fresh authority for reevaluation' },
      });
      expect(resume.statusCode, resume.body).toBe(202);

      const durable = await controlPlane.repository.get(submitted.view.projectId);
      expect(durable?.verification.evaluations.map(({ state }) => state)).toEqual([
        'STALE',
        'PASSED',
      ]);
      expect(durable?.verification.evaluations[1]?.evaluationId).not.toBe(
        prepared.evaluation.evaluationId,
      );
      expect(durable?.view.tasks[0]?.state).toBe('VERIFIED');
    } finally {
      await controlPlane.server.close();
    }
  }, 60_000);

  it('converges a filesystem publication after a database rollback without changing artifact identity', async () => {
    const storeRoot = join(artifactRoot, 'rollback-retry');
    const { controlPlane, submitted } = await approvedControlPlane('us3-rollback-retry', storeRoot);
    const triggerName = 'moonshift_test_fail_verification_artifact';
    try {
      await pool.query(`CREATE OR REPLACE FUNCTION ${triggerName}() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected verification artifact rollback'; END $$`);
      await pool.query(`CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON verification_artifacts
        FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
      await expect(
        controlPlane.verification.prepareFixtureEvaluation({
          projectId: submitted.view.projectId,
          correlationId: '74000000-0000-4000-8000-000000000020',
          disposition: 'PASS',
        }),
      ).rejects.toThrow(/injected verification artifact rollback/u);
      await pool.query(`DROP TRIGGER ${triggerName} ON verification_artifacts`);
      await pool.query(`DROP FUNCTION ${triggerName}()`);

      const metadataFilesAfterRollback = await readdir(join(storeRoot, 'metadata'));
      expect(metadataFilesAfterRollback).toHaveLength(1);
      const sidecar = JSON.parse(
        await readFile(join(storeRoot, 'metadata', metadataFilesAfterRollback[0]!), 'utf8'),
      ) as { artifactId: string; contentHash: string };
      const retried = await controlPlane.verification.prepareFixtureEvaluation({
        projectId: submitted.view.projectId,
        correlationId: '74000000-0000-4000-8000-000000000020',
        disposition: 'PASS',
      });
      expect(retried.artifact.artifactId).toBe(sidecar.artifactId);
      expect(retried.artifact.contentHash).toBe(sidecar.contentHash);
      expect(await readdir(join(storeRoot, 'metadata'))).toHaveLength(1);
      const persisted = await pool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM verification_artifacts WHERE artifact_id = $1',
        [retried.artifact.artifactId],
      );
      expect(persisted.rows[0]?.count).toBe(1);
      await expect(
        controlPlane.verification.commitEvaluation({
          projectId: submitted.view.projectId,
          evaluationId: retried.evaluation.evaluationId,
          correlationId: '74000000-0000-4000-8000-000000000021',
        }),
      ).resolves.toMatchObject({ evaluation: { state: 'PASSED' }, taskState: 'VERIFIED' });
    } finally {
      await pool
        .query(`DROP TRIGGER IF EXISTS ${triggerName} ON verification_artifacts`)
        .catch(() => undefined);
      await pool.query(`DROP FUNCTION IF EXISTS ${triggerName}()`).catch(() => undefined);
      await controlPlane.server.close();
    }
  }, 60_000);
});
