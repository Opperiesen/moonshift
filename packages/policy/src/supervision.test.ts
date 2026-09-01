import { describe, expect, it } from 'vitest';

import {
  authorizeApprovedAction,
  canonicalActionDigest,
  decideApproval,
  evaluateControlCommand,
  evaluatePauseVerificationInterlock,
  evaluateToolAuthorization,
  type ApprovalRequest,
  type ToolAuthorizationInput,
} from './supervision.js';

type Actor = { readonly type: 'SUPERVISOR' | 'RUNTIME'; readonly id: string };
const supervisor: Actor = { type: 'SUPERVISOR', id: 'supervisor-1' };
const specialist: Actor = { type: 'RUNTIME', id: 'agent-1' };
const now = '2026-01-01T00:00:00.000Z';
const grant = Object.freeze({
  grantId: 'grant-1',
  capabilities: Object.freeze(['FIXTURE_EFFECT']),
  resourceScopes: Object.freeze(['fixture:repository']),
  invocationLimit: 2,
  monetaryLimitMicros: 1_000,
  expiresAt: '2026-01-01T01:00:00.000Z',
  revoked: false,
});

const action = {
  tool: 'FIXTURE_EFFECT',
  resource: 'fixture:repository',
  arguments: { path: 'approved-marker', value: 'done' },
};

