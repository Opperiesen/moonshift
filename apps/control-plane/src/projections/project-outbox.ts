import type { Pool, PoolClient } from 'pg';
import { withMaintenanceOperation } from '@moonshift/persistence';

const PROJECT_EVENT_PROJECTION = 'project-events';
const CLAIM_DURATION_MS = 30_000;

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

interface ClaimedProjectEvent {
  readonly event_id: string;
  readonly project_id: string;
  readonly project_sequence: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claim_token: string;
}

export interface ProjectOutboxDeliveryReport {
  readonly deliveredEvents: number;
  readonly projectionEventsApplied: number;
  readonly lastSequence: number;
}

/**
 * Applies one claimed event to the durable project-event projection and acknowledges the outbox
 * row in the same transaction. The projection checkpoint is the consumer's idempotency ledger, so
 * an event left unacknowledged by a prior projection attempt is safely acknowledged without being
 * applied twice.
 */
async function deliverNextProjectEvent(input: {
  readonly pool: Pool;
  readonly workerId: string;
  readonly projectId?: string;
  readonly maintenanceClient?: PoolClient;
}): Promise<{ readonly delivered: boolean; readonly applied: boolean }> {
  const run = async (client: PoolClient) => {
    const claimed = await client.query<ClaimedProjectEvent>(
      `WITH candidate AS (
         SELECT pending.event_id
         FROM outbox_events pending
         LEFT JOIN projection_checkpoints checkpoint
           ON checkpoint.projection_name = $2
          AND checkpoint.project_id = pending.project_id
         WHERE ($3::uuid IS NULL OR pending.project_id = $3)
           AND (
             pending.status = 'PENDING'
             OR (pending.status = 'CLAIMED' AND pending.claim_expires_at <= clock_timestamp())
           )
           AND pending.project_sequence <= COALESCE(checkpoint.last_sequence, 0) + 1
         ORDER BY pending.project_id, pending.project_sequence, pending.event_id
         FOR UPDATE OF pending SKIP LOCKED
         LIMIT 1
       )
       UPDATE outbox_events pending
       SET status = 'CLAIMED',
           claimed_by = $1,
           claimed_at = clock_timestamp(),
           claim_expires_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'),
           claim_token = pending.claim_token + 1
       FROM candidate
       WHERE pending.event_id = candidate.event_id
       RETURNING pending.event_id, pending.project_id, pending.project_sequence,
         pending.aggregate_type, pending.aggregate_id, pending.aggregate_version,
         pending.payload, pending.claim_token`,
      [input.workerId, PROJECT_EVENT_PROJECTION, input.projectId ?? null, CLAIM_DURATION_MS],
    );
    const event = claimed.rows[0];
    if (event === undefined) return { delivered: false, applied: false };

    const durable = await client.query(
      `SELECT 1
       FROM project_events stored
       JOIN project_snapshots snapshot ON snapshot.project_id = stored.project_id
       WHERE stored.event_id = $1
         AND stored.project_id = $2
         AND stored.project_sequence = $3
         AND stored.envelope = $4::jsonb
         AND stored.envelope->'aggregate'->>'type' = $5
         AND stored.envelope->'aggregate'->>'id' = $6
         AND (stored.envelope->'aggregate'->>'version')::integer = $7
         AND snapshot.record->'events'->($3::integer - 1) = $4::jsonb`,
      [
        event.event_id,
        event.project_id,
        event.project_sequence,
        event.payload,
        event.aggregate_type,
        event.aggregate_id,
        event.aggregate_version,
      ],
    );
    if ((durable.rowCount ?? 0) !== 1) throw new Error('PROJECT_OUTBOX_EVENT_MISMATCH');

    await client.query(
      `INSERT INTO projection_checkpoints (projection_name, project_id, last_sequence)
       VALUES ($1, $2, 0)
       ON CONFLICT (projection_name, project_id) DO NOTHING`,
      [PROJECT_EVENT_PROJECTION, event.project_id],
    );
    const checkpoint = await client.query<{ last_sequence: string }>(
      `SELECT last_sequence::text
       FROM projection_checkpoints
       WHERE projection_name = $1 AND project_id = $2
       FOR UPDATE`,
      [PROJECT_EVENT_PROJECTION, event.project_id],
    );
    const priorSequence = Number(checkpoint.rows[0]?.last_sequence ?? 0);
    const eventSequence = Number(event.project_sequence);
    if (eventSequence > priorSequence + 1) throw new Error('PROJECT_OUTBOX_PROJECTION_GAP');
    const applied = eventSequence === priorSequence + 1;
    if (applied) {
      const advanced = await client.query(
        `UPDATE projection_checkpoints
         SET last_sequence = $3, updated_at = clock_timestamp()
         WHERE projection_name = $1 AND project_id = $2 AND last_sequence = $3 - 1`,
        [PROJECT_EVENT_PROJECTION, event.project_id, eventSequence],
      );
      if ((advanced.rowCount ?? 0) !== 1) throw new Error('PROJECT_OUTBOX_PROJECTION_RACE');
    }

    const acknowledged = await client.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED',
           published_at = COALESCE(published_at, clock_timestamp()),
           claimed_by = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL
       WHERE event_id = $1
         AND status = 'CLAIMED'
         AND claimed_by = $2
         AND claim_token = $3
         AND claim_expires_at > clock_timestamp()`,
      [event.event_id, input.workerId, event.claim_token],
    );
    if ((acknowledged.rowCount ?? 0) !== 1) throw new Error('PROJECT_OUTBOX_CLAIM_LOST');
    return { delivered: true, applied };
  };
  if (input.maintenanceClient !== undefined) {
    await input.maintenanceClient.query('BEGIN');
    try {
      const result = await run(input.maintenanceClient);
      await input.maintenanceClient.query('COMMIT');
      return result;
    } catch (error) {
      await input.maintenanceClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  return transaction(input.pool, run);
}

async function drainProjectOutboxUnlocked(input: {
  readonly pool: Pool;
  readonly workerId: string;
  readonly projectId: string;
  readonly expectedLastSequence: number;
  readonly maintenanceClient?: PoolClient;
}): Promise<ProjectOutboxDeliveryReport> {
  let deliveredEvents = 0;
  let projectionEventsApplied = 0;
  for (;;) {
    const delivered = await deliverNextProjectEvent(input);
    if (!delivered.delivered) break;
    deliveredEvents += 1;
    if (delivered.applied) projectionEventsApplied += 1;
  }
  const checkpoint = await (input.maintenanceClient ?? input.pool).query<{ last_sequence: string }>(
    `SELECT last_sequence::text
     FROM projection_checkpoints
     WHERE projection_name = $1 AND project_id = $2`,
    [PROJECT_EVENT_PROJECTION, input.projectId],
  );
  const lastSequence = Number(checkpoint.rows[0]?.last_sequence ?? 0);
  if (lastSequence < input.expectedLastSequence) throw new Error('PROJECT_OUTBOX_PROJECTION_GAP');
  return Object.freeze({ deliveredEvents, projectionEventsApplied, lastSequence });
}

export async function drainProjectOutbox(input: {
  readonly pool: Pool;
  readonly workerId: string;
  readonly projectId: string;
  readonly expectedLastSequence: number;
  readonly maintenanceClient?: PoolClient;
}): Promise<ProjectOutboxDeliveryReport> {
  if (input.maintenanceClient !== undefined) return drainProjectOutboxUnlocked(input);
  return withMaintenanceOperation(input.pool, (maintenanceClient) =>
    drainProjectOutboxUnlocked({ ...input, maintenanceClient }),
  );
}
