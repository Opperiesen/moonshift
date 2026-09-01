import type {
  AgentIdentityState,
  ExecutionState,
  PresenceSourceType,
  PresenceState,
  ProjectState,
  TaskState,
} from '@moonshift/contracts';
import type { CompleteDelegation, SpecialistIdentity } from '@moonshift/domain';
import type { ContextManifest } from '@moonshift/context';
import type {
  QualityReviewAssignment,
  VerificationArtifact,
  VerificationEvaluation,
  VerificationEvidence,
  VerificationPolicy,
} from '@moonshift/verification';
import type { ExecutionCheckpoint } from './application/recovery/checkpoints.js';

export type FixtureScenario =
  | 'PASS'
  | 'EVIDENCE_FAIL'
  | 'APPROVAL_REJECT'
  | 'INTERRUPT_BEFORE_EFFECT'
  | 'INTERRUPT_DURING_EFFECT'
  | 'INTERRUPT_AFTER_EFFECT';

export interface AgentSummary {
  readonly agentId: string;
  readonly kind: 'PERSONA' | 'SPECIALIST';
  readonly role: string;
  readonly status: AgentIdentityState;
  readonly lineageId: string;
}

export interface PresenceView {
  readonly agentId: string;
  readonly state: PresenceState;
  readonly sourceType: PresenceSourceType;
  readonly sourceId: string;
  readonly updatedAt: string;
  readonly activity: string;
}

export interface TaskSummary {
  readonly taskId: string;
  readonly title: string;
  readonly state: TaskState;
  readonly assigneeAgentId: string | null;
  readonly expectedRevision: string;
}

export interface ChannelSummary {
  readonly channelId: string;
  readonly parentChannelId: string | null;
  readonly name: string;
  readonly kind: 'CATEGORY' | 'CHANNEL' | 'SUBCHANNEL';
  readonly depth: number;
  readonly status: 'ACTIVE' | 'ARCHIVED';
}

export interface TaskDependencySummary {
  readonly taskDependencyId: string;
  readonly predecessorTaskId: string;
  readonly successorTaskId: string;
  readonly kind: 'BLOCKS';
}

export interface ProjectView {
  readonly projectId: string;
  readonly objective: string;
  readonly status: ProjectState;
  readonly version: number;
  readonly personas: readonly AgentSummary[];
  readonly specialists: readonly AgentSummary[];
  readonly presences: readonly PresenceView[];
  readonly channels: readonly ChannelSummary[];
  readonly tasks: readonly TaskSummary[];
  readonly dependencies: readonly TaskDependencySummary[];
  readonly capacity: {
    readonly activeCognitiveRuns: number;
    readonly cognitiveRunLimit: number;
    readonly activeRunnerJobs: number;
    readonly runnerJobLimit: 1;
  };
  readonly lastSequence: number;
}

export type EventKind =
  | 'project.created'
  | 'project.status_changed'
  | 'channel.created'
  | 'agent.created'
  | 'agent.presence_changed'
  | 'delegation.created'
  | 'task.state_changed'
  | 'execution.state_changed'
  | 'backend.event_observed'
  | 'tool.requested'
  | 'policy.decided'
  | 'approval.requested'
  | 'approval.decided'
  | 'effect.state_changed'
  | 'artifact.published'
  | 'evidence.recorded'
  | 'verification.decided'
  | 'checkpoint.created'
  | 'audit.notice';

