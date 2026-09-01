import {
  followProjectEvents,
  mergeProjectEvent,
  ProjectEventProjectionError,
} from '../../apps/web/src/services/project-events.js';
import type {
  ProjectEvent,
  ProjectView,
  ResultView,
} from '../../apps/web/src/services/project-api.js';
import { describe, expect, it } from 'vitest';

const projectId = '78000000-0000-4000-8000-000000000001';

function event(eventId: string, sequence: number): ProjectEvent {
  return Object.freeze({
    eventId,
    sequence,
    kind: 'audit.notice',
    payload: { summary: 'fixture' },
  });
}

function auditEvent(sequence: number): ResultView['audit'][number] {
  return Object.freeze({
    auditEventId: `79000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    projectEventId: `79100000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    supervisionSequence: null,
    projectId,
    taskId: '79000000-0000-4000-8000-000000000100',
    sequence,
    actorType: 'SYSTEM',
    actorId: '79000000-0000-4000-8000-000000000101',
    action: 'audit.notice',
    targetType: 'PROJECT',
    targetId: projectId,
    occurredAt: '2026-09-01T08:00:00.000Z',
    reason: `Durable event ${sequence}`,
    outcome: 'RECORDED',
    correlationId: '79000000-0000-4000-8000-000000000102',
  });
}

const audit = Object.freeze([1, 2, 3, 4].map(auditEvent));

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

const view = Object.freeze({
  projectId,
  objective: 'Rebuild the durable projection',
  status: 'ACTIVE',
  version: 2,
  lastSequence: 4,
  personas: Object.freeze([]),
  specialists: Object.freeze([]),
  presences: Object.freeze([]),
  channels: Object.freeze([]),
  tasks: Object.freeze([]),
  capacity: Object.freeze({
    activeCognitiveRuns: 0,
    cognitiveRunLimit: 3,
    activeRunnerJobs: 0,
    runnerJobLimit: 1,
  }),
}) satisfies ProjectView;

describe('browser project event projection', () => {
  it('deduplicates exact delivery and rejects identity or sequence collisions', () => {
    const first = event('78000000-0000-4000-8000-000000000002', 1);
    const merged = mergeProjectEvent([], first);
    expect(mergeProjectEvent(merged, first)).toBe(merged);
    expect(() =>
      mergeProjectEvent(merged, event('78000000-0000-4000-8000-000000000003', 1)),
    ).toThrow(ProjectEventProjectionError);
    expect(() =>
      mergeProjectEvent(merged, event('78000000-0000-4000-8000-000000000002', 2)),
    ).toThrow(ProjectEventProjectionError);
  });

  it('reloads durable presence after cursor expiry and resumes at the projection high-water mark', async () => {
    const cursorStorage = storage();
    const controller = new AbortController();
    const connections: string[] = [];
    const projections: ProjectView[] = [];
    const visibleEvents: readonly ProjectEvent[][] = [];
    let calls = 0;
    await followProjectEvents({
      projectId,
      signal: controller.signal,
      storage: cursorStorage,
      loadProject: async () => view,
      loadAudit: async () => audit,
      replay: async (_projectId, cursor, onEvent, options) => {
        calls += 1;
        if (calls === 1) return 'expired';
        expect(cursor).toBe(view.lastSequence);
        options.onOpen?.();
        onEvent(event('78000000-0000-4000-8000-000000000004', 5));
        controller.abort();
        return 'closed';
      },
      retryDelay: async () => undefined,
      onProject: (project) => projections.push(project),
      onEvents: (events) => visibleEvents.push(events),
      onConnection: (connection) => connections.push(connection),
    });
    expect(projections).toEqual([view]);
    expect(visibleEvents.at(-1)?.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(connections).toContain('Reloaded after expired cursor');
    expect(cursorStorage.values.get(`moonshift:last-sequence:${projectId}`)).toBe('5');
  });

  it('reloads instead of accepting a gap in the ordered event stream', async () => {
    const cursorStorage = storage();
    const controller = new AbortController();
    const connections: string[] = [];
    let loads = 0;
    await followProjectEvents({
      projectId,
      signal: controller.signal,
      storage: cursorStorage,
      replay: async (_projectId, _cursor, onEvent) => {
        onEvent(event('78000000-0000-4000-8000-000000000005', 2));
        return 'closed';
      },
      loadProject: async () => {
        loads += 1;
        controller.abort();
        return view;
      },
      loadAudit: async () => audit,
      retryDelay: async () => undefined,
      onProject: () => undefined,
      onEvents: () => undefined,
      onConnection: (connection) => connections.push(connection),
    });
    expect(loads).toBe(1);
    expect(connections).toContain('Reloaded after event conflict');
  });

  it('hydrates complete durable activity before replaying after a browser reload', async () => {
    const cursorStorage = storage();
    cursorStorage.setItem(`moonshift:last-sequence:${projectId}`, '4');
    const controller = new AbortController();
    const visibleEvents: readonly ProjectEvent[][] = [];
    await followProjectEvents({
      projectId,
      signal: controller.signal,
      storage: cursorStorage,
      loadProject: async () => view,
      loadAudit: async () => audit,
      replay: async (_projectId, cursor, onEvent, options) => {
        expect(cursor).toBe(4);
        options.onOpen?.();
        onEvent(event('78000000-0000-4000-8000-000000000006', 5));
        controller.abort();
        return 'closed';
      },
      retryDelay: async () => undefined,
      onProject: () => undefined,
      onEvents: (events) => visibleEvents.push(events),
      onConnection: () => undefined,
    });
    expect(visibleEvents.map((items) => items.map(({ sequence }) => sequence))).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4, 5],
    ]);
    expect(new Set(visibleEvents.at(-1)?.map(({ eventId }) => eventId)).size).toBe(5);
  });
});
