import { compileContext, type ContextManifest } from '@moonshift/context';
import {
  createFakeCheckpoint,
  createFakeExecutionBackend,
  FAKE_CONNECTIONS,
  FAKE_MODEL_DESCRIPTOR,
  type FakeExecutionResult,
} from '@moonshift/backend-fake';

import {
  assertExecutionCheckpoint,
  type ExecutionCheckpoint,
} from '../application/recovery/checkpoints.js';

export type BackendSwitchConnection = (typeof FAKE_CONNECTIONS)[number];

export interface BackendSwitchPlan {
  readonly source: {
    readonly executionId: string;
    readonly connectionId: string;
  };
  readonly successor: {
    readonly executionId: string;
    readonly runtimeId: string;
    readonly agentId: string;
    readonly taskId: string;
    readonly connectionId: string;
    readonly modelDescriptorId: string;
    readonly modelDescriptorVersion: number;
    readonly contextManifestId: string;
  };
  readonly routeDecision: {
    readonly routeDecisionId: string;
    readonly eligibleConnectionIds: readonly string[];
    readonly selectedConnectionId: string;
    readonly reasonCode: 'RECOVERY_COMPATIBLE_BACKEND_SELECTED';
  };
  readonly contextManifest: ContextManifest;
}

export interface BackendSwitchResult extends BackendSwitchPlan {
  readonly result: FakeExecutionResult;
}

export function planBackendSwitchFromCheckpoint(input: {
  readonly checkpoint: ExecutionCheckpoint;
  readonly nextId: () => string;
  readonly connections?: readonly BackendSwitchConnection[];
}): BackendSwitchPlan {
  assertExecutionCheckpoint(input.checkpoint);
  const checkpoint = input.checkpoint;
  if (
    checkpoint.execution.modelDescriptorId !== FAKE_MODEL_DESCRIPTOR.id ||
    checkpoint.execution.modelDescriptorVersion !== FAKE_MODEL_DESCRIPTOR.version
  )
    throw new Error('CHECKPOINT_MODEL_DESCRIPTOR_INCOMPATIBLE');
  const eligible = (input.connections ?? FAKE_CONNECTIONS).filter(
    ({ id, relation }) =>
      id !== checkpoint.execution.connectionId &&
      relation.available &&
      relation.conformance === 'CONFORMANT' &&
      relation.modelDescriptorId === checkpoint.execution.modelDescriptorId &&
      relation.modelDescriptorVersion === checkpoint.execution.modelDescriptorVersion,
  );
  const selected = eligible[0];
  if (selected === undefined) throw new Error('NO_COMPATIBLE_BACKEND_CONTINUATION');

  const executionId = input.nextId();
  const runtimeId = input.nextId();
  const contextManifestId = input.nextId();
  const routeDecisionId = input.nextId();
  const contextManifest = compileContext({
    executionId,
    taskId: checkpoint.task.taskId,
    agentId: checkpoint.specialist.agentId,
    connectionId: selected.id,
    policyVersion: checkpoint.context.compilerPolicyVersion,
    destination: 'FAKE_EXECUTION',
    tokenBudget: 2_000,
    inputs: [
      {
        sourceType: 'objective',
        sourceReference: checkpoint.project.projectId,
        content: checkpoint.project.objective,
        classification: 'PUBLIC_FIXTURE',
        inclusionReason: 'Recovered execution objective',
      },
      {
        sourceType: 'acceptance_criteria',
        sourceReference: checkpoint.task.taskId,
        content: checkpoint.task.acceptanceCriteria.join('\n'),
        classification: 'PUBLIC_FIXTURE',
        inclusionReason: 'Recovered bounded success conditions',
      },
      {
        sourceType: 'task',
        sourceReference: checkpoint.task.taskId,
        content: checkpoint.remainingWork.join('\n') || checkpoint.task.title,
        classification: 'PUBLIC_FIXTURE',
        inclusionReason: 'Normalized remaining work',
      },
      {
        sourceType: 'repository_revision',
        sourceReference: checkpoint.repository.worktreeRef,
        revision: checkpoint.repository.revision,
        content: checkpoint.repository.revision,
        classification: 'PUBLIC_FIXTURE',
        inclusionReason: 'Checkpoint-bound repository revision',
      },
      {
        sourceType: 'decision_summary',
        sourceReference: checkpoint.checkpointId,
        content:
          [...checkpoint.decisions, ...checkpoint.openQuestions].join('\n') || 'No open decision',
        classification: 'INSTANCE_INTERNAL',
        inclusionReason: 'Durable decision and open-question summary',
      },
    ],
  });
  return Object.freeze({
    source: Object.freeze({
      executionId: checkpoint.execution.executionId,
      connectionId: checkpoint.execution.connectionId,
    }),
    successor: Object.freeze({
      executionId,
      runtimeId,
      agentId: checkpoint.specialist.agentId,
      taskId: checkpoint.task.taskId,
      connectionId: selected.id,
      modelDescriptorId: checkpoint.execution.modelDescriptorId,
      modelDescriptorVersion: checkpoint.execution.modelDescriptorVersion,
      contextManifestId,
    }),
    routeDecision: Object.freeze({
      routeDecisionId,
      eligibleConnectionIds: Object.freeze(eligible.map(({ id }) => id)),
      selectedConnectionId: selected.id,
      reasonCode: 'RECOVERY_COMPATIBLE_BACKEND_SELECTED' as const,
    }),
    contextManifest,
  });
}

export function isSuccessfulBackendContinuation(result: FakeExecutionResult): boolean {
  return (
    result.outcome === 'CLAIMED_COMPLETE' && result.effect === 'APPLIED' && result.artifact !== null
  );
}

export async function switchBackendFromCheckpoint(input: {
  readonly checkpoint: ExecutionCheckpoint;
  readonly correlationId: string;
  readonly now: () => Date;
  readonly nextId: () => string;
  readonly connections?: readonly BackendSwitchConnection[];
}): Promise<BackendSwitchResult> {
  const plan = planBackendSwitchFromCheckpoint(input);
  const checkpoint = input.checkpoint;
  const backendCheckpoint = createFakeCheckpoint({
    executionId: checkpoint.execution.executionId,
    agentId: checkpoint.specialist.agentId,
    taskId: checkpoint.task.taskId,
    contextManifestId: checkpoint.execution.contextManifestId,
    scenario: checkpoint.continuation.scenario as Parameters<
      typeof createFakeCheckpoint
    >[0]['scenario'],
    seed: checkpoint.continuation.seed,
    cursor: checkpoint.continuation.cursor,
    nextSequence: checkpoint.continuation.nextSequence,
  });
  const backend = createFakeExecutionBackend(plan.successor.connectionId, { now: input.now });
  const result = await backend.resume(
    {
      schemaVersion: '1.0',
      messageId: input.nextId(),
      kind: 'backend.resume',
      connectionId: plan.successor.connectionId,
      correlationId: input.correlationId,
      sentAt: input.now().toISOString(),
      executionId: plan.successor.executionId,
      sourceExecutionId: checkpoint.execution.executionId,
      agentId: checkpoint.specialist.agentId,
      taskId: checkpoint.task.taskId,
      contextManifestId: plan.successor.contextManifestId,
      modelDescriptorId: checkpoint.execution.modelDescriptorId,
      modelDescriptorVersion: checkpoint.execution.modelDescriptorVersion,
      checkpointId: backendCheckpoint.id,
      checkpointHash: backendCheckpoint.contentHash,
    },
    backendCheckpoint,
  );
  return Object.freeze({
    ...plan,
    result,
  });
}
