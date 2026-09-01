import { createHash } from 'node:crypto';

import {
  transitionTask,
  type ProjectState,
  type TaskState,
  type VersionedState,
} from '@moonshift/domain';

export type ContentHash = `sha256:${string}`;
export type EvidenceType =
  'BUILD' | 'TEST' | 'INTEGRITY' | 'COVERAGE' | 'REVIEW' | 'APPROVAL' | 'RECONCILIATION';
export type EvidenceStatus = 'PASS' | 'FAIL' | 'MISSING' | 'STALE' | 'BLOCKING';
export type VerificationEvaluationState = 'EVALUATING' | 'PASSED' | 'FAILED' | 'STALE';

export interface VerificationArtifact {
  readonly artifactId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly authorAgentId: string;
  readonly authorLineageId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly size: number;
  readonly contentHash: ContentHash;
  readonly storageKey: string;
  readonly gitRevision: string;
  readonly createdAt: string;
}

export interface VerificationEvidence {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly artifactId?: string;
  readonly producerAgentId: string;
  readonly producerLineageId: string;
  readonly type: EvidenceType;
  readonly status: EvidenceStatus;
  readonly observedAt: string;
  readonly gitRevision: string;
  readonly sourceHash: ContentHash;
}

export interface QualityReviewAssignment {
  readonly reviewerAgentId: string;
  readonly reviewerLineageId: string;
  readonly authorAgentId: string;
  readonly authorLineageId: string;
  readonly contextManifestId: string;
}

export type VerificationRule =
  | {
      readonly ruleId: string;
      readonly version: number;
      readonly kind: 'REQUIRED_EVIDENCE';
      readonly evidenceType: EvidenceType;
    }
  | {
      readonly ruleId: string;
      readonly version: number;
      readonly kind: 'INDEPENDENT_REVIEW';
    }
  | {
      readonly ruleId: string;
      readonly version: number;
      readonly kind: 'NO_BLOCKING_FINDINGS';
    };

export interface VerificationPolicy {
  readonly policyId: string;
  readonly version: number;
  readonly rules: readonly VerificationRule[];
}

export interface VerificationMaterial {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedRevision: string;
  readonly artifact: VerificationArtifact;
  readonly evidence: readonly VerificationEvidence[];
  readonly review: QualityReviewAssignment;
  readonly policy: VerificationPolicy;
}

export interface VerificationSnapshot extends VerificationMaterial {
  readonly materialHash: ContentHash;
}

export interface VerificationRuleResult {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly passed: boolean;
  readonly blockingReason: string | null;
  readonly evidenceIds: readonly string[];
}

export interface VerificationEvaluation {
  readonly evaluationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly state: VerificationEvaluationState;
  readonly capturedAt: string;
  readonly decidedAt: string | null;
  readonly snapshot: VerificationSnapshot;
  readonly ruleResults: readonly VerificationRuleResult[];
  readonly blockingReasons: readonly string[];
}

export interface VerificationCommitResult {
  readonly evaluation: VerificationEvaluation;
  readonly task: VersionedState<TaskState>;
  readonly projectState: ProjectState;
  readonly ruleResults: readonly VerificationRuleResult[];
  readonly blockingReasons: readonly string[];
  readonly requiresFreshEvaluation: boolean;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}

function sha256(value: string): ContentHash {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(JSON.parse(canonical(value)) as T);
}

function normalizedMaterial(material: VerificationMaterial): VerificationMaterial {
  return {
    ...material,
    evidence: [...material.evidence].sort((left, right) =>
      left.evidenceId.localeCompare(right.evidenceId),
    ),
    policy: {
      ...material.policy,
      rules: [...material.policy.rules].sort((left, right) =>
        left.ruleId.localeCompare(right.ruleId),
      ),
    },
  };
}

export function verificationMaterialHash(material: VerificationMaterial): ContentHash {
  return sha256(canonical(normalizedMaterial(material)));
}

const defaultPolicy: VerificationPolicy = {
  policyId: 'moonshift.fixture.verification',
  version: 1,
  rules: [
    { ruleId: 'required-build', version: 1, kind: 'REQUIRED_EVIDENCE', evidenceType: 'BUILD' },
    {
      ruleId: 'required-coverage',
      version: 1,
      kind: 'REQUIRED_EVIDENCE',
      evidenceType: 'COVERAGE',
    },
    {
      ruleId: 'required-integrity',
      version: 1,
      kind: 'REQUIRED_EVIDENCE',
      evidenceType: 'INTEGRITY',
    },
    { ruleId: 'required-review', version: 1, kind: 'REQUIRED_EVIDENCE', evidenceType: 'REVIEW' },
    { ruleId: 'required-test', version: 1, kind: 'REQUIRED_EVIDENCE', evidenceType: 'TEST' },
    { ruleId: 'independent-review', version: 1, kind: 'INDEPENDENT_REVIEW' },
    { ruleId: 'no-blocking-findings', version: 1, kind: 'NO_BLOCKING_FINDINGS' },
  ],
};

