import { createHash } from 'node:crypto';

import type { FsArtifactStore } from '@moonshift/artifacts';
import { transitionExecution, transitionTask, type TaskState } from '@moonshift/domain';
import {
  beginVerificationEvaluation,
  commitVerificationEvaluation,
  type QualityReviewAssignment,
  type VerificationArtifact,
  type VerificationCommitResult,
  type VerificationEvidence,
  type VerificationMaterial,
} from '@moonshift/verification';

import { ControlPlaneError } from '../../errors.js';
import type {
  ProjectEvent,
  ProjectRecord,
  ProjectView,
  QualityReviewRecord,
  VerificationRecord,
} from '../../model.js';
import { appendSupervisionMutation } from '../../projections/supervision-events.js';
import { commandRequestHash, type ProjectRepository } from '../projects/repository.js';
import { publishFixtureArtifactAndClaim } from './claims.js';
import { routeIndependentQualityReview } from './review-routing.js';

export type FixtureVerificationDisposition =
  'PASS' | 'FAIL' | 'UNVERIFIED' | 'WRONG_LINEAGE' | 'TAMPERED' | 'STALE';

const INVALID_CURRENT_ARTIFACT_HASH = `sha256:${'0'.repeat(64)}` as const;

type VerificationMutation = {
  readonly record: ProjectRecord;
  readonly tasks?: ProjectView['tasks'];
  readonly status?: ProjectView['status'];
  readonly verification: VerificationRecord;
  readonly supervisionVerification: ProjectRecord['supervision']['verification'];
  readonly blockedReasons?: readonly string[];
  readonly events: readonly {
    readonly kind: ProjectEvent['kind'];
    readonly actor: ProjectEvent['actor'];
    readonly aggregate: ProjectEvent['aggregate'];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly classification?: ProjectEvent['classification'];
  }[];
  readonly audits: readonly {
    readonly actorType: ProjectRecord['supervision']['audit'][number]['actorType'];
    readonly actorId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason: string;
    readonly outcome: string;
  }[];
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly nextId: () => string;
  readonly completeExecution?: boolean;
};

function replaceVerificationRecord(input: VerificationMutation): ProjectRecord {
  const appended = appendSupervisionMutation({
    record: input.record,
    events: input.events,
    audits: input.audits,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    nextId: input.nextId,
  });
  const lastSequence = appended.events.at(-1)?.sequence ?? input.record.view.lastSequence;
  const specialistId = input.record.organization.specialist.agentId;
  return Object.freeze({
    ...input.record,
    view: Object.freeze({
      ...input.record.view,
      status: input.status ?? input.record.view.status,
      version: input.record.view.version + 1,
      tasks: input.tasks ?? input.record.view.tasks,
      presences: input.completeExecution
        ? Object.freeze(
            input.record.view.presences.map((presence) =>
              presence.agentId === specialistId
                ? Object.freeze({
                    ...presence,
                    state: 'COMPLETED' as const,
                    sourceType: 'TASK' as const,
                    sourceId: input.record.view.tasks[0]?.taskId ?? presence.sourceId,
                    updatedAt: input.occurredAt,
                    activity: 'Fixture execution claimed completion',
                  })
                : presence,
            ),
          )
        : input.record.view.presences,
      capacity: input.completeExecution
        ? Object.freeze({
            ...input.record.view.capacity,
            activeCognitiveRuns: Math.max(0, input.record.view.capacity.activeCognitiveRuns - 1),
            activeRunnerJobs: 0,
          })
        : input.record.view.capacity,
      lastSequence,
    }),
    scheduling: input.completeExecution
      ? Object.freeze({
          ...input.record.scheduling,
          execution: Object.freeze({
            ...input.record.scheduling.execution,
            state: 'SUCCEEDED' as const,
          }),
          runtime: Object.freeze({
            ...input.record.scheduling.runtime,
            status: 'RUNNING' as const,
          }),
          queueReason: null,
        })
      : input.record.scheduling,
    supervision: Object.freeze({
      ...input.record.supervision,
      authority: input.completeExecution
        ? Object.freeze({
            ...input.record.supervision.authority,
            executionState: 'SUCCEEDED' as const,
          })
        : input.record.supervision.authority,
      verification: input.supervisionVerification,
      blockedReasons: Object.freeze(
        input.blockedReasons ?? input.record.supervision.blockedReasons,
      ),
      audit: appended.audit,
    }),
    verification: Object.freeze(input.verification),
    events: Object.freeze([...input.record.events, ...appended.events]),
  });
}

