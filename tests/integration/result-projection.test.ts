import {
  createFixtureControlPlane,
  projectResults,
  type ResultView,
} from '../../apps/control-plane/src/index.js';
import { EXECUTION_STATES, type ExecutionState } from '../../packages/contracts/src/index.js';
import { describe, expect, it } from 'vitest';

const bootstrapSecret = 't'.repeat(48);
const origin = 'http://127.0.0.1:4173';
const supervisorId = '73000000-0000-4000-8000-000000000001';

async function fixture(scenario: 'PASS' | 'EVIDENCE_FAIL' = 'PASS') {
  const controlPlane = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  const created = await controlPlane.service.submitObjective({
    actorId: supervisorId,
    idempotencyKey: 'result-projection-project-create',
    correlationId: '73000000-0000-4000-8000-000000000002',
    objective: 'Inspect a complete deterministic result and audit trail',
    fixtureScenario: scenario,
  });
  return { controlPlane, projectId: created.view.projectId };
}

async function approveAndRun(
  controlPlane: ReturnType<typeof createFixtureControlPlane>,
  projectId: string,
): Promise<void> {
  const approval = (await controlPlane.supervision.getProjection(projectId)).approvals[0];
  if (approval === undefined) throw new Error('Expected fixture approval');
  await controlPlane.supervision.decideApproval({
    actorId: supervisorId,
    projectId,
    approvalId: approval.approvalId,
    decision: 'APPROVE',
    actionDigest: approval.actionDigest,
    reason: 'Approve the deterministic fixture effect',
    expectedVersion: approval.version,
    idempotencyKey: 'result-projection-approval',
    correlationId: '73000000-0000-4000-8000-000000000003',
  });
  await controlPlane.verification.runConfiguredFixture(
    projectId,
    '73000000-0000-4000-8000-000000000004',
  );
}

