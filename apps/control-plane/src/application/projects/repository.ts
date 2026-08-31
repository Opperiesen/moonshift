import { createHash, randomUUID } from 'node:crypto';

import {
  planningValidators,
  type PresenceSourceType,
  type PresenceState,
} from '@moonshift/contracts';

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
  get(projectId: string): Promise<ProjectRecord | null>;
  listEvents(projectId: string, afterSequence: number): Promise<readonly ProjectEvent[]>;
  expireEventsBefore(projectId: string, sequence: number): Promise<void>;
  assertVersion(projectId: string, expectedVersion: number): Promise<void>;
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

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly idempotency = new Map<
    string,
    { readonly requestHash: string; readonly projectId: string }
  >();
  private readonly retainedFrom = new Map<string, number>();
  private creationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly authorityClock: () => Date = () => new Date()) {}

  async create(
    input: CreateProjectRecordInput,
  ): Promise<{ reused: boolean; record: ProjectRecord }> {
    const previous = this.creationQueue;
    let release = (): void => undefined;
    this.creationQueue = new Promise<void>((resolve) => {
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
    const records = [...this.projects.values()];
    const record = await input.build({
      activeSpecialists: records.reduce(
        (total, project) =>
          total + project.view.specialists.filter(({ status }) => status === 'ACTIVE').length,
        0,
      ),
      activeCognitiveRuns: records.filter(
        (project) => project.scheduling.execution.state === 'WAITING_FOR_APPROVAL',
      ).length,
      activeRunnerJobs: records.filter((project) => project.scheduling.runtime.status === 'RUNNING')
        .length,
      authorityNow: this.authorityClock().toISOString(),
    });
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
      occurredAt: new Date().toISOString(),
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
    this.retainedFrom.clear();
  }
}
