export interface ProjectEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: { readonly summary?: string };
}

export interface ProjectView {
  readonly projectId: string;
  readonly objective: string;
  readonly status: string;
  readonly lastSequence: number;
  readonly personas: readonly Record<string, unknown>[];
  readonly specialists: readonly Record<string, unknown>[];
  readonly presences: readonly Record<string, unknown>[];
  readonly channels: readonly Record<string, unknown>[];
  readonly tasks: readonly Record<string, unknown>[];
  readonly capacity: {
    readonly activeCognitiveRuns: number;
    readonly cognitiveRunLimit: number;
    readonly activeRunnerJobs: number;
    readonly runnerJobLimit: number;
  };
}

export async function bootstrap(secret: string): Promise<void> {
  const response = await fetch('/v1/session/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrapSecret: secret }),
  });
  if (!response.ok) throw new Error('Unable to establish the supervisor session.');
}

function id(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export async function createProject(objective: string): Promise<ProjectView> {
  const response = await fetch('/v1/projects', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': id(),
      'x-correlation-id': id(),
    },
    body: JSON.stringify({ objective, fixtureScenario: 'PASS' }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body.detail ?? body.message ?? body.title ?? body.code ?? 'Project creation failed.',
    );
  return body as ProjectView;
}

export async function getProject(projectId: string): Promise<ProjectView> {
  const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error('Unable to load the durable project view.');
  return response.json() as Promise<ProjectView>;
}

export async function replayEvents(
  projectId: string,
  sequence: number,
  onEvent: (event: ProjectEvent) => void,
  options: {
    readonly signal?: AbortSignal;
    readonly onOpen?: () => void;
  } = {},
): Promise<'closed' | 'expired'> {
  const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/events`, {
    credentials: 'include',
    headers: { accept: 'text/event-stream', 'last-event-id': String(sequence) },
    signal: options.signal ?? null,
  });
  if (response.status === 409) {
    const problem = await response.json().catch(() => ({}));
    if (problem.code === 'EVENT_CURSOR_EXPIRED') return 'expired';
  }
  if (!response.ok || !response.body) throw new Error('Activity connection failed.');
  options.onOpen?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data) {
        try {
          const decoded = JSON.parse(data) as ProjectEvent | { readonly code?: string };
          if ('code' in decoded && decoded.code === 'EVENT_CURSOR_EXPIRED') return 'expired';
          onEvent(decoded as ProjectEvent);
        } catch {
          /* malformed events are ignored */
        }
      }
    }
  }
  return 'closed';
}
