import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FsArtifactStore } from '@moonshift/artifacts';
import { isUuid } from '@moonshift/contracts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { ControlPlaneError, EventCursorExpiredError } from '../errors.js';
import type { FixtureScenario } from '../model.js';
import { formatProjectEventsAsSse } from '../projections/project-events.js';
import { projectResults } from '../projections/results.js';
import { FixtureScheduler } from '../scheduler/index.js';
import {
  InMemoryProjectRepository,
  PostgresProjectRepository,
  ProjectService,
  type ProjectRepository,
} from '../application/projects/index.js';
import {
  InMemoryApprovedEffectExecutor,
  SupervisionService,
  type ApprovedEffectExecutor,
} from '../application/supervision/index.js';
import { VerificationService } from '../application/verification/index.js';
import { RecoveryService } from '../application/recovery/index.js';
import { reconstructDurableState } from '../bootstrap/recovery.js';
import { LoopbackSessionManager } from './session.js';
import { registerSupervisionRoutes } from './supervision.js';

const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/u;
const scenarioValues = new Set([
  'PASS',
  'EVIDENCE_FAIL',
  'APPROVAL_REJECT',
  'INTERRUPT_BEFORE_EFFECT',
  'INTERRUPT_DURING_EFFECT',
  'INTERRUPT_AFTER_EFFECT',
]);

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  correlationId: string,
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: `urn:moonshift:problem:${code.toLocaleLowerCase('en-US')}`,
      title,
      status,
      code,
      correlationId,
    });
}

function correlation(request: FastifyRequest): string {
  const value = request.headers['x-correlation-id'];
  return typeof value === 'string' && isUuid(value) ? value : randomUUID();
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function assertLoopbackRequest(request: FastifyRequest): void {
  const localAddress = request.raw.socket.localAddress;
  const boundAddress = (
    request.raw.socket as typeof request.raw.socket & {
      readonly server?: { address(): string | AddressInfo | null };
    }
  ).server?.address();
  if (
    (localAddress !== undefined && !isLoopbackAddress(localAddress)) ||
    (boundAddress !== undefined &&
      boundAddress !== null &&
      typeof boundAddress !== 'string' &&
      !isLoopbackAddress((boundAddress as AddressInfo).address))
  ) {
    throw new ControlPlaneError(
      'LOOPBACK_REQUIRED',
      'Session bootstrap is available only on a loopback listener',
      400,
    );
  }
}

function waitForPoll(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: LoopbackSessionManager,
): string | null {
  const actorId = sessions.authenticate(request.headers.cookie);
  if (actorId === null) {
    problem(reply, 401, 'UNAUTHORIZED', 'A supervisor session is required', correlation(request));
  }
  return actorId;
}

function objectiveBody(value: unknown): { objective: string; fixtureScenario: FixtureScenario } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ControlPlaneError('PROJECT_REQUEST_INVALID', 'Project request must be an object');
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 2 ||
    typeof body.objective !== 'string' ||
    typeof body.fixtureScenario !== 'string' ||
    !scenarioValues.has(body.fixtureScenario)
  ) {
    throw new ControlPlaneError('PROJECT_REQUEST_INVALID', 'Project request fields are invalid');
  }
  return { objective: body.objective, fixtureScenario: body.fixtureScenario as FixtureScenario };
}

