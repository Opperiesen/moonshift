import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  EXECUTION_STATES,
  PERSONA_IDENTITY_STATES,
  PRESENCE_SOURCE_TYPES,
  PRESENCE_STATES,
  PROJECT_STATES,
  SPECIALIST_IDENTITY_STATES,
  TASK_STATES,
  createPlanningValidators,
  isRfc3339DateTime,
  isUri,
  isUriReference,
  sanitizeBackendEvent,
} from '../../packages/contracts/src/index.js';

const repositoryRoot = process.cwd();
const contractRoot = resolve(repositoryRoot, 'specs/001-supervised-autonomous-loop/contracts');
const vendorRoot = resolve(repositoryRoot, 'config/validation/vendor');
const uuid = (suffix: number): string =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const now = '2026-01-01T00:00:00.000Z';
const hash = `sha256:${'a'.repeat(64)}`;

function readJson(path: string): AnySchemaObject {
  return JSON.parse(readFileSync(path, 'utf8')) as AnySchemaObject;
}

const eventEnvelopeSchema = readJson(resolve(contractRoot, 'event-envelope.schema.json'));
const executionCheckpointSchema = readJson(
  resolve(contractRoot, 'execution-checkpoint.schema.json'),
);
const executionBackendSchema = readJson(resolve(contractRoot, 'execution-backend.schema.json'));
const runnerProtocolSchema = readJson(resolve(contractRoot, 'runner-protocol.schema.json'));
const openapi = YAML.parse(
  readFileSync(resolve(contractRoot, 'http-api.openapi.yaml'), 'utf8'),
) as {
  components: { schemas: Record<string, AnySchemaObject> };
  paths: Record<
    string,
    {
      get?: { responses: Record<string, unknown> };
      post?: { responses: Record<string, unknown> };
    }
  >;
};

function ajv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
    strict: false,
    formats: {
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'date-time': isRfc3339DateTime,
      'uri-reference': isUriReference,
      uri: isUri,
    },
  });
}

function compileOpenApiComponent(name: string): ReturnType<Ajv2020['compile']> {
  const instance = ajv();
  instance.addSchema(openapi as AnySchemaObject, 'moonshift-openapi');
  return instance.compile({ $ref: `moonshift-openapi#/components/schemas/${name}` });
}

function backendStart(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    messageId: uuid(1),
    kind: 'backend.start',
    connectionId: uuid(2),
    correlationId: uuid(3),
    sentAt: now,
    executionId: uuid(4),
    agentId: uuid(5),
    taskId: uuid(6),
    modelDescriptorId: uuid(7),
    modelDescriptorVersion: 1,
    contextManifestId: uuid(8),
    scenario: 'PASS',
    seed: 'foundation-seed',
    budgets: { maxInvocations: 10, maxRuntimeMs: 60_000 },
  };
}

function backendEvent(
  observable: Record<string, unknown> = {
    status: 'RUNNING',
    summary: 'Fixture progress',
    progressPercent: 50,
  },
): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    messageId: uuid(11),
    kind: 'backend.event',
    connectionId: uuid(2),
    correlationId: uuid(3),
    sentAt: now,
    executionId: uuid(4),
    modelDescriptorId: uuid(7),
    modelDescriptorVersion: 1,
    sequence: 1,
    eventType: 'PROGRESS',
    observable,
    usage: { synthetic: true, invocations: 1, units: 20 },
  };
}

const resourceCapacity = {
  fixtureOperations: true,
  arbitraryShell: false,
  maxJobs: 1,
  memoryBytes: 268_435_456,
  cpuUnits: 1,
  processLimit: 8,
  diskBytes: 16_777_216,
  maxRuntimeMs: 60_000,
  networkMode: 'DENY',
  gpuUnits: 0,
  enforcement: {
    cpu: true,
    memory: true,
    process: true,
    disk: true,
    time: true,
    network: true,
    gpu: true,
  },
};
const resourceRequest = {
  memoryBytes: 134_217_728,
  cpuUnits: 1,
  processLimit: 4,
  diskBytes: 8_388_608,
  maxRuntimeMs: 30_000,
  networkMode: 'DENY',
  gpuUnits: 0,
};
const runtimeDiscovery = {
  cgroupVersion: 'NONE',
  subordinateUidRange: false,
  subordinateGidRange: false,
  rootlessRuntime: 'UNAVAILABLE',
  rootlessNetwork: 'UNAVAILABLE',
  storageDriver: 'UNAVAILABLE',
  filesystemType: 'APFS',
  supportsRootlessOci: false,
};
const runnerBase = {
  schemaVersion: '1.0',
  instanceId: uuid(30),
  runnerId: uuid(31),
  correlationId: uuid(32),
  sentAt: now,
};

