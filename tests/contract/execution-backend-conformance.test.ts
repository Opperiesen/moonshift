import { describe, expect, it } from 'vitest';

import { sanitizeBackendEvent } from '../../packages/contracts/src/index.js';
import {
  FAKE_BACKEND_DESCRIPTOR,
  FAKE_CONNECTIONS,
  FAKE_MODEL_DESCRIPTOR,
  type FakeScenario,
  createFakeCheckpoint,
  createFakeExecutionBackend,
} from '../../packages/backend-fake/src/index.js';

const uuid = (suffix: number): string =>
  `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const now = new Date('2026-08-30T12:00:00.000Z');

function startCommand(connectionId: string, scenario: FakeScenario = 'PASS') {
  return {
    schemaVersion: '1.0' as const,
    messageId: uuid(1),
    kind: 'backend.start' as const,
    connectionId,
    correlationId: uuid(2),
    sentAt: now.toISOString(),
    executionId: uuid(3),
    agentId: uuid(4),
    taskId: uuid(5),
    modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
    modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
    contextManifestId: uuid(6),
    scenario,
    seed: 'same-seed',
    budgets: { maxInvocations: 10, maxRuntimeMs: 60_000 },
  };
}

function semanticOutcome(
  result: Awaited<ReturnType<ReturnType<typeof createFakeExecutionBackend>['start']>>,
) {
  return {
    outcome: result.outcome,
    checkpoint: { hash: result.checkpoint.contentHash, cursor: result.checkpoint.cursor },
    artifact: {
      bytes: result.artifact?.bytes ?? null,
      mediaType: result.artifact?.mediaType ?? null,
      contentHash: result.artifact?.contentHash ?? null,
    },
    effect: result.effect,
    usage: result.usage,
    events: result.events.map(({ event }) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      observable: event.observable,
      usage: event.usage,
    })),
  };
}

describe('minimum fake execution-backend conformance', () => {
  it('keeps backend, connection, descriptor, and relation identities stable and distinct', () => {
    expect(FAKE_BACKEND_DESCRIPTOR.id).not.toBe(FAKE_MODEL_DESCRIPTOR.id);
    expect(FAKE_CONNECTIONS).toHaveLength(2);
    expect(new Set(FAKE_CONNECTIONS.map(({ id }) => id)).size).toBe(2);
    expect(new Set(FAKE_CONNECTIONS.map(({ relation }) => relation.id)).size).toBe(2);
    for (const connection of FAKE_CONNECTIONS) {
      expect(connection.backendId).toBe(FAKE_BACKEND_DESCRIPTOR.id);
      expect(connection.relation.connectionId).toBe(connection.id);
      expect(connection.relation.modelDescriptorId).toBe(FAKE_MODEL_DESCRIPTOR.id);
      expect(connection.relation.modelDescriptorVersion).toBe(FAKE_MODEL_DESCRIPTOR.version);
      expect(connection.relation.conformance).toBe('CONFORMANT');
      expect(connection.relation.available).toBe(true);
    }
  });

  it('probes health and fixture-only capabilities without provider authentication', () => {
    for (const connection of FAKE_CONNECTIONS) {
      const probe = createFakeExecutionBackend(connection.id, { now: () => now }).probe();
      expect(probe).toMatchObject({
        healthy: true,
        connectionId: connection.id,
        backendId: FAKE_BACKEND_DESCRIPTOR.id,
        adapterVersion: '1.0.0',
        authentication: 'NONE_FIXTURE',
        arbitraryShell: false,
        externalNetwork: false,
        providerCredentials: false,
      });
      expect(probe.relation).toEqual(connection.relation);
    }
  });

  it('retains exact connection and model-descriptor provenance on execution and every event', async () => {
    for (const connection of FAKE_CONNECTIONS) {
      const backend = createFakeExecutionBackend(connection.id, { now: () => now });
      const result = await backend.start(startCommand(connection.id));
      expect(result.execution).toMatchObject({
        executionId: uuid(3),
        connectionId: connection.id,
        modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
        modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
      });
      expect(result.events.length).toBeGreaterThan(0);
      for (const observation of result.events) {
        expect(observation.accepted).toBe(true);
        if (observation.accepted) {
          expect(observation.event.connectionId).toBe(connection.id);
          expect(observation.event.modelDescriptorId).toBe(FAKE_MODEL_DESCRIPTOR.id);
          expect(observation.event.modelDescriptorVersion).toBe(FAKE_MODEL_DESCRIPTOR.version);
          expect(sanitizeBackendEvent(observation.event)).toMatchObject({ accepted: true });
        }
      }
    }
  });

  it('produces identical normalized outcomes on both connections', async () => {
    const [primary, secondary] = FAKE_CONNECTIONS;
    if (primary === undefined || secondary === undefined)
      throw new Error('Two fake connections required');
    const first = await createFakeExecutionBackend(primary.id, { now: () => now }).start(
      startCommand(primary.id),
    );
    const second = await createFakeExecutionBackend(secondary.id, { now: () => now }).start(
      startCommand(secondary.id),
    );
    expect(semanticOutcome(first)).toEqual(semanticOutcome(second));
  });

  it('resumes a provider-neutral checkpoint on the other connection with exact provenance', async () => {
    const [primary, secondary] = FAKE_CONNECTIONS;
    if (primary === undefined || secondary === undefined)
      throw new Error('Two fake connections required');
    const initial = await createFakeExecutionBackend(primary.id, { now: () => now }).start(
      startCommand(primary.id),
    );
    const resumed = await createFakeExecutionBackend(secondary.id, { now: () => now }).resume(
      {
        schemaVersion: '1.0',
        messageId: uuid(20),
        kind: 'backend.resume',
        connectionId: secondary.id,
        correlationId: uuid(2),
        sentAt: now.toISOString(),
        executionId: uuid(3),
        modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
        modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
        checkpointId: initial.checkpoint.id,
        checkpointHash: initial.checkpoint.contentHash,
      },
      initial.checkpoint,
    );
    expect(resumed.execution).toMatchObject({
      connectionId: secondary.id,
      modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
      modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
    });
    expect(
      resumed.events.every((event) => !event.accepted || event.event.connectionId === secondary.id),
    ).toBe(true);
    expect(resumed.events.map((observation) => observation.event.sequence)).toEqual([8]);
    expect(resumed.artifact?.bytes).toBe(initial.artifact?.bytes);
    expect(resumed.effect).toBe(initial.effect);
  });

  it('rejects unknown descriptor provenance and corrupt checkpoints', async () => {
    const connection = FAKE_CONNECTIONS[0];
    if (connection === undefined) throw new Error('Fake connection required');
    const backend = createFakeExecutionBackend(connection.id, { now: () => now });
    await expect(
      backend.start({ ...startCommand(connection.id), modelDescriptorVersion: 2 }),
    ).rejects.toThrow('descriptor');
    const initial = await backend.start(startCommand(connection.id));
    await expect(
      backend.resume(
        {
          schemaVersion: '1.0',
          messageId: uuid(21),
          kind: 'backend.resume',
          connectionId: connection.id,
          correlationId: uuid(2),
          sentAt: now.toISOString(),
          executionId: uuid(3),
          modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
          modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
          checkpointId: initial.checkpoint.id,
          checkpointHash: `sha256:${'f'.repeat(64)}`,
        },
        initial.checkpoint,
      ),
    ).rejects.toThrow('checkpoint');
  });

  it('rejects tampering of every checkpoint snapshot field and invalid cursor pairs', async () => {
    const connection = FAKE_CONNECTIONS[0];
    if (connection === undefined) throw new Error('Fake connection required');
    const backend = createFakeExecutionBackend(connection.id, { now: () => now });
    const initial = await backend.start(startCommand(connection.id));
    const fields = [
      'schemaVersion',
      'id',
      'contentHash',
      'executionId',
      'agentId',
      'taskId',
      'modelDescriptorId',
      'modelDescriptorVersion',
      'contextManifestId',
      'scenario',
      'seed',
      'cursor',
      'nextSequence',
    ] as const;
    for (const field of fields) {
      const tampered = {
        ...initial.checkpoint,
        [field]:
          field === 'nextSequence' || field === 'modelDescriptorVersion'
            ? 5
            : field === 'cursor'
              ? 'BEFORE_EFFECT'
              : field === 'scenario'
                ? 'EVIDENCE_FAIL'
                : 'tampered',
      };
      const attempt = backend.resume(
        {
          schemaVersion: '1.0',
          messageId: uuid(30),
          kind: 'backend.resume',
          connectionId: connection.id,
          correlationId: uuid(2),
          sentAt: now.toISOString(),
          executionId: uuid(3),
          modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
          modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
          checkpointId: initial.checkpoint.id,
          checkpointHash: initial.checkpoint.contentHash,
        },
        tampered as typeof initial.checkpoint,
      );
      await expect(attempt, field).rejects.toThrow('checkpoint');
    }
    const invalidPair = createFakeCheckpoint({
      executionId: uuid(3),
      agentId: uuid(4),
      taskId: uuid(5),
      contextManifestId: uuid(6),
      scenario: 'PASS',
      seed: 'same-seed',
      cursor: 'BEFORE_EFFECT',
      nextSequence: 6,
    });
    await expect(
      backend.resume(
        {
          schemaVersion: '1.0',
          messageId: uuid(31),
          kind: 'backend.resume',
          connectionId: connection.id,
          correlationId: uuid(2),
          sentAt: now.toISOString(),
          executionId: uuid(3),
          modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
          modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
          checkpointId: invalidPair.id,
          checkpointHash: invalidPair.contentHash,
        },
        { ...invalidPair, nextSequence: 5 } as typeof invalidPair,
      ),
    ).rejects.toThrow('checkpoint');
  });

  it.each([
    ['BEFORE_TOOL_INTENT', 4, 'PASS', [4, 5, 6, 7, 8], 'APPLIED'],
    ['BEFORE_EFFECT', 6, 'PASS', [6, 7, 8], 'APPLIED'],
    ['DURING_EFFECT', 6, 'INTERRUPT_DURING_EFFECT', [6], 'UNKNOWN'],
    ['AFTER_EFFECT', 8, 'INTERRUPT_AFTER_EFFECT', [], 'APPLIED'],
  ] as const)(
    'resumes only the suffix at %s without duplicating effect work',
    async (cursor, nextSequence, scenario, sequences, effect) => {
      const [primary, secondary] = FAKE_CONNECTIONS;
      if (!primary || !secondary) throw new Error('Two fake connections required');
      const checkpoint = createFakeCheckpoint({
        executionId: uuid(3),
        agentId: uuid(4),
        taskId: uuid(5),
        contextManifestId: uuid(6),
        scenario,
        seed: 'same-seed',
        cursor,
        nextSequence,
      });
      const resumed = await createFakeExecutionBackend(secondary.id, { now: () => now }).resume(
        {
          schemaVersion: '1.0',
          messageId: uuid(40),
          kind: 'backend.resume',
          connectionId: secondary.id,
          correlationId: uuid(2),
          sentAt: now.toISOString(),
          executionId: uuid(3),
          modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
          modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
          checkpointId: checkpoint.id,
          checkpointHash: checkpoint.contentHash,
        },
        checkpoint,
      );
      expect(resumed.events.map((observation) => observation.event.sequence)).toEqual(sequences);
      expect(
        resumed.events.some((observation) => observation.event.eventType === 'TOOL_INTENT'),
      ).toBe(cursor === 'BEFORE_TOOL_INTENT');
      expect(resumed.effect).toBe(effect);
    },
  );

  it.each([
    [
      'PASS',
      [
        'STARTED',
        'PROGRESS',
        'CHECKPOINT',
        'TOOL_INTENT',
        'CHECKPOINT',
        'ARTIFACT',
        'CHECKPOINT',
        'COMPLETED',
      ],
      'CLAIMED_COMPLETE',
      'APPLIED',
    ],
    [
      'EVIDENCE_FAIL',
      [
        'STARTED',
        'PROGRESS',
        'CHECKPOINT',
        'TOOL_INTENT',
        'CHECKPOINT',
        'ARTIFACT',
        'CHECKPOINT',
        'COMPLETED',
      ],
      'CLAIMED_COMPLETE',
      'APPLIED',
    ],
    [
      'APPROVAL_REJECT',
      ['STARTED', 'PROGRESS', 'CHECKPOINT', 'TOOL_INTENT', 'CHECKPOINT', 'FAILED'],
      'FAILED',
      'NOT_APPLIED',
    ],
    [
      'INTERRUPT_BEFORE_EFFECT',
      ['STARTED', 'PROGRESS', 'CHECKPOINT', 'TOOL_INTENT', 'CHECKPOINT', 'FAILED'],
      'FAILED',
      'NOT_APPLIED',
    ],
    [
      'INTERRUPT_DURING_EFFECT',
      ['STARTED', 'PROGRESS', 'CHECKPOINT', 'TOOL_INTENT', 'CHECKPOINT', 'FAILED'],
      'FAILED',
      'UNKNOWN',
    ],
    [
      'INTERRUPT_AFTER_EFFECT',
      ['STARTED', 'PROGRESS', 'CHECKPOINT', 'TOOL_INTENT', 'CHECKPOINT', 'FAILED'],
      'FAILED',
      'APPLIED',
    ],
  ] as const)(
    'models %s as a distinct deterministic boundary',
    async (scenario, eventTypes, outcome, effect) => {
      const [primary, secondary] = FAKE_CONNECTIONS;
      if (!primary || !secondary) throw new Error('Two fake connections required');
      const first = await createFakeExecutionBackend(primary.id, { now: () => now }).start(
        startCommand(primary.id, scenario),
      );
      const second = await createFakeExecutionBackend(secondary.id, { now: () => now }).start(
        startCommand(secondary.id, scenario),
      );
      expect(first.outcome).toBe(outcome);
      expect(first.effect).toBe(effect);
      expect(first.events.map((observation) => observation.event.eventType)).toEqual(eventTypes);
      expect(first.events.every((observation) => observation.accepted)).toBe(true);
      expect(first.events.map((observation) => observation.event.sequence)).toEqual(
        eventTypes.map((_, index) => index + 1),
      );
      expect(first.artifact === null).toBe(
        scenario === 'APPROVAL_REJECT' ||
          scenario === 'INTERRUPT_BEFORE_EFFECT' ||
          scenario === 'INTERRUPT_DURING_EFFECT',
      );
      if (scenario === 'EVIDENCE_FAIL' && first.artifact) {
        expect(JSON.parse(first.artifact.bytes).evidencePass).toBe(false);
      }
      expect(semanticOutcome(first)).toEqual(semanticOutcome(second));
    },
  );
});
