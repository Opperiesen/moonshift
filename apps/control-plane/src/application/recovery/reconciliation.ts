import type {
  ApprovedEffectExecutor,
  EffectAuthorityReference,
  EffectGroundTruth,
} from '../supervision/tool-policy.js';

export const EFFECT_CRASH_BOUNDARIES = Object.freeze([
  'BEFORE_EFFECT_INTENT_COMMIT',
  'AFTER_INTENT_COMMIT_BEFORE_RUNNER_DISPATCH',
  'AFTER_DISPATCH_BEFORE_FIXTURE_MUTATION',
  'AFTER_FIXTURE_MUTATION_BEFORE_RUNNER_RESULT',
  'AFTER_RUNNER_RESULT_BEFORE_APPLIED_COMMIT',
  'AFTER_EFFECT_COMMIT_BEFORE_OUTBOX_PUBLICATION',
  'AFTER_OUTBOX_PUBLICATION_BEFORE_BROWSER_ACKNOWLEDGEMENT',
] as const);

export type EffectCrashBoundary = (typeof EFFECT_CRASH_BOUNDARIES)[number];

export interface EffectRecoveryResult {
  readonly groundTruth: 'NONE' | 'NOT_APPLIED' | 'APPLIED' | 'UNKNOWN';
  readonly recoveryAction:
    | 'RESUME_TASK_PLANNING'
    | 'RECORD_RECONCILED_NOT_APPLIED'
    | 'RECORD_RECONCILED_APPLIED'
    | 'REPUBLISH_DURABLE_OUTBOX'
    | 'OBSERVE_DURABLE_PUBLICATION'
    | 'BLOCK_UNKNOWN';
  readonly continuationAllowed: boolean;
  readonly blockedReason: string | null;
  readonly lookupAttempts: number;
  readonly dispatchedEffects: 0;
  readonly groundTruthDigest: `sha256:${string}` | null;
}

async function boundedLookup(
  executor: ApprovedEffectExecutor,
  authority: EffectAuthorityReference,
  maxAttempts: number,
): Promise<{ readonly truth: EffectGroundTruth; readonly attempts: number }> {
  let truth: EffectGroundTruth = { outcome: 'INDETERMINATE', groundTruthDigest: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      truth = await executor.lookup(authority);
    } catch {
      truth = { outcome: 'INDETERMINATE', groundTruthDigest: null };
    }
    if (truth.outcome !== 'INDETERMINATE') return { truth, attempts: attempt };
  }
  return { truth, attempts: maxAttempts };
}

export async function recoverEffectAfterCrash(input: {
  readonly boundary: EffectCrashBoundary;
  readonly authority: EffectAuthorityReference;
  readonly executor: ApprovedEffectExecutor;
  readonly maxLookupAttempts?: number;
  readonly knownGroundTruth?: EffectGroundTruth;
}): Promise<EffectRecoveryResult> {
  const maxLookupAttempts = input.maxLookupAttempts ?? 3;
  if (!Number.isSafeInteger(maxLookupAttempts) || maxLookupAttempts < 1 || maxLookupAttempts > 10)
    throw new Error('RECONCILIATION_ATTEMPTS_INVALID');
  if (input.boundary === 'BEFORE_EFFECT_INTENT_COMMIT') {
    return Object.freeze({
      groundTruth: 'NONE' as const,
      recoveryAction: 'RESUME_TASK_PLANNING' as const,
      continuationAllowed: true,
      blockedReason: null,
      lookupAttempts: 0,
      dispatchedEffects: 0 as const,
      groundTruthDigest: null,
    });
  }
  if (input.boundary === 'AFTER_EFFECT_COMMIT_BEFORE_OUTBOX_PUBLICATION') {
    return Object.freeze({
      groundTruth: 'APPLIED' as const,
      recoveryAction: 'REPUBLISH_DURABLE_OUTBOX' as const,
      continuationAllowed: true,
      blockedReason: null,
      lookupAttempts: 0,
      dispatchedEffects: 0 as const,
      groundTruthDigest: null,
    });
  }
  if (input.boundary === 'AFTER_OUTBOX_PUBLICATION_BEFORE_BROWSER_ACKNOWLEDGEMENT') {
    return Object.freeze({
      groundTruth: 'APPLIED' as const,
      recoveryAction: 'OBSERVE_DURABLE_PUBLICATION' as const,
      continuationAllowed: true,
      blockedReason: null,
      lookupAttempts: 0,
      dispatchedEffects: 0 as const,
      groundTruthDigest: null,
    });
  }
  const lookedUp =
    input.knownGroundTruth === undefined
      ? await boundedLookup(input.executor, input.authority, maxLookupAttempts)
      : { truth: input.knownGroundTruth, attempts: 1 };
  if (lookedUp.truth.outcome === 'APPLIED') {
    return Object.freeze({
      groundTruth: 'APPLIED' as const,
      recoveryAction: 'RECORD_RECONCILED_APPLIED' as const,
      continuationAllowed: true,
      blockedReason: null,
      lookupAttempts: lookedUp.attempts,
      dispatchedEffects: 0 as const,
      groundTruthDigest: lookedUp.truth.groundTruthDigest ?? null,
    });
  }
  if (lookedUp.truth.outcome === 'NOT_APPLIED') {
    return Object.freeze({
      groundTruth: 'NOT_APPLIED' as const,
      recoveryAction: 'RECORD_RECONCILED_NOT_APPLIED' as const,
      continuationAllowed: true,
      blockedReason: null,
      lookupAttempts: lookedUp.attempts,
      dispatchedEffects: 0 as const,
      groundTruthDigest: null,
    });
  }
  return Object.freeze({
    groundTruth: 'UNKNOWN' as const,
    recoveryAction: 'BLOCK_UNKNOWN' as const,
    continuationAllowed: false,
    blockedReason: 'External effect ground truth remains unknown after bounded reconciliation',
    lookupAttempts: lookedUp.attempts,
    dispatchedEffects: 0 as const,
    groundTruthDigest: null,
  });
}
