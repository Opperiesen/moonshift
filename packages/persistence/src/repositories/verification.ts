import type { PoolClient } from 'pg';

import type {
  VerificationArtifact,
  VerificationEvaluation,
  VerificationEvidence,
  VerificationPolicy,
} from '@moonshift/verification';

export interface VerificationPersistenceRecord {
  readonly policy: VerificationPolicy;
  readonly artifacts: readonly VerificationArtifact[];
  readonly evidence: readonly VerificationEvidence[];
  readonly evaluations: readonly VerificationEvaluation[];
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

function assertSame(label: string, expected: unknown, actual: unknown): void {
  if (canonical(expected) !== canonical(actual)) {
    throw new Error(`${label} is immutable and cannot be replaced`);
  }
}

async function persistPolicy(client: PoolClient, policy: VerificationPolicy): Promise<void> {
  await client.query(
    `INSERT INTO verification_policies (policy_id, version, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (policy_id, version) DO NOTHING`,
    [policy.policyId, policy.version, policy],
  );
  const stored = await client.query<{ payload: VerificationPolicy }>(
    `SELECT payload FROM verification_policies WHERE policy_id = $1 AND version = $2`,
    [policy.policyId, policy.version],
  );
  assertSame('Verification policy version', policy, stored.rows[0]?.payload);
  for (const rule of policy.rules) {
    await client.query(
      `INSERT INTO verification_rules
        (policy_id, policy_version, rule_id, rule_version, kind, evidence_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (policy_id, policy_version, rule_id, rule_version) DO NOTHING`,
      [
        policy.policyId,
        policy.version,
        rule.ruleId,
        rule.version,
        rule.kind,
        rule.kind === 'REQUIRED_EVIDENCE' ? rule.evidenceType : null,
        rule,
      ],
    );
    const storedRule = await client.query<{ payload: unknown }>(
      `SELECT payload FROM verification_rules
       WHERE policy_id = $1 AND policy_version = $2 AND rule_id = $3 AND rule_version = $4`,
      [policy.policyId, policy.version, rule.ruleId, rule.version],
    );
    assertSame('Verification rule version', rule, storedRule.rows[0]?.payload);
  }
}

async function persistArtifact(client: PoolClient, artifact: VerificationArtifact): Promise<void> {
  await client.query(
    `INSERT INTO verification_artifacts
      (artifact_id, project_id, task_id, execution_id, author_agent_id, author_lineage_id,
       kind, media_type, size, content_hash, storage_key, git_revision, created_at, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (artifact_id) DO NOTHING`,
    [
      artifact.artifactId,
      artifact.projectId,
      artifact.taskId,
      artifact.executionId,
      artifact.authorAgentId,
      artifact.authorLineageId,
      artifact.kind,
      artifact.mediaType,
      artifact.size,
      artifact.contentHash,
      artifact.storageKey,
      artifact.gitRevision,
      artifact.createdAt,
      artifact,
    ],
  );
  const stored = await client.query<{ payload: VerificationArtifact }>(
    'SELECT payload FROM verification_artifacts WHERE artifact_id = $1',
    [artifact.artifactId],
  );
  assertSame('Artifact identity', artifact, stored.rows[0]?.payload);
}

async function persistEvidence(client: PoolClient, evidence: VerificationEvidence): Promise<void> {
  await client.query(
    `INSERT INTO verification_evidence
      (evidence_id, project_id, task_id, artifact_id, producer_agent_id, producer_lineage_id,
       evidence_type, status, observed_at, git_revision, source_hash, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (evidence_id) DO NOTHING`,
    [
      evidence.evidenceId,
      evidence.projectId,
      evidence.taskId,
      evidence.artifactId ?? null,
      evidence.producerAgentId,
      evidence.producerLineageId,
      evidence.type,
      evidence.status,
      evidence.observedAt,
      evidence.gitRevision,
      evidence.sourceHash,
      evidence,
    ],
  );
  const stored = await client.query<{ payload: VerificationEvidence }>(
    'SELECT payload FROM verification_evidence WHERE evidence_id = $1',
    [evidence.evidenceId],
  );
  assertSame('Evidence identity', evidence, stored.rows[0]?.payload);
}

async function persistEvaluation(
  client: PoolClient,
  evaluation: VerificationEvaluation,
): Promise<void> {
  const existing = await client.query<{
    snapshot_hash: string;
    state: VerificationEvaluation['state'];
    payload: VerificationEvaluation;
  }>(
    `SELECT snapshot_hash, state, payload FROM verification_evaluations
     WHERE evaluation_id = $1 FOR UPDATE`,
    [evaluation.evaluationId],
  );
  const current = existing.rows[0];
  if (current === undefined) {
    await client.query(
      `INSERT INTO verification_evaluations
        (evaluation_id, project_id, task_id, artifact_id, policy_id, policy_version,
         expected_revision, snapshot_hash, state, captured_at, decided_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        evaluation.evaluationId,
        evaluation.projectId,
        evaluation.taskId,
        evaluation.snapshot.artifact.artifactId,
        evaluation.snapshot.policy.policyId,
        evaluation.snapshot.policy.version,
        evaluation.snapshot.expectedRevision,
        evaluation.snapshot.materialHash,
        evaluation.state,
        evaluation.capturedAt,
        evaluation.decidedAt,
        evaluation,
      ],
    );
    return;
  }
  if (current.snapshot_hash !== evaluation.snapshot.materialHash) {
    throw new Error('Verification evaluation snapshot is immutable and cannot be replaced');
  }
  if (current.state === evaluation.state) {
    assertSame('Verification evaluation decision', evaluation, current.payload);
    return;
  }
  if (current.state !== 'EVALUATING' || evaluation.state === 'EVALUATING') {
    throw new Error('Verification evaluation has an immutable terminal decision');
  }
  assertSame('Verification evaluation snapshot', evaluation.snapshot, current.payload.snapshot);
  await client.query(
    `UPDATE verification_evaluations
     SET state = $2, decided_at = $3, payload = $4
     WHERE evaluation_id = $1`,
    [evaluation.evaluationId, evaluation.state, evaluation.decidedAt, evaluation],
  );
}

/** Persists the verification write-set inside the caller's project transaction. */
export async function persistVerificationRecords(
  client: PoolClient,
  record: VerificationPersistenceRecord,
): Promise<void> {
  if (
    record.artifacts.length === 0 &&
    record.evidence.length === 0 &&
    record.evaluations.length === 0
  ) {
    return;
  }
  await persistPolicy(client, record.policy);
  for (const artifact of record.artifacts) await persistArtifact(client, artifact);
  for (const evidence of record.evidence) await persistEvidence(client, evidence);
  for (const evaluation of record.evaluations) await persistEvaluation(client, evaluation);
}
