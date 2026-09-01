import { afterEach, describe, expect, it } from 'vitest';

import { createFixtureControlPlane } from '../../apps/control-plane/src/index.js';

const bootstrapSecret = 's'.repeat(48);
const origin = 'http://127.0.0.1:4173';
const supervisorId = '61000000-0000-4000-8000-000000000001';

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
      'idempotency-key': `supervision-project-${fixture.repository.size()}`,
      'x-correlation-id': '61000000-0000-4000-8000-000000000002',
    },
    payload: {
      objective: 'Apply one approval-gated deterministic fixture marker',
      fixtureScenario: 'PASS',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ projectId: string; version: number }>();
}

function commandHeaders(cookie: string, version: number, suffix: string) {
  return {
    cookie,
    'idempotency-key': `supervision-command-${suffix}`,
    'x-correlation-id': `61000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    'if-match': `"${version}"`,
  };
}

describe('supervision HTTP contract', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('requires a supervisor session and exposes approval list/item acquisition with a strong ETag', async () => {
    const fixture = await authenticatedFixture();
    servers.push(fixture.server);
    const project = await createProject(fixture);

    const unauthorized = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/approvals`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const listed = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/approvals?state=REQUESTED`,
      headers: { cookie: fixture.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const supervision = listed.json<{
      items: Array<{
        approvalId: string;
        projectId: string;
        state: string;
        actionDigest: string;
        scope: string;
        version: number;
      }>;
      budget: Record<string, unknown>;
      authority: Record<string, unknown>;
      checkpoint: Record<string, unknown> | null;
      recovery: Record<string, unknown>;
      effects: Array<Record<string, unknown>>;
      blockedReasons: string[];
      projectState: string;
      projectVersion: number;
    }>();
    expect(Object.keys(supervision).sort()).toEqual(
      [
        'items',
        'budget',
        'authority',
        'checkpoint',
        'recovery',
        'effects',
        'blockedReasons',
        'projectState',
        'projectVersion',
      ].sort(),
    );
    expect(Object.keys(supervision.effects[0] ?? {}).sort()).toEqual(
      [
        'effectId',
        'taskId',
        'actionDigest',
        'semanticKey',
        'state',
        'reconciliationOutcome',
        'groundTruthDigest',
        'version',
      ].sort(),
    );
    const approval = supervision.items[0];
    expect(approval).toMatchObject({
      projectId: project.projectId,
      state: 'REQUESTED',
      scope: 'fixture:repository/approved-marker',
      version: 1,
    });
    expect(approval?.actionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    if (approval === undefined) throw new Error('Expected pending approval');

    const item = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/approvals/${approval.approvalId}`,
      headers: { cookie: fixture.cookie },
    });
    expect(item.statusCode).toBe(200);
    expect(item.headers.etag).toBe('"1"');
    expect(item.json()).toEqual(approval);
  });

  it('serializes concurrent decisions, rejects tampering, and returns the original idempotent result', async () => {
    const fixture = await authenticatedFixture();
    servers.push(fixture.server);
    const project = await createProject(fixture);
    const listed = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${project.projectId}/approvals`,
      headers: { cookie: fixture.cookie },
    });
    const approval = listed.json<{
      items: Array<{ approvalId: string; actionDigest: string; version: number }>;
    }>().items[0];
    if (approval === undefined) throw new Error('Expected approval');

    const tampered = await fixture.server.inject({
      method: 'POST',
      url: `/v1/projects/${project.projectId}/approvals/${approval.approvalId}/decision`,
      headers: commandHeaders(fixture.cookie, approval.version, '100'),
      payload: {
        decision: 'APPROVE',
        actionDigest: `sha256:${'0'.repeat(64)}`,
        reason: 'The displayed action was altered',
      },
    });
    expect(tampered.statusCode).toBe(422);
    expect(tampered.json()).toMatchObject({ code: 'ACTION_DIGEST_MISMATCH' });

    const decide = (decision: 'APPROVE' | 'REJECT', suffix: string) =>
      fixture.server.inject({
        method: 'POST',
        url: `/v1/projects/${project.projectId}/approvals/${approval.approvalId}/decision`,
        headers: commandHeaders(fixture.cookie, approval.version, suffix),
        payload: { decision, actionDigest: approval.actionDigest, reason: `${decision} fixture` },
      });
    const raced = await Promise.all([decide('APPROVE', '101'), decide('REJECT', '102')]);
    expect(raced.map(({ statusCode }) => statusCode).sort()).toEqual([200, 412]);
    const winner = raced.find(({ statusCode }) => statusCode === 200);
    if (winner === undefined) throw new Error('Expected one decision winner');
    expect(winner.headers.etag).toBe('"2"');
    expect(winner.json()).toMatchObject({ state: expect.stringMatching(/^(APPROVED|REJECTED)$/) });

    const replay = await decide(
      winner.json<{ state: string }>().state === 'APPROVED' ? 'APPROVE' : 'REJECT',
      winner.json<{ state: string }>().state === 'APPROVED' ? '101' : '102',
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(winner.json());
  });

  it('enforces versioned, idempotent, state-specific pause/resume/stop/cancel controls', async () => {
    const fixture = await authenticatedFixture();
    servers.push(fixture.server);
    const project = await createProject(fixture);
    const command = (
      name: 'pause' | 'resume' | 'stop' | 'cancel',
      version: number,
      suffix: string,
    ) =>
      fixture.server.inject({
        method: 'POST',
        url: `/v1/projects/${project.projectId}/commands/${name}`,
        headers: commandHeaders(fixture.cookie, version, suffix),
        payload: { reason: `${name} the supervised fixture` },
      });
    const read = async () => {
      const response = await fixture.server.inject({
        method: 'GET',
        url: `/v1/projects/${project.projectId}`,
        headers: { cookie: fixture.cookie },
      });
      return response.json<{ status: string; version: number }>();
    };

    const unauthorized = await fixture.server.inject({
      method: 'POST',
      url: `/v1/projects/${project.projectId}/commands/pause`,
      headers: {
        'idempotency-key': 'supervision-unauthorized',
        'x-correlation-id': '61000000-0000-4000-8000-000000000200',
        'if-match': '"2"',
      },
      payload: { reason: 'not authenticated' },
    });
    expect(unauthorized.statusCode).toBe(401);

    const paused = await command('pause', project.version, '201');
    expect(paused.statusCode).toBe(202);
    expect(paused.json()).toMatchObject({ projectId: project.projectId, status: 'ACCEPTED' });
    expect(await read()).toMatchObject({ status: 'PAUSED', version: project.version + 1 });

    const replayedPause = await command('pause', project.version, '201');
    expect(replayedPause.statusCode).toBe(202);
    expect(replayedPause.json()).toEqual(paused.json());
    const staleStop = await command('stop', project.version, '202');
    expect(staleStop.statusCode).toBe(412);
    expect(staleStop.json()).toMatchObject({ code: 'PROJECT_VERSION_CONFLICT' });

    const resumed = await command('resume', project.version + 1, '203');
    expect(resumed.statusCode).toBe(202);
    expect(await read()).toMatchObject({ status: 'ACTIVE', version: project.version + 2 });
    const stopped = await command('stop', project.version + 2, '204');
    expect(stopped.statusCode).toBe(202);
    expect(await read()).toMatchObject({ status: 'STOPPED', version: project.version + 3 });
    const restarted = await command('resume', project.version + 3, '205');
    expect(restarted.statusCode).toBe(202);
    expect(await read()).toMatchObject({ status: 'ACTIVE', version: project.version + 4 });
    const cancelled = await command('cancel', project.version + 4, '206');
    expect(cancelled.statusCode).toBe(202);
    expect(await read()).toMatchObject({ status: 'CANCELLED', version: project.version + 5 });
    const terminalResume = await command('resume', project.version + 5, '207');
    expect(terminalResume.statusCode).toBe(409);
    expect(terminalResume.json()).toMatchObject({ code: 'CONTROL_STATE_CONFLICT' });
  });
});
