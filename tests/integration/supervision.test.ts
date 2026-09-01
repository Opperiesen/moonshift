import { X509Certificate } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPostgresControlPlane,
  SupervisionService,
  type ApprovedEffectExecutor,
  type MutateProjectRecordInput,
  type ProjectRepository,
} from '../../apps/control-plane/src/index.js';
import {
  AuthenticatedFixtureRunnerClient,
  DEFAULT_FIXTURE_CAPACITY,
  FixtureRunnerJournal,
  FixtureRunnerServer,
} from '../../apps/runner/src/index.js';
import { runMigrations } from '../../packages/persistence/src/index.js';
import {
  createDeterministicUuid,
  createFixtureCertificateAuthority,
  createFixtureLeafCertificate,
  FIXTURE_CERTIFICATE_NOT_AFTER,
  FIXTURE_CERTIFICATE_NOT_BEFORE,
} from '../../packages/test-fixtures/src/index.js';

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

const runnerInstanceId = '63000000-0000-4000-8000-000000000001';
const runnerId = '63000000-0000-4000-8000-000000000002';
const runnerClientSerial = '6301';

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type RunnerCertificates = {
  readonly ca: Buffer;
  readonly serverCert: Buffer;
  readonly serverKey: Buffer;
  readonly clientCert: Buffer;
  readonly clientKey: Buffer;
};

async function createRunnerCertificates(root: string): Promise<RunnerCertificates> {
  await createFixtureCertificateAuthority({
    directory: root,
    prefix: 'ca',
    subject: '/CN=Moonshift US2 Fixture CA',
    serial: '0x6300',
  });
  const leaf = async (
    prefix: string,
    serial: string,
    extendedKeyUsage: 'serverAuth' | 'clientAuth',
    subjectAlternativeName: string,
  ) => {
    await createFixtureLeafCertificate({
      directory: root,
      prefix,
      certificateAuthorityPrefix: 'ca',
      subject: `/CN=${prefix}`,
      serial,
      extensions: `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${extendedKeyUsage}\nsubjectAltName=${subjectAlternativeName}`,
    });
  };
  await leaf('server', '0x6302', 'serverAuth', `IP:127.0.0.1,URI:urn:moonshift:runner:${runnerId}`);
  await leaf(
    'client',
    `0x${runnerClientSerial}`,
    'clientAuth',
    `URI:urn:moonshift:instance:${runnerInstanceId}`,
  );
  return {
    ca: await readFile(join(root, 'ca.crt')),
    serverCert: await readFile(join(root, 'server.crt')),
    serverKey: await readFile(join(root, 'server.key')),
    clientCert: await readFile(join(root, 'client.crt')),
    clientKey: await readFile(join(root, 'client.key')),
  };
}

function expectDeterministicCertificateValidity(certificate: Buffer): void {
  const parsed = new X509Certificate(certificate);
  expect(parsed.validFromDate.toISOString()).toBe(FIXTURE_CERTIFICATE_NOT_BEFORE);
  expect(parsed.validToDate.toISOString()).toBe(FIXTURE_CERTIFICATE_NOT_AFTER);
}

