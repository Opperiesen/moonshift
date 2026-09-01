import {
  asOpaqueId,
  createCompleteDelegation,
  createDefaultCouncil,
  createProject,
  createProjectChannel,
  createSpecialist,
  createTask,
} from '@moonshift/domain';
import { DEFAULT_POLICY_PROFILE } from '@moonshift/policy';
import { DEFAULT_VERIFICATION_POLICY } from '@moonshift/verification';

import { ControlPlaneError } from '../../errors.js';
import type {
  AgentSummary,
  FixtureScenario,
  PresenceView,
  ProjectRecord,
  ProjectView,
} from '../../model.js';
import { ProjectEventSequence } from '../../projections/project-events.js';
import { appendInitialSupervisionEvents } from '../../projections/supervision-events.js';
import type { FixtureScheduler } from '../../scheduler/index.js';
import { buildFixtureSupervision } from '../supervision/tool-policy.js';
import { projectRequestHash, type ProjectRepository } from './repository.js';

const SCENARIOS = new Set<FixtureScenario>([
  'PASS',
  'EVIDENCE_FAIL',
  'APPROVAL_REJECT',
  'INTERRUPT_BEFORE_EFFECT',
  'INTERRUPT_DURING_EFFECT',
  'INTERRUPT_AFTER_EFFECT',
]);

export interface SubmitObjectiveCommand {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly objective: string;
  readonly fixtureScenario: FixtureScenario;
}

export class ProjectService {
  constructor(
    private readonly dependencies: {
      readonly repository: ProjectRepository;
      readonly scheduler: FixtureScheduler;
      readonly nextId: () => string;
    },
  ) {}

