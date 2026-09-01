import { describe, expect, it } from 'vitest';

import {
  deriveCapabilityGrant,
  evaluateActorAuthority,
  validateReviewerLineage,
  type CapabilityGrant,
} from '../../packages/policy/src/policy.js';
import {
  authorizeApprovedAction,
  canonicalActionDigest,
  decideApproval,
  type ApprovalRequest,
} from '../../packages/policy/src/supervision.js';
import { sanitizeBackendEvent, planningValidators } from '../../packages/contracts/src/index.js';
import { FixtureLeaseRegistry, type FixtureLeaseOffer } from '../../apps/runner/src/index.js';

const uuid = (n: number): string => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-01-01T00:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const parent: CapabilityGrant = Object.freeze({
  grantId: 'parent',
  capabilities: Object.freeze(['READ_FIXTURE', 'WRITE_APPROVED_MARKER']),
  resourceScopes: Object.freeze(['fixture:repository']),
  invocationLimit: 4,
  monetaryLimitMicros: 100,
  expiresAt: '2026-01-01T01:00:00.000Z',
  revoked: false,
});
const action = Object.freeze({
  tool: 'WRITE_APPROVED_MARKER',
  resource: 'fixture:repository',
  arguments: { path: 'approved-marker', value: 'done' },
});
const approval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  approvalId: 'approval-1',
  projectId: 'project-1',
  taskId: 'task-1',
  toolInvocationId: 'invocation-1',
  requesterAgentId: 'agent-1',
  actionDigest: canonicalActionDigest(action),
  reason: 'bounded fixture action',
  riskSummary: 'writes one fixture marker',
  state: 'REQUESTED',
  expiresAt: '2026-01-01T00:05:00.000Z',
  version: 1,
  ...overrides,
});

function lease(overrides: Partial<FixtureLeaseOffer> = {}): FixtureLeaseOffer {
  return {
    leaseId: uuid(1),
    executionId: uuid(2),
    fencingToken: 1,
    effectId: uuid(3),
    actionDigest: digest,
    authorizedAt: now,
    approvalExpiresAt: '2026-01-01T00:05:00.000Z',
    expiresAt: '2026-01-01T00:10:00.000Z',
    resources: {
      memoryBytes: 1,
      cpuUnits: 1,
      processLimit: 1,
      diskBytes: 1,
      maxRuntimeMs: 1,
      networkMode: 'DENY',
      gpuUnits: 0,
    },
    ...overrides,
  };
}

