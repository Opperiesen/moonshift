import {
  createFakeExecutionBackend,
  FAKE_CONNECTIONS,
  FAKE_MODEL_DESCRIPTOR,
  type FakeScenario,
} from '@moonshift/backend-fake';
import { compileContext } from '@moonshift/context';
import {
  DEFAULT_POLICY_PROFILE,
  evaluateOrganizationCeilings,
  evaluateRuntimeAuthority,
  evaluateTaskDeadline,
} from '@moonshift/policy';

import { ControlPlaneError } from '../errors.js';
import type { SchedulingResult } from '../model.js';

export interface FixtureSchedulerOptions {
  readonly now: () => Date;
  readonly nextId: () => string;
  readonly expectedRevision: string;
  readonly activeSpecialists?: number;
  readonly activeCognitiveRuns?: number;
  readonly activeRunnerJobs?: number;
  readonly specialistLimit?: number;
  readonly cognitiveRunLimit?: number;
}

export class FixtureScheduler {
  readonly expectedRevision: string;
  readonly specialistLimit: number;
  readonly cognitiveRunLimit: number;
  private capacity: {
    activeSpecialists: number;
    activeCognitiveRuns: number;
    activeRunnerJobs: number;
  };

  constructor(private readonly options: FixtureSchedulerOptions) {
    this.expectedRevision = options.expectedRevision;
    this.specialistLimit =
      options.specialistLimit ?? DEFAULT_POLICY_PROFILE.specialists.defaultProjectMaximum;
    if (
      !Number.isSafeInteger(this.specialistLimit) ||
      this.specialistLimit < 1 ||
      this.specialistLimit > DEFAULT_POLICY_PROFILE.specialists.projectMaximum
    ) {
      throw new RangeError('Fixture specialist limit is outside the constitutional ceiling');
    }
    this.cognitiveRunLimit =
      options.cognitiveRunLimit ?? DEFAULT_POLICY_PROFILE.cognitiveConcurrency.default;
    if (
      !Number.isSafeInteger(this.cognitiveRunLimit) ||
      this.cognitiveRunLimit < 1 ||
      this.cognitiveRunLimit > DEFAULT_POLICY_PROFILE.cognitiveConcurrency.maximum
    ) {
      throw new RangeError('Fixture cognitive run limit is outside the constitutional ceiling');
    }
    this.capacity = {
      activeSpecialists: options.activeSpecialists ?? 0,
      activeCognitiveRuns: options.activeCognitiveRuns ?? 0,
      activeRunnerJobs: options.activeRunnerJobs ?? 0,
    };
  }

  get activeSpecialists(): number {
    return this.capacity.activeSpecialists;
  }

  get activeCognitiveRuns(): number {
    return this.capacity.activeCognitiveRuns;
  }

  get activeRunnerJobs(): number {
    return this.capacity.activeRunnerJobs;
  }

  setFixtureCapacity(input: {
    readonly activeSpecialists?: number;
    readonly activeCognitiveRuns?: number;
    readonly activeRunnerJobs?: number;
  }): void {
    this.capacity = {
      activeSpecialists: input.activeSpecialists ?? 0,
      activeCognitiveRuns: input.activeCognitiveRuns ?? 0,
      activeRunnerJobs: input.activeRunnerJobs ?? 0,
    };
  }

  assertSpecialistCapacity(activeSpecialists = 0): void {
    const requestedSpecialists = activeSpecialists + this.activeSpecialists + 1;
    if (requestedSpecialists > this.specialistLimit)
      throw new ControlPlaneError(
        'SPECIALIST_CEILING',
        'Project specialist capacity is exhausted',
        422,
      );
    const decision = evaluateOrganizationCeilings(DEFAULT_POLICY_PROFILE, {
      personas: 3,
      specialists: requestedSpecialists,
      perPersona: 1,
      depth: 1,
    });
    if (!decision.allowed)
      throw new ControlPlaneError(decision.reason, 'Project specialist capacity is exhausted', 422);
  }

