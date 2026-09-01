import { FAKE_CONNECTIONS } from '@moonshift/backend-fake';
import {
  transitionExecution,
  transitionExternalEffect,
  type ExecutionState,
  type ExternalEffectState,
} from '@moonshift/domain';

import type { ProjectRecord } from '../../model.js';
import { appendSupervisionMutation } from '../../projections/supervision-events.js';
import {
  isSuccessfulBackendContinuation,
  planBackendSwitchFromCheckpoint,
  switchBackendFromCheckpoint,
  type BackendSwitchConnection,
  type BackendSwitchPlan,
  type BackendSwitchResult,
} from '../../scheduler/backend-switch.js';
import { evaluateRuntimeHealth } from '../../scheduler/recovery.js';
import {
  commandRequestHash,
  type ProjectRepository,
  type RuntimeHeartbeatInput,
} from '../projects/repository.js';
import type { ApprovedEffectExecutor } from '../supervision/tool-policy.js';
import {
  assertExecutionCheckpoint,
  checkpointFromProjectRecord,
  createExecutionCheckpoint,
  type ExecutionCheckpoint,
} from './checkpoints.js';
import { recoverEffectAfterCrash } from './reconciliation.js';

type RecoveryEvent = Parameters<typeof appendSupervisionMutation>[0]['events'][number];
type RecoveryAudit = Parameters<typeof appendSupervisionMutation>[0]['audits'][number];
type EffectProjection = ProjectRecord['supervision']['effects'][number];

const INTERRUPTIBLE_EXECUTION_STATES = new Set<ExecutionState>([
  'STARTING',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'CHECKPOINTING',
  'LOST',
  'RECONCILING',
]);

function latestExecutionVersion(record: ProjectRecord, executionId: string): number {
  return record.events.reduce(
    (version, event) =>
      event.aggregate.type === 'EXECUTION' && event.aggregate.id === executionId
        ? Math.max(version, event.aggregate.version)
        : version,
    0,
  );
}

function checkpointEvent(
  checkpoint: ExecutionCheckpoint,
  systemId: string,
  summary: string,
): RecoveryEvent {
  return {
    kind: 'checkpoint.created',
    actor: { type: 'SYSTEM', id: systemId },
    aggregate: { type: 'CHECKPOINT', id: checkpoint.checkpointId, version: 1 },
    payload: {
      referenceType: 'CHECKPOINT',
      referenceId: checkpoint.checkpointId,
      contentHash: checkpoint.contentHash,
      summary,
    },
  };
}

function sourceRecoveryEvents(record: ProjectRecord, systemId: string): readonly RecoveryEvent[] {
  const sourceExecutionId = record.supervision.authority.executionId;
  let aggregate = {
    state: record.supervision.authority.executionState,
    version: latestExecutionVersion(record, sourceExecutionId),
  };
  const path: readonly ExecutionState[] =
    aggregate.state === 'RECONCILING'
      ? []
      : aggregate.state === 'LOST'
        ? ['RECONCILING']
        : ['LOST', 'RECONCILING'];
  const events: RecoveryEvent[] = [];
  for (const nextState of path) {
    const transitioned = transitionExecution(
      aggregate,
      nextState,
      nextState === 'RECONCILING'
        ? { type: 'RECOVERY_COORDINATOR', id: systemId }
        : { type: 'SYSTEM', id: systemId },
      aggregate.version,
    );
    events.push({
      kind: 'execution.state_changed',
      actor: { type: 'SYSTEM', id: systemId },
      aggregate: {
        type: 'EXECUTION',
        id: sourceExecutionId,
        version: transitioned.version,
      },
      payload: {
        fromState: aggregate.state,
        toState: transitioned.state,
        reasonCode: nextState === 'LOST' ? 'RUNTIME_LOST_FENCED' : 'RUNTIME_RECOVERY_RECONCILING',
        summary:
          nextState === 'LOST'
            ? 'Lost runtime was fenced before replacement scheduling'
            : 'Fenced runtime entered ground-truth reconciliation',
      },
    });
    aggregate = transitioned;
  }
  return Object.freeze(events);
}

function successorExecutionEvents(executionId: string, systemId: string): readonly RecoveryEvent[] {
  const events: RecoveryEvent[] = [
    {
      kind: 'execution.state_changed',
      actor: { type: 'SYSTEM', id: systemId },
      aggregate: { type: 'EXECUTION', id: executionId, version: 1 },
      payload: {
        fromState: null,
        toState: 'QUEUED',
        reasonCode: 'RECOVERY_SUCCESSOR_CREATED',
        summary: 'Recovery created a fresh successor execution from the durable checkpoint',
      },
    },
  ];
  let aggregate: { readonly state: ExecutionState; readonly version: number } = {
    state: 'QUEUED',
    version: 1,
  };
  for (const nextState of ['STARTING', 'RUNNING', 'WAITING_FOR_APPROVAL'] as const) {
    const transitioned = transitionExecution(
      aggregate,
      nextState,
      { type: 'SYSTEM', id: systemId },
      aggregate.version,
    );
    events.push({
      kind: 'execution.state_changed',
      actor: { type: 'SYSTEM', id: systemId },
      aggregate: { type: 'EXECUTION', id: executionId, version: transitioned.version },
      payload: {
        fromState: aggregate.state,
        toState: transitioned.state,
        reasonCode: 'RECOVERY_BACKEND_SWITCHED',
        summary: 'Provider-neutral checkpoint continued on a compatible backend connection',
      },
    });
    aggregate = transitioned;
  }
  return Object.freeze(events);
}

