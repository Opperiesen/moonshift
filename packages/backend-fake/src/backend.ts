import { createHash } from 'node:crypto';

import {
  planningValidators,
  sanitizeBackendEvent,
  type SanitizedBackendObservation,
} from '@moonshift/contracts';

export const FAKE_BACKEND_DESCRIPTOR = Object.freeze({
  id: '20000000-0000-4000-8000-000000000001',
  family: 'FAKE',
  adapterName: 'moonshift-deterministic-fake',
  adapterVersion: '1.0.0',
  authentication: 'NONE_FIXTURE',
});

export const FAKE_MODEL_DESCRIPTOR = Object.freeze({
  id: '20000000-0000-4000-8000-000000000002',
  backendId: FAKE_BACKEND_DESCRIPTOR.id,
  version: 1,
  name: 'moonshift-foundation-fixture',
  capabilities: Object.freeze([
    'STRUCTURED_EVENTS',
    'ORDERED_STREAM',
    'CHECKPOINT',
    'RESUME',
    'CANCEL',
    'FIXTURE_TOOL_INTENT',
  ]),
});

const connection = (ordinal: 1 | 2, name: 'fake-primary' | 'fake-secondary') => {
  const id = `20000000-0000-4000-8000-${String(ordinal + 2).padStart(12, '0')}`;
  return Object.freeze({
    id,
    name,
    backendId: FAKE_BACKEND_DESCRIPTOR.id,
    relation: Object.freeze({
      id: `20000000-0000-4000-8000-${String(ordinal + 4).padStart(12, '0')}`,
      connectionId: id,
      modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
      modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
      available: true,
      conformance: 'CONFORMANT' as const,
      conformanceVersion: 1,
    }),
  });
};

export const FAKE_CONNECTIONS = Object.freeze([
  connection(1, 'fake-primary'),
  connection(2, 'fake-secondary'),
]);

export type FakeScenario =
  | 'PASS'
  | 'EVIDENCE_FAIL'
  | 'APPROVAL_REJECT'
  | 'INTERRUPT_BEFORE_EFFECT'
  | 'INTERRUPT_DURING_EFFECT'
  | 'INTERRUPT_AFTER_EFFECT';

export type FakeStartCommand = {
  readonly schemaVersion: '1.0';
  readonly messageId: string;
  readonly kind: 'backend.start';
  readonly connectionId: string;
  readonly correlationId: string;
  readonly sentAt: string;
  readonly executionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly modelDescriptorId: string;
  readonly modelDescriptorVersion: number;
  readonly contextManifestId: string;
  readonly scenario: FakeScenario;
  readonly seed: string;
  readonly budgets: { readonly maxInvocations: number; readonly maxRuntimeMs: number };
};

export type FakeResumeCommand = {
  readonly schemaVersion: '1.0';
  readonly messageId: string;
  readonly kind: 'backend.resume';
  readonly connectionId: string;
  readonly correlationId: string;
  readonly sentAt: string;
  readonly executionId: string;
  readonly modelDescriptorId: string;
  readonly modelDescriptorVersion: number;
  readonly checkpointId: string;
  readonly checkpointHash: string;
};

export type FakeCheckpoint = {
  readonly schemaVersion: '1.0';
  readonly id: string;
  readonly contentHash: `sha256:${string}`;
  readonly executionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly modelDescriptorId: string;
  readonly modelDescriptorVersion: number;
  readonly contextManifestId: string;
  readonly scenario: FakeScenario;
  readonly seed: string;
  readonly cursor: 'BEFORE_TOOL_INTENT' | 'BEFORE_EFFECT' | 'DURING_EFFECT' | 'AFTER_EFFECT';
  readonly nextSequence: number;
};

