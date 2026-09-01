import { compileContext } from '@moonshift/context';
import type { VerificationArtifact } from '@moonshift/verification';

import type { ProjectRecord, QualityReviewRecord } from '../../model.js';

export function routeIndependentQualityReview(input: {
  readonly record: ProjectRecord;
  readonly artifact: VerificationArtifact;
  readonly contextManifestId: string;
  readonly reviewExecutionId: string;
}): QualityReviewRecord {
  const quality = input.record.view.personas.find(({ role }) => role === 'QUALITY');
  if (quality === undefined) throw new Error('Quality persona is unavailable');
  const author = input.record.organization.specialist;
  if (quality.agentId === author.agentId || quality.lineageId === author.lineageId) {
    throw new Error('Quality review routing excludes the Engineering author lineage');
  }
  const task = input.record.view.tasks[0];
  if (task === undefined) throw new Error('Quality review requires one bounded fixture task');
  const contextManifest = compileContext({
    executionId: input.reviewExecutionId,
    taskId: task.taskId,
    agentId: quality.agentId,
    connectionId: input.record.scheduling.routeDecision.selectedConnectionId,
    policyVersion: `${input.record.verification.policy.policyId}:${input.record.verification.policy.version}`,
    destination: 'FAKE_EXECUTION',
    tokenBudget: 1_000,
    inputs: [
      {
        sourceType: 'artifact',
        sourceReference: input.artifact.artifactId,
        revision: input.artifact.gitRevision,
        content: input.artifact.contentHash,
        artifactReference: input.artifact.contentHash,
        classification: 'PUBLIC_FIXTURE',
        inclusionReason: 'Independently inspect the published artifact identity and integrity',
      },
      {
        sourceType: 'acceptance_criteria',
        sourceReference: task.taskId,
        revision: task.expectedRevision,
        content: [
          ...input.record.organization.delegation.expectedOutputs,
          ...input.record.organization.delegation.requiredEvidence,
        ].join('\n'),
        classification: 'PUBLIC_FIXTURE',
        inclusionReason: 'Evaluate the bounded task against its accepted criteria',
      },
      {
        sourceType: 'repository_revision',
        sourceReference: 'fixture-repository',
        revision: task.expectedRevision,
        content: task.expectedRevision,
        classification: 'PUBLIC_FIXTURE',
        inclusionReason: 'Bind Quality review to the controlled fixture revision',
      },
    ],
  });
  return Object.freeze({
    reviewerAgentId: quality.agentId,
    reviewerLineageId: quality.lineageId,
    authorAgentId: author.agentId,
    authorLineageId: author.lineageId,
    contextManifestId: input.contextManifestId,
    contextManifest,
  });
}
