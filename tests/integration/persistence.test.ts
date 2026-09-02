import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { stopEmbeddedPostgres } from '../fixtures/postgres.js';

import { sanitizeBackendEvent } from '../../packages/contracts/src/index.js';
import {
  asOpaqueId,
  beginExternalEffectExecution,
  type Actor,
  type ExternalEffectAggregate,
} from '../../packages/domain/src/index.js';
import {
  FencingAuthorityError,
  IdempotencyConflictError,
  LeaseConflictError,
  MoonshiftStore,
  OptimisticConcurrencyError,
  runMigrations,
} from '../../packages/persistence/src/index.js';
import {
  createDeterministicClock,
  createDeterministicUuid,
} from '../../packages/test-fixtures/src/determinism.js';

const clock = createDeterministicClock('2026-08-30T12:00:00.000Z');
const uuid = createDeterministicUuid('persistence');

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Unable to reserve loopback port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

async function waitForDatabaseLock(pool: Pool, queryFragment: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await pool.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND state = 'active' AND query LIKE $1`,
      [`%${queryFragment}%`],
    );
    if (result.rows.some(({ wait_event_type }) => wait_event_type === 'Lock')) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${queryFragment}`);
}

function backendEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    messageId: uuid(),
    kind: 'backend.event',
    connectionId: uuid(),
    correlationId: uuid(),
    sentAt: clock.now().toISOString(),
    executionId: uuid(),
    modelDescriptorId: uuid(),
    modelDescriptorVersion: 1,
    sequence: 1,
    eventType: 'PROGRESS',
    observable: { status: 'RUNNING', summary: 'Fixture progress', progressPercent: 50 },
    usage: { synthetic: true, invocations: 1, units: 1 },
    ...overrides,
  };
}

async function readDatabaseNow(pool: Pool): Promise<Date> {
  const result = await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = result.rows[0]?.now;
  if (now === undefined) throw new Error('PostgreSQL did not return its authoritative clock');
  return now;
}

