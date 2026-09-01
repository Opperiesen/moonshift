import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020, type AnySchemaObject } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { createFixtureControlPlane } from '../../apps/control-plane/src/index.js';
import { isRfc3339DateTime, isUri, isUriReference } from '../../packages/contracts/src/index.js';

const root = process.cwd();
const eventSchema = JSON.parse(
  readFileSync(
    resolve(root, 'specs/001-supervised-autonomous-loop/contracts/event-envelope.schema.json'),
    'utf8',
  ),
) as AnySchemaObject;
const openapi = YAML.parse(
  readFileSync(
    resolve(root, 'specs/001-supervised-autonomous-loop/contracts/http-api.openapi.yaml'),
    'utf8',
  ),
) as AnySchemaObject;
const resultAjv = new Ajv2020({
  strict: false,
  allErrors: true,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    'date-time': isRfc3339DateTime,
    'uri-reference': isUriReference,
    uri: isUri,
  },
});
resultAjv.addSchema(openapi, 'moonshift-openapi');
const validateResult = resultAjv.compile({
  $ref: 'moonshift-openapi#/components/schemas/ResultView',
});
const bootstrapSecret = 'r'.repeat(48);
const origin = 'http://127.0.0.1:4173';
const supervisorId = '72000000-0000-4000-8000-000000000001';
const revision = '857f0f9b02210000000000000000000000000000';
const executionStates = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'CHECKPOINTING',
  'SUSPENDED',
  'STOPPING',
  'STOPPED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'LOST',
  'RECONCILING',
] as const;

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function authenticatedFixture() {
  const fixture = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  const bootstrap = await fixture.server.inject({
    method: 'POST',
    url: '/v1/session/bootstrap',
    headers: { origin },
    payload: { bootstrapSecret },
  });
  const cookie = bootstrap.headers['set-cookie']?.split(';')[0];
  if (cookie === undefined) throw new Error('Expected supervisor session cookie');
  return { ...fixture, cookie };
}

async function createProject(fixture: Awaited<ReturnType<typeof authenticatedFixture>>) {
  const response = await fixture.server.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: {
      cookie: fixture.cookie,
      'idempotency-key': 'results-project-create',
      'x-correlation-id': '72000000-0000-4000-8000-000000000002',
    },
    payload: {
      objective: 'Publish a revision-bound result for contract verification',
      fixtureScenario: 'PASS',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ projectId: string; version: number }>();
}

