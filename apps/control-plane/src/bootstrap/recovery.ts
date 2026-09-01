import type { Pool } from 'pg';

import { assertExecutionCheckpoint } from '../application/recovery/checkpoints.js';
import { drainProjectOutbox } from '../projections/project-outbox.js';

interface DurableEvent {
  readonly eventId?: string;
  readonly projectId?: string;
  readonly sequence: number;
  readonly aggregate?: {
    readonly type: string;
    readonly id: string;
    readonly version: number;
  };
}

interface DurableRecoveryRecord {
  readonly view: {
    readonly projectId: string;
    readonly status: string;
    readonly version: number;
    readonly lastSequence: number;
  };
  readonly supervision: {
    readonly checkpoint: unknown;
    readonly effects: readonly { readonly state: string }[];
    readonly authority: { readonly executionState: string; readonly executionId?: string };
  };
  readonly events: readonly DurableEvent[];
}

interface RecoveryRepository {
  list(): Promise<readonly DurableRecoveryRecord[]>;
}

export interface DeliveryRecoveryReport {
  readonly releasedQueueClaims: number;
  readonly releasedOutboxClaims: number;
  readonly replayedOutboxEvents: number;
  readonly publishedOutboxEvents: number;
  readonly projectionCheckpointsAdvanced: number;
  readonly projectionReplayBlockedProjectIds: readonly string[];
  readonly projectionReplayFailures: readonly {
    readonly projectId: string;
    readonly reason: string;
  }[];
}

function eventReplayState(
  events: readonly { readonly sequence: number }[],
  expectedLastSequence: number,
): 'CONTIGUOUS' | 'GAP' {
  if (events.length !== expectedLastSequence) return 'GAP';
  return events.every(({ sequence }, index) => sequence === index + 1) ? 'CONTIGUOUS' : 'GAP';
}