  async schedule(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly agentId: string;
    readonly objective: string;
    readonly acceptanceCriteria: readonly string[];
    readonly scenario: FakeScenario;
    readonly correlationId: string;
    readonly authority: {
      readonly maxRuntimeMs: number;
      readonly consumedActiveMs: number;
      readonly attemptedActiveMs: number;
      readonly authorityLeaseExpiresAt: string;
      readonly taskDeadlineAt?: string;
      readonly now: string;
    };
    readonly capacity?: {
      readonly activeSpecialists: number;
      readonly activeCognitiveRuns: number;
      readonly activeRunnerJobs: number;
    };
  }): Promise<SchedulingResult> {
    this.assertSpecialistCapacity(input.capacity?.activeSpecialists ?? 0);
    const now = input.authority.now;
    const deadlineDecision = evaluateTaskDeadline(input.authority.taskDeadlineAt, now);
    if (!deadlineDecision.allowed)
      throw new ControlPlaneError(
        deadlineDecision.reason,
        'Task deadline does not permit execution',
        422,
      );
    const runtimeDecision = evaluateRuntimeAuthority({
      maxRuntimeMs: input.authority.maxRuntimeMs,
      consumedActiveMs: input.authority.consumedActiveMs,
      attemptedActiveMs: input.authority.attemptedActiveMs,
      authorityLeaseExpiresAt: input.authority.authorityLeaseExpiresAt,
      now,
    });
    if (!runtimeDecision.allowed)
      throw new ControlPlaneError(
        runtimeDecision.reason,
        'Delegated runtime authority does not permit execution',
        422,
      );
    const eligible = FAKE_CONNECTIONS.filter(
      ({ relation }) =>
        relation.available &&
        relation.conformance === 'CONFORMANT' &&
        relation.modelDescriptorId === FAKE_MODEL_DESCRIPTOR.id &&
        relation.modelDescriptorVersion === FAKE_MODEL_DESCRIPTOR.version,
    );
    const selected = eligible[0];
    if (selected === undefined)
      throw new ControlPlaneError('BACKEND_CAPACITY', 'No conformant fixture connection', 422);
    const routeDecisionId = this.options.nextId();
    const executionId = this.options.nextId();
    const runtimeId = this.options.nextId();
    const contextManifestId = this.options.nextId();
    const contextManifest = compileContext({
      executionId,
      taskId: input.taskId,
      agentId: input.agentId,
      connectionId: selected.id,
      policyVersion: `${DEFAULT_POLICY_PROFILE.profileId}:${DEFAULT_POLICY_PROFILE.version}`,
      destination: 'FAKE_EXECUTION',
      tokenBudget: 2_000,
      inputs: [
        {
          sourceType: 'objective',
          sourceReference: input.projectId,
          content: input.objective,
          classification: 'PUBLIC_FIXTURE',
          inclusionReason: 'Execution objective',
        },
        {
          sourceType: 'acceptance_criteria',
          sourceReference: input.taskId,
          content: input.acceptanceCriteria.join('\n'),
          classification: 'PUBLIC_FIXTURE',
          inclusionReason: 'Bounded success conditions',
        },
        {
          sourceType: 'task',
          sourceReference: input.taskId,
          content: 'Create one deterministic release-note fixture artifact',
          classification: 'PUBLIC_FIXTURE',
          inclusionReason: 'Assigned bounded task',
        },
        {
          sourceType: 'repository_revision',
          sourceReference: 'fixture-repository',
          revision: this.expectedRevision,
          content: this.expectedRevision,
          classification: 'PUBLIC_FIXTURE',
          inclusionReason: 'Revision-bound fixture input',
        },
      ],
    });
    const queueReason =
      this.activeCognitiveRuns + (input.capacity?.activeCognitiveRuns ?? 0) >=
      this.cognitiveRunLimit
        ? ('COGNITIVE_CAPACITY' as const)
        : this.activeRunnerJobs + (input.capacity?.activeRunnerJobs ?? 0) >= 1
          ? ('RUNNER_CAPACITY' as const)
          : null;
    if (queueReason !== null) {
      return Object.freeze({
        routeDecision: Object.freeze({
          routeDecisionId,
          eligibleConnectionIds: Object.freeze(eligible.map(({ id }) => id)),
          selectedConnectionId: selected.id,
          modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
          modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
          reasonCode: 'FIXTURE_PRIMARY_SELECTED' as const,
        }),
        execution: Object.freeze({
          executionId,
          taskId: input.taskId,
          agentId: input.agentId,
          runtimeId,
          connectionId: selected.id,
          modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
          modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
          state: 'QUEUED' as const,
        }),
        runtime: Object.freeze({
          runtimeId,
          agentId: input.agentId,
          taskId: input.taskId,
          executionId,
          connectionId: selected.id,
          modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
          modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
          contextManifestId,
          status: 'QUEUED' as const,
        }),
        contextManifestId,
        contextManifest,
        observations: Object.freeze([]),
        queueReason,
      });
    }
    const backend = createFakeExecutionBackend(selected.id, { now: this.options.now });
    const result = await backend.start({
      schemaVersion: '1.0',
      messageId: this.options.nextId(),
      kind: 'backend.start',
      connectionId: selected.id,
      correlationId: input.correlationId,
      sentAt: this.options.now().toISOString(),
      executionId,
      agentId: input.agentId,
      taskId: input.taskId,
      modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
      modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
      contextManifestId,
      scenario: input.scenario,
      seed: `${input.projectId}:${input.taskId}`,
      budgets: { maxInvocations: 4, maxRuntimeMs: input.authority.attemptedActiveMs },
    });
    const observations = result.events
      .filter((observation) => observation.accepted && observation.event.sequence <= 4)
      .map((observation) => Object.freeze({ ...observation }));
    return Object.freeze({
      routeDecision: Object.freeze({
        routeDecisionId,
        eligibleConnectionIds: Object.freeze(eligible.map(({ id }) => id)),
        selectedConnectionId: selected.id,
        modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
        modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
        reasonCode: 'FIXTURE_PRIMARY_SELECTED' as const,
      }),
      execution: Object.freeze({
        executionId,
        taskId: input.taskId,
        agentId: input.agentId,
        runtimeId,
        connectionId: selected.id,
        modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
        modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
        state: 'WAITING_FOR_APPROVAL' as const,
      }),
      runtime: Object.freeze({
        runtimeId,
        agentId: input.agentId,
        taskId: input.taskId,
        executionId,
        connectionId: selected.id,
        modelDescriptorId: FAKE_MODEL_DESCRIPTOR.id,
        modelDescriptorVersion: FAKE_MODEL_DESCRIPTOR.version,
        contextManifestId,
        status: 'WAITING_FOR_APPROVAL' as const,
      }),
      contextManifestId,
      contextManifest,
      observations: Object.freeze(observations),
      queueReason: 'WAITING_FOR_APPROVAL' as const,
    });
  }
}