function effectRecoveryTransitions(input: {
  readonly effect: EffectProjection;
  readonly targetState: 'RECONCILED' | 'UNKNOWN';
  readonly systemId: string;
}): { readonly version: number; readonly events: readonly RecoveryEvent[] } {
  let aggregate = {
    state: input.effect.state as ExternalEffectState,
    version: input.effect.version,
  };
  const path: readonly ExternalEffectState[] =
    aggregate.state === 'EXECUTING'
      ? ['UNKNOWN', 'RECONCILING', input.targetState]
      : aggregate.state === 'UNKNOWN'
        ? ['RECONCILING', input.targetState]
        : [input.targetState];
  const events: RecoveryEvent[] = [];
  for (const nextState of path) {
    const transitioned = transitionExternalEffect(
      aggregate,
      nextState,
      { type: 'RECOVERY_COORDINATOR', id: input.systemId },
      aggregate.version,
    );
    const reasonCode =
      nextState === 'RECONCILING'
        ? 'RECOVERY_GROUND_TRUTH_LOOKUP'
        : nextState === 'RECONCILED'
          ? 'RECOVERY_GROUND_TRUTH_DETERMINATE'
          : 'RECOVERY_GROUND_TRUTH_UNKNOWN';
    events.push({
      kind: 'effect.state_changed',
      actor: { type: 'SYSTEM', id: input.systemId },
      aggregate: {
        type: 'EXTERNAL_EFFECT',
        id: input.effect.effectId,
        version: transitioned.version,
      },
      payload: {
        fromState: aggregate.state,
        toState: transitioned.state,
        reasonCode,
        summary:
          nextState === 'RECONCILING'
            ? 'Recovery began a bounded fixture ground-truth lookup'
            : nextState === 'RECONCILED'
              ? 'Recovery recorded determinate fixture ground truth'
              : 'Effect outcome remains unknown and cannot be retried blindly',
      },
    });
    aggregate = transitioned;
  }
  return Object.freeze({ version: aggregate.version, events: Object.freeze(events) });
}

function blockedProjectEvent(
  record: ProjectRecord,
  systemId: string,
  reasonCode = 'RECOVERY_GROUND_TRUTH_UNKNOWN',
  summary = 'Project blocked because effect ground truth remains indeterminate',
): RecoveryEvent {
  return {
    kind: 'project.status_changed',
    actor: { type: 'SYSTEM', id: systemId },
    aggregate: {
      type: 'PROJECT',
      id: record.view.projectId,
      version: record.view.version + 1,
    },
    payload: {
      fromState: record.view.status,
      toState: 'BLOCKED',
      reasonCode,
      summary,
    },
  };
}

function successorCheckpoint(input: {
  readonly source: ExecutionCheckpoint;
  readonly switched: BackendSwitchResult;
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly projectVersion: number;
  readonly projectLastSequence: number;
  readonly budget: ProjectRecord['supervision']['budget'];
  readonly leases: ExecutionCheckpoint['leases'];
  readonly effects: ProjectRecord['supervision']['effects'];
}): ExecutionCheckpoint {
  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    backendSessionHint: _backendSessionHint,
    ...durableSource
  } = input.source;
  const nextSequence = input.switched.result.events.reduce(
    (next, observation) =>
      observation.accepted ? Math.max(next, observation.event.sequence + 1) : next,
    Math.max(input.source.continuation.nextSequence, input.switched.result.checkpoint.nextSequence),
  );
  return createExecutionCheckpoint({
    ...durableSource,
    checkpointId: input.checkpointId,
    createdAt: input.createdAt,
    reason: 'BACKEND_SWITCH',
    project: {
      ...input.source.project,
      version: input.projectVersion,
      lastSequence: input.projectLastSequence,
    },
    execution: {
      executionId: input.switched.successor.executionId,
      runtimeId: input.switched.successor.runtimeId,
      connectionId: input.switched.successor.connectionId,
      modelDescriptorId: input.switched.successor.modelDescriptorId,
      modelDescriptorVersion: input.switched.successor.modelDescriptorVersion,
      contextManifestId: input.switched.successor.contextManifestId,
    },
    context: {
      manifestId: input.switched.successor.contextManifestId,
      manifestHash: input.switched.contextManifest.manifestHash,
      compilerPolicyVersion: input.switched.contextManifest.compilerPolicyVersion,
    },
    budget: input.budget,
    leases: input.leases,
    effects: input.effects.map(
      ({
        effectId,
        actionDigest,
        semanticKey,
        state,
        reconciliationOutcome,
        groundTruthDigest,
      }) => ({
        effectId,
        actionDigest,
        semanticKey,
        state,
        reconciliationOutcome,
        groundTruthDigest,
      }),
    ),
    continuation: {
      ...input.source.continuation,
      cursor: input.switched.result.checkpoint.cursor,
      nextSequence,
    },
  });
}

function plannedSuccessorCheckpoint(input: {
  readonly source: ExecutionCheckpoint;
  readonly plan: BackendSwitchPlan;
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly projectVersion: number;
  readonly projectLastSequence: number;
  readonly budget: ProjectRecord['supervision']['budget'];
  readonly leases: ExecutionCheckpoint['leases'];
  readonly effects: ProjectRecord['supervision']['effects'];
}): ExecutionCheckpoint {
  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    backendSessionHint: _backendSessionHint,
    ...durableSource
  } = input.source;
  return createExecutionCheckpoint({
    ...durableSource,
    checkpointId: input.checkpointId,
    createdAt: input.createdAt,
    reason: 'BACKEND_SWITCH',
    project: {
      ...input.source.project,
      version: input.projectVersion,
      lastSequence: input.projectLastSequence,
    },
    execution: {
      executionId: input.plan.successor.executionId,
      runtimeId: input.plan.successor.runtimeId,
      connectionId: input.plan.successor.connectionId,
      modelDescriptorId: input.plan.successor.modelDescriptorId,
      modelDescriptorVersion: input.plan.successor.modelDescriptorVersion,
      contextManifestId: input.plan.successor.contextManifestId,
    },
    context: {
      manifestId: input.plan.successor.contextManifestId,
      manifestHash: input.plan.contextManifest.manifestHash,
      compilerPolicyVersion: input.plan.contextManifest.compilerPolicyVersion,
    },
    budget: input.budget,
    leases: input.leases,
    effects: input.effects.map(
      ({
        effectId,
        actionDigest,
        semanticKey,
        state,
        reconciliationOutcome,
        groundTruthDigest,
      }) => ({
        effectId,
        actionDigest,
        semanticKey,
        state,
        reconciliationOutcome,
        groundTruthDigest,
      }),
    ),
    continuation: input.source.continuation,
  });
}

function checkpointWithDurableContinuation(
  checkpoint: ExecutionCheckpoint,
  continuation: ExecutionCheckpoint['continuation'],
): ExecutionCheckpoint {
  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    ...checkpointInput
  } = checkpoint;
  return createExecutionCheckpoint({
    ...checkpointInput,
    continuation,
  });
}