  async submitObjective(command: SubmitObjectiveCommand): Promise<{
    reused: boolean;
    view: ProjectView;
    organization: ProjectRecord['organization'];
    scheduling: ProjectRecord['scheduling'];
  }> {
    const objective = command.objective.trim();
    if (objective.length === 0 || command.objective.length > 4_000)
      throw new ControlPlaneError(
        'OBJECTIVE_INVALID',
        'Enter an objective between 1 and 4000 characters',
      );
    if (!SCENARIOS.has(command.fixtureScenario))
      throw new ControlPlaneError('FIXTURE_SCENARIO_INVALID', 'Unknown fixture scenario');
    const nextId = this.dependencies.nextId;
    const projectId = nextId();
    const project = createProject({
      projectId: asOpaqueId('Project', projectId),
      workspaceId: asOpaqueId('Workspace', nextId()),
      objective,
    });
    const policyProfileId = nextId();
    const permissionSetId = nextId();
    const routingPolicyId = nextId();
    const memoryScopeId = nextId();
    const personas = createDefaultCouncil({
      projectId,
      policyProfileId,
      permissionSetId,
      routingPolicyId,
      memoryScopeId,
      nextId,
    });
    const engineering = personas.find(({ personaRole }) => personaRole === 'ENGINEERING');
    if (engineering === undefined) throw new Error('Default Engineering persona missing');
    const rootChannel = createProjectChannel(
      {
        channelId: nextId(),
        projectId,
        parentChannelId: null,
        name: 'Delivery',
        kind: 'CATEGORY',
        createdByAgentId: engineering.agentId,
      },
      [],
    );
    const implementationChannel = createProjectChannel(
      {
        channelId: nextId(),
        projectId,
        parentChannelId: rootChannel.channelId,
        name: 'Implementation',
        kind: 'SUBCHANNEL',
        createdByAgentId: engineering.agentId,
      },
      [rootChannel],
    );
    const taskId = nextId();
    const acceptanceCriteria = Object.freeze([
      'Produce one deterministic release-note fixture artifact',
      'Retain exact connection and model descriptor provenance',
    ]);
    createTask({
      taskId: asOpaqueId('Task', taskId),
      projectId: asOpaqueId('Project', projectId),
      title: 'Create deterministic release-note artifact',
      objective,
      acceptanceCriteria,
      expectedRevision: this.dependencies.scheduler.expectedRevision,
    });
    const specialistId = nextId();
    const specialist = createSpecialist({
      agentId: asOpaqueId('Agent', specialistId),
      projectId: asOpaqueId('Project', projectId),
      kind: 'SPECIALIST',
      parentPersonaId: engineering.agentId,
      role: 'Release-note specialist',
      objective,
      lineageId: engineering.lineageId,
      permissionSetId: asOpaqueId('PermissionSet', nextId()),
      routingPolicyId: asOpaqueId('RoutingPolicy', nextId()),
      status: 'ACTIVE',
      archivalConditions: ['terminal state', 'required exports complete'],
    });
    const persisted = await this.dependencies.repository.create({
      idempotencyKey: command.idempotencyKey,
      requestHash: projectRequestHash({ objective, fixtureScenario: command.fixtureScenario }),
      build: async (capacity) => {
        const authorityNow = new Date(capacity.authorityNow);
        if (!Number.isFinite(authorityNow.getTime()))
          throw new ControlPlaneError('AUTHORITY_TIME_INVALID', 'Authority clock is invalid', 500);
        const occurredAt = capacity.authorityNow;
        const delegation = createCompleteDelegation({
          delegationId: nextId(),
          projectId,
          taskId,
          parentPersonaId: engineering.agentId,
          specialistId,
          depth: 1,
          role: specialist.role,
          objective,
          rationale: 'Engineering delegates one bounded deterministic fixture task',
          expectedOutputs: ['release-note.json'],
          requiredEvidence: ['fixture-integrity', 'fixture-test'],
          capabilityGrantId: nextId(),
          budgetId: nextId(),
          parentCapabilities: ['FIXTURE_READ', 'FIXTURE_ARTIFACT', 'FIXTURE_EFFECT'],
          capabilities: ['FIXTURE_READ', 'FIXTURE_ARTIFACT', 'FIXTURE_EFFECT'],
          parentInvocationLimit: 8,
          invocationLimit: 4,
          parentMonetaryLimitMicros: 20_000,
          monetaryLimitMicros: 5_000,
          maxRuntimeMs: 60_000,
          taskDeadlineAt: new Date(authorityNow.getTime() + 86_400_000).toISOString(),
          authorityLeaseExpiresAt: new Date(authorityNow.getTime() + 300_000).toISOString(),
          terminationConditions: ['runtime exhausted', 'task cancelled', 'project stopped'],
          archivalConditions: specialist.archivalConditions,
        });
        const scheduling = await this.dependencies.scheduler.schedule({
          projectId,
          taskId,
          agentId: specialistId,
          objective,
          acceptanceCriteria,
          scenario: command.fixtureScenario,
          correlationId: command.correlationId,
          authority: {
            maxRuntimeMs: delegation.maxRuntimeMs,
            consumedActiveMs: 0,
            attemptedActiveMs: delegation.maxRuntimeMs,
            authorityLeaseExpiresAt: delegation.authorityLeaseExpiresAt,
            now: capacity.authorityNow,
            ...(delegation.taskDeadlineAt === undefined
              ? {}
              : { taskDeadlineAt: delegation.taskDeadlineAt }),
          },
          capacity,
        });
        const waitsForCapacity =
          scheduling.queueReason === 'COGNITIVE_CAPACITY' ||
          scheduling.queueReason === 'RUNNER_CAPACITY';
        const taskState = waitsForCapacity
          ? ('WAITING_FOR_CAPACITY' as const)
          : ('WAITING_FOR_APPROVAL' as const);
        const presenceState = waitsForCapacity
          ? ('QUEUED' as const)
          : ('WAITING_FOR_APPROVAL' as const);
        const presenceSourceType = waitsForCapacity ? ('CAPACITY' as const) : ('APPROVAL' as const);
        const waitTarget = scheduling.queueReason === 'COGNITIVE_CAPACITY' ? 'cognitive' : 'runner';
        const systemId = nextId();
        const supervision = buildFixtureSupervision({
          projectId,
          taskId,
          requesterAgentId: specialistId,
          scheduling,
          scenario: command.fixtureScenario,
          authorityNow: capacity.authorityNow,
          authorityLeaseExpiresAt: delegation.authorityLeaseExpiresAt,
          nextId,
        });
        const events = new ProjectEventSequence(
          projectId,
          command.correlationId,
          occurredAt,
          nextId,
        );
        events.append({
          kind: 'project.created',
          actor: { type: 'SUPERVISOR', id: command.actorId },
          aggregate: { type: 'PROJECT', id: projectId, version: project.version },
          payload: {
            referenceType: 'PROJECT',
            referenceId: projectId,
            summary: 'Project accepted for bounded fixture execution',
          },
          classification: 'PUBLIC_FIXTURE',
        });
        for (const persona of personas) {
          events.append({
            kind: 'agent.created',
            actor: { type: 'SYSTEM', id: systemId },
            aggregate: { type: 'AGENT', id: persona.agentId, version: 1 },
            payload: {
              referenceType: 'AGENT',
              referenceId: persona.agentId,
              summary: `${persona.personaRole} persona created`,
            },
          });
        }
        for (const channel of [rootChannel, implementationChannel]) {
          events.append({
            kind: 'channel.created',
            actor: { type: 'PERSONA', id: engineering.agentId, lineageId: engineering.lineageId },
            aggregate: { type: 'CHANNEL', id: channel.channelId, version: 1 },
            payload: {
              referenceType: 'CHANNEL',
              referenceId: channel.channelId,
              summary: `${channel.name} channel created`,
            },
          });
        }
        events.append({
          kind: 'task.state_changed',
          actor: { type: 'PERSONA', id: engineering.agentId, lineageId: engineering.lineageId },
          aggregate: { type: 'TASK', id: taskId, version: 1 },
          payload: {
            fromState: null,
            toState: taskState,
            reasonCode: scheduling.queueReason ?? 'BOUNDED_TASK_DELEGATED',
            summary: waitsForCapacity
              ? `Bounded fixture task waits for ${waitTarget} capacity`
              : 'Bounded fixture task created and queued',
          },
        });
        events.append({
          kind: 'agent.created',
          actor: { type: 'PERSONA', id: engineering.agentId, lineageId: engineering.lineageId },
          aggregate: { type: 'AGENT', id: specialistId, version: 1 },
          payload: {
            referenceType: 'AGENT',
            referenceId: specialistId,
            summary: 'Release-note specialist created',
          },
        });
        events.append({
          kind: 'delegation.created',
          actor: { type: 'PERSONA', id: engineering.agentId, lineageId: engineering.lineageId },
          aggregate: { type: 'DELEGATION', id: delegation.delegationId, version: 1 },
          payload: {
            referenceType: 'DELEGATION',
            referenceId: delegation.delegationId,
            summary: 'Depth-one bounded delegation activated',
          },
        });
        events.append({
          kind: 'policy.decided',
          actor: { type: 'SYSTEM', id: systemId },
          aggregate: { type: 'EXECUTION', id: scheduling.execution.executionId, version: 1 },
          payload: {
            decision: 'FIXTURE_PRIMARY_SELECTED',
            reasonCode: scheduling.routeDecision.reasonCode,
            summary: 'Selected one of two conformant fixture connections',
          },
        });
        events.append({
          kind: 'execution.state_changed',
          actor: { type: 'SYSTEM', id: systemId },
          aggregate: { type: 'EXECUTION', id: scheduling.execution.executionId, version: 1 },
          payload: {
            fromState: null,
            toState: scheduling.execution.state,
            reasonCode: scheduling.queueReason ?? 'FIXTURE_TOOL_INTENT_REACHED',
            summary: waitsForCapacity
              ? `Execution waits for ${waitTarget} capacity`
              : 'Fake execution reached the approval boundary',
          },
        });
        for (const observation of scheduling.observations) {
          const source = observation as {
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
          const payload: Record<string, unknown> = {
            activity: source.event.eventType,
            status: source.event.observable.status,
            summary: source.event.observable.summary,
            referenceId: scheduling.execution.executionId,
          };
          if (source.event.observable.progressPercent !== undefined)
            payload.progressPercent = source.event.observable.progressPercent;
          if (source.event.observable.actionDigest !== undefined)
            payload.actionDigest = source.event.observable.actionDigest;
          events.append({
            kind: 'backend.event_observed',
            actor: { type: 'SPECIALIST', id: specialistId, lineageId: specialist.lineageId },
            aggregate: {
              type: 'EXECUTION',
              id: scheduling.execution.executionId,
              version: source.event.sequence,
            },
            payload,
          });
        }
        const supervisionAudit = appendInitialSupervisionEvents({
          sequence: events,
          supervision,
          specialistId,
          specialistLineageId: specialist.lineageId,
          systemId,
          occurredAt,
          correlationId: command.correlationId,
          nextId,
        });
        events.append({
          kind: 'agent.presence_changed',
          actor: { type: 'SYSTEM', id: systemId },
          aggregate: { type: 'AGENT', id: specialistId, version: 2 },
          payload: {
            fromState: waitsForCapacity ? 'IDLE' : 'THINKING_PROVIDER_CALL',
            toState: presenceState,
            reasonCode: scheduling.queueReason ?? 'FIXTURE_TOOL_INTENT_REACHED',
            summary: waitsForCapacity
              ? `Specialist awaits ${waitTarget} capacity`
              : 'Specialist awaits supervisor approval',
          },
        });
        events.append({
          kind: 'project.status_changed',
          actor: { type: 'SYSTEM', id: systemId },
          aggregate: { type: 'PROJECT', id: projectId, version: 2 },
          payload: {
            fromState: 'CREATING',
            toState: 'ACTIVE',
            reasonCode: 'ATOMIC_BOOTSTRAP_COMPLETE',
            summary: 'Project organization and first execution are active',
          },
          classification: 'PUBLIC_FIXTURE',
        });
        const eventSnapshot = events.snapshot();
        const personaSummaries: AgentSummary[] = personas.map((persona) => ({
          agentId: persona.agentId,
          kind: 'PERSONA',
          role: persona.personaRole,
          status: persona.status,
          lineageId: persona.lineageId,
        }));
        const specialistSummary: AgentSummary = {
          agentId: specialist.agentId,
          kind: 'SPECIALIST',
          role: specialist.role,
          status: specialist.status,
          lineageId: specialist.lineageId,
        };
        const presences: PresenceView[] = [
          ...personas.map((persona) => ({
            agentId: persona.agentId,
            state: 'IDLE' as const,
            sourceType: 'IDENTITY' as const,
            sourceId: persona.agentId,
            updatedAt: occurredAt,
            activity: `${persona.personaRole} persona ready`,
          })),
          {
            agentId: specialistId,
            state: presenceState,
            sourceType: presenceSourceType,
            sourceId: scheduling.execution.executionId,
            updatedAt: occurredAt,
            activity: waitsForCapacity
              ? `Waiting for ${waitTarget} capacity`
              : 'Waiting for approval at controlled fixture tool boundary',
          },
        ];
        const view: ProjectView = Object.freeze({
          projectId,
          objective,
          status: 'ACTIVE',
          version: 2,
          personas: Object.freeze(personaSummaries),
          specialists: Object.freeze([specialistSummary]),
          presences: Object.freeze(presences),
          channels: Object.freeze(
            [rootChannel, implementationChannel].map(
              ({ channelId, parentChannelId, name, kind, depth, status }) =>
                Object.freeze({ channelId, parentChannelId, name, kind, depth, status }),
            ),
          ),
          tasks: Object.freeze([
            {
              taskId,
              title: 'Create deterministic release-note artifact',
              state: taskState,
              assigneeAgentId: specialistId,
              expectedRevision: this.dependencies.scheduler.expectedRevision,
            },
          ]),
          dependencies: Object.freeze([]),
          capacity: Object.freeze({
            activeCognitiveRuns:
              capacity.activeCognitiveRuns +
              this.dependencies.scheduler.activeCognitiveRuns +
              (waitsForCapacity ? 0 : 1),
            cognitiveRunLimit: DEFAULT_POLICY_PROFILE.cognitiveConcurrency.default,
            activeRunnerJobs:
              capacity.activeRunnerJobs + this.dependencies.scheduler.activeRunnerJobs,
            runnerJobLimit: 1 as const,
          }),
          lastSequence: eventSnapshot.at(-1)?.sequence ?? 0,
        });
        const record: ProjectRecord = Object.freeze({
          fixtureScenario: command.fixtureScenario,
          view,
          organization: Object.freeze({ specialist, delegation }),
          scheduling,
          supervision: Object.freeze({ ...supervision, audit: supervisionAudit }),
          verification: Object.freeze({
            taskVersion: 1,
            policy: DEFAULT_VERIFICATION_POLICY,
            artifacts: Object.freeze([]),
            evidence: Object.freeze([]),
            review: null,
            evaluations: Object.freeze([]),
          }),
          events: eventSnapshot,
        });
        return record;
      },
    });
    return {
      reused: persisted.reused,
      view: persisted.record.view,
      organization: persisted.record.organization,
      scheduling: persisted.record.scheduling,
    };
  }

  async getProject(projectId: string): Promise<ProjectView | null> {
    return (await this.dependencies.repository.get(projectId))?.view ?? null;
  }
}