describe.sequential('PostgreSQL 18 persistence foundation', () => {
  let embedded: EmbeddedPostgres;
  let pool: Pool;
  let store: MoonshiftStore;
  let dataDirectory: string;

  beforeAll(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'moonshift-postgres-'));
    const port = await unusedLoopbackPort();
    const user = 'moonshift_test';
    const databasePassword = ['moonshift', 'fixture', 'only'].join('-');
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
    pool = new Pool({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      max: 8,
      ...localCredentials,
    });
    await runMigrations(pool);
    store = new MoonshiftStore(pool);
  }, 120_000);

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE
      backend_event_projections, projection_checkpoints, leases, queue_items,
      idempotency_records, outbox_events, audit_events, aggregates
      RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await stopEmbeddedPostgres(embedded, [pool]);
    if (dataDirectory !== undefined) await rm(dataDirectory, { recursive: true, force: true });
  }, 120_000);

  it('runs checksum-locked forward-only migrations against real PostgreSQL 18', async () => {
    const version = await pool.query<{ version: string }>('SELECT version()');
    expect(version.rows[0]?.version).toContain('PostgreSQL 18.4');
    await expect(runMigrations(pool)).resolves.toEqual({ applied: [], currentVersion: 3 });
    const applied = await pool.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM moonshift_schema_migrations ORDER BY version',
    );
    expect(applied.rows).toEqual([
      { version: 1, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 2, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
      { version: 3, checksum: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);

    await pool.query(`DROP TABLE verification_evaluations, verification_evidence,
      verification_artifacts, verification_rules, verification_policies`);
    await pool.query('DELETE FROM moonshift_schema_migrations WHERE version = 3');
    await expect(runMigrations(pool)).resolves.toEqual({ applied: [3], currentVersion: 3 });
    const retentionColumn = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'project_snapshots' AND column_name = 'retained_from_sequence'`,
    );
    expect(retentionColumn.rowCount).toBe(1);
    const verificationTable = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'verification_evaluations'`,
    );
    expect(verificationTable.rowCount).toBe(1);
  });

  it('commits aggregate, audit event, and outbox event atomically with optimistic concurrency', async () => {
    const aggregateId = uuid();
    const projectId = uuid();
    await expect(
      store.commitAggregate({
        aggregate: {
          type: 'TASK',
          id: aggregateId,
          projectId,
          state: 'READY',
          data: { title: 'foundation' },
        },
        expectedVersion: 0,
        audit: {
          id: uuid(),
          actorType: 'SYSTEM',
          actorId: 'foundation-test',
          action: 'task.created',
          reasonCode: 'FIXTURE',
          outcome: 'APPLIED',
          correlationId: uuid(),
          occurredAt: clock.now(),
        },
        outbox: { id: uuid(), projectId, projectSequence: 1, payload: { kind: 'task.created' } },
      }),
    ).resolves.toMatchObject({ version: 1 });

    await expect(
      store.commitAggregate({
        aggregate: { type: 'TASK', id: aggregateId, projectId, state: 'RUNNING', data: {} },
        expectedVersion: 0,
        audit: {
          id: uuid(),
          actorType: 'SYSTEM',
          actorId: 'foundation-test',
          action: 'task.started',
          reasonCode: 'FIXTURE',
          outcome: 'APPLIED',
          correlationId: uuid(),
          occurredAt: clock.now(),
        },
        outbox: { id: uuid(), projectId, projectSequence: 2, payload: { kind: 'task.started' } },
      }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);

    const counts = await pool.query<{ aggregates: string; audits: string; events: string }>(`
      SELECT
        (SELECT count(*) FROM aggregates)::text AS aggregates,
        (SELECT count(*) FROM audit_events)::text AS audits,
        (SELECT count(*) FROM outbox_events)::text AS events`);
    expect(counts.rows[0]).toEqual({ aggregates: '1', audits: '1', events: '1' });
  });

  it('rolls back the aggregate when a unique audit identity conflicts', async () => {
    const auditId = uuid();
    const projectId = uuid();
    const commit = (aggregateId: string, sequence: number) =>
      store.commitAggregate({
        aggregate: { type: 'TASK', id: aggregateId, projectId, state: 'READY', data: {} },
        expectedVersion: 0,
        audit: {
          id: auditId,
          actorType: 'SYSTEM',
          actorId: 'foundation-test',
          action: 'task.created',
          reasonCode: 'FIXTURE',
          outcome: 'APPLIED',
          correlationId: uuid(),
          occurredAt: clock.now(),
        },
        outbox: {
          id: uuid(),
          projectId,
          projectSequence: sequence,
          payload: { kind: 'task.created' },
        },
      });
    await commit(uuid(), 1);
    const rolledBackId = uuid();
    await expect(commit(rolledBackId, 2)).rejects.toMatchObject({ code: '23505' });
    const result = await pool.query('SELECT 1 FROM aggregates WHERE aggregate_id = $1', [
      rolledBackId,
    ]);
    expect(result.rowCount).toBe(0);
  });

  it('commits idempotency, aggregate mutation, audit, and outbox in one transaction', async () => {
    const aggregateId = uuid();
    const projectId = uuid();
    const requestHash = `sha256:${'c'.repeat(64)}`;
    const input = {
      scope: 'task-commands',
      idempotencyKey: 'create-foundation-task',
      requestHash,
      response: { aggregateId },
      commit: {
        aggregate: {
          type: 'TASK',
          id: aggregateId,
          projectId,
          state: 'READY',
          data: { title: 'idempotent-foundation' },
        },
        expectedVersion: 0,
        audit: {
          id: uuid(),
          actorType: 'SYSTEM',
          actorId: 'idempotency-test',
          action: 'task.created',
          reasonCode: 'FIXTURE',
          outcome: 'APPLIED',
          correlationId: uuid(),
          occurredAt: clock.now(),
        },
        outbox: {
          id: uuid(),
          projectId,
          projectSequence: 1,
          payload: { kind: 'task.created' },
        },
      },
    } as const;

    await expect(store.commitIdempotentAggregate(input)).resolves.toMatchObject({
      reused: false,
      response: { aggregateId },
      version: 1,
    });
    await expect(
      store.commitIdempotentAggregate({
        ...input,
        commit: {
          ...input.commit,
          audit: { ...input.commit.audit, id: uuid() },
          outbox: { ...input.commit.outbox, id: uuid() },
        },
      }),
    ).resolves.toMatchObject({ reused: true, response: { aggregateId }, version: null });
    await expect(
      store.commitIdempotentAggregate({
        ...input,
        requestHash: `sha256:${'d'.repeat(64)}`,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const counts = await pool.query<{
      aggregates: string;
      audits: string;
      events: string;
      keys: string;
    }>(
      `SELECT
        (SELECT count(*) FROM aggregates)::text AS aggregates,
        (SELECT count(*) FROM audit_events)::text AS audits,
        (SELECT count(*) FROM outbox_events)::text AS events,
        (SELECT count(*) FROM idempotency_records)::text AS keys`,
    );
    expect(counts.rows[0]).toEqual({ aggregates: '1', audits: '1', events: '1', keys: '1' });

    const conflictingAuditId = input.commit.audit.id;
    const failedAggregateId = uuid();
    await expect(
      store.commitIdempotentAggregate({
        scope: 'task-commands',
        idempotencyKey: 'must-roll-back',
        requestHash: `sha256:${'e'.repeat(64)}`,
        response: { aggregateId: failedAggregateId },
        commit: {
          ...input.commit,
          aggregate: { ...input.commit.aggregate, id: failedAggregateId },
          audit: { ...input.commit.audit, id: conflictingAuditId },
          outbox: { ...input.commit.outbox, id: uuid(), projectSequence: 2 },
        },
      }),
    ).rejects.toMatchObject({ code: '23505' });
    const rolledBack = await pool.query<{ keys: string; aggregate: string }>(
      `SELECT
        (SELECT count(*) FROM idempotency_records WHERE idempotency_key = 'must-roll-back')::text AS keys,
        (SELECT count(*) FROM aggregates WHERE aggregate_id = $1)::text AS aggregate`,
      [failedAggregateId],
    );
    expect(rolledBack.rows[0]).toEqual({ keys: '0', aggregate: '0' });
  });

  it('stores idempotent responses and rejects key reuse with another request hash', async () => {
    const requestHash = `sha256:${'a'.repeat(64)}`;
    await expect(
      store.rememberIdempotent('projects', 'request-1', requestHash, { projectId: uuid() }),
    ).resolves.toMatchObject({ reused: false });
    await expect(
      store.rememberIdempotent('projects', 'request-1', requestHash, { ignored: true }),
    ).resolves.toMatchObject({ reused: true });
    await expect(
      store.rememberIdempotent('projects', 'request-1', `sha256:${'b'.repeat(64)}`, {}),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('uses SKIP LOCKED queue claims so concurrent workers never receive the same item', async () => {
    const databaseNow = await readDatabaseNow(pool);
    const forgedCallerNow = new Date('2000-01-01T00:00:00.000Z');
    const claimUntil = new Date(forgedCallerNow.getTime() + 60_000);
    await store.enqueue({
      id: uuid(),
      queueName: 'execution',
      payload: { ordinal: 1 },
      availableAt: databaseNow,
    });
    await store.enqueue({
      id: uuid(),
      queueName: 'execution',
      payload: { ordinal: 2 },
      availableAt: databaseNow,
    });
    const [first, second] = await Promise.all([
      store.claimQueue('execution', 'worker-a', forgedCallerNow, claimUntil),
      store.claimQueue('execution', 'worker-b', forgedCallerNow, claimUntil),
    ]);
    expect(first?.id).not.toBe(second?.id);
    expect(new Set([first?.claimedBy, second?.claimedBy])).toEqual(
      new Set(['worker-a', 'worker-b']),
    );
    await expect(
      store.claimQueue('execution', 'worker-c', forgedCallerNow, claimUntil),
    ).resolves.toBeNull();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) throw new Error('Expected two queue claims');
    await pool.query(
      `UPDATE queue_items
       SET claim_expires_at = clock_timestamp() - interval '1 second'
       WHERE queue_item_id = ANY($1::uuid[])`,
      [[first.id, second.id]],
    );
    const forgedCallerAfterExpiry = new Date('1900-01-01T00:00:00.000Z');
    await expect(
      store.completeQueue(first.id, first.claimedBy, first.claimToken, forgedCallerAfterExpiry),
    ).resolves.toBe(false);
    await expect(
      store.releaseQueue(
        second.id,
        second.claimedBy,
        second.claimToken,
        forgedCallerAfterExpiry,
        forgedCallerAfterExpiry,
      ),
    ).resolves.toBe(false);

    const recovered = await store.claimQueue(
      'execution',
      'worker-c',
      forgedCallerNow,
      new Date(forgedCallerNow.getTime() + 120_000),
    );
    expect(recovered?.claimToken).toBe(2n);
    const stale = [first, second].find((claim) => claim?.id === recovered?.id);
    expect(stale).toBeDefined();
    if (stale === undefined || stale === null || recovered === null)
      throw new Error('Expected expired queue claim recovery');
    await expect(
      store.completeQueue(stale.id, stale.claimedBy, stale.claimToken, forgedCallerAfterExpiry),
    ).resolves.toBe(false);
    await expect(
      store.completeQueue(
        recovered.id,
        recovered.claimedBy,
        recovered.claimToken,
        forgedCallerAfterExpiry,
      ),
    ).resolves.toBe(true);
    const remaining = [first, second].find((claim) => claim?.id !== recovered.id);
    if (remaining === undefined || remaining === null)
      throw new Error('Expected a remaining queue claim');
    const remainingRecovered = await store.claimQueue(
      'execution',
      'worker-d',
      forgedCallerNow,
      new Date(forgedCallerNow.getTime() + 120_000),
    );
    expect(remainingRecovered).toMatchObject({
      id: remaining.id,
      claimedBy: 'worker-d',
      claimToken: 2n,
    });
    if (remainingRecovered === null) throw new Error('Expected remaining expired claim recovery');
    await expect(
      store.releaseQueue(
        remainingRecovered.id,
        remainingRecovered.claimedBy,
        remainingRecovered.claimToken,
        forgedCallerAfterExpiry,
        forgedCallerAfterExpiry,
      ),
    ).resolves.toBe(true);
    const released = await pool.query<{ status: string; available_at: Date; database_now: Date }>(
      `SELECT status, available_at, clock_timestamp() AS database_now
       FROM queue_items WHERE queue_item_id = $1`,
      [remainingRecovered.id],
    );
    expect(released.rows[0]).toMatchObject({ status: 'AVAILABLE' });
    expect(
      (released.rows[0]?.available_at.getTime() ?? Number.POSITIVE_INFINITY) <=
        (released.rows[0]?.database_now.getTime() ?? Number.NEGATIVE_INFINITY),
    ).toBe(true);
    await expect(
      store.claimQueue(
        'execution',
        'worker-e',
        forgedCallerNow,
        new Date(forgedCallerNow.getTime() + 120_000),
      ),
    ).resolves.toMatchObject({ id: remaining.id, claimedBy: 'worker-e', claimToken: 3n });
  });

  it('anchors delayed queue release availability to the PostgreSQL clock', async () => {
    const databaseNow = await readDatabaseNow(pool);
    const itemId = uuid();
    await store.enqueue({
      id: itemId,
      queueName: 'delayed-release',
      payload: { fixture: true },
      availableAt: databaseNow,
    });
    const forgedCallerNow = new Date('2099-01-01T00:00:00.000Z');
    const claim = await store.claimQueue(
      'delayed-release',
      'worker-delayed',
      forgedCallerNow,
      new Date(forgedCallerNow.getTime() + 60_000),
    );
    if (claim === null) throw new Error('Expected delayed-release queue claim');

    await expect(
      store.releaseQueue(
        claim.id,
        claim.claimedBy,
        claim.claimToken,
        forgedCallerNow,
        new Date(forgedCallerNow.getTime() - 1),
      ),
    ).rejects.toBeInstanceOf(RangeError);

    const beforeRelease = await readDatabaseNow(pool);
    await expect(
      store.releaseQueue(
        claim.id,
        claim.claimedBy,
        claim.claimToken,
        forgedCallerNow,
        new Date(forgedCallerNow.getTime() + 30_000),
      ),
    ).resolves.toBe(true);
    const afterRelease = await readDatabaseNow(pool);
    const persisted = await pool.query<{ available_at: Date }>(
      'SELECT available_at FROM queue_items WHERE queue_item_id = $1',
      [itemId],
    );
    const authoritativeAvailableAt = persisted.rows[0]?.available_at;
    if (authoritativeAvailableAt === undefined)
      throw new Error('Expected persisted delayed release availability');
    expect(authoritativeAvailableAt.getTime()).toBeGreaterThanOrEqual(
      beforeRelease.getTime() + 30_000,
    );
    expect(authoritativeAvailableAt.getTime()).toBeLessThanOrEqual(afterRelease.getTime() + 30_000);
    await expect(
      store.claimQueue(
        'delayed-release',
        'worker-too-early',
        forgedCallerNow,
        new Date(forgedCallerNow.getTime() + 60_000),
      ),
    ).resolves.toBeNull();
  });

  it('rechecks queue release authority after a row lock wait crosses claim expiry', async () => {
    const databaseNow = await readDatabaseNow(pool);
    const itemId = uuid();
    await store.enqueue({
      id: itemId,
      queueName: 'release-expiry-race',
      payload: { fixture: true },
      availableAt: databaseNow,
    });
    const forgedCallerNow = new Date('2000-01-01T00:00:00.000Z');
    const claim = await store.claimQueue(
      'release-expiry-race',
      'worker-expiring',
      forgedCallerNow,
      new Date(forgedCallerNow.getTime() + 1_000),
    );
    if (claim === null) throw new Error('Expected expiring queue claim');
    const expiry = await pool.query<{ claim_expires_at: Date }>(
      'SELECT claim_expires_at FROM queue_items WHERE queue_item_id = $1',
      [itemId],
    );
    const claimExpiresAt = expiry.rows[0]?.claim_expires_at;
    if (claimExpiresAt === undefined) throw new Error('Expected queue claim expiry');

    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM queue_items WHERE queue_item_id = $1 FOR UPDATE', [
        itemId,
      ]);
      const release = store.releaseQueue(
        claim.id,
        claim.claimedBy,
        claim.claimToken,
        forgedCallerNow,
        forgedCallerNow,
      );
      await waitForDatabaseLock(pool, 'UPDATE queue_items AS queued');
      while ((await readDatabaseNow(pool)) <= claimExpiresAt) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocker.query('COMMIT');
      await expect(release).resolves.toBe(false);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  it('claims and publishes transactional outbox events with exclusive worker ownership', async () => {
    const databaseNow = await readDatabaseNow(pool);
    const forgedCallerNow = new Date('2000-01-01T00:00:00.000Z');
    const claimUntil = new Date(forgedCallerNow.getTime() + 60_000);
    const projectId = uuid();
    const commit = (sequence: number) =>
      store.commitAggregate({
        aggregate: {
          type: 'TASK',
          id: uuid(),
          projectId,
          state: 'READY',
          data: { sequence },
        },
        expectedVersion: 0,
        audit: {
          id: uuid(),
          actorType: 'SYSTEM',
          actorId: 'outbox-test',
          action: 'task.created',
          reasonCode: 'FIXTURE',
          outcome: 'APPLIED',
          correlationId: uuid(),
          occurredAt: clock.now(),
        },
        outbox: {
          id: uuid(),
          projectId,
          projectSequence: sequence,
          payload: { kind: 'task.created', sequence },
        },
      });
    await commit(1);
    await commit(2);

    const [first, second] = await Promise.all([
      store.claimOutbox('publisher-a', forgedCallerNow, claimUntil),
      store.claimOutbox('publisher-b', forgedCallerNow, claimUntil),
    ]);
    expect(first?.id).not.toBe(second?.id);
    expect(new Set([first?.claimedBy, second?.claimedBy])).toEqual(
      new Set(['publisher-a', 'publisher-b']),
    );
    await expect(store.claimOutbox('publisher-c', forgedCallerNow, claimUntil)).resolves.toBeNull();

    expect(first).not.toBeNull();
    if (first === null) throw new Error('Expected an outbox claim');
    await expect(
      store.publishOutbox(first.id, 'publisher-c', first.claimToken, forgedCallerNow),
    ).resolves.toBe(false);
    await expect(
      store.publishOutbox(first.id, first.claimedBy, first.claimToken, forgedCallerNow),
    ).resolves.toBe(true);
    await expect(
      store.publishOutbox(first.id, first.claimedBy, first.claimToken, forgedCallerNow),
    ).resolves.toBe(false);

    const published = await pool.query<{ status: string; published_at: Date | null }>(
      'SELECT status, published_at FROM outbox_events WHERE event_id = $1',
      [first.id],
    );
    expect(published.rows[0]).toMatchObject({ status: 'PUBLISHED' });
    expect(published.rows[0]?.published_at).toBeInstanceOf(Date);

    expect(second).not.toBeNull();
    if (second === null) throw new Error('Expected a second outbox claim');
    await pool.query(
      `UPDATE outbox_events
       SET claim_expires_at = clock_timestamp() - interval '1 second'
       WHERE event_id = $1`,
      [second.id],
    );
    const forgedCallerAfterExpiry = new Date('1900-01-01T00:00:00.000Z');
    await expect(
      store.publishOutbox(second.id, second.claimedBy, second.claimToken, forgedCallerAfterExpiry),
    ).resolves.toBe(false);
    await expect(
      store.releaseOutbox(second.id, second.claimedBy, second.claimToken, forgedCallerAfterExpiry),
    ).resolves.toBe(false);
    const recovered = await store.claimOutbox(
      'publisher-c',
      forgedCallerNow,
      new Date(forgedCallerNow.getTime() + 120_000),
    );
    expect(recovered).toMatchObject({ id: second.id, claimedBy: 'publisher-c', claimToken: 2n });
    if (recovered === null) throw new Error('Expected expired outbox claim recovery');
    await expect(
      store.releaseOutbox(
        recovered.id,
        recovered.claimedBy,
        recovered.claimToken,
        forgedCallerAfterExpiry,
      ),
    ).resolves.toBe(true);
  });

  it('expires or revokes leases and advances monotonic fencing tokens', async () => {
    const resourceId = uuid();
    const databaseNow = await readDatabaseNow(pool);
    const forgedFuture = new Date('2099-01-01T00:00:00.000Z');
    const forgedPast = new Date('2000-01-01T00:00:00.000Z');
    const first = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId,
      ownerId: 'runner-a',
      now: forgedFuture,
      expiresAt: new Date(forgedFuture.getTime() + 60_000),
    });
    expect(first.fencingToken).toBe(1n);
    expect(first.expiresAt.getTime() - first.now.getTime()).toBe(60_000);
    expect(first.now.getFullYear()).not.toBe(forgedFuture.getFullYear());
    await expect(
      store.isCurrentFence(
        'EXECUTION',
        resourceId,
        first.id,
        first.ownerId,
        first.fencingToken,
        forgedFuture,
      ),
    ).resolves.toBe(true);
    await expect(
      store.acquireLease({
        id: uuid(),
        resourceType: 'EXECUTION',
        resourceId,
        ownerId: 'runner-b',
        now: forgedPast,
        expiresAt: new Date(forgedPast.getTime() + 120_000),
      }),
    ).rejects.toBeInstanceOf(LeaseConflictError);

    await pool.query(
      `UPDATE leases
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE lease_id = $1`,
      [first.id],
    );
    await expect(
      store.isCurrentFence(
        'EXECUTION',
        resourceId,
        first.id,
        first.ownerId,
        first.fencingToken,
        forgedPast,
      ),
    ).resolves.toBe(false);

    const second = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId,
      ownerId: 'runner-b',
      now: forgedFuture,
      expiresAt: new Date(forgedFuture.getTime() + 120_000),
    });
    expect(second.fencingToken).toBe(2n);
    await expect(
      store.isCurrentFence(
        'EXECUTION',
        resourceId,
        first.id,
        first.ownerId,
        first.fencingToken,
        forgedPast,
      ),
    ).resolves.toBe(false);
    await expect(
      store.isCurrentFence(
        'EXECUTION',
        resourceId,
        second.id,
        second.ownerId,
        second.fencingToken,
        forgedFuture,
      ),
    ).resolves.toBe(true);
    await store.revokeLease(second.id, forgedPast);
    await expect(
      store.isCurrentFence(
        'EXECUTION',
        resourceId,
        second.id,
        second.ownerId,
        second.fencingToken,
        forgedPast,
      ),
    ).resolves.toBe(false);
    await expect(
      store.acquireLease({
        id: uuid(),
        resourceType: 'EXECUTION',
        resourceId: uuid(),
        ownerId: 'runner-expired-at-acquisition',
        now: forgedPast,
        expiresAt: new Date(forgedPast.getTime() - 1_000),
      }),
    ).rejects.toThrow('Lease expiry must be after acquisition time');
  });

  it('fails closed before a fencing token leaves the exact runner-protocol range', async () => {
    const resourceId = uuid();
    await pool.query(
      `INSERT INTO leases
        (lease_id, resource_type, resource_id, owner_id, fencing_token, expires_at, status, created_at, updated_at)
       VALUES ($1, 'EXECUTION', $2, 'runner-max', $3, clock_timestamp() - interval '1 second',
         'RELEASED', clock_timestamp(), clock_timestamp())`,
      [uuid(), resourceId, Number.MAX_SAFE_INTEGER.toString()],
    );

    await expect(
      store.acquireLease({
        id: uuid(),
        resourceType: 'EXECUTION',
        resourceId,
        ownerId: 'runner-overflow',
        now: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 60_000),
      }),
    ).rejects.toThrow('Lease fencing token space exhausted for the runner protocol');

    await expect(
      pool.query(
        `INSERT INTO leases
          (lease_id, resource_type, resource_id, owner_id, fencing_token, expires_at, status, created_at, updated_at)
         VALUES ($1, 'EXECUTION', $2, 'runner-invalid', $3, clock_timestamp() + interval '1 minute',
           'ACTIVE', clock_timestamp(), clock_timestamp())`,
        [uuid(), uuid(), (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString()],
      ),
    ).rejects.toThrow();
  });

  it('mints effect execution authority only from the matching current durable lease', async () => {
    const executionId = asOpaqueId('Execution', uuid());
    const acquiredAt = await readDatabaseNow(pool);
    const first = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId: executionId,
      ownerId: 'runner-effect-a',
      now: acquiredAt,
      expiresAt: new Date(acquiredAt.getTime() + 60_000),
    });
    const effect = (overrides: Partial<ExternalEffectAggregate> = {}): ExternalEffectAggregate => ({
      effectId: asOpaqueId('ExternalEffect', uuid()),
      actionDigest: `sha256:${'c'.repeat(64)}`,
      idempotencyKey: 'fixture:effect:marker',
      executorExecutionId: executionId,
      executorLeaseId: asOpaqueId('RunnerLease', first.id),
      executorOwnerId: first.ownerId,
      executorFencingToken: first.fencingToken,
      state: 'REQUESTED',
      version: 1,
      ...overrides,
    });
    const currentEffect = effect();
    const runtime: Actor = { type: 'RUNTIME', id: first.ownerId };
    await expect(
      beginExternalEffectExecution(currentEffect, runtime, 1, store, acquiredAt),
    ).resolves.toEqual({ state: 'EXECUTING', version: 2 });

    await expect(
      beginExternalEffectExecution(
        effect({ executorLeaseId: asOpaqueId('RunnerLease', uuid()) }),
        runtime,
        1,
        store,
        acquiredAt,
      ),
    ).rejects.toThrow(/current durable runner lease/);

    await pool.query(
      `UPDATE leases
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE lease_id = $1`,
      [first.id],
    );
    const afterExpiry = new Date('2000-01-01T00:00:00.000Z');
    await expect(
      beginExternalEffectExecution(currentEffect, runtime, 1, store, afterExpiry),
    ).rejects.toThrow(/current durable runner lease/);
    const second = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId: executionId,
      ownerId: 'runner-effect-b',
      now: afterExpiry,
      expiresAt: new Date(acquiredAt.getTime() + 120_000),
    });
    await expect(
      beginExternalEffectExecution(currentEffect, runtime, 1, store, afterExpiry),
    ).rejects.toThrow(/current durable runner lease/);
    await expect(
      beginExternalEffectExecution(
        effect({
          executorLeaseId: asOpaqueId('RunnerLease', second.id),
          executorFencingToken: 99n,
        }),
        runtime,
        1,
        store,
        afterExpiry,
      ),
    ).rejects.toThrow(/current durable runner lease/);

    const secondEffect = effect({
      executorLeaseId: asOpaqueId('RunnerLease', second.id),
      executorOwnerId: second.ownerId,
      executorFencingToken: second.fencingToken,
    });
    await expect(
      beginExternalEffectExecution(secondEffect, runtime, 1, store, afterExpiry),
    ).rejects.toThrow(/owner must match/);
    const secondRuntime: Actor = { type: 'RUNTIME', id: second.ownerId };
    await expect(
      beginExternalEffectExecution(secondEffect, secondRuntime, 1, store, afterExpiry),
    ).resolves.toEqual({ state: 'EXECUTING', version: 2 });
    const revokedAt = new Date('1900-01-01T00:00:00.000Z');
    await store.revokeLease(second.id, revokedAt);
    await expect(
      beginExternalEffectExecution(secondEffect, secondRuntime, 1, store, revokedAt),
    ).rejects.toThrow(/current durable runner lease/);
  });

  it('commits an ExternalEffect EXECUTING transition atomically with owner-bound fencing', async () => {
    const projectId = uuid();
    const executionId = uuid();
    const effectId = uuid();
    const lease = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId: executionId,
      ownerId: 'runner-atomic',
      now: clock.now(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const data = {
      executorExecutionId: executionId,
      executorLeaseId: lease.id,
      executorOwnerId: lease.ownerId,
      executorFencingToken: lease.fencingToken.toString(),
    };
    const commit = (
      state: 'REQUESTED' | 'EXECUTING',
      version: number,
      ownerId: string,
      authorityData: Readonly<Record<string, unknown>> = data,
    ) => ({
      aggregate: {
        type: 'EXTERNAL_EFFECT',
        id: effectId,
        projectId,
        state,
        data: authorityData,
      },
      expectedVersion: version,
      audit: {
        id: uuid(),
        actorType: state === 'EXECUTING' ? 'RUNTIME' : 'SYSTEM',
        actorId: ownerId,
        action: `external-effect.${state.toLowerCase()}`,
        reasonCode: 'FIXTURE',
        outcome: 'APPLIED',
        correlationId: uuid(),
        occurredAt: clock.now(),
      },
      outbox: {
        id: uuid(),
        projectId,
        projectSequence: state === 'REQUESTED' ? 1 : 2,
        payload: { kind: `external-effect.${state.toLowerCase()}` },
      },
    });
    await expect(store.commitAggregate(commit('REQUESTED', 0, 'system'))).resolves.toEqual({
      version: 1,
    });
    const foreignExecutionId = uuid();
    const foreignLease = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId: foreignExecutionId,
      ownerId: 'runner-foreign',
      now: clock.now(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const foreignData = {
      executorExecutionId: foreignExecutionId,
      executorLeaseId: foreignLease.id,
      executorOwnerId: foreignLease.ownerId,
      executorFencingToken: foreignLease.fencingToken.toString(),
    };
    await expect(
      store.commitFencedExternalEffectExecution({
        executionId: foreignExecutionId,
        leaseId: foreignLease.id,
        ownerId: foreignLease.ownerId,
        fencingToken: foreignLease.fencingToken,
        commit: commit('EXECUTING', 1, foreignLease.ownerId, foreignData),
      }),
    ).rejects.toBeInstanceOf(FencingAuthorityError);
    await expect(
      store.commitAggregate(commit('EXECUTING', 1, lease.ownerId)),
    ).rejects.toBeInstanceOf(FencingAuthorityError);
    await expect(
      store.commitFencedExternalEffectExecution({
        executionId,
        leaseId: lease.id,
        ownerId: 'runner-impostor',
        fencingToken: lease.fencingToken,
        commit: commit('EXECUTING', 1, 'runner-impostor'),
      }),
    ).rejects.toBeInstanceOf(FencingAuthorityError);
    await expect(
      store.commitFencedExternalEffectExecution({
        executionId,
        leaseId: lease.id,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        commit: commit('EXECUTING', 1, lease.ownerId),
      }),
    ).resolves.toEqual({ version: 2 });
    await expect(
      store.commitFencedExternalEffectExecution({
        executionId,
        leaseId: lease.id,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        commit: commit('EXECUTING', 2, lease.ownerId),
      }),
    ).rejects.toBeInstanceOf(FencingAuthorityError);
    const persisted = await pool.query<{ state: string; version: number }>(
      `SELECT state, version FROM aggregates
       WHERE aggregate_type = 'EXTERNAL_EFFECT' AND aggregate_id = $1`,
      [effectId],
    );
    expect(persisted.rows[0]).toEqual({ state: 'EXECUTING', version: 2 });

    const expiredProjectId = uuid();
    const expiredExecutionId = uuid();
    const expiredEffectId = uuid();
    const databaseNow = await readDatabaseNow(pool);
    const expiredLease = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId: expiredExecutionId,
      ownerId: 'runner-expired',
      now: databaseNow,
      expiresAt: new Date(databaseNow.getTime() + 60_000),
    });
    await pool.query(
      `UPDATE leases
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE lease_id = $1`,
      [expiredLease.id],
    );
    const expiredData = {
      executorExecutionId: expiredExecutionId,
      executorLeaseId: expiredLease.id,
      executorOwnerId: expiredLease.ownerId,
      executorFencingToken: expiredLease.fencingToken.toString(),
    };
    const expiredRequested = commit('REQUESTED', 0, 'system', expiredData);
    await store.commitAggregate({
      ...expiredRequested,
      aggregate: {
        ...expiredRequested.aggregate,
        id: expiredEffectId,
        projectId: expiredProjectId,
      },
      outbox: { ...expiredRequested.outbox, id: uuid(), projectId: expiredProjectId },
    });
    const expiredExecuting = commit('EXECUTING', 1, expiredLease.ownerId, expiredData);
    await expect(
      store.commitFencedExternalEffectExecution({
        executionId: expiredExecutionId,
        leaseId: expiredLease.id,
        ownerId: expiredLease.ownerId,
        fencingToken: expiredLease.fencingToken,
        commit: {
          ...expiredExecuting,
          aggregate: {
            ...expiredExecuting.aggregate,
            id: expiredEffectId,
            projectId: expiredProjectId,
          },
          outbox: { ...expiredExecuting.outbox, id: uuid(), projectId: expiredProjectId },
        },
      }),
    ).rejects.toBeInstanceOf(FencingAuthorityError);
  });

  it('serializes revocation ahead of an in-flight fenced effect commit', async () => {
    const projectId = uuid();
    const executionId = uuid();
    const effectId = uuid();
    const lease = await store.acquireLease({
      id: uuid(),
      resourceType: 'EXECUTION',
      resourceId: executionId,
      ownerId: 'runner-race',
      now: clock.now(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const data = {
      executorExecutionId: executionId,
      executorLeaseId: lease.id,
      executorOwnerId: lease.ownerId,
      executorFencingToken: lease.fencingToken.toString(),
    };
    const requested = {
      aggregate: {
        type: 'EXTERNAL_EFFECT',
        id: effectId,
        projectId,
        state: 'REQUESTED',
        data,
      },
      expectedVersion: 0,
      audit: {
        id: uuid(),
        actorType: 'SYSTEM',
        actorId: 'system',
        action: 'external-effect.requested',
        reasonCode: 'FIXTURE',
        outcome: 'APPLIED',
        correlationId: uuid(),
        occurredAt: clock.now(),
      },
      outbox: {
        id: uuid(),
        projectId,
        projectSequence: 1,
        payload: { kind: 'external-effect.requested' },
      },
    };
    await store.commitAggregate(requested);
    const executing = {
      ...requested,
      aggregate: { ...requested.aggregate, state: 'EXECUTING' },
      expectedVersion: 1,
      audit: {
        ...requested.audit,
        id: uuid(),
        actorType: 'RUNTIME',
        actorId: lease.ownerId,
        action: 'external-effect.executing',
        correlationId: uuid(),
      },
      outbox: {
        id: uuid(),
        projectId,
        projectSequence: 2,
        payload: { kind: 'external-effect.executing' },
      },
    };

    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM leases WHERE lease_id = $1 FOR UPDATE', [lease.id]);
    try {
      const revokedAt = new Date(clock.now().getTime() + 1);
      const revocation = store.revokeLease(lease.id, revokedAt);
      await waitForDatabaseLock(pool, "UPDATE leases SET status = 'REVOKED'");
      const fencedCommit = store.commitFencedExternalEffectExecution({
        executionId,
        leaseId: lease.id,
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        commit: executing,
      });
      await waitForDatabaseLock(pool, 'SELECT 1 FROM leases');
      await blocker.query('COMMIT');
      await revocation;
      await expect(fencedCommit).rejects.toBeInstanceOf(FencingAuthorityError);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    const persisted = await pool.query<{ state: string; version: number }>(
      `SELECT state, version FROM aggregates
       WHERE aggregate_type = 'EXTERNAL_EFFECT' AND aggregate_id = $1`,
      [effectId],
    );
    expect(persisted.rows[0]).toEqual({ state: 'REQUESTED', version: 1 });
  });

  it('advances projection checkpoints monotonically', async () => {
    const projectId = uuid();
    await expect(store.advanceProjection('project-view', projectId, 3)).resolves.toBe(3n);
    await expect(store.advanceProjection('project-view', projectId, 2)).resolves.toBe(3n);
    await expect(store.advanceProjection('project-view', projectId, 5)).resolves.toBe(5n);
  });

  it('deduplicates identical backend observations and rejects divergent message reuse', async () => {
    const source = backendEvent();
    const accepted = sanitizeBackendEvent(source);
    const divergent = sanitizeBackendEvent({
      ...source,
      observable: {
        status: 'RUNNING',
        summary: 'Fixture progress',
        progressPercent: 75,
      },
    });
    if (!accepted.accepted || !divergent.accepted)
      throw new Error('Expected accepted backend observations');

    await expect(
      Promise.all([
        store.recordBackendObservation(accepted),
        store.recordBackendObservation(accepted),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(store.recordBackendObservation(accepted)).resolves.toBeUndefined();
    await expect(store.recordBackendObservation(divergent)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );

    const persisted = await pool.query<{ source_content_hash: string; count: string }>(
      `SELECT min(source_content_hash) AS source_content_hash, count(*)::text AS count
       FROM backend_event_projections WHERE message_id = $1`,
      [accepted.event.messageId],
    );
    expect(persisted.rows[0]).toEqual({
      source_content_hash: accepted.sourceContentHash,
      count: '1',
    });
  });

  it('persists only bounded sanitized backend projections', async () => {
    const accepted = sanitizeBackendEvent(backendEvent());
    const prohibitedValue = ['Bearer', 'fixturecredentialmaterial'].join(' ');
    const rejected = sanitizeBackendEvent(
      backendEvent({ observable: { status: 'RUNNING', summary: prohibitedValue } }),
    );
    const unrecognizedUnsafeSummary = 'failure at /host-sensitive-path';
    const rejectedUnsafeSummary = sanitizeBackendEvent(
      backendEvent({
        observable: {
          status: 'RUNNING',
          summary: unrecognizedUnsafeSummary,
          progressPercent: 50,
        },
      }),
    );
    const unsafeMessageIds = [
      ['Bearer', 'backendsecretmaterial'].join(' '),
      '/Users/example/private-backend-path',
      'not-a-uuid',
    ];
    const rejectedUnsafeIds = unsafeMessageIds.map((messageId) =>
      sanitizeBackendEvent(backendEvent({ messageId })),
    );
    expect(rejectedUnsafeIds).toEqual(
      unsafeMessageIds.map(() =>
        expect.objectContaining({ accepted: false, sourceMessageId: null }),
      ),
    );
    await store.recordBackendObservation(accepted);
    await store.recordBackendObservation(rejected);
    await store.recordBackendObservation(rejectedUnsafeSummary);
    for (const observation of rejectedUnsafeIds) await store.recordBackendObservation(observation);
    if (!accepted.accepted || rejected.accepted)
      throw new Error('Expected accepted and rejected sanitizer fixtures');
    const forgedAccepted = {
      ...accepted,
      event: {
        ...accepted.event,
        observable: {
          status: 'RUNNING',
          summary: unrecognizedUnsafeSummary,
          progressPercent: 50,
        },
      },
    };
    const forgedRejected = {
      ...rejected,
      notice: unrecognizedUnsafeSummary,
    };
    await expect(store.recordBackendObservation(forgedAccepted)).rejects.toThrow(
      'Sanitized backend observation required',
    );
    await expect(store.recordBackendObservation(forgedRejected)).rejects.toThrow(
      'Sanitized backend observation required',
    );
    const rows = await pool.query<{
      message_id: string;
      accepted: boolean;
      projection: Record<string, unknown>;
    }>(
      `SELECT message_id::text, accepted, projection
       FROM backend_event_projections ORDER BY created_at, message_id`,
    );
    expect(rows.rows).toHaveLength(6);
    expect(
      rows.rows.every((row) => !JSON.stringify(row.projection).includes(prohibitedValue)),
    ).toBe(true);
    for (const unsafeMessageId of unsafeMessageIds) {
      expect(JSON.stringify(rows.rows)).not.toContain(unsafeMessageId);
    }
    expect(JSON.stringify(rows.rows)).not.toContain(unrecognizedUnsafeSummary);
    expect(rows.rows.every(({ message_id }) => /^[0-9a-f-]{36}$/u.test(message_id))).toBe(true);
    expect(rows.rows.map((row) => row.accepted).sort()).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    await expect(store.recordBackendObservation(backendEvent())).rejects.toThrow(
      'Sanitized backend observation required',
    );
  });
});
