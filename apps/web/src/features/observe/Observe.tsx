import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getProject,
  type ProjectEvent,
  type ProjectView,
  replayEvents,
} from '../../services/project-api.js';

const label = (value: unknown) =>
  String(value ?? '')
    .replaceAll('_', ' ')
    .toLocaleLowerCase('en-US')
    .replace(/^./u, (character) => character.toLocaleUpperCase('en-US'));

export function Observe({ initial }: { initial: ProjectView }) {
  const [view, setView] = useState(initial);
  const [activity, setActivity] = useState<ProjectEvent[]>([]);
  const [connection, setConnection] = useState('Live');
  const stream = useRef<AbortController | null>(null);
  const projectId = view.projectId;
  const add = useCallback(
    (event: ProjectEvent) =>
      setActivity((old) => {
        const sequence = event.sequence;
        if (sequence) sessionStorage.setItem('moonshift:last-sequence', String(sequence));
        if (old.some((item) => item.eventId === event.eventId || item.sequence === sequence))
          return old;
        return [...old, event].sort((a, b) => a.sequence - b.sequence);
      }),
    [],
  );
  const reconnect = useCallback(async () => {
    stream.current?.abort();
    const controller = new AbortController();
    stream.current = controller;
    const stored = sessionStorage.getItem('moonshift:last-sequence');
    let cursor = stored === null ? 0 : Number(stored);
    let preserveReloadNotice = false;
    setConnection('Reconnecting');
    while (!controller.signal.aborted) {
      const result = await replayEvents(projectId, cursor, add, {
        signal: controller.signal,
        onOpen: () => {
          if (!preserveReloadNotice) setConnection('Live');
        },
      });
      if (result === 'expired') {
        const fresh = await getProject(projectId);
        setView(fresh);
        setActivity([]);
        cursor = fresh.lastSequence;
        sessionStorage.setItem('moonshift:last-sequence', String(cursor));
        preserveReloadNotice = true;
        setConnection('Reloaded after expired cursor');
        continue;
      }
      preserveReloadNotice = false;
      setConnection('Reconnecting');
      const replayCursor = sessionStorage.getItem('moonshift:last-sequence');
      cursor = replayCursor === null ? cursor : Number(replayCursor);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
  }, [add, projectId]);
  useEffect(() => {
    void reconnect().catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setConnection('Offline');
    });
    return () => stream.current?.abort();
  }, [reconnect]);
  const personas = useMemo(() => view.personas ?? [], [view]);
  const specialists = view.specialists ?? [];
  const specialistId = specialists[0]?.agentId;
  const presence = view.presences.find((item) => item.agentId === specialistId) ?? {};
  const task = view.tasks[0] ?? {};
  const channels = view.channels;
  const queueReason =
    task.state === 'WAITING_FOR_CAPACITY'
      ? view.capacity.activeCognitiveRuns >= view.capacity.cognitiveRunLimit
        ? 'Waiting for cognitive capacity'
        : 'Waiting for runner capacity'
      : task.state === 'WAITING_FOR_APPROVAL'
        ? 'Waiting for approval'
        : 'Ready to run';
  return (
    <main>
      <h1>Observe</h1>
      <p role="status">Project active · Connection: {connection}</p>
      <button
        onClick={() => void getProject(projectId).then((fresh: ProjectView) => setView(fresh))}
      >
        Reload durable view
      </button>{' '}
      <button
        onClick={() =>
          void reconnect().catch((error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError'))
              setConnection('Offline');
          })
        }
      >
        Reconnect activity
      </button>
      <section>
        <h2>Organization</h2>
        <div role="tree" aria-label="Organization">
          <div role="treeitem">Product</div>
          <div role="treeitem">
            Engineering
            <ul>
              {specialists.map((s: any) => (
                <li key={s.agentId ?? s.id}>Release-note specialist</li>
              ))}
            </ul>
          </div>
          <div role="treeitem">Quality</div>
          {personas
            .filter((p: any) => !['PRODUCT', 'ENGINEERING', 'QUALITY'].includes(p.role))
            .map((p: any) => (
              <div role="treeitem" key={p.id}>
                {p.name ?? p.role}
              </div>
            ))}
        </div>
      </section>
      <section>
        <h2>Channels</h2>
        <div role="tree" aria-label="Channels">
          {channels.map((c) => (
            <div role="treeitem" key={String(c.channelId)}>
              {String(c.name ?? c.kind ?? 'Implementation')}
            </div>
          ))}
        </div>
      </section>
      <section aria-label="Tasks and dependencies">
        <h2>Tasks and dependencies</h2>
        <p>{label(task.state ?? 'WAITING_FOR_APPROVAL')}</p>
        <p data-testid="queue-reason">{queueReason}</p>
      </section>
      <section>
        <h2>Presence</h2>
        <p data-testid="fixture-specialist-presence">
          {String(presence.state ?? 'WAITING_FOR_APPROVAL').replaceAll('_', ' ')} ·{' '}
          {String(presence.sourceType ?? 'TASK')}
        </p>
      </section>
      <section>
        <h2>Activity</h2>
        <ol role="log" aria-label="Project activity">
          {activity.map((item) => (
            <li key={item.eventId} data-sequence={item.sequence}>
              {item.payload.summary ?? item.kind}
            </li>
          ))}
          {activity.length === 0 && <li data-sequence="0">Waiting for activity</li>}
        </ol>
      </section>
    </main>
  );
}
