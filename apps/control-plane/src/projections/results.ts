import type { ExecutionState, ProjectState } from '@moonshift/contracts';
import type { EvidenceStatus, EvidenceType } from '@moonshift/verification';

import type {
  ApprovalProjection,
  EffectProjection,
  ProjectRecord,
  SupervisionAuditProjection,
  TaskSummary,
} from '../model.js';

export interface ResultArtifactView {
  readonly artifactId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly size: number;
  readonly contentHash: `sha256:${string}`;
  readonly gitRevision: string;
}

export interface ResultEvidenceView {
  readonly evidenceId: string;
  readonly producerAgentId: string;
  readonly type: EvidenceType;
  readonly status: EvidenceStatus;
  readonly observedAt: string;
  readonly gitRevision: string;
  readonly sourceHash: `sha256:${string}`;
}

export interface ResultExecutionView {
  readonly executionId: string;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly backendConnectionId: string;
  readonly modelDescriptorId: string;
  readonly modelDescriptorVersion: number;
  readonly state: ExecutionState;
  readonly attemptNumber: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface ResultCheckpointView {
  readonly checkpointId: string;
  readonly executionId: string;
  readonly schemaVersion: '1.0';
  readonly contentHash: `sha256:${string}`;
  readonly gitRevision: string;
  readonly createdAt: string;
}

export interface ResultView {
  readonly projectId: string;
  readonly projectState: ProjectState;
  readonly task: TaskSummary;
  readonly artifacts: readonly ResultArtifactView[];
  readonly evidence: readonly ResultEvidenceView[];
  readonly approvals: readonly Omit<ApprovalProjection, 'usable'>[];
  readonly executions: readonly ResultExecutionView[];
  readonly checkpoints: readonly ResultCheckpointView[];
  readonly effects: readonly EffectProjection[];
  readonly organizationLineage: {
    readonly authorAgentId: string;
    readonly authorLineageId: string;
    readonly reviewerAgentId: string | null;
    readonly reviewerLineageId: string | null;
    readonly independentReview: boolean;
  };
  readonly audit: readonly SupervisionAuditProjection[];
  readonly verified: boolean;
}

function publicApproval(approval: ApprovalProjection): Omit<ApprovalProjection, 'usable'> {
  const { usable: _usable, ...view } = approval;
  return Object.freeze(view);
}

export function projectResults(record: ProjectRecord): ResultView {
  const task = record.view.tasks[0];
  if (task === undefined) throw new Error('Result projection requires one bounded fixture task');
  const review = record.verification.review;
  const independentReview =
    review !== null &&
    review.reviewerAgentId !== review.authorAgentId &&
    review.reviewerLineageId !== review.authorLineageId;
  const executionStartedAt =
    record.events.find(
      ({ kind, aggregate }) =>
        kind === 'execution.state_changed' &&
        aggregate.id === record.scheduling.execution.executionId,
    )?.occurredAt ?? record.events[0]?.occurredAt;
  if (executionStartedAt === undefined) throw new Error('Execution start time is unavailable');
  const terminal = ['SUSPENDED', 'STOPPED', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(
    record.scheduling.execution.state,
  );
  const endedAt = terminal
    ? ([...record.events]
        .reverse()
        .find(
          ({ kind, aggregate }) =>
            kind === 'execution.state_changed' &&
            aggregate.id === record.scheduling.execution.executionId,
        )?.occurredAt ?? executionStartedAt)
    : null;
  const latestEvaluation = record.verification.evaluations.at(-1);
  return Object.freeze({
    projectId: record.view.projectId,
    projectState: record.view.status,
    task,
    artifacts: Object.freeze(
      record.verification.artifacts.map((artifact) =>
        Object.freeze({
          artifactId: artifact.artifactId,
          projectId: artifact.projectId,
          taskId: artifact.taskId,
          executionId: artifact.executionId,
          kind: artifact.kind,
          mediaType: artifact.mediaType,
          size: artifact.size,
          contentHash: artifact.contentHash,
          gitRevision: artifact.gitRevision,
        }),
      ),
    ),
    evidence: Object.freeze(
      [...record.verification.evidence]
        .sort(
          (left, right) =>
            left.observedAt.localeCompare(right.observedAt) ||
            left.evidenceId.localeCompare(right.evidenceId),
        )
        .map((item) =>
          Object.freeze({
            evidenceId: item.evidenceId,
            producerAgentId: item.producerAgentId,
            type: item.type,
            status: item.status,
            observedAt: item.observedAt,
            gitRevision: item.gitRevision,
            sourceHash: item.sourceHash,
          }),
        ),
    ),
    approvals: Object.freeze(record.supervision.approvals.map(publicApproval)),
    executions: Object.freeze([
      Object.freeze({
        executionId: record.scheduling.execution.executionId,
        agentId: record.scheduling.execution.agentId,
        runtimeId: record.scheduling.execution.runtimeId,
        backendConnectionId: record.scheduling.execution.connectionId,
        modelDescriptorId: record.scheduling.execution.modelDescriptorId,
        modelDescriptorVersion: record.scheduling.execution.modelDescriptorVersion,
        state: record.scheduling.execution.state,
        attemptNumber: record.supervision.authority.executionAttempt,
        startedAt: executionStartedAt,
        endedAt,
      }),
    ]),
    checkpoints: Object.freeze(
      record.supervision.checkpoint === null
        ? []
        : [
            Object.freeze({
              checkpointId: record.supervision.checkpoint.checkpointId,
              executionId: record.supervision.checkpoint.execution.executionId,
              schemaVersion: record.supervision.checkpoint.schemaVersion,
              contentHash: record.supervision.checkpoint.contentHash,
              gitRevision: record.supervision.checkpoint.repository.revision,
              createdAt: record.supervision.checkpoint.createdAt,
            }),
          ],
    ),
    effects: record.supervision.effects,
    organizationLineage: Object.freeze({
      authorAgentId: record.organization.specialist.agentId,
      authorLineageId: record.organization.specialist.lineageId,
      reviewerAgentId: review?.reviewerAgentId ?? null,
      reviewerLineageId: review?.reviewerLineageId ?? null,
      independentReview,
    }),
    audit: Object.freeze(
      [...record.supervision.audit].sort((left, right) => left.sequence - right.sequence),
    ),
    verified: task.state === 'VERIFIED' && latestEvaluation?.state === 'PASSED',
  });
}