export async function recoverPostgresDeliveryState(pool: Pool): Promise<DeliveryRecoveryReport> {
  const releasedQueue = await pool.query(
    `UPDATE queue_items
     SET status = 'AVAILABLE', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
     WHERE status = 'CLAIMED' AND claim_expires_at <= clock_timestamp()`,
  );
  const releasedOutbox = await pool.query(
    `UPDATE outbox_events
     SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
     WHERE status = 'CLAIMED' AND claim_expires_at <= clock_timestamp()`,
  );
  const snapshots = await pool.query<{
    project_id: string;
    retained_from_sequence: string;
    record: DurableRecoveryRecord;
  }>(
    `SELECT project_id, retained_from_sequence::text, record
     FROM project_snapshots ORDER BY project_id`,
  );
  let replayedOutboxEvents = 0;
  let publishedOutboxEvents = 0;
  let projectionCheckpointsAdvanced = 0;
  const projectionReplayBlockedProjectIds: string[] = [];
  const projectionReplayFailures: { projectId: string; reason: string }[] = [];
  const blockProjection = (projectId: string, reason: string): void => {
    projectionReplayBlockedProjectIds.push(projectId);
    projectionReplayFailures.push({ projectId, reason });
  };

  for (const snapshot of snapshots.rows) {
    const { record } = snapshot;
    const retainedFrom = Number(snapshot.retained_from_sequence);
    if (eventReplayState(record.events, record.view.lastSequence) === 'GAP') {
      blockProjection(snapshot.project_id, 'SNAPSHOT_EVENT_GAP');
      continue;
    }
    const retained = await pool.query<{ event_id: string; project_sequence: string }>(
      `SELECT event_id, project_sequence::text
       FROM project_events WHERE project_id = $1 ORDER BY project_events.project_sequence`,
      [snapshot.project_id],
    );
    const retainedMismatchIndex = retained.rows.findIndex((event, index) => {
      const expectedSequence = retainedFrom + index;
      const durable = record.events[expectedSequence - 1];
      return !(
        Number(event.project_sequence) === expectedSequence &&
        durable?.sequence === expectedSequence &&
        durable.eventId === event.event_id
      );
    });
    const retainedValid = retainedMismatchIndex === -1;
    const expectedRetainedCount = Math.max(0, record.view.lastSequence - retainedFrom + 1);
    if (!retainedValid || retained.rows.length !== expectedRetainedCount) {
      blockProjection(
        snapshot.project_id,
        retained.rows.length !== expectedRetainedCount
          ? `RETAINED_EVENT_COUNT:${retained.rows.length}:${expectedRetainedCount}`
          : `RETAINED_EVENT_MISMATCH:${retainedMismatchIndex}:${retained.rows[retainedMismatchIndex]?.event_id ?? 'missing'}:${record.events[retainedFrom + retainedMismatchIndex - 1]?.eventId ?? 'missing'}`,
      );
      continue;
    }

    let replayFailed = false;
    for (const event of record.events) {
      if (
        event.eventId === undefined ||
        event.projectId !== snapshot.project_id ||
        event.aggregate === undefined
      ) {
        replayFailed = true;
        break;
      }
      try {
        const inserted = await pool.query(
          `INSERT INTO outbox_events
             (event_id, project_id, project_sequence, aggregate_type, aggregate_id,
              aggregate_version, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            event.eventId,
            snapshot.project_id,
            event.sequence,
            event.aggregate.type,
            event.aggregate.id,
            event.aggregate.version,
            event,
          ],
        );
        replayedOutboxEvents += inserted.rowCount ?? 0;
        const verified = await pool.query(
          `SELECT 1 FROM outbox_events
           WHERE event_id = $1 AND project_id = $2 AND project_sequence = $3
             AND aggregate_type = $4 AND aggregate_id = $5 AND aggregate_version = $6
             AND payload = $7::jsonb`,
          [
            event.eventId,
            snapshot.project_id,
            event.sequence,
            event.aggregate.type,
            event.aggregate.id,
            event.aggregate.version,
            event,
          ],
        );
        if ((verified.rowCount ?? 0) !== 1) {
          replayFailed = true;
          break;
        }
      } catch {
        replayFailed = true;
        break;
      }
    }
    if (replayFailed) {
      blockProjection(snapshot.project_id, 'OUTBOX_REPLAY_CONFLICT');
      continue;
    }
    await pool.query(
      `UPDATE outbox_events pending
       SET status = 'PENDING',
           published_at = NULL,
           claimed_by = NULL,
           claimed_at = NULL,
           claim_expires_at = NULL
       WHERE pending.project_id = $1
         AND pending.status = 'PUBLISHED'
         AND pending.project_sequence > COALESCE(
           (SELECT checkpoint.last_sequence
            FROM projection_checkpoints checkpoint
            WHERE checkpoint.projection_name = 'project-events'
              AND checkpoint.project_id = pending.project_id),
           0
         )`,
      [snapshot.project_id],
    );
    try {
      const delivery = await drainProjectOutbox({
        pool,
        workerId: 'startup-project-events',
        projectId: snapshot.project_id,
        expectedLastSequence: record.view.lastSequence,
      });
      publishedOutboxEvents += delivery.deliveredEvents;
      projectionCheckpointsAdvanced += delivery.projectionEventsApplied;
    } catch (error) {
      blockProjection(
        snapshot.project_id,
        error instanceof Error ? error.message : 'OUTBOX_DELIVERY_FAILED',
      );
    }
  }

  return Object.freeze({
    releasedQueueClaims: releasedQueue.rowCount ?? 0,
    releasedOutboxClaims: releasedOutbox.rowCount ?? 0,
    replayedOutboxEvents,
    publishedOutboxEvents,
    projectionCheckpointsAdvanced,
    projectionReplayBlockedProjectIds: Object.freeze(projectionReplayBlockedProjectIds),
    projectionReplayFailures: Object.freeze(
      projectionReplayFailures.map((failure) => Object.freeze(failure)),
    ),
  });
}

export async function reconstructDurableState(input: {
  readonly repository: RecoveryRepository;
  readonly pool?: Pool;
}) {
  const records = await input.repository.list();
  const delivery = input.pool === undefined ? null : await recoverPostgresDeliveryState(input.pool);
  const projectionBlocked = new Set(delivery?.projectionReplayBlockedProjectIds ?? []);
  const projectionFailures = new Map(
    (delivery?.projectionReplayFailures ?? []).map(({ projectId, reason }) => [projectId, reason]),
  );
  const projects = [];
  const resumeExecutionIds: string[] = [];
  for (const record of records) {
    const events = record.events;
    const eventReplay = eventReplayState(events, record.view.lastSequence);
    let checkpointState: 'VALID' | 'MISSING' | 'CORRUPT' = 'MISSING';
    if (record.supervision.checkpoint !== null && record.supervision.checkpoint !== undefined) {
      try {
        assertExecutionCheckpoint(record.supervision.checkpoint);
        checkpointState = 'VALID';
      } catch {
        checkpointState = 'CORRUPT';
      }
    }
    const hasUnknownEffect = record.supervision.effects.some(({ state }) =>
      ['UNKNOWN', 'RECONCILING'].includes(state),
    );
    const safeState = ['PAUSED', 'STOPPED', 'CANCELLED'].includes(record.view.status);
    const executionState = record.supervision.authority.executionState;
    const previouslyLostExecution = ['LOST', 'RECONCILING'].includes(executionState);
    const interruptedActiveExecution =
      record.view.status === 'ACTIVE' &&
      ['STARTING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CHECKPOINTING'].includes(executionState);
    const recoverableExecution = previouslyLostExecution || interruptedActiveExecution;
    const sourceExecutionId = record.supervision.authority.executionId ?? null;
    const blockedReason =
      checkpointState === 'CORRUPT'
        ? 'Durable checkpoint failed integrity validation'
        : eventReplay === 'GAP'
          ? 'Durable snapshot event history is not contiguous'
          : projectionBlocked.has(record.view.projectId)
            ? `Durable project-event projection could not be replayed safely: ${projectionFailures.get(record.view.projectId) ?? 'UNKNOWN'}`
            : recoverableExecution && sourceExecutionId === null
              ? 'Recoverable runtime has no durable execution identity'
              : previouslyLostExecution && checkpointState !== 'VALID'
                ? 'Lost runtime has no valid durable checkpoint'
                : null;
    const disposition =
      blockedReason !== null
        ? ('BLOCKED' as const)
        : safeState
          ? ('PRESERVE_SAFE_STATE' as const)
          : recoverableExecution
            ? ('RESUME_ELIGIBLE' as const)
            : ('PRESERVE_ACTIVE_STATE' as const);
    if (disposition === 'RESUME_ELIGIBLE' && sourceExecutionId !== null)
      resumeExecutionIds.push(sourceExecutionId);
    projects.push(
      Object.freeze({
        projectId: record.view.projectId,
        sourceExecutionId,
        projectVersion: record.view.version,
        checkpointState,
        disposition,
        blockedReason,
        requiresEffectReconciliation: hasUnknownEffect,
        eventReplay,
        eventSequence: events.at(-1)?.sequence ?? 0,
      }),
    );
  }
  return Object.freeze({
    projects: Object.freeze(projects),
    resumeExecutionIds: Object.freeze(resumeExecutionIds),
    delivery,
  });
}