function toolInput(overrides: Partial<ToolAuthorizationInput> = {}): ToolAuthorizationInput {
  return {
    grant,
    action,
    now,
    consumedInvocations: 0,
    consumedMonetaryMicros: 0,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: 'approval-1',
    projectId: 'project-1',
    taskId: 'task-1',
    toolInvocationId: 'invocation-1',
    requesterAgentId: 'agent-1',
    actionDigest: canonicalActionDigest(action),
    reason: 'fixture mutation requires supervision',
    riskSummary: 'changes the controlled fixture',
    state: 'REQUESTED',
    expiresAt: '2026-01-01T00:05:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('supervised tool authorization', () => {
  it('uses a canonical immutable digest and requires approval for sensitive effects', () => {
    const reordered = {
      resource: action.resource,
      arguments: { value: 'done', path: 'approved-marker' },
      tool: action.tool,
    };
    expect(canonicalActionDigest(action)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(canonicalActionDigest(action)).toBe(canonicalActionDigest(reordered));
    expect(
      canonicalActionDigest({ ...action, arguments: { ...action.arguments, value: 'other' } }),
    ).not.toBe(canonicalActionDigest(action));
    expect(evaluateToolAuthorization(toolInput())).toMatchObject({
      allowed: false,
      reason: 'APPROVAL_REQUIRED',
      approvalRequired: true,
      actionDigest: canonicalActionDigest(action),
    });
  });

  it.each([
    ['capability', { action: { ...action, tool: 'HOST_SHELL' } }, 'CAPABILITY_DENIED'],
    ['resource', { action: { ...action, resource: 'host:filesystem' } }, 'RESOURCE_SCOPE_DENIED'],
    [
      'arguments',
      { action: { ...action, arguments: { path: '../escape', value: 'done' } } },
      'ARGUMENTS_DENIED',
    ],
    ['lease', { now: '2026-01-01T01:00:00.000Z' }, 'TOOL_LEASE_EXPIRED'],
    ['invocation budget', { consumedInvocations: 2 }, 'INVOCATION_BUDGET_EXHAUSTED'],
    ['monetary budget', { consumedMonetaryMicros: 1_000 }, 'MONETARY_BUDGET_EXHAUSTED'],
  ] as const)('denies %s escalation or exhaustion', (_name, input, reason) => {
    expect(evaluateToolAuthorization(toolInput(input))).toMatchObject({ allowed: false, reason });
  });
});

describe('approval integrity and authority', () => {
  it('allows only the supervisor to decide, rejects self-approval, and is versioned', () => {
    expect(() =>
      decideApproval({
        approval: approval(),
        actor: specialist,
        decision: 'APPROVE',
        expectedVersion: 1,
        now,
      }),
    ).toThrow('SUPERVISOR_ONLY');
    expect(() =>
      decideApproval({
        approval: approval(),
        actor: supervisor,
        decision: 'APPROVE',
        expectedVersion: 1,
        now,
        requesterAgentId: 'supervisor-1',
      }),
    ).toThrow('SELF_APPROVAL_DENIED');
    expect(() =>
      decideApproval({
        approval: approval(),
        actor: supervisor,
        decision: 'APPROVE',
        expectedVersion: 0,
        now,
      }),
    ).toThrow('VERSION_CONFLICT');
  });

  it('denies expiry, changed digests, and repeat decisions while preserving immutable action data', () => {
    expect(() =>
      decideApproval({
        approval: approval(),
        actor: supervisor,
        decision: 'APPROVE',
        expectedVersion: 1,
        now: '2026-01-01T00:05:00.000Z',
      }),
    ).toThrow('APPROVAL_EXPIRED');
    const changed = { ...approval(), actionDigest: 'sha256:changed' as `sha256:${string}` };
    expect(() =>
      authorizeApprovedAction({
        approval: changed,
        actionDigest: canonicalActionDigest(action),
        now,
      }),
    ).toThrow('ACTION_DIGEST_MISMATCH');
    const approved = decideApproval({
      approval: approval(),
      actor: supervisor,
      decision: 'APPROVE',
      expectedVersion: 1,
      now,
    });
    expect(Object.isFrozen(approved.approval)).toBe(true);
    expect(() =>
      decideApproval({
        approval: approved.approval,
        actor: supervisor,
        decision: 'REJECT',
        expectedVersion: 2,
        now,
      }),
    ).toThrow('APPROVAL_ALREADY_DECIDED');
  });
});

describe('pause, stop, and cancel supervision semantics', () => {
  it('blocks new verification on PAUSING but drains or stales one in-flight snapshot before PAUSED', () => {
    expect(
      evaluatePauseVerificationInterlock({
        projectState: 'PAUSING',
        evaluationState: 'EVALUATING',
        graceExpired: false,
      }),
    ).toEqual({ allowed: true, reason: 'DRAIN_IN_FLIGHT_EVALUATION' });
    expect(
      evaluatePauseVerificationInterlock({
        projectState: 'PAUSING',
        evaluationState: 'EVALUATING',
        graceExpired: true,
      }),
    ).toEqual({ allowed: true, reason: 'STALE_IN_FLIGHT_EVALUATION' });
    expect(
      evaluatePauseVerificationInterlock({
        projectState: 'PAUSING',
        evaluationState: 'NONE',
        graceExpired: false,
      }),
    ).toEqual({ allowed: false, reason: 'PAUSING_VERIFICATION_INTERLOCK' });
    expect(
      evaluatePauseVerificationInterlock({
        projectState: 'PAUSED',
        evaluationState: 'EVALUATING',
        graceExpired: false,
      }),
    ).toEqual({ allowed: false, reason: 'PAUSED_VERIFICATION_INTERLOCK' });
  });

  it.each([
    ['PAUSE', 'PAUSING', 'PRESERVE_PENDING_APPROVALS', 'LEASES_REVOKED_ON_RESUME'],
    ['STOP', 'STOPPING', 'CANCEL_PENDING_APPROVALS', 'FENCE_EXECUTION_AUTHORITY'],
    ['CANCEL', 'CANCELLING', 'CANCEL_PENDING_APPROVALS', 'CANCEL_TASKS_TERMINALLY'],
  ] as const)(
    'keeps %s state, lease, approval, and recovery semantics distinct',
    (command, state, approvalEffect, recovery) => {
      expect(
        evaluateControlCommand({
          command,
          projectState: 'ACTIVE',
          expectedVersion: 4,
          actualVersion: 4,
          actor: supervisor,
          idempotencyKey: `key-${command}`,
        }),
      ).toMatchObject({ accepted: true, nextState: state, approvalEffect, recovery });
    },
  );

  it('makes repeats idempotent while rejecting stale command races', () => {
    const input = {
      command: 'PAUSE' as const,
      projectState: 'ACTIVE' as const,
      expectedVersion: 4,
      actualVersion: 4,
      actor: supervisor,
      idempotencyKey: 'pause-command-key',
    };
    expect(evaluateControlCommand(input)).toEqual(evaluateControlCommand(input));
    expect(() => evaluateControlCommand({ ...input, expectedVersion: 3 })).toThrow(
      'VERSION_CONFLICT',
    );
  });
});