function checkpointWithRecoveryDecision(input: {
  readonly checkpoint: ExecutionCheckpoint;
  readonly effectApplied: boolean;
}): ExecutionCheckpoint {
  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    ...checkpointInput
  } = input.checkpoint;
  const interrupted = input.checkpoint.continuation.scenario.startsWith('INTERRUPT_');
  const scenario = interrupted ? 'PASS' : input.checkpoint.continuation.scenario;
  const decision = input.effectApplied
    ? 'Effect ground truth is APPLIED; continue after the effect without dispatching it again.'
    : 'Effect ground truth is NOT_APPLIED or no dispatch began; return to a supervisor-authorized effect attempt.';
  return createExecutionCheckpoint({
    ...checkpointInput,
    decisions: Object.freeze([...input.checkpoint.decisions, decision]),
    continuation: {
      ...input.checkpoint.continuation,
      scenario,
      cursor: input.effectApplied ? 'AFTER_EFFECT' : 'BEFORE_EFFECT',
      nextSequence: input.effectApplied ? 8 : 6,
    },
  });
}

interface RuntimeRecoveryIntent {
  readonly sourceExecutionId: string;
  readonly sourceConnectionId: string;
  readonly correlationId: string;
  readonly preparedProjectVersion: number;
  readonly recoveryFencingToken: number;
  readonly checkpoint: ExecutionCheckpoint;
  readonly sourceAuthority: {
    readonly leaseId: string;
    readonly fencingToken: number;
  };
  readonly effectMessageIds: readonly {
    readonly effectId: string;
    readonly messageId: string;
  }[];
  readonly backendSwitchIds: readonly [string, string, string, string, string];
  readonly freshEffectIntentIds: {
    readonly toolInvocationId: string;
    readonly approvalId: string;
    readonly effectId: string;
  };
  readonly capabilityLeaseId: string;
  readonly runnerLeaseId: string;
  readonly continuedCheckpointId: string;
}

interface RemoteRecoveryResult {
  readonly effects: readonly EffectProjection[];
  readonly effectEvents: readonly RecoveryEvent[];
  readonly blockedReasons: readonly string[];
  readonly recoveredAppliedEffect: boolean;
  readonly requiresFreshEffectIntent: boolean;
  readonly continuationCheckpoint: ExecutionCheckpoint | null;
  readonly plan: BackendSwitchPlan | null;
  readonly switched: BackendSwitchResult | null;
}

function stableIdSource(ids: readonly string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (id === undefined) throw new Error('RUNTIME_RECOVERY_STABLE_ID_EXHAUSTED');
    index += 1;
    return id;
  };
}

function createFreshRecoveryEffectIntent(input: {
  readonly record: ProjectRecord;
  readonly effects: readonly EffectProjection[];
  readonly ids: RuntimeRecoveryIntent['freshEffectIntentIds'];
  readonly authorityNow: string;
  readonly systemId: string;
}): {
  readonly toolInvocationId: string;
  readonly approvals: ProjectRecord['supervision']['approvals'];
  readonly effects: ProjectRecord['supervision']['effects'];
  readonly events: readonly RecoveryEvent[];
  readonly audits: readonly RecoveryAudit[];
} {
  const previousEffect = input.effects.at(-1);
  if (previousEffect === undefined) throw new Error('RECOVERY_EFFECT_RETRY_SOURCE_MISSING');
  const previousApproval = input.record.supervision.approvals.findLast(
    ({ actionDigest }) => actionDigest === previousEffect.actionDigest,
  );
  if (previousApproval === undefined) throw new Error('RECOVERY_APPROVAL_RETRY_SOURCE_MISSING');
  const approval = Object.freeze({
    ...previousApproval,
    approvalId: input.ids.approvalId,
    state: 'REQUESTED' as const,
    expiresAt: new Date(Date.parse(input.authorityNow) + 300_000).toISOString(),
    decidedAt: null,
    decisionActorId: null,
    version: 1,
    usable: true,
  });
  const effect = Object.freeze({
    ...previousEffect,
    effectId: input.ids.effectId,
    state: 'REQUESTED' as const,
    reconciliationOutcome: null,
    groundTruthDigest: null,
    version: 1,
  });
  const events: readonly RecoveryEvent[] = Object.freeze([
    {
      kind: 'tool.requested',
      actor: {
        type: 'SPECIALIST',
        id: input.record.organization.specialist.agentId,
        lineageId: input.record.organization.specialist.lineageId,
      },
      aggregate: { type: 'TOOL_INVOCATION', id: input.ids.toolInvocationId, version: 1 },
      payload: {
        activity: 'WRITE_APPROVED_MARKER',
        status: 'WAITING_FOR_APPROVAL',
        summary: 'Recovered work requested a fresh attempt for the reconciled semantic effect',
        referenceId: input.ids.toolInvocationId,
        actionDigest: approval.actionDigest,
      },
    },
    {
      kind: 'policy.decided',
      actor: { type: 'SYSTEM', id: input.systemId },
      aggregate: { type: 'TOOL_INVOCATION', id: input.ids.toolInvocationId, version: 1 },
      payload: {
        decision: 'APPROVAL_REQUIRED',
        reasonCode: 'RECOVERY_EFFECT_NOT_APPLIED',
        summary: 'Determinate NOT_APPLIED ground truth requires fresh supervisor authorization',
      },
    },
    {
      kind: 'approval.requested',
      actor: { type: 'SYSTEM', id: input.systemId },
      aggregate: { type: 'APPROVAL', id: approval.approvalId, version: approval.version },
      payload: {
        referenceType: 'APPROVAL',
        referenceId: approval.approvalId,
        contentHash: approval.actionDigest,
        summary: 'Recovery requested authorization before a new effect attempt',
      },
    },
  ]);
  const audits: readonly RecoveryAudit[] = Object.freeze([
    {
      actorType: 'SPECIALIST',
      actorId: input.record.organization.specialist.agentId,
      action: 'tool.requested',
      targetType: 'TOOL_INVOCATION',
      targetId: input.ids.toolInvocationId,
      reason: 'Reconciled ground truth proved the prior attempt did not apply',
      outcome: 'WAITING_FOR_APPROVAL',
    },
    {
      actorType: 'SYSTEM',
      actorId: input.systemId,
      action: 'policy.decided',
      targetType: 'TOOL_INVOCATION',
      targetId: input.ids.toolInvocationId,
      reason: 'Recovery cannot reuse prior execution authority',
      outcome: 'APPROVAL_REQUIRED',
    },
    {
      actorType: 'SYSTEM',
      actorId: input.systemId,
      action: 'approval.requested',
      targetType: 'APPROVAL',
      targetId: approval.approvalId,
      reason: 'Fresh successor authority requires a new human decision',
      outcome: 'REQUESTED',
    },
  ]);
  return Object.freeze({
    toolInvocationId: input.ids.toolInvocationId,
    approvals: Object.freeze([
      ...input.record.supervision.approvals.map((candidate) =>
        Object.freeze({ ...candidate, usable: false }),
      ),
      approval,
    ]),
    effects: Object.freeze([...input.effects, effect]),
    events,
    audits,
  });
}

