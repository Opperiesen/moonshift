import { describe, expect, it } from 'vitest';

import {
  assertRuntimeFence,
  createSuccessorRuntimeAuthority,
  evaluateRuntimeHealth,
} from '../../apps/control-plane/src/scheduler/recovery.js';
import {
  reconstructDurableState,
  recoverPostgresDeliveryState,
} from '../../apps/control-plane/src/bootstrap/recovery.js';
import { recoveryCheckpoint, recoveryUuid } from './fixtures.js';

describe('runtime and control-plane restart recovery', () => {
  it('declares an expired or heartbeat-stale runtime lost and fences its authority', () => {
    const lost = evaluateRuntimeHealth({
      authorityNow: '2026-09-01T08:10:00.000Z',
      heartbeatTimeoutMs: 30_000,
      runtime: {
        executionId: recoveryUuid(1),
        runtimeId: recoveryUuid(2),
        leaseId: recoveryUuid(3),
        ownerId: 'fixture-runner',
        fencingToken: 4,
        leaseExpiresAt: '2026-09-01T08:05:00.000Z',
        lastHeartbeatAt: '2026-09-01T08:04:00.000Z',
      },
    });
    expect(lost).toMatchObject({ state: 'LOST', reason: 'LEASE_EXPIRED', fencedToken: 4 });

    const successor = createSuccessorRuntimeAuthority({
      previous: lost,
      executionId: recoveryUuid(4),
      runtimeId: recoveryUuid(5),
      leaseId: recoveryUuid(6),
      ownerId: 'replacement-runner',
      leaseExpiresAt: '2026-09-01T08:15:00.000Z',
      lastHeartbeatAt: '2026-09-01T08:10:00.000Z',
    });
    expect(successor.fencingToken).toBe(5);
    expect(() => assertRuntimeFence(successor, 4)).toThrow('STALE_RUNTIME_FENCE');
    expect(() => assertRuntimeFence(successor, 5)).not.toThrow();
  });

  it('reconstructs inspectable paused state and never auto-resumes it', async () => {
    const checkpoint = recoveryCheckpoint({
      reason: 'PAUSE',
      project: {
        projectId: recoveryUuid(2),
        objective: 'Recover deterministic work',
        status: 'PAUSED',
        version: 5,
        lastSequence: 20,
      },
    });
    const record = {
      view: {
        projectId: checkpoint.project.projectId,
        status: 'PAUSED',
        version: checkpoint.project.version,
        lastSequence: checkpoint.project.lastSequence,
      },
      supervision: { checkpoint, effects: [], authority: { executionState: 'SUSPENDED' } },
      events: Array.from({ length: 20 }, (_, index) => ({ sequence: index + 1 })),
    };
    const report = await reconstructDurableState({
      repository: {
        list: async () => [record],
      },
    });

    expect(report.projects).toEqual([
      expect.objectContaining({
        projectId: checkpoint.project.projectId,
        checkpointState: 'VALID',
        disposition: 'PRESERVE_SAFE_STATE',
        eventSequence: 20,
      }),
    ]);
    expect(report.resumeExecutionIds).toEqual([]);
  });

  it('fails closed on a corrupt checkpoint and on a non-contiguous event replay', async () => {
    const checkpoint = recoveryCheckpoint();
    const corrupt = { ...checkpoint, contentHash: `sha256:${'0'.repeat(64)}` as const };
    const record = {
      view: {
        projectId: checkpoint.project.projectId,
        status: 'ACTIVE',
        version: 4,
        lastSequence: 3,
      },
      supervision: { checkpoint: corrupt, effects: [], authority: { executionState: 'LOST' } },
      events: [{ sequence: 1 }, { sequence: 3 }],
    };
    const report = await reconstructDurableState({
      repository: {
        list: async () => [record],
      },
    });

    expect(report.projects[0]).toMatchObject({
      checkpointState: 'CORRUPT',
      disposition: 'BLOCKED',
      eventReplay: 'GAP',
    });
    expect(report.resumeExecutionIds).toEqual([]);
  });

  it('blocks missing lost-state checkpoints but admits unknown effects to bounded reconciliation', async () => {
    const checkpoint = recoveryCheckpoint();
    const records = [
      {
        view: { projectId: recoveryUuid(30), status: 'ACTIVE', version: 2, lastSequence: 1 },
        supervision: {
          checkpoint: null,
          effects: [],
          authority: { executionState: 'LOST', executionId: recoveryUuid(31) },
        },
        events: [{ sequence: 1 }],
      },
      {
        view: {
          projectId: checkpoint.project.projectId,
          status: 'ACTIVE',
          version: 4,
          lastSequence: 1,
        },
        supervision: {
          checkpoint,
          effects: [{ state: 'UNKNOWN' }],
          authority: { executionState: 'RECONCILING', executionId: recoveryUuid(32) },
        },
        events: [{ sequence: 1 }],
      },
    ];
    const report = await reconstructDurableState({
      repository: {
        list: async () => records,
      },
    });

    expect(report.projects).toEqual([
      expect.objectContaining({ disposition: 'BLOCKED', requiresEffectReconciliation: false }),
      expect.objectContaining({
        disposition: 'RESUME_ELIGIBLE',
        requiresEffectReconciliation: true,
      }),
    ]);
    expect(report.resumeExecutionIds).toEqual([recoveryUuid(32)]);
  });

  it('admits only an active lost execution with a valid checkpoint for startup continuation', async () => {
    const checkpoint = recoveryCheckpoint();
    const record = {
      view: {
        projectId: checkpoint.project.projectId,
        status: 'ACTIVE',
        version: 4,
        lastSequence: 1,
      },
      supervision: {
        checkpoint,
        effects: [],
        authority: { executionState: 'LOST', executionId: checkpoint.execution.executionId },
      },
      events: [{ sequence: 1 }],
    };
    const report = await reconstructDurableState({
      repository: {
        list: async () => [record],
      },
    });

    expect(report.projects[0]?.disposition).toBe('RESUME_ELIGIBLE');
    expect(report.resumeExecutionIds).toEqual([checkpoint.execution.executionId]);
  });

  it('captures a new checkpoint for an active runtime interrupted by control-plane restart', async () => {
    const checkpoint = recoveryCheckpoint();
    const record = {
      view: {
        projectId: checkpoint.project.projectId,
        status: 'ACTIVE',
        version: 4,
        lastSequence: 1,
      },
      supervision: {
        checkpoint: null,
        effects: [],
        authority: {
          executionState: 'WAITING_FOR_APPROVAL',
          executionId: checkpoint.execution.executionId,
        },
      },
      events: [{ sequence: 1 }],
    };

    const report = await reconstructDurableState({
      repository: {
        list: async () => [record],
      },
    });

    expect(report.projects[0]).toMatchObject({
      checkpointState: 'MISSING',
      disposition: 'RESUME_ELIGIBLE',
      sourceExecutionId: checkpoint.execution.executionId,
    });
    expect(report.resumeExecutionIds).toEqual([checkpoint.execution.executionId]);
  });

  it('reconstructs from the durable snapshot when the public event cursor was retained', async () => {
    const checkpoint = recoveryCheckpoint();
    const record = {
      view: {
        projectId: checkpoint.project.projectId,
        status: 'ACTIVE',
        version: 4,
        lastSequence: 3,
      },
      supervision: {
        checkpoint,
        effects: [],
        authority: { executionState: 'LOST', executionId: checkpoint.execution.executionId },
      },
      events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
    };

    const report = await reconstructDurableState({
      repository: {
        list: async () => [record],
      },
    });

    expect(report.projects[0]).toMatchObject({
      disposition: 'RESUME_ELIGIBLE',
      eventReplay: 'CONTIGUOUS',
      eventSequence: 3,
    });
  });

  it('releases expired queue/outbox claims and catches the project-event projection up', async () => {
    const statements: string[] = [];
    let outboxClaimed = false;
    const projectId = recoveryUuid(40);
    const eventId = recoveryUuid(41);
    const event = {
      eventId,
      projectId,
      sequence: 1,
      aggregate: { type: 'PROJECT', id: projectId, version: 1 },
    };
    const pool = {
      query: async (statement: string) => {
        statements.push(statement);
        if (statement.includes('FROM project_snapshots'))
          return {
            rows: [
              {
                project_id: projectId,
                retained_from_sequence: '1',
                record: { view: { lastSequence: 1 }, events: [event] },
              },
            ],
          };
        if (statement.includes('FROM project_events'))
          return { rows: [{ event_id: eventId, project_sequence: '1' }] };
        if (statement.includes('SELECT last_sequence::text'))
          return { rows: [{ last_sequence: '1' }] };
        if (statement.includes("status = 'AVAILABLE'")) return { rowCount: 1 };
        if (statement.includes("status = 'PENDING'") && !statement.includes('project_id = $1'))
          return { rowCount: 2 };
        return { rowCount: 1 };
      },
      connect: async () => ({
        query: async (statement: string) => {
          statements.push(statement);
          if (statement.includes('WITH candidate AS')) {
            if (outboxClaimed) return { rows: [] };
            outboxClaimed = true;
            return {
              rows: [
                {
                  event_id: eventId,
                  project_id: projectId,
                  project_sequence: '1',
                  aggregate_type: 'PROJECT',
                  aggregate_id: projectId,
                  aggregate_version: 1,
                  payload: event,
                  claim_token: '1',
                },
              ],
            };
          }
          if (statement.includes('FROM project_events stored')) return { rowCount: 1 };
          if (statement.includes('SELECT last_sequence::text'))
            return { rows: [{ last_sequence: '0' }] };
          return { rowCount: 1 };
        },
        release: () => undefined,
      }),
    };
    const report = await recoverPostgresDeliveryState(pool as unknown as import('pg').Pool);

    expect(report).toEqual({
      releasedQueueClaims: 1,
      releasedOutboxClaims: 2,
      replayedOutboxEvents: 1,
      publishedOutboxEvents: 1,
      projectionCheckpointsAdvanced: 1,
      projectionValidatedProjectIds: [projectId],
      projectionReplayBlockedProjectIds: [],
      projectionReplayFailures: [],
    });
    expect(statements.join('\n')).toContain("status = 'AVAILABLE'");
    expect(statements.join('\n')).toContain("status = 'PENDING'");
    expect(statements.join('\n')).toContain("'project-events'");
  });
});