export const DEFAULT_VERIFICATION_POLICY = immutableCopy(defaultPolicy);

function requiredEvidenceResult(
  rule: Extract<VerificationRule, { readonly kind: 'REQUIRED_EVIDENCE' }>,
  snapshot: VerificationSnapshot,
): VerificationRuleResult {
  const evidence = snapshot.evidence.filter(({ type }) => type === rule.evidenceType);
  let blockingReason: string | null = null;
  if (evidence.length === 0) {
    blockingReason = `Required ${rule.evidenceType} evidence is missing`;
  } else if (evidence.some(({ status }) => status !== 'PASS')) {
    blockingReason = `Required ${rule.evidenceType} evidence did not pass`;
  } else if (evidence.some(({ gitRevision }) => gitRevision !== snapshot.expectedRevision)) {
    blockingReason = `${rule.evidenceType} evidence is bound to another revision`;
  } else if (
    rule.evidenceType === 'INTEGRITY' &&
    evidence.some(({ sourceHash }) => sourceHash !== snapshot.artifact.contentHash)
  ) {
    blockingReason = 'Artifact integrity evidence does not match the published content hash';
  } else if (
    rule.evidenceType === 'REVIEW' &&
    evidence.some(
      ({ producerAgentId, producerLineageId }) =>
        producerAgentId !== snapshot.review.reviewerAgentId ||
        producerLineageId !== snapshot.review.reviewerLineageId,
    )
  ) {
    blockingReason = 'Review evidence is not attributable to the assigned Quality reviewer';
  }
  return immutableCopy({
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    passed: blockingReason === null,
    blockingReason,
    evidenceIds: evidence.map(({ evidenceId }) => evidenceId),
  });
}

function evaluateRule(
  rule: VerificationRule,
  snapshot: VerificationSnapshot,
): VerificationRuleResult {
  if (rule.kind === 'REQUIRED_EVIDENCE') return requiredEvidenceResult(rule, snapshot);
  if (rule.kind === 'INDEPENDENT_REVIEW') {
    const independent =
      snapshot.review.authorAgentId === snapshot.artifact.authorAgentId &&
      snapshot.review.authorLineageId === snapshot.artifact.authorLineageId &&
      snapshot.review.reviewerAgentId !== snapshot.review.authorAgentId &&
      snapshot.review.reviewerLineageId !== snapshot.review.authorLineageId;
    return immutableCopy({
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      passed: independent,
      blockingReason: independent ? null : 'Quality reviewer must be outside the author lineage',
      evidenceIds: snapshot.evidence
        .filter(({ type }) => type === 'REVIEW')
        .map(({ evidenceId }) => evidenceId),
    });
  }
  const blocking = snapshot.evidence.filter(({ status }) => status === 'BLOCKING');
  return immutableCopy({
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    passed: blocking.length === 0,
    blockingReason: blocking.length === 0 ? null : 'Blocking evidence findings must be resolved',
    evidenceIds: blocking.map(({ evidenceId }) => evidenceId),
  });
}

function validateMaterialBinding(material: VerificationMaterial): string[] {
  const reasons: string[] = [];
  if (
    material.artifact.projectId !== material.projectId ||
    material.artifact.taskId !== material.taskId
  ) {
    reasons.push('Published artifact attribution does not match the evaluation target');
  }
  if (material.artifact.gitRevision !== material.expectedRevision) {
    reasons.push('Published artifact is bound to another revision');
  }
  if (
    material.evidence.some(
      ({ projectId, taskId }) => projectId !== material.projectId || taskId !== material.taskId,
    )
  ) {
    reasons.push('Evidence attribution does not match the evaluation target');
  }
  return reasons;
}

export function beginVerificationEvaluation(input: {
  readonly evaluationId: string;
  readonly capturedAt: string;
  readonly projectState: ProjectState;
  readonly material: VerificationMaterial;
}): VerificationEvaluation {
  if (input.projectState !== 'ACTIVE') {
    throw new Error(`Verification evaluation cannot start while Project is ${input.projectState}`);
  }
  const material = immutableCopy(normalizedMaterial(input.material));
  const snapshot = immutableCopy({
    ...material,
    materialHash: verificationMaterialHash(material),
  });
  return immutableCopy({
    evaluationId: input.evaluationId,
    projectId: material.projectId,
    taskId: material.taskId,
    state: 'EVALUATING' as const,
    capturedAt: input.capturedAt,
    decidedAt: null,
    snapshot,
    ruleResults: [],
    blockingReasons: [],
  });
}