describe('result projection integration', () => {
  it('retains stable links for every result record and independent route provenance', async () => {
    const { controlPlane, projectId } = await fixture();
    await approveAndRun(controlPlane, projectId);
    const record = await controlPlane.repository.get(projectId);
    if (record === null) throw new Error('Expected durable project record');
    const result = projectResults(record) as ResultView;
    const taskId = result.task.taskId;
    const execution = result.executions[0];
    if (execution === undefined) throw new Error('Expected result execution');

    expect(result.projectId).toBe(projectId);
    expect(result.artifacts).not.toHaveLength(0);
    expect(result.evidence).not.toHaveLength(0);
    expect(result.approvals).not.toHaveLength(0);
    expect(result.effects).not.toHaveLength(0);
    expect(result.audit).not.toHaveLength(0);

    for (const artifact of result.artifacts) {
      expect(artifact).toMatchObject({ projectId, taskId, executionId: execution.executionId });
    }
    for (const evidence of result.evidence) {
      expect(evidence).toHaveProperty('projectId', projectId);
      expect(evidence).toHaveProperty('taskId', taskId);
      const artifact = result.artifacts.find(
        ({ artifactId }) => artifactId === evidence.artifactId,
      );
      expect(evidence.executionId).toBe(artifact?.executionId ?? null);
    }
    for (const approval of result.approvals) expect(approval.taskId).toBe(taskId);
    for (const executionView of result.executions) {
      expect(executionView).toMatchObject({
        backendConnectionId: expect.any(String),
        modelDescriptorId: expect.any(String),
        modelDescriptorVersion: expect.any(Number),
      });
      expect(executionView).toHaveProperty('routeDecisionId');
    }
    for (const checkpoint of result.checkpoints)
      expect(checkpoint.executionId).toBe(execution.executionId);
    for (const effect of result.effects) expect(effect.taskId).toBe(taskId);
    for (const audit of result.audit) {
      expect(audit).toHaveProperty('projectId', projectId);
      expect(audit).toHaveProperty('taskId', taskId);
    }
    expect(result.audit.map(({ projectEventId }) => projectEventId)).toEqual(
      record.events.map(({ eventId }) => eventId),
    );
    expect(result.audit.map(({ sequence }) => sequence)).toEqual(
      record.events.map(({ sequence }) => sequence),
    );
    expect(new Set(result.audit.map(({ auditEventId }) => auditEventId)).size).toBe(
      record.events.length,
    );
    expect(result.audit.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        'project.created',
        'agent.created',
        'delegation.created',
        'execution.state_changed',
        'tool.requested',
        'policy.decided',
        'approval.requested',
        'approval.decided',
        'effect.attempt',
        'effect.result',
        'artifact.published',
        'evidence.recorded',
        'completion.claimed',
        'verification.started',
        'verification.decided',
      ]),
    );
    for (const audit of record.supervision.audit) {
      expect(result.audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            auditEventId: audit.auditEventId,
            supervisionSequence: audit.sequence,
            actorType: audit.actorType,
            actorId: audit.actorId,
            action: audit.action,
            targetType: audit.targetType,
            targetId: audit.targetId,
            occurredAt: audit.occurredAt,
            reason: audit.reason,
            outcome: audit.outcome,
            correlationId: audit.correlationId,
          }),
        ]),
      );
    }
    expect(result.organizationLineage).toMatchObject({
      authorAgentId: expect.any(String),
      authorLineageId: expect.any(String),
      reviewerAgentId: expect.any(String),
      reviewerLineageId: expect.any(String),
      independentReview: true,
    });
    await controlPlane.server.close();
  });

  it.each(EXECUTION_STATES)('projects exact ExecutionState parity for %s', async (state) => {
    const { controlPlane, projectId } = await fixture();
    controlPlane.repository.setFixtureExecutionState(projectId, state as ExecutionState);
    const record = await controlPlane.repository.get(projectId);
    if (record === null) throw new Error('Expected durable project record');
    const result = projectResults(record);
    expect(result.executions[0]?.state).toBe(state);
    expect(result.verified).toBe(false);
    if (['SUSPENDED', 'STOPPING', 'STOPPED', 'FAILED', 'CANCELLED'].includes(state)) {
      expect(result.projectState).not.toBe('COMPLETED');
    }
    await controlPlane.server.close();
  });

  it('replays project events without gaps or duplicates and reloads bounded presence after cursor expiry', async () => {
    const { controlPlane, projectId } = await fixture();
    const before = await controlPlane.repository.listEvents(projectId, 0);
    expect(before.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: before.length }, (_, index) => index + 1),
    );

    const expiryBoundary = before[3]?.sequence;
    if (expiryBoundary === undefined) throw new Error('Expected enough fixture events');
    await controlPlane.repository.expireEventsBefore(projectId, expiryBoundary);
    await expect(
      controlPlane.repository.listEvents(projectId, expiryBoundary - 2),
    ).rejects.toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });

    const replay = await controlPlane.repository.listEvents(projectId, expiryBoundary - 1);
    expect(replay.map(({ sequence }) => sequence)).toEqual(
      replay.map(({ sequence }) => sequence).sort((left, right) => left - right),
    );
    expect(new Set(replay.map(({ sequence }) => sequence)).size).toBe(replay.length);

    const view = await controlPlane.service.getProject(projectId);
    if (view === null) throw new Error('Expected ProjectView after cursor expiry');
    expect(view.presences).not.toHaveLength(0);
    expect(new Set(view.presences.map(({ agentId }) => agentId))).toEqual(
      new Set([...view.personas, ...view.specialists].map(({ agentId }) => agentId)),
    );
    expect(
      view.presences.every(
        ({ sourceType, sourceId }) => sourceType.length > 0 && sourceId.length > 0,
      ),
    ).toBe(true);
    expect(view.lastSequence).toBeGreaterThanOrEqual(before.at(-1)?.sequence ?? 0);
    await controlPlane.server.close();
  });

  it('links a durable recovery checkpoint to the suspended execution', async () => {
    const { controlPlane, projectId } = await fixture();
    const initial = await controlPlane.repository.get(projectId);
    if (initial === null) throw new Error('Expected durable project record');
    const executionId = initial.scheduling.execution.executionId;
    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId,
      command: 'PAUSE',
      reason: 'Preserve a deterministic checkpoint for result inspection',
      expectedVersion: initial.view.version,
      idempotencyKey: 'result-projection-pause',
      correlationId: '73000000-0000-4000-8000-000000000005',
    });
    const paused = await controlPlane.repository.get(projectId);
    if (paused === null) throw new Error('Expected paused project record');
    const result = projectResults(paused);
    expect(result.projectState).toBe('PAUSED');
    expect(result.checkpoints).toEqual([expect.objectContaining({ executionId })]);
    controlPlane.advanceTime(1_000);

    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId,
      command: 'RESUME',
      reason: 'Resume while retaining the complete result history',
      expectedVersion: paused.view.version,
      idempotencyKey: 'result-projection-resume',
      correlationId: '73000000-0000-4000-8000-000000000006',
    });
    const resumed = await controlPlane.repository.get(projectId);
    if (resumed === null) throw new Error('Expected resumed project record');
    const resumedResult = projectResults(resumed);
    const suspendedEvent = [...resumed.events]
      .reverse()
      .find(
        ({ kind, aggregate, payload }) =>
          kind === 'execution.state_changed' &&
          aggregate.id === executionId &&
          payload.toState === 'SUSPENDED',
      );
    if (suspendedEvent === undefined) throw new Error('Expected source suspension event');
    expect(resumedResult.projectState).toBe('ACTIVE');
    expect(resumedResult.executions.map(({ executionId: id }) => id)).toEqual([
      resumed.scheduling.execution.executionId,
      executionId,
    ]);
    expect(resumedResult.executions).toEqual([
      expect.objectContaining({
        executionId: resumed.scheduling.execution.executionId,
        attemptNumber: 2,
        endedAt: null,
        routeDecisionId: expect.any(String),
      }),
      expect.objectContaining({
        executionId,
        attemptNumber: 1,
        state: 'SUSPENDED',
        endedAt: suspendedEvent.occurredAt,
        routeDecisionId: expect.any(String),
      }),
    ]);
    expect(resumedResult.executions[1]?.endedAt).not.toBe(resumedResult.executions[0]?.startedAt);
    expect(resumedResult.checkpoints).toEqual([expect.objectContaining({ executionId })]);
    expect(resumedResult.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'control.pause',
          reason: 'Preserve a deterministic checkpoint for result inspection',
          outcome: 'PAUSED',
        }),
        expect.objectContaining({
          action: 'control.resume',
          reason: 'Resume while retaining the complete result history',
          outcome: 'ACTIVE',
        }),
      ]),
    );
    for (const action of ['control.pause', 'control.resume']) {
      const audit = resumedResult.audit.find((item) => item.action === action);
      if (audit === undefined) throw new Error(`Expected ${action} audit entry`);
      expect(resumed.events.find(({ eventId }) => eventId === audit.projectEventId)?.sequence).toBe(
        audit.sequence,
      );
    }
    await controlPlane.server.close();
  });

  it('keeps evidence without an artifact explicitly unlinked across pause and resume', async () => {
    const { controlPlane, projectId } = await fixture();
    const before = await controlPlane.repository.get(projectId);
    if (before === null) throw new Error('Expected durable project record');
    const task = before.view.tasks[0];
    if (task === undefined) throw new Error('Expected fixture task');
    const evidenceId = '73000000-0000-4000-8000-000000000020';
    await controlPlane.verification.recordEvidence({
      projectId,
      correlationId: '73000000-0000-4000-8000-000000000021',
      evidence: {
        evidenceId,
        projectId,
        taskId: task.taskId,
        producerAgentId: before.organization.specialist.agentId,
        producerLineageId: before.organization.specialist.lineageId,
        type: 'RECONCILIATION',
        status: 'PASS',
        observedAt: '2026-09-01T08:00:00.000Z',
        gitRevision: task.expectedRevision,
        sourceHash: `sha256:${'a'.repeat(64)}`,
      },
    });
    const recorded = await controlPlane.repository.get(projectId);
    if (recorded === null) throw new Error('Expected evidence-bearing project record');
    expect(
      projectResults(recorded).evidence.find((item) => item.evidenceId === evidenceId),
    ).toEqual(expect.objectContaining({ artifactId: null, executionId: null }));

    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId,
      command: 'PAUSE',
      reason: 'Checkpoint evidence attribution before a successor execution',
      expectedVersion: recorded.view.version,
      idempotencyKey: 'result-projection-unlinked-pause',
      correlationId: '73000000-0000-4000-8000-000000000022',
    });
    const paused = await controlPlane.repository.get(projectId);
    if (paused === null) throw new Error('Expected paused project record');
    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId,
      command: 'RESUME',
      reason: 'Resume without fabricating evidence execution provenance',
      expectedVersion: paused.view.version,
      idempotencyKey: 'result-projection-unlinked-resume',
      correlationId: '73000000-0000-4000-8000-000000000023',
    });
    const resumed = await controlPlane.repository.get(projectId);
    if (resumed === null) throw new Error('Expected resumed project record');
    const result = projectResults(resumed);
    expect(result.evidence.find((item) => item.evidenceId === evidenceId)).toEqual(
      expect.objectContaining({ artifactId: null, executionId: null }),
    );
    expect(result.executions[0]?.executionId).not.toBe(before.scheduling.execution.executionId);
    await controlPlane.server.close();
  });

  it('exposes authoritative verification blockers and recovery state', async () => {
    const { controlPlane, projectId } = await fixture('EVIDENCE_FAIL');
    await approveAndRun(controlPlane, projectId);
    const record = await controlPlane.repository.get(projectId);
    if (record === null) throw new Error('Expected blocked project record');
    const result = projectResults(record);
    expect(result.projectState).toBe('BLOCKED');
    expect(result.blockedReasons).toEqual(record.supervision.blockedReasons);
    expect(result.blockedReasons).not.toHaveLength(0);
    expect(result.recovery).toEqual(record.supervision.recovery);
    expect(result.recovery.progress).not.toHaveLength(0);
    await controlPlane.server.close();
  });

  it('keeps an evidence-negative result explicitly unverified', async () => {
    const { controlPlane, projectId } = await fixture();
    controlPlane.verification.setFixtureDisposition(projectId, 'UNVERIFIED');
    await approveAndRun(controlPlane, projectId);
    const record = await controlPlane.repository.get(projectId);
    if (record === null) throw new Error('Expected durable project record');
    const result = projectResults(record);
    expect(result.task.state).toBe('CLAIMED_COMPLETE');
    expect(result.verified).toBe(false);
    expect(result.projectState).not.toBe('COMPLETED');
    await controlPlane.server.close();
  });

  it.each([
    ['SUSPENDED', 'PAUSED'],
    ['STOPPING', 'STOPPING'],
    ['STOPPED', 'STOPPED'],
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
  ] as const)(
    'does not present %s as a completed verified result',
    async (state, expectedProjectState) => {
      const { controlPlane, projectId } = await fixture();
      controlPlane.repository.setFixtureExecutionState(projectId, state);
      const record = await controlPlane.repository.get(projectId);
      if (record === null) throw new Error('Expected durable project record');
      const result = projectResults(record);
      expect(result.projectState).toBe(expectedProjectState);
      expect(result.executions[0]?.state).toBe(state);
      expect(result.verified).toBe(false);
      await controlPlane.server.close();
    },
  );
});
