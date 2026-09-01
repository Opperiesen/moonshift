export interface RuntimeAuthoritySnapshot {
  readonly executionId: string;
  readonly runtimeId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly lastHeartbeatAt: string;
}

export interface RuntimeHealthResult {
  readonly state: 'HEALTHY' | 'LOST';
  readonly reason: 'CURRENT' | 'LEASE_EXPIRED' | 'HEARTBEAT_STALE';
  readonly fencedToken: number;
  readonly runtime: RuntimeAuthoritySnapshot;
}

function timestamp(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function evaluateRuntimeHealth(input: {
  readonly authorityNow: string;
  readonly heartbeatTimeoutMs: number;
  readonly runtime: RuntimeAuthoritySnapshot;
}): RuntimeHealthResult {
  if (!Number.isSafeInteger(input.heartbeatTimeoutMs) || input.heartbeatTimeoutMs < 1)
    throw new Error('HEARTBEAT_TIMEOUT_INVALID');
  if (!Number.isSafeInteger(input.runtime.fencingToken) || input.runtime.fencingToken < 1)
    throw new Error('RUNTIME_FENCE_INVALID');
  const now = timestamp(input.authorityNow, 'AUTHORITY_TIME_INVALID');
  const leaseExpiresAt = timestamp(input.runtime.leaseExpiresAt, 'RUNTIME_LEASE_INVALID');
  const lastHeartbeatAt = timestamp(input.runtime.lastHeartbeatAt, 'RUNTIME_HEARTBEAT_INVALID');
  const reason =
    now >= leaseExpiresAt
      ? ('LEASE_EXPIRED' as const)
      : now - lastHeartbeatAt >= input.heartbeatTimeoutMs
        ? ('HEARTBEAT_STALE' as const)
        : ('CURRENT' as const);
  return Object.freeze({
    state: reason === 'CURRENT' ? ('HEALTHY' as const) : ('LOST' as const),
    reason,
    fencedToken: input.runtime.fencingToken,
    runtime: input.runtime,
  });
}

export function createSuccessorRuntimeAuthority(input: {
  readonly previous: RuntimeHealthResult;
  readonly executionId: string;
  readonly runtimeId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly leaseExpiresAt: string;
  readonly lastHeartbeatAt: string;
}): RuntimeAuthoritySnapshot {
  if (input.previous.state !== 'LOST') throw new Error('RUNTIME_NOT_LOST');
  if (
    input.executionId === input.previous.runtime.executionId ||
    input.runtimeId === input.previous.runtime.runtimeId ||
    input.leaseId === input.previous.runtime.leaseId
  )
    throw new Error('SUCCESSOR_AUTHORITY_MUST_BE_FRESH');
  const leaseExpiresAt = timestamp(input.leaseExpiresAt, 'RUNTIME_LEASE_INVALID');
  const lastHeartbeatAt = timestamp(input.lastHeartbeatAt, 'RUNTIME_HEARTBEAT_INVALID');
  if (lastHeartbeatAt >= leaseExpiresAt) throw new Error('SUCCESSOR_LEASE_EXPIRED');
  return Object.freeze({
    executionId: input.executionId,
    runtimeId: input.runtimeId,
    leaseId: input.leaseId,
    ownerId: input.ownerId,
    fencingToken: input.previous.fencedToken + 1,
    leaseExpiresAt: input.leaseExpiresAt,
    lastHeartbeatAt: input.lastHeartbeatAt,
  });
}

export function assertRuntimeFence(authority: RuntimeAuthoritySnapshot, presented: number): void {
  if (presented !== authority.fencingToken) throw new Error('STALE_RUNTIME_FENCE');
}
