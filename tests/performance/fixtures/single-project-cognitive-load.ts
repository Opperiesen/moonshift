import {
  commandRequestHash,
  ProjectEventSequence,
  type ProjectRecord,
  type ProjectRepository,
} from '../../../apps/control-plane/src/index.js';
import type { FixtureScheduler } from '../../../apps/control-plane/src/scheduler/index.js';

type AcceptedObservation = {
  readonly accepted: true;
  readonly event: {
    readonly sequence: number;
    readonly eventType: string;
    readonly observable: {
      readonly status: string;
      readonly summary: string;
      readonly progressPercent?: number;
      readonly actionDigest?: string;
    };
  };
};

function acceptedObservation(value: Readonly<Record<string, unknown>>): AcceptedObservation {
  const observation = value as unknown as AcceptedObservation;
  if (
    observation.accepted !== true ||
    !Number.isSafeInteger(observation.event?.sequence) ||
    typeof observation.event?.eventType !== 'string' ||
    typeof observation.event?.observable?.status !== 'string' ||
    typeof observation.event?.observable?.summary !== 'string'
  ) {
    throw new Error('Capacity fixture received an invalid sanitized backend observation');
  }
  return observation;
}

/**
 * Materializes additional real fake-backend scheduler executions for one already-submitted project.
 * The normal Foundation journey owns one task and one specialist, so this load fixture reuses those
 * stable identities, reserves cognitive slots in input order, and persists the scheduler's exact
 * sanitized observations through the PostgreSQL repository/outbox observed by Chromium.
 */
