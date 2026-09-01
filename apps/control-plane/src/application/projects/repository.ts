import { createHash, randomUUID } from 'node:crypto';

import {
  planningValidators,
  type ExecutionState,
  type PresenceSourceType,
  type PresenceState,
} from '@moonshift/contracts';
import { transitionExecution } from '@moonshift/domain';

import {
  ControlPlaneError,
  EventCursorExpiredError,
  ProjectVersionConflictError,
} from '../../errors.js';
import type { ProjectEvent, ProjectRecord } from '../../model.js';

export interface CreateProjectRecordInput {
  readonly idempotencyKey: string;
  readonly requestHash: `sha256:${string}`;
  readonly build: (capacity: ProjectCapacitySnapshot) => Promise<ProjectRecord>;
}

export interface ProjectCapacitySnapshot {
  readonly activeSpecialists: number;
  readonly activeCognitiveRuns: number;
  readonly activeRunnerJobs: number;
  readonly authorityNow: string;
}

export interface ProjectRepository {
  create(input: CreateProjectRecordInput): Promise<{ reused: boolean; record: ProjectRecord }>;
  authorityNow(): Promise<string>;
  get(projectId: string): Promise<ProjectRecord | null>;
  list(): Promise<readonly ProjectRecord[]>;
  listEvents(projectId: string, afterSequence: number): Promise<readonly ProjectEvent[]>;
  expireEventsBefore(projectId: string, sequence: number): Promise<void>;
  assertVersion(projectId: string, expectedVersion: number): Promise<void>;
  recordRuntimeHeartbeat(input: RuntimeHeartbeatInput): Promise<RuntimeHeartbeatResult>;
  mutate<T>(input: MutateProjectRecordInput<T>): Promise<{
    readonly reused: boolean;
    readonly response: T;
    readonly record: ProjectRecord;
  }>;
}

export interface RuntimeHeartbeatInput {
  readonly projectId: string;
  readonly executionId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
}

export interface RuntimeHeartbeatResult {
  readonly accepted: boolean;
  readonly authorityNow: string;
  readonly leaseExpiresAt: string | null;
}

export interface MutateProjectRecordInput<T> {
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: `sha256:${string}`;
  readonly projectId: string;
  readonly reserveCognitiveCapacity?: boolean;
  readonly reserveRunnerCapacity?: boolean;
  readonly mutate: (
    record: ProjectRecord,
    authorityNow: string,
    capacity?: ProjectCapacitySnapshot,
  ) => Promise<{ readonly record: ProjectRecord; readonly response: T }>;
}

