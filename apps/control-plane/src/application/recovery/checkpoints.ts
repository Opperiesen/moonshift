import { createHash } from 'node:crypto';

import { planningValidators } from '@moonshift/contracts';

import type { ProjectRecord } from '../../model.js';

export type CheckpointReason =
  'PAUSE' | 'STOP' | 'RUNTIME_LOST' | 'BACKEND_SWITCH' | 'EFFECT_RECONCILIATION';

export interface CheckpointReference {
  readonly id: string;
  readonly kind: string;
  readonly contentHash: `sha256:${string}`;
}

export interface ExecutionCheckpointInput {
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly reason: CheckpointReason;
  readonly project: {
    readonly projectId: string;
    readonly objective: string;
    readonly status: string;
    readonly version: number;
    readonly lastSequence: number;
  };
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly state: string;
    readonly assigneeAgentId: string | null;
    readonly expectedRevision: string;
    readonly acceptanceCriteria: readonly string[];
  };
  readonly specialist: {
    readonly agentId: string;
    readonly lineageId: string;
    readonly role: string;
  };
  readonly execution: {
    readonly executionId: string;
    readonly runtimeId: string;
    readonly connectionId: string;
    readonly modelDescriptorId: string;
    readonly modelDescriptorVersion: number;
    readonly contextManifestId: string;
  };
  readonly repository: {
    readonly revision: string;
    readonly diffState: 'CLEAN' | 'DIRTY';
    readonly worktreeRef: string;
  };
  readonly decisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly toolResults: readonly CheckpointReference[];
  readonly artifacts: readonly CheckpointReference[];
  readonly evidence: readonly CheckpointReference[];
  readonly remainingWork: readonly string[];
  readonly context: {
    readonly manifestId: string;
    readonly manifestHash: `sha256:${string}`;
    readonly compilerPolicyVersion: string;
  };
  readonly budget: {
    readonly invocationLimit: number;
    readonly consumedInvocations: number;
    readonly monetaryLimitMicros: number;
    readonly consumedMonetaryMicros: number;
  };
  readonly leases: {
    readonly capabilityLeaseId: string;
    readonly capabilityLeaseState: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    readonly capabilityLeaseExpiresAt: string;
    readonly runnerLeaseId: string;
    readonly runnerLeaseState: 'ACTIVE' | 'REVOKED';
    readonly runnerLeaseExpiresAt: string;
    readonly runnerLastHeartbeatAt: string;
    readonly fencingToken: number;
  };
  readonly effects: readonly {
    readonly effectId: string;
    readonly actionDigest: `sha256:${string}`;
    readonly semanticKey: string;
    readonly state: string;
    readonly reconciliationOutcome: string | null;
    readonly groundTruthDigest: `sha256:${string}` | null;
  }[];
  readonly continuation: {
    readonly scenario: string;
    readonly seed: string;
    readonly cursor: 'BEFORE_TOOL_INTENT' | 'BEFORE_EFFECT' | 'DURING_EFFECT' | 'AFTER_EFFECT';
    readonly nextSequence: number;
    readonly normalizedWorkHash: `sha256:${string}`;
  };
  readonly backendSessionHint?: string;
}

export interface ExecutionCheckpoint extends ExecutionCheckpointInput {
  readonly schemaVersion: '1.0';
  readonly contentHash: `sha256:${string}`;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, candidate) =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? Object.fromEntries(
          Object.keys(candidate)
            .sort()
            .map((key) => [key, candidate[key]]),
        )
      : candidate,
  );
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot(checkpoint: ExecutionCheckpointInput | ExecutionCheckpoint) {
  const { contentHash: _contentHash, ...withoutHash } = checkpoint as ExecutionCheckpoint;
  return withoutHash;
}

export function createExecutionCheckpoint(input: ExecutionCheckpointInput): ExecutionCheckpoint {
  const base = { schemaVersion: '1.0' as const, ...input };
  const checkpoint = { ...base, contentHash: sha256(canonical(base)) };
  planningValidators().executionCheckpoint.assert(checkpoint);
  if (checkpoint.context.manifestId !== checkpoint.execution.contextManifestId)
    throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
  return freeze(checkpoint);
}

export function assertExecutionCheckpoint(value: unknown): asserts value is ExecutionCheckpoint {
  try {
    planningValidators().executionCheckpoint.assert(value);
  } catch {
    throw new Error('CHECKPOINT_CONTRACT_INVALID');
  }
  const checkpoint = value as ExecutionCheckpoint;
  if (checkpoint.context.manifestId !== checkpoint.execution.contextManifestId)
    throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
  if (checkpoint.contentHash !== sha256(canonical(snapshot(checkpoint))))
    throw new Error('CHECKPOINT_HASH_MISMATCH');
}

