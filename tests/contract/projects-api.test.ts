import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFixtureControlPlane,
  LoopbackSessionManager,
} from '../../apps/control-plane/src/index.js';

const bootstrapSecret = 'b'.repeat(48);
const origin = 'http://127.0.0.1:4173';
const supervisorId = '30000000-0000-4000-8000-000000000001';

async function authenticatedFixture() {
  const fixture = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  const response = await fixture.server.inject({
    method: 'POST',
    url: '/v1/session/bootstrap',
    headers: { origin },
    payload: { bootstrapSecret },
  });
  const cookie = response.headers['set-cookie'];
  if (cookie === undefined) throw new Error('Expected supervisor session cookie');
  return { ...fixture, cookie: cookie.split(';')[0] ?? '' };
}

describe('projects HTTP contract', () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('exposes public health and exchanges the bootstrap secret exactly once on loopback', async () => {
    const fixture = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
    servers.push(fixture.server);
    const health = await fixture.server.inject({ method: 'GET', url: '/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'alive', version: '0.0.0' });

    const first = await fixture.server.inject({
      method: 'POST',
      url: '/v1/session/bootstrap',
      headers: { origin },
      payload: { bootstrapSecret },
    });
    expect(first.statusCode).toBe(204);
    expect(first.headers['set-cookie']).toContain('HttpOnly');
    expect(first.headers['set-cookie']).toContain('SameSite=Strict');
    expect(
      await fixture.server.inject({
        method: 'POST',
        url: '/v1/session/bootstrap',
        headers: { origin },
        payload: { bootstrapSecret },
      }),
    ).toMatchObject({ statusCode: 409 });
  });

  it('invalidates the bootstrap secret even when the exchange request is malformed', async () => {
    const fixture = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
    servers.push(fixture.server);
    const malformed = await fixture.server.inject({
      method: 'POST',
      url: '/v1/session/bootstrap',
      headers: { origin },
      payload: { bootstrapSecret, unexpected: true },
    });
    expect(malformed.statusCode).toBe(400);
    const retry = await fixture.server.inject({
      method: 'POST',
      url: '/v1/session/bootstrap',
      headers: { origin },
      payload: { bootstrapSecret },
    });
    expect(retry.statusCode).toBe(409);
  });

  it('rejects bootstrap on a non-loopback listener and expires an unused secret', async () => {
    const fixture = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
    servers.push(fixture.server);
    await fixture.server.listen({ host: '0.0.0.0', port: 0 });
    const address = fixture.server.addresses()[0];
    if (address === undefined) throw new Error('Expected listener address');
    const exposed = await fetch(`http://127.0.0.1:${address.port}/v1/session/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ bootstrapSecret }),
    });
    expect(exposed.status).toBe(400);
    await expect(exposed.json()).resolves.toMatchObject({ code: 'LOOPBACK_REQUIRED' });

    let now = 0;
    const sessions = new LoopbackSessionManager(
      bootstrapSecret,
      supervisorId,
      origin,
      '127.0.0.1',
      () => new Date(now),
      100,
    );
    now = 101;
    expect(() => sessions.exchange(bootstrapSecret, origin)).toThrowError(
      expect.objectContaining({ code: 'BOOTSTRAP_SECRET_EXPIRED' }),
    );
    expect(() => sessions.exchange(bootstrapSecret, origin)).toThrowError(
      expect.objectContaining({ code: 'BOOTSTRAP_ALREADY_USED' }),
    );
  });

  it('rejects unauthorized, malformed, oversized, and unknown-scenario project requests safely', async () => {
    const fixture = await authenticatedFixture();
    servers.push(fixture.server);
    const headers = {
      cookie: fixture.cookie,
      'idempotency-key': 'objective-invalid',
      'x-correlation-id': '30000000-0000-4000-8000-000000000002',
    };
    expect(
      await fixture.server.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { objective: 'x', fixtureScenario: 'PASS' },
      }),
    ).toMatchObject({ statusCode: 401 });
    for (const payload of [
      { objective: '   ', fixtureScenario: 'PASS' },
      { objective: 'x'.repeat(4001), fixtureScenario: 'PASS' },
      { objective: `${'x'.repeat(4000)} `, fixtureScenario: 'PASS' },
      { objective: 'valid', fixtureScenario: 'REAL_PROVIDER' },
      { objective: 'valid', fixtureScenario: 'PASS', unknown: true },
    ]) {
      const response = await fixture.server.inject({
        method: 'POST',
        url: '/v1/projects',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: expect.any(String) });
    }
    expect(fixture.repository.size()).toBe(0);
  });

  it('creates, reads, and idempotently returns one versioned project', async () => {
    const fixture = await authenticatedFixture();
    servers.push(fixture.server);
    const headers = {
      cookie: fixture.cookie,
      'idempotency-key': 'objective-create-1',
      'x-correlation-id': '30000000-0000-4000-8000-000000000003',
    };
    const payload = {
      objective: 'Create a deterministic release-note artifact for the fixture',
      fixtureScenario: 'PASS',
    };
    const schedule = vi.spyOn(fixture.scheduler, 'schedule');
    const created = await fixture.server.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toMatch(/^"\d+"$/);
    expect(created.json()).toMatchObject({ status: 'ACTIVE', version: 2 });

    const reused = await fixture.server.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload,
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toEqual(created.json());
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(fixture.repository.size()).toBe(1);

    const projectId = created.json<{ projectId: string }>().projectId;
    const read = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}`,
      headers: { cookie: fixture.cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers.etag).toBe(created.headers.etag);
    expect(read.json()).toEqual(created.json());

    const conflict = await fixture.server.inject({
      method: 'POST',
      url: '/v1/projects',
      headers,
      payload: { ...payload, objective: 'Different objective' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('replays ordered SSE events and reports an expired cursor for projection reload', async () => {
    const fixture = await authenticatedFixture();
    servers.push(fixture.server);
    const created = await fixture.server.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: {
        cookie: fixture.cookie,
        'idempotency-key': 'objective-events',
        'x-correlation-id': '30000000-0000-4000-8000-000000000004',
      },
      payload: {
        objective: 'Create a deterministic release-note artifact for the fixture',
        fixtureScenario: 'PASS',
      },
    });
    const projectId = created.json<{ projectId: string }>().projectId;
    const replay = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/events`,
      headers: { cookie: fixture.cookie, 'last-event-id': '2' },
    });
    expect(replay.statusCode).toBe(200);
    const ids = [...replay.body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(1);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.every((id) => id > 2)).toBe(true);

    fixture.repository.expireBefore(projectId, 4);
    const expired = await fixture.server.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/events`,
      headers: { cookie: fixture.cookie, 'last-event-id': '1' },
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({ code: 'EVENT_CURSOR_EXPIRED' });
  });

  it('fails closed when an application update uses a stale project version', async () => {
    const fixture = await authenticatedFixture();
    servers.push(fixture.server);
    const result = await fixture.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: 'versioned-objective',
      correlationId: '30000000-0000-4000-8000-000000000005',
      objective: 'Create a deterministic release-note artifact for the fixture',
      fixtureScenario: 'PASS',
    });
    await expect(fixture.repository.assertVersion(result.view.projectId, 1)).rejects.toMatchObject({
      code: 'PROJECT_VERSION_CONFLICT',
    });
  });
});
