import {
  createExecutionCheckpoint,
  type ExecutionCheckpoint,
  type ExecutionCheckpointInput,
} from '../../apps/control-plane/src/application/recovery/checkpoints.js';
import { FAKE_CONNECTIONS, FAKE_MODEL_DESCRIPTOR } from '../../packages/backend-fake/src/index.js';

export const recoveryUuid = (suffix: number): string =>
  `72000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
export const recoveryHash = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}`;

export function recoveryCheckpoint(
  overrides: Partial<ExecutionCheckpointInput> = {},
): ExecutionCheckpoint {
  const taskId = recoveryUuid(3);
  const agentId = recoveryUuid(4);
  const executionId = recoveryUuid(6);
  const contextManifestId = recoveryUuid(10);
  return createExecutionCheckpoint({
    checkpointId: recoveryUuid(1),
    createdAt: '2026-09-01T08:00:00.000Z',
    reason: 'RUNTIME_LOST',
    project: {
      projectId: recoveryUuid(2),
      objective: 'Recover deterministic work',
      status: 'ACTIVE',
      version: 4,
      lastSequence: 18,
    },
    task: {
      taskId,
      title: 'Create deterministic release-note artifact',
      state: 'WAITING_FOR_APPROVAL',
      assigneeAgentId: agentId,
      expectedRevision: 'fixture-revision-001',
      acceptanceCriteria: [
        'Produce one deterministic release-note fixture artifact',
        'Retain exact connection and model descriptor provenance',
      ],
    },
    specialist: { agentId, lineageId: recoveryUuid(5), role: 'Release-note specialist' },
    execution: {
      executionId,
      runtimeId: recoveryUuid(7),
      connectionId: FAKE_CONNECTIONS[0]!.id,
      modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
      modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
      contextManifestId,
    },
    repository: {
      revision: 'fixture-revision-001',
      diffState: 'CLEAN',
      worktreeRef: 'fixture-worktree',
    },
    decisions: ['Continue the same bounded task'],
    openQuestions: [],
    toolResults: [],
    artifacts: [],
    evidence: [],
    remainingWork: ['Continue after the controlled effect boundary'],
    context: {
      manifestId: contextManifestId,
      manifestHash: recoveryHash('d'),
      compilerPolicyVersion: 'foundation-default:1',
    },
    budget: {
      invocationLimit: 4,
      consumedInvocations: 1,
      monetaryLimitMicros: 5_000,
      consumedMonetaryMicros: 1_000,
    },
    leases: {
      capabilityLeaseId: recoveryUuid(14),
      capabilityLeaseState: 'ACTIVE',
      capabilityLeaseExpiresAt: '2026-09-01T08:05:00.000Z',
      runnerLeaseId: recoveryUuid(15),
      runnerLeaseState: 'ACTIVE',
      runnerLeaseExpiresAt: '2026-09-01T08:05:00.000Z',
      runnerLastHeartbeatAt: '2026-09-01T08:00:00.000Z',
      fencingToken: 3,
    },
    effects: [],
    continuation: {
      scenario: 'PASS',
      seed: `${recoveryUuid(2)}:${taskId}`,
      cursor: 'BEFORE_EFFECT',
      nextSequence: 6,
      normalizedWorkHash: recoveryHash('f'),
    },
    ...overrides,
  });
}
