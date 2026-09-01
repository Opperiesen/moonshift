import type { Pool, PoolClient } from 'pg';

import {
  ControlPlaneError,
  EventCursorExpiredError,
  ProjectVersionConflictError,
} from '../../errors.js';
import type { ProjectEvent, ProjectRecord } from '../../model.js';
import type {
  CreateProjectRecordInput,
  MutateProjectRecordInput,
  ProjectCapacitySnapshot,
  ProjectRepository,
} from './repository.js';

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
    return transaction(this.pool, async (client) => {
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
      const record = await input.build(await capacitySnapshot(client));
      const projectId = record.view.projectId;
      await client.query(
        `INSERT INTO project_snapshots (project_id, version, record)
         VALUES ($1, $2, $3)`,
        [projectId, record.view.version, record],
      );
      for (const event of record.events) {
        await client.query(
          `INSERT INTO project_events (event_id, project_id, project_sequence, envelope)
           VALUES ($1, $2, $3, $4)`,
          [event.eventId, projectId, event.sequence, event],
        );
      }
      await client.query(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response)
         VALUES ('projects', $1, $2, $3)`,
        [input.idempotencyKey, input.requestHash, { projectId }],
      );
      return { reused: false, record };
    });
  }

  async get(projectId: string): Promise<ProjectRecord | null> {
    const result = await this.pool.query<{ record: ProjectRecord }>(
      'SELECT record FROM project_snapshots WHERE project_id = $1',
      [projectId],
    );
    return result.rows[0]?.record ?? null;
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

  async mutate<T>(input: MutateProjectRecordInput<T>): Promise<{
    readonly reused: boolean;
    readonly response: T;
    readonly record: ProjectRecord;
  }> {
    return transaction(this.pool, async (client) => {
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
      if (
        changed.record.view.projectId !== input.projectId ||
        changed.record.view.version !== current.version + 1 ||
        changed.record.view.lastSequence < current.record.view.lastSequence
      ) {
        throw new Error('Project mutation did not preserve identity and monotonic versions');
      }
      await client.query(
        `UPDATE project_snapshots
         SET version = $2, record = $3, updated_at = clock_timestamp()
         WHERE project_id = $1`,
        [input.projectId, changed.record.view.version, changed.record],
      );
      for (const event of changed.record.events.filter(
        ({ sequence }) => sequence > current.record.view.lastSequence,
      )) {
        await client.query(
          `INSERT INTO project_events (event_id, project_id, project_sequence, envelope)
           VALUES ($1, $2, $3, $4)`,
          [event.eventId, input.projectId, event.sequence, event],
        );
      }
      await client.query(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response)
         VALUES ($1, $2, $3, $4)`,
        [input.scope, input.idempotencyKey, input.requestHash, changed.response],
      );
      return { reused: false, response: changed.response, record: changed.record };
    });
  }
}
