import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFixtureControlPlane } from '../../apps/control-plane/src/index.js';
import { runProjectInspect } from '../../apps/cli/src/index.js';
import { createPlanningValidators } from '../../packages/contracts/src/index.js';
import { describe, expect, it } from 'vitest';

const bootstrapSecret = 'c'.repeat(48);
const origin = 'http://127.0.0.1:4173';
const supervisorId = '74000000-0000-4000-8000-000000000001';

async function fixture() {
  const controlPlane = createFixtureControlPlane({ bootstrapSecret, origin, supervisorId });
  const bootstrap = await controlPlane.server.inject({
    method: 'POST',
    url: '/v1/session/bootstrap',
    headers: { origin },
    payload: { bootstrapSecret },
  });
  const cookie = bootstrap.headers['set-cookie']?.split(';')[0];
  if (cookie === undefined) throw new Error('Expected supervisor session cookie');
  const created = await controlPlane.service.submitObjective({
    actorId: supervisorId,
    idempotencyKey: 'cli-project-create',
    correlationId: '74000000-0000-4000-8000-000000000002',
    objective: 'Inspect and export one complete deterministic project result',
    fixtureScenario: 'PASS',
  });
  const approval = (await controlPlane.supervision.getProjection(created.view.projectId))
    .approvals[0];
  if (approval === undefined) throw new Error('Expected fixture approval');
  await controlPlane.supervision.decideApproval({
    actorId: supervisorId,
    projectId: created.view.projectId,
    approvalId: approval.approvalId,
    decision: 'APPROVE',
    actionDigest: approval.actionDigest,
    reason: 'Approve the deterministic CLI inspection fixture',
    expectedVersion: approval.version,
    idempotencyKey: 'cli-project-approval',
    correlationId: '74000000-0000-4000-8000-000000000003',
  });
  await controlPlane.verification.runConfiguredFixture(
    created.view.projectId,
    '74000000-0000-4000-8000-000000000004',
  );
  await controlPlane.server.listen({ host: '127.0.0.1', port: 0 });
  return {
    controlPlane,
    projectId: created.view.projectId,
    cookie,
    baseUrl: controlPlane.server.listeningOrigin,
  };
}

describe('project inspect CLI', () => {
  it('uses the authenticated Results contract for truthful summary and JSON export', async () => {
    const context = await fixture();
    try {
      const summary = await runProjectInspect([context.projectId, '--base-url', context.baseUrl], {
        sessionCookie: context.cookie,
      });
      expect(summary).toContain(`Project ${context.projectId}: ACTIVE`);
      expect(summary).toContain('Verified: yes');
      expect(summary).toContain('Current execution');
      expect(summary).toContain('Recovery:');

      let exportedPath = '';
      let exportedContents = '';
      const output = await runProjectInspect(
        [
          context.projectId,
          '--base-url',
          context.baseUrl,
          '--format',
          'json',
          '--output',
          'result.json',
        ],
        {
          sessionCookie: context.cookie,
          exportFile: async (path, contents) => {
            exportedPath = path;
            exportedContents = contents;
          },
        },
      );
      expect(output).toBeNull();
      expect(exportedPath).toBe('result.json');
      expect(JSON.parse(exportedContents)).toMatchObject({
        projectId: context.projectId,
        verified: true,
      });
    } finally {
      await context.controlPlane.server.close();
    }
  });

  it('rejects incomplete or widened Results responses using the shared strict contract', async () => {
    const context = await fixture();
    try {
      const response = await fetch(
        new URL(`/v1/projects/${context.projectId}/results`, context.baseUrl),
        { headers: { cookie: context.cookie } },
      );
      const valid = (await response.json()) as Record<string, unknown>;
      const incomplete = structuredClone(valid) as {
        executions: Array<Record<string, unknown>>;
      };
      delete incomplete.executions[0]?.routeDecisionId;
      const missingEndedAt = structuredClone(valid) as {
        executions: Array<Record<string, unknown>>;
      };
      delete missingEndedAt.executions[0]?.endedAt;
      const respondWith = (body: unknown) =>
        (async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch;

      await expect(
        runProjectInspect([context.projectId, '--base-url', context.baseUrl], {
          sessionCookie: context.cookie,
          fetch: respondWith(incomplete),
        }),
      ).rejects.toThrow('Contract validation failed');
      await expect(
        runProjectInspect([context.projectId, '--base-url', context.baseUrl], {
          sessionCookie: context.cookie,
          fetch: respondWith(missingEndedAt),
        }),
      ).rejects.toThrow('Contract validation failed');
      await expect(
        runProjectInspect([context.projectId, '--base-url', context.baseUrl], {
          sessionCookie: context.cookie,
          fetch: respondWith({ ...valid, unexpectedField: true }),
        }),
      ).rejects.toThrow('Contract validation failed');

      const originalDirectory = process.cwd();
      const externalDirectory = await mkdtemp(join(tmpdir(), 'moonshift-cli-cwd-'));
      try {
        process.chdir(externalDirectory);
        createPlanningValidators().resultView.assert(valid);
        await expect(
          runProjectInspect([context.projectId, '--base-url', context.baseUrl], {
            sessionCookie: context.cookie,
            fetch: respondWith(valid),
          }),
        ).resolves.toContain(`Project ${context.projectId}`);
      } finally {
        process.chdir(originalDirectory);
        await rm(externalDirectory, { recursive: true, force: true });
      }
    } finally {
      await context.controlPlane.server.close();
    }
  });

  it('requires loopback supervisor access without exposing a cookie argument', async () => {
    await expect(
      runProjectInspect([
        '74000000-0000-4000-8000-000000000010',
        '--base-url',
        'https://moonshift.example',
      ]),
    ).rejects.toThrow('loopback-only');
    await expect(
      runProjectInspect([
        '74000000-0000-4000-8000-000000000010',
        '--base-url',
        'http://127.0.0.1:4310',
        '--cookie',
        'secret',
      ]),
    ).rejects.toThrow('Unknown or incomplete');
  });
});
