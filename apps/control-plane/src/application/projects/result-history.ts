import type {
  ProjectEvent,
  ProjectRecord,
  ResultExecutionRecord,
  ResultHistoryRecord,
} from '../../model.js';

const TERMINAL_EXECUTION_STATES = new Set([
  'SUSPENDED',
  'STOPPED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'LOST',
]);

function executionEvents(record: ProjectRecord, executionId: string): readonly ProjectEvent[] {
  return record.events.filter(
    ({ kind, aggregate }) => kind === 'execution.state_changed' && aggregate.id === executionId,
  );
}

function executionRecord(
  record: ProjectRecord,
  successorStartedAt: string | null,
): ResultExecutionRecord {
  const execution = record.scheduling.execution;
  const events = executionEvents(record, execution.executionId);
  const startedAt = events[0]?.occurredAt ?? record.events[0]?.occurredAt;
  if (startedAt === undefined) throw new Error('Execution start time is unavailable');
  const endedAt = TERMINAL_EXECUTION_STATES.has(execution.state)
    ? (events.at(-1)?.occurredAt ?? startedAt)
    : successorStartedAt;
  return Object.freeze({
    executionId: execution.executionId,
    taskId: execution.taskId,
    agentId: execution.agentId,
    runtimeId: execution.runtimeId,
    backendConnectionId: execution.connectionId,
    modelDescriptorId: execution.modelDescriptorId,
    modelDescriptorVersion: execution.modelDescriptorVersion,
    routeDecisionId: record.scheduling.routeDecision.routeDecisionId,
    state: execution.state,
    attemptNumber: record.supervision.authority.executionAttempt,
    startedAt,
    endedAt,
  });
}

function inheritedHistory(record: ProjectRecord): ResultHistoryRecord {
  return (
    record.resultHistory ??
    Object.freeze({
      executions: Object.freeze([executionRecord(record, null)]),
      checkpoints: Object.freeze(
        record.supervision.checkpoint === null ? [] : [record.supervision.checkpoint],
      ),
    })
  );
}

export function synchronizeResultHistory(
  previous: ProjectRecord | null,
  next: ProjectRecord,
): ProjectRecord {
  const base = previous === null ? inheritedHistory(next) : inheritedHistory(previous);
  const executions = new Map(
    base.executions.map((execution) => [execution.executionId, execution]),
  );
  if (previous !== null) {
    const executionChanged =
      previous.scheduling.execution.executionId !== next.scheduling.execution.executionId;
    const successorStartedAt = executionChanged
      ? (executionEvents(next, next.scheduling.execution.executionId)[0]?.occurredAt ??
        next.events.at(-1)?.occurredAt ??
        null)
      : null;
    executions.set(
      previous.scheduling.execution.executionId,
      executionRecord(previous, successorStartedAt),
    );
  }
  const current = executionRecord(next, null);
  executions.set(current.executionId, current);

  const checkpoints = new Map(
    base.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint]),
  );
  if (previous?.supervision.checkpoint !== null && previous?.supervision.checkpoint !== undefined) {
    checkpoints.set(previous.supervision.checkpoint.checkpointId, previous.supervision.checkpoint);
  }
  if (next.supervision.checkpoint !== null) {
    checkpoints.set(next.supervision.checkpoint.checkpointId, next.supervision.checkpoint);
  }

  const resultHistory: ResultHistoryRecord = Object.freeze({
    executions: Object.freeze(
      [...executions.values()].sort(
        (left, right) =>
          left.attemptNumber - right.attemptNumber ||
          left.startedAt.localeCompare(right.startedAt) ||
          left.executionId.localeCompare(right.executionId),
      ),
    ),
    checkpoints: Object.freeze(
      [...checkpoints.values()].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.checkpointId.localeCompare(right.checkpointId),
      ),
    ),
  });
  return Object.freeze({ ...next, resultHistory });
}

export function completeResultHistory(record: ProjectRecord): ResultHistoryRecord {
  const synchronized = synchronizeResultHistory(null, record).resultHistory;
  if (synchronized === undefined) throw new Error('Result history is unavailable');
  return synchronized;
}
