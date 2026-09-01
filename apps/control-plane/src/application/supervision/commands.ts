import { createHash } from 'node:crypto';

import { EXECUTION_TRANSITIONS, transitionExecution, type ExecutionState } from '@moonshift/domain';
import {
  canonicalActionDigest,
  DEFAULT_POLICY_PROFILE,
  evaluateControlCommand,
  type ControlCommand,
} from '@moonshift/policy';

import { ControlPlaneError } from '../../errors.js';
import type {
  ApprovalProjection,
  ProjectEvent,
  ProjectRecord,
  ProjectView,
  SupervisionProjection,
  SupervisionRecord,
} from '../../model.js';
import { appendSupervisionMutation } from '../../projections/supervision-events.js';
import { checkpointFromProjectRecord } from '../recovery/checkpoints.js';
import { commandRequestHash, type ProjectRepository } from '../projects/repository.js';
import type { ApprovedEffectExecutor } from './tool-policy.js';

type DecisionCommand = {
  readonly actorId: string;
  readonly projectId: string;
  readonly approvalId: string;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly actionDigest: string;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
};

type ControlProjectCommand = {
  readonly actorId: string;
  readonly projectId: string;
  readonly command: ControlCommand;
  readonly reason: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
};

function fail(code: string, message: string, statusCode = 422): never {
  throw new ControlPlaneError(code, message, statusCode);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function approvalPublic(approval: ApprovalProjection): Omit<ApprovalProjection, 'usable'> {
  const { usable: _usable, ...view } = approval;
  return Object.freeze(view);
}

function projection(record: ProjectRecord): SupervisionProjection {
  return Object.freeze({
    ...record.supervision,
    projectState: record.view.status,
    projectVersion: record.view.version,
  });
}

function replaceRecord(input: {
  readonly record: ProjectRecord;
  readonly status?: ProjectView['status'];
  readonly tasks?: ProjectView['tasks'];
  readonly capacity?: ProjectView['capacity'];
  readonly scheduling?: ProjectRecord['scheduling'];
  readonly verification?: ProjectRecord['verification'];
  readonly supervision: Omit<SupervisionRecord, 'audit'>;
  readonly events: Parameters<typeof appendSupervisionMutation>[0]['events'];
  readonly audits: Parameters<typeof appendSupervisionMutation>[0]['audits'];
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly nextId: () => string;
}): ProjectRecord {
  const appended = appendSupervisionMutation({
    record: input.record,
    events: input.events,
    audits: input.audits,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    nextId: input.nextId,
  });
  const lastSequence = appended.events.at(-1)?.sequence ?? input.record.view.lastSequence;
  return Object.freeze({
    ...input.record,
    view: Object.freeze({
      ...input.record.view,
      status: input.status ?? input.record.view.status,
      version: input.record.view.version + 1,
      tasks: input.tasks ?? input.record.view.tasks,
      capacity: input.capacity ?? input.record.view.capacity,
      lastSequence,
    }),
    scheduling: input.scheduling ?? input.record.scheduling,
    verification: input.verification ?? input.record.verification,
    supervision: Object.freeze({ ...input.supervision, audit: appended.audit }),
    events: Object.freeze([...input.record.events, ...appended.events]),
  });
}

function updateTaskState(
  record: ProjectRecord,
  state: ProjectView['tasks'][number]['state'],
): ProjectView['tasks'] {
  return Object.freeze(
    record.view.tasks.map((task, index) =>
      index === 0 ? Object.freeze({ ...task, state }) : task,
    ),
  );
}

function controlStates(command: ControlCommand) {
  if (command === 'PAUSE') return ['PAUSING', 'PAUSED'] as const;
  if (command === 'RESUME') return ['RESUMING', 'ACTIVE'] as const;
  if (command === 'STOP') return ['STOPPING', 'STOPPED'] as const;
  return ['CANCELLING', 'CANCELLED'] as const;
}

function latestExecutionVersion(record: ProjectRecord, executionId: string): number {
  return record.events.reduce(
    (version, event) =>
      event.aggregate.type === 'EXECUTION' && event.aggregate.id === executionId
        ? Math.max(version, event.aggregate.version)
        : version,
    0,
  );
}

function executionPath(from: ExecutionState, to: ExecutionState): readonly ExecutionState[] {
  if (from === to) return Object.freeze([]);
  const pending: Array<{
    readonly state: ExecutionState;
    readonly path: readonly ExecutionState[];
  }> = [{ state: from, path: Object.freeze([]) }];
  const visited = new Set<ExecutionState>([from]);
  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined) break;
    for (const next of EXECUTION_TRANSITIONS[candidate.state]) {
      if (visited.has(next)) continue;
      const path = Object.freeze([...candidate.path, next]);
      if (next === to) return path;
      visited.add(next);
      pending.push({ state: next, path });
    }
  }
  throw new Error(`No legal execution transition path from ${from} to ${to}`);
}

function executionTransitionEvents(input: {
  readonly record: ProjectRecord;
  readonly executionId: string;
  readonly fromState: ExecutionState;
  readonly toState: ExecutionState;
  readonly systemId: string;
  readonly reasonCode: string;
  readonly summary: string;
}): readonly Parameters<typeof appendSupervisionMutation>[0]['events'][number][] {
  let aggregate = {
    state: input.fromState,
    version: latestExecutionVersion(input.record, input.executionId),
  };
  const events: Array<Parameters<typeof appendSupervisionMutation>[0]['events'][number]> = [];
  for (const nextState of executionPath(input.fromState, input.toState)) {
    const transitioned = transitionExecution(
      aggregate,
      nextState,
      nextState === 'RECONCILING'
        ? { type: 'RECOVERY_COORDINATOR', id: input.systemId }
        : { type: 'SYSTEM', id: input.systemId },
      aggregate.version,
    );
    events.push({
      kind: 'execution.state_changed',
      actor: { type: 'SYSTEM', id: input.systemId },
      aggregate: {
        type: 'EXECUTION',
        id: input.executionId,
        version: transitioned.version,
      },
      payload: {
        fromState: aggregate.state,
        toState: transitioned.state,
        reasonCode: input.reasonCode,
        summary: input.summary,
      },
    });
    aggregate = transitioned;
  }
  return Object.freeze(events);
}

function successorExecutionEvents(
  executionId: string,
  systemId: string,
): readonly Parameters<typeof appendSupervisionMutation>[0]['events'][number][] {
  const events: Array<Parameters<typeof appendSupervisionMutation>[0]['events'][number]> = [
    {
      kind: 'execution.state_changed',
      actor: { type: 'SYSTEM', id: systemId },
      aggregate: { type: 'EXECUTION', id: executionId, version: 1 },
      payload: {
        fromState: null,
        toState: 'QUEUED',
        reasonCode: 'SUCCESSOR_EXECUTION_CREATED',
        summary: 'Resume created a fresh successor execution under new authority',
      },
    },
  ];
  let aggregate: { readonly state: ExecutionState; readonly version: number } = {
    state: 'QUEUED',
    version: 1,
  };
  for (const nextState of ['STARTING', 'RUNNING', 'WAITING_FOR_APPROVAL'] as const) {
    const transitioned = transitionExecution(
      aggregate,
      nextState,
      { type: 'SYSTEM', id: systemId },
      aggregate.version,
    );
    events.push({
      kind: 'execution.state_changed',
      actor: { type: 'SYSTEM', id: systemId },
      aggregate: { type: 'EXECUTION', id: executionId, version: transitioned.version },
      payload: {
        fromState: aggregate.state,
        toState: transitioned.state,
        reasonCode: 'SUCCESSOR_EXECUTION_STARTED',
        summary: 'Successor execution reached the bounded approval boundary',
      },
    });
    aggregate = transitioned;
  }
  return Object.freeze(events);
}