export function createControlPlaneServer(input: {
  readonly service: ProjectService;
  readonly repository: ProjectRepository;
  readonly supervision: SupervisionService;
  readonly verification: VerificationService;
  readonly sessions: LoopbackSessionManager;
  readonly version?: string;
}): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/v1/health', async () => ({ status: 'alive', version: input.version ?? '0.0.0' }));

  registerSupervisionRoutes({
    server,
    supervision: input.supervision,
    sessions: input.sessions,
    afterApprovedEffect: (projectId, correlationId) =>
      input.verification.runConfiguredFixture(projectId, correlationId),
    afterControl: async (projectId, command, correlationId) => {
      if (command === 'RESUME') {
        await input.verification.resumeStaleEvaluation({ projectId, correlationId });
      }
    },
  });

  server.post('/v1/session/bootstrap', async (request, reply) => {
    const requestCorrelation = correlation(request);
    try {
      try {
        assertLoopbackRequest(request);
      } catch (error) {
        input.sessions.invalidateAttempt();
        throw error;
      }
      const body = request.body as Record<string, unknown> | null;
      if (
        body === null ||
        typeof body !== 'object' ||
        Object.keys(body).length !== 1 ||
        typeof body.bootstrapSecret !== 'string' ||
        body.bootstrapSecret.length < 43 ||
        body.bootstrapSecret.length > 256
      ) {
        input.sessions.invalidateAttempt();
        throw new ControlPlaneError(
          'BOOTSTRAP_REQUEST_INVALID',
          'Bootstrap request is invalid',
          400,
        );
      }
      const cookie = input.sessions.exchange(body.bootstrapSecret, request.headers.origin);
      return reply.code(204).header('set-cookie', cookie).send();
    } catch (error) {
      if (error instanceof ControlPlaneError)
        return problem(reply, error.statusCode, error.code, error.message, requestCorrelation);
      throw error;
    }
  });

  server.post('/v1/projects', async (request, reply) => {
    const requestCorrelation = correlation(request);
    const actorId = authenticate(request, reply, input.sessions);
    if (actorId === null) return reply;
    try {
      const idempotencyKey = request.headers['idempotency-key'];
      const correlationId = request.headers['x-correlation-id'];
      if (
        typeof idempotencyKey !== 'string' ||
        !IDEMPOTENCY_PATTERN.test(idempotencyKey) ||
        typeof correlationId !== 'string' ||
        !isUuid(correlationId)
      ) {
        throw new ControlPlaneError(
          'COMMAND_HEADERS_INVALID',
          'Valid idempotency and correlation headers are required',
          400,
        );
      }
      const body = objectiveBody(request.body);
      const result = await input.service.submitObjective({
        actorId,
        idempotencyKey,
        correlationId,
        ...body,
      });
      return reply
        .code(result.reused ? 200 : 201)
        .header('etag', `"${result.view.version}"`)
        .send(result.view);
    } catch (error) {
      if (error instanceof ControlPlaneError)
        return problem(reply, error.statusCode, error.code, error.message, requestCorrelation);
      throw error;
    }
  });

  server.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId',
    async (request, reply) => {
      const actorId = authenticate(request, reply, input.sessions);
      if (actorId === null) return reply;
      const requestCorrelation = correlation(request);
      if (!isUuid(request.params.projectId))
        return problem(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found', requestCorrelation);
      const view = await input.service.getProject(request.params.projectId);
      if (view === null)
        return problem(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found', requestCorrelation);
      return reply.header('etag', `"${view.version}"`).send(view);
    },
  );

  server.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/results',
    async (request, reply) => {
      const actorId = authenticate(request, reply, input.sessions);
      if (actorId === null) return reply;
      const requestCorrelation = correlation(request);
      if (!isUuid(request.params.projectId))
        return problem(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found', requestCorrelation);
      const record = await input.repository.get(request.params.projectId);
      if (record === null)
        return problem(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found', requestCorrelation);
      return reply.send(projectResults(record));
    },
  );

  server.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/events',
    async (request, reply) => {
      const actorId = authenticate(request, reply, input.sessions);
      if (actorId === null) return reply;
      const requestCorrelation = correlation(request);
      if (!isUuid(request.params.projectId))
        return problem(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found', requestCorrelation);
      const cursorValue = request.headers['last-event-id'];
      if (
        cursorValue !== undefined &&
        (typeof cursorValue !== 'string' || !/^[0-9]+$/u.test(cursorValue))
      ) {
        return problem(
          reply,
          400,
          'EVENT_CURSOR_INVALID',
          'Event cursor is invalid',
          requestCorrelation,
        );
      }
      const afterSequence = cursorValue === undefined ? 0 : Number(cursorValue);
      if (!Number.isSafeInteger(afterSequence))
        return problem(
          reply,
          400,
          'EVENT_CURSOR_INVALID',
          'Event cursor is invalid',
          requestCorrelation,
        );
      try {
        const record = await input.repository.get(request.params.projectId);
        if (record === null)
          return problem(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found', requestCorrelation);
        const events = await input.repository.listEvents(request.params.projectId, afterSequence);
        const followsLive = request.headers.accept
          ?.split(',')
          .some((value) => value.trim().split(';')[0] === 'text/event-stream');
        if (followsLive) {
          reply.hijack();
          reply.raw.writeHead(200, {
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8',
          });
          reply.raw.flushHeaders();
          let cursor = afterSequence;
          let pending = events;
          while (!request.raw.destroyed && !reply.raw.destroyed) {
            if (pending.length > 0) {
              reply.raw.write(formatProjectEventsAsSse(pending));
              cursor = pending.at(-1)?.sequence ?? cursor;
            }
            await waitForPoll(100);
            if (request.raw.destroyed || reply.raw.destroyed) break;
            try {
              pending = await input.repository.listEvents(request.params.projectId, cursor);
            } catch (error) {
              if (error instanceof EventCursorExpiredError) {
                reply.raw.write(
                  `event: stream.reset\ndata: ${JSON.stringify({ code: error.code })}\n\n`,
                );
                break;
              }
              throw error;
            }
          }
          if (!reply.raw.destroyed) reply.raw.end();
          return reply;
        }
        return reply
          .header('cache-control', 'no-cache')
          .type('text/event-stream')
          .send(formatProjectEventsAsSse(events));
      } catch (error) {
        if (error instanceof EventCursorExpiredError)
          return problem(reply, 409, error.code, error.message, requestCorrelation);
        throw error;
      }
    },
  );

  return server;
}

export function createFixtureControlPlane(input: {
  readonly bootstrapSecret: string;
  readonly origin: string;
  readonly supervisorId: string;
}): {
  readonly server: FastifyInstance;
  readonly sessions: LoopbackSessionManager;
  readonly repository: InMemoryProjectRepository;
  readonly service: ProjectService;
  readonly scheduler: FixtureScheduler;
  readonly supervision: SupervisionService;
  readonly effectExecutor: InMemoryApprovedEffectExecutor;
  readonly verification: VerificationService;
  readonly recovery: RecoveryService;
  readonly artifactStore: FsArtifactStore;
  readonly advanceTime: (milliseconds: number) => void;
  readonly resetTime: () => void;
} {
  const initialTime = Date.parse('2026-08-31T21:00:00.000Z');
  let fixtureTime = initialTime;
  const fixtureNow = () => new Date(fixtureTime);
  const repository = new InMemoryProjectRepository(fixtureNow);
  const sessions = new LoopbackSessionManager(
    input.bootstrapSecret,
    input.supervisorId,
    input.origin,
  );
  const scheduler = new FixtureScheduler({
    now: fixtureNow,
    nextId: randomUUID,
    expectedRevision: '857f0f9b02210000000000000000000000000000',
  });
  const service = new ProjectService({
    repository,
    scheduler,
    nextId: randomUUID,
  });
  const effectExecutor = new InMemoryApprovedEffectExecutor();
  const artifactRoot = join(tmpdir(), `moonshift-fixture-artifacts-${randomUUID()}`);
  const artifactStore = new FsArtifactStore({
    root: artifactRoot,
    ownerId: input.supervisorId,
  });
  const systemId = randomUUID();
  const supervision = new SupervisionService({
    repository,
    effectExecutor,
    nextId: randomUUID,
    expectedRevision: scheduler.expectedRevision,
    systemId,
    runnerId: randomUUID(),
  });
  const verification = new VerificationService({
    repository,
    artifactStore,
    nextId: randomUUID,
    expectedRevision: scheduler.expectedRevision,
    systemId,
    engineId: randomUUID(),
  });
  const recovery = new RecoveryService({
    repository,
    effectExecutor,
    nextId: randomUUID,
    systemId,
  });
  const server = createControlPlaneServer({
    service,
    repository,
    supervision,
    verification,
    sessions,
  });
  server.addHook('onClose', async () => rm(artifactRoot, { recursive: true, force: true }));
  return {
    server,
    sessions,
    repository,
    service,
    scheduler,
    supervision,
    effectExecutor,
    verification,
    recovery,
    artifactStore,
    advanceTime: (milliseconds) => {
      fixtureTime += milliseconds;
    },
    resetTime: () => {
      fixtureTime = initialTime;
      effectExecutor.clear();
    },
  };
}

export function createPostgresControlPlane(input: {
  readonly pool: Pool;
  readonly bootstrapSecret: string;
  readonly origin: string;
  readonly supervisorId: string;
  readonly expectedRevision: string;
  readonly runnerId: string;
  readonly now?: () => Date;
  readonly nextId?: () => string;
  readonly version?: string;
  readonly effectExecutor: ApprovedEffectExecutor;
  readonly artifactRoot?: string;
  readonly recoveryScanIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly recoveryBackendConnections?: ConstructorParameters<
    typeof RecoveryService
  >[0]['backendConnections'];
  readonly afterRemoteRecovery?: ConstructorParameters<
    typeof RecoveryService
  >[0]['afterRemoteRecovery'];
}): {
  readonly server: FastifyInstance;
  readonly sessions: LoopbackSessionManager;
  readonly repository: PostgresProjectRepository;
  readonly service: ProjectService;
  readonly scheduler: FixtureScheduler;
  readonly supervision: SupervisionService;
  readonly verification: VerificationService;
  readonly recovery: RecoveryService;
  readonly scanRuntimeRecovery: () => Promise<readonly string[]>;
  readonly artifactStore: FsArtifactStore;
} {
  const now = input.now ?? (() => new Date());
  const nextId = input.nextId ?? randomUUID;
  const repository = new PostgresProjectRepository(input.pool);
  const sessions = new LoopbackSessionManager(
    input.bootstrapSecret,
    input.supervisorId,
    input.origin,
    '127.0.0.1',
    now,
  );
  const scheduler = new FixtureScheduler({
    now,
    nextId,
    expectedRevision: input.expectedRevision,
  });
  const service = new ProjectService({ repository, scheduler, nextId });
  const artifactRoot =
    input.artifactRoot ?? join(tmpdir(), `moonshift-postgres-artifacts-${randomUUID()}`);
  const artifactStore = new FsArtifactStore({ root: artifactRoot, ownerId: input.supervisorId });
  const systemId = nextId();
  const supervision = new SupervisionService({
    repository,
    effectExecutor: input.effectExecutor,
    nextId,
    expectedRevision: input.expectedRevision,
    systemId,
    runnerId: input.runnerId,
  });
  const verification = new VerificationService({
    repository,
    artifactStore,
    nextId,
    expectedRevision: input.expectedRevision,
    systemId,
    engineId: nextId(),
  });
  const recovery = new RecoveryService({
    repository,
    effectExecutor: input.effectExecutor,
    nextId,
    systemId,
    ...(input.recoveryBackendConnections === undefined
      ? {}
      : { backendConnections: input.recoveryBackendConnections }),
    ...(input.afterRemoteRecovery === undefined
      ? {}
      : { afterRemoteRecovery: input.afterRemoteRecovery }),
  });
  const server = createControlPlaneServer({
    service,
    repository,
    supervision,
    verification,
    sessions,
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? 30_000;
  const scanRuntimeRecovery = () =>
    recovery.recoverStaleRuntimes({ heartbeatTimeoutMs, correlationId: nextId });
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  server.addHook('onReady', async () => {
    const reconstructed = await reconstructDurableState({ repository, pool: input.pool });
    for (const project of reconstructed.projects) {
      if (project.disposition === 'RESUME_ELIGIBLE') {
        if (project.sourceExecutionId === null) throw new Error('RECOVERY_EXECUTION_ID_MISSING');
        await recovery.recoverLostRuntime({
          projectId: project.projectId,
          sourceExecutionId: project.sourceExecutionId,
          correlationId: nextId(),
        });
      } else if (project.disposition === 'BLOCKED') {
        await recovery.blockUnrecoverableProject({
          projectId: project.projectId,
          sourceExecutionId: project.sourceExecutionId,
          reason: project.blockedReason ?? 'Startup recovery validation failed closed',
          correlationId: nextId(),
        });
      }
    }
    recoveryTimer = setInterval(() => {
      void scanRuntimeRecovery().catch((error: unknown) =>
        server.log.error({ err: error }, 'runtime recovery scan failed'),
      );
    }, input.recoveryScanIntervalMs ?? 30_000);
    recoveryTimer.unref();
  });
  server.addHook('onClose', async () => {
    if (recoveryTimer !== undefined) clearInterval(recoveryTimer);
  });
  if (input.artifactRoot === undefined) {
    server.addHook('onClose', async () => rm(artifactRoot, { recursive: true, force: true }));
  }
  return {
    server,
    sessions,
    repository,
    service,
    scheduler,
    supervision,
    verification,
    recovery,
    scanRuntimeRecovery,
    artifactStore,
  };
}
