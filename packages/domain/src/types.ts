const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

declare const opaqueIdBrand: unique symbol;

export type OpaqueId<Kind extends string> = string & {
  readonly [opaqueIdBrand]: Kind;
};

export function asOpaqueId<Kind extends string>(kind: Kind, value: string): OpaqueId<Kind> {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`${kind} identity must be an opaque UUID`);
  }
  return value as OpaqueId<Kind>;
}

export const PROJECT_STATES = [
  'CREATING',
  'ACTIVE',
  'PAUSING',
  'PAUSED',
  'RESUMING',
  'STOPPING',
  'STOPPED',
  'CANCELLING',
  'COMPLETED',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
] as const;
export type ProjectState = (typeof PROJECT_STATES)[number];

export const TASK_STATES = [
  'PROPOSED',
  'READY',
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_AGENT',
  'WAITING_FOR_CAPACITY',
  'WAITING_FOR_APPROVAL',
  'BLOCKED',
  'CLAIMED_COMPLETE',
  'VERIFYING',
  'VERIFIED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const EXECUTION_STATES = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'CHECKPOINTING',
  'SUSPENDED',
  'STOPPING',
  'STOPPED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'LOST',
  'RECONCILING',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const APPROVAL_STATES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const EXTERNAL_EFFECT_STATES = [
  'REQUESTED',
  'EXECUTING',
  'APPLIED',
  'FAILED',
  'UNKNOWN',
  'RECONCILING',
  'RECONCILED',
] as const;
export type ExternalEffectState = (typeof EXTERNAL_EFFECT_STATES)[number];

export const PERSONA_IDENTITY_STATES = ['ACTIVE', 'DISABLED', 'ARCHIVED'] as const;
export type PersonaIdentityState = (typeof PERSONA_IDENTITY_STATES)[number];
export const SPECIALIST_IDENTITY_STATES = [
  'CREATED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'ARCHIVED',
] as const;
export type SpecialistIdentityState = (typeof SPECIALIST_IDENTITY_STATES)[number];

export interface VersionedAggregate<State extends string> {
  readonly state: State;
  readonly version: number;
}

export interface TaskDependency {
  readonly taskDependencyId: OpaqueId<'TaskDependency'>;
  readonly projectId: OpaqueId<'Project'>;
  readonly predecessorTaskId: OpaqueId<'Task'>;
  readonly successorTaskId: OpaqueId<'Task'>;
  readonly kind: 'BLOCKS';
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface PersonaIdentity {
  readonly agentId: OpaqueId<'Agent'>;
  readonly projectId: OpaqueId<'Project'>;
  readonly kind: 'PERSONA';
  readonly personaRole: 'PRODUCT' | 'ENGINEERING' | 'QUALITY' | string;
  readonly responsibilityVersion: number;
  readonly policyProfileId: OpaqueId<'PolicyProfile'>;
  readonly permissionSetId: OpaqueId<'PermissionSet'>;
  readonly routingPolicyId: OpaqueId<'RoutingPolicy'>;
  readonly memoryScopeId: OpaqueId<'MemoryScope'>;
  readonly lineageId: OpaqueId<'Lineage'>;
  readonly status: PersonaIdentityState;
}

export interface SpecialistIdentity {
  readonly agentId: OpaqueId<'Agent'>;
  readonly projectId: OpaqueId<'Project'>;
  readonly kind: 'SPECIALIST';
  readonly parentPersonaId: OpaqueId<'Agent'>;
  readonly role: string;
  readonly objective: string;
  readonly lineageId: OpaqueId<'Lineage'>;
  readonly permissionSetId: OpaqueId<'PermissionSet'>;
  readonly routingPolicyId: OpaqueId<'RoutingPolicy'>;
  readonly status: SpecialistIdentityState;
  readonly archivalConditions: readonly string[];
}

export interface TaskAggregate extends VersionedAggregate<TaskState> {
  readonly taskId: OpaqueId<'Task'>;
  readonly projectId: OpaqueId<'Project'>;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly expectedRevision: string;
  readonly dependencies: readonly TaskDependency[];
}

export interface ProjectAggregate extends VersionedAggregate<ProjectState> {
  readonly projectId: OpaqueId<'Project'>;
  readonly workspaceId: OpaqueId<'Workspace'>;
  readonly objective: string;
}

export interface ExecutionAggregate extends VersionedAggregate<ExecutionState> {
  readonly executionId: OpaqueId<'Execution'>;
  readonly taskId: OpaqueId<'Task'>;
  readonly agentId: OpaqueId<'Agent'>;
  readonly connectionId: OpaqueId<'Connection'>;
  readonly modelDescriptorId: OpaqueId<'ModelDescriptor'>;
  readonly modelDescriptorVersion: number;
}

export interface ApprovalAggregate extends VersionedAggregate<ApprovalState> {
  readonly approvalId: OpaqueId<'Approval'>;
  readonly actionDigest: `sha256:${string}`;
  readonly requesterAgentId: OpaqueId<'Agent'>;
  readonly expiresAt: string;
}

export interface ExternalEffectAggregate extends VersionedAggregate<ExternalEffectState> {
  readonly effectId: OpaqueId<'ExternalEffect'>;
  readonly actionDigest: `sha256:${string}`;
  readonly idempotencyKey: string;
  readonly executorExecutionId: OpaqueId<'Execution'>;
  readonly executorLeaseId: OpaqueId<'RunnerLease'>;
  readonly executorOwnerId: string;
  readonly executorFencingToken: bigint;
}
