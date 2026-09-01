import { createHash } from 'node:crypto';

import { isRfc3339DateTime } from '@moonshift/contracts';
import {
  canonicalActionDigest,
  evaluateToolAuthorization,
  type Sha256Digest,
} from '@moonshift/policy';

import type { SchedulingResult, SupervisionRecord } from '../../model.js';

export interface ApprovedEffectExecution {
  readonly messageId: string;
  readonly correlationId: string;
  readonly effectId: string;
  readonly actionDigest: Sha256Digest;
  readonly operation: 'WRITE_APPROVED_MARKER';
  readonly executionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly approval: {
    readonly state: 'APPROVED';
    readonly actionDigest: Sha256Digest;
    readonly expiresAt: string;
  };
  readonly authority: {
    readonly authorizedAt: string;
    readonly leaseExpiresAt: string;
  };
}

export interface EffectAuthorityReference {
  readonly messageId: string;
  readonly correlationId: string;
  readonly effectId: string;
  readonly actionDigest: Sha256Digest;
  readonly executionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
}

export interface EffectGroundTruth {
  readonly outcome: 'APPLIED' | 'NOT_APPLIED' | 'INDETERMINATE';
  readonly groundTruthDigest?: Sha256Digest | null;
}

export interface ApprovedEffectExecutor {
  execute(input: ApprovedEffectExecution): Promise<{
    readonly outcome: 'APPLIED' | 'ALREADY_APPLIED';
    readonly groundTruthDigest: Sha256Digest;
  }>;
  revoke(input: EffectAuthorityReference & { readonly reason: string }): Promise<EffectGroundTruth>;
  lookup(input: EffectAuthorityReference): Promise<EffectGroundTruth>;
}

export class InMemoryApprovedEffectExecutor implements ApprovedEffectExecutor {
  private readonly effects = new Map<
    string,
    { readonly actionDigest: Sha256Digest; readonly groundTruthDigest: Sha256Digest }
  >();
  private readonly fixtureGroundTruth = new Map<string, EffectGroundTruth>();
  private readonly revokedFenceByEffect = new Map<string, number>();
  private readonly effectQueues = new Map<string, Promise<void>>();

  private async withEffectLock<T>(effectId: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.effectQueues.get(effectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.effectQueues.set(effectId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.effectQueues.get(effectId) === queued) this.effectQueues.delete(effectId);
    }
  }

  private groundTruth(input: EffectAuthorityReference): EffectGroundTruth {
    const fixtureTruth = this.fixtureGroundTruth.get(input.effectId);
    if (fixtureTruth !== undefined) return fixtureTruth;
    const existing = this.effects.get(input.effectId);
    if (existing === undefined)
      return Object.freeze({ outcome: 'NOT_APPLIED' as const, groundTruthDigest: null });
    if (existing.actionDigest !== input.actionDigest)
      return Object.freeze({ outcome: 'INDETERMINATE' as const, groundTruthDigest: null });
    return Object.freeze({
      outcome: 'APPLIED' as const,
      groundTruthDigest: existing.groundTruthDigest,
    });
  }

  async execute(input: ApprovedEffectExecution) {
    assertApprovedEffectExecution(input);
    return this.withEffectLock(input.effectId, () => {
      const revokedFence = this.revokedFenceByEffect.get(input.effectId) ?? 0;
      if (input.fencingToken <= revokedFence) throw new Error('STALE_RUNTIME_FENCE');
      const existing = this.effects.get(input.effectId);
      if (existing !== undefined) {
        if (existing.actionDigest !== input.actionDigest)
          throw new Error('Fixture effect identity reused with another action digest');
        return Object.freeze({ outcome: 'ALREADY_APPLIED' as const, ...existing });
      }
      const groundTruthDigest = `sha256:${createHash('sha256')
        .update(
          JSON.stringify({
            actionDigest: input.actionDigest,
            effectId: input.effectId,
            marker: 'APPROVED',
          }),
        )
        .digest('hex')}` as const;
      this.effects.set(
        input.effectId,
        Object.freeze({ actionDigest: input.actionDigest, groundTruthDigest }),
      );
      return Object.freeze({ outcome: 'APPLIED' as const, groundTruthDigest });
    });
  }

  async revoke(input: EffectAuthorityReference): Promise<EffectGroundTruth> {
    return this.withEffectLock(input.effectId, () => {
      this.revokedFenceByEffect.set(
        input.effectId,
        Math.max(this.revokedFenceByEffect.get(input.effectId) ?? 0, input.fencingToken),
      );
      return this.groundTruth(input);
    });
  }

  async lookup(input: EffectAuthorityReference) {
    return this.withEffectLock(input.effectId, () => this.groundTruth(input));
  }

  clear(): void {
    this.effects.clear();
    this.fixtureGroundTruth.clear();
    this.revokedFenceByEffect.clear();
    this.effectQueues.clear();
  }

  setFixtureGroundTruth(effectId: string, truth: EffectGroundTruth): void {
    this.fixtureGroundTruth.set(effectId, Object.freeze({ ...truth }));
  }
}