export function projectRequestHash(input: {
  readonly objective: string;
  readonly fixtureScenario: string;
}): `sha256:${string}` {
  const canonical = JSON.stringify({
    fixtureScenario: input.fixtureScenario,
    objective: input.objective,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function commandRequestHash(input: Readonly<Record<string, unknown>>): `sha256:${string}` {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))),
  );
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly idempotency = new Map<
    string,
    { readonly requestHash: string; readonly projectId: string }
  >();
  private readonly retainedFrom = new Map<string, number>();
  private readonly commandIdempotency = new Map<
    string,
    { readonly requestHash: string; readonly response: unknown }
  >();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly authorityClock: () => Date = () => new Date()) {}

  async authorityNow(): Promise<string> {
    return this.authorityClock().toISOString();
  }

  private capacitySnapshot(authorityNow: string): ProjectCapacitySnapshot {
    const records = [...this.projects.values()];
    return Object.freeze({
      activeSpecialists: records.reduce(
        (total, project) =>
          total + project.view.specialists.filter(({ status }) => status === 'ACTIVE').length,
        0,
      ),
      activeCognitiveRuns: records.filter((project) =>
        ['STARTING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CHECKPOINTING'].includes(
          project.supervision.authority.executionState,
        ),
      ).length,
      activeRunnerJobs: records.filter(
        (project) =>
          project.scheduling.runtime.status === 'RUNNING' ||
          project.supervision.effects.some(({ state }) =>
            ['EXECUTING', 'UNKNOWN', 'RECONCILING'].includes(state),
          ),
      ).length,
      authorityNow,
    });
  }

  async create(
    input: CreateProjectRecordInput,
  ): Promise<{ reused: boolean; record: ProjectRecord }> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.createExclusive(input);
    } finally {
      release();
    }
  }

  private async createExclusive(
    input: CreateProjectRecordInput,
  ): Promise<{ reused: boolean; record: ProjectRecord }> {
    const existing = this.idempotency.get(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestHash !== input.requestHash)
        throw new ControlPlaneError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key belongs to another request',
          409,
        );
      const record = this.projects.get(existing.projectId);
      if (record === undefined) throw new Error('Idempotency record has no project');
      return { reused: true, record };
    }
    const record = await input.build(this.capacitySnapshot(this.authorityClock().toISOString()));
    const projectId = record.view.projectId;
    if (this.projects.has(projectId)) throw new Error('Project identity already exists');
    this.projects.set(projectId, record);
    this.idempotency.set(input.idempotencyKey, {
      requestHash: input.requestHash,
      projectId,
    });
    this.retainedFrom.set(projectId, 1);
    return { reused: false, record };
  }

  async get(projectId: string): Promise<ProjectRecord | null> {
    return this.projects.get(projectId) ?? null;
  }

  async list(): Promise<readonly ProjectRecord[]> {
    return Object.freeze(
      [...this.projects.values()].sort((left, right) =>
        left.view.projectId.localeCompare(right.view.projectId),
      ),
    );
  }

  async listEvents(projectId: string, afterSequence: number): Promise<readonly ProjectEvent[]> {
    const record = this.projects.get(projectId);
    if (record === undefined) return [];
    const retainedFrom = this.retainedFrom.get(projectId) ?? 1;
    if (afterSequence < retainedFrom - 1) throw new EventCursorExpiredError(retainedFrom);
    return record.events.filter(({ sequence }) => sequence > afterSequence);
  }

  async expireEventsBefore(projectId: string, sequence: number): Promise<void> {
    const record = this.projects.get(projectId);
    if (record === undefined) throw new Error('Project not found');
    this.retainedFrom.set(
      projectId,
      Math.max(
        this.retainedFrom.get(projectId) ?? 1,
        Math.min(sequence, record.view.lastSequence + 1),
      ),
    );
  }

  async assertVersion(projectId: string, expectedVersion: number): Promise<void> {
    const current = this.projects.get(projectId)?.view.version;
    if (current === undefined)
      throw new ControlPlaneError('PROJECT_NOT_FOUND', 'Project not found', 404);
    if (current !== expectedVersion)
      throw new ProjectVersionConflictError(expectedVersion, current);
  }

  async recordRuntimeHeartbeat(input: RuntimeHeartbeatInput): Promise<RuntimeHeartbeatResult> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const now = this.authorityClock();
      const authorityNow = now.toISOString();
      const record = this.projects.get(input.projectId);
      const authority = record?.supervision.authority;
      const accepted =
        record !== undefined &&
        record.view.status === 'ACTIVE' &&
        authority?.executionId === input.executionId &&
        authority.runnerLeaseId === input.leaseId &&
        authority.runnerLeaseState === 'ACTIVE' &&
        authority.fencingToken === input.fencingToken &&
        record.scheduling.runtime.connectionId === input.ownerId &&
        Date.parse(authority.runnerLeaseExpiresAt) > now.getTime();
      if (!accepted || record === undefined || authority === undefined)
        return Object.freeze({ accepted: false, authorityNow, leaseExpiresAt: null });
      const leaseExpiresAt = new Date(now.getTime() + 300_000).toISOString();
      this.projects.set(
        input.projectId,
        Object.freeze({
          ...record,
          supervision: Object.freeze({
            ...record.supervision,
            authority: Object.freeze({
              ...authority,
              runnerLastHeartbeatAt: authorityNow,
              runnerLeaseExpiresAt: leaseExpiresAt,
            }),
          }),
        }),
      );
      return Object.freeze({ accepted: true, authorityNow, leaseExpiresAt });
    } finally {
      release();
    }
  }

  async mutate<T>(input: MutateProjectRecordInput<T>): Promise<{
    readonly reused: boolean;
    readonly response: T;
    readonly record: ProjectRecord;
  }> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const key = `${input.scope}:${input.idempotencyKey}`;
      const prior = this.commandIdempotency.get(key);
      const current = this.projects.get(input.projectId);
      if (current === undefined)
        throw new ControlPlaneError('PROJECT_NOT_FOUND', 'Project not found', 404);
      if (prior !== undefined) {
        if (prior.requestHash !== input.requestHash)
          throw new ControlPlaneError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key belongs to another request',
            409,
          );
        return { reused: true, response: prior.response as T, record: current };
      }
      const authorityNow = this.authorityClock().toISOString();
      const changed = await input.mutate(
        current,
        authorityNow,
        input.reserveCognitiveCapacity || input.reserveRunnerCapacity
          ? this.capacitySnapshot(authorityNow)
          : undefined,
      );
      if (
        changed.record.view.projectId !== input.projectId ||
        changed.record.view.version !== current.view.version + 1 ||
        changed.record.view.lastSequence < current.view.lastSequence
      ) {
        throw new Error('Project mutation did not preserve identity and monotonic versions');
      }
      this.projects.set(input.projectId, changed.record);
      this.commandIdempotency.set(key, {
        requestHash: input.requestHash,
        response: changed.response,
      });
      return { reused: false, response: changed.response, record: changed.record };
    } finally {
      release();
    }
  }

  expireBefore(projectId: string, sequence: number): void {
    const record = this.projects.get(projectId);
    if (record === undefined) throw new Error('Project not found');
    this.retainedFrom.set(
      projectId,
      Math.max(
        this.retainedFrom.get(projectId) ?? 1,
        Math.min(sequence, record.view.lastSequence + 1),
      ),
    );
  }

  setFixturePresence(
    projectId: string,
    state: PresenceState,
    sourceType: PresenceSourceType,
  ): void {
    const record = this.projects.get(projectId);
    if (record === undefined) throw new Error('Project not found');
    const specialistId = record.view.specialists[0]?.agentId;
    if (specialistId === undefined) throw new Error('Fixture specialist not found');
    const presences = record.view.presences.map((presence) =>
      presence.agentId === specialistId
        ? Object.freeze({
            ...presence,
            state,
            sourceType,
            activity: `Fixture ${state.toLocaleLowerCase('en-US').replaceAll('_', ' ')}`,
          })
        : presence,
    );
    this.projects.set(
      projectId,
      Object.freeze({
        ...record,
        view: Object.freeze({ ...record.view, presences: Object.freeze(presences) }),
      }),
    );
  }

  setFixtureExecutionState(projectId: string, state: ExecutionState): void {
    const record = this.projects.get(projectId);
    if (record === undefined) throw new Error('Project not found');
    const paths: Record<ExecutionState, readonly ExecutionState[]> = {
      QUEUED: [],
      STARTING: ['STARTING'],
      RUNNING: ['STARTING', 'RUNNING'],
      WAITING_FOR_APPROVAL: ['STARTING', 'RUNNING', 'WAITING_FOR_APPROVAL'],
      CHECKPOINTING: ['STARTING', 'RUNNING', 'CHECKPOINTING'],
      SUSPENDED: ['SUSPENDED'],
      STOPPING: ['STOPPING'],
      STOPPED: ['STOPPING', 'STOPPED'],
      SUCCEEDED: ['STARTING', 'RUNNING', 'SUCCEEDED'],
      FAILED: ['STARTING', 'FAILED'],
      CANCELLED: ['CANCELLED'],
      LOST: ['STARTING', 'LOST'],
      RECONCILING: ['STARTING', 'LOST', 'RECONCILING'],
    };
    const executionId = randomUUID();
    const actorId = randomUUID();
    const correlationId = record.events[0]?.correlationId ?? randomUUID();
    const occurredAt = this.authorityClock().toISOString();
    const events: ProjectEvent[] = [];
    let execution: { readonly state: ExecutionState; readonly version: number } = {
      state: 'QUEUED',
      version: 1,
    };
    events.push(
      Object.freeze({
        schemaVersion: '1.0',
        eventId: randomUUID(),
        projectId,
        sequence: record.view.lastSequence + 1,
        kind: 'execution.state_changed',
        occurredAt,
        actor: Object.freeze({ type: 'SYSTEM', id: actorId }),
        aggregate: Object.freeze({ type: 'EXECUTION', id: executionId, version: 1 }),
        correlationId,
        classification: 'PUBLIC_FIXTURE',
        payload: Object.freeze({
          fromState: null,
          toState: 'QUEUED',
          reasonCode: 'FIXTURE_EXECUTION_CREATED',
          summary: 'Synthetic contract execution entered its initial queued state',
        }),
      }),
    );
    for (const nextState of paths[state]) {
      const previousState = execution.state;
      execution = transitionExecution(
        execution,
        nextState,
        nextState === 'RECONCILING'
          ? { type: 'RECOVERY_COORDINATOR', id: actorId }
          : { type: 'SYSTEM', id: actorId },
        execution.version,
      );
      events.push(
        Object.freeze({
          schemaVersion: '1.0',
          eventId: randomUUID(),
          projectId,
          sequence: record.view.lastSequence + events.length + 1,
          kind: 'execution.state_changed',
          occurredAt,
          actor: Object.freeze({ type: 'SYSTEM', id: actorId }),
          aggregate: Object.freeze({
            type: 'EXECUTION',
            id: executionId,
            version: execution.version,
          }),
          correlationId,
          classification: 'PUBLIC_FIXTURE',
          payload: Object.freeze({
            fromState: previousState,
            toState: execution.state,
            reasonCode: 'FIXTURE_EXECUTION_TRANSITION',
            summary: `Synthetic contract execution transitioned to ${execution.state}`,
          }),
        }),
      );
    }
    for (const event of events) planningValidators().eventEnvelope.assert(event);
    const lastSequence = events.at(-1)?.sequence ?? record.view.lastSequence;
    this.projects.set(
      projectId,
      Object.freeze({
        ...record,
        view: Object.freeze({ ...record.view, lastSequence }),
        scheduling: Object.freeze({
          ...record.scheduling,
          execution: Object.freeze({
            ...record.scheduling.execution,
            executionId,
            state: execution.state,
          }),
          runtime: Object.freeze({ ...record.scheduling.runtime, executionId }),
        }),
        supervision: Object.freeze({
          ...record.supervision,
          authority: Object.freeze({
            ...record.supervision.authority,
            executionId,
            executionAttempt: record.supervision.authority.executionAttempt + 1,
            executionState: execution.state,
          }),
        }),
        events: Object.freeze([...record.events, ...events]),
      }),
    );
  }

  setFixtureEffectState(
    projectId: string,
    state: ProjectRecord['supervision']['effects'][number]['state'],
  ): void {
    const record = this.projects.get(projectId);
    if (record === undefined) throw new Error('Project not found');
    const effect = record.supervision.effects[0];
    if (effect === undefined) throw new Error('Fixture effect not found');
    this.projects.set(
      projectId,
      Object.freeze({
        ...record,
        supervision: Object.freeze({
          ...record.supervision,
          effects: Object.freeze([
            Object.freeze({
              ...effect,
              state,
              reconciliationOutcome:
                state === 'UNKNOWN' ? 'RECONCILIATION_REQUIRED' : effect.reconciliationOutcome,
              version: effect.version + 1,
            }),
            ...record.supervision.effects.slice(1),
          ]),
        }),
      }),
    );
  }

  appendFixtureNotice(projectId: string, summary: string): void {
    const record = this.projects.get(projectId);
    if (record === undefined) throw new Error('Project not found');
    const sequence = record.view.lastSequence + 1;
    const event: ProjectEvent = Object.freeze({
      schemaVersion: '1.0',
      eventId: randomUUID(),
      projectId,
      sequence,
      kind: 'audit.notice',
      occurredAt: this.authorityClock().toISOString(),
      actor: Object.freeze({ type: 'SYSTEM', id: randomUUID() }),
      aggregate: Object.freeze({ type: 'PROJECT', id: projectId, version: record.view.version }),
      correlationId: record.events[0]?.correlationId ?? randomUUID(),
      classification: 'PUBLIC_FIXTURE',
      payload: Object.freeze({ code: 'FIXTURE_LIVE_UPDATE', severity: 'INFO', summary }),
    });
    planningValidators().eventEnvelope.assert(event);
    this.projects.set(
      projectId,
      Object.freeze({
        ...record,
        view: Object.freeze({ ...record.view, lastSequence: sequence }),
        events: Object.freeze([...record.events, event]),
      }),
    );
  }

  size(): number {
    return this.projects.size;
  }

  ids(): readonly string[] {
    return [...this.projects.keys()];
  }

  clear(): void {
    this.projects.clear();
    this.idempotency.clear();
    this.commandIdempotency.clear();
    this.retainedFrom.clear();
  }
}