describe('planning contract source validity', () => {
  it.each([
    ['event envelope', eventEnvelopeSchema],
    ['execution checkpoint', executionCheckpointSchema],
    ['execution backend', executionBackendSchema],
    ['runner protocol', runnerProtocolSchema],
  ])(
    'validates the %s schema against Draft 2020-12 and resolves all references',
    (_name, schema) => {
      const instance = ajv();
      expect(instance.validateSchema(schema), JSON.stringify(instance.errors)).toBe(true);
      expect(() => instance.compile(schema)).not.toThrow();
    },
  );

  it('validates the complete OpenAPI document against the vendored official OpenAPI 3.1 schema', () => {
    expect(() =>
      execFileSync(
        resolve(repositoryRoot, 'node_modules/.bin/jsonschema'),
        [
          'validate',
          resolve(vendorRoot, 'openapi-3.1-schema-2025-11-23.json'),
          resolve(contractRoot, 'http-api.openapi.yaml'),
        ],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });

  it('compiles every declared Draft 2020-12 OpenAPI Schema Object and resolves its local references', () => {
    const instance = ajv();
    instance.addSchema(openapi as AnySchemaObject, 'moonshift-openapi');
    const pointers: string[] = Object.keys(openapi.components.schemas).map(
      (name) => `/components/schemas/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    );
    const visit = (value: unknown, pointer: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${pointer}/${index}`));
      } else if (value !== null && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          const child = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
          if (key === 'schema' && nested !== null && typeof nested === 'object')
            pointers.push(child);
          visit(nested, child);
        }
      }
    };
    visit(openapi, '');
    for (const pointer of new Set(pointers)) {
      expect(
        () => instance.compile({ $ref: `moonshift-openapi#${pointer}` }),
        pointer,
      ).not.toThrow();
    }
  });

  it('keeps Project, Task, Execution, and Presence enums exactly aligned with approved contracts', () => {
    expect(openapi.components.schemas.ProjectState?.enum).toEqual(PROJECT_STATES);
    expect(openapi.components.schemas.TaskState?.enum).toEqual(TASK_STATES);
    expect(openapi.components.schemas.ExecutionState?.enum).toEqual(EXECUTION_STATES);
    expect(openapi.components.schemas.PresenceState?.enum).toEqual(PRESENCE_STATES);
  });

  it('documents every runtime supervision response status', () => {
    const responseStatuses = (path: string, method: 'get' | 'post') =>
      Object.keys(openapi.paths[path]?.[method]?.responses ?? {}).sort();
    for (const command of ['pause', 'resume', 'stop', 'cancel']) {
      expect(responseStatuses(`/v1/projects/{projectId}/commands/${command}`, 'post')).toEqual([
        '202',
        '400',
        '401',
        '404',
        '409',
        '412',
      ]);
    }
    expect(responseStatuses('/v1/projects/{projectId}/approvals', 'get')).toEqual([
      '200',
      '400',
      '401',
      '404',
    ]);
    expect(responseStatuses('/v1/projects/{projectId}/approvals/{approvalId}', 'get')).toEqual([
      '200',
      '401',
      '404',
    ]);
    expect(
      responseStatuses('/v1/projects/{projectId}/approvals/{approvalId}/decision', 'post'),
    ).toEqual(['200', '400', '401', '403', '404', '409', '412', '422']);
  });
});

