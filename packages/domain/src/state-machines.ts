import type {
  ApprovalState,
  ExecutionState,
  ExternalEffectAggregate,
  ExternalEffectState,
  ProjectState,
  TaskDependency,
  TaskState,
  VersionedAggregate,
} from './types.js';

export type ActorType =
  | 'SUPERVISOR'
  | 'SYSTEM'
  | 'RUNTIME'
  | 'VERIFICATION_ENGINE'
  | 'RECOVERY_COORDINATOR'
  | 'EXPIRY_WORKER';

export interface Actor {
  readonly type: ActorType;
  readonly id: string;
}

export type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>;
export type VersionedState<State extends string> = VersionedAggregate<State>;

export const PROJECT_TRANSITIONS: TransitionMap<ProjectState> = {
  CREATING: ['ACTIVE', 'FAILED', 'CANCELLING'],
  ACTIVE: ['PAUSING', 'STOPPING', 'CANCELLING', 'COMPLETED', 'BLOCKED', 'FAILED'],
  PAUSING: ['PAUSED', 'STOPPING', 'CANCELLING', 'BLOCKED', 'FAILED'],
  PAUSED: ['RESUMING', 'STOPPING', 'CANCELLING'],
  RESUMING: ['ACTIVE', 'STOPPING', 'CANCELLING', 'BLOCKED', 'FAILED'],
  STOPPING: ['STOPPED', 'CANCELLING', 'BLOCKED', 'FAILED'],
  STOPPED: ['RESUMING', 'CANCELLING'],
  CANCELLING: ['CANCELLED', 'BLOCKED'],
  COMPLETED: [],
  BLOCKED: ['ACTIVE', 'PAUSING', 'STOPPING', 'CANCELLING', 'FAILED'],
  FAILED: [],
  CANCELLED: [],
};

