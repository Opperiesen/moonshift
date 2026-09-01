import { describe, expect, it } from 'vitest';

import {
  createFakeExecutionBackend,
  FAKE_CONNECTIONS,
  FAKE_MODEL_DESCRIPTOR,
} from '../../packages/backend-fake/src/index.js';
import {
  isSuccessfulBackendContinuation,
  planBackendSwitchFromCheckpoint,
  switchBackendFromCheckpoint,
} from '../../apps/control-plane/src/scheduler/backend-switch.js';
import { recoveryCheckpoint, recoveryUuid } from './fixtures.js';

describe('provider-neutral backend continuation', () => {
  it('continues the same specialist, task, and normalized work on another compatible connection', async () => {
    let ordinal = 100;
    const checkpoint = recoveryCheckpoint();
    const switched = await switchBackendFromCheckpoint({
      checkpoint,
      correlationId: recoveryUuid(90),
      now: () => new Date('2026-09-01T08:01:00.000Z'),
      nextId: () => recoveryUuid(ordinal++),
    });

    expect(switched.source).toMatchObject({
      executionId: checkpoint.execution.executionId,
      connectionId: FAKE_CONNECTIONS[0]!.id,
    });
    expect(switched.successor).toMatchObject({
      agentId: checkpoint.specialist.agentId,
      taskId: checkpoint.task.taskId,
      connectionId: FAKE_CONNECTIONS[1]!.id,
      modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
      modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
    });
    expect(switched.successor.executionId).not.toBe(checkpoint.execution.executionId);
    expect(switched.contextManifest.connectionId).toBe(FAKE_CONNECTIONS[1]!.id);
    expect(switched.contextManifest.items.some(({ sourceType }) => sourceType === 'raw_chat')).toBe(
      false,
    );
    expect(
      switched.result.events.every(
        (observation) =>
          !observation.accepted ||
          (observation.event.executionId === switched.successor.executionId &&
            observation.event.sequence >= checkpoint.continuation.nextSequence),
      ),
    ).toBe(true);
    expect(switched.result.artifact?.contentHash).toMatch(/^sha256:/);
    expect(switched.result.checkpoint.executionId).toBe(switched.successor.executionId);
    expect(isSuccessfulBackendContinuation(switched.result)).toBe(true);

    const uninterrupted = await createFakeExecutionBackend(FAKE_CONNECTIONS[0]!.id, {
      now: () => new Date('2026-09-01T08:01:00.000Z'),
    }).start({
      schemaVersion: '1.0',
      messageId: recoveryUuid(95),
      kind: 'backend.start',
      connectionId: FAKE_CONNECTIONS[0]!.id,
      correlationId: recoveryUuid(96),
      sentAt: '2026-09-01T08:01:00.000Z',
      executionId: checkpoint.execution.executionId,
      agentId: checkpoint.specialist.agentId,
      taskId: checkpoint.task.taskId,
      modelDescriptorId: checkpoint.execution.modelDescriptorId,
      modelDescriptorVersion: checkpoint.execution.modelDescriptorVersion,
      contextManifestId: checkpoint.execution.contextManifestId,
      scenario: 'PASS',
      seed: checkpoint.continuation.seed,
      budgets: { maxInvocations: 8, maxRuntimeMs: 60_000 },
    });
    expect(switched.result).toMatchObject({
      outcome: uninterrupted.outcome,
      effect: uninterrupted.effect,
      artifact: {
        bytes: uninterrupted.artifact?.bytes,
        contentHash: uninterrupted.artifact?.contentHash,
      },
    });
  });

  it('does not treat a repeated interruption fixture as authoritative continuation', async () => {
    const checkpoint = recoveryCheckpoint({
      continuation: {
        scenario: 'INTERRUPT_DURING_EFFECT',
        seed: `${recoveryUuid(2)}:${recoveryUuid(3)}`,
        cursor: 'DURING_EFFECT',
        nextSequence: 6,
        normalizedWorkHash: `sha256:${'f'.repeat(64)}`,
      },
    });
    let planOrdinal = 300;
    const plan = planBackendSwitchFromCheckpoint({
      checkpoint,
      nextId: () => recoveryUuid(planOrdinal++),
    });
    expect(plan.successor).toMatchObject({
      taskId: checkpoint.task.taskId,
      agentId: checkpoint.specialist.agentId,
      connectionId: FAKE_CONNECTIONS[1]!.id,
    });

    let switchOrdinal = 400;
    const repeatedInterruption = await switchBackendFromCheckpoint({
      checkpoint,
      correlationId: recoveryUuid(399),
      now: () => new Date('2026-09-01T08:01:00.000Z'),
      nextId: () => recoveryUuid(switchOrdinal++),
    });
    expect(repeatedInterruption.result).toMatchObject({
      outcome: 'FAILED',
      effect: 'UNKNOWN',
      artifact: null,
    });
    expect(isSuccessfulBackendContinuation(repeatedInterruption.result)).toBe(false);
  });

  it('fails closed when no second conformant connection matches the exact model descriptor', async () => {
    await expect(
      switchBackendFromCheckpoint({
        checkpoint: recoveryCheckpoint(),
        correlationId: recoveryUuid(91),
        now: () => new Date('2026-09-01T08:01:00.000Z'),
        nextId: () => recoveryUuid(200),
        connections: [FAKE_CONNECTIONS[0]!],
      }),
    ).rejects.toThrow('NO_COMPATIBLE_BACKEND_CONTINUATION');
  });
});