describe.sequential('PostgreSQL supervised sensitive-work journey', () => {
  const supervisorId = '62000000-0000-4000-8000-000000000001';
  let embedded: EmbeddedPostgres;
  let pool: Pool;
  let dataDirectory: string;
  let runnerDirectory: string;
  let effectStateDirectory: string;
  let certificates: RunnerCertificates;
  let runner: FixtureRunnerServer;
  let effects: AuthenticatedFixtureRunnerClient;
  let runnerNow: () => Date;
  let runnerClientNow: () => Date;

  beforeAll(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), 'moonshift-us2-postgres-'));
    runnerDirectory = await mkdtemp(join(tmpdir(), 'moonshift-us2-runner-'));
    certificates = await createRunnerCertificates(runnerDirectory);
    expectDeterministicCertificateValidity(certificates.ca);
    expectDeterministicCertificateValidity(certificates.serverCert);
    const port = await unusedLoopbackPort();
    const user = 'moonshift_us2';
    const databasePassword = ['fixture', 'postgres', 'us2'].join('-');
    const localCredentials = { user, ['pass' + 'word']: databasePassword } as {
      user: string;
      password: string;
    };
    embedded = new EmbeddedPostgres({
      databaseDir: dataDirectory,
      port,
      ...localCredentials,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=20'],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    pool = new Pool({ host: '127.0.0.1', port, database: 'postgres', max: 8, ...localCredentials });
    await runMigrations(pool);
  }, 120_000);

  beforeEach(async () => {
    await runner?.close();
    await pool.query(`TRUNCATE TABLE project_events, project_snapshots, idempotency_records,
      backend_event_projections, projection_checkpoints, leases, queue_items,
      outbox_events, audit_events, aggregates RESTART IDENTITY CASCADE`);
    effectStateDirectory = await mkdtemp(join(runnerDirectory, 'case-'));
    runnerNow = () => new Date();
    runnerClientNow = () => new Date();
    runner = new FixtureRunnerServer({
      instanceId: runnerInstanceId,
      runnerId,
      stateDirectory: effectStateDirectory,
      tls: {
        ca: certificates.ca,
        cert: certificates.serverCert,
        key: certificates.serverKey,
      },
      controlPlaneEnrollments: [{ serialNumber: runnerClientSerial, instanceId: runnerInstanceId }],
      now: () => runnerNow(),
      capacity: {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: {
          cpu: true,
          memory: true,
          process: true,
          disk: true,
          time: true,
          network: true,
          gpu: true,
        },
      },
    });
    const endpoint = await runner.listen();
    effects = new AuthenticatedFixtureRunnerClient({
      instanceId: runnerInstanceId,
      runnerId,
      ...endpoint,
      tls: {
        ca: certificates.ca,
        cert: certificates.clientCert,
        key: certificates.clientKey,
      },
      now: () => runnerClientNow(),
    });
  });

  afterAll(async () => {
    await runner?.close();
    await pool?.end();
    await embedded?.stop();
    if (dataDirectory !== undefined) await rm(dataDirectory, { recursive: true, force: true });
    if (runnerDirectory !== undefined) await rm(runnerDirectory, { recursive: true, force: true });
  }, 120_000);

  function fixture(
    seed: string,
    effectExecutor: ApprovedEffectExecutor = effects,
    now: () => Date = () => new Date(),
  ) {
    return createPostgresControlPlane({
      pool,
      bootstrapSecret: 'p'.repeat(48),
      origin: 'http://127.0.0.1:4173',
      supervisorId,
      expectedRevision: '857f0f9b02210000000000000000000000000000',
      now,
      nextId: createDeterministicUuid(seed),
      effectExecutor,
      runnerId,
    });
  }

  function authorityReference(
    projection: Awaited<ReturnType<ReturnType<typeof fixture>['supervision']['getProjection']>>,
    effect: { readonly effectId: string; readonly actionDigest: `sha256:${string}` },
  ) {
    return {
      messageId: randomUUID(),
      correlationId: randomUUID(),
      effectId: effect.effectId,
      actionDigest: effect.actionDigest,
      executionId: projection.authority.executionId,
      leaseId: projection.authority.runnerLeaseId,
      fencingToken: projection.authority.fencingToken,
    };
  }

  async function submit(controlPlane: ReturnType<typeof fixture>, suffix: string) {
    return controlPlane.service.submitObjective({
      actorId: supervisorId,
      idempotencyKey: `us2-objective-${suffix}`,
      correlationId: `62000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
      objective: 'Apply one approval-gated deterministic fixture marker',
      fixtureScenario: 'PASS',
    });
  }

  async function seedEvaluatingVerification(
    controlPlane: ReturnType<typeof fixture>,
    projectId: string,
  ): Promise<void> {
    await controlPlane.repository.mutate({
      scope: `test-verification-seed:${projectId}`,
      idempotencyKey: randomUUID(),
      requestHash: `sha256:${'1'.repeat(64)}`,
      projectId,
      mutate: async (record) => ({
        record: Object.freeze({
          ...record,
          view: Object.freeze({
            ...record.view,
            version: record.view.version + 1,
            tasks: Object.freeze(
              record.view.tasks.map((task, index) =>
                index === 0 ? Object.freeze({ ...task, state: 'VERIFYING' as const }) : task,
              ),
            ),
          }),
          supervision: Object.freeze({
            ...record.supervision,
            verification: Object.freeze({ state: 'EVALUATING' as const }),
          }),
        }),
        response: { seeded: true },
      }),
    });
  }

  async function commitTestCompletion(
    controlPlane: ReturnType<typeof fixture>,
    projectId: string,
    expectedVersion: number,
  ): Promise<void> {
    await controlPlane.repository.mutate({
      scope: `test-completion-race:${projectId}`,
      idempotencyKey: randomUUID(),
      requestHash: `sha256:${'2'.repeat(64)}`,
      projectId,
      mutate: async (record) => {
        if (record.view.version !== expectedVersion || record.view.status !== 'ACTIVE') {
          throw new Error('TEST_COMPLETION_VERSION_CONFLICT');
        }
        return {
          record: Object.freeze({
            ...record,
            view: Object.freeze({
              ...record.view,
              status: 'COMPLETED' as const,
              version: record.view.version + 1,
            }),
          }),
          response: { completed: true },
        };
      },
    });
  }

  async function waitForEffectState(
    controlPlane: ReturnType<typeof fixture>,
    projectId: string,
    state: string,
  ) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const projection = await controlPlane.supervision.getProjection(projectId);
      if (projection.effects.some((effect) => effect.state === state)) return projection;
      if (Date.now() >= deadline) throw new Error(`Effect did not reach ${state}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  it('persists intent before effect, applies an approved digest at most once, and reconstructs audit state', async () => {
    const controlPlane = fixture('us2-approval');
    const created = await submit(controlPlane, '10');
    const projection = await controlPlane.supervision.getProjection(created.view.projectId);
    const approval = projection.approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    const before = projection.effects[0];
    expect(before).toMatchObject({ state: 'REQUESTED', actionDigest: approval.actionDigest });
    if (before === undefined) throw new Error('Expected effect');
    await expect(effects.lookup(authorityReference(projection, before))).resolves.toMatchObject({
      outcome: 'NOT_APPLIED',
    });

    const approved = await controlPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Exact fixture action reviewed',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-approval-decision-10',
      correlationId: '62000000-0000-4000-8000-000000000011',
    });
    expect(approved.approval.state).toBe('APPROVED');
    const appliedProjection = await controlPlane.supervision.getProjection(created.view.projectId);
    await expect(
      effects.lookup(authorityReference(appliedProjection, before)),
    ).resolves.toMatchObject({
      outcome: 'APPLIED',
    });
    await expect(
      effects.lookup({
        ...authorityReference(appliedProjection, before),
        fencingToken: appliedProjection.authority.fencingToken + 1,
      }),
    ).resolves.toMatchObject({ outcome: 'INDETERMINATE' });

    const replayed = await controlPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Exact fixture action reviewed',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-approval-decision-10',
      correlationId: '62000000-0000-4000-8000-000000000011',
    });
    expect(replayed).toEqual(approved);

    const durable = await controlPlane.supervision.getProjection(created.view.projectId);
    expect(durable.effects).toHaveLength(1);
    expect(durable.effects[0]).toMatchObject({ state: 'APPLIED' });
    expect(runner.effectLedger.size).toBe(1);
    expect(
      new FixtureRunnerJournal(effectStateDirectory).effects.find(
        ({ effectId }) => effectId === before.effectId,
      ),
    ).toMatchObject({ effectId: before.effectId, actionDigest: approval.actionDigest });
    expect(durable.audit.filter(({ action }) => action === 'approval.decided')).toHaveLength(1);
    expect(durable.audit.filter(({ action }) => action === 'effect.result')).toHaveLength(1);
    const restarted = fixture('us2-restart');
    await expect(restarted.supervision.getProjection(created.view.projectId)).resolves.toEqual(
      durable,
    );
    await controlPlane.server.close();
    await restarted.server.close();
  });

  it('reconciles a runner-applied effect after result persistence fails without reexecution', async () => {
    const controlPlane = fixture('us2-result-crash-base');
    const created = await submit(controlPlane, '11');
    const initial = await controlPlane.supervision.getProjection(created.view.projectId);
    const approval = initial.approvals[0];
    const effect = initial.effects[0];
    if (approval === undefined || effect === undefined) throw new Error('Expected approval effect');

    let executeCalls = 0;
    let lookupCalls = 0;
    let lookupAuthority: Parameters<ApprovedEffectExecutor['lookup']>[0] | undefined;
    const observedEffects: ApprovedEffectExecutor = {
      execute: async (input) => {
        executeCalls += 1;
        return effects.execute(input);
      },
      revoke: (input) => effects.revoke(input),
      lookup: (input) => {
        lookupCalls += 1;
        lookupAuthority = input;
        return effects.lookup(input);
      },
    };
    let failResultPersistence = true;
    const crashRepository: ProjectRepository = {
      create: (input) => controlPlane.repository.create(input),
      authorityNow: () => controlPlane.repository.authorityNow(),
      get: (projectId) => controlPlane.repository.get(projectId),
      listEvents: (projectId, afterSequence) =>
        controlPlane.repository.listEvents(projectId, afterSequence),
      expireEventsBefore: (projectId, sequence) =>
        controlPlane.repository.expireEventsBefore(projectId, sequence),
      assertVersion: (projectId, expectedVersion) =>
        controlPlane.repository.assertVersion(projectId, expectedVersion),
      mutate: async <T>(input: MutateProjectRecordInput<T>) => {
        if (failResultPersistence && input.scope === `effect-result:${created.view.projectId}`) {
          failResultPersistence = false;
          throw new Error('simulated control-plane loss before effect-result persistence');
        }
        return controlPlane.repository.mutate(input);
      },
    };
    const crashingSupervision = new SupervisionService({
      repository: crashRepository,
      effectExecutor: observedEffects,
      nextId: createDeterministicUuid('us2-result-crash-first'),
      expectedRevision: '857f0f9b02210000000000000000000000000000',
      systemId: randomUUID(),
      runnerId,
    });
    const command = {
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE' as const,
      actionDigest: approval.actionDigest,
      reason: 'Recover the exact approved effect after a durable-boundary interruption',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-result-crash-decision-11',
      correlationId: '62000000-0000-4000-8000-000000000011',
    };

    await expect(crashingSupervision.decideApproval(command)).rejects.toThrow(
      'simulated control-plane loss',
    );
    const interrupted = await controlPlane.supervision.getProjection(created.view.projectId);
    expect(interrupted.effects[0]).toMatchObject({ state: 'EXECUTING' });
    expect(interrupted.budget).toMatchObject({
      consumedInvocations: 0,
      consumedMonetaryMicros: 0,
    });
    expect(runner.effectLedger.size).toBe(1);
    expect(executeCalls).toBe(1);

    const recoveredSupervision = new SupervisionService({
      repository: controlPlane.repository,
      effectExecutor: observedEffects,
      nextId: createDeterministicUuid('us2-result-crash-restart'),
      expectedRevision: '857f0f9b02210000000000000000000000000000',
      systemId: randomUUID(),
      runnerId,
    });
    await expect(recoveredSupervision.decideApproval(command)).resolves.toMatchObject({
      approval: { approvalId: approval.approvalId, state: 'APPROVED' },
    });

    const recovered = await recoveredSupervision.getProjection(created.view.projectId);
    expect(executeCalls).toBe(1);
    expect(lookupCalls).toBe(1);
    expect(lookupAuthority).toMatchObject({
      effectId: effect.effectId,
      actionDigest: effect.actionDigest,
      executionId: interrupted.authority.executionId,
      leaseId: interrupted.authority.runnerLeaseId,
      fencingToken: interrupted.authority.fencingToken,
    });
    expect(recovered.effects[0]).toMatchObject({
      state: 'APPLIED',
      reconciliationOutcome: 'GROUND_TRUTH_APPLIED',
      groundTruthDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(recovered.budget).toMatchObject({
      consumedInvocations: 1,
      consumedMonetaryMicros: 100,
    });
    expect(recovered.audit.filter(({ action }) => action === 'approval.decided')).toHaveLength(1);
    expect(recovered.audit.filter(({ action }) => action === 'effect.attempt')).toHaveLength(1);
    expect(recovered.audit.filter(({ action }) => action === 'effect.result')).toHaveLength(1);
    expect(runner.effectLedger.size).toBe(1);
    await controlPlane.server.close();
  });

  it('resumes an interrupted control reconciliation on exact idempotent replay', async () => {
    const effectReturned = deferred();
    const effectApplied = deferred();
    let executeCalls = 0;
    const revokeInputs: Array<Parameters<ApprovedEffectExecutor['revoke']>[0]> = [];
    const observedEffects: ApprovedEffectExecutor = {
      execute: async (input) => {
        executeCalls += 1;
        const result = await effects.execute(input);
        effectApplied.resolve();
        await effectReturned.promise;
        return result;
      },
      revoke: async (input) => {
        revokeInputs.push(input);
        return effects.revoke(input);
      },
      lookup: (input) => effects.lookup(input),
    };
    const approvingPlane = fixture('us2-control-crash-approval', observedEffects);
    const created = await submit(approvingPlane, '12');
    const initial = await approvingPlane.supervision.getProjection(created.view.projectId);
    const approval = initial.approvals[0];
    const effect = initial.effects[0];
    if (approval === undefined || effect === undefined) throw new Error('Expected approval effect');
    const decision = approvingPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Hold the applied fixture result across a control-plane interruption',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-control-crash-approval-12',
      correlationId: '62000000-0000-4000-8000-000000000012',
    });
    await effectApplied.promise;
    const executing = await waitForEffectState(approvingPlane, created.view.projectId, 'EXECUTING');

    let failControlReconciliation = true;
    const crashRepository: ProjectRepository = {
      create: (input) => approvingPlane.repository.create(input),
      authorityNow: () => approvingPlane.repository.authorityNow(),
      get: (projectId) => approvingPlane.repository.get(projectId),
      listEvents: (projectId, afterSequence) =>
        approvingPlane.repository.listEvents(projectId, afterSequence),
      expireEventsBefore: (projectId, sequence) =>
        approvingPlane.repository.expireEventsBefore(projectId, sequence),
      assertVersion: (projectId, expectedVersion) =>
        approvingPlane.repository.assertVersion(projectId, expectedVersion),
      mutate: async <T>(input: MutateProjectRecordInput<T>) => {
        if (
          failControlReconciliation &&
          input.scope === `project-control-reconciliation:${created.view.projectId}`
        ) {
          failControlReconciliation = false;
          throw new Error('simulated control-plane loss before control reconciliation persistence');
        }
        return approvingPlane.repository.mutate(input);
      },
    };
    const controlCommand = {
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'STOP' as const,
      reason: 'Recover the exact stop after its durable intent was committed',
      expectedVersion: executing.projectVersion,
      idempotencyKey: 'us2-control-crash-stop-12',
      correlationId: '62000000-0000-4000-8000-000000000013',
    };
    const crashingControl = new SupervisionService({
      repository: crashRepository,
      effectExecutor: observedEffects,
      nextId: createDeterministicUuid('us2-control-crash-first'),
      expectedRevision: '857f0f9b02210000000000000000000000000000',
      systemId: randomUUID(),
      runnerId,
    });

    await expect(crashingControl.controlProject(controlCommand)).rejects.toThrow(
      'simulated control-plane loss',
    );
    const interrupted = await approvingPlane.supervision.getProjection(created.view.projectId);
    expect(interrupted).toMatchObject({
      projectState: 'STOPPING',
      authority: {
        executionState: 'STOPPING',
        capabilityLeaseState: 'REVOKED',
        runnerLeaseState: 'REVOKED',
      },
      effects: [{ state: 'EXECUTING' }],
    });
    expect(revokeInputs).toHaveLength(1);

    const recoveredControl = new SupervisionService({
      repository: approvingPlane.repository,
      effectExecutor: observedEffects,
      nextId: createDeterministicUuid('us2-control-crash-restart'),
      expectedRevision: '857f0f9b02210000000000000000000000000000',
      systemId: randomUUID(),
      runnerId,
    });
    await expect(recoveredControl.controlProject(controlCommand)).resolves.toMatchObject({
      projectId: created.view.projectId,
      status: 'ACCEPTED',
    });
    const recovered = await recoveredControl.getProjection(created.view.projectId);
    expect(executeCalls).toBe(1);
    expect(revokeInputs).toHaveLength(2);
    expect(revokeInputs[1]).toMatchObject({
      effectId: effect.effectId,
      actionDigest: effect.actionDigest,
      executionId: interrupted.authority.executionId,
      leaseId: interrupted.authority.runnerLeaseId,
      fencingToken: interrupted.authority.fencingToken,
    });
    expect(recovered).toMatchObject({
      projectState: 'STOPPED',
      authority: { executionState: 'STOPPED' },
      effects: [
        {
          state: 'APPLIED',
          reconciliationOutcome: 'GROUND_TRUTH_APPLIED',
        },
      ],
      budget: { consumedInvocations: 1, consumedMonetaryMicros: 100 },
    });
    expect(recovered.audit.filter(({ action }) => action === 'control.stop')).toHaveLength(1);
    expect(
      recovered.audit.filter(({ action }) => action === 'control.stop.completed'),
    ).toHaveLength(1);
    expect(recovered.audit.filter(({ action }) => action === 'effect.result')).toHaveLength(1);
    expect(runner.effectLedger.size).toBe(1);

    effectReturned.resolve();
    await decision;
    expect(executeCalls).toBe(1);
    await approvingPlane.server.close();
  });

  it('reserves the single runner slot across projects before a second effect crosses the boundary', async () => {
    const firstEffectReturned = deferred();
    const firstEffectApplied = deferred();
    let executeCalls = 0;
    const delayedFirstEffect: ApprovedEffectExecutor = {
      execute: async (input) => {
        executeCalls += 1;
        const result = await effects.execute(input);
        if (executeCalls === 1) {
          firstEffectApplied.resolve();
          await firstEffectReturned.promise;
        }
        return result;
      },
      revoke: (input) => effects.revoke(input),
      lookup: (input) => effects.lookup(input),
    };
    const firstPlane = fixture('us2-capacity-first', delayedFirstEffect);
    const secondPlane = fixture('us2-capacity-second', delayedFirstEffect);
    const firstProject = await submit(firstPlane, '14');
    const secondProject = await submit(secondPlane, '15');
    const firstApproval = (await firstPlane.supervision.getProjection(firstProject.view.projectId))
      .approvals[0];
    const secondApproval = (
      await secondPlane.supervision.getProjection(secondProject.view.projectId)
    ).approvals[0];
    if (firstApproval === undefined || secondApproval === undefined)
      throw new Error('Expected both approvals');
    const firstCommand = {
      actorId: supervisorId,
      projectId: firstProject.view.projectId,
      approvalId: firstApproval.approvalId,
      decision: 'APPROVE' as const,
      actionDigest: firstApproval.actionDigest,
      reason: 'Reserve the single runner slot for the first effect',
      expectedVersion: firstApproval.version,
      idempotencyKey: 'us2-capacity-approval-14',
      correlationId: '62000000-0000-4000-8000-000000000014',
    };
    const secondCommand = {
      actorId: supervisorId,
      projectId: secondProject.view.projectId,
      approvalId: secondApproval.approvalId,
      decision: 'APPROVE' as const,
      actionDigest: secondApproval.actionDigest,
      reason: 'Queue behind the first durable runner reservation',
      expectedVersion: secondApproval.version,
      idempotencyKey: 'us2-capacity-approval-15',
      correlationId: '62000000-0000-4000-8000-000000000015',
    };

    const firstDecision = firstPlane.supervision.decideApproval(firstCommand);
    await firstEffectApplied.promise;
    await expect(firstPlane.service.getProject(firstProject.view.projectId)).resolves.toMatchObject(
      {
        capacity: { activeRunnerJobs: 1, runnerJobLimit: 1 },
      },
    );
    await expect(secondPlane.supervision.decideApproval(secondCommand)).resolves.toMatchObject({
      approval: { state: 'APPROVED' },
    });

    const waiting = await secondPlane.supervision.getProjection(secondProject.view.projectId);
    expect(executeCalls).toBe(1);
    expect(waiting).toMatchObject({
      approvals: [{ state: 'APPROVED', usable: true }],
      effects: [{ state: 'REQUESTED' }],
      blockedReasons: ['Waiting for runner capacity'],
    });
    expect(waiting.effects.some(({ state }) => state === 'UNKNOWN')).toBe(false);
    const waitingRecord = await secondPlane.repository.get(secondProject.view.projectId);
    expect(waitingRecord?.view.tasks[0]?.state).toBe('WAITING_FOR_CAPACITY');
    expect(waitingRecord?.view.presences.at(-1)).toMatchObject({
      state: 'WAITING_FOR_RUNNER',
      activity: 'Waiting for runner capacity',
    });

    firstEffectReturned.resolve();
    await firstDecision;
    await expect(firstPlane.service.getProject(firstProject.view.projectId)).resolves.toMatchObject(
      {
        capacity: { activeRunnerJobs: 0, runnerJobLimit: 1 },
      },
    );
    await expect(secondPlane.supervision.decideApproval(secondCommand)).resolves.toMatchObject({
      approval: { state: 'APPROVED' },
    });
    const firstApplied = await firstPlane.supervision.getProjection(firstProject.view.projectId);
    const secondApplied = await secondPlane.supervision.getProjection(secondProject.view.projectId);
    expect(firstApplied.effects[0]).toMatchObject({ state: 'APPLIED' });
    expect(secondApplied.effects[0]).toMatchObject({ state: 'APPLIED' });
    expect(secondApplied.blockedReasons).toEqual([]);
    expect(executeCalls).toBe(2);
    expect(runner.effectLedger.size).toBe(2);
    await firstPlane.server.close();
    await secondPlane.server.close();
  });

  it('returns one canonical approval decision while only one instance crosses the effect boundary', async () => {
    const effectReturned = deferred();
    const effectApplied = deferred();
    let executeCalls = 0;
    const delayedEffects: ApprovedEffectExecutor = {
      execute: async (input) => {
        executeCalls += 1;
        const result = await effects.execute(input);
        effectApplied.resolve();
        await effectReturned.promise;
        return result;
      },
      revoke: (input) => effects.revoke(input),
      lookup: (input) => effects.lookup(input),
    };
    const firstPlane = fixture('us2-duplicate-first', delayedEffects);
    const secondPlane = fixture('us2-duplicate-second', delayedEffects);
    const created = await submit(firstPlane, '12');
    const approval = (await firstPlane.supervision.getProjection(created.view.projectId))
      .approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    const command = {
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE' as const,
      actionDigest: approval.actionDigest,
      reason: 'One exact decision across two control-plane instances',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-duplicate-approval-12',
      correlationId: '62000000-0000-4000-8000-000000000012',
    };
    const firstDecision = firstPlane.supervision.decideApproval(command);
    await effectApplied.promise;
    const duplicateDecision = await secondPlane.supervision.decideApproval(command);
    effectReturned.resolve();
    const originalDecision = await firstDecision;

    expect(duplicateDecision).toEqual(originalDecision);
    expect(executeCalls).toBe(1);
    const projection = await secondPlane.supervision.getProjection(created.view.projectId);
    expect(projection.approvals[0]).toMatchObject({ state: 'APPROVED', usable: false });
    expect(projection.effects[0]).toMatchObject({ state: 'APPLIED' });
    expect(projection.audit.filter(({ action }) => action === 'approval.decided')).toHaveLength(1);
    expect(projection.audit.filter(({ action }) => action === 'effect.attempt')).toHaveLength(1);
    expect(projection.audit.filter(({ action }) => action === 'effect.result')).toHaveLength(1);
    expect(runner.effectLedger.size).toBe(1);
    await firstPlane.server.close();
    await secondPlane.server.close();
  });

  it('serializes concurrent decisions and denies tampered or expired approval authority', async () => {
    const controlPlane = fixture('us2-integrity');
    const tamperProject = await submit(controlPlane, '20');
    const tamperApproval = (
      await controlPlane.supervision.getProjection(tamperProject.view.projectId)
    ).approvals[0];
    if (tamperApproval === undefined) throw new Error('Expected approval');
    await expect(
      controlPlane.supervision.decideApproval({
        actorId: supervisorId,
        projectId: tamperProject.view.projectId,
        approvalId: tamperApproval.approvalId,
        decision: 'APPROVE',
        actionDigest: `sha256:${'f'.repeat(64)}`,
        reason: 'Tampered action',
        expectedVersion: 1,
        idempotencyKey: 'us2-tamper-decision-20',
        correlationId: '62000000-0000-4000-8000-000000000021',
      }),
    ).rejects.toMatchObject({ code: 'ACTION_DIGEST_MISMATCH' });
    expect(runner.effectLedger.size).toBe(0);

    const raceProject = await submit(controlPlane, '22');
    const raceApproval = (await controlPlane.supervision.getProjection(raceProject.view.projectId))
      .approvals[0];
    if (raceApproval === undefined) throw new Error('Expected approval');
    const decide = (decision: 'APPROVE' | 'REJECT', suffix: string) =>
      controlPlane.supervision.decideApproval({
        actorId: supervisorId,
        projectId: raceProject.view.projectId,
        approvalId: raceApproval.approvalId,
        decision,
        actionDigest: raceApproval.actionDigest,
        reason: `${decision} raced`,
        expectedVersion: 1,
        idempotencyKey: `us2-race-decision-${suffix}`,
        correlationId: `62000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
      });
    const race = await Promise.allSettled([decide('APPROVE', '23'), decide('REJECT', '24')]);
    expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(race.filter(({ status }) => status === 'rejected')).toHaveLength(1);

    const expiryProject = await submit(controlPlane, '25');
    const expiryApproval = (
      await controlPlane.supervision.getProjection(expiryProject.view.projectId)
    ).approvals[0];
    if (expiryApproval === undefined) throw new Error('Expected approval');
    await pool.query(
      `UPDATE project_snapshots
       SET record = jsonb_set(record, '{supervision,approvals,0,expiresAt}', '"2000-01-01T00:00:00.000Z"')
       WHERE project_id = $1`,
      [expiryProject.view.projectId],
    );
    await expect(
      controlPlane.supervision.decideApproval({
        actorId: supervisorId,
        projectId: expiryProject.view.projectId,
        approvalId: expiryApproval.approvalId,
        decision: 'APPROVE',
        actionDigest: expiryApproval.actionDigest,
        reason: 'Too late',
        expectedVersion: 1,
        idempotencyKey: 'us2-expired-decision-25',
        correlationId: '62000000-0000-4000-8000-000000000026',
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
    expect(
      (await controlPlane.supervision.getProjection(expiryProject.view.projectId)).approvals[0],
    ).toMatchObject({ state: 'EXPIRED', version: 2 });
    await controlPlane.server.close();
  });

  it('projects approval expiry from PostgreSQL authority despite a lagging host clock', async () => {
    const laggingHost = fixture(
      'us2-expiry-authority',
      effects,
      () => new Date('1999-01-01T00:00:00.000Z'),
    );
    const created = await submit(laggingHost, '26');
    const initial = await laggingHost.repository.get(created.view.projectId);
    if (initial === null || initial.events[0] === undefined)
      throw new Error('Expected durable initial supervision events');
    const initialOccurredAt = initial.events[0].occurredAt;
    expect(Date.parse(initialOccurredAt)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00.000Z'));
    expect(new Set(initial.events.map(({ occurredAt }) => occurredAt))).toEqual(
      new Set([initialOccurredAt]),
    );
    expect(initial.supervision.audit.length).toBeGreaterThan(0);
    expect(
      initial.supervision.audit.every(({ occurredAt }) => occurredAt === initialOccurredAt),
    ).toBe(true);
    expect(initial.view.presences.every(({ updatedAt }) => updatedAt === initialOccurredAt)).toBe(
      true,
    );
    await pool.query(
      `UPDATE project_snapshots
       SET record = jsonb_set(record, '{supervision,approvals,0,expiresAt}', '"2000-01-01T00:00:00.000Z"')
       WHERE project_id = $1`,
      [created.view.projectId],
    );

    const expired = await laggingHost.supervision.getProjection(created.view.projectId);
    expect(expired).toMatchObject({
      projectState: 'BLOCKED',
      approvals: [{ state: 'EXPIRED', usable: false, version: 2 }],
      effects: [{ state: 'FAILED', reconciliationOutcome: 'NOT_APPLIED:APPROVAL_EXPIRED' }],
      blockedReasons: ['Approval expired'],
    });
    expect(expired.audit.filter(({ action }) => action === 'approval.expired')).toHaveLength(1);
    expect(
      (await laggingHost.supervision.getProjection(created.view.projectId)).audit.filter(
        ({ action }) => action === 'approval.expired',
      ),
    ).toHaveLength(1);
    expect(runner.effectLedger.size).toBe(0);
    await laggingHost.server.close();
  });

  it('uses the PostgreSQL claim timestamp across skewed control-plane client and runner clocks', async () => {
    const farFuture = () => new Date('2099-01-01T00:00:00.000Z');
    runnerNow = farFuture;
    runnerClientNow = farFuture;
    const laggingControlPlane = fixture(
      'us2-effect-authority-clock',
      effects,
      () => new Date('1999-01-01T00:00:00.000Z'),
    );
    const created = await submit(laggingControlPlane, '29');
    const initial = await laggingControlPlane.supervision.getProjection(created.view.projectId);
    const approval = initial.approvals[0];
    const effect = initial.effects[0];
    if (approval === undefined || effect === undefined) throw new Error('Expected approval effect');

    await expect(
      laggingControlPlane.supervision.decideApproval({
        actorId: supervisorId,
        projectId: created.view.projectId,
        approvalId: approval.approvalId,
        decision: 'APPROVE',
        actionDigest: approval.actionDigest,
        reason: 'Database claim time remains authoritative across host clock skew',
        expectedVersion: approval.version,
        idempotencyKey: 'us2-effect-authority-clock-29',
        correlationId: '62000000-0000-4000-8000-000000000029',
      }),
    ).resolves.toMatchObject({ approval: { state: 'APPROVED' } });

    const applied = await laggingControlPlane.supervision.getProjection(created.view.projectId);
    expect(applied.effects[0]).toMatchObject({ state: 'APPLIED' });
    const durableLease = new FixtureRunnerJournal(effectStateDirectory).leaseOffers.find(
      ({ effectId }) => effectId === effect.effectId,
    );
    expect(durableLease).toMatchObject({
      effectId: effect.effectId,
      approvalExpiresAt: approval.expiresAt,
      consumed: true,
    });
    expect(Date.parse(durableLease?.authorizedAt ?? '')).toBeLessThan(
      Date.parse(approval.expiresAt),
    );
    expect(Date.parse(durableLease?.authorizedAt ?? '')).toBeLessThan(
      Date.parse(durableLease?.expiresAt ?? ''),
    );
    await laggingControlPlane.server.close();
  });

  it('durably fences STOP before a delayed runner lease offer can cross the effect boundary', async () => {
    const executeEntered = deferred();
    const executeReleased = deferred();
    const delayedOfferEffects: ApprovedEffectExecutor = {
      execute: async (input) => {
        executeEntered.resolve();
        await executeReleased.promise;
        return effects.execute(input);
      },
      revoke: (input) => effects.revoke(input),
      lookup: (input) => effects.lookup(input),
    };
    const approvingPlane = fixture('us2-pre-offer-approval', delayedOfferEffects);
    const stoppingPlane = fixture('us2-pre-offer-stop');
    const created = await submit(approvingPlane, '61');
    const approval = (await approvingPlane.supervision.getProjection(created.view.projectId))
      .approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    const decision = approvingPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Delay the offer after the durable effect claim',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-pre-offer-approval-61',
      correlationId: '62000000-0000-4000-8000-000000000061',
    });
    await executeEntered.promise;
    const executing = await waitForEffectState(stoppingPlane, created.view.projectId, 'EXECUTING');

    await stoppingPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'STOP',
      reason: 'Fence authority before the delayed runner offer arrives',
      expectedVersion: executing.projectVersion,
      idempotencyKey: 'us2-pre-offer-stop-61',
      correlationId: '62000000-0000-4000-8000-000000000062',
    });
    const preempted = new FixtureRunnerJournal(effectStateDirectory);
    expect(preempted.leaseOffers).toEqual([]);
    expect(preempted.revokedLeaseAuthorities).toEqual([
      {
        executionId: executing.authority.executionId,
        leaseId: executing.authority.runnerLeaseId,
        fencingToken: executing.authority.fencingToken,
      },
    ]);

    executeReleased.resolve();
    await decision;
    const stopped = await stoppingPlane.supervision.getProjection(created.view.projectId);
    expect(stopped).toMatchObject({
      projectState: 'STOPPED',
      authority: {
        executionState: 'STOPPED',
        capabilityLeaseState: 'REVOKED',
        runnerLeaseState: 'REVOKED',
      },
      effects: [{ state: 'FAILED', reconciliationOutcome: 'NOT_APPLIED:STOP' }],
    });
    expect(runner.effectLedger.size).toBe(0);
    const afterDelayedOffer = new FixtureRunnerJournal(effectStateDirectory);
    expect(afterDelayedOffer.effects).toEqual([]);
    expect(afterDelayedOffer.leaseOffers).toEqual([]);
    expect(afterDelayedOffer.revokedLeaseAuthorities).toHaveLength(1);
    await approvingPlane.server.close();
    await stoppingPlane.server.close();
  });

  it('revokes an authenticated runner effect in flight and reconciles UNKNOWN before stop', async () => {
    const effectReturned = deferred();
    const effectApplied = deferred();
    const approvingEffects: ApprovedEffectExecutor = {
      execute: async (input) => {
        const result = await effects.execute(input);
        effectApplied.resolve();
        await effectReturned.promise;
        return result;
      },
      revoke: (input) => effects.revoke(input),
      lookup: (input) => effects.lookup(input),
    };
    const approvingPlane = fixture('us2-inflight-approval', approvingEffects);
    const stoppingPlane = fixture('us2-inflight-stop');
    const created = await submit(approvingPlane, '27');
    const approval = (await approvingPlane.supervision.getProjection(created.view.projectId))
      .approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    const decision = approvingPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Start the bounded authenticated runner effect',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-inflight-approval-27',
      correlationId: '62000000-0000-4000-8000-000000000027',
    });
    await effectApplied.promise;
    const executing = await waitForEffectState(stoppingPlane, created.view.projectId, 'EXECUTING');
    const stopped = stoppingPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'STOP',
      reason: 'Fence and reconcile the in-flight fixture effect',
      expectedVersion: executing.projectVersion,
      idempotencyKey: 'us2-inflight-stop-27',
      correlationId: '62000000-0000-4000-8000-000000000028',
    });
    const [stopOutcome] = await Promise.allSettled([stopped]);
    effectReturned.resolve();
    const [decisionOutcome] = await Promise.allSettled([decision]);
    expect(stopOutcome).toMatchObject({ status: 'fulfilled' });
    expect(decisionOutcome).toMatchObject({ status: 'fulfilled' });
    const projection = await stoppingPlane.supervision.getProjection(created.view.projectId);
    expect(projection).toMatchObject({
      projectState: 'STOPPED',
      authority: {
        executionState: 'STOPPED',
        capabilityLeaseState: 'REVOKED',
        runnerLeaseState: 'REVOKED',
      },
    });
    expect(projection.effects[0]?.state).toMatch(/^(APPLIED|FAILED|RECONCILED)$/u);
    expect(projection.effects[0]?.state).not.toBe('UNKNOWN');
    expect(projection.effects[0]?.reconciliationOutcome).toMatch(
      /^(GROUND_TRUTH_APPLIED|GROUND_TRUTH_NOT_APPLIED|NOT_APPLIED:STOP)$/u,
    );
    const resultAudits = projection.audit.filter(({ action }) => action === 'effect.result');
    expect(resultAudits).toHaveLength(projection.effects[0]?.state === 'RECONCILED' ? 2 : 1);
    expect(new Set(resultAudits.map(({ auditEventId }) => auditEventId)).size).toBe(
      resultAudits.length,
    );
    expect(resultAudits.at(-1)?.outcome).toBe(projection.effects[0]?.state);

    const unknownProject = await submit(stoppingPlane, '29');
    await stoppingPlane.repository.mutate({
      scope: `test-unknown-effect:${unknownProject.view.projectId}`,
      idempotencyKey: randomUUID(),
      requestHash: `sha256:${'3'.repeat(64)}`,
      projectId: unknownProject.view.projectId,
      mutate: async (record) => ({
        record: Object.freeze({
          ...record,
          view: Object.freeze({
            ...record.view,
            status: 'BLOCKED' as const,
            version: record.view.version + 1,
          }),
          supervision: Object.freeze({
            ...record.supervision,
            effects: Object.freeze(
              record.supervision.effects.map((effect, index) =>
                index === 0
                  ? Object.freeze({
                      ...effect,
                      state: 'UNKNOWN' as const,
                      reconciliationOutcome: 'RECONCILIATION_REQUIRED',
                      version: effect.version + 1,
                    })
                  : effect,
              ),
            ),
          }),
        }),
        response: { seeded: true },
      }),
    });
    const unknown = await stoppingPlane.supervision.getProjection(unknownProject.view.projectId);
    await stoppingPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: unknownProject.view.projectId,
      command: 'STOP',
      reason: 'Require determinate ground truth before stopped',
      expectedVersion: unknown.projectVersion,
      idempotencyKey: 'us2-unknown-stop-29',
      correlationId: '62000000-0000-4000-8000-000000000029',
    });
    const reconciled = await stoppingPlane.supervision.getProjection(unknownProject.view.projectId);
    expect(reconciled.projectState).toBe('STOPPED');
    expect(reconciled.effects[0]).toMatchObject({
      state: 'RECONCILED',
      reconciliationOutcome: 'GROUND_TRUTH_NOT_APPLIED',
    });
    await approvingPlane.server.close();
    await stoppingPlane.server.close();
  });

  it('keeps PAUSING visible until authenticated runner ground truth is reconciled', async () => {
    const effectReturned = deferred();
    const effectApplied = deferred();
    const revokeEntered = deferred();
    const revokeReleased = deferred();
    let revokeCalls = 0;
    const approvingEffects: ApprovedEffectExecutor = {
      execute: async (input) => {
        const result = await effects.execute(input);
        effectApplied.resolve();
        await effectReturned.promise;
        return result;
      },
      revoke: (input) => effects.revoke(input),
      lookup: (input) => effects.lookup(input),
    };
    const pausingEffects: ApprovedEffectExecutor = {
      execute: (input) => effects.execute(input),
      revoke: async (input) => {
        revokeCalls += 1;
        revokeEntered.resolve();
        await revokeReleased.promise;
        return effects.revoke(input);
      },
      lookup: (input) => effects.lookup(input),
    };
    const approvingPlane = fixture('us2-inflight-pause-approval', approvingEffects);
    const pausingPlane = fixture('us2-inflight-pause-control', pausingEffects);
    const created = await submit(approvingPlane, '34');
    const approval = (await approvingPlane.supervision.getProjection(created.view.projectId))
      .approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    const decision = approvingPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Hold the durable result while pause fences authority',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-inflight-pause-approval-34',
      correlationId: '62000000-0000-4000-8000-000000000034',
    });
    await effectApplied.promise;
    const executing = await waitForEffectState(pausingPlane, created.view.projectId, 'EXECUTING');
    const pause = pausingPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'PAUSE',
      reason: 'Fence the runner before publishing PAUSED',
      expectedVersion: executing.projectVersion,
      idempotencyKey: 'us2-inflight-pause-control-34',
      correlationId: '62000000-0000-4000-8000-000000000035',
    });
    await revokeEntered.promise;
    const transitioning = await pausingPlane.repository.get(created.view.projectId);
    expect(transitioning).toMatchObject({
      view: { status: 'PAUSING' },
      supervision: {
        approvals: [{ state: 'APPROVED', usable: false }],
        authority: {
          executionState: 'CHECKPOINTING',
          capabilityLeaseState: 'SUSPENDED',
          runnerLeaseState: 'REVOKED',
        },
      },
    });
    revokeReleased.resolve();
    await pause;
    const paused = await pausingPlane.supervision.getProjection(created.view.projectId);
    expect(revokeCalls).toBe(1);
    expect(paused).toMatchObject({
      projectState: 'PAUSED',
      authority: {
        executionState: 'SUSPENDED',
        capabilityLeaseState: 'SUSPENDED',
        runnerLeaseState: 'REVOKED',
      },
    });
    expect(paused.effects[0]).toMatchObject({
      state: 'APPLIED',
      reconciliationOutcome: 'GROUND_TRUTH_APPLIED',
    });
    effectReturned.resolve();
    await decision;
    const afterResult = await pausingPlane.supervision.getProjection(created.view.projectId);
    expect(afterResult.projectState).toBe('PAUSED');
    expect(afterResult.audit.filter(({ action }) => action === 'effect.result')).toHaveLength(1);
    await approvingPlane.server.close();
    await pausingPlane.server.close();
  });

  it('preserves pause approvals, stales in-flight verification without promoting it, and resumes with fresh authority', async () => {
    const controlPlane = fixture('us2-pause');
    const created = await submit(controlPlane, '30');
    await seedEvaluatingVerification(controlPlane, created.view.projectId);
    const started = await controlPlane.service.getProject(created.view.projectId);
    if (started === null) throw new Error('Expected project');
    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'PAUSE',
      reason: 'Checkpoint for inspection',
      expectedVersion: started.version,
      idempotencyKey: 'us2-pause-control-30',
      correlationId: '62000000-0000-4000-8000-000000000032',
    });
    const paused = await controlPlane.supervision.getProjection(created.view.projectId);
    expect(paused.projectState).toBe('PAUSED');
    expect(paused.approvals[0]).toMatchObject({ state: 'REQUESTED', usable: false });
    expect(paused.verification).toEqual({ state: 'STALE' });
    expect(paused.authority.capabilityLeaseState).toBe('SUSPENDED');
    expect(paused.checkpoint).not.toBeNull();

    const pausedView = await controlPlane.service.getProject(created.view.projectId);
    if (pausedView === null) throw new Error('Expected project');
    expect(pausedView.tasks[0]?.state).toBe('VERIFYING');
    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'RESUME',
      reason: 'Continue under fresh authority',
      expectedVersion: pausedView.version,
      idempotencyKey: 'us2-resume-control-30',
      correlationId: '62000000-0000-4000-8000-000000000033',
    });
    const resumed = await controlPlane.supervision.getProjection(created.view.projectId);
    expect(resumed.projectState).toBe('ACTIVE');
    expect(resumed.approvals[0]).toMatchObject({ state: 'REQUESTED', usable: true });
    expect(resumed.authority.executionId).not.toBe(paused.authority.executionId);
    expect(resumed.authority.capabilityLeaseId).not.toBe(paused.authority.capabilityLeaseId);
    expect(resumed.authority.runnerLeaseId).not.toBe(paused.authority.runnerLeaseId);
    expect(resumed.verification).toEqual({ state: 'STALE' });
    await controlPlane.server.close();
  });

  it('serializes cross-instance resume capacity so only one final cognitive slot is claimed', async () => {
    const setupPlane = fixture('us2-capacity-setup');
    const first = await submit(setupPlane, '36');
    const second = await submit(setupPlane, '37');
    await submit(setupPlane, '38');
    for (const [project, suffix] of [
      [first, '36'],
      [second, '37'],
    ] as const) {
      await setupPlane.supervision.controlProject({
        actorId: supervisorId,
        projectId: project.view.projectId,
        command: 'PAUSE',
        reason: 'Release one cognitive slot for the capacity race',
        expectedVersion: project.view.version,
        idempotencyKey: `us2-capacity-pause-${suffix}`,
        correlationId: `62000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
      });
    }
    await submit(setupPlane, '39');

    const firstResumePlane = fixture('us2-capacity-resume-first');
    const secondResumePlane = fixture('us2-capacity-resume-second');
    const firstPaused = await firstResumePlane.supervision.getProjection(first.view.projectId);
    const secondPaused = await secondResumePlane.supervision.getProjection(second.view.projectId);
    const outcomes = await Promise.allSettled([
      firstResumePlane.supervision.controlProject({
        actorId: supervisorId,
        projectId: first.view.projectId,
        command: 'RESUME',
        reason: 'Claim the final cognitive slot atomically',
        expectedVersion: firstPaused.projectVersion,
        idempotencyKey: 'us2-capacity-resume-36',
        correlationId: '62000000-0000-4000-8000-000000000056',
      }),
      secondResumePlane.supervision.controlProject({
        actorId: supervisorId,
        projectId: second.view.projectId,
        command: 'RESUME',
        reason: 'Race for the same final cognitive slot',
        expectedVersion: secondPaused.projectVersion,
        idempotencyKey: 'us2-capacity-resume-37',
        correlationId: '62000000-0000-4000-8000-000000000057',
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'COGNITIVE_CAPACITY' },
    });
    const finalStates = await Promise.all([
      firstResumePlane.supervision.getProjection(first.view.projectId),
      secondResumePlane.supervision.getProjection(second.view.projectId),
    ]);
    expect(finalStates.map(({ projectState }) => projectState).sort()).toEqual([
      'ACTIVE',
      'PAUSED',
    ]);
    const capacity = await pool.query<{ active_cognitive_runs: number }>(`
      SELECT count(*) FILTER (
        WHERE record#>>'{supervision,authority,executionState}'
          IN ('STARTING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CHECKPOINTING')
      )::integer AS active_cognitive_runs
      FROM project_snapshots`);
    expect(capacity.rows[0]?.active_cognitive_runs).toBe(3);
    await setupPlane.server.close();
    await firstResumePlane.server.close();
    await secondResumePlane.server.close();
  });

  it('stops recoverably, cancels terminally, and serializes stop/cancel against completion', async () => {
    const controlPlane = fixture('us2-controls');
    const created = await submit(controlPlane, '40');
    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'STOP',
      reason: 'Revoke the current attempt',
      expectedVersion: created.view.version,
      idempotencyKey: 'us2-stop-control-40',
      correlationId: '62000000-0000-4000-8000-000000000041',
    });
    const stopped = await controlPlane.supervision.getProjection(created.view.projectId);
    expect(stopped.projectState).toBe('STOPPED');
    expect(stopped.approvals[0]).toMatchObject({ state: 'CANCELLED', usable: false });
    expect(stopped.authority).toMatchObject({
      capabilityLeaseState: 'REVOKED',
      runnerLeaseState: 'REVOKED',
      executionState: 'STOPPED',
    });
    expect(stopped.checkpoint).not.toBeNull();

    const stoppedView = await controlPlane.service.getProject(created.view.projectId);
    if (stoppedView === null) throw new Error('Expected project');
    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'RESUME',
      reason: 'Create a successor attempt',
      expectedVersion: stoppedView.version,
      idempotencyKey: 'us2-stop-resume-40',
      correlationId: '62000000-0000-4000-8000-000000000042',
    });
    const resumed = await controlPlane.supervision.getProjection(created.view.projectId);
    expect(resumed.projectState).toBe('ACTIVE');
    expect(resumed.approvals).toHaveLength(2);
    expect(resumed.approvals[1]).toMatchObject({ state: 'REQUESTED', usable: true });
    const successorApproval = resumed.approvals[1];
    const successorEffect = resumed.effects[1];
    if (successorApproval === undefined || successorEffect === undefined)
      throw new Error('Expected a successor approval and effect');
    await controlPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: successorApproval.approvalId,
      decision: 'APPROVE',
      actionDigest: successorApproval.actionDigest,
      reason: 'Approve only the fresh successor intent',
      expectedVersion: successorApproval.version,
      idempotencyKey: 'us2-successor-approval-40',
      correlationId: '62000000-0000-4000-8000-000000000053',
    });
    const appliedSuccessor = await controlPlane.supervision.getProjection(created.view.projectId);
    expect(appliedSuccessor.effects[0]).toMatchObject({ state: 'FAILED' });
    expect(appliedSuccessor.effects[1]).toMatchObject({
      effectId: successorEffect.effectId,
      state: 'APPLIED',
    });
    await expect(
      effects.lookup(authorityReference(appliedSuccessor, successorEffect)),
    ).resolves.toMatchObject({ outcome: 'APPLIED' });
    expect(appliedSuccessor.audit.filter(({ action }) => action === 'tool.requested')).toHaveLength(
      2,
    );
    expect(appliedSuccessor.audit.filter(({ action }) => action === 'policy.decided')).toHaveLength(
      2,
    );
    expect(
      appliedSuccessor.audit.filter(({ action }) => action === 'approval.requested'),
    ).toHaveLength(2);

    const resumedView = await controlPlane.service.getProject(created.view.projectId);
    if (resumedView === null) throw new Error('Expected project');
    await controlPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'CANCEL',
      reason: 'End the project permanently',
      expectedVersion: resumedView.version,
      idempotencyKey: 'us2-cancel-control-40',
      correlationId: '62000000-0000-4000-8000-000000000043',
    });
    expect(await controlPlane.supervision.getProjection(created.view.projectId)).toMatchObject({
      projectState: 'CANCELLED',
      authority: { executionState: 'CANCELLED' },
    });
    const cancelledView = await controlPlane.service.getProject(created.view.projectId);
    if (cancelledView === null) throw new Error('Expected project');
    await expect(
      controlPlane.supervision.controlProject({
        actorId: supervisorId,
        projectId: created.view.projectId,
        command: 'RESUME',
        reason: 'Must remain terminal',
        expectedVersion: cancelledView.version,
        idempotencyKey: 'us2-terminal-resume-40',
        correlationId: '62000000-0000-4000-8000-000000000044',
      }),
    ).rejects.toMatchObject({ code: 'CONTROL_STATE_CONFLICT' });

    for (const command of ['STOP', 'CANCEL'] as const) {
      const raced = await submit(controlPlane, command === 'STOP' ? '45' : '46');
      const ready = await controlPlane.service.getProject(raced.view.projectId);
      if (ready === null) throw new Error('Expected project');
      const outcomes = await Promise.allSettled([
        controlPlane.supervision.controlProject({
          actorId: supervisorId,
          projectId: raced.view.projectId,
          command,
          reason: `${command} wins or loses by version`,
          expectedVersion: ready.version,
          idempotencyKey: `us2-${command.toLocaleLowerCase('en-US')}-race`,
          correlationId: `62000000-0000-4000-8000-0000000000${command === 'STOP' ? '49' : '50'}`,
        }),
        commitTestCompletion(controlPlane, raced.view.projectId, ready.version),
      ]);
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const after = await controlPlane.supervision.getProjection(raced.view.projectId);
      expect([command === 'STOP' ? 'STOPPED' : 'CANCELLED', 'COMPLETED']).toContain(
        after.projectState,
      );
      const winningAudits = after.audit.filter(({ action }) =>
        ['control.stop', 'control.cancel'].includes(action),
      );
      expect(winningAudits).toHaveLength(after.projectState === 'COMPLETED' ? 0 : 1);
    }
    await controlPlane.server.close();
  });

  it('lets a newer cancel supersede delayed stop reconciliation without reverting terminal state', async () => {
    const effectReturned = deferred();
    const effectApplied = deferred();
    const stopRevokeEntered = deferred();
    const stopRevokeReleased = deferred();
    const approvingEffects: ApprovedEffectExecutor = {
      execute: async (input) => {
        const result = await effects.execute(input);
        effectApplied.resolve();
        await effectReturned.promise;
        return result;
      },
      revoke: (input) => effects.revoke(input),
      lookup: (input) => effects.lookup(input),
    };
    const delayedStopEffects: ApprovedEffectExecutor = {
      execute: (input) => effects.execute(input),
      revoke: async (input) => {
        stopRevokeEntered.resolve();
        await stopRevokeReleased.promise;
        return effects.revoke(input);
      },
      lookup: (input) => effects.lookup(input),
    };
    const approvingPlane = fixture('us2-supersession-approval', approvingEffects);
    const stoppingPlane = fixture('us2-supersession-stop', delayedStopEffects);
    const cancellingPlane = fixture('us2-supersession-cancel');
    const created = await submit(approvingPlane, '58');
    const approval = (await approvingPlane.supervision.getProjection(created.view.projectId))
      .approvals[0];
    if (approval === undefined) throw new Error('Expected approval');
    const decision = approvingPlane.supervision.decideApproval({
      actorId: supervisorId,
      projectId: created.view.projectId,
      approvalId: approval.approvalId,
      decision: 'APPROVE',
      actionDigest: approval.actionDigest,
      reason: 'Hold the result while controls race',
      expectedVersion: approval.version,
      idempotencyKey: 'us2-supersession-approval-58',
      correlationId: '62000000-0000-4000-8000-000000000058',
    });
    await effectApplied.promise;
    const executing = await waitForEffectState(stoppingPlane, created.view.projectId, 'EXECUTING');
    const stop = stoppingPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'STOP',
      reason: 'Begin a recoverable stop',
      expectedVersion: executing.projectVersion,
      idempotencyKey: 'us2-supersession-stop-58',
      correlationId: '62000000-0000-4000-8000-000000000059',
    });
    await stopRevokeEntered.promise;
    const stopping = await cancellingPlane.supervision.getProjection(created.view.projectId);
    expect(stopping.projectState).toBe('STOPPING');
    await cancellingPlane.supervision.controlProject({
      actorId: supervisorId,
      projectId: created.view.projectId,
      command: 'CANCEL',
      reason: 'Supersede stop with terminal cancellation',
      expectedVersion: stopping.projectVersion,
      idempotencyKey: 'us2-supersession-cancel-58',
      correlationId: '62000000-0000-4000-8000-000000000060',
    });
    expect(
      (await cancellingPlane.supervision.getProjection(created.view.projectId)).projectState,
    ).toBe('CANCELLED');
    stopRevokeReleased.resolve();
    await stop;
    effectReturned.resolve();
    await decision;
    const final = await cancellingPlane.supervision.getProjection(created.view.projectId);
    expect(final).toMatchObject({
      projectState: 'CANCELLED',
      authority: { executionState: 'CANCELLED' },
    });
    expect(final.audit.filter(({ action }) => action === 'control.cancel.completed')).toHaveLength(
      1,
    );
    expect(final.audit.filter(({ action }) => action === 'control.stop.completed')).toHaveLength(0);
    expect(final.audit.filter(({ action }) => action === 'effect.result')).toHaveLength(1);
    await approvingPlane.server.close();
    await stoppingPlane.server.close();
    await cancellingPlane.server.close();
  });
});
