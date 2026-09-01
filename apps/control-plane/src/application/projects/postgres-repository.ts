import type { Pool, PoolClient } from 'pg';
import { persistVerificationRecords } from '@moonshift/persistence';

import {
  ControlPlaneError,
  EventCursorExpiredError,
  ProjectVersionConflictError,
} from '../../errors.js';
import type { ProjectEvent, ProjectRecord } from '../../model.js';
import { drainProjectOutbox } from '../../projections/project-outbox.js';
import type {
  CreateProjectRecordInput,
  MutateProjectRecordInput,
  ProjectCapacitySnapshot,
  ProjectRepository,
  RuntimeHeartbeatInput,
  RuntimeHeartbeatResult,
} from './repository.js';
import { synchronizeResultHistory } from './result-history.js';

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function capacitySnapshot(client: PoolClient): Promise<ProjectCapacitySnapshot> {
  const result = await client.query<{
    active_specialists: number;
    active_cognitive_runs: number;
    active_runner_jobs: number;
    authority_now: string;
  }>(`
    SELECT
      COALESCE(SUM((
        SELECT count(*) FROM jsonb_array_elements(record->'view'->'specialists') specialist
        WHERE specialist->>'status' = 'ACTIVE'
      )), 0)::integer AS active_specialists,
      count(*) FILTER (
        WHERE record#>>'{supervision,authority,executionState}'
          IN ('STARTING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CHECKPOINTING')
      )::integer AS active_cognitive_runs,
      count(*) FILTER (
        WHERE record#>>'{scheduling,runtime,status}' = 'RUNNING'
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(record->'supervision'->'effects') effect
             WHERE effect->>'state' IN ('EXECUTING', 'UNKNOWN', 'RECONCILING')
           )
      )::integer AS active_runner_jobs,
      to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS authority_now
    FROM project_snapshots`);
  const capacity = result.rows[0];
  if (capacity === undefined) throw new Error('Capacity query returned no row');
  return Object.freeze({
    activeSpecialists: capacity.active_specialists,
    activeCognitiveRuns: capacity.active_cognitive_runs,
    activeRunnerJobs: capacity.active_runner_jobs,
    authorityNow: capacity.authority_now,
  });
}

