import {
  getProject,
  getResults,
  type ProjectEvent,
  type ProjectView,
  type ResultView,
  replayEvents,
} from './project-api.js';

export type ProjectEventConnectionState =
  'Live' | 'Reconnecting' | 'Reloaded after expired cursor' | 'Reloaded after event conflict';

export class ProjectEventProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectEventProjectionError';
  }
}

export function mergeProjectEvent(
  current: readonly ProjectEvent[],
  incoming: ProjectEvent,
): readonly ProjectEvent[] {
  const sameId = current.find((event) => event.eventId === incoming.eventId);
  const sameSequence = current.find((event) => event.sequence === incoming.sequence);
  if (sameId !== undefined || sameSequence !== undefined) {
    if (sameId?.sequence === incoming.sequence && sameSequence?.eventId === incoming.eventId) {
      return current;
    }
    throw new ProjectEventProjectionError('Conflicting event identity or sequence');
  }
  return Object.freeze(
    [...current, incoming].sort((left, right) => left.sequence - right.sequence),
  );
}

function cursorKey(projectId: string): string {
  return `moonshift:last-sequence:${projectId}`;
}

function readCursor(storage: Pick<Storage, 'getItem'>, projectId: string): number {
  const stored = storage.getItem(cursorKey(projectId));
  if (stored === null || !/^[0-9]+$/u.test(stored)) return 0;
  const cursor = Number(stored);
  return Number.isSafeInteger(cursor) ? cursor : 0;
}

function writeCursor(storage: Pick<Storage, 'setItem'>, projectId: string, cursor: number): void {
  storage.setItem(cursorKey(projectId), String(cursor));
}

function projectEventsFromAudit(audit: ResultView['audit']): readonly ProjectEvent[] {
  let events: readonly ProjectEvent[] = Object.freeze([]);
  for (const item of [...audit].sort((left, right) => left.sequence - right.sequence)) {
    if (item.sequence !== events.length + 1) {
      throw new ProjectEventProjectionError(
        `Durable audit is missing event sequence ${events.length + 1}`,
      );
    }
    events = mergeProjectEvent(
      events,
      Object.freeze({
        eventId: item.projectEventId,
        sequence: item.sequence,
        kind: item.action,
        payload: Object.freeze({ summary: item.reason }),
      }),
    );
  }
  return events;
}

export async function followProjectEvents(input: {
  readonly projectId: string;
  readonly signal: AbortSignal;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly onProject: (view: ProjectView) => void;
  readonly onEvents: (events: readonly ProjectEvent[]) => void;
  readonly onConnection: (state: ProjectEventConnectionState) => void;
  readonly loadProject?: typeof getProject;
  readonly loadAudit?: (projectId: string) => Promise<ResultView['audit']>;
  readonly replay?: typeof replayEvents;
  readonly retryDelay?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const storage = input.storage ?? globalThis.sessionStorage;
  const loadProject = input.loadProject ?? getProject;
  const loadAudit = input.loadAudit ?? (async (projectId) => (await getResults(projectId)).audit);
  const replay = input.replay ?? replayEvents;
  const retryDelay =
    input.retryDelay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  let cursor = readCursor(storage, input.projectId);
  let events: readonly ProjectEvent[] = Object.freeze([]);
  let preserveReloadNotice = false;
  input.onConnection('Reconnecting');

  const hydrate = async (preserveReplayCursor = false): Promise<void> => {
    const replayCursor = cursor;
    const audit = await loadAudit(input.projectId);
    const fresh = await loadProject(input.projectId);
    input.onProject(fresh);
    events = projectEventsFromAudit(audit);
    input.onEvents(events);
    const durableCursor = events.at(-1)?.sequence ?? 0;
    cursor = preserveReplayCursor && replayCursor <= durableCursor ? replayCursor : durableCursor;
    writeCursor(storage, input.projectId, cursor);
  };

  const reload = async (state: ProjectEventConnectionState): Promise<void> => {
    await hydrate();
    preserveReloadNotice = true;
    input.onConnection(state);
  };

  if (cursor > 0) await hydrate(true);

  while (!input.signal.aborted) {
    let replayResult: Awaited<ReturnType<typeof replayEvents>>;
    try {
      replayResult = await replay(
        input.projectId,
        cursor,
        (event) => {
          if (event.sequence <= cursor) return;
          if (event.sequence !== cursor + 1) {
            throw new ProjectEventProjectionError(
              `Expected event sequence ${cursor + 1}, received ${event.sequence}`,
            );
          }
          events = mergeProjectEvent(events, event);
          cursor = event.sequence;
          writeCursor(storage, input.projectId, cursor);
          input.onEvents(events);
        },
        {
          signal: input.signal,
          onOpen: () => {
            if (!preserveReloadNotice) input.onConnection('Live');
          },
        },
      );
    } catch (error) {
      if (!(error instanceof ProjectEventProjectionError)) throw error;
      await reload('Reloaded after event conflict');
      continue;
    }
    if (replayResult === 'expired') {
      await reload('Reloaded after expired cursor');
      continue;
    }
    preserveReloadNotice = false;
    input.onConnection('Reconnecting');
    await retryDelay(100);
  }
}