export class RecoveryService {
  constructor(
    private readonly dependencies: {
      readonly repository: ProjectRepository;
      readonly effectExecutor: ApprovedEffectExecutor;
      readonly nextId: () => string;
      readonly systemId: string;
      readonly backendConnections?: readonly BackendSwitchConnection[];
      readonly afterRemoteRecovery?: (input: {
        readonly projectId: string;
        readonly sourceExecutionId: string;
        readonly successorExecutionId: string | null;
      }) => Promise<void> | void;
    },
  ) {}

  async recordRuntimeHeartbeat(command: RuntimeHeartbeatInput) {
    const heartbeat = await this.dependencies.repository.recordRuntimeHeartbeat(command);
    if (!heartbeat.accepted) throw new Error('STALE_RUNTIME_FENCE');
    return heartbeat;
  }

  async recoverStaleRuntimes(input: {
    readonly heartbeatTimeoutMs: number;
    readonly correlationId: () => string;
  }): Promise<readonly string[]> {
    const authorityNow = await this.dependencies.repository.authorityNow();
    const records = await this.dependencies.repository.list();
    const recovered: string[] = [];
    for (const record of records) {
      if (
        record.view.status !== 'ACTIVE' ||
        !['STARTING', 'RUNNING', 'CHECKPOINTING'].includes(
          record.supervision.authority.executionState,
        )
      )
        continue;
      const health = evaluateRuntimeHealth({
        authorityNow,
        heartbeatTimeoutMs: input.heartbeatTimeoutMs,
        runtime: {
          executionId: record.supervision.authority.executionId,
          runtimeId: record.scheduling.runtime.runtimeId,
          leaseId: record.supervision.authority.runnerLeaseId,
          ownerId: record.scheduling.runtime.connectionId,
          fencingToken: record.supervision.authority.fencingToken,
          leaseExpiresAt: record.supervision.authority.runnerLeaseExpiresAt,
          lastHeartbeatAt: record.supervision.authority.runnerLastHeartbeatAt,
        },
      });
      if (health.state !== 'LOST') continue;
      try {
        await this.recoverLostRuntime({
          projectId: record.view.projectId,
          sourceExecutionId: record.supervision.authority.executionId,
          correlationId: input.correlationId(),
          heartbeatTimeoutMs: input.heartbeatTimeoutMs,
        });
        recovered.push(record.view.projectId);
      } catch (error) {
        if (!(error instanceof Error && error.message === 'RUNTIME_RECOVERY_NO_LONGER_REQUIRED'))
          throw error;
      }
    }
    return Object.freeze(recovered);
  }

  async blockUnrecoverableProject(command: {
    readonly projectId: string;
    readonly sourceExecutionId: string | null;
    readonly reason: string;
    readonly correlationId: string;
  }) {
    const current = await this.dependencies.repository.get(command.projectId);
    if (current === null) throw new Error('PROJECT_NOT_FOUND');
    if (current.supervision.recovery.state === 'BLOCKED_RECOVERY')
      return current.supervision.recovery;
    const idempotencyKey = command.sourceExecutionId ?? command.projectId;
    const result = await this.dependencies.repository.mutate<
      ProjectRecord['supervision']['recovery']
    >({
      scope: `startup-recovery-block:${command.projectId}`,
      idempotencyKey,
      requestHash: commandRequestHash({
        projectId: command.projectId,
        sourceExecutionId: command.sourceExecutionId,
        reason: command.reason,
      }),
      projectId: command.projectId,
      mutate: async (record, authorityNow) => {
        const sourceEvents = INTERRUPTIBLE_EXECUTION_STATES.has(
          record.supervision.authority.executionState,
        )
          ? sourceRecoveryEvents(record, this.dependencies.systemId)
          : [];
        const recovery = Object.freeze({
          state: 'BLOCKED_RECOVERY' as const,
          sourceExecutionId: command.sourceExecutionId,
          successorExecutionId: null,
          sourceConnectionId: record.scheduling.execution.connectionId,
          targetConnectionId: null,
          progress: `Startup recovery blocked: ${command.reason}`,
          updatedAt: authorityNow,
        });
        const blocked = recoveryRecord({
          record,
          checkpoint: record.supervision.checkpoint,
          effects: record.supervision.effects,
          status: 'BLOCKED',
          recovery,
          blockedReasons: [command.reason],
          events: [
            ...sourceEvents,
            blockedProjectEvent(
              record,
              this.dependencies.systemId,
              'STARTUP_RECOVERY_VALIDATION_FAILED',
              command.reason,
            ),
          ],
          correlationId: command.correlationId,
          systemId: this.dependencies.systemId,
          nextId: this.dependencies.nextId,
        });
        return { record: blocked, response: blocked.supervision.recovery };
      },
    });
    return result.response;
  }