export function assertApprovedEffectExecution(input: ApprovedEffectExecution): void {
  if (input.approval.state !== 'APPROVED') throw new Error('APPROVAL_NOT_APPROVED');
  if (input.approval.actionDigest !== input.actionDigest) throw new Error('ACTION_DIGEST_MISMATCH');
  if (
    !isRfc3339DateTime(input.authority.authorizedAt) ||
    !isRfc3339DateTime(input.approval.expiresAt) ||
    !isRfc3339DateTime(input.authority.leaseExpiresAt)
  ) {
    throw new Error('EFFECT_AUTHORITY_TIMESTAMP_INVALID');
  }
  if (Date.parse(input.authority.authorizedAt) >= Date.parse(input.approval.expiresAt))
    throw new Error('APPROVAL_EXPIRED');
  if (Date.parse(input.authority.authorizedAt) >= Date.parse(input.authority.leaseExpiresAt))
    throw new Error('EFFECT_AUTHORITY_EXPIRED');
  if (input.operation !== 'WRITE_APPROVED_MARKER') throw new Error('FIXTURE_OPERATION_DENIED');
}

export function buildFixtureSupervision(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly requesterAgentId: string;
  readonly scheduling: SchedulingResult;
  readonly scenario: string;
  readonly authorityNow: string;
  readonly authorityLeaseExpiresAt: string;
  readonly nextId: () => string;
}): SupervisionRecord {
  const action = Object.freeze({
    tool: 'FIXTURE_EFFECT' as const,
    operation: 'WRITE_APPROVED_MARKER' as const,
    resource: 'fixture:repository' as const,
    arguments: Object.freeze({
      path: 'approved-marker' as const,
      value: `APPROVED:${input.scenario}`,
    }),
  });
  const toolInvocationId = input.nextId();
  const capabilityLeaseId = input.nextId();
  const runnerLeaseId = input.nextId();
  const authority = Object.freeze({
    executionId: input.scheduling.execution.executionId,
    executionAttempt: 1,
    executionState: input.scheduling.execution.state,
    capabilityLeaseId,
    capabilityLeaseState: 'ACTIVE' as const,
    capabilityLeaseExpiresAt: input.authorityLeaseExpiresAt,
    runnerLeaseId,
    runnerLeaseState: 'ACTIVE' as const,
    runnerLeaseExpiresAt: input.authorityLeaseExpiresAt,
    runnerLastHeartbeatAt: input.authorityNow,
    fencingToken: 1,
    successor: false,
  });
  const base = {
    action,
    toolInvocationId,
    budget: Object.freeze({
      invocationLimit: 1,
      consumedInvocations: 0,
      monetaryLimitMicros: 1_000,
      consumedMonetaryMicros: 0,
    }),
    authority,
    checkpoint: null,
    recovery: Object.freeze({
      state: 'IDLE' as const,
      sourceExecutionId: null,
      successorExecutionId: null,
      sourceConnectionId: null,
      targetConnectionId: null,
      progress: 'No recovery is in progress',
      updatedAt: input.authorityNow,
    }),
    verification: Object.freeze({
      state: 'NONE' as const,
    }),
    blockedReasons: Object.freeze([]),
    audit: Object.freeze([]),
  };
  if (input.scheduling.execution.state !== 'WAITING_FOR_APPROVAL') {
    return Object.freeze({
      ...base,
      toolInvocationState: 'NOT_REQUESTED' as const,
      approvals: Object.freeze([]),
      effects: Object.freeze([]),
    });
  }
  const evaluated = evaluateToolAuthorization({
    grant: {
      grantId: capabilityLeaseId,
      capabilities: ['FIXTURE_EFFECT'],
      resourceScopes: ['fixture:repository'],
      invocationLimit: 1,
      monetaryLimitMicros: 1_000,
      expiresAt: input.authorityLeaseExpiresAt,
      revoked: false,
    },
    action,
    now: input.authorityNow,
    consumedInvocations: 0,
    consumedMonetaryMicros: 0,
  });
  if (evaluated.reason !== 'APPROVAL_REQUIRED' || !evaluated.approvalRequired)
    throw new Error(`Fixture action did not reach approval: ${evaluated.reason}`);
  const approvalId = input.nextId();
  const effectId = input.nextId();
  const expiresAt = new Date(Date.parse(input.authorityNow) + 300_000).toISOString();
  const actionDigest = canonicalActionDigest(action);
  return Object.freeze({
    ...base,
    toolInvocationState: 'WAITING_FOR_APPROVAL' as const,
    approvals: Object.freeze([
      Object.freeze({
        approvalId,
        projectId: input.projectId,
        taskId: input.taskId,
        requesterAgentId: input.requesterAgentId,
        state: 'REQUESTED' as const,
        actionDigest,
        scope: 'fixture:repository/approved-marker',
        reason: 'A specialist requested the bounded fixture marker effect',
        riskSummary: 'Writes one synthetic marker to the runner-owned fixture ledger',
        expiresAt,
        decidedAt: null,
        decisionActorId: null,
        version: 1,
        usable: true,
      }),
    ]),
    effects: Object.freeze([
      Object.freeze({
        effectId,
        taskId: input.taskId,
        actionDigest,
        semanticKey: `fixture-approved-marker:${input.projectId}:${input.taskId}:${toolInvocationId}`,
        state: 'REQUESTED' as const,
        reconciliationOutcome: null,
        groundTruthDigest: null,
        version: 1,
      }),
    ]),
  });
}
