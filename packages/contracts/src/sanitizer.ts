import { createHash } from 'node:crypto';

import type { BackendEvent, BackendEventType, BackendObservable } from './generated.js';
import { isUuid, planningValidators } from './validators.js';

export type BackendObservationRejectionReason =
  | 'BACKEND_OBSERVATION_PROHIBITED_CONTENT'
  | 'BACKEND_OBSERVATION_SCHEMA_INVALID'
  | 'BACKEND_OBSERVATION_KIND_INVALID';

export type SanitizedBackendObservation =
  | {
      readonly accepted: true;
      readonly sourceContentHash: `sha256:${string}`;
      readonly classification: 'INTERNAL';
      readonly event: BackendEvent;
    }
  | {
      readonly accepted: false;
      readonly sourceMessageId: string | null;
      readonly contentHash: `sha256:${string}`;
      readonly classification: 'INTERNAL';
      readonly reasonCode: BackendObservationRejectionReason;
      readonly notice: 'Backend observation rejected by projection policy';
    };

const prohibitedKeys = new Set([
  'apikey',
  'authorization',
  'chainofthought',
  'cookie',
  'credential',
  'messages',
  'password',
  'privatekey',
  'privatereasoning',
  'prompt',
  'rawprompt',
  'reasoning',
  'token',
  'transcript',
]);
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const absolutePath = /^(?:\/|[a-z]:[\\/])/iu;
const traversalPath = /(?:^|[\\/])\.\.(?:[\\/]|$)/u;
const credentialValue =
  /(?:\bbearer\s+[a-z0-9._~+\/-]{8,}|-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----|\bsk-[a-z0-9]{16,})/iu;

const kindFields: Readonly<Record<BackendEventType, readonly (keyof BackendObservable)[]>> = {
  STARTED: ['status', 'summary'],
  PROGRESS: ['status', 'summary', 'progressPercent'],
  TOOL_INTENT: ['status', 'summary', 'toolOperation', 'actionDigest'],
  CHECKPOINT: ['status', 'summary', 'checkpointId', 'contentHash'],
  ARTIFACT: ['status', 'summary', 'artifactId', 'contentHash'],
  COMPLETED: ['status', 'summary'],
  FAILED: ['status', 'summary', 'failureCategory'],
  CANCELLED: ['status', 'summary'],
};

const observationVocabulary: Readonly<Record<BackendEventType, ReadonlySet<string>>> = {
  STARTED: new Set(['RUNNING\u0000Deterministic fixture execution started']),
  PROGRESS: new Set([
    'RUNNING\u0000Fixture progress',
    'RUNNING\u0000Normalized fixture objective analyzed',
  ]),
  TOOL_INTENT: new Set(['WAITING_FOR_APPROVAL\u0000Controlled fixture marker requested']),
  CHECKPOINT: new Set([
    'CHECKPOINTING\u0000Provider-neutral checkpoint captured',
    'CHECKPOINTING\u0000Durable before effect boundary captured',
    'CHECKPOINTING\u0000Durable during effect boundary captured',
    'CHECKPOINTING\u0000Durable after effect boundary captured',
    'CHECKPOINTING\u0000Durable effect boundary captured',
    'CHECKPOINTING\u0000Durable post-effect boundary captured',
  ]),
  ARTIFACT: new Set([
    'RUNNING\u0000Deterministic artifact published',
    'RUNNING\u0000Deterministic artifact published with failing evidence',
  ]),
  COMPLETED: new Set(['CLAIMED_COMPLETE\u0000Fixture execution claimed completion']),
  FAILED: new Set([
    'REJECTED\u0000Sensitive fixture effect rejected by policy',
    'INTERRUPTED\u0000Fixture runtime interrupted before effect',
    'INTERRUPTED\u0000Fixture runtime interrupted during effect',
    'INTERRUPTED\u0000Fixture runtime interrupted after effect',
  ]),
  CANCELLED: new Set(['CANCELLED\u0000Fixture execution cancelled']),
};

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
}

function containsProhibitedContent(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'string') {
    return (
      controlCharacters.test(value) ||
      absolutePath.test(value) ||
      traversalPath.test(value) ||
      credentialValue.test(value)
    );
  }
  if (Array.isArray(value)) {
    if (value.length > 100) return true;
    return value.some((item) => containsProhibitedContent(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 100) return true;
    return entries.some(
      ([key, nested]) =>
        prohibitedKeys.has(normalizedKey(key)) || containsProhibitedContent(nested, depth + 1),
    );
  }
  return false;
}

function contentHash(value: unknown): `sha256:${string}` {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'undefined';
  } catch {
    serialized = 'unserializable';
  }
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function reject(
  raw: unknown,
  reasonCode: BackendObservationRejectionReason,
): SanitizedBackendObservation {
  const candidate =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>).messageId
      : undefined;
  return Object.freeze({
    accepted: false,
    sourceMessageId: typeof candidate === 'string' && isUuid(candidate) ? candidate : null,
    contentHash: contentHash(raw),
    classification: 'INTERNAL',
    reasonCode,
    notice: 'Backend observation rejected by projection policy',
  });
}

function copyObservable(
  raw: Record<string, unknown>,
  eventType: BackendEventType,
): BackendObservable | undefined {
  const allowed = kindFields[eventType];
  if (allowed === undefined) return undefined;
  if (
    typeof raw.status !== 'string' ||
    typeof raw.summary !== 'string' ||
    !observationVocabulary[eventType].has(`${raw.status}\u0000${raw.summary}`)
  ) {
    return undefined;
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => !allowed.includes(key as keyof BackendObservable))) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.hasOwn(raw, key)) output[key] = raw[key];
  }
  return output as unknown as BackendObservable;
}

export function sanitizeBackendEvent(raw: unknown): SanitizedBackendObservation {
  if (containsProhibitedContent(raw)) return reject(raw, 'BACKEND_OBSERVATION_PROHIBITED_CONTENT');
  if (!planningValidators().executionBackend.validate(raw))
    return reject(raw, 'BACKEND_OBSERVATION_SCHEMA_INVALID');
  const source = raw as Record<string, unknown>;
  if (source.kind !== 'backend.event' || typeof source.eventType !== 'string')
    return reject(raw, 'BACKEND_OBSERVATION_KIND_INVALID');
  const observable = copyObservable(
    source.observable as Record<string, unknown>,
    source.eventType as BackendEventType,
  );
  if (observable === undefined) return reject(raw, 'BACKEND_OBSERVATION_KIND_INVALID');
  const usage = source.usage as Record<string, unknown>;
  const event: BackendEvent = Object.freeze({
    schemaVersion: '1.0',
    messageId: source.messageId as string,
    kind: 'backend.event',
    connectionId: source.connectionId as string,
    correlationId: source.correlationId as string,
    sentAt: source.sentAt as string,
    executionId: source.executionId as string,
    modelDescriptorId: source.modelDescriptorId as string,
    modelDescriptorVersion: source.modelDescriptorVersion as number,
    sequence: source.sequence as number,
    eventType: source.eventType as BackendEventType,
    observable: Object.freeze({ ...observable }),
    usage: Object.freeze({
      synthetic: true,
      invocations: usage.invocations as number,
      units: usage.units as number,
    }),
  });
  return Object.freeze({
    accepted: true,
    sourceContentHash: contentHash(raw),
    classification: 'INTERNAL',
    event,
  });
}
