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
  | 'policy.decided'
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
    readonly type: 'PROJECT' | 'CHANNEL' | 'AGENT' | 'DELEGATION' | 'TASK' | 'EXECUTION';
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
  readonly reasonCode: 'FIXTURE_PRIMARY_SELECTED';
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

export interface ProjectRecord {
  readonly view: ProjectView;
  readonly organization: ProjectOrganization;
  readonly scheduling: SchedulingResult;
  readonly events: readonly ProjectEvent[];
}