const taskWaitingStates = [
  'WAITING_FOR_AGENT',
  'WAITING_FOR_CAPACITY',
  'WAITING_FOR_APPROVAL',
] as const;
export const TASK_TRANSITIONS: TransitionMap<TaskState> = {
  PROPOSED: ['READY', 'CANCELLED'],
  READY: ['QUEUED', 'BLOCKED', 'CANCELLED'],
  QUEUED: ['RUNNING', ...taskWaitingStates, 'BLOCKED', 'CANCELLED'],
  RUNNING: [...taskWaitingStates, 'BLOCKED', 'CLAIMED_COMPLETE', 'FAILED', 'CANCELLED'],
  WAITING_FOR_AGENT: ['QUEUED', 'RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_CAPACITY: ['QUEUED', 'RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_APPROVAL: ['QUEUED', 'RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'RUNNING', 'CANCELLED'],
  CLAIMED_COMPLETE: ['VERIFYING', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['VERIFIED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  VERIFIED: [],
  FAILED: [],
  CANCELLED: [],
};

export const EXECUTION_TRANSITIONS: TransitionMap<ExecutionState> = {
  QUEUED: ['STARTING', 'SUSPENDED', 'STOPPING', 'CANCELLED'],
  STARTING: ['RUNNING', 'SUSPENDED', 'STOPPING', 'FAILED', 'CANCELLED', 'LOST'],
  RUNNING: [
    'WAITING_FOR_APPROVAL',
    'CHECKPOINTING',
    'SUSPENDED',
    'STOPPING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'LOST',
  ],
  WAITING_FOR_APPROVAL: ['RUNNING', 'SUSPENDED', 'STOPPING', 'FAILED', 'CANCELLED', 'LOST'],
  CHECKPOINTING: ['RUNNING', 'SUSPENDED', 'STOPPING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'LOST'],
  SUSPENDED: [],
  STOPPING: ['STOPPED', 'RECONCILING', 'FAILED'],
  STOPPED: [],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  LOST: ['RECONCILING'],
  RECONCILING: ['SUCCEEDED', 'FAILED', 'STOPPED', 'CANCELLED'],
};

export const APPROVAL_TRANSITIONS: TransitionMap<ApprovalState> = {
  REQUESTED: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  APPROVED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const EXTERNAL_EFFECT_TRANSITIONS: TransitionMap<ExternalEffectState> = {
  REQUESTED: ['EXECUTING', 'FAILED'],
  EXECUTING: ['APPLIED', 'FAILED', 'UNKNOWN'],
  APPLIED: [],
  FAILED: [],
  UNKNOWN: ['RECONCILING'],
  RECONCILING: ['RECONCILED', 'UNKNOWN'],
  RECONCILED: [],
};

export function canTransition<State extends string>(
  transitions: TransitionMap<State>,
  from: State,
  to: State,
): boolean {
  return transitions[from].includes(to);
}

function transition<State extends string>(
  machineName: string,
  transitions: TransitionMap<State>,
  aggregate: VersionedState<State>,
  to: State,
  expectedVersion: number,
): VersionedState<State> {
  if (aggregate.version !== expectedVersion) {
    throw new Error(
      `${machineName} version conflict: expected ${expectedVersion}, current ${aggregate.version}`,
    );
  }
  if (!canTransition(transitions, aggregate.state, to)) {
    throw new Error(`Illegal ${machineName} transition ${aggregate.state} -> ${to}`);
  }
  return Object.freeze({ state: to, version: aggregate.version + 1 });
}

function requireActor(actor: Actor, allowed: readonly ActorType[], action: string): void {
  if (!allowed.includes(actor.type)) {
    throw new Error(`${action} requires ${allowed.join(' or ')} authority`);
  }
}

export function transitionProject(
  aggregate: VersionedState<ProjectState>,
  to: ProjectState,
  actor: Actor,
  expectedVersion: number,
): VersionedState<ProjectState> {
  if (['PAUSING', 'RESUMING', 'STOPPING', 'CANCELLING'].includes(to)) {
    requireActor(actor, ['SUPERVISOR'], `Project ${to}`);
  } else {
    requireActor(actor, ['SYSTEM', 'SUPERVISOR'], `Project ${to}`);
  }
  return transition('Project', PROJECT_TRANSITIONS, aggregate, to, expectedVersion);
}

export function transitionTask(
  aggregate: VersionedState<TaskState>,
  to: TaskState,
  actor: Actor,
  expectedVersion: number,
  context: { readonly projectState?: ProjectState } = {},
): VersionedState<TaskState> {
  if (to === 'VERIFIED') {
    requireActor(actor, ['VERIFICATION_ENGINE'], 'Task VERIFIED');
    if (context.projectState === 'PAUSED') {
      throw new Error('Task cannot transition to VERIFIED while Project is PAUSED');
    }
  } else if (to === 'CLAIMED_COMPLETE') {
    requireActor(actor, ['RUNTIME'], 'Task CLAIMED_COMPLETE');
  } else {
    requireActor(actor, ['SYSTEM', 'SUPERVISOR', 'RUNTIME', 'VERIFICATION_ENGINE'], `Task ${to}`);
  }
  return transition('Task', TASK_TRANSITIONS, aggregate, to, expectedVersion);
}

export function transitionExecution(
  aggregate: VersionedState<ExecutionState>,
  to: ExecutionState,
  actor: Actor,
  expectedVersion: number,
): VersionedState<ExecutionState> {
  if (to === 'RECONCILING') {
    requireActor(actor, ['RECOVERY_COORDINATOR'], 'Execution RECONCILING');
  } else if (['SUSPENDED', 'STOPPING', 'STOPPED', 'CANCELLED'].includes(to)) {
    requireActor(actor, ['SUPERVISOR', 'SYSTEM', 'RECOVERY_COORDINATOR'], `Execution ${to}`);
  } else {
    requireActor(actor, ['SYSTEM', 'RUNTIME', 'RECOVERY_COORDINATOR'], `Execution ${to}`);
  }
  return transition('Execution', EXECUTION_TRANSITIONS, aggregate, to, expectedVersion);
}

export function transitionApproval(
  aggregate: VersionedState<ApprovalState>,
  to: ApprovalState,
  actor: Actor,
  expectedVersion: number,
): VersionedState<ApprovalState> {
  if (to === 'APPROVED' || to === 'REJECTED') {
    requireActor(actor, ['SUPERVISOR'], `Approval ${to}`);
  } else if (to === 'EXPIRED') {
    requireActor(actor, ['EXPIRY_WORKER'], 'Approval EXPIRED');
  } else {
    requireActor(actor, ['SUPERVISOR', 'SYSTEM'], `Approval ${to}`);
  }
  return transition('Approval', APPROVAL_TRANSITIONS, aggregate, to, expectedVersion);
}

export function transitionExternalEffect(
  aggregate: VersionedState<ExternalEffectState>,
  to: ExternalEffectState,
  actor: Actor,
  expectedVersion: number,
): VersionedState<ExternalEffectState> {
  if (aggregate.state === 'REQUESTED' && to === 'EXECUTING') {
    throw new Error('ExternalEffect EXECUTING requires beginExternalEffectExecution');
  } else if (aggregate.state === 'UNKNOWN' || aggregate.state === 'RECONCILING') {
    requireActor(actor, ['RECOVERY_COORDINATOR'], `ExternalEffect ${to}`);
  } else if (aggregate.state === 'EXECUTING' && to === 'UNKNOWN') {
    requireActor(actor, ['RUNTIME', 'RECOVERY_COORDINATOR'], `ExternalEffect ${to}`);
  } else {
    requireActor(actor, ['RUNTIME'], `ExternalEffect ${to}`);
  }
  return transition('ExternalEffect', EXTERNAL_EFFECT_TRANSITIONS, aggregate, to, expectedVersion);
}

export interface CurrentLeaseVerifier {
  isCurrentFence(
    resourceType: string,
    resourceId: string,
    leaseId: string,
    ownerId: string,
    fencingToken: bigint,
    now: Date,
  ): Promise<boolean>;
}

export async function beginExternalEffectExecution(
  aggregate: ExternalEffectAggregate,
  actor: Actor,
  expectedVersion: number,
  verifier: CurrentLeaseVerifier,
  now: Date,
): Promise<VersionedState<ExternalEffectState>> {
  requireActor(actor, ['RUNTIME'], 'ExternalEffect EXECUTING');
  if (aggregate.executorFencingToken <= 0n) {
    throw new Error('ExternalEffect executor fencing token must be positive');
  }
  if (aggregate.executorOwnerId !== actor.id) {
    throw new Error('ExternalEffect executor owner must match the runtime actor');
  }
  const current = await verifier.isCurrentFence(
    'EXECUTION',
    aggregate.executorExecutionId,
    aggregate.executorLeaseId,
    aggregate.executorOwnerId,
    aggregate.executorFencingToken,
    now,
  );
  if (!current)
    throw new Error('ExternalEffect EXECUTING requires the current durable runner lease');
  return transition(
    'ExternalEffect',
    EXTERNAL_EFFECT_TRANSITIONS,
    aggregate,
    'EXECUTING',
    expectedVersion,
  );
}

export function assertAcyclicDependencies(
  dependencies: readonly TaskDependency[],
): readonly TaskDependency[] {
  const projectId = dependencies[0]?.projectId;
  const pairs = new Set<string>();
  const graph = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (dependency.projectId !== projectId) {
      throw new Error('Task dependencies must belong to one project');
    }
    if (dependency.predecessorTaskId === dependency.successorTaskId) {
      throw new Error('A Task cannot depend on itself');
    }
    const pair = `${dependency.predecessorTaskId}:${dependency.successorTaskId}`;
    if (pairs.has(pair)) {
      throw new Error('Duplicate Task dependency');
    }
    pairs.add(pair);
    const successors = graph.get(dependency.predecessorTaskId) ?? [];
    successors.push(dependency.successorTaskId);
    graph.set(dependency.predecessorTaskId, successors);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new Error('Task dependency cycle detected');
    if (visited.has(node)) return;
    visiting.add(node);
    for (const successor of graph.get(node) ?? []) visit(successor);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node);
  return dependencies;
}

export type VerificationEvaluationState = 'EVALUATING' | 'PASSED' | 'FAILED' | 'STALE';

export function resolvePauseVerificationBoundary(input: {
  readonly projectState: ProjectState;
  readonly evaluationState: VerificationEvaluationState;
  readonly graceExpired: boolean;
  readonly evaluationPassed: boolean;
}): {
  readonly evaluationState: VerificationEvaluationState;
  readonly taskMayVerify: boolean;
  readonly projectMayPause: boolean;
} {
  if (input.projectState === 'PAUSED' && input.evaluationState === 'EVALUATING') {
    throw new Error('PAUSED cannot contain an EVALUATING verification');
  }
  if (input.evaluationState !== 'EVALUATING') {
    return {
      evaluationState: input.evaluationState,
      taskMayVerify: input.evaluationState === 'PASSED' && input.projectState !== 'PAUSED',
      projectMayPause: true,
    };
  }
  if (input.projectState !== 'PAUSING') {
    throw new Error('An evaluating pause boundary requires Project PAUSING');
  }
  if (input.graceExpired) {
    return { evaluationState: 'STALE', taskMayVerify: false, projectMayPause: true };
  }
  return {
    evaluationState: input.evaluationPassed ? 'PASSED' : 'FAILED',
    taskMayVerify: input.evaluationPassed,
    projectMayPause: true,
  };
}

export interface TransitionReceipt<State extends string> {
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly targetState: State;
  readonly aggregate: VersionedState<State>;
}

export function applyVersionedTransition<From extends string, To extends string>(
  aggregate: VersionedState<From>,
  targetState: To,
  expectedVersion: number,
  idempotencyKey: string,
  priorReceipt?: TransitionReceipt<To>,
): { readonly aggregate: VersionedState<To>; readonly receipt: TransitionReceipt<To> } {
  if (priorReceipt?.idempotencyKey === idempotencyKey) {
    return { aggregate: priorReceipt.aggregate, receipt: priorReceipt };
  }
  if (aggregate.version !== expectedVersion) {
    throw new Error(
      `Aggregate version conflict: expected ${expectedVersion}, current ${aggregate.version}`,
    );
  }
  const next = Object.freeze({ state: targetState, version: aggregate.version + 1 });
  const receipt = Object.freeze({ idempotencyKey, expectedVersion, targetState, aggregate: next });
  return { aggregate: next, receipt };
}
