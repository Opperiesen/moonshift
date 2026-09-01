import { describe, expect, it } from 'vitest';

import { transitionTask } from '@moonshift/domain';

import {
  DEFAULT_VERIFICATION_POLICY,
  beginVerificationEvaluation,
  commitVerificationEvaluation,
  type VerificationMaterial,
} from './verification-engine.js';

const ids = {
  project: '73000000-0000-4000-8000-000000000001',
  task: '73000000-0000-4000-8000-000000000002',
  execution: '73000000-0000-4000-8000-000000000003',
  author: '73000000-0000-4000-8000-000000000004',
  authorLineage: '73000000-0000-4000-8000-000000000005',
  reviewer: '73000000-0000-4000-8000-000000000006',
  reviewerLineage: '73000000-0000-4000-8000-000000000007',
  contextManifest: '73000000-0000-4000-8000-000000000008',
  artifact: '73000000-0000-4000-8000-000000000009',
};
const revision = '857f0f9b02210000000000000000000000000000';
const artifactHash = `sha256:${'a'.repeat(64)}` as const;

function material(overrides: Partial<VerificationMaterial> = {}): VerificationMaterial {
  const evidence = (['BUILD', 'TEST', 'INTEGRITY', 'COVERAGE', 'REVIEW'] as const).map(
    (type, index) => ({
      evidenceId: `73000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      projectId: ids.project,
      taskId: ids.task,
      producerAgentId: type === 'REVIEW' ? ids.reviewer : ids.author,
      producerLineageId: type === 'REVIEW' ? ids.reviewerLineage : ids.authorLineage,
      type,
      status: 'PASS' as const,
      observedAt: '2026-09-01T09:00:00.000Z',
      gitRevision: revision,
      sourceHash: artifactHash,
    }),
  );
  return {
    projectId: ids.project,
    taskId: ids.task,
    expectedRevision: revision,
    artifact: {
      artifactId: ids.artifact,
      projectId: ids.project,
      taskId: ids.task,
      executionId: ids.execution,
      authorAgentId: ids.author,
      authorLineageId: ids.authorLineage,
      kind: 'FIXTURE_RESULT',
      mediaType: 'application/json',
      size: 128,
      contentHash: artifactHash,
      storageKey: 'aa/fixture.bin',
      gitRevision: revision,
      createdAt: '2026-09-01T09:00:00.000Z',
    },
    evidence,
    review: {
      reviewerAgentId: ids.reviewer,
      reviewerLineageId: ids.reviewerLineage,
      authorAgentId: ids.author,
      authorLineageId: ids.authorLineage,
      contextManifestId: ids.contextManifest,
    },
    policy: DEFAULT_VERIFICATION_POLICY,
    ...overrides,
  };
}

describe('deterministic verification engine', () => {
  it('keeps a runtime completion claim below VERIFIED authority', () => {
    expect(
      transitionTask(
        { state: 'RUNNING', version: 1 },
        'CLAIMED_COMPLETE',
        { type: 'RUNTIME', id: ids.execution },
        1,
      ),
    ).toEqual({ state: 'CLAIMED_COMPLETE', version: 2 });
    expect(() =>
      transitionTask(
        { state: 'VERIFYING', version: 2 },
        'VERIFIED',
        { type: 'RUNTIME', id: ids.execution },
        2,
      ),
    ).toThrow(/VERIFICATION_ENGINE/u);
  });

  it('captures a deeply immutable, revision-bound evidence and policy snapshot', () => {
    const evaluation = beginVerificationEvaluation({
      evaluationId: '73000000-0000-4000-8000-000000000020',
      capturedAt: '2026-09-01T09:01:00.000Z',
      projectState: 'ACTIVE',
      material: material(),
    });

    expect(evaluation.state).toBe('EVALUATING');
    expect(evaluation.snapshot.expectedRevision).toBe(revision);
    expect(evaluation.snapshot.materialHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(evaluation.snapshot)).toBe(true);
    expect(Object.isFrozen(evaluation.snapshot.evidence)).toBe(true);
    expect(Object.isFrozen(evaluation.snapshot.evidence[0])).toBe(true);
    expect(() => {
      (evaluation.snapshot.evidence as unknown as Array<unknown>).push({});
    }).toThrow();
    expect(() => {
      (evaluation.snapshot.policy as { version: number }).version = 99;
    }).toThrow();
  });

  it('verifies only a complete passing matrix reviewed outside the author lineage', () => {
    const current = material();
    const evaluation = beginVerificationEvaluation({
      evaluationId: '73000000-0000-4000-8000-000000000021',
      capturedAt: '2026-09-01T09:01:00.000Z',
      projectState: 'ACTIVE',
      material: current,
    });
    const result = commitVerificationEvaluation({
      evaluation,
      currentMaterial: current,
      projectState: 'ACTIVE',
      task: { state: 'VERIFYING', version: 2 },
      committedAt: '2026-09-01T09:02:00.000Z',
      engineId: '73000000-0000-4000-8000-000000000022',
    });

    expect(result.evaluation.state).toBe('PASSED');
    expect(result.task).toEqual({ state: 'VERIFIED', version: 3 });
    expect(result.blockingReasons).toEqual([]);
    expect(result.ruleResults.every(({ passed }) => passed)).toBe(true);
  });

  it.each([
    {
      name: 'missing build evidence',
      change: (value: VerificationMaterial) => ({
        ...value,
        evidence: value.evidence.filter(({ type }) => type !== 'BUILD'),
      }),
      reason: 'Required BUILD evidence is missing',
    },
    {
      name: 'failing tests',
      change: (value: VerificationMaterial) => ({
        ...value,
        evidence: value.evidence.map((item) =>
          item.type === 'TEST' ? { ...item, status: 'FAIL' as const } : item,
        ),
      }),
      reason: 'Required TEST evidence did not pass',
    },
    {
      name: 'wrong revision',
      change: (value: VerificationMaterial) => ({
        ...value,
        evidence: value.evidence.map((item) =>
          item.type === 'BUILD' ? { ...item, gitRevision: '1'.repeat(40) } : item,
        ),
      }),
      reason: 'BUILD evidence is bound to another revision',
    },
    {
      name: 'tampered artifact integrity',
      change: (value: VerificationMaterial) => ({
        ...value,
        evidence: value.evidence.map((item) =>
          item.type === 'INTEGRITY'
            ? { ...item, sourceHash: `sha256:${'b'.repeat(64)}` as const }
            : item,
        ),
      }),
      reason: 'Artifact integrity evidence does not match the published content hash',
    },
    {
      name: 'same-lineage review',
      change: (value: VerificationMaterial) => ({
        ...value,
        review: { ...value.review, reviewerLineageId: value.review.authorLineageId },
      }),
      reason: 'Quality reviewer must be outside the author lineage',
    },
    {
      name: 'blocking finding',
      change: (value: VerificationMaterial) => ({
        ...value,
        evidence: [
          ...value.evidence,
          {
            ...value.evidence[0]!,
            evidenceId: '73000000-0000-4000-8000-000000000099',
            status: 'BLOCKING' as const,
          },
        ],
      }),
      reason: 'Blocking evidence findings must be resolved',
    },
  ])('blocks $name with explicit remediation', ({ change, reason }) => {
    const current = change(material());
    const evaluation = beginVerificationEvaluation({
      evaluationId: '73000000-0000-4000-8000-000000000023',
      capturedAt: '2026-09-01T09:01:00.000Z',
      projectState: 'ACTIVE',
      material: current,
    });
    const result = commitVerificationEvaluation({
      evaluation,
      currentMaterial: current,
      projectState: 'ACTIVE',
      task: { state: 'VERIFYING', version: 2 },
      committedAt: '2026-09-01T09:02:00.000Z',
      engineId: '73000000-0000-4000-8000-000000000022',
    });

    expect(result.evaluation.state).toBe('FAILED');
    expect(result.task.state).toBe('BLOCKED');
    expect(result.blockingReasons).toContain(reason);
  });

  it.each([
    [
      'policy version',
      (value: VerificationMaterial) => ({
        ...value,
        policy: { ...value.policy, version: value.policy.version + 1 },
      }),
      'Verification policy changed after snapshot capture',
    ],
    [
      'expected revision',
      (value: VerificationMaterial) => ({
        ...value,
        expectedRevision: '2'.repeat(40),
      }),
      'Expected revision changed after snapshot capture',
    ],
    [
      'evidence membership',
      (value: VerificationMaterial) => ({
        ...value,
        evidence: value.evidence.slice(1),
      }),
      'Evidence membership changed after snapshot capture',
    ],
    [
      'evidence hash',
      (value: VerificationMaterial) => ({
        ...value,
        evidence: value.evidence.map((item, index) =>
          index === 0 ? { ...item, sourceHash: `sha256:${'c'.repeat(64)}` as const } : item,
        ),
      }),
      'Evidence content changed after snapshot capture',
    ],
    [
      'artifact hash',
      (value: VerificationMaterial) => ({
        ...value,
        artifact: { ...value.artifact, contentHash: `sha256:${'d'.repeat(64)}` as const },
      }),
      'Published artifact hash changed or bytes failed integrity validation after snapshot capture',
    ],
  ] as const)('marks the captured evaluation stale on %s change', (_name, change, reason) => {
    const captured = material();
    const evaluation = beginVerificationEvaluation({
      evaluationId: '73000000-0000-4000-8000-000000000024',
      capturedAt: '2026-09-01T09:01:00.000Z',
      projectState: 'ACTIVE',
      material: captured,
    });
    const result = commitVerificationEvaluation({
      evaluation,
      currentMaterial: change(captured),
      projectState: 'ACTIVE',
      task: { state: 'VERIFYING', version: 2 },
      committedAt: '2026-09-01T09:02:00.000Z',
      engineId: '73000000-0000-4000-8000-000000000022',
    });

    expect(result.evaluation.state).toBe('STALE');
    expect(result.task).toEqual({ state: 'VERIFYING', version: 2 });
    expect(result.requiresFreshEvaluation).toBe(true);
    expect(result.blockingReasons).toContain(reason);
  });

  it('serializes pause against commit and requires a fresh evaluation after resume', () => {
    const current = material();
    const interrupted = beginVerificationEvaluation({
      evaluationId: '73000000-0000-4000-8000-000000000025',
      capturedAt: '2026-09-01T09:01:00.000Z',
      projectState: 'ACTIVE',
      material: current,
    });
    const pausedCommit = commitVerificationEvaluation({
      evaluation: interrupted,
      currentMaterial: current,
      projectState: 'PAUSED',
      task: { state: 'VERIFYING', version: 2 },
      committedAt: '2026-09-01T09:02:00.000Z',
      engineId: '73000000-0000-4000-8000-000000000022',
    });
    expect(pausedCommit.evaluation.state).toBe('STALE');
    expect(pausedCommit.task.state).toBe('VERIFYING');
    expect(pausedCommit.requiresFreshEvaluation).toBe(true);
    expect(() =>
      beginVerificationEvaluation({
        evaluationId: '73000000-0000-4000-8000-000000000026',
        capturedAt: '2026-09-01T09:03:00.000Z',
        projectState: 'PAUSED',
        material: current,
      }),
    ).toThrow(/PAUSED/u);

    const fresh = beginVerificationEvaluation({
      evaluationId: '73000000-0000-4000-8000-000000000027',
      capturedAt: '2026-09-01T09:04:00.000Z',
      projectState: 'ACTIVE',
      material: current,
    });
    expect(fresh.evaluationId).not.toBe(interrupted.evaluationId);
    expect(
      commitVerificationEvaluation({
        evaluation: fresh,
        currentMaterial: current,
        projectState: 'ACTIVE',
        task: { state: 'VERIFYING', version: 2 },
        committedAt: '2026-09-01T09:05:00.000Z',
        engineId: '73000000-0000-4000-8000-000000000022',
      }).task.state,
    ).toBe('VERIFIED');
  });

  it('may atomically verify during PAUSING without inflating the project to complete', () => {
    const current = material();
    const evaluation = beginVerificationEvaluation({
      evaluationId: '73000000-0000-4000-8000-000000000028',
      capturedAt: '2026-09-01T09:01:00.000Z',
      projectState: 'ACTIVE',
      material: current,
    });
    const result = commitVerificationEvaluation({
      evaluation,
      currentMaterial: current,
      projectState: 'PAUSING',
      task: { state: 'VERIFYING', version: 2 },
      committedAt: '2026-09-01T09:02:00.000Z',
      engineId: '73000000-0000-4000-8000-000000000022',
    });
    expect(result.task.state).toBe('VERIFIED');
    expect(result.projectState).toBe('PAUSING');
  });
});