async function approveFixture(
  fixture: Awaited<ReturnType<typeof authenticatedFixture>>,
  projectId: string,
) {
  const listed = await fixture.server.inject({
    method: 'GET',
    url: `/v1/projects/${projectId}/approvals`,
    headers: { cookie: fixture.cookie },
  });
  const approval = listed.json<{
    items: Array<{ approvalId: string; actionDigest: string; version: number }>;
  }>().items[0];
  if (approval === undefined) throw new Error('Expected approval');
  const decided = await fixture.server.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/approvals/${approval.approvalId}/decision`,
    headers: {
      cookie: fixture.cookie,
      'idempotency-key': 'results-approval-decision',
      'x-correlation-id': '72000000-0000-4000-8000-000000000003',
      'if-match': `"${approval.version}"`,
    },
    payload: {
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Approve the exact fixture effect',
    },
  });
  expect(decided.statusCode).toBe(200);
}

async function controlFixture(
  fixture: Awaited<ReturnType<typeof authenticatedFixture>>,
  projectId: string,
  command: 'pause' | 'resume' | 'stop',
  expectedVersion: number,
  suffix: string,
  identity?: {
    readonly idempotencyKey: string;
    readonly correlationId: string;
  },
) {
  const response = await fixture.server.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/commands/${command}`,
    headers: {
      cookie: fixture.cookie,
      'idempotency-key': identity?.idempotencyKey ?? `results-control-${command}-${suffix}`,
      'x-correlation-id':
        identity?.correlationId ?? `72000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
      'if-match': `"${expectedVersion}"`,
    },
    payload: { reason: `${command} the result projection through the public API` },
  });
  expect(response.statusCode, response.body).toBe(202);
  return response;
}

describe('results HTTP contract', () => {
  it('requires supervisor authentication and returns not-found for an unknown project', async () => {
    const fixture = await authenticatedFixture();
    const unauthenticated = await fixture.server.inject({
      method: 'GET',
      url: '/v1/projects/72000000-0000-4000-8000-000000000099/results',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const missing = await fixture.server.inject({
      method: 'GET',
      url: '/v1/projects/72000000-0000-4000-8000-000000000099/results',
      headers: { cookie: fixture.cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await fixture.server.close();
  });

  it('projects truthful artifact, evidence, audit, lineage, and provenance records', async () => {
    const fixture = await authenticatedFixture();
    const project = await createProject(fixture);
    await approveFixture(fixture, project.projectId);
    const response = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/results`,
      headers: { cookie: fixture.cookie },
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json<unknown>();
    expect(validateResult(responseBody), JSON.stringify(validateResult.errors)).toBe(true);
    const result = responseBody as {
      projectId: string;
      projectState: string;
      task: { taskId: string; state: string; expectedRevision: string };
      artifacts: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
      executions: Array<Record<string, unknown>>;
      organizationLineage: Record<string, unknown>;
      audit: Array<Record<string, unknown>>;
      verified: boolean;
    };
    expect(result.projectId).toBe(project.projectId);
    expect(result.task.expectedRevision).toBe(revision);
    expect(result.task.state).toBe('VERIFIED');
    expect(result.verified).toBe(true);
    expect(result.artifacts[0]).toMatchObject({
      projectId: project.projectId,
      taskId: result.task.taskId,
      gitRevision: revision,
      contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(result.evidence[0]).toMatchObject({
      gitRevision: revision,
      sourceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(result.executions[0]).toMatchObject({
      backendConnectionId: expect.any(String),
      modelDescriptorId: expect.any(String),
      modelDescriptorVersion: expect.any(Number),
    });
    expect(result.organizationLineage).toMatchObject({ independentReview: true });
    expect(result.audit.length).toBeGreaterThan(0);
    expect(result.audit.map((event) => event.sequence)).toEqual(
      [...result.audit].map((event) => event.sequence).sort((a, b) => Number(a) - Number(b)),
    );
    await fixture.server.close();
  });

  it('emits a schema-valid verification decision linked to the task aggregate and preserves execution states', async () => {
    const fixture = await authenticatedFixture();
    const project = await createProject(fixture);
    await approveFixture(fixture, project.projectId);
    const events = await fixture.repository.listEvents(project.projectId, 0);
    const actualExecutionTransitions = events
      .filter((event) => (event.kind as string) === 'execution.state_changed')
      .slice(-2)
      .map(({ payload }) => ({ fromState: payload.fromState, toState: payload.toState }));
    expect(actualExecutionTransitions).toEqual([
      { fromState: 'WAITING_FOR_APPROVAL', toState: 'RUNNING' },
      { fromState: 'RUNNING', toState: 'SUCCEEDED' },
    ]);
    const verification = events.find((event) => (event.kind as string) === 'verification.decided');
    expect(verification).toBeDefined();
    expect(verification?.aggregate).toMatchObject({ type: 'TASK', id: expect.any(String) });
    expect(verification?.aggregate.version).toEqual(expect.any(Number));
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(eventSchema);
    expect(validate(verification), JSON.stringify(validate.errors)).toBe(true);

    for (const state of executionStates) {
      fixture.repository.setFixtureExecutionState(project.projectId, state);
      const result = await fixture.server.inject({
        method: 'GET',
        url: `/v1/projects/${project.projectId}/results`,
        headers: { cookie: fixture.cookie },
      });
      const body = result.json<{ projectState: string; executions: Array<{ state: string }> }>();
      expect(validateResult(body), JSON.stringify(validateResult.errors)).toBe(true);
      const executionEvent = [...(await fixture.repository.listEvents(project.projectId, 0))]
        .reverse()
        .find((event) => (event.kind as string) === 'execution.state_changed');
      expect(executionEvent?.payload).toMatchObject({ toState: state });
      expect(body.executions[0]?.state).toBe(state);
      expect(body.projectState).not.toBe('COMPLETED');
    }
    await fixture.server.close();
  });

  it('projects real pause, resume, and stop controls from the current durable execution', async () => {
    const fixture = await authenticatedFixture();
    const project = await createProject(fixture);
    const initial = await fixture.repository.get(project.projectId);
    if (initial === null) throw new Error('Expected project');
    const initialExecutionId = initial.scheduling.execution.executionId;

    await controlFixture(fixture, project.projectId, 'pause', initial.view.version, '20');
    const pausedResponse = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/results`,
      headers: { cookie: fixture.cookie },
    });
    const paused = pausedResponse.json<{
      projectState: string;
      executions: Array<{ executionId: string; state: string }>;
    }>();
    expect(validateResult(paused), JSON.stringify(validateResult.errors)).toBe(true);
    expect(paused).toMatchObject({
      projectState: 'PAUSED',
      executions: [{ executionId: initialExecutionId, state: 'SUSPENDED' }],
    });

    const pausedRecord = await fixture.repository.get(project.projectId);
    if (pausedRecord === null) throw new Error('Expected paused project');
    await controlFixture(fixture, project.projectId, 'resume', pausedRecord.view.version, '21');
    const resumedRecord = await fixture.repository.get(project.projectId);
    if (resumedRecord === null) throw new Error('Expected resumed project');
    expect(resumedRecord.scheduling.execution.executionId).not.toBe(initialExecutionId);
    expect(resumedRecord.scheduling.runtime.executionId).toBe(
      resumedRecord.scheduling.execution.executionId,
    );
    const resumedResponse = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/results`,
      headers: { cookie: fixture.cookie },
    });
    const resumed = resumedResponse.json<{
      projectState: string;
      executions: Array<{ executionId: string; state: string }>;
    }>();
    expect(validateResult(resumed), JSON.stringify(validateResult.errors)).toBe(true);
    expect(resumed).toMatchObject({
      projectState: 'ACTIVE',
      executions: [
        {
          executionId: resumedRecord.scheduling.execution.executionId,
          state: 'WAITING_FOR_APPROVAL',
        },
        { executionId: initialExecutionId, state: 'SUSPENDED' },
      ],
    });
    const successorTransitions = (await fixture.repository.listEvents(project.projectId, 0))
      .filter(
        ({ kind, aggregate }) =>
          kind === 'execution.state_changed' &&
          aggregate.id === resumedRecord.scheduling.execution.executionId,
      )
      .map(({ payload }) => ({ fromState: payload.fromState, toState: payload.toState }));
    expect(successorTransitions).toEqual([
      { fromState: null, toState: 'QUEUED' },
      { fromState: 'QUEUED', toState: 'STARTING' },
      { fromState: 'STARTING', toState: 'RUNNING' },
      { fromState: 'RUNNING', toState: 'WAITING_FOR_APPROVAL' },
    ]);

    await controlFixture(fixture, project.projectId, 'stop', resumedRecord.view.version, '22');
    const stoppedResponse = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/results`,
      headers: { cookie: fixture.cookie },
    });
    const stopped = stoppedResponse.json<{
      projectState: string;
      executions: Array<{ executionId: string; state: string }>;
    }>();
    expect(validateResult(stopped), JSON.stringify(validateResult.errors)).toBe(true);
    expect(stopped).toMatchObject({
      projectState: 'STOPPED',
      executions: [
        {
          executionId: resumedRecord.scheduling.execution.executionId,
          state: 'STOPPED',
        },
        { executionId: initialExecutionId, state: 'SUSPENDED' },
      ],
    });
    await fixture.server.close();
  });

  it('runs a fresh durable verification decision automatically after an HTTP resume', async () => {
    const fixture = await authenticatedFixture();
    const project = await createProject(fixture);
    const approval = (await fixture.supervision.getProjection(project.projectId)).approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    await fixture.supervision.decideApproval({
      actorId: supervisorId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Prepare an evaluating snapshot before the public control journey',
      expectedVersion: approval.version,
      idempotencyKey: 'results-stale-approval',
      correlationId: '72000000-0000-4000-8000-000000000023',
    });
    const prepared = await fixture.verification.prepareFixtureEvaluation({
      projectId: project.projectId,
      correlationId: '72000000-0000-4000-8000-000000000024',
      disposition: 'PASS',
    });
    const evaluating = await fixture.repository.get(project.projectId);
    if (evaluating === null) throw new Error('Expected evaluating project');

    await controlFixture(fixture, project.projectId, 'pause', evaluating.view.version, '25');
    const paused = await fixture.repository.get(project.projectId);
    expect(paused?.verification.evaluations.at(-1)).toMatchObject({
      evaluationId: prepared.evaluation.evaluationId,
      state: 'STALE',
    });
    if (paused === null) throw new Error('Expected paused project');

    const resume = await controlFixture(
      fixture,
      project.projectId,
      'resume',
      paused.view.version,
      '26',
    );
    const resumed = await fixture.repository.get(project.projectId);
    expect(resumed?.view.status).toBe('ACTIVE');
    expect(resumed?.view.tasks[0]?.state).toBe('VERIFIED');
    expect(resumed?.verification.evaluations.map(({ state }) => state)).toEqual([
      'STALE',
      'PASSED',
    ]);
    expect(resumed?.verification.evaluations[1]?.evaluationId).not.toBe(
      prepared.evaluation.evaluationId,
    );

    const replay = await controlFixture(
      fixture,
      project.projectId,
      'resume',
      paused.view.version,
      '26',
    );
    expect(replay.json()).toEqual(resume.json());
    expect(
      (await fixture.repository.get(project.projectId))?.verification.evaluations,
    ).toHaveLength(2);

    const response = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/results`,
      headers: { cookie: fixture.cookie },
    });
    const result = response.json<{ task: { state: string }; verified: boolean }>();
    expect(validateResult(result), JSON.stringify(validateResult.errors)).toBe(true);
    expect(result).toMatchObject({ task: { state: 'VERIFIED' }, verified: true });
    await fixture.server.close();
  });

  it('replays concurrent HTTP resumes across distinct correlation identifiers', async () => {
    const fixture = await authenticatedFixture();
    const project = await createProject(fixture);
    const approval = (await fixture.supervision.getProjection(project.projectId)).approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    await fixture.supervision.decideApproval({
      actorId: supervisorId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Prepare verification for concurrent resume replay',
      expectedVersion: approval.version,
      idempotencyKey: 'results-concurrent-replay-approval',
      correlationId: '72000000-0000-4000-8000-000000000032',
    });
    await fixture.verification.prepareFixtureEvaluation({
      projectId: project.projectId,
      correlationId: '72000000-0000-4000-8000-000000000033',
      disposition: 'PASS',
    });
    const evaluating = await fixture.repository.get(project.projectId);
    if (evaluating === null) throw new Error('Expected evaluating project');
    await controlFixture(fixture, project.projectId, 'pause', evaluating.view.version, '34');
    const paused = await fixture.repository.get(project.projectId);
    if (paused === null) throw new Error('Expected paused project');

    const firstCommitEntered = deferred();
    const secondCommitEntered = deferred();
    const releaseCommits = deferred();
    const originalCommit = fixture.verification.commitEvaluation.bind(fixture.verification);
    let commitCalls = 0;
    fixture.verification.commitEvaluation = async (input) => {
      commitCalls += 1;
      if (commitCalls === 1) firstCommitEntered.resolve();
      if (commitCalls === 2) secondCommitEntered.resolve();
      await releaseCommits.promise;
      return originalCommit(input);
    };
    try {
      const identity = { idempotencyKey: 'results-concurrent-resume-replay' };
      const first = controlFixture(
        fixture,
        project.projectId,
        'resume',
        paused.view.version,
        '35',
        {
          ...identity,
          correlationId: '72000000-0000-4000-8000-000000000035',
        },
      );
      await firstCommitEntered.promise;
      const second = controlFixture(
        fixture,
        project.projectId,
        'resume',
        paused.view.version,
        '36',
        {
          ...identity,
          correlationId: '72000000-0000-4000-8000-000000000036',
        },
      );
      await Promise.race([
        secondCommitEntered.promise,
        second.then(() => {
          throw new Error('Concurrent replay completed before entering verification commit');
        }),
      ]);
      releaseCommits.resolve();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.statusCode).toBe(202);
      expect(secondResponse.statusCode).toBe(202);
      expect(secondResponse.json()).toEqual(firstResponse.json());

      const replayed = await fixture.repository.get(project.projectId);
      expect(replayed?.verification.evaluations.map(({ state }) => state)).toEqual([
        'STALE',
        'PASSED',
      ]);
      expect(
        (await fixture.repository.listEvents(project.projectId, 0)).filter(
          ({ kind, payload }) => kind === 'verification.decided' && payload.decision === 'PASSED',
        ),
      ).toHaveLength(1);
    } finally {
      releaseCommits.resolve();
      fixture.verification.commitEvaluation = originalCommit;
      await fixture.server.close();
    }
  });

  it('treats a concurrent pause as safe supersession of the resume evaluation', async () => {
    const fixture = await authenticatedFixture();
    const project = await createProject(fixture);
    const approval = (await fixture.supervision.getProjection(project.projectId)).approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    await fixture.supervision.decideApproval({
      actorId: supervisorId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Prepare verification for a deterministic resume and pause race',
      expectedVersion: approval.version,
      idempotencyKey: 'results-race-approval',
      correlationId: '72000000-0000-4000-8000-000000000027',
    });
    await fixture.verification.prepareFixtureEvaluation({
      projectId: project.projectId,
      correlationId: '72000000-0000-4000-8000-000000000028',
      disposition: 'PASS',
    });
    const evaluating = await fixture.repository.get(project.projectId);
    if (evaluating === null) throw new Error('Expected evaluating project');
    await controlFixture(fixture, project.projectId, 'pause', evaluating.view.version, '29');
    const paused = await fixture.repository.get(project.projectId);
    if (paused === null) throw new Error('Expected paused project');

    const commitEntered = deferred();
    const releaseCommit = deferred();
    const originalCommit = fixture.verification.commitEvaluation.bind(fixture.verification);
    fixture.verification.commitEvaluation = async (input) => {
      commitEntered.resolve();
      await releaseCommit.promise;
      return originalCommit(input);
    };
    try {
      const resumePromise = controlFixture(
        fixture,
        project.projectId,
        'resume',
        paused.view.version,
        '30',
      );
      await commitEntered.promise;
      const resumed = await fixture.repository.get(project.projectId);
      expect(resumed?.view.status).toBe('ACTIVE');
      expect(resumed?.verification.evaluations.at(-1)?.state).toBe('EVALUATING');
      if (resumed === null) throw new Error('Expected resumed project');

      await controlFixture(fixture, project.projectId, 'pause', resumed.view.version, '31');
      releaseCommit.resolve();
      const resumeResponse = await resumePromise;
      expect(resumeResponse.statusCode).toBe(202);

      const superseded = await fixture.repository.get(project.projectId);
      expect(superseded?.view.status).toBe('PAUSED');
      expect(superseded?.view.tasks[0]?.state).toBe('VERIFYING');
      expect(superseded?.verification.evaluations.map(({ state }) => state)).toEqual([
        'STALE',
        'STALE',
      ]);
      expect(superseded?.verification.evaluations.some(({ state }) => state === 'PASSED')).toBe(
        false,
      );
    } finally {
      releaseCommit.resolve();
      fixture.verification.commitEvaluation = originalCommit;
      await fixture.server.close();
    }
  });
});