export async function materializeSingleProjectCognitiveLoad(input: {
  readonly repository: ProjectRepository;
  readonly scheduler: FixtureScheduler;
  readonly projectId: string;
  readonly targetConcurrency: 1 | 3 | 5;
  readonly nextId: () => string;
}): Promise<{
  readonly record: ProjectRecord;
  readonly executionIds: readonly string[];
  readonly backendEventIds: readonly string[];
  readonly queueProbe: {
    readonly executionId: string;
    readonly reason: 'COGNITIVE_CAPACITY';
  };
}> {
  const initial = await input.repository.get(input.projectId);
  if (initial === null) throw new Error('Capacity fixture project is missing');
  if (
    initial.view.specialists.length !== 1 ||
    initial.scheduling.execution.state !== 'WAITING_FOR_APPROVAL'
  ) {
    throw new Error('Capacity fixture requires the bounded one-specialist reference journey');
  }

  const additionalCount = input.targetConcurrency - 1;
  const authorityNow = await input.repository.authorityNow();
  const delegation = initial.organization.delegation;
  const correlations = Array.from({ length: additionalCount }, () => input.nextId());
  const additional = await Promise.all(
    correlations.map((correlationId, index) =>
      input.scheduler.schedule({
        projectId: initial.view.projectId,
        taskId: initial.scheduling.execution.taskId,
        agentId: initial.organization.specialist.agentId,
        objective: initial.taskDefinition.objective,
        acceptanceCriteria: initial.taskDefinition.acceptanceCriteria,
        scenario: initial.fixtureScenario,
        correlationId,
        authority: {
          maxRuntimeMs: delegation.maxRuntimeMs,
          consumedActiveMs: 0,
          attemptedActiveMs: delegation.maxRuntimeMs,
          authorityLeaseExpiresAt: delegation.authorityLeaseExpiresAt,
          now: authorityNow,
          ...(delegation.taskDeadlineAt === undefined
            ? {}
            : { taskDeadlineAt: delegation.taskDeadlineAt }),
        },
        capacity: {
          activeSpecialists: 0,
          // The submitted execution owns slot one; each batch member reserves the preceding slots.
          activeCognitiveRuns: index + 1,
          activeRunnerJobs: 0,
        },
      }),
    ),
  );
  if (
    additional.some(
      ({ execution, observations, queueReason }) =>
        execution.state !== 'WAITING_FOR_APPROVAL' ||
        queueReason !== 'WAITING_FOR_APPROVAL' ||
        observations.length !== 4,
    )
  ) {
    throw new Error('Configured cognitive capacity did not admit the complete fixture batch');
  }
  const queued = await input.scheduler.schedule({
    projectId: initial.view.projectId,
    taskId: initial.scheduling.execution.taskId,
    agentId: initial.organization.specialist.agentId,
    objective: initial.taskDefinition.objective,
    acceptanceCriteria: initial.taskDefinition.acceptanceCriteria,
    scenario: initial.fixtureScenario,
    correlationId: input.nextId(),
    authority: {
      maxRuntimeMs: delegation.maxRuntimeMs,
      consumedActiveMs: 0,
      attemptedActiveMs: delegation.maxRuntimeMs,
      authorityLeaseExpiresAt: delegation.authorityLeaseExpiresAt,
      now: authorityNow,
      ...(delegation.taskDeadlineAt === undefined
        ? {}
        : { taskDeadlineAt: delegation.taskDeadlineAt }),
    },
    capacity: {
      activeSpecialists: 0,
      activeCognitiveRuns: input.scheduler.cognitiveRunLimit,
      activeRunnerJobs: 0,
    },
  });
  if (
    queued.execution.state !== 'QUEUED' ||
    queued.queueReason !== 'COGNITIVE_CAPACITY' ||
    queued.observations.length !== 0
  ) {
    throw new Error('Capacity fixture failed to preserve the cognitive queue boundary');
  }
  const queueProbe = Object.freeze({
    executionId: queued.execution.executionId,
    reason: queued.queueReason,
  });

  if (additional.length === 0) {
    const backendEventIds = initial.events
      .filter(
        ({ aggregate, kind }) =>
          kind === 'backend.event_observed' &&
          aggregate.id === initial.scheduling.execution.executionId,
      )
      .map(({ eventId }) => eventId);
    return Object.freeze({
      record: initial,
      executionIds: Object.freeze([initial.scheduling.execution.executionId]),
      backendEventIds: Object.freeze(backendEventIds),
      queueProbe,
    });
  }

  const correlationId = input.nextId();
  const systemId = input.nextId();
  const mutation = await input.repository.mutate({
    scope: `capacity-fixture:${input.projectId}`,
    idempotencyKey: `cognitive-load-${String(input.targetConcurrency)}`,
    requestHash: commandRequestHash({
      executionIds: additional.map(({ execution }) => execution.executionId),
      projectId: input.projectId,
      targetConcurrency: input.targetConcurrency,
    }),
    projectId: input.projectId,
    mutate: async (record, committedAt) => {
      const events = new ProjectEventSequence(
        record.view.projectId,
        correlationId,
        committedAt,
        input.nextId,
        record.view.lastSequence,
      );
      for (const scheduled of additional) {
        events.append({
          kind: 'policy.decided',
          actor: { type: 'SYSTEM', id: systemId },
          aggregate: {
            type: 'EXECUTION',
            id: scheduled.execution.executionId,
            version: 1,
          },
          payload: {
            decision: 'FIXTURE_PRIMARY_SELECTED',
            reasonCode: scheduled.routeDecision.reasonCode,
            summary: 'Capacity fixture selected a conformant fake connection',
          },
        });
        events.append({
          kind: 'execution.state_changed',
          actor: { type: 'SYSTEM', id: systemId },
          aggregate: {
            type: 'EXECUTION',
            id: scheduled.execution.executionId,
            version: 1,
          },
          payload: {
            fromState: null,
            toState: scheduled.execution.state,
            reasonCode: scheduled.queueReason ?? 'FIXTURE_TOOL_INTENT_REACHED',
            summary: 'Capacity fixture execution reached the approval boundary',
          },
        });
        for (const rawObservation of scheduled.observations) {
          const observation = acceptedObservation(rawObservation);
          const payload: Record<string, unknown> = {
            activity: observation.event.eventType,
            status: observation.event.observable.status,
            summary: observation.event.observable.summary,
            referenceId: scheduled.execution.executionId,
          };
          if (observation.event.observable.progressPercent !== undefined) {
            payload.progressPercent = observation.event.observable.progressPercent;
          }
          if (observation.event.observable.actionDigest !== undefined) {
            payload.actionDigest = observation.event.observable.actionDigest;
          }
          events.append({
            kind: 'backend.event_observed',
            actor: {
              type: 'SPECIALIST',
              id: record.organization.specialist.agentId,
              lineageId: record.organization.specialist.lineageId,
            },
            aggregate: {
              type: 'EXECUTION',
              id: scheduled.execution.executionId,
              version: observation.event.sequence,
            },
            payload,
          });
        }
      }
      const appended = events.snapshot();
      const lastSequence = appended.at(-1)?.sequence ?? record.view.lastSequence;
      const presences = Object.freeze(
        record.view.presences.map((presence) =>
          presence.agentId === record.organization.specialist.agentId
            ? Object.freeze({
                ...presence,
                sourceId: additional.at(-1)?.execution.executionId ?? presence.sourceId,
                updatedAt: committedAt,
                activity: `${String(input.targetConcurrency)} fixture cognitive executions wait at the approval boundary`,
              })
            : presence,
        ),
      );
      return {
        record: Object.freeze({
          ...record,
          view: Object.freeze({
            ...record.view,
            version: record.view.version + 1,
            presences,
            capacity: Object.freeze({
              ...record.view.capacity,
              activeCognitiveRuns: input.targetConcurrency,
            }),
            lastSequence,
          }),
          events: Object.freeze([...record.events, ...appended]),
        }),
        response: Object.freeze({
          executionIds: Object.freeze(additional.map(({ execution }) => execution.executionId)),
        }),
      };
    },
  });
  const executionIds = Object.freeze([
    initial.scheduling.execution.executionId,
    ...mutation.response.executionIds,
  ]);
  const executionIdSet = new Set(executionIds);
  const backendEventIds = mutation.record.events
    .filter(
      ({ aggregate, kind }) =>
        kind === 'backend.event_observed' && executionIdSet.has(aggregate.id),
    )
    .map(({ eventId }) => eventId);
  return Object.freeze({
    record: mutation.record,
    executionIds,
    backendEventIds: Object.freeze(backendEventIds),
    queueProbe,
  });
}