  async recoverLostRuntime(command: {
    readonly projectId: string;
    readonly sourceExecutionId: string;
    readonly correlationId: string;
    readonly heartbeatTimeoutMs?: number;
  }) {
    const current = await this.dependencies.repository.get(command.projectId);
    if (current === null) throw new Error('PROJECT_NOT_FOUND');
    if (
      current.supervision.recovery.sourceExecutionId === command.sourceExecutionId &&
      ['RESUMED', 'BLOCKED_UNKNOWN', 'BLOCKED_RECOVERY'].includes(
        current.supervision.recovery.state,
      )
    )
      return current.supervision.recovery;
    if (current.supervision.authority.executionId !== command.sourceExecutionId)
      throw new Error('RUNTIME_RECOVERY_SUPERSEDED');
    if (current.view.status !== 'ACTIVE') throw new Error('RUNTIME_RECOVERY_NOT_ALLOWED');
    if (!INTERRUPTIBLE_EXECUTION_STATES.has(current.supervision.authority.executionState))
      throw new Error('RUNTIME_NOT_RECOVERABLE');

    const sourceExecutionId = command.sourceExecutionId;
    const prepared = await this.dependencies.repository.mutate<RuntimeRecoveryIntent>({
      scope: 'runtime-recovery-prepare:' + command.projectId,
      idempotencyKey: sourceExecutionId,
      requestHash: commandRequestHash({ projectId: command.projectId, sourceExecutionId }),
      projectId: command.projectId,
      mutate: async (record, authorityNow) => {
        if (record.supervision.authority.executionId !== sourceExecutionId)
          throw new Error('RUNTIME_RECOVERY_SUPERSEDED');
        if (command.heartbeatTimeoutMs !== undefined) {
          const health = evaluateRuntimeHealth({
            authorityNow,
            heartbeatTimeoutMs: command.heartbeatTimeoutMs,
            runtime: {
              executionId: record.supervision.authority.executionId,
              runtimeId: record.scheduling.runtime.runtimeId,
              leaseId: record.supervision.authority.runnerLeaseId,
              ownerId: record.scheduling.runtime.connectionId,
              fencingToken: record.supervision.authority.fencingToken,
              leaseExpiresAt: record.supervision.authority.runnerLeaseExpiresAt,
              lastHeartbeatAt: record.supervision.authority.runnerLastHeartbeatAt,
            },
          });
          if (health.state !== 'LOST') throw new Error('RUNTIME_RECOVERY_NO_LONGER_REQUIRED');
        }

        const priorCheckpoint = record.supervision.checkpoint;
        if (priorCheckpoint !== null) assertExecutionCheckpoint(priorCheckpoint);
        if (
          priorCheckpoint === null &&
          ['LOST', 'RECONCILING'].includes(record.supervision.authority.executionState)
        )
          throw new Error('RECOVERY_CHECKPOINT_MISSING');
        let checkpoint = checkpointFromProjectRecord({
          record,
          checkpointId: this.dependencies.nextId(),
          createdAt: authorityNow,
          reason: 'RUNTIME_LOST',
        });
        if (
          priorCheckpoint !== null &&
          priorCheckpoint.execution.executionId === sourceExecutionId &&
          priorCheckpoint.continuation.normalizedWorkHash ===
            checkpoint.continuation.normalizedWorkHash
        ) {
          checkpoint = checkpointWithDurableContinuation(checkpoint, priorCheckpoint.continuation);
        }

        const backendSwitchIds: RuntimeRecoveryIntent['backendSwitchIds'] = Object.freeze([
          this.dependencies.nextId(),
          this.dependencies.nextId(),
          this.dependencies.nextId(),
          this.dependencies.nextId(),
          this.dependencies.nextId(),
        ]);
        const intent: RuntimeRecoveryIntent = Object.freeze({
          sourceExecutionId,
          sourceConnectionId: record.scheduling.execution.connectionId,
          correlationId: command.correlationId,
          preparedProjectVersion: record.view.version + 1,
          recoveryFencingToken: record.supervision.authority.fencingToken + 1,
          checkpoint,
          sourceAuthority: Object.freeze({
            leaseId: record.supervision.authority.runnerLeaseId,
            fencingToken: record.supervision.authority.fencingToken,
          }),
          effectMessageIds: Object.freeze(
            record.supervision.effects
              .filter(({ state }) => ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state))
              .map(({ effectId }) =>
                Object.freeze({ effectId, messageId: this.dependencies.nextId() }),
              ),
          ),
          backendSwitchIds,
          freshEffectIntentIds: Object.freeze({
            toolInvocationId: this.dependencies.nextId(),
            approvalId: this.dependencies.nextId(),
            effectId: this.dependencies.nextId(),
          }),
          capabilityLeaseId: this.dependencies.nextId(),
          runnerLeaseId: this.dependencies.nextId(),
          continuedCheckpointId: this.dependencies.nextId(),
        });
        const sourceEvents = sourceRecoveryEvents(record, this.dependencies.systemId);
        const preparing = recoveryRecord({
          record,
          checkpoint,
          effects: record.supervision.effects,
          status: 'ACTIVE',
          recovery: {
            state: 'RECONCILING',
            sourceExecutionId,
            successorExecutionId: null,
            sourceConnectionId: record.scheduling.execution.connectionId,
            targetConnectionId: null,
            progress: 'Runtime loss fenced; durable effect reconciliation intent committed',
            updatedAt: authorityNow,
          },
          blockedReasons: [],
          events: [
            checkpointEvent(
              checkpoint,
              this.dependencies.systemId,
              'Runtime-loss checkpoint captured before remote effect reconciliation',
            ),
            ...sourceEvents,
          ],
          correlationId: command.correlationId,
          systemId: this.dependencies.systemId,
          nextId: this.dependencies.nextId,
        });
        return { record: preparing, response: intent };
      },
    });

    const intent = prepared.response;
    assertExecutionCheckpoint(intent.checkpoint);
    if (
      prepared.record.view.version !== intent.preparedProjectVersion ||
      prepared.record.supervision.authority.executionId !== sourceExecutionId ||
      prepared.record.supervision.authority.fencingToken !== intent.recoveryFencingToken ||
      prepared.record.supervision.authority.runnerLeaseState !== 'REVOKED' ||
      prepared.record.supervision.checkpoint?.contentHash !== intent.checkpoint.contentHash
    )
      throw new Error('RUNTIME_RECOVERY_PREPARATION_INVALID');

    const remote = await this.performRemoteRecovery(prepared.record, intent);
    await this.dependencies.afterRemoteRecovery?.({
      projectId: command.projectId,
      sourceExecutionId,
      successorExecutionId: remote.plan?.successor.executionId ?? null,
    });

