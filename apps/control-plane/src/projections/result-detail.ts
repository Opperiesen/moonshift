import type { ExecutionState, ProjectState } from '@moonshift/contracts';
import type { EvidenceStatus, EvidenceType } from '@moonshift/verification';

import { completeResultHistory } from '../application/projects/result-history.js';
import type {
  ApprovalProjection,
  EffectProjection,
  ProjectEvent,
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
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string | null;
  readonly artifactId: string | null;
  readonly producerAgentId: string;
  readonly type: EvidenceType;
  readonly status: EvidenceStatus;
  readonly observedAt: string;
  readonly gitRevision: string;
  readonly sourceHash: `sha256:${string}`;
}

export interface ResultExecutionView {
  readonly executionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly backendConnectionId: string;
  readonly modelDescriptorId: string;
  readonly modelDescriptorVersion: number;
  readonly routeDecisionId: string;
  readonly state: ExecutionState;
  readonly attemptNumber: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface ResultCheckpointView {
  readonly checkpointId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly reason: string;
  readonly schemaVersion: '1.0';
  readonly contentHash: `sha256:${string}`;
  readonly gitRevision: string;
  readonly createdAt: string;
}

export interface ResultEffectView extends EffectProjection {
  readonly projectId: string;
}

export interface ResultAuditView {
  readonly auditEventId: string;
  readonly projectEventId: string;
  readonly supervisionSequence: number | null;
  readonly projectId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly actorType: ProjectEvent['actor']['type'] | SupervisionAuditProjection['actorType'];
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly outcome: string;
  readonly correlationId: string;
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
  readonly effects: readonly ResultEffectView[];
  readonly organizationLineage: {
    readonly authorAgentId: string;
    readonly authorLineageId: string;
    readonly reviewerAgentId: string | null;
    readonly reviewerLineageId: string | null;
    readonly independentReview: boolean;
  };
  readonly blockedReasons: readonly string[];
  readonly recovery: ProjectRecord['supervision']['recovery'];
  readonly audit: readonly ResultAuditView[];
  readonly verified: boolean;
}

function publicApproval(approval: ApprovalProjection): Omit<ApprovalProjection, 'usable'> {
  const { usable: _usable, ...view } = approval;
  return Object.freeze(view);
}

function payloadText(event: ProjectEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function auditReason(event: ProjectEvent): string {
  return (
    payloadText(event, 'summary') ??
    payloadText(event, 'reason') ??
    payloadText(event, 'reasonCode') ??
    `Recorded ${event.kind}`
  );
}

function auditOutcome(event: ProjectEvent): string {
  for (const key of ['toState', 'decision', 'state', 'status', 'outcome', 'result']) {
    const value = payloadText(event, key);
    if (value !== undefined) return value;
  }
  return 'RECORDED';
}

function supervisionAuditAssignments(
  record: ProjectRecord,
): ReadonlyMap<string, SupervisionAuditProjection> {
  const assignedEventIds = new Set<string>();
  const assignments = new Map<string, SupervisionAuditProjection>();
  for (const audit of [...record.supervision.audit].sort(
    (left, right) => left.sequence - right.sequence,
  )) {
    const candidates = record.events
      .filter(
        (event) =>
          event.correlationId === audit.correlationId && !assignedEventIds.has(event.eventId),
      )
      .map((event) => {
        let score = 0;
        if (event.kind === audit.action) score += 1_000;
        if (audit.action.startsWith('control.') && event.kind === 'project.status_changed') {
          score += 900;
        }
        if (event.aggregate.id === audit.targetId) score += 100;
        if (event.actor.id === audit.actorId) score += 20;
        if (event.aggregate.type === audit.targetType) score += 10;
        return { event, score };
      })
      .sort(
        (left, right) => right.score - left.score || left.event.sequence - right.event.sequence,
      );
    const selected = candidates[0]?.event;
    if (selected === undefined) {
      throw new Error(`Supervision audit ${audit.auditEventId} has no project event carrier`);
    }
    assignedEventIds.add(selected.eventId);
    assignments.set(selected.eventId, audit);
  }
  return assignments;
}

export function projectResults(record: ProjectRecord): ResultView {
  const task = record.view.tasks[0];
  if (task === undefined) throw new Error('Result projection requires one bounded fixture task');
  const review = record.verification.review;
  const independentReview =
    review !== null &&
    review.reviewerAgentId !== review.authorAgentId &&
    review.reviewerLineageId !== review.authorLineageId;
  const history = completeResultHistory(record);
  const artifactsById = new Map(
    record.verification.artifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  const latestEvaluation = record.verification.evaluations.at(-1);
  const supervisionAudits = supervisionAuditAssignments(record);
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
        .map((item) => {
          const artifact =
            item.artifactId === undefined ? undefined : artifactsById.get(item.artifactId);
          return Object.freeze({
            evidenceId: item.evidenceId,
            projectId: item.projectId,
            taskId: item.taskId,
            executionId: artifact?.executionId ?? null,
            artifactId: item.artifactId ?? null,
            producerAgentId: item.producerAgentId,
            type: item.type,
            status: item.status,
            observedAt: item.observedAt,
            gitRevision: item.gitRevision,
            sourceHash: item.sourceHash,
          });
        }),
    ),
    approvals: Object.freeze(record.supervision.approvals.map(publicApproval)),
    executions: Object.freeze(
      [...history.executions]
        .sort(
          (left, right) =>
            right.attemptNumber - left.attemptNumber ||
            right.startedAt.localeCompare(left.startedAt) ||
            right.executionId.localeCompare(left.executionId),
        )
        .map((execution) =>
          Object.freeze({
            ...execution,
            projectId: record.view.projectId,
          }),
        ),
    ),
    checkpoints: Object.freeze(
      [...history.checkpoints]
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.checkpointId.localeCompare(left.checkpointId),
        )
        .map((checkpoint) =>
          Object.freeze({
            checkpointId: checkpoint.checkpointId,
            projectId: checkpoint.project.projectId,
            taskId: checkpoint.task.taskId,
            executionId: checkpoint.execution.executionId,
            reason: checkpoint.reason,
            schemaVersion: checkpoint.schemaVersion,
            contentHash: checkpoint.contentHash,
            gitRevision: checkpoint.repository.revision,
            createdAt: checkpoint.createdAt,
          }),
        ),
    ),
    effects: Object.freeze(
      record.supervision.effects.map((effect) =>
        Object.freeze({ ...effect, projectId: record.view.projectId }),
      ),
    ),
    organizationLineage: Object.freeze({
      authorAgentId: record.organization.specialist.agentId,
      authorLineageId: record.organization.specialist.lineageId,
      reviewerAgentId: review?.reviewerAgentId ?? null,
      reviewerLineageId: review?.reviewerLineageId ?? null,
      independentReview,
    }),
    blockedReasons: Object.freeze([...record.supervision.blockedReasons]),
    recovery: Object.freeze({ ...record.supervision.recovery }),
    audit: Object.freeze(
      [...record.events]
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => {
          const supervisionAudit = supervisionAudits.get(event.eventId);
          return Object.freeze({
            auditEventId: supervisionAudit?.auditEventId ?? event.eventId,
            projectEventId: event.eventId,
            supervisionSequence: supervisionAudit?.sequence ?? null,
            projectId: record.view.projectId,
            taskId: task.taskId,
            sequence: event.sequence,
            actorType: supervisionAudit?.actorType ?? event.actor.type,
            actorId: supervisionAudit?.actorId ?? event.actor.id,
            action: supervisionAudit?.action ?? event.kind,
            targetType: supervisionAudit?.targetType ?? event.aggregate.type,
            targetId: supervisionAudit?.targetId ?? event.aggregate.id,
            occurredAt: supervisionAudit?.occurredAt ?? event.occurredAt,
            reason: supervisionAudit?.reason ?? auditReason(event),
            outcome: supervisionAudit?.outcome ?? auditOutcome(event),
            correlationId: event.correlationId,
          });
        }),
    ),
    verified: task.state === 'VERIFIED' && latestEvaluation?.state === 'PASSED',
  });
}
