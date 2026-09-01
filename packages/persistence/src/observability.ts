import type { Pool } from 'pg';

export type PostgresObservabilitySnapshot = {
  readonly connections: number;
  readonly waitingLocks: number;
  readonly databaseBytes: number;
  readonly pendingOutboxEvents: number;
  readonly outboxLagMs: number;
  readonly queuedExecutions: number;
  readonly queueWaitMs: number;
  readonly queueReasons: Readonly<Record<string, number>>;
};

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label} metric`);
  return value;
}

/** Collects bounded, aggregate-only PostgreSQL health and queue metrics. */
export async function collectPostgresObservability(
  pool: Pool,
): Promise<PostgresObservabilitySnapshot> {
  const [database, outbox, queue, reasons] = await Promise.all([
    pool.query<{ connections: number; waiting_locks: number; database_bytes: string }>(`
      SELECT
        (SELECT count(*)::integer FROM pg_stat_activity WHERE datname = current_database()) AS connections,
        (SELECT count(*)::integer FROM pg_locks WHERE NOT granted) AS waiting_locks,
        pg_database_size(current_database())::text AS database_bytes`),
    pool.query<{ pending: number; lag_ms: number }>(`
      SELECT
        count(*) FILTER (WHERE status <> 'PUBLISHED')::integer AS pending,
        COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp() - created_at)) * 1000)
          FILTER (WHERE status <> 'PUBLISHED'), 0)::double precision AS lag_ms
      FROM outbox_events`),
    pool.query<{ queued: number; wait_ms: number }>(`
      SELECT
        count(*) FILTER (WHERE status IN ('AVAILABLE', 'CLAIMED'))::integer AS queued,
        COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp() - available_at)) * 1000)
          FILTER (WHERE status IN ('AVAILABLE', 'CLAIMED')), 0)::double precision AS wait_ms
      FROM queue_items`),
    pool.query<{ reason: string; count: number }>(`
      SELECT snapshot.record#>>'{scheduling,queueReason}' AS reason, count(*)::integer AS count
      FROM project_snapshots snapshot
      WHERE snapshot.record#>>'{scheduling,queueReason}' IS NOT NULL
      GROUP BY snapshot.record#>>'{scheduling,queueReason}'
      ORDER BY reason`),
  ]);
  const databaseRow = database.rows[0];
  const outboxRow = outbox.rows[0];
  const queueRow = queue.rows[0];
  if (databaseRow === undefined || outboxRow === undefined || queueRow === undefined) {
    throw new Error('PostgreSQL observability query returned no row');
  }
  return Object.freeze({
    connections: nonNegative(databaseRow.connections, 'connection'),
    waitingLocks: nonNegative(databaseRow.waiting_locks, 'waiting lock'),
    databaseBytes: nonNegative(Number(databaseRow.database_bytes), 'database size'),
    pendingOutboxEvents: nonNegative(outboxRow.pending, 'outbox count'),
    outboxLagMs: nonNegative(outboxRow.lag_ms, 'outbox lag'),
    queuedExecutions: nonNegative(queueRow.queued, 'queue count'),
    queueWaitMs: nonNegative(queueRow.wait_ms, 'queue wait'),
    queueReasons: Object.freeze(
      Object.fromEntries(reasons.rows.map(({ reason, count }) => [reason, count])),
    ),
  });
}