    const finalRequestHash = commandRequestHash({
      checkpointHash: intent.checkpoint.contentHash,
      effects: remote.effects.map(
        ({ effectId, reconciliationOutcome, groundTruthDigest, state }) => ({
          effectId,
          groundTruthDigest,
          reconciliationOutcome,
          state,
        }),
      ),
      projectId: command.projectId,
      sourceExecutionId,
      continuationCheckpointHash: remote.continuationCheckpoint?.contentHash ?? null,
      successorExecutionId: remote.plan?.successor.executionId ?? null,
      backendOutcome: remote.switched?.result.outcome ?? 'PLANNED_BEFORE_EFFECT',
    });
    const finalized = await this.dependencies.repository.mutate<
      ProjectRecord['supervision']['recovery']
    >({
      scope: 'runtime-recovery-finalize:' + command.projectId,
      idempotencyKey: sourceExecutionId,
      requestHash: finalRequestHash,
      projectId: command.projectId,
      mutate: async (record, authorityNow) => {
        if (
          record.view.version !== intent.preparedProjectVersion ||
          record.supervision.authority.executionId !== sourceExecutionId ||
          record.supervision.authority.executionState !== 'RECONCILING' ||
          record.supervision.authority.fencingToken !== intent.recoveryFencingToken ||
          record.supervision.authority.runnerLeaseState !== 'REVOKED' ||
          record.supervision.checkpoint?.contentHash !== intent.checkpoint.contentHash
        )
          throw new Error('RUNTIME_RECOVERY_STATE_CHANGED');

        if (
          remote.blockedReasons.length > 0 ||
          remote.plan === null ||
          remote.continuationCheckpoint === null
        ) {
          const unknownEffect = remote.effects.some(({ state }) => state === 'UNKNOWN');
          const blockedReasons =
            remote.blockedReasons.length > 0
              ? remote.blockedReasons
              : ['Backend continuation did not produce an authoritative recovery plan'];
          const blocked = recoveryRecord({
            record,
            checkpoint: intent.checkpoint,
            effects: remote.effects,
            status: 'BLOCKED',
            authority: record.supervision.authority,
            recovery: {
              state: unknownEffect ? 'BLOCKED_UNKNOWN' : 'BLOCKED_RECOVERY',
              sourceExecutionId,
              successorExecutionId: null,
              sourceConnectionId: intent.sourceConnectionId,
              targetConnectionId: remote.plan?.successor.connectionId ?? null,
              progress: unknownEffect
                ? 'Recovery blocked because effect ground truth remains unknown'
                : 'Recovery blocked because backend continuation was not authoritative',
              updatedAt: authorityNow,
            },
            blockedReasons,
            events: [
              ...remote.effectEvents,
              blockedProjectEvent(
                record,
                this.dependencies.systemId,
                unknownEffect
                  ? 'RECOVERY_GROUND_TRUTH_UNKNOWN'
                  : 'RECOVERY_BACKEND_CONTINUATION_FAILED',
                unknownEffect
                  ? 'Project blocked because effect ground truth remains indeterminate'
                  : 'Project blocked because the replacement backend did not complete continuation',
              ),
            ],
            correlationId: intent.correlationId,
            systemId: this.dependencies.systemId,
            nextId: this.dependencies.nextId,
          });
          return { record: blocked, response: blocked.supervision.recovery };
        }

        const plan = remote.plan;
        const switched = remote.switched;
        const continuationCheckpoint = remote.continuationCheckpoint;
        const freshIntent = remote.requiresFreshEffectIntent
          ? createFreshRecoveryEffectIntent({
              record,
              effects: remote.effects,
              ids: intent.freshEffectIntentIds,
              authorityNow,
              systemId: this.dependencies.systemId,
            })
          : null;
        const recoveredEffects = freshIntent?.effects ?? remote.effects;
        const targetName =
          FAKE_CONNECTIONS.find(({ id }) => id === plan.successor.connectionId)?.name ??
          plan.successor.connectionId;
        const capabilityLeaseExpiresAt = new Date(Date.parse(authorityNow) + 300_000).toISOString();
        const fencingToken = intent.recoveryFencingToken;
        const successorAuthority = Object.freeze({
          ...record.supervision.authority,
          executionId: plan.successor.executionId,
          executionAttempt: record.supervision.authority.executionAttempt + 1,
          executionState: 'WAITING_FOR_APPROVAL' as const,
          capabilityLeaseId: intent.capabilityLeaseId,
          capabilityLeaseState: 'ACTIVE' as const,
          capabilityLeaseExpiresAt,
          runnerLeaseId: intent.runnerLeaseId,
          runnerLeaseState: 'ACTIVE' as const,
          runnerLeaseExpiresAt: capabilityLeaseExpiresAt,
          runnerLastHeartbeatAt: authorityNow,
          fencingToken,
          successor: true,
        });
        const scheduling = Object.freeze({
          ...record.scheduling,
          routeDecision: Object.freeze({
            routeDecisionId: plan.routeDecision.routeDecisionId,
            eligibleConnectionIds: plan.routeDecision.eligibleConnectionIds,
            selectedConnectionId: plan.routeDecision.selectedConnectionId,
            modelDescriptorId: plan.successor.modelDescriptorId,
            modelDescriptorVersion: plan.successor.modelDescriptorVersion,
            reasonCode: plan.routeDecision.reasonCode,
          }),
          execution: Object.freeze({
            ...record.scheduling.execution,
            executionId: plan.successor.executionId,
            runtimeId: plan.successor.runtimeId,
            connectionId: plan.successor.connectionId,
            modelDescriptorId: plan.successor.modelDescriptorId,
            modelDescriptorVersion: plan.successor.modelDescriptorVersion,
            state: 'WAITING_FOR_APPROVAL' as const,
          }),
          runtime: Object.freeze({
            ...record.scheduling.runtime,
            runtimeId: plan.successor.runtimeId,
            executionId: plan.successor.executionId,
            connectionId: plan.successor.connectionId,
            modelDescriptorId: plan.successor.modelDescriptorId,
            modelDescriptorVersion: plan.successor.modelDescriptorVersion,
            contextManifestId: plan.successor.contextManifestId,
            status: 'WAITING_FOR_APPROVAL' as const,
          }),
          contextManifestId: plan.successor.contextManifestId,
          contextManifest: plan.contextManifest,
          observations: Object.freeze([
            ...record.scheduling.observations,
            ...(switched?.result.events ?? []).map((observation) =>
              Object.freeze({ ...observation }),
            ),
          ]),
          queueReason: 'WAITING_FOR_APPROVAL' as const,
        });
        const shouldRecordAppliedUsage =
          remote.recoveredAppliedEffect && record.supervision.toolInvocationState !== 'APPLIED';
        const nextBudget = shouldRecordAppliedUsage
          ? Object.freeze({
              ...record.supervision.budget,
              consumedInvocations: record.supervision.budget.consumedInvocations + 1,
              consumedMonetaryMicros: record.supervision.budget.consumedMonetaryMicros + 100,
            })
          : record.supervision.budget;
        const nextToolInvocationState = freshIntent
          ? ('WAITING_FOR_APPROVAL' as const)
          : shouldRecordAppliedUsage
            ? ('APPLIED' as const)
            : record.supervision.toolInvocationState;
        const successorEvents = successorExecutionEvents(
          plan.successor.executionId,
          this.dependencies.systemId,
        );
        const retryEvents = freshIntent?.events ?? [];
        const checkpointInput = {
          source: continuationCheckpoint,
          checkpointId: intent.continuedCheckpointId,
          createdAt: authorityNow,
          projectVersion: record.view.version + 1,
          projectLastSequence:
            record.view.lastSequence +
            remote.effectEvents.length +
            retryEvents.length +
            successorEvents.length +
            1,
          budget: nextBudget,
          leases: {
            capabilityLeaseId: intent.capabilityLeaseId,
            capabilityLeaseState: 'ACTIVE' as const,
            capabilityLeaseExpiresAt,
            runnerLeaseId: intent.runnerLeaseId,
            runnerLeaseState: 'ACTIVE' as const,
            runnerLeaseExpiresAt: capabilityLeaseExpiresAt,
            runnerLastHeartbeatAt: authorityNow,
            fencingToken,
          },
          effects: recoveredEffects,
        };
        const continuedCheckpoint =
          switched === null
            ? plannedSuccessorCheckpoint({ ...checkpointInput, plan })
            : successorCheckpoint({ ...checkpointInput, switched });
        const recovered = recoveryRecord({
          record,
          checkpoint: continuedCheckpoint,
          effects: recoveredEffects,
          ...(freshIntent === null
            ? {}
            : {
                approvals: freshIntent.approvals,
                toolInvocationId: freshIntent.toolInvocationId,
                audits: freshIntent.audits,
              }),
          scheduling,
          status: 'ACTIVE',
          authority: successorAuthority,
          recovery: {
            state: 'RESUMED',
            sourceExecutionId,
            successorExecutionId: plan.successor.executionId,
            sourceConnectionId: intent.sourceConnectionId,
            targetConnectionId: plan.successor.connectionId,
            progress:
              switched === null
                ? 'Replanned on ' +
                  targetName +
                  ' before the effect; supervisor approval is required'
                : 'Resumed on ' +
                  targetName +
                  ' after checkpoint validation and effect reconciliation',
            updatedAt: authorityNow,
          },
          budget: nextBudget,
          toolInvocationState: nextToolInvocationState,
          blockedReasons: [],
          events: [
            ...remote.effectEvents,
            ...retryEvents,
            ...successorEvents,
            checkpointEvent(
              continuedCheckpoint,
              this.dependencies.systemId,
              switched === null
                ? 'Successor checkpoint captured at the fresh authorization boundary'
                : 'Successor continuation checkpoint captured after backend resume',
            ),
          ],
          correlationId: intent.correlationId,
          systemId: this.dependencies.systemId,
          nextId: this.dependencies.nextId,
        });
        return { record: recovered, response: recovered.supervision.recovery };
      },
    });
    return finalized.response;
  }

  private async performRemoteRecovery(
    record: ProjectRecord,
    intent: RuntimeRecoveryIntent,
  ): Promise<RemoteRecoveryResult> {
    const effects: EffectProjection[] = [];
    const effectEvents: RecoveryEvent[] = [];
    const blockedReasons: string[] = [];
    let recoveredAppliedEffect = record.supervision.effects.some(
      ({ state, reconciliationOutcome }) =>
        state === 'APPLIED' ||
        (state === 'RECONCILED' && reconciliationOutcome === 'GROUND_TRUTH_APPLIED'),
    );
    let recoveredNotAppliedEffect = false;
    for (const effect of record.supervision.effects) {
      if (!['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(effect.state)) {
        effects.push(effect);
        continue;
      }
      const messageId = intent.effectMessageIds.find(
        ({ effectId }) => effectId === effect.effectId,
      )?.messageId;
      if (messageId === undefined) throw new Error('RUNTIME_RECOVERY_EFFECT_INTENT_MISSING');
      const authority = {
        messageId,
        correlationId: intent.correlationId,
        effectId: effect.effectId,
        actionDigest: effect.actionDigest,
        executionId: intent.sourceExecutionId,
        leaseId: intent.sourceAuthority.leaseId,
        fencingToken: intent.sourceAuthority.fencingToken,
      };
      let fencedGroundTruth;
      try {
        fencedGroundTruth = await this.dependencies.effectExecutor.revoke({
          ...authority,
          reason: 'RUNTIME_LOST_FENCED',
        });
      } catch {
        fencedGroundTruth = Object.freeze({
          outcome: 'INDETERMINATE' as const,
          groundTruthDigest: null,
        });
      }
      const reconciled = await recoverEffectAfterCrash({
        boundary: 'AFTER_DISPATCH_BEFORE_FIXTURE_MUTATION',
        authority,
        executor: this.dependencies.effectExecutor,
        knownGroundTruth: fencedGroundTruth,
      });
      const targetState = reconciled.continuationAllowed ? 'RECONCILED' : 'UNKNOWN';
      const transitioned = effectRecoveryTransitions({
        effect,
        targetState,
        systemId: this.dependencies.systemId,
      });
      effectEvents.push(...transitioned.events);
      if (!reconciled.continuationAllowed) {
        if (reconciled.blockedReason !== null) blockedReasons.push(reconciled.blockedReason);
        effects.push(
          Object.freeze({
            ...effect,
            state: 'UNKNOWN' as const,
            reconciliationOutcome: 'RECONCILIATION_INDETERMINATE',
            groundTruthDigest: null,
            version: transitioned.version,
          }),
        );
      } else {
        const applied = reconciled.groundTruth === 'APPLIED';
        recoveredAppliedEffect ||= applied;
        recoveredNotAppliedEffect ||= !applied;
        effects.push(
          Object.freeze({
            ...effect,
            state: 'RECONCILED' as const,
            reconciliationOutcome: applied ? 'GROUND_TRUTH_APPLIED' : 'GROUND_TRUTH_NOT_APPLIED',
            groundTruthDigest: reconciled.groundTruthDigest,
            version: transitioned.version,
          }),
        );
      }
    }

    const continuationCheckpoint =
      blockedReasons.length > 0
        ? null
        : checkpointWithRecoveryDecision({
            checkpoint: intent.checkpoint,
            effectApplied: recoveredAppliedEffect,
          });
    let plan: BackendSwitchPlan | null = null;
    let switched: BackendSwitchResult | null = null;
    if (continuationCheckpoint !== null) {
      const nextStableId = stableIdSource(intent.backendSwitchIds);
      try {
        if (recoveredAppliedEffect) {
          const candidate = await switchBackendFromCheckpoint({
            checkpoint: continuationCheckpoint,
            correlationId: intent.correlationId,
            now: () => new Date(intent.checkpoint.createdAt),
            nextId: nextStableId,
            ...(this.dependencies.backendConnections === undefined
              ? {}
              : { connections: this.dependencies.backendConnections }),
          });
          if (isSuccessfulBackendContinuation(candidate.result)) {
            plan = candidate;
            switched = candidate;
          } else {
            blockedReasons.push(
              `Replacement backend continuation was not authoritative: outcome=${candidate.result.outcome}, effect=${candidate.result.effect}, artifact=${candidate.result.artifact === null ? 'missing' : 'present'}`,
            );
          }
        } else {
          plan = planBackendSwitchFromCheckpoint({
            checkpoint: continuationCheckpoint,
            nextId: nextStableId,
            ...(this.dependencies.backendConnections === undefined
              ? {}
              : { connections: this.dependencies.backendConnections }),
          });
        }
      } catch {
        plan = null;
        switched = null;
        blockedReasons.push('No authoritative compatible replacement backend is available');
      }
    }
    const requiresFreshEffectIntent =
      recoveredNotAppliedEffect &&
      !recoveredAppliedEffect &&
      !effects.some(({ state }) => state === 'REQUESTED');
    return Object.freeze({
      effects: Object.freeze(effects),
      effectEvents: Object.freeze(effectEvents),
      blockedReasons: Object.freeze(blockedReasons),
      recoveredAppliedEffect,
      requiresFreshEffectIntent,
      continuationCheckpoint,
      plan,
      switched,
    });
  }
}

