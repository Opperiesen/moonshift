import { describe, expect, it } from 'vitest';

import type {
  ApprovedEffectExecution,
  ApprovedEffectExecutor,
  EffectAuthorityReference,
  EffectGroundTruth,
} from '../../apps/control-plane/src/application/supervision/tool-policy.js';
import { InMemoryApprovedEffectExecutor } from '../../apps/control-plane/src/application/supervision/tool-policy.js';
import {
  EFFECT_CRASH_BOUNDARIES,
  recoverEffectAfterCrash,
} from '../../apps/control-plane/src/application/recovery/reconciliation.js';
import { recoveryHash, recoveryUuid } from './fixtures.js';

class ObservedExecutor implements ApprovedEffectExecutor {
  executeCalls = 0;
  lookupCalls = 0;

  constructor(private readonly truth: EffectGroundTruth) {}

  async execute(_input: ApprovedEffectExecution) {
    this.executeCalls += 1;
    return { outcome: 'APPLIED' as const, groundTruthDigest: recoveryHash('9') };
  }

  async revoke(_input: EffectAuthorityReference & { readonly reason: string }) {
    return this.truth;
  }

  async lookup(_input: EffectAuthorityReference) {
    this.lookupCalls += 1;
    return this.truth;
  }
}

const authority = {
  messageId: recoveryUuid(20),
  correlationId: recoveryUuid(21),
  effectId: recoveryUuid(22),
  actionDigest: recoveryHash('a'),
  executionId: recoveryUuid(23),
  leaseId: recoveryUuid(24),
  fencingToken: 7,
} as const;

describe('effect crash-boundary recovery matrix', () => {
  it.each(EFFECT_CRASH_BOUNDARIES)(
    'recovers %s without blindly executing an effect',
    async (boundary) => {
      const truth =
        boundary.includes('MUTATION') || boundary.includes('RUNNER_RESULT')
          ? ({ outcome: 'APPLIED', groundTruthDigest: recoveryHash('b') } as const)
          : ({ outcome: 'NOT_APPLIED', groundTruthDigest: null } as const);
      const executor = new ObservedExecutor(truth);
      const recovered = await recoverEffectAfterCrash({ boundary, authority, executor });

      expect(executor.executeCalls).toBe(0);
      expect(recovered.dispatchedEffects).toBe(0);
      expect(recovered.blockedReason).toBeNull();
      expect(['NONE', 'NOT_APPLIED', 'APPLIED']).toContain(recovered.groundTruth);
      if (boundary === 'BEFORE_EFFECT_INTENT_COMMIT') expect(executor.lookupCalls).toBe(0);
      if (boundary === 'AFTER_EFFECT_COMMIT_BEFORE_OUTBOX_PUBLICATION')
        expect(recovered.recoveryAction).toBe('REPUBLISH_DURABLE_OUTBOX');
      if (boundary === 'AFTER_OUTBOX_PUBLICATION_BEFORE_BROWSER_ACKNOWLEDGEMENT')
        expect(recovered.recoveryAction).toBe('OBSERVE_DURABLE_PUBLICATION');
    },
  );

  it('keeps an indeterminate outcome UNKNOWN and blocks all continuation', async () => {
    const executor = new ObservedExecutor({ outcome: 'INDETERMINATE', groundTruthDigest: null });
    const recovered = await recoverEffectAfterCrash({
      boundary: 'AFTER_DISPATCH_BEFORE_FIXTURE_MUTATION',
      authority,
      executor,
      maxLookupAttempts: 2,
    });

    expect(recovered).toMatchObject({
      groundTruth: 'UNKNOWN',
      recoveryAction: 'BLOCK_UNKNOWN',
      lookupAttempts: 2,
      continuationAllowed: false,
    });
    expect(recovered.blockedReason).toContain('unknown');
    expect(executor.executeCalls).toBe(0);
  });

  it('serializes effect execution against authority revocation at the crash boundary', async () => {
    const executor = new InMemoryApprovedEffectExecutor();
    const execution: ApprovedEffectExecution = {
      ...authority,
      operation: 'WRITE_APPROVED_MARKER',
      approval: {
        state: 'APPROVED',
        actionDigest: authority.actionDigest,
        expiresAt: '2026-09-01T08:01:00.000Z',
      },
      authority: {
        authorizedAt: '2026-09-01T08:00:00.000Z',
        leaseExpiresAt: '2026-09-01T08:05:00.000Z',
      },
    };
    const [revoked, lateExecution] = await Promise.allSettled([
      executor.revoke({ ...authority, reason: 'RUNTIME_LOST_FENCED' }),
      executor.execute(execution),
    ]);

    expect(revoked).toEqual({
      status: 'fulfilled',
      value: { outcome: 'NOT_APPLIED', groundTruthDigest: null },
    });
    expect(lateExecution).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'STALE_RUNTIME_FENCE' }),
    });

    executor.clear();
    const [applied, observed] = await Promise.all([
      executor.execute(execution),
      executor.revoke({ ...authority, reason: 'RUNTIME_LOST_FENCED' }),
    ]);
    expect(applied.outcome).toBe('APPLIED');
    expect(observed.outcome).toBe('APPLIED');
  });
});