function staleResult(
  input: Parameters<typeof commitVerificationEvaluation>[0],
  reason: string,
): VerificationCommitResult {
  const blockingReasons = immutableCopy([reason]);
  const evaluation = immutableCopy({
    ...input.evaluation,
    state: 'STALE' as const,
    decidedAt: input.committedAt,
    blockingReasons,
  });
  return immutableCopy({
    evaluation,
    task: input.task,
    projectState: input.projectState,
    ruleResults: [],
    blockingReasons,
    requiresFreshEvaluation: true,
  });
}

function changedMaterialReason(
  snapshot: VerificationSnapshot,
  current: VerificationMaterial,
): string {
  const normalizedCurrent = normalizedMaterial(current);
  if (canonical(snapshot.policy) !== canonical(normalizedCurrent.policy)) {
    return 'Verification policy changed after snapshot capture';
  }
  if (snapshot.expectedRevision !== current.expectedRevision) {
    return 'Expected revision changed after snapshot capture';
  }
  if (snapshot.artifact.contentHash !== current.artifact.contentHash) {
    return 'Published artifact hash changed or bytes failed integrity validation after snapshot capture';
  }
  if (canonical(snapshot.artifact) !== canonical(current.artifact)) {
    return 'Published artifact metadata changed after snapshot capture';
  }
  const snapshotEvidenceIds = snapshot.evidence.map(({ evidenceId }) => evidenceId).sort();
  const currentEvidenceIds = current.evidence.map(({ evidenceId }) => evidenceId).sort();
  if (canonical(snapshotEvidenceIds) !== canonical(currentEvidenceIds)) {
    return 'Evidence membership changed after snapshot capture';
  }
  if (canonical(snapshot.evidence) !== canonical(normalizedCurrent.evidence)) {
    return 'Evidence content changed after snapshot capture';
  }
  if (canonical(snapshot.review) !== canonical(current.review)) {
    return 'Quality review assignment changed after snapshot capture';
  }
  return 'Verification inputs changed after snapshot capture';
}

export function commitVerificationEvaluation(input: {
  readonly evaluation: VerificationEvaluation;
  readonly currentMaterial: VerificationMaterial;
  readonly projectState: ProjectState;
  readonly task: VersionedState<TaskState>;
  readonly committedAt: string;
  readonly engineId: string;
}): VerificationCommitResult {
  if (input.evaluation.state !== 'EVALUATING') {
    throw new Error('Only an EVALUATING verification can commit');
  }
  if (input.evaluation.taskId !== input.currentMaterial.taskId) {
    return staleResult(input, 'Verification target changed after snapshot capture');
  }
  if (input.projectState === 'PAUSED') {
    return staleResult(input, 'Project reached PAUSED before verification commit');
  }
  if (input.projectState !== 'ACTIVE' && input.projectState !== 'PAUSING') {
    return staleResult(input, 'Project control state no longer permits verification commit');
  }
  if (input.evaluation.snapshot.materialHash !== verificationMaterialHash(input.currentMaterial)) {
    return staleResult(
      input,
      changedMaterialReason(input.evaluation.snapshot, input.currentMaterial),
    );
  }

  const bindingReasons = validateMaterialBinding(input.evaluation.snapshot);
  const ruleResults = immutableCopy(
    input.evaluation.snapshot.policy.rules.map((rule) =>
      evaluateRule(rule, input.evaluation.snapshot),
    ),
  );
  const blockingReasons = immutableCopy(
    [
      ...bindingReasons,
      ...ruleResults.flatMap(({ blockingReason }) =>
        blockingReason === null ? [] : [blockingReason],
      ),
    ].filter((reason, index, all) => all.indexOf(reason) === index),
  );
  const passed = blockingReasons.length === 0;
  const task = transitionTask(
    input.task,
    passed ? 'VERIFIED' : 'BLOCKED',
    { type: 'VERIFICATION_ENGINE', id: input.engineId },
    input.task.version,
    { projectState: input.projectState },
  );
  const evaluation = immutableCopy({
    ...input.evaluation,
    state: passed ? ('PASSED' as const) : ('FAILED' as const),
    decidedAt: input.committedAt,
    ruleResults,
    blockingReasons,
  });
  return immutableCopy({
    evaluation,
    task,
    projectState: input.projectState,
    ruleResults,
    blockingReasons,
    requiresFreshEvaluation: false,
  });
}
