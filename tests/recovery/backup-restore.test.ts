import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresProjectRepository, ProjectService } from '../../apps/control-plane/src/index.js';
import { recoverPostgresDeliveryState } from '../../apps/control-plane/src/bootstrap/recovery.js';
import { FixtureScheduler } from '../../apps/control-plane/src/scheduler/index.js';
import { FsArtifactStore, type StoredArtifact } from '../../packages/artifacts/src/index.js';
import {
  createFixtureBackup,
  restoreFixtureBackup,
  runMigrations,
  validateFixtureBackup,
} from '../../packages/persistence/src/index.js';
import { FOUNDATION_MIGRATIONS } from '../../packages/persistence/src/migrations/manifest.js';
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

const revision = '857f0f9b02210000000000000000000000000000';
const artifactOwnerId = 'moonshift-backup-owner';
const password = ['fixture', 'only', 'backup'].join('-');
const configurationReferences = Object.freeze({
  DATABASE_URL: 'secret-ref:fixture/moonshift/database',
  RUNNER_CERTIFICATE: 'credential-ref:fixture/runner/certificate',
});
const contractHashes = Object.freeze({
  'contracts/events.json': `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
  'contracts/results.json': `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
});

describe.sequential('PostgreSQL fixture backup and restore', () => {
  let embedded: EmbeddedPostgres;
  let source: Pool;
  let admin: Pool;
  let port: number;
  let databaseDirectory: string;
  let workspaceDirectory: string;
  let sourceArtifacts: string;

  beforeAll(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), 'moonshift-backup-postgres-'));
    workspaceDirectory = await mkdtemp(join(tmpdir(), 'moonshift-backup-workspace-'));
    sourceArtifacts = join(workspaceDirectory, 'source-artifacts');
    port = await unusedLoopbackPort();
    const user = 'moonshift_backup_fixture';
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
    admin = new Pool({ host: '127.0.0.1', port, database: 'postgres', user, password, max: 6 });
    source = admin;
    await runMigrations(source);
  }, 120_000);

  beforeEach(async () => {
    await source.query(`TRUNCATE TABLE
      verification_evaluations, verification_rules, verification_evidence, verification_artifacts,
      verification_policies, project_events, project_snapshots, idempotency_records,
      backend_event_projections, projection_checkpoints, leases, queue_items, outbox_events,
      audit_events, aggregates RESTART IDENTITY CASCADE`);
    await rm(sourceArtifacts, { recursive: true, force: true });
    await mkdir(sourceArtifacts, { recursive: true, mode: 0o700 });
  });

  afterAll(async () => {
    await admin?.query('DROP DATABASE IF EXISTS moonshift_backup_target');
    await admin?.end();
    await embedded?.stop();
    await rm(databaseDirectory, { recursive: true, force: true });
    await rm(workspaceDirectory, { recursive: true, force: true });
  }, 120_000);

  async function createTargetPool(name = 'moonshift_backup_target'): Promise<Pool> {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const target = new Pool({
      host: '127.0.0.1',
      port,
      database: name,
      user: 'moonshift_backup_fixture',
      password,
      max: 4,
    });
    await runMigrations(target);
    return target;
  }

  async function seedProject(): Promise<Awaited<ReturnType<ProjectService['submitObjective']>>> {
    const scheduler = new FixtureScheduler({
      now: () => new Date('2026-09-01T08:00:00.000Z'),
      nextId: createDeterministicUuid('backup-scheduler'),
      expectedRevision: revision,
    });
    return new ProjectService({
      repository: new PostgresProjectRepository(source),
      scheduler,
      nextId: createDeterministicUuid('backup-project'),
    }).submitObjective({
      actorId: '77000000-0000-4000-8000-000000000001',
      idempotencyKey: 'backup-objective',
      correlationId: '77000000-0000-4000-8000-000000000002',
      objective: 'Preserve one deterministic fixture project across restore',
      fixtureScenario: 'PASS',
    });
  }

  async function seedProjectAndArtifact(): Promise<{
    readonly submitted: Awaited<ReturnType<ProjectService['submitObjective']>>;
    readonly stored: StoredArtifact;
  }> {
    const submitted = await seedProject();
    const task = submitted.view.tasks[0];
    if (task === undefined) throw new Error('Expected fixture task');
    const artifactId = '77000000-0000-4000-8000-000000000010';
    const stored = await new FsArtifactStore({
      root: sourceArtifacts,
      ownerId: artifactOwnerId,
    }).put('{"fixture":true}\n', {
      artifactId,
      projectId: submitted.view.projectId,
      taskId: task.taskId,
      executionId: submitted.scheduling.execution.executionId,
      gitRevision: revision,
      kind: 'FIXTURE_RESULT',
      mediaType: 'application/json',
    });
    await source.query(
      `INSERT INTO verification_artifacts
        (artifact_id, project_id, task_id, execution_id, author_agent_id, author_lineage_id,
         kind, media_type, size, content_hash, storage_key, git_revision, created_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'FIXTURE_RESULT', 'application/json', $7, $8, $9,
         $10, '2026-09-01T08:00:30.000Z', '{}'::jsonb)`,
      [
        artifactId,
        submitted.view.projectId,
        task.taskId,
        submitted.scheduling.execution.executionId,
        submitted.organization.specialist.agentId,
        submitted.organization.specialist.lineageId,
        stored.size,
        stored.contentHash,
        stored.storageKey,
        revision,
      ],
    );
    return { submitted, stored };
  }

  it('runs clean migration and upgrades the immediately previous fixture schema immutably', async () => {
    const clean = await createTargetPool('moonshift_backup_clean');
    await expect(
      clean.query('SELECT version FROM moonshift_schema_migrations ORDER BY version'),
    ).resolves.toMatchObject({ rows: [{ version: 1 }, { version: 2 }, { version: 3 }] });
    await expect(runMigrations(clean)).resolves.toEqual({ applied: [], currentVersion: 3 });
    await clean.end();

    const previous = await createTargetPool('moonshift_backup_previous');
    await previous.query(
      'DROP TABLE verification_evaluations, verification_evidence, verification_artifacts, verification_rules, verification_policies',
    );
    await previous.query('DELETE FROM moonshift_schema_migrations WHERE version = 3');
    const migration = FOUNDATION_MIGRATIONS[2]!;
    await expect(runMigrations(previous)).resolves.toEqual({ applied: [3], currentVersion: 3 });
    await expect(
      previous.query(
        'SELECT version, name, checksum FROM moonshift_schema_migrations ORDER BY version',
      ),
    ).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { version: 3, name: migration.name, checksum: migration.checksum },
      ]),
    });
    await previous.query(
      "UPDATE moonshift_schema_migrations SET checksum = repeat('0', 64) WHERE version = 1",
    );
    await expect(runMigrations(previous)).rejects.toThrow('does not match the immutable manifest');
    await previous.end();
  });

  it('backs up PostgreSQL, artifacts, opaque references and contracts, then restores and rebuilds delivery', async () => {
    const { submitted, stored } = await seedProjectAndArtifact();
    const backupDirectory = join(workspaceDirectory, 'backup-consistent');
    const targetArtifacts = join(workspaceDirectory, 'restored-artifacts');
    const created = await createFixtureBackup({
      pool: source,
      artifactRoot: sourceArtifacts,
      outputDirectory: backupDirectory,
      configurationReferences,
      contractHashes,
      now: () => new Date('2026-09-01T08:01:00.000Z'),
    });
    expect(created.manifest.migrationVersion).toBe(3);
    expect(created.manifest.artifacts).toContainEqual(
      expect.objectContaining({
        path: `artifacts/${stored.storageKey}`,
        sha256: stored.contentHash,
        size: stored.size,
      }),
    );
    expect(created.metrics.backupBytes).toBeGreaterThan(created.metrics.databaseBytes);
    await expect(
      validateFixtureBackup({
        backupDirectory,
        expectedConfigurationReferences: configurationReferences,
        expectedContractHashes: contractHashes,
      }),
    ).resolves.toMatchObject({ manifest: created.manifest });

    const target = await createTargetPool();
    await target.query(
      `INSERT INTO projection_checkpoints (projection_name, project_id, last_sequence)
       VALUES ('project-events', $1, 0)`,
      [submitted.view.projectId],
    );
    await expect(
      restoreFixtureBackup({
        pool: target,
        backupDirectory,
        artifactRoot: targetArtifacts,
        schedulerStopped: true,
        expectedConfigurationReferences: configurationReferences,
        expectedContractHashes: contractHashes,
        validateRestoredState: async () => undefined,
      }),
    ).rejects.toThrow('Restore target table projection_checkpoints is not empty');
    await target.query('DELETE FROM projection_checkpoints');
    const restored = await restoreFixtureBackup({
      pool: target,
      backupDirectory,
      artifactRoot: targetArtifacts,
      schedulerStopped: true,
      expectedConfigurationReferences: configurationReferences,
      expectedContractHashes: contractHashes,
      monotonicNow: (() => {
        let value = 1_000;
        return () => (value += 25);
      })(),
      validateRestoredState: async () => {
        const report = await recoverPostgresDeliveryState(target);
        expect(report.projectionReplayBlockedProjectIds).toEqual([]);
        expect(report.projectionCheckpointsAdvanced).toBeGreaterThan(0);
        const restoredProject = await new PostgresProjectRepository(target).get(
          submitted.view.projectId,
        );
        expect(restoredProject?.view).toEqual(submitted.view);
        expect(restoredProject?.organization).toEqual(submitted.organization);
      },
    });
    expect(restored.schedulingMayResume).toBe(true);
    expect(restored.metrics.restoredBytes).toBeGreaterThan(0);
    expect(restored.metrics.temporaryDiskBytesHighWater).toBeGreaterThan(0);
    expect(restored.metrics.schedulingDowntimeMs).toBe(25);
    await expect(
      new FsArtifactStore({ root: targetArtifacts, ownerId: artifactOwnerId }).get(
        stored.contentHash,
        {
          artifactId: stored.artifactId,
          projectId: stored.projectId,
          taskId: stored.taskId,
          executionId: stored.executionId,
          gitRevision: stored.gitRevision,
          kind: stored.kind,
          mediaType: stored.mediaType,
        },
      ),
    ).resolves.toEqual(Buffer.from('{"fixture":true}\n'));
    await target.end();
  });

  it('validates tampering and scheduler state before any target database write', async () => {
    const { stored } = await seedProjectAndArtifact();
    const backupDirectory = join(workspaceDirectory, 'backup-tampered');
    await createFixtureBackup({
      pool: source,
      artifactRoot: sourceArtifacts,
      outputDirectory: backupDirectory,
      configurationReferences,
      contractHashes,
    });
    await writeFile(join(backupDirectory, 'artifacts', stored.storageKey), 'tampered\n', {
      mode: 0o600,
    });
    const target = await createTargetPool();
    const before = await target.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM aggregates',
    );
    await expect(
      restoreFixtureBackup({
        pool: target,
        backupDirectory,
        artifactRoot: join(workspaceDirectory, 'tampered-target'),
        schedulerStopped: true,
        expectedConfigurationReferences: configurationReferences,
        expectedContractHashes: contractHashes,
        validateRestoredState: async () => undefined,
      }),
    ).rejects.toThrow('Artifact backup failed integrity validation');
    await expect(
      restoreFixtureBackup({
        pool: target,
        backupDirectory,
        artifactRoot: join(workspaceDirectory, 'scheduler-running-target'),
        schedulerStopped: false,
        expectedConfigurationReferences: configurationReferences,
        expectedContractHashes: contractHashes,
        validateRestoredState: async () => undefined,
      }),
    ).rejects.toThrow('Restore requires a stopped scheduler');
    await expect(target.query('SELECT count(*)::text AS count FROM aggregates')).resolves.toEqual(
      before,
    );
    await target.end();
  });
});