function recoveryRecord(input: {
  readonly record: ProjectRecord;
  readonly checkpoint: ProjectRecord['supervision']['checkpoint'];
  readonly effects: ProjectRecord['supervision']['effects'];
  readonly approvals?: ProjectRecord['supervision']['approvals'];
  readonly scheduling?: ProjectRecord['scheduling'];
  readonly authority?: ProjectRecord['supervision']['authority'];
  readonly budget?: ProjectRecord['supervision']['budget'];
  readonly toolInvocationId?: string;
  readonly toolInvocationState?: ProjectRecord['supervision']['toolInvocationState'];
  readonly status: ProjectRecord['view']['status'];
  readonly recovery: ProjectRecord['supervision']['recovery'];
  readonly blockedReasons: readonly string[];
  readonly events: readonly RecoveryEvent[];
  readonly audits?: readonly RecoveryAudit[];
  readonly correlationId: string;
  readonly systemId: string;
  readonly nextId: () => string;
}): ProjectRecord {
  const appended = appendSupervisionMutation({
    record: input.record,
    events: input.events,
    audits: [
      {
        actorType: 'SYSTEM',
        actorId: input.systemId,
        action: 'runtime.recovered',
        targetType: 'EXECUTION',
        targetId: input.record.supervision.authority.executionId,
        reason: 'Runtime heartbeat or process authority was lost',
        outcome: input.recovery.state,
      },
      ...(input.audits ?? []),
    ],
    occurredAt: input.recovery.updatedAt,
    correlationId: input.correlationId,
    nextId: input.nextId,
  });
  const authority =
    input.authority ??
    Object.freeze({
      ...input.record.supervision.authority,
      executionState: 'RECONCILING' as const,
      capabilityLeaseState: 'REVOKED' as const,
      runnerLeaseState: 'REVOKED' as const,
      fencingToken: input.record.supervision.authority.fencingToken + 1,
    });
  const scheduling =
    input.scheduling ??
    Object.freeze({
      ...input.record.scheduling,
      execution: Object.freeze({
        ...input.record.scheduling.execution,
        state: authority.executionState,
      }),
      queueReason: null,
    });
  const successorExecutionId = scheduling.execution.executionId;
  const blocked = input.status === 'BLOCKED';
  const hadActiveRunnerEffect = input.record.supervision.effects.some(({ state }) =>
    ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state),
  );
  const hasActiveRunnerEffect = input.effects.some(({ state }) =>
    ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state),
  );
  const activeRunnerJobs =
    hadActiveRunnerEffect === hasActiveRunnerEffect
      ? input.record.view.capacity.activeRunnerJobs
      : hasActiveRunnerEffect
        ? Math.min(
            input.record.view.capacity.runnerJobLimit,
            input.record.view.capacity.activeRunnerJobs + 1,
          )
        : Math.max(0, input.record.view.capacity.activeRunnerJobs - 1);
  return Object.freeze({
    ...input.record,
    view: Object.freeze({
      ...input.record.view,
      status: input.status,
      version: input.record.view.version + 1,
      capacity: Object.freeze({
        ...input.record.view.capacity,
        activeCognitiveRuns: blocked
          ? Math.max(0, input.record.view.capacity.activeCognitiveRuns - 1)
          : input.record.view.capacity.activeCognitiveRuns,
        activeRunnerJobs,
      }),
      lastSequence: appended.events.at(-1)?.sequence ?? input.record.view.lastSequence,
      presences: Object.freeze(
        input.record.view.presences.map((presence) =>
          presence.agentId === input.record.organization.specialist.agentId
            ? Object.freeze({
                ...presence,
                state: blocked ? ('BLOCKED' as const) : ('WAITING_FOR_APPROVAL' as const),
                sourceType: 'EXECUTION' as const,
                sourceId: successorExecutionId,
                updatedAt: input.recovery.updatedAt,
                activity: input.recovery.progress,
              })
            : presence,
        ),
      ),
    }),
    scheduling,
    supervision: Object.freeze({
      ...input.record.supervision,
      authority,
      budget: input.budget ?? input.record.supervision.budget,
      toolInvocationId: input.toolInvocationId ?? input.record.supervision.toolInvocationId,
      toolInvocationState:
        input.toolInvocationState ?? input.record.supervision.toolInvocationState,
      approvals: input.approvals ?? input.record.supervision.approvals,
      checkpoint: input.checkpoint,
      recovery: Object.freeze(input.recovery),
      effects: Object.freeze(input.effects),
      blockedReasons: Object.freeze(input.blockedReasons),
      audit: appended.audit,
    }),
    events: Object.freeze([...input.record.events, ...appended.events]),
  });
}