describe('T076 negative security boundaries', () => {
  it('rejects grant escalation, specialist child spawning, and self-approval', () => {
    expect(() =>
      deriveCapabilityGrant(parent, {
        grantId: 'child',
        capabilities: ['READ_FIXTURE', 'HOST_SHELL'],
        resourceScopes: ['fixture:repository'],
        invocationLimit: 4,
        monetaryLimitMicros: 100,
        expiresAt: parent.expiresAt,
      }),
    ).toThrow('CAPABILITY_ESCALATION');
    expect(
      evaluateActorAuthority({
        actor: 'SPECIALIST',
        action: 'CREATE_SPECIALIST',
        requesterIsActor: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'SPECIALIST_CHILD_DENIED' });
    expect(
      evaluateActorAuthority({
        actor: 'SPECIALIST',
        action: 'DECIDE_APPROVAL',
        requesterIsActor: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'SELF_APPROVAL_DENIED' });
  });

  it('rejects digest replay or tampering and repeat approval decisions', () => {
    expect(() =>
      authorizeApprovedAction({ approval: approval(), actionDigest: digest, now }),
    ).toThrow('ACTION_DIGEST_MISMATCH');
    const approved = decideApproval({
      approval: approval(),
      actor: { type: 'SUPERVISOR', id: 'supervisor' },
      decision: 'APPROVE',
      expectedVersion: 1,
      now,
    });
    expect(() =>
      decideApproval({
        approval: approved.approval,
        actor: { type: 'SUPERVISOR', id: 'supervisor' },
        decision: 'REJECT',
        expectedVersion: 2,
        now,
      }),
    ).toThrow('APPROVAL_ALREADY_DECIDED');
    expect(() =>
      authorizeApprovedAction({
        approval: approval({ actionDigest: digest }),
        actionDigest: digest,
        now,
      }),
    ).toThrow('APPROVAL_NOT_APPROVED');
  });

  it('requires same-lineage reviews to be rejected', () => {
    expect(validateReviewerLineage('engineering', 'engineering')).toEqual({
      allowed: false,
      reason: 'SAME_LINEAGE',
    });
  });

  it('fences forged, replayed, revoked, and stale runner traffic', () => {
    const registry = new FixtureLeaseRegistry();
    const first = lease();
    registry.offer(first, 'runner-1');
    expect(registry.isCurrent(first.leaseId, first.executionId, first.fencingToken)).toBe(true);
    expect(
      registry.availableForEffect(
        first.leaseId,
        first.executionId,
        1,
        first.effectId,
        'sha256:forged',
      ),
    ).toBeNull();
    registry.consumeEffect(first.leaseId, first.executionId, 1, first.effectId, digest);
    expect(() =>
      registry.consumeEffect(first.leaseId, first.executionId, 1, first.effectId, digest),
    ).toThrow();
    registry.revoke(first.leaseId, first.executionId, 1);
    expect(registry.isCurrent(first.leaseId, first.executionId, 1)).toBe(false);
    expect(() =>
      registry.offer({ ...first, leaseId: uuid(4), fencingToken: 1 }, 'runner-1'),
    ).toThrow('not monotonic');
    expect(() =>
      registry.offer({ ...first, leaseId: uuid(5), fencingToken: 2 }, 'runner-2'),
    ).not.toThrow();
    expect(registry.isCurrent(first.leaseId, first.executionId, 1)).toBe(false);
  });

  it('rejects plaintext/forged runner protocol identities and unauthorized events at the contract boundary', () => {
    const validator = planningValidators().runnerProtocol.validate;
    const message = {
      schemaVersion: '1.0',
      messageId: uuid(10),
      kind: 'runner.heartbeat',
      instanceId: uuid(11),
      runnerId: uuid(12),
      correlationId: uuid(13),
      sentAt: now,
      activeLeaseIds: [],
    };
    expect(validator(message)).toBe(true);
    expect(validator({ ...message, kind: 'runner.unauthorized_event' })).toBe(false);
    expect(validator({ ...message, instanceId: 'forged-instance' })).toBe(false);
  });

  const forbiddenValues = [
    ['prompt', 'prompt text'],
    ['transcript', 'conversation'],
    ['authorization', 'Bearer abcdefgh'],
    ['credential', 'secret'],
    ['privateKey', ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join('')],
    ['privateReasoning', 'chain of thought'],
    ['path', '/etc/passwd'],
    ['path', '../escape'],
  ] as const;
  it.each(forbiddenValues)(
    'rejects raw, credential, private, absolute, and traversal content: %s',
    (key, value) => {
      const raw = {
        schemaVersion: '1.0',
        messageId: uuid(20),
        kind: 'backend.event',
        connectionId: uuid(21),
        correlationId: uuid(22),
        sentAt: now,
        executionId: uuid(23),
        modelDescriptorId: uuid(24),
        modelDescriptorVersion: 1,
        sequence: 1,
        eventType: 'STARTED',
        observable: { status: 'RUNNING', summary: 'Deterministic fixture execution started' },
        usage: { synthetic: true, invocations: 0, units: 0 },
        [key]: value,
      };
      expect(sanitizeBackendEvent(raw)).toMatchObject({ accepted: false });
    },
  );

  it('rejects unknown/nested fields, oversize payloads, and control-character tampering', () => {
    const base = {
      schemaVersion: '1.0',
      messageId: uuid(30),
      kind: 'backend.event',
      connectionId: uuid(31),
      correlationId: uuid(32),
      sentAt: now,
      executionId: uuid(33),
      modelDescriptorId: uuid(34),
      modelDescriptorVersion: 1,
      sequence: 1,
      eventType: 'STARTED',
      observable: { status: 'RUNNING', summary: 'Deterministic fixture execution started' },
      usage: { synthetic: true, invocations: 0, units: 0 },
    };
    expect(sanitizeBackendEvent({ ...base, unknown: true })).toMatchObject({ accepted: false });
    expect(sanitizeBackendEvent({ ...base, nested: { safe: { deeper: true } } })).toMatchObject({
      accepted: false,
    });
    expect(
      sanitizeBackendEvent({
        ...base,
        observable: { ...base.observable, summary: `bad\u0000value` },
      }),
    ).toMatchObject({ accepted: false });
    expect(
      sanitizeBackendEvent({ ...base, values: Array.from({ length: 101 }, () => 'x') }),
    ).toMatchObject({ accepted: false });
  });

  it('does not retain rejected unauthorized payloads', () => {
    const rejected = sanitizeBackendEvent({ rawPrompt: 'do not retain me', token: 'secret' });
    expect(rejected).toMatchObject({
      accepted: false,
      notice: 'Backend observation rejected by projection policy',
    });
    expect(JSON.stringify(rejected)).not.toContain('do not retain me');
  });
});
