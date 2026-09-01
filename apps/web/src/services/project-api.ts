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
  readonly version: number;
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

export interface ApprovalView {
  readonly approvalId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly requesterAgentId: string;
  readonly state: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  readonly actionDigest: `sha256:${string}`;
  readonly scope: string;
  readonly reason: string;
  readonly riskSummary: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decisionActorId: string | null;
  readonly version: number;
}

export interface SupervisionView {
  readonly items: readonly ApprovalView[];
  readonly budget: {
    readonly invocationLimit: number;
    readonly consumedInvocations: number;
    readonly monetaryLimitMicros: number;
    readonly consumedMonetaryMicros: number;
  };
  readonly authority: {
    readonly executionState: string;
    readonly capabilityLeaseState: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    readonly runnerLeaseState: 'ACTIVE' | 'REVOKED';
    readonly successor: boolean;
  };
  readonly checkpoint: {
    readonly checkpointId: string;
    readonly contentHash: `sha256:${string}`;
    readonly createdAt: string;
  } | null;
  readonly recovery: {
    readonly state: string;
    readonly sourceExecutionId: string | null;
    readonly successorExecutionId: string | null;
    readonly sourceConnectionId: string | null;
    readonly targetConnectionId: string | null;
    readonly progress: string;
    readonly updatedAt: string;
  };
  readonly effects: readonly {
    readonly effectId: string;
    readonly taskId: string;
    readonly actionDigest: `sha256:${string}`;
    readonly semanticKey: string;
    readonly state:
      'REQUESTED' | 'EXECUTING' | 'APPLIED' | 'FAILED' | 'UNKNOWN' | 'RECONCILING' | 'RECONCILED';
    readonly reconciliationOutcome: string | null;
    readonly groundTruthDigest: `sha256:${string}` | null;
    readonly version: number;
  }[];
  readonly blockedReasons: readonly string[];
  readonly projectState: string;
  readonly projectVersion: number;
}

export interface ResultArtifactView {
  readonly artifactId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly size: number;
  readonly contentHash: `sha256:${string}`;
  readonly gitRevision: string;
}

export interface ResultEvidenceView {
  readonly evidenceId: string;
  readonly producerAgentId: string;
  readonly type:
    'BUILD' | 'TEST' | 'INTEGRITY' | 'COVERAGE' | 'REVIEW' | 'APPROVAL' | 'RECONCILIATION';
  readonly status: 'PASS' | 'FAIL' | 'MISSING' | 'STALE' | 'BLOCKING';
  readonly observedAt: string;
  readonly gitRevision: string;
  readonly sourceHash: `sha256:${string}`;
}

export interface ResultView {
  readonly projectId: string;
  readonly projectState: string;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly state: string;
    readonly assigneeAgentId: string | null;
    readonly expectedRevision: string;
  };
  readonly artifacts: readonly ResultArtifactView[];
  readonly evidence: readonly ResultEvidenceView[];
  readonly approvals: readonly ApprovalView[];
  readonly executions: readonly {
    readonly executionId: string;
    readonly agentId: string;
    readonly runtimeId: string;
    readonly backendConnectionId: string;
    readonly modelDescriptorId: string;
    readonly modelDescriptorVersion: number;
    readonly state: string;
    readonly attemptNumber: number;
    readonly startedAt: string;
    readonly endedAt: string | null;
  }[];
  readonly checkpoints: readonly {
    readonly checkpointId: string;
    readonly executionId: string;
    readonly schemaVersion: string;
    readonly contentHash: `sha256:${string}`;
    readonly gitRevision: string;
    readonly createdAt: string;
  }[];
  readonly effects: SupervisionView['effects'];
  readonly organizationLineage: {
    readonly authorAgentId: string;
    readonly authorLineageId: string;
    readonly reviewerAgentId: string | null;
    readonly reviewerLineageId: string | null;
    readonly independentReview: boolean;
  };
  readonly audit: readonly {
    readonly auditEventId: string;
    readonly sequence: number;
    readonly actorType: string;
    readonly actorId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly occurredAt: string;
    readonly reason: string;
    readonly outcome: string;
    readonly correlationId: string;
  }[];
  readonly verified: boolean;
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

async function responseBody(response: Response, fallback: string): Promise<unknown> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = body as {
      readonly detail?: string;
      readonly title?: string;
      readonly code?: string;
    };
    throw new Error(problem.detail ?? problem.title ?? problem.code ?? fallback);
  }
  return body;
}

export async function listApprovals(projectId: string): Promise<SupervisionView> {
  const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/approvals`, {
    credentials: 'include',
  });
  return (await responseBody(response, 'Unable to load supervision.')) as SupervisionView;
}

export async function getResults(projectId: string): Promise<ResultView> {
  const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/results`, {
    credentials: 'include',
  });
  return (await responseBody(response, 'Unable to load project results.')) as ResultView;
}

export async function getApproval(
  projectId: string,
  approvalId: string,
): Promise<{ readonly approval: ApprovalView; readonly etag: string }> {
  const response = await fetch(
    `/v1/projects/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(approvalId)}`,
    { credentials: 'include' },
  );
  const approval = (await responseBody(response, 'Unable to load the approval.')) as ApprovalView;
  const etag = response.headers.get('etag');
  if (etag === null) throw new Error('The approval response did not include a version validator.');
  return { approval, etag };
}

export async function decideApproval(input: {
  readonly projectId: string;
  readonly approvalId: string;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly actionDigest: `sha256:${string}`;
  readonly reason: string;
}): Promise<ApprovalView> {
  const current = await getApproval(input.projectId, input.approvalId);
  if (current.approval.actionDigest !== input.actionDigest)
    throw new Error('The displayed action changed before the decision could be submitted.');
  const response = await fetch(
    `/v1/projects/${encodeURIComponent(input.projectId)}/approvals/${encodeURIComponent(input.approvalId)}/decision`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': id(),
        'x-correlation-id': id(),
        'if-match': current.etag,
      },
      body: JSON.stringify({
        decision: input.decision,
        actionDigest: input.actionDigest,
        reason: input.reason,
      }),
    },
  );
  return (await responseBody(response, 'Unable to record the approval decision.')) as ApprovalView;
}

export async function controlProject(input: {
  readonly projectId: string;
  readonly command: 'pause' | 'resume' | 'stop' | 'cancel';
  readonly reason: string;
  readonly projectVersion: number;
}): Promise<void> {
  const response = await fetch(
    `/v1/projects/${encodeURIComponent(input.projectId)}/commands/${input.command}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': id(),
        'x-correlation-id': id(),
        'if-match': `"${input.projectVersion}"`,
      },
      body: JSON.stringify({ reason: input.reason }),
    },
  );
  await responseBody(response, `Unable to ${input.command} the project.`);
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