function continuationBoundary(record: ProjectRecord): {
  readonly cursor: ExecutionCheckpointInput['continuation']['cursor'];
  readonly nextSequence: number;
} {
  if (record.supervision.effects.some(({ state }) => state === 'APPLIED'))
    return { cursor: 'AFTER_EFFECT', nextSequence: 8 };
  if (
    record.supervision.effects.some(({ state }) =>
      ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state),
    )
  )
    return { cursor: 'DURING_EFFECT', nextSequence: 6 };
  return { cursor: 'BEFORE_EFFECT', nextSequence: 6 };
}

export function checkpointFromProjectRecord(input: {
  readonly record: ProjectRecord;
  readonly checkpointId: string;
  readonly createdAt: string;
  readonly reason: CheckpointReason;
  readonly backendSessionHint?: string;
}): ExecutionCheckpoint {
  const { record } = input;
  const task = record.view.tasks[0];
  if (task === undefined) throw new Error('CHECKPOINT_TASK_MISSING');
  const boundary = continuationBoundary(record);
  const seed = `${record.view.projectId}:${task.taskId}`;
  const normalizedWorkHash = sha256(
    canonical({
      acceptanceCriteria: record.taskDefinition.acceptanceCriteria,
      objective: record.view.objective,
      remainingTaskState: task.state,
      seed,
      taskId: task.taskId,
    }),
  );
  const contextManifest = record.scheduling.contextManifest;
  return createExecutionCheckpoint({
    checkpointId: input.checkpointId,
    createdAt: input.createdAt,
    reason: input.reason,
    project: {
      projectId: record.view.projectId,
      objective: record.view.objective,
      status: record.view.status,
      version: record.view.version,
      lastSequence: record.view.lastSequence,
    },
    task: {
      ...task,
      acceptanceCriteria: record.taskDefinition.acceptanceCriteria,
    },
    specialist: {
      agentId: record.organization.specialist.agentId,
      lineageId: record.organization.specialist.lineageId,
      role: record.organization.specialist.role,
    },
    execution: {
      executionId: record.supervision.authority.executionId,
      runtimeId: record.scheduling.runtime.runtimeId,
      connectionId: record.scheduling.runtime.connectionId,
      modelDescriptorId: record.scheduling.runtime.modelDescriptorId,
      modelDescriptorVersion: record.scheduling.runtime.modelDescriptorVersion,
      contextManifestId: record.scheduling.contextManifestId,
    },
    repository: {
      revision: task.expectedRevision,
      diffState: 'CLEAN',
      worktreeRef: 'fixture-worktree',
    },
    decisions: record.supervision.audit.slice(-10).map(({ reason }) => reason),
    openQuestions: record.supervision.blockedReasons,
    toolResults: record.supervision.effects
      .filter(({ state }) => ['APPLIED', 'RECONCILED'].includes(state))
      .map((effect) => ({
        id: effect.effectId,
        kind: 'EXTERNAL_EFFECT',
        contentHash: effect.groundTruthDigest ?? effect.actionDigest,
      })),
    artifacts: record.verification.artifacts.map((artifact) => ({
      id: artifact.artifactId,
      kind: artifact.kind,
      contentHash: artifact.contentHash,
    })),
    evidence: record.verification.evidence.map((evidence) => ({
      id: evidence.evidenceId,
      kind: evidence.type,
      contentHash: evidence.sourceHash,
    })),
    remainingWork: ['VERIFIED', 'CANCELLED', 'FAILED'].includes(task.state)
      ? []
      : ['Reconcile external-effect ground truth and continue the bounded fixture task'],
    context: {
      manifestId: record.scheduling.contextManifestId,
      manifestHash: contextManifest.manifestHash,
      compilerPolicyVersion: contextManifest.compilerPolicyVersion,
    },
    budget: record.supervision.budget,
    leases: {
      capabilityLeaseId: record.supervision.authority.capabilityLeaseId,
      capabilityLeaseState: record.supervision.authority.capabilityLeaseState,
      capabilityLeaseExpiresAt: record.supervision.authority.capabilityLeaseExpiresAt,
      runnerLeaseId: record.supervision.authority.runnerLeaseId,
      runnerLeaseState: record.supervision.authority.runnerLeaseState,
      runnerLeaseExpiresAt: record.supervision.authority.runnerLeaseExpiresAt,
      runnerLastHeartbeatAt: record.supervision.authority.runnerLastHeartbeatAt,
      fencingToken: record.supervision.authority.fencingToken,
    },
    effects: record.supervision.effects.map(
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
      scenario: record.fixtureScenario,
      seed,
      ...boundary,
      normalizedWorkHash,
    },
    ...(input.backendSessionHint === undefined
      ? {}
      : { backendSessionHint: input.backendSessionHint }),
  });
}
