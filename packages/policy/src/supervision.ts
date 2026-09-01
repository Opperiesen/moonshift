import { createHash } from 'node:crypto';

import type { CapabilityGrant } from './policy.js';

export type Sha256Digest = `sha256:${string}`;

export interface SensitiveToolAction {
  readonly tool: string;
  readonly resource: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolAuthorizationInput {
  readonly grant: CapabilityGrant;
  readonly action: SensitiveToolAction;
  readonly now: string;
  readonly consumedInvocations: number;
  readonly consumedMonetaryMicros: number;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly toolInvocationId: string;
  readonly requesterAgentId: string;
  readonly actionDigest: Sha256Digest;
  readonly reason: string;
  readonly riskSummary: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  readonly expiresAt: string;
  readonly decidedAt?: string | null;
  readonly decisionActorId?: string | null;
  readonly version: number;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function canonicalActionDigest(action: SensitiveToolAction): Sha256Digest {
  const canonical = JSON.stringify(stableValue(action));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function decision(
  reason: string,
  actionDigest: Sha256Digest,
  approvalRequired = false,
): {
  readonly allowed: false;
  readonly reason: string;
  readonly approvalRequired: boolean;
  readonly actionDigest: Sha256Digest;
} {
  return Object.freeze({ allowed: false, reason, approvalRequired, actionDigest });
}

export function evaluateToolAuthorization(input: ToolAuthorizationInput) {
  const actionDigest = canonicalActionDigest(input.action);
  if (input.grant.revoked) return decision('TOOL_LEASE_REVOKED', actionDigest);
  if (Date.parse(input.now) >= Date.parse(input.grant.expiresAt))
    return decision('TOOL_LEASE_EXPIRED', actionDigest);
  if (!input.grant.capabilities.includes(input.action.tool))
    return decision('CAPABILITY_DENIED', actionDigest);
  if (!input.grant.resourceScopes.includes(input.action.resource))
    return decision('RESOURCE_SCOPE_DENIED', actionDigest);
  const argumentKeys = Object.keys(input.action.arguments).sort();
  const path = input.action.arguments.path;
  const value = input.action.arguments.value;
  if (
    argumentKeys.join(',') !== 'path,value' ||
    path !== 'approved-marker' ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128
  ) {
    return decision('ARGUMENTS_DENIED', actionDigest);
  }
  if (input.consumedInvocations >= input.grant.invocationLimit)
    return decision('INVOCATION_BUDGET_EXHAUSTED', actionDigest);
  if (input.consumedMonetaryMicros >= input.grant.monetaryLimitMicros)
    return decision('MONETARY_BUDGET_EXHAUSTED', actionDigest);
  return decision('APPROVAL_REQUIRED', actionDigest, true);
}

function fail(code: string): never {
  throw new Error(code);
}

export function decideApproval(input: {
  readonly approval: ApprovalRequest;
  readonly actor: { readonly type: string; readonly id: string };
  readonly requesterAgentId?: string;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly expectedVersion: number;
  readonly now: string;
}): { readonly approval: ApprovalRequest } {
  if (input.actor.type !== 'SUPERVISOR') fail('SUPERVISOR_ONLY');
  if ((input.requesterAgentId ?? input.approval.requesterAgentId) === input.actor.id)
    fail('SELF_APPROVAL_DENIED');
  if (input.expectedVersion !== input.approval.version) fail('VERSION_CONFLICT');
  if (input.approval.state !== 'REQUESTED') fail('APPROVAL_ALREADY_DECIDED');
  if (Date.parse(input.now) >= Date.parse(input.approval.expiresAt)) fail('APPROVAL_EXPIRED');
  return Object.freeze({
    approval: Object.freeze({
      ...input.approval,
      state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      decidedAt: input.now,
      decisionActorId: input.actor.id,
      version: input.approval.version + 1,
    }),
  });
}

export function authorizeApprovedAction(input: {
  readonly approval: ApprovalRequest;
  readonly actionDigest: Sha256Digest;
  readonly now: string;
}): { readonly allowed: true; readonly approvalId: string } {
  if (input.approval.actionDigest !== input.actionDigest) fail('ACTION_DIGEST_MISMATCH');
  if (input.approval.state !== 'APPROVED') fail('APPROVAL_NOT_APPROVED');
  if (Date.parse(input.now) >= Date.parse(input.approval.expiresAt)) fail('APPROVAL_EXPIRED');
  return Object.freeze({ allowed: true, approvalId: input.approval.approvalId });
}

export function evaluatePauseVerificationInterlock(input: {
  readonly projectState: string;
  readonly evaluationState: string;
  readonly graceExpired: boolean;
}) {
  if (input.projectState === 'PAUSING') {
    if (input.evaluationState === 'EVALUATING') {
      return Object.freeze({
        allowed: true,
        reason: input.graceExpired
          ? ('STALE_IN_FLIGHT_EVALUATION' as const)
          : ('DRAIN_IN_FLIGHT_EVALUATION' as const),
      });
    }
    return Object.freeze({ allowed: false, reason: 'PAUSING_VERIFICATION_INTERLOCK' as const });
  }
  if (input.projectState === 'PAUSED')
    return Object.freeze({ allowed: false, reason: 'PAUSED_VERIFICATION_INTERLOCK' as const });
  return Object.freeze({ allowed: true, reason: 'VERIFICATION_ALLOWED' as const });
}

const controlRules = Object.freeze({
  PAUSE: Object.freeze({
    allowed: Object.freeze(['ACTIVE', 'BLOCKED']),
    nextState: 'PAUSING',
    approvalEffect: 'PRESERVE_PENDING_APPROVALS',
    recovery: 'LEASES_REVOKED_ON_RESUME',
  }),
  RESUME: Object.freeze({
    allowed: Object.freeze(['PAUSED', 'STOPPED']),
    nextState: 'RESUMING',
    approvalEffect: 'REVALIDATE_PENDING_APPROVALS',
    recovery: 'MINT_SUCCESSOR_AUTHORITY',
  }),
  STOP: Object.freeze({
    allowed: Object.freeze(['ACTIVE', 'PAUSING', 'PAUSED', 'RESUMING', 'BLOCKED']),
    nextState: 'STOPPING',
    approvalEffect: 'CANCEL_PENDING_APPROVALS',
    recovery: 'FENCE_EXECUTION_AUTHORITY',
  }),
  CANCEL: Object.freeze({
    allowed: Object.freeze([
      'CREATING',
      'ACTIVE',
      'PAUSING',
      'PAUSED',
      'RESUMING',
      'STOPPING',
      'STOPPED',
      'BLOCKED',
    ]),
    nextState: 'CANCELLING',
    approvalEffect: 'CANCEL_PENDING_APPROVALS',
    recovery: 'CANCEL_TASKS_TERMINALLY',
  }),
} as const);

export type ControlCommand = keyof typeof controlRules;

export function evaluateControlCommand(input: {
  readonly command: ControlCommand;
  readonly projectState: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  readonly actor: { readonly type: string; readonly id: string };
  readonly idempotencyKey: string;
}) {
  if (input.actor.type !== 'SUPERVISOR') fail('SUPERVISOR_ONLY');
  if (input.expectedVersion !== input.actualVersion) fail('VERSION_CONFLICT');
  if (!input.idempotencyKey) fail('IDEMPOTENCY_KEY_REQUIRED');
  const rule = controlRules[input.command];
  if (!(rule.allowed as readonly string[]).includes(input.projectState))
    fail('CONTROL_STATE_CONFLICT');
  return Object.freeze({
    accepted: true,
    nextState: rule.nextState,
    approvalEffect: rule.approvalEffect,
    recovery: rule.recovery,
  });
}