export type FakeExecutionResult = {
  readonly execution: {
    readonly executionId: string;
    readonly connectionId: string;
    readonly modelDescriptorId: string;
    readonly modelDescriptorVersion: number;
  };
  readonly outcome: 'CLAIMED_COMPLETE' | 'FAILED';
  readonly events: readonly SanitizedBackendObservation[];
  readonly checkpoint: FakeCheckpoint;
  readonly artifact: {
    readonly id: string;
    readonly bytes: string;
    readonly mediaType: 'application/json';
    readonly contentHash: `sha256:${string}`;
  } | null;
  readonly effect: 'NOT_APPLIED' | 'UNKNOWN' | 'APPLIED';
  readonly usage: {
    readonly synthetic: true;
    readonly invocations: number;
    readonly units: number;
  };
};

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function uuidFrom(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function assertDescriptor(
  connectionId: string,
  descriptorId: string,
  descriptorVersion: number,
): void {
  const registered = FAKE_CONNECTIONS.find(({ id }) => id === connectionId);
  if (
    registered === undefined ||
    registered.relation.modelDescriptorId !== descriptorId ||
    registered.relation.modelDescriptorVersion !== descriptorVersion ||
    registered.relation.conformance !== 'CONFORMANT' ||
    !registered.relation.available
  ) {
    throw new Error('Fake connection or model descriptor provenance is not conformant');
  }
}

const NEXT_SEQUENCE_BY_CURSOR = Object.freeze({
  BEFORE_TOOL_INTENT: 4,
  BEFORE_EFFECT: 6,
  DURING_EFFECT: 6,
  AFTER_EFFECT: 8,
} as const);

type CheckpointSnapshot = Omit<FakeCheckpoint, 'id' | 'contentHash'>;

function checkpointSnapshot(checkpoint: CheckpointSnapshot): string {
  return JSON.stringify({
    schemaVersion: checkpoint.schemaVersion,
    executionId: checkpoint.executionId,
    agentId: checkpoint.agentId,
    taskId: checkpoint.taskId,
    modelDescriptorId: checkpoint.modelDescriptorId,
    modelDescriptorVersion: checkpoint.modelDescriptorVersion,
    contextManifestId: checkpoint.contextManifestId,
    scenario: checkpoint.scenario,
    seed: checkpoint.seed,
    cursor: checkpoint.cursor,
    nextSequence: checkpoint.nextSequence,
  });
}

export function createFakeCheckpoint(input: {
  executionId: string;
  agentId: string;
  taskId: string;
  contextManifestId: string;
  scenario: FakeScenario;
  seed: string;
  cursor?: FakeCheckpoint['cursor'];
  nextSequence?: number;
}): FakeCheckpoint {
  const snapshot = {
    schemaVersion: '1.0',
    executionId: input.executionId,
    agentId: input.agentId,
    taskId: input.taskId,
    modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
    modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
    contextManifestId: input.contextManifestId,
    scenario: input.scenario,
    seed: input.seed,
    cursor: input.cursor ?? 'BEFORE_TOOL_INTENT',
    nextSequence:
      input.nextSequence ?? NEXT_SEQUENCE_BY_CURSOR[input.cursor ?? 'BEFORE_TOOL_INTENT'],
  } as const;
  if (snapshot.nextSequence !== NEXT_SEQUENCE_BY_CURSOR[snapshot.cursor])
    throw new Error('Invalid fake checkpoint cursor/sequence pairing');
  const contentHash = sha256(checkpointSnapshot(snapshot));
  return Object.freeze({ ...snapshot, id: uuidFrom(contentHash), contentHash });
}

function assertCheckpoint(checkpoint: FakeCheckpoint): void {
  if (
    checkpoint.schemaVersion !== '1.0' ||
    checkpoint.modelDescriptorId !== FAKE_MODEL_DESCRIPTOR.id ||
    checkpoint.modelDescriptorVersion !== FAKE_MODEL_DESCRIPTOR.version ||
    !Number.isInteger(checkpoint.nextSequence) ||
    checkpoint.nextSequence !== NEXT_SEQUENCE_BY_CURSOR[checkpoint.cursor]
  ) {
    throw new Error('Invalid or incompatible provider-neutral checkpoint');
  }
  const contentHash = sha256(checkpointSnapshot(checkpoint));
  if (checkpoint.contentHash !== contentHash || checkpoint.id !== uuidFrom(contentHash))
    throw new Error('Invalid or incompatible provider-neutral checkpoint');
}

function event(
  input: {
    executionId: string;
    connectionId: string;
    correlationId: string;
    sentAt: string;
  },
  sequence: number,
  eventType:
    'STARTED' | 'PROGRESS' | 'TOOL_INTENT' | 'CHECKPOINT' | 'ARTIFACT' | 'COMPLETED' | 'FAILED',
  observable: Readonly<Record<string, unknown>>,
  units: number,
): SanitizedBackendObservation {
  const raw = {
    schemaVersion: '1.0',
    messageId: uuidFrom(`${input.executionId}:event:${sequence}`),
    kind: 'backend.event',
    connectionId: input.connectionId,
    correlationId: input.correlationId,
    sentAt: input.sentAt,
    executionId: input.executionId,
    modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
    modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
    sequence,
    eventType,
    observable,
    usage: { synthetic: true, invocations: sequence, units },
  };
  const observation = sanitizeBackendEvent(raw);
  if (!observation.accepted)
    throw new Error(`Fake backend produced invalid ${eventType} observation`);
  return observation;
}

function resultFrom(input: {
  connectionId: string;
  executionId: string;
  correlationId: string;
  sentAt: string;
  checkpoint: FakeCheckpoint;
  resumeFrom?: FakeCheckpoint;
}): FakeExecutionResult {
  const stable = `${input.checkpoint.taskId}:${input.checkpoint.seed}:${input.checkpoint.scenario}`;
  const actionDigest = sha256(`WRITE_APPROVED_MARKER:${stable}`);
  const artifactBytes = JSON.stringify({
    schemaVersion: '1.0',
    taskId: input.checkpoint.taskId,
    scenario: input.checkpoint.scenario,
    seed: input.checkpoint.seed,
    claimedComplete:
      input.checkpoint.scenario === 'PASS' || input.checkpoint.scenario === 'EVIDENCE_FAIL',
    evidencePass: input.checkpoint.scenario === 'PASS',
  });
  const artifactHash = sha256(artifactBytes);
  const artifactId = uuidFrom(`artifact:${artifactHash}`);
  const preToolCheckpoint = createFakeCheckpoint({
    executionId: input.checkpoint.executionId,
    agentId: input.checkpoint.agentId,
    taskId: input.checkpoint.taskId,
    contextManifestId: input.checkpoint.contextManifestId,
    scenario: input.checkpoint.scenario,
    seed: input.checkpoint.seed,
  });
  const base = {
    executionId: input.executionId,
    connectionId: input.connectionId,
    correlationId: input.correlationId,
    sentAt: input.sentAt,
  };
  const events: SanitizedBackendObservation[] = [
    event(
      base,
      1,
      'STARTED',
      { status: 'RUNNING', summary: 'Deterministic fixture execution started' },
      1,
    ),
    event(
      base,
      2,
      'PROGRESS',
      { status: 'RUNNING', summary: 'Normalized fixture objective analyzed', progressPercent: 40 },
      2,
    ),
    event(
      base,
      3,
      'CHECKPOINT',
      {
        status: 'CHECKPOINTING',
        summary: 'Provider-neutral checkpoint captured',
        checkpointId: preToolCheckpoint.id,
        contentHash: preToolCheckpoint.contentHash,
      },
      3,
    ),
    event(
      base,
      4,
      'TOOL_INTENT',
      {
        status: 'WAITING_FOR_APPROVAL',
        summary: 'Controlled fixture marker requested',
        toolOperation: 'WRITE_APPROVED_MARKER',
        actionDigest,
      },
      4,
    ),
  ];
  const scenario = input.checkpoint.scenario;
  const interrupted = scenario.startsWith('INTERRUPT_');
  const rejected = scenario === 'APPROVAL_REJECT';
  const effect =
    scenario === 'PASS' || scenario === 'EVIDENCE_FAIL' || scenario === 'INTERRUPT_AFTER_EFFECT'
      ? 'APPLIED'
      : scenario === 'INTERRUPT_DURING_EFFECT'
        ? 'UNKNOWN'
        : 'NOT_APPLIED';
  const boundary =
    scenario === 'INTERRUPT_BEFORE_EFFECT' || rejected
      ? 'BEFORE_EFFECT'
      : scenario === 'INTERRUPT_DURING_EFFECT'
        ? 'DURING_EFFECT'
        : scenario === 'INTERRUPT_AFTER_EFFECT'
          ? 'AFTER_EFFECT'
          : undefined;
  if (boundary !== undefined) {
    const boundaryCheckpoint = createFakeCheckpoint({
      executionId: input.checkpoint.executionId,
      agentId: input.checkpoint.agentId,
      taskId: input.checkpoint.taskId,
      contextManifestId: input.checkpoint.contextManifestId,
      scenario,
      seed: input.checkpoint.seed,
      cursor: boundary,
      nextSequence: boundary === 'AFTER_EFFECT' ? 8 : 6,
    });
    events.push(
      event(
        base,
        5,
        'CHECKPOINT',
        {
          status: 'CHECKPOINTING',
          summary: `Durable ${boundary.toLowerCase().replace('_', ' ')} boundary captured`,
          checkpointId: boundaryCheckpoint.id,
          contentHash: boundaryCheckpoint.contentHash,
        },
        5,
      ),
    );
    if (rejected)
      events.push(
        event(
          base,
          6,
          'FAILED',
          {
            status: 'REJECTED',
            summary: 'Sensitive fixture effect rejected by policy',
            failureCategory: 'TOOL_REJECTED',
          },
          6,
        ),
      );
    else
      events.push(
        event(
          base,
          6,
          'FAILED',
          {
            status: 'INTERRUPTED',
            summary: `Fixture runtime interrupted ${boundary.toLowerCase().replace('_', ' ')}`,
            failureCategory: 'BACKEND_LOST',
          },
          6,
        ),
      );
    input = { ...input, checkpoint: boundaryCheckpoint };
  } else {
    const effectCheckpoint = createFakeCheckpoint({
      executionId: input.checkpoint.executionId,
      agentId: input.checkpoint.agentId,
      taskId: input.checkpoint.taskId,
      contextManifestId: input.checkpoint.contextManifestId,
      scenario,
      seed: input.checkpoint.seed,
      cursor: 'BEFORE_EFFECT',
      nextSequence: 6,
    });
    events.push(
      event(
        base,
        5,
        'CHECKPOINT',
        {
          status: 'CHECKPOINTING',
          summary: 'Durable effect boundary captured',
          checkpointId: effectCheckpoint.id,
          contentHash: effectCheckpoint.contentHash,
        },
        5,
      ),
    );
    events.push(
      event(
        base,
        6,
        'ARTIFACT',
        {
          status: 'RUNNING',
          summary:
            scenario === 'EVIDENCE_FAIL'
              ? 'Deterministic artifact published with failing evidence'
              : 'Deterministic artifact published',
          artifactId,
          contentHash: artifactHash,
        },
        6,
      ),
    );
    const completedCheckpoint = createFakeCheckpoint({
      executionId: input.checkpoint.executionId,
      agentId: input.checkpoint.agentId,
      taskId: input.checkpoint.taskId,
      contextManifestId: input.checkpoint.contextManifestId,
      scenario,
      seed: input.checkpoint.seed,
      cursor: 'AFTER_EFFECT',
      nextSequence: 8,
    });
    events.push(
      event(
        base,
        7,
        'CHECKPOINT',
        {
          status: 'CHECKPOINTING',
          summary: 'Durable post-effect boundary captured',
          checkpointId: completedCheckpoint.id,
          contentHash: completedCheckpoint.contentHash,
        },
        7,
      ),
    );
    events.push(
      event(
        base,
        8,
        'COMPLETED',
        {
          status: 'CLAIMED_COMPLETE',
          summary: 'Fixture execution claimed completion',
        },
        8,
      ),
    );
    input = { ...input, checkpoint: completedCheckpoint };
  }
  const finalArtifact =
    effect !== 'APPLIED'
      ? null
      : Object.freeze({
          id: artifactId,
          bytes: artifactBytes,
          mediaType: 'application/json' as const,
          contentHash: artifactHash,
        });
  const emittedEvents = input.resumeFrom
    ? events.filter((observation) =>
        observation.accepted ? observation.event.sequence >= input.resumeFrom!.nextSequence : true,
      )
    : events;
  return Object.freeze({
    execution: Object.freeze({
      executionId: input.executionId,
      connectionId: input.connectionId,
      modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
      modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
    }),
    outcome: interrupted || rejected ? 'FAILED' : 'CLAIMED_COMPLETE',
    events: Object.freeze(emittedEvents),
    checkpoint: input.checkpoint,
    artifact: finalArtifact,
    effect,
    usage: Object.freeze({
      synthetic: true,
      invocations: events.length,
      units: events.length,
    }),
  });
}

export function createFakeExecutionBackend(
  connectionId: string,
  dependencies: { readonly now: () => Date },
): {
  probe(): Readonly<Record<string, unknown>>;
  start(command: FakeStartCommand): Promise<FakeExecutionResult>;
  resume(command: FakeResumeCommand, checkpoint: FakeCheckpoint): Promise<FakeExecutionResult>;
} {
  const configured = FAKE_CONNECTIONS.find(({ id }) => id === connectionId);
  if (configured === undefined) throw new Error('Unknown fake connection');
  return {
    probe() {
      return Object.freeze({
        healthy: true,
        backendId: FAKE_BACKEND_DESCRIPTOR.id,
        connectionId: configured.id,
        adapterVersion: FAKE_BACKEND_DESCRIPTOR.adapterVersion,
        authentication: FAKE_BACKEND_DESCRIPTOR.authentication,
        relation: configured.relation,
        orderedEvents: true,
        checkpointResume: true,
        fixtureToolIntent: true,
        arbitraryShell: false,
        externalNetwork: false,
        providerCredentials: false,
      });
    },
    async start(command) {
      if (!planningValidators().executionBackend.validate(command))
        throw new Error('Invalid fake backend start contract');
      if (command.connectionId !== connectionId)
        throw new Error('Fake connection identity mismatch');
      assertDescriptor(
        command.connectionId,
        command.modelDescriptorId,
        command.modelDescriptorVersion,
      );
      const checkpoint = createFakeCheckpoint(command);
      return resultFrom({
        connectionId,
        executionId: command.executionId,
        correlationId: command.correlationId,
        sentAt: dependencies.now().toISOString(),
        checkpoint,
      });
    },
    async resume(command, checkpoint) {
      if (!planningValidators().executionBackend.validate(command))
        throw new Error('Invalid fake backend resume contract');
      if (command.connectionId !== connectionId)
        throw new Error('Fake connection identity mismatch');
      assertDescriptor(
        command.connectionId,
        command.modelDescriptorId,
        command.modelDescriptorVersion,
      );
      assertCheckpoint(checkpoint);
      if (
        command.checkpointId !== checkpoint.id ||
        command.checkpointHash !== checkpoint.contentHash ||
        command.executionId !== checkpoint.executionId ||
        checkpoint.modelDescriptorId !== command.modelDescriptorId ||
        checkpoint.modelDescriptorVersion !== command.modelDescriptorVersion
      ) {
        throw new Error('Invalid or incompatible provider-neutral checkpoint');
      }
      return resultFrom({
        connectionId,
        executionId: command.executionId,
        correlationId: command.correlationId,
        sentAt: dependencies.now().toISOString(),
        checkpoint,
        resumeFrom: checkpoint,
      });
    },
  };
}
