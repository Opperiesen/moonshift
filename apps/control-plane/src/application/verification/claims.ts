import type { FsArtifactStore } from '@moonshift/artifacts';
import { transitionTask, type VersionedState } from '@moonshift/domain';
import type { VerificationArtifact } from '@moonshift/verification';

import type { ProjectRecord } from '../../model.js';

function latestTaskVersion(record: ProjectRecord, taskId: string): number {
  return record.events.reduce(
    (version, event) =>
      event.aggregate.type === 'TASK' && event.aggregate.id === taskId
        ? Math.max(version, event.aggregate.version)
        : version,
    record.verification.taskVersion,
  );
}

export async function publishFixtureArtifactAndClaim(input: {
  readonly record: ProjectRecord;
  readonly artifactStore: FsArtifactStore;
  readonly artifactId: string;
  readonly occurredAt: string;
}): Promise<{
  readonly artifact: VerificationArtifact;
  readonly claimedTask: VersionedState<'CLAIMED_COMPLETE'>;
}> {
  const task = input.record.view.tasks[0];
  if (task === undefined) throw new Error('Verification requires one bounded fixture task');
  if (task.state !== 'RUNNING') {
    throw new Error(`Completion claim requires RUNNING work, received ${task.state}`);
  }
  const applied = input.record.supervision.effects.some(
    ({ state, reconciliationOutcome }) =>
      state === 'APPLIED' ||
      (state === 'RECONCILED' && reconciliationOutcome === 'GROUND_TRUTH_APPLIED'),
  );
  if (!applied) throw new Error('Completion claim requires the approved fixture effect');

  const bytes = JSON.stringify({
    schemaVersion: '1.0',
    projectId: input.record.view.projectId,
    taskId: task.taskId,
    executionId: input.record.scheduling.execution.executionId,
    gitRevision: task.expectedRevision,
    result: 'Deterministic fixture artifact',
  });
  const stored = await input.artifactStore.put(bytes, {
    artifactId: input.artifactId,
    projectId: input.record.view.projectId,
    taskId: task.taskId,
    executionId: input.record.scheduling.execution.executionId,
    gitRevision: task.expectedRevision,
    kind: 'FIXTURE_RESULT',
    mediaType: 'application/json',
  });
  const artifact: VerificationArtifact = Object.freeze({
    artifactId: stored.artifactId,
    projectId: input.record.view.projectId,
    taskId: task.taskId,
    executionId: input.record.scheduling.execution.executionId,
    authorAgentId: input.record.organization.specialist.agentId,
    authorLineageId: input.record.organization.specialist.lineageId,
    kind: 'FIXTURE_RESULT',
    mediaType: 'application/json',
    size: stored.size,
    contentHash: stored.contentHash,
    storageKey: stored.storageKey,
    gitRevision: task.expectedRevision,
    createdAt: input.occurredAt,
  });
  const claimedTask = transitionTask(
    { state: task.state, version: latestTaskVersion(input.record, task.taskId) },
    'CLAIMED_COMPLETE',
    { type: 'RUNTIME', id: input.record.scheduling.runtime.runtimeId },
    latestTaskVersion(input.record, task.taskId),
  ) as VersionedState<'CLAIMED_COMPLETE'>;
  return Object.freeze({ artifact, claimedTask });
}
