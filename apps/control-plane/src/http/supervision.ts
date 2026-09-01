import { randomUUID } from 'node:crypto';

import { isUuid } from '@moonshift/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SupervisionService } from '../application/supervision/index.js';
import { ControlPlaneError } from '../errors.js';
import type { LoopbackSessionManager } from './session.js';

const IDEMPOTENCY_PATTERN = /^[!-~]{16,128}$/u;
const ETAG_PATTERN = /^"([1-9][0-9]*)"$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const approvalStates = new Set(['REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED']);

function correlation(request: FastifyRequest): string {
  const value = request.headers['x-correlation-id'];
  return typeof value === 'string' && isUuid(value) ? value : randomUUID();
}

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

function actor(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: LoopbackSessionManager,
): string | null {
  const actorId = sessions.authenticate(request.headers.cookie);
  if (actorId === null)
    problem(reply, 401, 'UNAUTHORIZED', 'A supervisor session is required', correlation(request));
  return actorId;
}

function version(request: FastifyRequest): number {
  const value = request.headers['if-match'];
  const match = typeof value === 'string' ? ETAG_PATTERN.exec(value) : null;
  const parsed = Number(match?.[1]);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new ControlPlaneError(
      'COMMAND_HEADERS_INVALID',
      'A valid strong If-Match precondition is required',
      400,
    );
  return parsed;
}

function commandIdentity(request: FastifyRequest): {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly expectedVersion: number;
} {
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
  return { idempotencyKey, correlationId, expectedVersion: version(request) };
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value as object)
      .sort()
      .join(',') !== [...keys].sort().join(',')
  ) {
    throw new ControlPlaneError('COMMAND_BODY_INVALID', 'Command body fields are invalid', 400);
  }
  return value as Record<string, unknown>;
}

function handleError(error: unknown, reply: FastifyReply, request: FastifyRequest): FastifyReply {
  if (error instanceof ControlPlaneError)
    return problem(reply, error.statusCode, error.code, error.message, correlation(request));
  throw error;
}

export function registerSupervisionRoutes(input: {
  readonly server: FastifyInstance;
  readonly supervision: SupervisionService;
  readonly sessions: LoopbackSessionManager;
  readonly afterApprovedEffect?: (projectId: string, correlationId: string) => Promise<void>;
  readonly afterControl?: (
    projectId: string,
    command: 'PAUSE' | 'RESUME' | 'STOP' | 'CANCEL',
    correlationId: string,
  ) => Promise<void>;
}): void {
  input.server.get<{
    Params: { projectId: string };
    Querystring: { state?: string };
  }>('/v1/projects/:projectId/approvals', async (request, reply) => {
    const actorId = actor(request, reply, input.sessions);
    if (actorId === null) return reply;
    if (!isUuid(request.params.projectId))
      return problem(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found', correlation(request));
    if (request.query.state !== undefined && !approvalStates.has(request.query.state))
      return problem(
        reply,
        400,
        'APPROVAL_STATE_INVALID',
        'Approval state filter is invalid',
        correlation(request),
      );
    try {
      return reply.send(
        await input.supervision.listApprovals(request.params.projectId, request.query.state),
      );
    } catch (error) {
      return handleError(error, reply, request);
    }
  });

  input.server.get<{ Params: { projectId: string; approvalId: string } }>(
    '/v1/projects/:projectId/approvals/:approvalId',
    async (request, reply) => {
      const actorId = actor(request, reply, input.sessions);
      if (actorId === null) return reply;
      if (!isUuid(request.params.projectId) || !isUuid(request.params.approvalId))
        return problem(
          reply,
          404,
          'APPROVAL_NOT_FOUND',
          'Approval not found',
          correlation(request),
        );
      try {
        const approval = await input.supervision.getApproval(
          request.params.projectId,
          request.params.approvalId,
        );
        return reply.header('etag', `"${approval.version}"`).send(approval);
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  input.server.post<{ Params: { projectId: string; approvalId: string } }>(
    '/v1/projects/:projectId/approvals/:approvalId/decision',
    async (request, reply) => {
      const actorId = actor(request, reply, input.sessions);
      if (actorId === null) return reply;
      if (!isUuid(request.params.projectId) || !isUuid(request.params.approvalId))
        return problem(
          reply,
          404,
          'APPROVAL_NOT_FOUND',
          'Approval not found',
          correlation(request),
        );
      try {
        const identity = commandIdentity(request);
        const body = exactObject(request.body, ['decision', 'actionDigest', 'reason']);
        if (
          (body.decision !== 'APPROVE' && body.decision !== 'REJECT') ||
          typeof body.actionDigest !== 'string' ||
          !DIGEST_PATTERN.test(body.actionDigest) ||
          typeof body.reason !== 'string'
        ) {
          throw new ControlPlaneError('DECISION_BODY_INVALID', 'Decision fields are invalid', 400);
        }
        const decided = await input.supervision.decideApproval({
          actorId,
          projectId: request.params.projectId,
          approvalId: request.params.approvalId,
          decision: body.decision,
          actionDigest: body.actionDigest,
          reason: body.reason,
          ...identity,
        });
        if (decided.approval.state === 'APPROVED') {
          await input.afterApprovedEffect?.(request.params.projectId, identity.correlationId);
        }
        return reply.header('etag', `"${decided.approval.version}"`).send(decided.approval);
      } catch (error) {
        return handleError(error, reply, request);
      }
    },
  );

  for (const [route, command] of [
    ['pause', 'PAUSE'],
    ['resume', 'RESUME'],
    ['stop', 'STOP'],
    ['cancel', 'CANCEL'],
  ] as const) {
    input.server.post<{ Params: { projectId: string } }>(
      `/v1/projects/:projectId/commands/${route}`,
      async (request, reply) => {
        const actorId = actor(request, reply, input.sessions);
        if (actorId === null) return reply;
        if (!isUuid(request.params.projectId))
          return problem(
            reply,
            404,
            'PROJECT_NOT_FOUND',
            'Project not found',
            correlation(request),
          );
        try {
          const identity = commandIdentity(request);
          const body = exactObject(request.body, ['reason']);
          if (typeof body.reason !== 'string')
            throw new ControlPlaneError('CONTROL_BODY_INVALID', 'Control reason is invalid', 400);
          const accepted = await input.supervision.controlProject({
            actorId,
            projectId: request.params.projectId,
            command,
            reason: body.reason,
            ...identity,
          });
          await input.afterControl?.(request.params.projectId, command, identity.correlationId);
          return reply.code(202).send(accepted);
        } catch (error) {
          return handleError(error, reply, request);
        }
      },
    );
  }
}