export class SupervisionService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: {
      readonly repository: ProjectRepository;
      readonly effectExecutor: ApprovedEffectExecutor;
      readonly nextId: () => string;
      readonly expectedRevision: string;
      readonly systemId: string;
      readonly runnerId: string;
    },
  ) {}

  private async exclusive<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(projectId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.queues.get(projectId) === queued) this.queues.delete(projectId);
    }
  }

  private async record(projectId: string): Promise<ProjectRecord> {
    const record = await this.dependencies.repository.get(projectId);
    if (record === null) fail('PROJECT_NOT_FOUND', 'Project not found', 404);
    return record;
  }

  private async expireDueApproval(projectId: string): Promise<void> {
    const record = await this.record(projectId);
    const now = await this.dependencies.repository.authorityNow();
    const due = record.supervision.approvals.find(
      ({ state, expiresAt }) => state === 'REQUESTED' && Date.parse(now) >= Date.parse(expiresAt),
    );
    if (due === undefined) return;
    try {
      await this.dependencies.repository.mutate({
        scope: `approval-expiry:${projectId}`,
        idempotencyKey: `${due.approvalId}:${due.version}`,
        requestHash: commandRequestHash({ approvalId: due.approvalId, version: due.version }),
        projectId,
        mutate: async (current, authorityNow) => {
          const approval = current.supervision.approvals.find(
            ({ approvalId }) => approvalId === due.approvalId,
          );
          if (
            approval === undefined ||
            approval.state !== 'REQUESTED' ||
            Date.parse(authorityNow) < Date.parse(approval.expiresAt)
          ) {
            throw new ControlPlaneError(
              'APPROVAL_EXPIRY_SUPERSEDED',
              'Approval expiry was superseded by a concurrent decision',
              409,
            );
          }
          const expired = Object.freeze({
            ...approval,
            state: 'EXPIRED' as const,
            version: approval.version + 1,
            usable: false,
          });
          const approvals = Object.freeze(
            current.supervision.approvals.map((item) =>
              item.approvalId === expired.approvalId ? expired : item,
            ),
          );
          const approvalIndex = current.supervision.approvals.findIndex(
            ({ approvalId }) => approvalId === expired.approvalId,
          );
          const effects = Object.freeze(
            current.supervision.effects.map((effect, index) =>
              index === approvalIndex && effect.state === 'REQUESTED'
                ? Object.freeze({
                    ...effect,
                    state: 'FAILED' as const,
                    reconciliationOutcome: 'NOT_APPLIED:APPROVAL_EXPIRED',
                    version: effect.version + 1,
                  })
                : effect,
            ),
          );
          const changed = replaceRecord({
            record: current,
            status: current.view.status === 'ACTIVE' ? 'BLOCKED' : current.view.status,
            tasks: updateTaskState(current, 'BLOCKED'),
            supervision: {
              ...current.supervision,
              approvals,
              effects,
              toolInvocationState: 'EXPIRED',
              blockedReasons: Object.freeze(['Approval expired']),
            },
            events: [
              {
                kind: 'approval.decided',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: { type: 'APPROVAL', id: expired.approvalId, version: expired.version },
                payload: {
                  decision: 'EXPIRED',
                  reasonCode: 'APPROVAL_EXPIRED',
                  summary: 'Approval expired without authorizing the fixture effect',
                },
              },
            ],
            audits: [
              {
                actorType: 'SYSTEM',
                actorId: this.dependencies.systemId,
                action: 'approval.expired',
                targetType: 'APPROVAL',
                targetId: expired.approvalId,
                reason: 'Approval lease reached its authoritative expiry',
                outcome: 'EXPIRED',
              },
            ],
            occurredAt: authorityNow,
            correlationId: current.events[0]?.correlationId ?? this.dependencies.nextId(),
            nextId: this.dependencies.nextId,
          });
          return { record: changed, response: approvalPublic(expired) };
        },
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'APPROVAL_EXPIRY_SUPERSEDED') return;
      throw error;
    }
  }

  async getProjection(projectId: string): Promise<SupervisionProjection> {
    await this.exclusive(projectId, () => this.expireDueApproval(projectId));
    return projection(await this.record(projectId));
  }

  async listApprovals(projectId: string, state?: string) {
    const current = await this.getProjection(projectId);
    return Object.freeze({
      items: Object.freeze(
        current.approvals
          .filter((approval) => state === undefined || approval.state === state)
          .map(approvalPublic),
      ),
      budget: current.budget,
      authority: current.authority,
      checkpoint:
        current.checkpoint === null
          ? null
          : Object.freeze({
              checkpointId: current.checkpoint.checkpointId,
              contentHash: current.checkpoint.contentHash,
              createdAt: current.checkpoint.createdAt,
            }),
      recovery: current.recovery,
      effects: current.effects,
      blockedReasons: current.blockedReasons,
      projectState: current.projectState,
      projectVersion: current.projectVersion,
    });
  }

  async getApproval(projectId: string, approvalId: string) {
    const current = await this.getProjection(projectId);
    const approval = current.approvals.find((item) => item.approvalId === approvalId);
    if (approval === undefined) fail('APPROVAL_NOT_FOUND', 'Approval not found', 404);
    return approvalPublic(approval);
  }

  async decideApproval(command: DecisionCommand): Promise<{
    readonly approval: Omit<ApprovalProjection, 'usable'>;
  }> {
    if (command.reason.trim().length === 0 || command.reason.length > 1_000)
      fail('DECISION_REASON_INVALID', 'Decision reason must be between 1 and 1000 characters');
    const mutation = await this.exclusive(command.projectId, () =>
      this.dependencies.repository.mutate({
        scope: `approval-decision:${command.projectId}:${command.approvalId}`,
        idempotencyKey: command.idempotencyKey,
        requestHash: commandRequestHash({
          actionDigest: command.actionDigest,
          approvalId: command.approvalId,
          decision: command.decision,
          expectedVersion: command.expectedVersion,
          projectId: command.projectId,
          reason: command.reason,
        }),
        projectId: command.projectId,
        mutate: async (record, authorityNow) => {
          const approval = record.supervision.approvals.find(
            ({ approvalId }) => approvalId === command.approvalId,
          );
          if (approval === undefined) fail('APPROVAL_NOT_FOUND', 'Approval not found', 404);
          if (approval.requesterAgentId === command.actorId)
            fail(
              'SELF_APPROVAL_DENIED',
              'An approval requester cannot decide its own request',
              403,
            );
          if (approval.actionDigest !== command.actionDigest)
            fail('ACTION_DIGEST_MISMATCH', 'The action no longer matches the presented approval');
          if (approval.version !== command.expectedVersion)
            fail('APPROVAL_VERSION_CONFLICT', 'Approval version precondition failed', 412);
          if (approval.state !== 'REQUESTED')
            fail('APPROVAL_ALREADY_DECIDED', 'Approval already has a terminal decision', 409);
          const expired = Date.parse(authorityNow) >= Date.parse(approval.expiresAt);
          const state = expired
            ? ('EXPIRED' as const)
            : command.decision === 'APPROVE'
              ? ('APPROVED' as const)
              : ('REJECTED' as const);
          const decided = Object.freeze({
            ...approval,
            state,
            decidedAt: expired ? null : authorityNow,
            decisionActorId: expired ? null : command.actorId,
            version: approval.version + 1,
            usable: !expired && state === 'APPROVED' && record.view.status === 'ACTIVE',
          });
          const approvals = Object.freeze(
            record.supervision.approvals.map((item) =>
              item.approvalId === decided.approvalId ? decided : item,
            ),
          );
          const rejected = state === 'REJECTED' || state === 'EXPIRED';
          const effects = rejected
            ? Object.freeze(
                record.supervision.effects.map((effect) =>
                  effect.actionDigest === decided.actionDigest && effect.state === 'REQUESTED'
                    ? Object.freeze({
                        ...effect,
                        state: 'FAILED' as const,
                        reconciliationOutcome: `NOT_APPLIED:APPROVAL_${state}`,
                        version: effect.version + 1,
                      })
                    : effect,
                ),
              )
            : record.supervision.effects;
          const nextStatus =
            rejected && record.view.status === 'ACTIVE' ? ('BLOCKED' as const) : record.view.status;
          const changed = replaceRecord({
            record,
            status: nextStatus,
            tasks: rejected ? updateTaskState(record, 'BLOCKED') : record.view.tasks,
            supervision: {
              ...record.supervision,
              authority: Object.freeze({
                ...record.supervision.authority,
                runnerLastHeartbeatAt: authorityNow,
              }),
              approvals,
              effects,
              toolInvocationState: state,
              blockedReasons: rejected
                ? Object.freeze([state === 'EXPIRED' ? 'Approval expired' : 'Approval rejected'])
                : Object.freeze([]),
            },
            events: [
              {
                kind: 'approval.decided',
                actor: expired
                  ? { type: 'SYSTEM', id: this.dependencies.systemId }
                  : { type: 'SUPERVISOR', id: command.actorId },
                aggregate: {
                  type: 'APPROVAL',
                  id: decided.approvalId,
                  version: decided.version,
                },
                payload: {
                  decision: state,
                  reasonCode: expired ? 'APPROVAL_EXPIRED' : `SUPERVISOR_${state}`,
                  summary: expired
                    ? 'Approval expired without authorizing the fixture effect'
                    : `Supervisor ${state.toLocaleLowerCase('en-US')} the fixture effect`,
                },
              },
            ],
            audits: [
              {
                actorType: expired ? 'SYSTEM' : 'SUPERVISOR',
                actorId: expired ? this.dependencies.systemId : command.actorId,
                action: expired ? 'approval.expired' : 'approval.decided',
                targetType: 'APPROVAL',
                targetId: decided.approvalId,
                reason: command.reason,
                outcome: state,
              },
            ],
            occurredAt: authorityNow,
            correlationId: command.correlationId,
            nextId: this.dependencies.nextId,
          });
          return {
            record: changed,
            response: Object.freeze({ approval: approvalPublic(decided), expired }),
          };
        },
      }),
    );
    if (mutation.response.expired)
      fail('APPROVAL_EXPIRED', 'Approval expired before the decision was committed');
    if (mutation.response.approval.state === 'APPROVED') {
      await this.executeApprovedEffect(
        command.projectId,
        command.approvalId,
        command.correlationId,
      );
    }
    return Object.freeze({ approval: mutation.response.approval });
  }

  private async executeApprovedEffect(
    projectId: string,
    approvalId: string,
    correlationId: string,
  ): Promise<void> {
    const current = await this.record(projectId);
    const approvalIndex = current.supervision.approvals.findIndex(
      (item) => item.approvalId === approvalId,
    );
    const approval = current.supervision.approvals[approvalIndex];
    const effect = current.supervision.effects[approvalIndex];
    if (approval === undefined || effect === undefined) throw new Error('Approved effect missing');
    if (effect.state === 'EXECUTING' || effect.state === 'UNKNOWN') {
      await this.recoverApprovedEffect(current, effect.effectId, correlationId);
      return;
    }
    if (
      effect.state !== 'REQUESTED' ||
      approval.state !== 'APPROVED' ||
      !approval.usable ||
      current.view.status !== 'ACTIVE' ||
      current.supervision.authority.capabilityLeaseState !== 'ACTIVE' ||
      current.supervision.authority.runnerLeaseState !== 'ACTIVE'
    ) {
      return;
    }
    const attempt = await this.dependencies.repository
      .mutate({
        scope: `effect-attempt:${projectId}`,
        idempotencyKey: effect.effectId,
        requestHash: commandRequestHash({
          actionDigest: effect.actionDigest,
          effectId: effect.effectId,
        }),
        projectId,
        reserveRunnerCapacity: true,
        mutate: async (record, authorityNow, capacity) => {
          const liveApproval = record.supervision.approvals.find(
            (item) => item.approvalId === approvalId,
          );
          const liveEffect = record.supervision.effects.find(
            (item) => item.effectId === effect.effectId,
          );
          if (liveApproval === undefined || liveEffect === undefined)
            throw new Error('Approved effect missing');
          if (
            liveApproval.state !== 'APPROVED' ||
            !liveApproval.usable ||
            record.view.status !== 'ACTIVE' ||
            record.supervision.authority.capabilityLeaseState !== 'ACTIVE' ||
            record.supervision.authority.runnerLeaseState !== 'ACTIVE'
          ) {
            fail('EFFECT_AUTHORITY_REVOKED', 'Effect authority is not currently active', 409);
          }
          if (Date.parse(authorityNow) >= Date.parse(liveApproval.expiresAt))
            fail('APPROVAL_EXPIRED', 'Approval expired before effect execution');
          if (
            Date.parse(authorityNow) >=
              Date.parse(record.supervision.authority.capabilityLeaseExpiresAt) ||
            Date.parse(authorityNow) >=
              Date.parse(record.supervision.authority.runnerLeaseExpiresAt)
          ) {
            fail('EFFECT_AUTHORITY_EXPIRED', 'Effect authority expired before execution', 409);
          }
          if (
            record.supervision.budget.consumedInvocations >=
              record.supervision.budget.invocationLimit ||
            record.supervision.budget.consumedMonetaryMicros + 100 >
              record.supervision.budget.monetaryLimitMicros
          ) {
            fail('EFFECT_BUDGET_EXHAUSTED', 'Effect budget is exhausted', 409);
          }
          if (capacity === undefined) throw new Error('Runner capacity snapshot missing');
          if (capacity.activeRunnerJobs >= record.view.capacity.runnerJobLimit) {
            fail('RUNNER_CAPACITY', 'Runner capacity is already reserved', 409);
          }
          const actionDigest = canonicalActionDigest(record.supervision.action);
          if (
            actionDigest !== liveApproval.actionDigest ||
            actionDigest !== liveEffect.actionDigest
          ) {
            fail('ACTION_DIGEST_MISMATCH', 'Stored action no longer matches its approval');
          }
          const executing = Object.freeze({
            ...liveEffect,
            state: 'EXECUTING' as const,
            version: liveEffect.version + 1,
          });
          const effects = Object.freeze(
            record.supervision.effects.map((item) =>
              item.effectId === executing.effectId ? executing : item,
            ),
          );
          const approvals = Object.freeze(
            record.supervision.approvals.map((item) =>
              item.approvalId === liveApproval.approvalId
                ? Object.freeze({ ...item, usable: false })
                : item,
            ),
          );
          const specialistId = record.organization.specialist.agentId;
          const currentPresence = record.view.presences.find(
            ({ agentId }) => agentId === specialistId,
          );
          const changedBase = replaceRecord({
            record,
            tasks: updateTaskState(record, 'RUNNING'),
            capacity: Object.freeze({
              ...record.view.capacity,
              activeRunnerJobs: Math.min(
                record.view.capacity.runnerJobLimit,
                capacity.activeRunnerJobs + 1,
              ),
            }),
            supervision: {
              ...record.supervision,
              approvals,
              effects,
              blockedReasons: Object.freeze(
                record.supervision.blockedReasons.filter(
                  (reason) => reason !== 'Waiting for runner capacity',
                ),
              ),
            },
            events: [
              {
                kind: 'effect.state_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: {
                  type: 'EXTERNAL_EFFECT',
                  id: executing.effectId,
                  version: executing.version,
                },
                payload: {
                  fromState: liveEffect.state,
                  toState: 'EXECUTING',
                  reasonCode: 'APPROVAL_AUTHORITY_VALIDATED',
                  summary: 'Approved fixture effect attempt entered its fenced boundary',
                },
              },
              {
                kind: 'task.state_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: {
                  type: 'TASK',
                  id: executing.taskId,
                  version: record.view.tasks[0]?.state === 'WAITING_FOR_CAPACITY' ? 3 : 2,
                },
                payload: {
                  fromState: record.view.tasks[0]?.state ?? null,
                  toState: 'RUNNING',
                  reasonCode: 'RUNNER_CAPACITY_RESERVED',
                  summary: 'Approved fixture effect reserved the single runner slot',
                },
              },
              {
                kind: 'agent.presence_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: {
                  type: 'AGENT',
                  id: specialistId,
                  version: currentPresence?.state === 'WAITING_FOR_RUNNER' ? 4 : 3,
                },
                payload: {
                  fromState: currentPresence?.state ?? null,
                  toState: 'USING_TOOLS',
                  reasonCode: 'RUNNER_CAPACITY_RESERVED',
                  summary: 'Specialist crossed the approved runner effect boundary',
                },
              },
            ],
            audits: [
              {
                actorType: 'SYSTEM',
                actorId: this.dependencies.systemId,
                action: 'effect.attempt',
                targetType: 'EXTERNAL_EFFECT',
                targetId: executing.effectId,
                reason: 'Approval digest, policy, budget, and leases revalidated',
                outcome: 'EXECUTING',
              },
            ],
            occurredAt: authorityNow,
            correlationId,
            nextId: this.dependencies.nextId,
          });
          const changed = Object.freeze({
            ...changedBase,
            view: Object.freeze({
              ...changedBase.view,
              presences: Object.freeze(
                changedBase.view.presences.map((presence) =>
                  presence.agentId === specialistId
                    ? Object.freeze({
                        ...presence,
                        state: 'USING_TOOLS' as const,
                        sourceType: 'EXECUTION' as const,
                        sourceId: record.supervision.authority.executionId,
                        updatedAt: authorityNow,
                        activity: 'Applying approved fixture effect',
                      })
                    : presence,
                ),
              ),
            }),
          });
          return {
            record: changed,
            response: Object.freeze({
              effect: executing,
              approval: liveApproval,
              authority: record.supervision.authority,
              authorizedAt: authorityNow,
              action: record.supervision.action,
            }),
          };
        },
      })
      .catch((error: unknown) => {
        if (error instanceof ControlPlaneError) {
          if (error.code === 'EFFECT_AUTHORITY_REVOKED') return null;
          if (error.code === 'RUNNER_CAPACITY') return 'WAITING_FOR_RUNNER' as const;
        }
        throw error;
      });
    if (attempt === null) return;
    if (attempt === 'WAITING_FOR_RUNNER') {
      await this.persistRunnerCapacityWait(projectId, effect.effectId, correlationId);
      return;
    }
    if (attempt.reused) {
      await this.recoverApprovedEffect(
        await this.record(projectId),
        effect.effectId,
        correlationId,
      );
      return;
    }
    let result: Awaited<ReturnType<ApprovedEffectExecutor['execute']>> | undefined;
    try {
      result = await this.dependencies.effectExecutor.execute({
        messageId: this.dependencies.nextId(),
        correlationId,
        effectId: attempt.response.effect.effectId,
        actionDigest: attempt.response.effect.actionDigest,
        operation: attempt.response.action.operation,
        executionId: attempt.response.authority.executionId,
        leaseId: attempt.response.authority.runnerLeaseId,
        fencingToken: attempt.response.authority.fencingToken,
        approval: {
          state: 'APPROVED',
          actionDigest: attempt.response.approval.actionDigest,
          expiresAt: attempt.response.approval.expiresAt,
        },
        authority: {
          authorizedAt: attempt.response.authorizedAt,
          leaseExpiresAt: attempt.response.authority.runnerLeaseExpiresAt,
        },
      });
    } catch {
      result = undefined;
    }
    if (result === undefined) {
      await this.persistUnknownEffect(projectId, effect.effectId, correlationId);
    } else {
      await this.persistAppliedEffect(
        projectId,
        effect.effectId,
        result.groundTruthDigest,
        correlationId,
      );
    }
  }

  private async persistRunnerCapacityWait(
    projectId: string,
    effectId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.dependencies.repository.mutate({
        scope: `effect-capacity-wait:${projectId}`,
        idempotencyKey: effectId,
        requestHash: commandRequestHash({ effectId, reason: 'RUNNER_CAPACITY' }),
        projectId,
        mutate: async (record, authorityNow) => {
          const live = record.supervision.effects.find((item) => item.effectId === effectId);
          if (live === undefined) throw new Error('Effect missing');
          if (live.state !== 'REQUESTED') {
            fail(
              'EFFECT_CAPACITY_WAIT_SUPERSEDED',
              'Effect already crossed its runner boundary',
              409,
            );
          }
          const specialistId = record.organization.specialist.agentId;
          const currentPresence = record.view.presences.find(
            ({ agentId }) => agentId === specialistId,
          );
          const changed = replaceRecord({
            record,
            tasks: updateTaskState(record, 'WAITING_FOR_CAPACITY'),
            supervision: {
              ...record.supervision,
              blockedReasons: Object.freeze(
                record.supervision.blockedReasons.includes('Waiting for runner capacity')
                  ? record.supervision.blockedReasons
                  : [...record.supervision.blockedReasons, 'Waiting for runner capacity'],
              ),
            },
            events: [
              {
                kind: 'task.state_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: { type: 'TASK', id: live.taskId, version: 2 },
                payload: {
                  fromState: record.view.tasks[0]?.state ?? null,
                  toState: 'WAITING_FOR_CAPACITY',
                  reasonCode: 'RUNNER_CAPACITY',
                  summary: 'Approved fixture effect waits for the single runner slot',
                },
              },
              {
                kind: 'agent.presence_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: { type: 'AGENT', id: specialistId, version: 3 },
                payload: {
                  fromState: currentPresence?.state ?? null,
                  toState: 'WAITING_FOR_RUNNER',
                  reasonCode: 'RUNNER_CAPACITY',
                  summary: 'Specialist waits for the single runner slot',
                },
              },
            ],
            audits: [
              {
                actorType: 'SYSTEM',
                actorId: this.dependencies.systemId,
                action: 'effect.queued',
                targetType: 'EXTERNAL_EFFECT',
                targetId: live.effectId,
                reason: 'Single runner slot is durably reserved by another external effect',
                outcome: 'WAITING_FOR_RUNNER',
              },
            ],
            occurredAt: authorityNow,
            correlationId,
            nextId: this.dependencies.nextId,
          });
          return {
            record: Object.freeze({
              ...changed,
              view: Object.freeze({
                ...changed.view,
                presences: Object.freeze(
                  changed.view.presences.map((presence) =>
                    presence.agentId === specialistId
                      ? Object.freeze({
                          ...presence,
                          state: 'WAITING_FOR_RUNNER' as const,
                          sourceType: 'EXECUTION' as const,
                          sourceId: record.supervision.authority.executionId,
                          updatedAt: authorityNow,
                          activity: 'Waiting for runner capacity',
                        })
                      : presence,
                  ),
                ),
              }),
            }),
            response: Object.freeze({ waiting: true }),
          };
        },
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'EFFECT_CAPACITY_WAIT_SUPERSEDED') {
        return;
      }
      throw error;
    }
  }

  private async recoverApprovedEffect(
    record: ProjectRecord,
    effectId: string,
    correlationId: string,
  ): Promise<void> {
    const effect = record.supervision.effects.find((candidate) => candidate.effectId === effectId);
    if (effect === undefined || !['EXECUTING', 'UNKNOWN'].includes(effect.state)) return;
    let groundTruth: Awaited<ReturnType<ApprovedEffectExecutor['lookup']>>;
    try {
      groundTruth = await this.dependencies.effectExecutor.lookup({
        messageId: this.dependencies.nextId(),
        correlationId,
        effectId: effect.effectId,
        actionDigest: effect.actionDigest,
        executionId: record.supervision.authority.executionId,
        leaseId: record.supervision.authority.runnerLeaseId,
        fencingToken: record.supervision.authority.fencingToken,
      });
    } catch {
      groundTruth = Object.freeze({
        outcome: 'INDETERMINATE' as const,
        groundTruthDigest: null,
      });
    }
    if (groundTruth.outcome === 'APPLIED' && groundTruth.groundTruthDigest != null) {
      await this.persistAppliedEffect(
        record.view.projectId,
        effect.effectId,
        groundTruth.groundTruthDigest,
        correlationId,
      );
      return;
    }
    await this.persistUnknownEffect(record.view.projectId, effect.effectId, correlationId);
  }

  private async persistUnknownEffect(
    projectId: string,
    effectId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.dependencies.repository.mutate({
        scope: `effect-unknown:${projectId}`,
        idempotencyKey: effectId,
        requestHash: commandRequestHash({ effectId, outcome: 'UNKNOWN' }),
        projectId,
        mutate: async (record, authorityNow) => {
          const live = record.supervision.effects.find((item) => item.effectId === effectId);
          if (live === undefined) throw new Error('Effect missing');
          if (live.state !== 'EXECUTING') {
            fail(
              'EFFECT_RESULT_SUPERSEDED',
              'Effect ground truth was already committed by control reconciliation',
              409,
            );
          }
          const resolved = Object.freeze({
            ...live,
            state: 'UNKNOWN' as const,
            reconciliationOutcome: 'RECONCILIATION_REQUIRED',
            version: live.version + 1,
          });
          const blockedReasons = Object.freeze(
            record.supervision.blockedReasons.includes('Effect ground truth is unknown')
              ? record.supervision.blockedReasons
              : [...record.supervision.blockedReasons, 'Effect ground truth is unknown'],
          );
          const changed = replaceRecord({
            record,
            status: ['PAUSING', 'STOPPING', 'CANCELLING'].includes(record.view.status)
              ? record.view.status
              : 'BLOCKED',
            supervision: {
              ...record.supervision,
              effects: Object.freeze(
                record.supervision.effects.map((item) =>
                  item.effectId === resolved.effectId ? resolved : item,
                ),
              ),
              blockedReasons,
            },
            events: [
              {
                kind: 'effect.state_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: {
                  type: 'EXTERNAL_EFFECT',
                  id: resolved.effectId,
                  version: resolved.version,
                },
                payload: {
                  fromState: live.state,
                  toState: resolved.state,
                  reasonCode: 'EFFECT_OUTCOME_UNKNOWN',
                  summary: 'Effect outcome requires supervisor-visible reconciliation',
                },
              },
            ],
            audits: [
              {
                actorType: 'RUNNER',
                actorId: this.dependencies.runnerId,
                action: 'effect.result',
                targetType: 'EXTERNAL_EFFECT',
                targetId: resolved.effectId,
                reason: 'Runner outcome unavailable',
                outcome: resolved.state,
              },
            ],
            occurredAt: authorityNow,
            correlationId,
            nextId: this.dependencies.nextId,
          });
          return { record: changed, response: resolved };
        },
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'EFFECT_RESULT_SUPERSEDED') return;
      throw error;
    }
  }

  private async persistAppliedEffect(
    projectId: string,
    effectId: string,
    groundTruthDigest: `sha256:${string}`,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.dependencies.repository.mutate({
        scope: `effect-result:${projectId}`,
        idempotencyKey: effectId,
        requestHash: commandRequestHash({ effectId, outcome: 'GROUND_TRUTH_APPLIED' }),
        projectId,
        mutate: async (record, authorityNow) => {
          const live = record.supervision.effects.find((item) => item.effectId === effectId);
          if (live === undefined) throw new Error('Effect missing');
          if (live.state !== 'EXECUTING' && live.state !== 'UNKNOWN') {
            fail(
              'EFFECT_RESULT_SUPERSEDED',
              'Effect ground truth was already committed by control reconciliation',
              409,
            );
          }
          const recovered = live.state === 'UNKNOWN';
          const resolved = Object.freeze({
            ...live,
            state: recovered ? ('RECONCILED' as const) : ('APPLIED' as const),
            groundTruthDigest,
            reconciliationOutcome: 'GROUND_TRUTH_APPLIED',
            version: live.version + (recovered ? 2 : 1),
          });
          const remainingBlockedReasons = record.supervision.blockedReasons.filter(
            (reason) => reason !== 'Effect ground truth is unknown',
          );
          const mayReactivate =
            record.view.status === 'BLOCKED' &&
            remainingBlockedReasons.length === 0 &&
            record.supervision.authority.capabilityLeaseState === 'ACTIVE' &&
            record.supervision.authority.runnerLeaseState === 'ACTIVE';
          const events: Array<Parameters<typeof appendSupervisionMutation>[0]['events'][number]> =
            [];
          if (recovered) {
            events.push({
              kind: 'effect.state_changed',
              actor: { type: 'SYSTEM', id: this.dependencies.systemId },
              aggregate: {
                type: 'EXTERNAL_EFFECT',
                id: resolved.effectId,
                version: live.version + 1,
              },
              payload: {
                fromState: 'UNKNOWN',
                toState: 'RECONCILING',
                reasonCode: 'RUNNER_LEDGER_RECONCILIATION_STARTED',
                summary: 'Idempotent recovery queried the authenticated runner ledger',
              },
            });
          }
          events.push({
            kind: 'effect.state_changed',
            actor: { type: 'SYSTEM', id: this.dependencies.systemId },
            aggregate: {
              type: 'EXTERNAL_EFFECT',
              id: resolved.effectId,
              version: resolved.version,
            },
            payload: {
              fromState: recovered ? 'RECONCILING' : live.state,
              toState: resolved.state,
              reasonCode: 'RUNNER_GROUND_TRUTH_APPLIED',
              summary: 'Runner fixture ledger recorded the effect at most once',
            },
          });
          const changed = replaceRecord({
            record,
            status: mayReactivate ? 'ACTIVE' : record.view.status,
            capacity: Object.freeze({
              ...record.view.capacity,
              activeRunnerJobs: Math.max(0, record.view.capacity.activeRunnerJobs - 1),
            }),
            supervision: {
              ...record.supervision,
              effects: Object.freeze(
                record.supervision.effects.map((item) =>
                  item.effectId === resolved.effectId ? resolved : item,
                ),
              ),
              toolInvocationState: 'APPLIED',
              budget: Object.freeze({
                ...record.supervision.budget,
                consumedInvocations: record.supervision.budget.consumedInvocations + 1,
                consumedMonetaryMicros: record.supervision.budget.consumedMonetaryMicros + 100,
              }),
              blockedReasons: Object.freeze(remainingBlockedReasons),
            },
            events,
            audits: [
              {
                actorType: 'RUNNER',
                actorId: this.dependencies.runnerId,
                action: 'effect.result',
                targetType: 'EXTERNAL_EFFECT',
                targetId: resolved.effectId,
                reason: recovered
                  ? 'Idempotent authenticated runner ledger reconciliation'
                  : 'Queryable runner ledger result',
                outcome: resolved.state,
              },
            ],
            occurredAt: authorityNow,
            correlationId,
            nextId: this.dependencies.nextId,
          });
          return { record: changed, response: resolved };
        },
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === 'EFFECT_RESULT_SUPERSEDED') return;
      throw error;
    }
  }

  private async reconcileControlEffect(command: ControlProjectCommand): Promise<void> {
    const before = await this.record(command.projectId);
    const effect =
      before.supervision.effects.find(({ state }) =>
        ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state),
      ) ?? before.supervision.effects.at(-1);
    if (effect === undefined) return;
    const authorityReference = {
      messageId: this.dependencies.nextId(),
      correlationId: command.correlationId,
      effectId: effect.effectId,
      actionDigest: effect.actionDigest,
      executionId: before.supervision.authority.executionId,
      leaseId: before.supervision.authority.runnerLeaseId,
      fencingToken: before.supervision.authority.fencingToken,
    };
    let groundTruth: Awaited<ReturnType<ApprovedEffectExecutor['lookup']>>;
    if (
      effect.state === 'APPLIED' ||
      (effect.state === 'RECONCILED' && effect.reconciliationOutcome === 'GROUND_TRUTH_APPLIED')
    ) {
      groundTruth = Object.freeze({
        outcome: 'APPLIED' as const,
        groundTruthDigest: effect.groundTruthDigest,
      });
    } else if (
      effect.state === 'FAILED' ||
      (effect.state === 'RECONCILED' &&
        effect.reconciliationOutcome?.includes('NOT_APPLIED') === true)
    ) {
      groundTruth = Object.freeze({ outcome: 'NOT_APPLIED' as const, groundTruthDigest: null });
    } else {
      try {
        if (effect.state === 'RECONCILING') {
          groundTruth = await this.dependencies.effectExecutor.lookup(authorityReference);
        } else {
          try {
            groundTruth = await this.dependencies.effectExecutor.revoke({
              ...authorityReference,
              reason: command.reason,
            });
          } catch {
            groundTruth = await this.dependencies.effectExecutor.lookup(authorityReference);
          }
        }
      } catch {
        groundTruth = Object.freeze({
          outcome: 'INDETERMINATE' as const,
          groundTruthDigest: null,
        });
      }
    }
    try {
      await this.dependencies.repository.mutate({
        scope: `project-control-reconciliation:${command.projectId}`,
        idempotencyKey: command.idempotencyKey,
        requestHash: commandRequestHash({
          command: command.command,
          effectId: effect.effectId,
          groundTruthDigest: groundTruth.groundTruthDigest ?? null,
          outcome: groundTruth.outcome,
        }),
        projectId: command.projectId,
        mutate: async (record, authorityNow) => {
          if (!['PAUSING', 'STOPPING', 'CANCELLING', 'BLOCKED'].includes(record.view.status)) {
            fail(
              'CONTROL_RECONCILIATION_SUPERSEDED',
              'A newer control already established the project boundary',
              409,
            );
          }
          const latestControl = [...record.supervision.audit]
            .reverse()
            .find(({ action }) =>
              ['control.pause', 'control.stop', 'control.cancel'].includes(action),
            );
          const stateCommand =
            record.view.status === 'PAUSING'
              ? 'PAUSE'
              : record.view.status === 'STOPPING'
                ? 'STOP'
                : record.view.status === 'CANCELLING'
                  ? 'CANCEL'
                  : undefined;
          const auditedCommand = latestControl?.action.slice('control.'.length).toUpperCase();
          const effectiveCommand = (stateCommand ?? auditedCommand ?? command.command) as Exclude<
            ControlCommand,
            'RESUME'
          >;
          const effectiveCorrelationId = latestControl?.correlationId ?? command.correlationId;
          const live = record.supervision.effects.find(
            ({ effectId }) => effectId === effect.effectId,
          );
          if (live === undefined) throw new Error('Effect missing during control reconciliation');
          const knownApplied = live.state === 'APPLIED' || groundTruth.outcome === 'APPLIED';
          const knownNotApplied =
            live.state === 'FAILED' ||
            (live.state === 'RECONCILED' &&
              live.reconciliationOutcome?.includes('NOT_APPLIED') === true) ||
            groundTruth.outcome === 'NOT_APPLIED';
          const known = knownApplied || knownNotApplied;
          const effectEvents: Array<
            Parameters<typeof appendSupervisionMutation>[0]['events'][number]
          > = [];
          let resolved = live;
          if (!known) {
            if (live.state !== 'UNKNOWN') {
              resolved = Object.freeze({
                ...live,
                state: 'UNKNOWN' as const,
                reconciliationOutcome: 'RECONCILIATION_REQUIRED',
                version: live.version + 1,
              });
              effectEvents.push({
                kind: 'effect.state_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: {
                  type: 'EXTERNAL_EFFECT',
                  id: resolved.effectId,
                  version: resolved.version,
                },
                payload: {
                  fromState: live.state,
                  toState: 'UNKNOWN',
                  reasonCode: 'CONTROL_RECONCILIATION_INDETERMINATE',
                  summary: 'Revoked effect authority did not yield determinate ground truth',
                },
              });
            }
          } else if (live.state === 'EXECUTING') {
            resolved = Object.freeze({
              ...live,
              state: knownApplied ? ('APPLIED' as const) : ('FAILED' as const),
              groundTruthDigest:
                knownApplied && groundTruth.groundTruthDigest !== undefined
                  ? groundTruth.groundTruthDigest
                  : live.groundTruthDigest,
              reconciliationOutcome: knownApplied
                ? 'GROUND_TRUTH_APPLIED'
                : `NOT_APPLIED:${effectiveCommand}`,
              version: live.version + 1,
            });
            effectEvents.push({
              kind: 'effect.state_changed',
              actor: { type: 'SYSTEM', id: this.dependencies.systemId },
              aggregate: {
                type: 'EXTERNAL_EFFECT',
                id: resolved.effectId,
                version: resolved.version,
              },
              payload: {
                fromState: live.state,
                toState: resolved.state,
                reasonCode: 'CONTROL_GROUND_TRUTH_RECONCILED',
                summary: 'Runner ground truth closed the in-flight effect boundary',
              },
            });
          } else if (live.state === 'UNKNOWN' || live.state === 'RECONCILING') {
            let version = live.version;
            if (live.state === 'UNKNOWN') {
              version += 1;
              effectEvents.push({
                kind: 'effect.state_changed',
                actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                aggregate: { type: 'EXTERNAL_EFFECT', id: live.effectId, version },
                payload: {
                  fromState: 'UNKNOWN',
                  toState: 'RECONCILING',
                  reasonCode: 'CONTROL_AUTHORITY_FENCED',
                  summary: 'Control reconciliation queried the authenticated runner ledger',
                },
              });
            }
            version += 1;
            resolved = Object.freeze({
              ...live,
              state: 'RECONCILED' as const,
              groundTruthDigest:
                knownApplied && groundTruth.groundTruthDigest !== undefined
                  ? groundTruth.groundTruthDigest
                  : live.groundTruthDigest,
              reconciliationOutcome: knownApplied
                ? 'GROUND_TRUTH_APPLIED'
                : 'GROUND_TRUTH_NOT_APPLIED',
              version,
            });
            effectEvents.push({
              kind: 'effect.state_changed',
              actor: { type: 'SYSTEM', id: this.dependencies.systemId },
              aggregate: { type: 'EXTERNAL_EFFECT', id: resolved.effectId, version },
              payload: {
                fromState: 'RECONCILING',
                toState: 'RECONCILED',
                reasonCode: 'CONTROL_GROUND_TRUTH_RECONCILED',
                summary: 'Authenticated runner ledger returned determinate ground truth',
              },
            });
          }
          const effects = Object.freeze(
            record.supervision.effects.map((candidate) =>
              candidate.effectId === resolved.effectId ? resolved : candidate,
            ),
          );
          const terminal =
            effectiveCommand === 'PAUSE'
              ? ('PAUSED' as const)
              : effectiveCommand === 'CANCEL'
                ? ('CANCELLED' as const)
                : ('STOPPED' as const);
          const projectState = known ? terminal : ('BLOCKED' as const);
          const executionState = known
            ? effectiveCommand === 'PAUSE'
              ? ('SUSPENDED' as const)
              : effectiveCommand === 'CANCEL'
                ? ('CANCELLED' as const)
                : ('STOPPED' as const)
            : ('RECONCILING' as const);
          const effectWasNewlyApplied = knownApplied && live.state !== 'APPLIED';
          const effectNeedsResultAudit = ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(
            live.state,
          );
          const events: Array<Parameters<typeof appendSupervisionMutation>[0]['events'][number]> = [
            ...effectEvents,
            {
              kind: 'project.status_changed',
              actor: { type: 'SYSTEM', id: this.dependencies.systemId },
              aggregate: {
                type: 'PROJECT',
                id: command.projectId,
                version: record.view.version + 1,
              },
              payload: {
                fromState: record.view.status,
                toState: projectState,
                reasonCode: known
                  ? `${effectiveCommand}_SAFE_BOUNDARY_REACHED`
                  : 'CONTROL_EFFECT_GROUND_TRUTH_UNKNOWN',
                summary: known
                  ? `${effectiveCommand} reached its durable reconciled fixture boundary`
                  : 'Control remains blocked because effect ground truth is indeterminate',
              },
              classification: 'PUBLIC_FIXTURE',
            },
            ...executionTransitionEvents({
              record,
              executionId: record.supervision.authority.executionId,
              fromState: record.supervision.authority.executionState,
              toState: executionState,
              systemId: this.dependencies.systemId,
              reasonCode: known
                ? 'CONTROL_RECONCILIATION_COMPLETE'
                : 'CONTROL_RECONCILIATION_BLOCKED',
              summary: known
                ? 'Execution reached a known effect ground-truth boundary'
                : 'Execution awaits explicit effect-ground-truth remediation',
            }),
          ];
          const changed = replaceRecord({
            record,
            status: projectState,
            scheduling: Object.freeze({
              ...record.scheduling,
              execution: Object.freeze({
                ...record.scheduling.execution,
                state: executionState,
              }),
            }),
            capacity: known
              ? Object.freeze({
                  ...record.view.capacity,
                  activeRunnerJobs: Math.max(0, record.view.capacity.activeRunnerJobs - 1),
                })
              : record.view.capacity,
            tasks:
              known && effectiveCommand === 'CANCEL'
                ? updateTaskState(record, 'CANCELLED')
                : record.view.tasks,
            supervision: {
              ...record.supervision,
              effects,
              toolInvocationState: knownApplied
                ? 'APPLIED'
                : record.supervision.toolInvocationState,
              authority: Object.freeze({
                ...record.supervision.authority,
                executionState,
                capabilityLeaseState:
                  known && effectiveCommand === 'PAUSE' ? 'SUSPENDED' : 'REVOKED',
                runnerLeaseState: 'REVOKED',
              }),
              budget: effectWasNewlyApplied
                ? Object.freeze({
                    ...record.supervision.budget,
                    consumedInvocations: record.supervision.budget.consumedInvocations + 1,
                    consumedMonetaryMicros: record.supervision.budget.consumedMonetaryMicros + 100,
                  })
                : record.supervision.budget,
              blockedReasons: known
                ? effectiveCommand === 'CANCEL'
                  ? Object.freeze(['Project cancelled'])
                  : Object.freeze([])
                : Object.freeze([
                    'Effect ground truth is indeterminate after authority revocation',
                  ]),
            },
            events,
            audits: [
              ...(effectNeedsResultAudit
                ? [
                    {
                      actorType: 'RUNNER' as const,
                      actorId: this.dependencies.runnerId,
                      action: 'effect.result',
                      targetType: 'EXTERNAL_EFFECT',
                      targetId: resolved.effectId,
                      reason: 'Control-time authenticated runner ledger reconciliation',
                      outcome: known ? resolved.state : 'UNKNOWN',
                    },
                  ]
                : []),
              {
                actorType: 'SYSTEM',
                actorId: this.dependencies.systemId,
                action: `control.${effectiveCommand.toLocaleLowerCase('en-US')}.${known ? 'completed' : 'blocked'}`,
                targetType: 'PROJECT',
                targetId: command.projectId,
                reason: known
                  ? 'Effect ground truth is known after authority revocation'
                  : 'Effect ground truth remains indeterminate after authority revocation',
                outcome: projectState,
              },
            ],
            occurredAt: authorityNow,
            correlationId: effectiveCorrelationId,
            nextId: this.dependencies.nextId,
          });
          return { record: changed, response: { projectState, effectState: resolved.state } };
        },
      });
    } catch (error) {
      if (
        error instanceof ControlPlaneError &&
        error.code === 'CONTROL_RECONCILIATION_SUPERSEDED'
      ) {
        return;
      }
      throw error;
    }
  }

  async controlProject(command: ControlProjectCommand) {
    return this.exclusive(command.projectId, async () => {
      if (command.reason.trim().length === 0 || command.reason.length > 1_000)
        fail('CONTROL_REASON_INVALID', 'Control reason must be between 1 and 1000 characters');
      const result = await this.dependencies.repository.mutate({
        scope: `project-control:${command.projectId}`,
        idempotencyKey: command.idempotencyKey,
        requestHash: commandRequestHash({
          command: command.command,
          expectedVersion: command.expectedVersion,
          projectId: command.projectId,
          reason: command.reason,
        }),
        projectId: command.projectId,
        reserveCognitiveCapacity: command.command === 'RESUME',
        mutate: async (record, authorityNow, globalCapacity) => {
          try {
            evaluateControlCommand({
              command: command.command,
              projectState: record.view.status,
              expectedVersion: command.expectedVersion,
              actualVersion: record.view.version,
              actor: { type: 'SUPERVISOR', id: command.actorId },
              idempotencyKey: command.idempotencyKey,
            });
          } catch (error) {
            const code = error instanceof Error ? error.message : 'CONTROL_STATE_CONFLICT';
            fail(
              code === 'VERSION_CONFLICT' ? 'PROJECT_VERSION_CONFLICT' : code,
              code === 'VERSION_CONFLICT'
                ? 'Project version precondition failed'
                : 'Control command is invalid for the current project state',
              code === 'VERSION_CONFLICT' ? 412 : 409,
            );
          }
          if (
            command.command === 'RESUME' &&
            (globalCapacity === undefined ||
              globalCapacity.activeCognitiveRuns >=
                DEFAULT_POLICY_PROFILE.cognitiveConcurrency.default)
          ) {
            fail(
              'COGNITIVE_CAPACITY',
              'No cognitive concurrency slot is available for resume',
              409,
            );
          }
          const [transitional, terminal] = controlStates(command.command);
          const requiresEffectReconciliation =
            ['PAUSE', 'STOP', 'CANCEL'].includes(command.command) &&
            record.supervision.effects.some(({ state }) =>
              ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state),
            );
          let supervision: Omit<SupervisionRecord, 'audit'> = { ...record.supervision };
          let verificationRecord = record.verification;
          let tasks = record.view.tasks;
          let capacity = record.view.capacity;
          let scheduling = record.scheduling;
          const fromExecution = record.supervision.authority.executionState;
          const executionAlreadyTerminal = [
            'SUSPENDED',
            'STOPPED',
            'SUCCEEDED',
            'FAILED',
            'CANCELLED',
          ].includes(fromExecution);
          const events: Array<Parameters<typeof appendSupervisionMutation>[0]['events'][number]> = [
            {
              kind: 'project.status_changed',
              actor: { type: 'SUPERVISOR', id: command.actorId },
              aggregate: {
                type: 'PROJECT',
                id: command.projectId,
                version: record.view.version + 1,
              },
              payload: {
                fromState: record.view.status,
                toState: transitional,
                reasonCode: `SUPERVISOR_${command.command}`,
                summary: `Supervisor ${command.command.toLocaleLowerCase('en-US')} command accepted`,
              },
              classification: 'PUBLIC_FIXTURE',
            },
          ];
          if (!requiresEffectReconciliation) {
            events.push({
              kind: 'project.status_changed',
              actor: { type: 'SYSTEM', id: this.dependencies.systemId },
              aggregate: {
                type: 'PROJECT',
                id: command.projectId,
                version: record.view.version + 1,
              },
              payload: {
                fromState: transitional,
                toState: terminal,
                reasonCode: `${command.command}_SAFE_BOUNDARY_REACHED`,
                summary: `${command.command} reached its durable fixture boundary`,
              },
              classification: 'PUBLIC_FIXTURE',
            });
          }
          const audits: Array<Parameters<typeof appendSupervisionMutation>[0]['audits'][number]> = [
            {
              actorType: 'SUPERVISOR',
              actorId: command.actorId,
              action: `control.${command.command.toLocaleLowerCase('en-US')}`,
              targetType: 'PROJECT',
              targetId: command.projectId,
              reason: command.reason,
              outcome: requiresEffectReconciliation ? transitional : terminal,
            },
          ];
          if (command.command === 'PAUSE') {
            const checkpointId = this.dependencies.nextId();
            const checkpoint = checkpointFromProjectRecord({
              record,
              checkpointId,
              createdAt: authorityNow,
              reason: 'PAUSE',
            });
            const staleReason = 'Project reached PAUSED before verification commit';
            const evaluating = record.verification.evaluations.filter(
              ({ state }) => state === 'EVALUATING',
            );
            if (evaluating.length > 0) {
              verificationRecord = Object.freeze({
                ...record.verification,
                evaluations: Object.freeze(
                  record.verification.evaluations.map((evaluation) =>
                    evaluation.state === 'EVALUATING'
                      ? Object.freeze({
                          ...evaluation,
                          state: 'STALE' as const,
                          decidedAt: authorityNow,
                          ruleResults: Object.freeze([]),
                          blockingReasons: Object.freeze([staleReason]),
                        })
                      : evaluation,
                  ),
                ),
              });
              for (const evaluation of evaluating) {
                events.push({
                  kind: 'verification.decided',
                  actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                  aggregate: {
                    type: 'TASK',
                    id: evaluation.taskId,
                    version: record.verification.taskVersion,
                  },
                  payload: {
                    decision: 'STALE',
                    reasonCode: 'VERIFICATION_SNAPSHOT_STALE',
                    summary: staleReason,
                    evidenceRefs: evaluation.snapshot.evidence.map(({ evidenceId }) => evidenceId),
                  },
                });
                audits.push({
                  actorType: 'SYSTEM',
                  actorId: this.dependencies.systemId,
                  action: 'verification.decided',
                  targetType: 'TASK',
                  targetId: evaluation.taskId,
                  reason: staleReason,
                  outcome: 'STALE',
                });
              }
            }
            const supervisionVerification =
              record.supervision.verification.state === 'EVALUATING'
                ? Object.freeze({
                    ...record.supervision.verification,
                    state: 'STALE' as const,
                  })
                : record.supervision.verification;
            supervision = {
              ...record.supervision,
              approvals: Object.freeze(
                record.supervision.approvals.map((approval) =>
                  Object.freeze({ ...approval, usable: false }),
                ),
              ),
              authority: Object.freeze({
                ...record.supervision.authority,
                executionState: requiresEffectReconciliation
                  ? 'CHECKPOINTING'
                  : executionAlreadyTerminal
                    ? fromExecution
                    : 'SUSPENDED',
                capabilityLeaseState: 'SUSPENDED',
                runnerLeaseState: 'REVOKED',
              }),
              verification: supervisionVerification,
              checkpoint,
              recovery: Object.freeze({
                state: 'SAFE_CHECKPOINT' as const,
                sourceExecutionId: record.supervision.authority.executionId,
                successorExecutionId: null,
                sourceConnectionId: record.scheduling.execution.connectionId,
                targetConnectionId: null,
                progress: 'Safe checkpoint preserved for supervisor-controlled resume',
                updatedAt: authorityNow,
              }),
              blockedReasons:
                evaluating.length > 0
                  ? Object.freeze([staleReason])
                  : record.supervision.blockedReasons,
            };
            scheduling = Object.freeze({
              ...record.scheduling,
              execution: Object.freeze({
                ...record.scheduling.execution,
                state: supervision.authority.executionState,
              }),
            });
            capacity = Object.freeze({
              ...record.view.capacity,
              activeCognitiveRuns: Math.max(0, record.view.capacity.activeCognitiveRuns - 1),
            });
            events.push({
              kind: 'checkpoint.created',
              actor: { type: 'SYSTEM', id: this.dependencies.systemId },
              aggregate: { type: 'CHECKPOINT', id: checkpointId, version: 1 },
              payload: {
                referenceType: 'CHECKPOINT',
                referenceId: checkpointId,
                contentHash: checkpoint.contentHash,
                summary: 'Cooperative fixture work checkpointed while pause fenced authority',
              },
            });
          } else if (command.command === 'RESUME') {
            const fromStopped = record.view.status === 'STOPPED';
            let approvals = record.supervision.approvals.map((approval, index) =>
              Object.freeze({
                ...approval,
                usable:
                  (approval.state === 'REQUESTED' || approval.state === 'APPROVED') &&
                  record.supervision.effects[index]?.state === 'REQUESTED' &&
                  Date.parse(authorityNow) < Date.parse(approval.expiresAt),
              }),
            );
            let effects = [...record.supervision.effects];
            let toolInvocationId = record.supervision.toolInvocationId;
            let toolInvocationState = record.supervision.toolInvocationState;
            const requiresFreshIntent =
              record.supervision.effects.every(({ state }) => state !== 'APPLIED') &&
              record.supervision.effects.every(({ state }) => state !== 'REQUESTED');
            if ((fromStopped || record.view.status === 'PAUSED') && requiresFreshIntent) {
              const previousApproval = record.supervision.approvals.at(-1);
              const previousEffect = record.supervision.effects.at(-1);
              if (previousApproval !== undefined && previousEffect !== undefined) {
                toolInvocationId = this.dependencies.nextId();
                const approvalId = this.dependencies.nextId();
                const effectId = this.dependencies.nextId();
                approvals = [
                  ...approvals,
                  Object.freeze({
                    ...previousApproval,
                    approvalId,
                    state: 'REQUESTED' as const,
                    expiresAt: new Date(Date.parse(authorityNow) + 300_000).toISOString(),
                    decidedAt: null,
                    decisionActorId: null,
                    version: 1,
                    usable: true,
                  }),
                ];
                effects = [
                  ...effects,
                  Object.freeze({
                    ...previousEffect,
                    effectId,
                    semanticKey: `fixture-approved-marker:${command.projectId}:${previousEffect.taskId}:${toolInvocationId}`,
                    state: 'REQUESTED' as const,
                    reconciliationOutcome: null,
                    groundTruthDigest: null,
                    version: 1,
                  }),
                ];
                toolInvocationState = 'WAITING_FOR_APPROVAL';
                events.push(
                  {
                    kind: 'tool.requested',
                    actor: {
                      type: 'SPECIALIST',
                      id: record.organization.specialist.agentId,
                      lineageId: record.organization.specialist.lineageId,
                    },
                    aggregate: { type: 'TOOL_INVOCATION', id: toolInvocationId, version: 1 },
                    payload: {
                      activity: 'WRITE_APPROVED_MARKER',
                      status: 'WAITING_FOR_APPROVAL',
                      summary: 'Successor execution requested a fresh bounded fixture effect',
                      referenceId: toolInvocationId,
                      actionDigest: previousApproval.actionDigest,
                    },
                  },
                  {
                    kind: 'policy.decided',
                    actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                    aggregate: { type: 'TOOL_INVOCATION', id: toolInvocationId, version: 1 },
                    payload: {
                      decision: 'APPROVAL_REQUIRED',
                      reasonCode: 'SUCCESSOR_SENSITIVE_FIXTURE_EFFECT',
                      summary: 'Fresh successor authority still requires supervisor approval',
                    },
                  },
                );
                events.push({
                  kind: 'approval.requested',
                  actor: { type: 'SYSTEM', id: this.dependencies.systemId },
                  aggregate: { type: 'APPROVAL', id: approvalId, version: 1 },
                  payload: {
                    referenceType: 'APPROVAL',
                    referenceId: approvalId,
                    contentHash: previousApproval.actionDigest,
                    summary: 'Quiesced work resumed with a fresh approval request and authority',
                  },
                });
                audits.push(
                  {
                    actorType: 'SPECIALIST',
                    actorId: record.organization.specialist.agentId,
                    action: 'tool.requested',
                    targetType: 'TOOL_INVOCATION',
                    targetId: toolInvocationId,
                    reason: 'Successor bounded fixture tool intent',
                    outcome: 'WAITING_FOR_APPROVAL',
                  },
                  {
                    actorType: 'SYSTEM',
                    actorId: this.dependencies.systemId,
                    action: 'policy.decided',
                    targetType: 'TOOL_INVOCATION',
                    targetId: toolInvocationId,
                    reason: 'Fresh authority does not reuse an earlier approval',
                    outcome: 'APPROVAL_REQUIRED',
                  },
                  {
                    actorType: 'SYSTEM',
                    actorId: this.dependencies.systemId,
                    action: 'approval.requested',
                    targetType: 'APPROVAL',
                    targetId: approvalId,
                    reason: 'Quiesced work resumed under a fresh decision boundary',
                    outcome: 'REQUESTED',
                  },
                );
              }
            }
            const executionId = this.dependencies.nextId();
            supervision = {
              ...record.supervision,
              toolInvocationId,
              toolInvocationState,
              approvals: Object.freeze(approvals),
              effects: Object.freeze(effects),
              authority: Object.freeze({
                executionId,
                executionAttempt: record.supervision.authority.executionAttempt + 1,
                executionState: 'WAITING_FOR_APPROVAL',
                capabilityLeaseId: this.dependencies.nextId(),
                capabilityLeaseState: 'ACTIVE',
                capabilityLeaseExpiresAt: new Date(
                  Date.parse(authorityNow) + 300_000,
                ).toISOString(),
                runnerLeaseId: this.dependencies.nextId(),
                runnerLeaseState: 'ACTIVE',
                runnerLeaseExpiresAt: new Date(Date.parse(authorityNow) + 300_000).toISOString(),
                runnerLastHeartbeatAt: authorityNow,
                fencingToken: record.supervision.authority.fencingToken + 1,
                successor: true,
              }),
              verification: record.supervision.verification,
              recovery: Object.freeze({
                ...record.supervision.recovery,
                state: 'RESUMED' as const,
                sourceExecutionId:
                  record.supervision.checkpoint?.execution.executionId ??
                  record.supervision.authority.executionId,
                successorExecutionId: executionId,
                progress: 'Resumed from durable checkpoint with fresh fenced authority',
                updatedAt: authorityNow,
              }),
              blockedReasons: Object.freeze([]),
            };
            scheduling = Object.freeze({
              ...record.scheduling,
              execution: Object.freeze({
                ...record.scheduling.execution,
                executionId,
                state: 'WAITING_FOR_APPROVAL',
              }),
              runtime: Object.freeze({
                ...record.scheduling.runtime,
                executionId,
                status: 'WAITING_FOR_APPROVAL',
              }),
              queueReason: 'WAITING_FOR_APPROVAL',
            });
            capacity = Object.freeze({
              ...record.view.capacity,
              activeCognitiveRuns: Math.min(
                record.view.capacity.cognitiveRunLimit,
                record.view.capacity.activeCognitiveRuns + 1,
              ),
            });
          } else {
            const cancelled = command.command === 'CANCEL';
            const approvals = Object.freeze(
              record.supervision.approvals.map((approval) =>
                approval.state === 'REQUESTED'
                  ? Object.freeze({
                      ...approval,
                      state: 'CANCELLED' as const,
                      version: approval.version + 1,
                      usable: false,
                    })
                  : Object.freeze({ ...approval, usable: false }),
              ),
            );
            const effects = Object.freeze(
              record.supervision.effects.map((effect) =>
                effect.state === 'REQUESTED'
                  ? Object.freeze({
                      ...effect,
                      state: 'FAILED' as const,
                      reconciliationOutcome: `NOT_APPLIED:${command.command}`,
                      version: effect.version + 1,
                    })
                  : effect,
              ),
            );
            const checkpointId = this.dependencies.nextId();
            const checkpoint = checkpointFromProjectRecord({
              record,
              checkpointId,
              createdAt: authorityNow,
              reason: 'STOP',
            });
            supervision = {
              ...record.supervision,
              approvals,
              effects,
              toolInvocationState: 'CANCELLED',
              authority: Object.freeze({
                ...record.supervision.authority,
                executionState: requiresEffectReconciliation
                  ? 'STOPPING'
                  : executionAlreadyTerminal
                    ? fromExecution
                    : cancelled
                      ? 'CANCELLED'
                      : 'STOPPED',
                capabilityLeaseState: 'REVOKED',
                runnerLeaseState: 'REVOKED',
              }),
              checkpoint,
              recovery: Object.freeze({
                state: 'SAFE_CHECKPOINT' as const,
                sourceExecutionId: record.supervision.authority.executionId,
                successorExecutionId: null,
                sourceConnectionId: record.scheduling.execution.connectionId,
                targetConnectionId: null,
                progress: 'Safe checkpoint preserved after authority revocation',
                updatedAt: authorityNow,
              }),
              blockedReasons:
                cancelled && !requiresEffectReconciliation
                  ? Object.freeze(['Project cancelled'])
                  : Object.freeze([]),
            };
            scheduling = Object.freeze({
              ...record.scheduling,
              execution: Object.freeze({
                ...record.scheduling.execution,
                state: supervision.authority.executionState,
              }),
            });
            tasks =
              cancelled && !requiresEffectReconciliation
                ? updateTaskState(record, 'CANCELLED')
                : record.view.tasks;
            capacity = Object.freeze({
              ...record.view.capacity,
              activeCognitiveRuns: Math.max(0, record.view.capacity.activeCognitiveRuns - 1),
            });
            events.push({
              kind: 'checkpoint.created',
              actor: { type: 'SYSTEM', id: this.dependencies.systemId },
              aggregate: { type: 'CHECKPOINT', id: checkpointId, version: 1 },
              payload: {
                referenceType: 'CHECKPOINT',
                referenceId: checkpointId,
                contentHash: checkpoint.contentHash,
                summary: 'Safe fixture checkpoint recorded after authority revocation',
              },
            });
          }
          events.push(
            ...(command.command === 'RESUME'
              ? successorExecutionEvents(
                  supervision.authority.executionId,
                  this.dependencies.systemId,
                )
              : executionTransitionEvents({
                  record,
                  executionId: supervision.authority.executionId,
                  fromState: fromExecution,
                  toState: supervision.authority.executionState,
                  systemId: this.dependencies.systemId,
                  reasonCode: `${command.command}_AUTHORITY_TRANSITION`,
                  summary: `${command.command} established its distinct execution and lease semantics`,
                })),
          );
          const response = Object.freeze({
            commandId: this.dependencies.nextId(),
            projectId: command.projectId,
            status: 'ACCEPTED' as const,
            acceptedAt: authorityNow,
            correlationId: command.correlationId,
          });
          const changed = replaceRecord({
            record,
            status: requiresEffectReconciliation ? transitional : terminal,
            tasks,
            capacity,
            scheduling,
            verification: verificationRecord,
            supervision,
            events,
            audits,
            occurredAt: authorityNow,
            correlationId: command.correlationId,
            nextId: this.dependencies.nextId,
          });
          return { record: changed, response };
        },
      });
      if (
        ['PAUSE', 'STOP', 'CANCEL'].includes(command.command) &&
        result.record.view.status === controlStates(command.command)[0] &&
        result.record.supervision.effects.some(({ state }) =>
          ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state),
        )
      ) {
        await this.reconcileControlEffect(command);
      }
      return result.response;
    });
  }
}