function replaceTaskState(record: ProjectRecord, state: TaskState): ProjectView['tasks'] {
  return Object.freeze(
    record.view.tasks.map((task, index) =>
      index === 0 ? Object.freeze({ ...task, state }) : task,
    ),
  );
}

function latestAggregateVersion(record: ProjectRecord, type: string, id: string): number {
  return record.events.reduce(
    (version, event) =>
      event.aggregate.type === type && event.aggregate.id === id
        ? Math.max(version, event.aggregate.version)
        : version,
    0,
  );
}

function stableFixtureArtifactId(record: ProjectRecord): string {
  const task = record.view.tasks[0];
  if (task === undefined) throw new Error('Verification requires one bounded fixture task');
  const digest = createHash('sha256')
    .update(
      [
        'moonshift-fixture-artifact',
        record.view.projectId,
        task.taskId,
        record.scheduling.execution.executionId,
        task.expectedRevision,
      ].join(':'),
    )
    .digest('hex');
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function stableUuid(namespace: string, ...values: readonly string[]): string {
  const digest = createHash('sha256')
    .update([namespace, ...values].join(':'))
    .digest('hex');
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function executionCompletionEvents(
  record: ProjectRecord,
  systemId: string,
): readonly VerificationMutation['events'][number][] {
  const execution = record.scheduling.execution;
  let current = {
    state: execution.state,
    version: latestAggregateVersion(record, 'EXECUTION', execution.executionId),
  };
  const events: VerificationMutation['events'][number][] = [];
  if (current.state !== 'RUNNING') {
    const running = transitionExecution(
      current,
      'RUNNING',
      { type: 'SYSTEM', id: systemId },
      current.version,
    );
    events.push({
      kind: 'execution.state_changed',
      actor: { type: 'SYSTEM', id: systemId },
      aggregate: {
        type: 'EXECUTION',
        id: execution.executionId,
        version: running.version,
      },
      payload: {
        fromState: current.state,
        toState: running.state,
        reasonCode: 'APPROVED_EFFECT_COMPLETED',
        summary: 'Fixture execution resumed after the approved effect completed',
      },
    });
    current = running;
  }
  const succeeded = transitionExecution(
    current,
    'SUCCEEDED',
    { type: 'SYSTEM', id: systemId },
    current.version,
  );
  events.push({
    kind: 'execution.state_changed',
    actor: { type: 'SYSTEM', id: systemId },
    aggregate: {
      type: 'EXECUTION',
      id: execution.executionId,
      version: succeeded.version,
    },
    payload: {
      fromState: current.state,
      toState: succeeded.state,
      reasonCode: 'FIXTURE_EXECUTION_CLAIMED_COMPLETE',
      summary: 'Fixture execution ended after publishing its completion claim',
    },
  });
  return Object.freeze(events);
}

function evidenceFor(input: {
  readonly record: ProjectRecord;
  readonly artifact: VerificationArtifact;
  readonly review: QualityReviewAssignment;
  readonly disposition: Exclude<FixtureVerificationDisposition, 'UNVERIFIED'>;
  readonly observedAt: string;
  readonly nextId: () => string;
}): readonly VerificationEvidence[] {
  const types = ['BUILD', 'TEST', 'INTEGRITY', 'COVERAGE', 'REVIEW'] as const;
  return Object.freeze(
    types.map((type) => {
      const reviewEvidence = type === 'REVIEW';
      const tampered = input.disposition === 'TAMPERED' && type === 'INTEGRITY';
      return Object.freeze({
        evidenceId: input.nextId(),
        projectId: input.record.view.projectId,
        taskId: input.artifact.taskId,
        artifactId: input.artifact.artifactId,
        producerAgentId: reviewEvidence
          ? input.review.reviewerAgentId
          : input.artifact.authorAgentId,
        producerLineageId: reviewEvidence
          ? input.review.reviewerLineageId
          : input.artifact.authorLineageId,
        type,
        status:
          input.disposition === 'FAIL' && type === 'TEST' ? ('FAIL' as const) : ('PASS' as const),
        observedAt: input.observedAt,
        gitRevision: input.artifact.gitRevision,
        sourceHash: tampered ? (`sha256:${'0'.repeat(64)}` as const) : input.artifact.contentHash,
      });
    }),
  );
}

function material(record: ProjectRecord, evaluationId?: string): VerificationMaterial {
  const evaluation =
    evaluationId === undefined
      ? undefined
      : record.verification.evaluations.find((item) => item.evaluationId === evaluationId);
  const artifactId = evaluation?.snapshot.artifact.artifactId;
  const artifact =
    (artifactId === undefined
      ? record.verification.artifacts.at(-1)
      : record.verification.artifacts.find((item) => item.artifactId === artifactId)) ?? null;
  const review = record.verification.review;
  const task = record.view.tasks[0];
  if (artifact === null || review === null || task === undefined)
    throw new Error('Verification material is incomplete');
  return {
    projectId: record.view.projectId,
    taskId: task.taskId,
    expectedRevision: task.expectedRevision,
    artifact,
    evidence: record.verification.evidence,
    review,
    policy: record.verification.policy,
  };
}

export class VerificationService {
  private readonly fixtureDispositions = new Map<string, FixtureVerificationDisposition>();

  constructor(
    private readonly dependencies: {
      readonly repository: ProjectRepository;
      readonly artifactStore: FsArtifactStore;
      readonly nextId: () => string;
      readonly expectedRevision: string;
      readonly systemId: string;
      readonly engineId: string;
    },
  ) {}

  setFixtureDisposition(projectId: string, disposition: FixtureVerificationDisposition): void {
    this.fixtureDispositions.set(projectId, disposition);
  }

  private async record(projectId: string): Promise<ProjectRecord> {
    const record = await this.dependencies.repository.get(projectId);
    if (record === null) throw new ControlPlaneError('PROJECT_NOT_FOUND', 'Project not found', 404);
    return record;
  }

  async prepareFixtureEvaluation(input: {
    readonly projectId: string;
    readonly correlationId: string;
    readonly disposition: FixtureVerificationDisposition;
  }): Promise<{
    readonly artifact: VerificationArtifact;
    readonly evidence: readonly VerificationEvidence[];
    readonly evaluation: ReturnType<typeof beginVerificationEvaluation>;
    readonly taskState: TaskState;
  }> {
    if (input.disposition === 'UNVERIFIED') {
      throw new Error('UNVERIFIED fixture preparation stops at the completion claim');
    }
    const disposition = input.disposition as Exclude<FixtureVerificationDisposition, 'UNVERIFIED'>;
    const result = await this.dependencies.repository.mutate({
      scope: `verification-prepare:${input.projectId}`,
      idempotencyKey: `verification-prepare:${input.disposition}`,
      requestHash: commandRequestHash(input),
      projectId: input.projectId,
      mutate: async (record, authorityNow) => {
        if (record.view.status !== 'ACTIVE') {
          throw new ControlPlaneError(
            'VERIFICATION_PROJECT_STATE',
            `Verification cannot start while Project is ${record.view.status}`,
            409,
          );
        }
        const artifactId = stableFixtureArtifactId(record);
        const { artifact, claimedTask } = await publishFixtureArtifactAndClaim({
          record,
          artifactStore: this.dependencies.artifactStore,
          artifactId,
          occurredAt: authorityNow,
        });
        let review: QualityReviewRecord = routeIndependentQualityReview({
          record,
          artifact,
          contextManifestId: this.dependencies.nextId(),
          reviewExecutionId: this.dependencies.nextId(),
        });
        if (input.disposition === 'WRONG_LINEAGE') {
          review = Object.freeze({
            ...review,
            reviewerLineageId: review.authorLineageId,
          });
        }
        const evidence = evidenceFor({
          record,
          artifact,
          review,
          disposition,
          observedAt: authorityNow,
          nextId: this.dependencies.nextId,
        });
        const verifyingTask = transitionTask(
          claimedTask,
          'VERIFYING',
          { type: 'SYSTEM', id: this.dependencies.systemId },
          claimedTask.version,
          { projectState: record.view.status },
        );
        const evaluation = beginVerificationEvaluation({
          evaluationId: this.dependencies.nextId(),
          capturedAt: authorityNow,
          projectState: record.view.status,
          material: {
            projectId: record.view.projectId,
            taskId: artifact.taskId,
            expectedRevision: this.dependencies.expectedRevision,
            artifact,
            evidence,
            review,
            policy: record.verification.policy,
          },
        });
        const executionEvents = executionCompletionEvents(record, this.dependencies.systemId);
        const verification: VerificationRecord = Object.freeze({
          ...record.verification,
          taskVersion: verifyingTask.version,
          artifacts: Object.freeze([...record.verification.artifacts, artifact]),
          evidence: Object.freeze([...record.verification.evidence, ...evidence]),
          review,
          evaluations: Object.freeze([...record.verification.evaluations, evaluation]),
        });
        const events: VerificationMutation['events'][number][] = [
          ...executionEvents,
          {
            kind: 'artifact.published',
            actor: {
              type: 'SPECIALIST',
              id: artifact.authorAgentId,
              lineageId: artifact.authorLineageId,
            },
            aggregate: { type: 'ARTIFACT', id: artifact.artifactId, version: 1 },
            payload: {
              referenceType: 'ARTIFACT',
              referenceId: artifact.artifactId,
              contentHash: artifact.contentHash,
              summary: 'Specialist published a revision-bound fixture artifact',
            },
          },
          {
            kind: 'task.state_changed',
            actor: {
              type: 'SPECIALIST',
              id: artifact.authorAgentId,
              lineageId: artifact.authorLineageId,
            },
            aggregate: { type: 'TASK', id: artifact.taskId, version: claimedTask.version },
            payload: {
              fromState: 'RUNNING',
              toState: 'CLAIMED_COMPLETE',
              reasonCode: 'SPECIALIST_COMPLETION_CLAIMED',
              summary: 'Specialist claim stopped below verified completion',
            },
          },
          ...evidence.map((item) => ({
            kind: 'evidence.recorded' as const,
            actor: {
              type: item.type === 'REVIEW' ? ('PERSONA' as const) : ('SYSTEM' as const),
              id: item.producerAgentId,
              lineageId: item.producerLineageId,
            },
            aggregate: { type: 'EVIDENCE' as const, id: item.evidenceId, version: 1 },
            payload: {
              referenceType: 'EVIDENCE',
              referenceId: item.evidenceId,
              contentHash: item.sourceHash,
              summary: `${item.type} evidence recorded as ${item.status}`,
            },
          })),
          {
            kind: 'task.state_changed',
            actor: { type: 'SYSTEM', id: this.dependencies.systemId },
            aggregate: { type: 'TASK', id: artifact.taskId, version: verifyingTask.version },
            payload: {
              fromState: 'CLAIMED_COMPLETE',
              toState: 'VERIFYING',
              reasonCode: 'INDEPENDENT_QUALITY_ASSIGNED',
              summary: 'Independent Quality evaluation captured immutable evidence',
            },
          },
        ];
        const changed = replaceVerificationRecord({
          record,
          tasks: replaceTaskState(record, 'VERIFYING'),
          verification,
          supervisionVerification: Object.freeze({ state: 'EVALUATING' }),
          blockedReasons: [],
          events,
          audits: [
            {
              actorType: 'SPECIALIST',
              actorId: artifact.authorAgentId,
              action: 'completion.claimed',
              targetType: 'TASK',
              targetId: artifact.taskId,
              reason: 'Published revision-bound fixture artifact',
              outcome: 'CLAIMED_COMPLETE',
            },
            {
              actorType: 'SYSTEM',
              actorId: this.dependencies.systemId,
              action: 'verification.started',
              targetType: 'TASK',
              targetId: artifact.taskId,
              reason: 'Independent Quality context and evidence snapshot captured',
              outcome: 'EVALUATING',
            },
          ],
          occurredAt: authorityNow,
          correlationId: input.correlationId,
          nextId: this.dependencies.nextId,
          completeExecution: true,
        });
        return {
          record: changed,
          response: Object.freeze({
            artifact,
            evidence,
            evaluation,
            taskState: 'VERIFYING' as const,
          }),
        };
      },
    });
    return result.response;
  }

  private async publishUnverifiedClaim(input: {
    readonly projectId: string;
    readonly correlationId: string;
  }): Promise<void> {
    await this.dependencies.repository.mutate({
      scope: `verification-claim:${input.projectId}`,
      idempotencyKey: 'verification-unverified-claim',
      requestHash: commandRequestHash(input),
      projectId: input.projectId,
      mutate: async (record, authorityNow) => {
        const { artifact, claimedTask } = await publishFixtureArtifactAndClaim({
          record,
          artifactStore: this.dependencies.artifactStore,
          artifactId: stableFixtureArtifactId(record),
          occurredAt: authorityNow,
        });
        const verification: VerificationRecord = Object.freeze({
          ...record.verification,
          taskVersion: claimedTask.version,
          artifacts: Object.freeze([...record.verification.artifacts, artifact]),
        });
        const executionEvents = executionCompletionEvents(record, this.dependencies.systemId);
        const changed = replaceVerificationRecord({
          record,
          tasks: replaceTaskState(record, 'CLAIMED_COMPLETE'),
          verification,
          supervisionVerification: Object.freeze({ state: 'NONE' }),
          blockedReasons: [],
          events: [
            ...executionEvents,
            {
              kind: 'artifact.published',
              actor: {
                type: 'SPECIALIST',
                id: artifact.authorAgentId,
                lineageId: artifact.authorLineageId,
              },
              aggregate: { type: 'ARTIFACT', id: artifact.artifactId, version: 1 },
              payload: {
                referenceType: 'ARTIFACT',
                referenceId: artifact.artifactId,
                contentHash: artifact.contentHash,
                summary: 'Specialist published a revision-bound fixture artifact',
              },
            },
            {
              kind: 'task.state_changed',
              actor: {
                type: 'SPECIALIST',
                id: artifact.authorAgentId,
                lineageId: artifact.authorLineageId,
              },
              aggregate: { type: 'TASK', id: artifact.taskId, version: claimedTask.version },
              payload: {
                fromState: 'RUNNING',
                toState: 'CLAIMED_COMPLETE',
                reasonCode: 'SPECIALIST_COMPLETION_CLAIMED',
                summary: 'Specialist claim stopped below verified completion',
              },
            },
          ],
          audits: [
            {
              actorType: 'SPECIALIST',
              actorId: artifact.authorAgentId,
              action: 'completion.claimed',
              targetType: 'TASK',
              targetId: artifact.taskId,
              reason: 'Published revision-bound fixture artifact',
              outcome: 'CLAIMED_COMPLETE',
            },
          ],
          occurredAt: authorityNow,
          correlationId: input.correlationId,
          nextId: this.dependencies.nextId,
          completeExecution: true,
        });
        return { record: changed, response: null };
      },
    });
  }

  async recordEvidence(input: {
    readonly projectId: string;
    readonly correlationId: string;
    readonly evidence: VerificationEvidence;
  }): Promise<VerificationEvidence> {
    const result = await this.dependencies.repository.mutate({
      scope: `verification-evidence:${input.projectId}`,
      idempotencyKey: input.evidence.evidenceId,
      requestHash: commandRequestHash({ ...input.evidence }),
      projectId: input.projectId,
      mutate: async (record, authorityNow) => {
        if (
          input.evidence.projectId !== record.view.projectId ||
          input.evidence.taskId !== record.view.tasks[0]?.taskId
        ) {
          throw new ControlPlaneError(
            'EVIDENCE_ATTRIBUTION_MISMATCH',
            'Evidence does not belong to the project task',
          );
        }
        const verification: VerificationRecord = Object.freeze({
          ...record.verification,
          evidence: Object.freeze([...record.verification.evidence, Object.freeze(input.evidence)]),
        });
        return {
          record: replaceVerificationRecord({
            record,
            verification,
            supervisionVerification: record.supervision.verification,
            events: [
              {
                kind: 'evidence.recorded',
                actor: { type: 'SYSTEM', id: input.evidence.producerAgentId },
                aggregate: { type: 'EVIDENCE', id: input.evidence.evidenceId, version: 1 },
                payload: {
                  referenceType: 'EVIDENCE',
                  referenceId: input.evidence.evidenceId,
                  contentHash: input.evidence.sourceHash,
                  summary: `${input.evidence.type} evidence added after snapshot capture`,
                },
              },
            ],
            audits: [],
            occurredAt: authorityNow,
            correlationId: input.correlationId,
            nextId: this.dependencies.nextId,
          }),
          response: input.evidence,
        };
      },
    });
    return result.response;
  }

  async beginFreshEvaluation(input: {
    readonly projectId: string;
    readonly correlationId: string;
    readonly evaluationId?: string;
  }) {
    const evaluationId = input.evaluationId ?? this.dependencies.nextId();
    const result = await this.dependencies.repository.mutate({
      scope: `verification-fresh:${input.projectId}`,
      idempotencyKey: evaluationId,
      requestHash: commandRequestHash({ evaluationId, projectId: input.projectId }),
      projectId: input.projectId,
      mutate: async (record, authorityNow) => {
        if (record.view.tasks[0]?.state !== 'VERIFYING') {
          throw new ControlPlaneError(
            'VERIFICATION_TASK_STATE',
            'Fresh evaluation requires a VERIFYING task',
            409,
          );
        }
        const evaluation = beginVerificationEvaluation({
          evaluationId,
          capturedAt: authorityNow,
          projectState: record.view.status,
          material: material(record),
        });
        const verification: VerificationRecord = Object.freeze({
          ...record.verification,
          evaluations: Object.freeze([...record.verification.evaluations, evaluation]),
        });
        return {
          record: replaceVerificationRecord({
            record,
            verification,
            supervisionVerification: Object.freeze({ state: 'EVALUATING' }),
            blockedReasons: [],
            events: [
              {
                kind: 'audit.notice',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: {
                  type: 'TASK',
                  id: evaluation.taskId,
                  version: verification.taskVersion,
                },
                payload: {
                  code: 'FRESH_VERIFICATION_STARTED',
                  severity: 'INFO',
                  summary: 'Fresh immutable verification snapshot captured',
                },
              },
            ],
            audits: [],
            occurredAt: authorityNow,
            correlationId: input.correlationId,
            nextId: this.dependencies.nextId,
          }),
          response: evaluation,
        };
      },
    });
    return result.response;
  }

  async resumeStaleEvaluation(input: {
    readonly projectId: string;
    readonly correlationId: string;
  }): Promise<(VerificationCommitResult & { readonly taskState: TaskState }) | null> {
    const record = await this.record(input.projectId);
    const latest = record.verification.evaluations.at(-1);
    if (
      record.view.status !== 'ACTIVE' ||
      record.view.tasks[0]?.state !== 'VERIFYING' ||
      latest === undefined ||
      (latest.state !== 'STALE' && latest.state !== 'EVALUATING')
    ) {
      return null;
    }
    const evaluation =
      latest.state === 'EVALUATING'
        ? latest
        : await this.beginFreshEvaluation({
            ...input,
            evaluationId: stableUuid(
              'moonshift-resume-verification',
              input.projectId,
              record.supervision.authority.executionId,
              latest.evaluationId,
            ),
          });
    try {
      return await this.commitEvaluation({
        projectId: input.projectId,
        evaluationId: evaluation.evaluationId,
        correlationId: input.correlationId,
      });
    } catch (error) {
      if (
        error instanceof ControlPlaneError &&
        error.code === 'VERIFICATION_EVALUATION_SUPERSEDED'
      ) {
        const current = await this.record(input.projectId);
        const superseded = current.verification.evaluations.find(
          (item) => item.evaluationId === evaluation.evaluationId,
        );
        if (superseded?.state === 'STALE') return null;
      }
      throw error;
    }
  }

  async commitEvaluation(input: {
    readonly projectId: string;
    readonly evaluationId: string;
    readonly correlationId: string;
  }): Promise<VerificationCommitResult & { readonly taskState: TaskState }> {
    const result = await this.dependencies.repository.mutate({
      scope: `verification-commit:${input.projectId}`,
      idempotencyKey: input.evaluationId,
      requestHash: commandRequestHash({
        evaluationId: input.evaluationId,
        projectId: input.projectId,
      }),
      projectId: input.projectId,
      mutate: async (record, authorityNow) => {
        const evaluation = record.verification.evaluations.find(
          (item) => item.evaluationId === input.evaluationId,
        );
        const task = record.view.tasks[0];
        if (evaluation === undefined || task === undefined)
          throw new ControlPlaneError(
            'VERIFICATION_EVALUATION_NOT_FOUND',
            'Verification evaluation not found',
            404,
          );
        if (evaluation.state !== 'EVALUATING') {
          throw new ControlPlaneError(
            'VERIFICATION_EVALUATION_SUPERSEDED',
            'Verification evaluation was superseded before commit',
            409,
          );
        }
        let currentMaterial = material(record, evaluation.evaluationId);
        try {
          await this.dependencies.artifactStore.get(currentMaterial.artifact.contentHash, {
            artifactId: currentMaterial.artifact.artifactId,
            projectId: currentMaterial.artifact.projectId,
            taskId: currentMaterial.artifact.taskId,
            executionId: currentMaterial.artifact.executionId,
            gitRevision: currentMaterial.artifact.gitRevision,
            kind: currentMaterial.artifact.kind,
            mediaType: currentMaterial.artifact.mediaType,
          });
        } catch {
          currentMaterial = {
            ...currentMaterial,
            artifact: {
              ...currentMaterial.artifact,
              contentHash: INVALID_CURRENT_ARTIFACT_HASH,
            },
          };
        }
        const committed = commitVerificationEvaluation({
          evaluation,
          currentMaterial,
          projectState: record.view.status,
          task: { state: task.state, version: record.verification.taskVersion },
          committedAt: authorityNow,
          engineId: this.dependencies.engineId,
        });
        const verification: VerificationRecord = Object.freeze({
          ...record.verification,
          taskVersion: committed.task.version,
          evaluations: Object.freeze(
            record.verification.evaluations.map((item) =>
              item.evaluationId === committed.evaluation.evaluationId ? committed.evaluation : item,
            ),
          ),
        });
        const events: VerificationMutation['events'][number][] = [];
        if (committed.task.state !== task.state) {
          events.push({
            kind: 'task.state_changed',
            actor: { type: 'SYSTEM', id: this.dependencies.engineId },
            aggregate: {
              type: 'TASK',
              id: task.taskId,
              version: committed.task.version,
            },
            payload: {
              fromState: task.state,
              toState: committed.task.state,
              reasonCode:
                committed.evaluation.state === 'PASSED'
                  ? 'VERIFICATION_POLICY_PASSED'
                  : 'VERIFICATION_POLICY_BLOCKED',
              summary:
                committed.evaluation.state === 'PASSED'
                  ? 'Deterministic verification established the task result'
                  : 'Verification evidence requires remediation',
            },
          });
        }
        events.push({
          kind: 'verification.decided',
          actor: { type: 'SYSTEM', id: this.dependencies.engineId },
          aggregate: { type: 'TASK', id: task.taskId, version: committed.task.version },
          payload: {
            decision: committed.evaluation.state,
            reasonCode:
              committed.evaluation.state === 'PASSED'
                ? 'VERIFICATION_POLICY_PASSED'
                : committed.evaluation.state === 'STALE'
                  ? 'VERIFICATION_SNAPSHOT_STALE'
                  : 'VERIFICATION_POLICY_BLOCKED',
            summary:
              committed.evaluation.state === 'PASSED'
                ? 'Revision-bound independent evidence passed'
                : (committed.blockingReasons[0] ?? 'Verification did not pass'),
            evidenceRefs: committed.evaluation.snapshot.evidence.map(
              ({ evidenceId }) => evidenceId,
            ),
          },
        });
        const changed = replaceVerificationRecord({
          record,
          status: committed.evaluation.state === 'FAILED' ? 'BLOCKED' : record.view.status,
          tasks: replaceTaskState(record, committed.task.state),
          verification,
          supervisionVerification: Object.freeze({
            state: committed.evaluation.state === 'STALE' ? ('STALE' as const) : ('NONE' as const),
          }),
          blockedReasons: committed.blockingReasons,
          events,
          audits: [
            {
              actorType: 'SYSTEM',
              actorId: this.dependencies.engineId,
              action: 'verification.decided',
              targetType: 'TASK',
              targetId: task.taskId,
              reason: committed.blockingReasons[0] ?? 'All configured evidence rules passed',
              outcome: committed.evaluation.state,
            },
          ],
          occurredAt: authorityNow,
          correlationId: input.correlationId,
          nextId: this.dependencies.nextId,
        });
        return {
          record: changed,
          response: Object.freeze({ ...committed, taskState: committed.task.state }),
        };
      },
    });
    return result.response;
  }

  async runConfiguredFixture(projectId: string, correlationId: string): Promise<void> {
    const record = await this.record(projectId);
    const disposition =
      this.fixtureDispositions.get(projectId) ??
      (record.fixtureScenario === 'EVIDENCE_FAIL' ? 'FAIL' : 'PASS');
    if (disposition === 'UNVERIFIED') {
      await this.publishUnverifiedClaim({ projectId, correlationId });
      return;
    }
    const prepared = await this.prepareFixtureEvaluation({
      projectId,
      correlationId,
      disposition,
    });
    if (disposition === 'STALE') {
      const source = prepared.evidence[0];
      if (source === undefined) throw new Error('Fixture verification evidence is unavailable');
      await this.recordEvidence({
        projectId,
        correlationId,
        evidence: {
          ...source,
          evidenceId: this.dependencies.nextId(),
          type: 'RECONCILIATION',
        },
      });
    }
    await this.commitEvaluation({
      projectId,
      evaluationId: prepared.evaluation.evaluationId,
      correlationId,
    });
  }
}