export interface ProjectEvent {
  readonly schemaVersion: '1.0';
  readonly eventId: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly kind: EventKind;
  readonly occurredAt: string;
  readonly actor: {
    readonly type: 'SUPERVISOR' | 'PERSONA' | 'SPECIALIST' | 'SYSTEM';
    readonly id: string;
    readonly lineageId?: string | null;
  };
  readonly aggregate: {
    readonly type:
      | 'PROJECT'
      | 'CHANNEL'
      | 'AGENT'
      | 'DELEGATION'
      | 'TASK'
      | 'EXECUTION'
      | 'TOOL_INVOCATION'
      | 'APPROVAL'
      | 'EXTERNAL_EFFECT'
      | 'ARTIFACT'
      | 'EVIDENCE'
      | 'CHECKPOINT';
    readonly id: string;
    readonly version: number;
  };
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly classification: 'PUBLIC_FIXTURE' | 'INSTANCE_INTERNAL';
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RouteDecision {
  readonly routeDecisionId: string;
  readonly eligibleConnectionIds: readonly string[];
  readonly selectedConnectionId: string;
  readonly modelDescriptorId: string;
  readonly modelDescriptorVersion: number;
  readonly reasonCode: 'FIXTURE_PRIMARY_SELECTED' | 'RECOVERY_COMPATIBLE_BACKEND_SELECTED';
}

export interface SchedulingResult {
  readonly routeDecision: RouteDecision;
  readonly execution: {
    readonly executionId: string;
    readonly taskId: string;
    readonly agentId: string;
    readonly runtimeId: string;
    readonly connectionId: string;
    readonly modelDescriptorId: string;
    readonly modelDescriptorVersion: number;
    readonly state: ExecutionState;
  };
  readonly runtime: {
    readonly runtimeId: string;
    readonly agentId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly connectionId: string;
    readonly modelDescriptorId: string;
    readonly modelDescriptorVersion: number;
    readonly contextManifestId: string;
    readonly status: 'QUEUED' | 'RUNNING' | 'WAITING_FOR_APPROVAL';
  };
  readonly contextManifestId: string;
  readonly contextManifest: ContextManifest;
  readonly observations: readonly Readonly<Record<string, unknown>>[];
  readonly queueReason:
    | 'BACKEND_CAPACITY'
    | 'COGNITIVE_CAPACITY'
    | 'RUNNER_CAPACITY'
    | 'WAITING_FOR_AGENT'
    | 'WAITING_FOR_APPROVAL'
    | null;
}

export interface ProjectOrganization {
  readonly specialist: SpecialistIdentity;
  readonly delegation: CompleteDelegation;
}

export interface ApprovalProjection {
  readonly approvalId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly requesterAgentId: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  readonly actionDigest: `sha256:${string}`;
  readonly scope: string;
  readonly reason: string;
  readonly riskSummary: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decisionActorId: string | null;
  readonly version: number;
  readonly usable: boolean;
}

export interface EffectProjection {
  readonly effectId: string;
  readonly taskId: string;
  readonly actionDigest: `sha256:${string}`;
  readonly semanticKey: string;
  readonly state:
    'REQUESTED' | 'EXECUTING' | 'APPLIED' | 'FAILED' | 'UNKNOWN' | 'RECONCILING' | 'RECONCILED';
  readonly reconciliationOutcome: string | null;
  readonly groundTruthDigest: `sha256:${string}` | null;
  readonly version: number;
}

export interface SupervisionAuditProjection {
  readonly auditEventId: string;
  readonly sequence: number;
  readonly actorType: 'SUPERVISOR' | 'SPECIALIST' | 'SYSTEM' | 'RUNNER';
  readonly actorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly outcome: string;
  readonly correlationId: string;
}

export interface SupervisionRecord {
  readonly action: {
    readonly tool: 'FIXTURE_EFFECT';
    readonly operation: 'WRITE_APPROVED_MARKER';
    readonly resource: 'fixture:repository';
    readonly arguments: { readonly path: 'approved-marker'; readonly value: string };
  };
  readonly toolInvocationId: string;
  readonly toolInvocationState:
    | 'NOT_REQUESTED'
    | 'WAITING_FOR_APPROVAL'
    | 'APPROVED'
    | 'REJECTED'
    | 'EXPIRED'
    | 'CANCELLED'
    | 'APPLIED';
  readonly approvals: readonly ApprovalProjection[];
  readonly effects: readonly EffectProjection[];
  readonly budget: {
    readonly invocationLimit: number;
    readonly consumedInvocations: number;
    readonly monetaryLimitMicros: number;
    readonly consumedMonetaryMicros: number;
  };
  readonly authority: {
    readonly executionId: string;
    readonly executionAttempt: number;
    readonly executionState: ExecutionState;
    readonly capabilityLeaseId: string;
    readonly capabilityLeaseState: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    readonly capabilityLeaseExpiresAt: string;
    readonly runnerLeaseId: string;
    readonly runnerLeaseState: 'ACTIVE' | 'REVOKED';
    readonly runnerLeaseExpiresAt: string;
    readonly runnerLastHeartbeatAt: string;
    readonly fencingToken: number;
    readonly successor: boolean;
  };
  readonly checkpoint: ExecutionCheckpoint | null;
  readonly recovery: {
    readonly state:
      | 'IDLE'
      | 'SAFE_CHECKPOINT'
      | 'RUNTIME_LOST'
      | 'RECONCILING'
      | 'SWITCHING_BACKEND'
      | 'RESUMED'
      | 'BLOCKED_UNKNOWN'
      | 'BLOCKED_RECOVERY';
    readonly sourceExecutionId: string | null;
    readonly successorExecutionId: string | null;
    readonly sourceConnectionId: string | null;
    readonly targetConnectionId: string | null;
    readonly progress: string;
    readonly updatedAt: string;
  };
  readonly verification: {
    readonly state: 'NONE' | 'EVALUATING' | 'STALE';
  };
  readonly blockedReasons: readonly string[];
  readonly audit: readonly SupervisionAuditProjection[];
}

export interface SupervisionProjection extends SupervisionRecord {
  readonly projectState: ProjectState;
  readonly projectVersion: number;
}

export interface QualityReviewRecord extends QualityReviewAssignment {
  readonly contextManifest: ContextManifest;
}

export interface VerificationRecord {
  readonly taskVersion: number;
  readonly policy: VerificationPolicy;
  readonly artifacts: readonly VerificationArtifact[];
  readonly evidence: readonly VerificationEvidence[];
  readonly review: QualityReviewRecord | null;
  readonly evaluations: readonly VerificationEvaluation[];
}

export interface ProjectRecord {
  readonly fixtureScenario: FixtureScenario;
  readonly taskDefinition: {
    readonly objective: string;
    readonly acceptanceCriteria: readonly string[];
  };
  readonly view: ProjectView;
  readonly organization: ProjectOrganization;
  readonly scheduling: SchedulingResult;
  readonly supervision: SupervisionRecord;
  readonly verification: VerificationRecord;
  readonly events: readonly ProjectEvent[];
}