describe('contract examples and lifecycle satisfiability', () => {
  it('round-trips every PersonaIdentity and SpecialistIdentity lifecycle state', () => {
    const validate = compileOpenApiComponent('AgentSummary');
    for (const [kind, states] of [
      ['PERSONA', PERSONA_IDENTITY_STATES],
      ['SPECIALIST', SPECIALIST_IDENTITY_STATES],
    ] as const) {
      for (const status of states) {
        const identity = JSON.parse(
          JSON.stringify({
            agentId: uuid(40),
            kind,
            role: kind === 'PERSONA' ? 'ENGINEERING' : 'IMPLEMENTER',
            status,
            lineageId: uuid(41),
          }),
        );
        expect(validate(identity), `${kind}:${status} ${JSON.stringify(validate.errors)}`).toBe(
          true,
        );
      }
    }
  });

  it('accepts every bounded PresenceView source and rejects unbounded/unknown sources', () => {
    const validate = compileOpenApiComponent('PresenceView');
    for (const sourceType of PRESENCE_SOURCE_TYPES) {
      expect(
        validate({
          agentId: uuid(40),
          state: 'QUEUED',
          sourceType,
          sourceId: uuid(42),
          updatedAt: now,
          activity: 'Waiting for bounded capacity',
        }),
        `${sourceType} ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
    expect(
      validate({
        agentId: uuid(40),
        state: 'QUEUED',
        sourceType: 'SOCKET',
        sourceId: uuid(42),
        updatedAt: now,
        activity: 'x',
      }),
    ).toBe(false);
    expect(
      validate({
        agentId: uuid(40),
        state: 'QUEUED',
        sourceType: 'CAPACITY',
        sourceId: uuid(42),
        updatedAt: now,
        activity: 'x'.repeat(241),
      }),
    ).toBe(false);
  });

  it('validates a satisfiable example for every execution-backend message lifecycle', () => {
    const validate = ajv().compile(executionBackendSchema);
    const start = backendStart();
    const examples = [
      {
        schemaVersion: '1.0',
        messageId: uuid(9),
        kind: 'backend.probe',
        connectionId: uuid(2),
        correlationId: uuid(3),
        sentAt: now,
      },
      start,
      {
        schemaVersion: '1.0',
        messageId: uuid(10),
        kind: 'backend.cancel',
        connectionId: uuid(2),
        correlationId: uuid(3),
        sentAt: now,
        executionId: uuid(4),
        reason: 'Supervisor stop',
      },
      {
        schemaVersion: '1.0',
        messageId: uuid(12),
        kind: 'backend.resume',
        connectionId: uuid(2),
        correlationId: uuid(3),
        sentAt: now,
        executionId: uuid(4),
        modelDescriptorId: uuid(7),
        modelDescriptorVersion: 1,
        checkpointId: uuid(13),
        checkpointHash: hash,
      },
      backendEvent(),
      {
        ...backendEvent({
          status: 'WAITING_FOR_APPROVAL',
          summary: 'Approval requested',
          toolOperation: 'WRITE_APPROVED_MARKER',
          actionDigest: hash,
        }),
        eventType: 'TOOL_INTENT',
      },
      {
        ...backendEvent({
          status: 'CHECKPOINTING',
          summary: 'Checkpoint emitted',
          checkpointId: uuid(13),
          contentHash: hash,
        }),
        eventType: 'CHECKPOINT',
      },
      {
        ...backendEvent({
          status: 'ARTIFACT',
          summary: 'Artifact emitted',
          artifactId: uuid(14),
          contentHash: hash,
        }),
        eventType: 'ARTIFACT',
      },
      {
        ...backendEvent({
          status: 'FAILED',
          summary: 'Backend lost',
          failureCategory: 'BACKEND_LOST',
        }),
        eventType: 'FAILED',
      },
    ];
    for (const example of examples)
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    for (const key of ['modelDescriptorId', 'modelDescriptorVersion'] as const) {
      const missing = { ...start };
      delete missing[key];
      expect(validate(missing), `missing ${key}`).toBe(false);
    }
  });

  it('validates a satisfiable example for every runner-protocol lifecycle message', () => {
    const validate = ajv().compile(runnerProtocolSchema);
    const examples = [
      {
        ...runnerBase,
        messageId: uuid(33),
        kind: 'runner.register',
        runnerVersion: '0.0.0',
        certificateSerial: 'A1',
        profile: 'FIXTURE_PROCESS',
        capabilities: resourceCapacity,
        runtimeDiscovery,
      },
      { ...runnerBase, messageId: uuid(34), kind: 'runner.heartbeat', activeLeaseIds: [uuid(35)] },
      {
        ...runnerBase,
        messageId: uuid(36),
        kind: 'runner.lease_offer',
        leaseId: uuid(35),
        executionId: uuid(4),
        fencingToken: 2,
        effectId: uuid(38),
        actionDigest: hash,
        authorizedAt: '2026-01-01T00:00:00.000Z',
        approvalExpiresAt: '2026-01-01T00:01:00.000Z',
        expiresAt: '2026-01-01T00:01:00.000Z',
        resources: resourceRequest,
      },
      {
        ...runnerBase,
        messageId: uuid(37),
        kind: 'runner.run_fixture',
        leaseId: uuid(35),
        executionId: uuid(4),
        fencingToken: 2,
        operation: 'WRITE_APPROVED_MARKER',
        effectId: uuid(38),
        actionDigest: hash,
      },
      {
        ...runnerBase,
        messageId: uuid(39),
        kind: 'runner.cancel',
        leaseId: uuid(35),
        executionId: uuid(4),
        fencingToken: 2,
        reason: 'Supervisor cancellation',
      },
      {
        ...runnerBase,
        messageId: uuid(43),
        kind: 'runner.reconcile',
        leaseId: uuid(35),
        executionId: uuid(4),
        fencingToken: 2,
        effectId: uuid(38),
        actionDigest: hash,
      },
      {
        ...runnerBase,
        messageId: uuid(44),
        kind: 'runner.result',
        operationMessageId: uuid(37),
        leaseId: uuid(35),
        executionId: uuid(4),
        fencingToken: 2,
        outcome: 'APPLIED',
        groundTruthDigest: hash,
      },
    ];
    for (const example of examples)
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    for (const example of examples) {
      if (!('fencingToken' in example)) continue;
      expect(validate({ ...example, fencingToken: Number.MAX_SAFE_INTEGER })).toBe(true);
      expect(validate({ ...example, fencingToken: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    }
  });

  it('validates a durable event envelope example', () => {
    const validate = ajv().compile(eventEnvelopeSchema);
    const example = {
      schemaVersion: '1.0',
      eventId: uuid(50),
      projectId: uuid(51),
      sequence: 1,
      kind: 'task.state_changed',
      occurredAt: now,
      actor: { type: 'SYSTEM', id: uuid(52) },
      aggregate: { type: 'TASK', id: uuid(53), version: 2 },
      correlationId: uuid(54),
      classification: 'INSTANCE_INTERNAL',
      payload: {
        fromState: 'READY',
        toState: 'QUEUED',
        reasonCode: 'SCHEDULED',
        summary: 'Task queued',
      },
    };
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('owned validators and strict backend projection sanitizer', () => {
  it('compiles all owned schema validators once', () => {
    const validators = createPlanningValidators();
    expect(validators.eventEnvelope.schema.$id).toBe(eventEnvelopeSchema.$id);
    expect(validators.executionBackend.schema.$id).toBe(executionBackendSchema.$id);
    expect(validators.runnerProtocol.schema.$id).toBe(runnerProtocolSchema.$id);
  });

  it('rejects malformed calendar timestamps and URI encodings instead of disabling formats', () => {
    const validators = createPlanningValidators();
    for (const sentAt of [
      'not-a-date',
      '2026-02-30T00:00:00.000Z',
      '2026-01-01 00:00:00Z',
      '2026-01-01T24:00:00Z',
    ]) {
      expect(validators.executionBackend.validate({ ...backendStart(), sentAt }), sentAt).toBe(
        false,
      );
    }
    expect(isRfc3339DateTime('2024-02-29T23:59:59.123+02:00')).toBe(true);
    expect(isRfc3339DateTime('2023-02-29T23:59:59Z')).toBe(false);
    expect(isUri('https://moonshift.invalid/path')).toBe(true);
    expect(isUri('/relative/path')).toBe(false);
    expect(isUriReference('/relative/path')).toBe(true);
    expect(isUriReference('/bad%encoding')).toBe(false);
  });

  it('constructs a new allowlisted projection for a valid backend event', () => {
    const raw = backendEvent();
    const sanitized = sanitizeBackendEvent(raw);
    expect(sanitized.accepted).toBe(true);
    if (sanitized.accepted) {
      expect(sanitized.event).not.toBe(raw);
      expect(sanitized.event.observable).not.toBe(raw.observable);
      expect(Object.keys(sanitized.event.observable)).toEqual([
        'status',
        'summary',
        'progressPercent',
      ]);
      expect(sanitized.classification).toBe('INTERNAL');
    }
  });

  it.each([
    ['unknown top-level field', { ...backendEvent(), debug: 'raw' }],
    [
      'unknown nested field',
      {
        ...backendEvent(),
        observable: { status: 'RUNNING', summary: 'safe', nested: { prompt: 'hidden' } },
      },
    ],
    [
      'private reasoning',
      {
        ...backendEvent(),
        observable: { status: 'RUNNING', summary: 'safe', reasoning: 'private' },
      },
    ],
    [
      'credential-shaped value',
      backendEvent({ status: 'RUNNING', summary: 'Bearer abcdefghijklmnopqrstuvwxyz' }),
    ],
    [
      'authorization header',
      {
        ...backendEvent(),
        observable: { status: 'RUNNING', summary: 'safe', authorization: 'redacted' },
      },
    ],
    [
      'private key material',
      backendEvent({ status: 'RUNNING', summary: ['-----BEGIN', 'PRIVATE KEY-----'].join(' ') }),
    ],
    [
      'raw transcript',
      {
        ...backendEvent(),
        observable: { status: 'RUNNING', summary: 'safe', transcript: ['raw'] },
      },
    ],
    ['absolute path', backendEvent({ status: 'RUNNING', summary: '/Users/example/private' })],
    [
      'embedded POSIX path',
      backendEvent({ status: 'RUNNING', summary: 'failure at /host-sensitive-path' }),
    ],
    [
      'embedded Windows path',
      backendEvent({ status: 'RUNNING', summary: String.raw`failure at C:\host\sensitive.txt` }),
    ],
    [
      'unrecognized secret value',
      backendEvent({ status: 'RUNNING', summary: 'credential hunter2-fixture-secret' }),
    ],
    [
      'multi-line transcript text',
      backendEvent({ status: 'RUNNING', summary: 'transcript line one\ntranscript line two' }),
    ],
    ['traversal path', backendEvent({ status: 'RUNNING', summary: '../../private' })],
    ['control character', backendEvent({ status: 'RUNNING', summary: 'unsafe\u0001text' })],
    [
      'wrong kind fields',
      {
        ...backendEvent({
          status: 'RUNNING',
          summary: 'safe',
          checkpointId: uuid(13),
          contentHash: hash,
        }),
        eventType: 'PROGRESS',
      },
    ],
  ])('rejects %s without retaining raw content', (_case, raw) => {
    const sanitized = sanitizeBackendEvent(raw);
    const rawObservable = (raw as Record<string, unknown>).observable;
    const rawSummary =
      rawObservable !== null &&
      typeof rawObservable === 'object' &&
      typeof (rawObservable as Record<string, unknown>).summary === 'string'
        ? ((rawObservable as Record<string, unknown>).summary as string)
        : undefined;
    expect(sanitized.accepted).toBe(false);
    if (!sanitized.accepted) {
      expect(sanitized).toEqual({
        accepted: false,
        sourceMessageId: uuid(11),
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        classification: 'INTERNAL',
        reasonCode: expect.stringMatching(/^BACKEND_OBSERVATION_/),
        notice: 'Backend observation rejected by projection policy',
      });
      expect(JSON.stringify(sanitized)).not.toContain('private');
      expect(JSON.stringify(sanitized)).not.toContain('Bearer');
      if (rawSummary !== undefined) expect(JSON.stringify(sanitized)).not.toContain(rawSummary);
    }
  });

  it.each([
    ['credential-shaped message ID', ['Bearer', 'backendsecretmaterial'].join(' ')],
    ['absolute-path message ID', '/Users/example/private-backend-path'],
    ['non-UUID message ID', 'not-a-uuid'],
  ])('does not retain a rejected %s', (_case, messageId) => {
    const sanitized = sanitizeBackendEvent({ ...backendEvent(), messageId });
    expect(sanitized).toMatchObject({ accepted: false, sourceMessageId: null });
    expect(JSON.stringify(sanitized)).not.toContain(messageId);
  });
});
