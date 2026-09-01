import { describe, expect, it } from 'vitest';

import { createPlanningValidators } from '../../packages/contracts/src/index.js';
import {
  assertExecutionCheckpoint,
  createExecutionCheckpoint,
  type ExecutionCheckpointInput,
} from '../../apps/control-plane/src/application/recovery/checkpoints.js';

const uuid = (suffix: number): string =>
  `71000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function fixture(): ExecutionCheckpointInput {
  return {
    checkpointId: uuid(1),
    createdAt: '2026-09-01T08:00:00.000Z',
    reason: 'RUNTIME_LOST',
    project: {
      projectId: uuid(2),
      objective: 'Recover deterministic work',
      status: 'ACTIVE',
      version: 4,
      lastSequence: 18,
    },
    task: {
      taskId: uuid(3),
      title: 'Create deterministic release-note artifact',
      state: 'WAITING_FOR_APPROVAL',
      assigneeAgentId: uuid(4),
      expectedRevision: 'fixture-revision-001',
      acceptanceCriteria: [
        'Produce one deterministic release-note fixture artifact',
        'Retain exact connection and model descriptor provenance',
      ],
    },
    specialist: { agentId: uuid(4), lineageId: uuid(5), role: 'Release-note specialist' },
    execution: {
      executionId: uuid(6),
      runtimeId: uuid(7),
      connectionId: uuid(8),
      modelDescriptorId: uuid(9),
      modelDescriptorVersion: 1,
      contextManifestId: uuid(10),
    },
    repository: {
      revision: 'fixture-revision-001',
      diffState: 'CLEAN',
      worktreeRef: 'fixture-worktree',
    },
    decisions: ['Continue the same bounded task'],
    openQuestions: [],
    toolResults: [{ id: uuid(11), kind: 'FIXTURE_TOOL_RESULT', contentHash: hash('a') }],
    artifacts: [{ id: uuid(12), kind: 'release-note.json', contentHash: hash('b') }],
    evidence: [{ id: uuid(13), kind: 'fixture-integrity', contentHash: hash('c') }],
    remainingWork: ['Reconcile the outstanding effect before continuation'],
    context: {
      manifestId: uuid(10),
      manifestHash: hash('d'),
      compilerPolicyVersion: 'foundation-default:1',
    },
    budget: {
      invocationLimit: 4,
      consumedInvocations: 1,
      monetaryLimitMicros: 5_000,
      consumedMonetaryMicros: 1_000,
    },
    leases: {
      capabilityLeaseId: uuid(14),
      capabilityLeaseState: 'ACTIVE',
      capabilityLeaseExpiresAt: '2026-09-01T08:05:00.000Z',
      runnerLeaseId: uuid(15),
      runnerLeaseState: 'ACTIVE',
      runnerLeaseExpiresAt: '2026-09-01T08:05:00.000Z',
      runnerLastHeartbeatAt: '2026-09-01T08:00:00.000Z',
      fencingToken: 3,
    },
    effects: [
      {
        effectId: uuid(16),
        actionDigest: hash('e'),
        semanticKey: 'fixture-effect',
        state: 'UNKNOWN',
        reconciliationOutcome: null,
        groundTruthDigest: null,
      },
    ],
    continuation: {
      scenario: 'INTERRUPT_DURING_EFFECT',
      seed: 'project:task',
      cursor: 'DURING_EFFECT',
      nextSequence: 6,
      normalizedWorkHash: hash('f'),
    },
  };
}

describe('provider-neutral execution checkpoint contract', () => {
  it('captures all durable continuation inputs and validates its content hash', () => {
    const checkpoint = createExecutionCheckpoint(fixture());

    expect(createPlanningValidators().executionCheckpoint.validate(checkpoint)).toBe(true);
    expect(() => assertExecutionCheckpoint(checkpoint)).not.toThrow();
    expect(checkpoint.task.acceptanceCriteria).toHaveLength(2);
    expect(checkpoint.context.manifestId).toBe(checkpoint.execution.contextManifestId);
    expect(checkpoint.backendSessionHint).toBeUndefined();
  });

  it('accepts an optional backend session hint without making it continuation authority', () => {
    const checkpoint = createExecutionCheckpoint({ ...fixture(), backendSessionHint: 'opaque-42' });

    expect(() => assertExecutionCheckpoint(checkpoint)).not.toThrow();
    expect(checkpoint.backendSessionHint).toBe('opaque-42');
    expect(checkpoint.continuation.normalizedWorkHash).toMatch(/^sha256:/);
  });

  it('rejects corrupt hashes, incompatible versions, missing state, and provider history', () => {
    const checkpoint = createExecutionCheckpoint(fixture());
    expect(() => assertExecutionCheckpoint({ ...checkpoint, contentHash: hash('0') })).toThrow(
      'CHECKPOINT_HASH_MISMATCH',
    );
    expect(
      createPlanningValidators().executionCheckpoint.validate({
        ...checkpoint,
        schemaVersion: '2.0',
      }),
    ).toBe(false);
    const { remainingWork: _remainingWork, ...missingState } = checkpoint;
    expect(createPlanningValidators().executionCheckpoint.validate(missingState)).toBe(false);
    expect(
      createPlanningValidators().executionCheckpoint.validate({
        ...checkpoint,
        rawProviderConversation: ['private reasoning'],
      }),
    ).toBe(false);
  });
});