async function persistProjectEvent(client: PoolClient, event: ProjectEvent): Promise<void> {
  await client.query(
    `INSERT INTO project_events (event_id, project_id, project_sequence, envelope)
     VALUES ($1, $2, $3, $4)`,
    [event.eventId, event.projectId, event.sequence, event],
  );
  await client.query(
    `INSERT INTO outbox_events
       (event_id, project_id, project_sequence, aggregate_type, aggregate_id,
        aggregate_version, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.eventId,
      event.projectId,
      event.sequence,
      event.aggregate.type,
      event.aggregate.id,
      event.aggregate.version,
      event,
    ],
  );
}

async function syncExecutionQueue(client: PoolClient, record: ProjectRecord): Promise<void> {
  const execution = record.scheduling.execution;
  const queued = execution.state === 'QUEUED';
  await client.query(
    `INSERT INTO queue_items
       (queue_item_id, queue_name, payload, status, completed_at)
     VALUES ($1, 'execution', $2, $3, CASE WHEN $3 = 'COMPLETED' THEN clock_timestamp() END)
     ON CONFLICT (queue_item_id) DO NOTHING`,
    [
      execution.executionId,
      {
        projectId: record.view.projectId,
        executionId: execution.executionId,
        taskId: execution.taskId,
      },
      queued ? 'AVAILABLE' : 'COMPLETED',
    ],
  );
  await client.query(
    `UPDATE queue_items
     SET payload = $2,
         status = CASE WHEN $3::boolean THEN status ELSE 'COMPLETED' END,
         completed_at = CASE
           WHEN $3::boolean THEN completed_at
           ELSE COALESCE(completed_at, clock_timestamp())
         END,
         claimed_by = CASE WHEN $3::boolean THEN claimed_by ELSE NULL END,
         claimed_at = CASE WHEN $3::boolean THEN claimed_at ELSE NULL END,
         claim_expires_at = CASE WHEN $3::boolean THEN claim_expires_at ELSE NULL END
     WHERE queue_item_id = $1`,
    [
      execution.executionId,
      {
        projectId: record.view.projectId,
        executionId: execution.executionId,
        taskId: execution.taskId,
      },
      queued,
    ],
  );
}

async function syncRuntimeLease(client: PoolClient, record: ProjectRecord): Promise<void> {
  const authority = record.supervision.authority;
  const projectId = record.view.projectId;
  if (authority.runnerLeaseState !== 'ACTIVE') {
    await client.query(
      `UPDATE leases
       SET status = 'REVOKED', updated_at = clock_timestamp()
       WHERE resource_type = 'PROJECT_RUNTIME' AND resource_id = $1 AND status = 'ACTIVE'`,
      [projectId],
    );
    return;
  }
  await client.query(
    `UPDATE leases
     SET status = 'REVOKED', updated_at = clock_timestamp()
     WHERE resource_type = 'PROJECT_RUNTIME' AND resource_id = $1
       AND status = 'ACTIVE' AND lease_id <> $2`,
    [projectId, authority.runnerLeaseId],
  );
  await client.query(
    `INSERT INTO leases
       (lease_id, resource_type, resource_id, owner_id, fencing_token, expires_at, status)
     VALUES ($1, 'PROJECT_RUNTIME', $2, $3, $4, $5, $6)
     ON CONFLICT (lease_id) DO UPDATE
     SET owner_id = EXCLUDED.owner_id,
         fencing_token = $4,
         expires_at = EXCLUDED.expires_at,
         status = EXCLUDED.status,
         updated_at = clock_timestamp()`,
    [
      authority.runnerLeaseId,
      projectId,
      record.scheduling.runtime.connectionId,
      authority.fencingToken,
      authority.runnerLeaseExpiresAt,
      authority.runnerLeaseState,
    ],
  );
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly pool: Pool) {}

  async authorityNow(): Promise<string> {
    const result = await this.pool.query<{ authority_now: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS authority_now`,
    );
    const authorityNow = result.rows[0]?.authority_now;
    if (authorityNow === undefined) throw new Error('PostgreSQL authority clock unavailable');
    return authorityNow;
  }

  async create(
    input: CreateProjectRecordInput,
  ): Promise<{ reused: boolean; record: ProjectRecord }> {
    const result = await transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'project-capacity',
      ]);
      const prior = await client.query<{ request_hash: string; response: { projectId?: string } }>(
        `SELECT request_hash, response FROM idempotency_records
         WHERE scope = 'projects' AND idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing !== undefined) {
        if (existing.request_hash !== input.requestHash)
          throw new ControlPlaneError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key belongs to another request',
            409,
          );
        const projectId = existing.response.projectId;
        if (projectId === undefined) throw new Error('Invalid project idempotency response');
        const record = await client.query<{ record: ProjectRecord }>(
          'SELECT record FROM project_snapshots WHERE project_id = $1',
          [projectId],
        );
        const snapshot = record.rows[0]?.record;
        if (snapshot === undefined) throw new Error('Idempotency record has no project');
        return { reused: true, record: snapshot };
      }
      const record = synchronizeResultHistory(
        null,
        await input.build(await capacitySnapshot(client)),
      );
      const projectId = record.view.projectId;
      await client.query(
        `INSERT INTO project_snapshots (project_id, version, record)
         VALUES ($1, $2, $3)`,
        [projectId, record.view.version, record],
      );
      for (const event of record.events) {
        await persistProjectEvent(client, event);
      }
      await syncExecutionQueue(client, record);
      await syncRuntimeLease(client, record);
      await client.query(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response)
         VALUES ('projects', $1, $2, $3)`,
        [input.idempotencyKey, input.requestHash, { projectId }],
      );
      return { reused: false, record };
    });
    await drainProjectOutbox({
      pool: this.pool,
      workerId: 'control-plane-project-events',
      projectId: result.record.view.projectId,
      expectedLastSequence: result.record.view.lastSequence,
    });
    return result;
  }

  async get(projectId: string): Promise<ProjectRecord | null> {
    const result = await this.pool.query<{ record: ProjectRecord }>(
      'SELECT record FROM project_snapshots WHERE project_id = $1',
      [projectId],
    );
    return result.rows[0]?.record ?? null;
  }

  async list(): Promise<readonly ProjectRecord[]> {
    const result = await this.pool.query<{ record: ProjectRecord }>(
      'SELECT record FROM project_snapshots ORDER BY project_id',
    );
    return Object.freeze(result.rows.map(({ record }) => record));
  }

  async listEvents(projectId: string, afterSequence: number): Promise<readonly ProjectEvent[]> {
    return transaction(this.pool, async (client) => {
      const snapshot = await client.query<{ retained_from_sequence: string }>(
        `SELECT retained_from_sequence::text FROM project_snapshots
         WHERE project_id = $1
         FOR SHARE`,
        [projectId],
      );
      const retainedFrom = Number(snapshot.rows[0]?.retained_from_sequence ?? 1);
      if (afterSequence < retainedFrom - 1) throw new EventCursorExpiredError(retainedFrom);
      const result = await client.query<{ envelope: ProjectEvent }>(
        `SELECT envelope FROM project_events
         WHERE project_id = $1 AND project_sequence > $2
         ORDER BY project_sequence`,
        [projectId, afterSequence],
      );
      return result.rows.map(({ envelope }) => envelope);
    });
  }

  async expireEventsBefore(projectId: string, sequence: number): Promise<void> {
    await transaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE project_snapshots
         SET retained_from_sequence = LEAST(
               GREATEST(retained_from_sequence, $2),
               (SELECT COALESCE(MAX(project_sequence), 0) + 1
                FROM project_events
                WHERE project_id = $1)
             ),
             updated_at = clock_timestamp()
         WHERE project_id = $1`,
        [projectId, sequence],
      );
      if (updated.rowCount !== 1) throw new Error('Project not found');
      await client.query(
        'DELETE FROM project_events WHERE project_id = $1 AND project_sequence < $2',
        [projectId, sequence],
      );
    });
  }

  async assertVersion(projectId: string, expectedVersion: number): Promise<void> {
    const result = await this.pool.query<{ version: number }>(
      'SELECT version FROM project_snapshots WHERE project_id = $1',
      [projectId],
    );
    const current = result.rows[0]?.version;
    if (current === undefined)
      throw new ControlPlaneError('PROJECT_NOT_FOUND', 'Project not found', 404);
    if (current !== expectedVersion)
      throw new ProjectVersionConflictError(expectedVersion, current);
  }

  async recordRuntimeHeartbeat(input: RuntimeHeartbeatInput): Promise<RuntimeHeartbeatResult> {
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `project:${input.projectId}`,
      ]);
      const nowResult = await client.query<{ authority_now: Date }>(
        'SELECT clock_timestamp() AS authority_now',
      );
      const now = nowResult.rows[0]?.authority_now;
      if (now === undefined) throw new Error('PostgreSQL authority clock unavailable');
      const authorityNow = now.toISOString();
      const snapshot = await client.query<{ record: ProjectRecord }>(
        `SELECT record FROM project_snapshots WHERE project_id = $1 FOR UPDATE`,
        [input.projectId],
      );
      const record = snapshot.rows[0]?.record;
      if (record === undefined)
        return Object.freeze({ accepted: false, authorityNow, leaseExpiresAt: null });
      const authority = record.supervision.authority;
      const lease = await client.query(
        `SELECT 1 FROM leases
         WHERE resource_type = 'PROJECT_RUNTIME'
           AND resource_id = $1
           AND lease_id = $2
           AND owner_id = $3
           AND fencing_token = $4
           AND status = 'ACTIVE'
           AND expires_at > $5
         FOR UPDATE`,
        [input.projectId, input.leaseId, input.ownerId, input.fencingToken, now],
      );
      const accepted =
        record.view.status === 'ACTIVE' &&
        authority.executionId === input.executionId &&
        authority.runnerLeaseId === input.leaseId &&
        authority.runnerLeaseState === 'ACTIVE' &&
        authority.fencingToken === input.fencingToken &&
        record.scheduling.runtime.connectionId === input.ownerId &&
        (lease.rowCount ?? 0) === 1;
      if (!accepted) return Object.freeze({ accepted: false, authorityNow, leaseExpiresAt: null });

      const leaseExpiresAt = new Date(now.getTime() + 300_000).toISOString();
      const nextRecord = Object.freeze({
        ...record,
        supervision: Object.freeze({
          ...record.supervision,
          authority: Object.freeze({
            ...authority,
            runnerLastHeartbeatAt: authorityNow,
            runnerLeaseExpiresAt: leaseExpiresAt,
          }),
        }),
      });
      const renewed = await client.query(
        `UPDATE leases
         SET expires_at = $5, updated_at = $6
         WHERE resource_type = 'PROJECT_RUNTIME'
           AND resource_id = $1
           AND lease_id = $2
           AND owner_id = $3
           AND fencing_token = $4
           AND status = 'ACTIVE'
           AND expires_at > $6`,
        [input.projectId, input.leaseId, input.ownerId, input.fencingToken, leaseExpiresAt, now],
      );
      if ((renewed.rowCount ?? 0) !== 1)
        return Object.freeze({ accepted: false, authorityNow, leaseExpiresAt: null });
      await client.query(
        `UPDATE project_snapshots
         SET record = $2, updated_at = $3
         WHERE project_id = $1`,
        [input.projectId, nextRecord, now],
      );
      return Object.freeze({ accepted: true, authorityNow, leaseExpiresAt });
    });
  }

  async mutate<T>(input: MutateProjectRecordInput<T>): Promise<{
    readonly reused: boolean;
    readonly response: T;
    readonly record: ProjectRecord;
  }> {
    const result = await transaction(this.pool, async (client) => {
      if (input.reserveCognitiveCapacity || input.reserveRunnerCapacity) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          'project-capacity',
        ]);
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `project:${input.projectId}`,
      ]);
      const prior = await client.query<{ request_hash: string; response: T }>(
        `SELECT request_hash, response FROM idempotency_records
         WHERE scope = $1 AND idempotency_key = $2`,
        [input.scope, input.idempotencyKey],
      );
      const existing = prior.rows[0];
      const snapshot = await client.query<{ record: ProjectRecord; version: number }>(
        `SELECT record, version FROM project_snapshots WHERE project_id = $1 FOR UPDATE`,
        [input.projectId],
      );
      const current = snapshot.rows[0];
      if (current === undefined)
        throw new ControlPlaneError('PROJECT_NOT_FOUND', 'Project not found', 404);
      if (existing !== undefined) {
        if (existing.request_hash !== input.requestHash)
          throw new ControlPlaneError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key belongs to another request',
            409,
          );
        return { reused: true, response: existing.response, record: current.record };
      }
      const capacity =
        input.reserveCognitiveCapacity || input.reserveRunnerCapacity
          ? await capacitySnapshot(client)
          : undefined;
      const authorityNow =
        capacity?.authorityNow ??
        (
          await client.query<{ authority_now: string }>(
            `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS authority_now`,
          )
        ).rows[0]?.authority_now;
      if (authorityNow === undefined) throw new Error('PostgreSQL authority clock unavailable');
      const changed = await input.mutate(current.record, authorityNow, capacity);
      const record = synchronizeResultHistory(current.record, changed.record);
      if (
        record.view.projectId !== input.projectId ||
        record.view.version !== current.version + 1 ||
        record.view.lastSequence < current.record.view.lastSequence
      ) {
        throw new Error('Project mutation did not preserve identity and monotonic versions');
      }
      await persistVerificationRecords(client, record.verification);
      await client.query(
        `UPDATE project_snapshots
         SET version = $2, record = $3, updated_at = clock_timestamp()
         WHERE project_id = $1`,
        [input.projectId, record.view.version, record],
      );
      for (const event of record.events.filter(
        ({ sequence }) => sequence > current.record.view.lastSequence,
      )) {
        await persistProjectEvent(client, event);
      }
      await syncExecutionQueue(client, record);
      await syncRuntimeLease(client, record);
      await client.query(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response)
         VALUES ($1, $2, $3, $4)`,
        [input.scope, input.idempotencyKey, input.requestHash, changed.response],
      );
      return { reused: false, response: changed.response, record };
    });
    await drainProjectOutbox({
      pool: this.pool,
      workerId: 'control-plane-project-events',
      projectId: result.record.view.projectId,
      expectedLastSequence: result.record.view.lastSequence,
    });
    return result;
  }
}
