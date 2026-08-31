import {
  isUuid,
  sanitizeBackendEvent,
  type BackendObservationRejectionReason,
  type SanitizedBackendObservation,
} from '@moonshift/contracts';
import type { Pool, PoolClient } from 'pg';

import {
  FencingAuthorityError,
  IdempotencyConflictError,
  LeaseConflictError,
  OptimisticConcurrencyError,
} from './errors.js';

export type AggregateCommit = {
  readonly aggregate: {
    readonly type: string;
    readonly id: string;
    readonly projectId?: string;
    readonly state: string;
    readonly data: Readonly<Record<string, unknown>>;
  };
  readonly expectedVersion: number;
  readonly audit: {
    readonly id: string;
    readonly actorType: string;
    readonly actorId: string;
    readonly action: string;
    readonly reasonCode: string;
    readonly outcome: string;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly occurredAt: Date;
  };
  readonly outbox: {
    readonly id: string;
    readonly projectId: string;
    readonly projectSequence: number | bigint;
    readonly payload: Readonly<Record<string, unknown>>;
  };
};

type QueueItem = {
  readonly id: string;
  readonly queueName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly availableAt: Date;
};

export type QueueClaim = {
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claimedBy: string;
  readonly claimToken: bigint;
};

type LeaseRequest = {
  readonly id: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly ownerId: string;
  readonly now: Date;
  readonly expiresAt: Date;
};

type Lease = LeaseRequest & { readonly fencingToken: bigint };

export type OutboxClaim = {
  readonly id: string;
  readonly projectId: string;
  readonly projectSequence: bigint;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claimedBy: string;
  readonly claimToken: bigint;
};

export type FencedExternalEffectCommit = {
  readonly executionId: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly fencingToken: bigint;
  readonly commit: AggregateCommit;
};

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function deterministicUuidFromHash(hash: `sha256:${string}`): string {
  const hex = hash.slice(7);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const backendObservationRejectionReasons = new Set([
  'BACKEND_OBSERVATION_PROHIBITED_CONTENT',
  'BACKEND_OBSERVATION_SCHEMA_INVALID',
  'BACKEND_OBSERVATION_KIND_INVALID',
]);
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const MAX_RUNNER_FENCE_VALUE = BigInt(Number.MAX_SAFE_INTEGER);

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveDurationMs(now: Date, until: Date, label: string): number {
  const duration = until.getTime() - now.getTime();
  if (!Number.isSafeInteger(duration) || duration <= 0) throw new RangeError(label);
  return duration;
}

function nonNegativeDurationMs(now: Date, until: Date, label: string): number {
  const duration = until.getTime() - now.getTime();
  if (!Number.isSafeInteger(duration) || duration < 0) throw new RangeError(label);
  return duration;
}

function normalizeBackendObservation(value: unknown): SanitizedBackendObservation {
  if (value === null || typeof value !== 'object')
    throw new TypeError('Sanitized backend observation required');
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.accepted === true) {
    if (
      !hasExactKeys(candidate, ['accepted', 'classification', 'event', 'sourceContentHash']) ||
      candidate.classification !== 'INTERNAL' ||
      typeof candidate.sourceContentHash !== 'string' ||
      !sha256Pattern.test(candidate.sourceContentHash)
    ) {
      throw new TypeError('Sanitized backend observation required');
    }
    const resanitized = sanitizeBackendEvent(candidate.event);
    if (!resanitized.accepted) throw new TypeError('Sanitized backend observation required');
    return Object.freeze({
      ...resanitized,
      sourceContentHash: candidate.sourceContentHash as `sha256:${string}`,
    });
  }
  if (
    candidate.accepted !== false ||
    !hasExactKeys(candidate, [
      'accepted',
      'classification',
      'contentHash',
      'notice',
      'reasonCode',
      'sourceMessageId',
    ]) ||
    candidate.classification !== 'INTERNAL' ||
    typeof candidate.contentHash !== 'string' ||
    !sha256Pattern.test(candidate.contentHash) ||
    (candidate.sourceMessageId !== null &&
      (typeof candidate.sourceMessageId !== 'string' || !isUuid(candidate.sourceMessageId))) ||
    typeof candidate.reasonCode !== 'string' ||
    !backendObservationRejectionReasons.has(candidate.reasonCode) ||
    candidate.notice !== 'Backend observation rejected by projection policy'
  ) {
    throw new TypeError('Sanitized backend observation required');
  }
  return Object.freeze({
    accepted: false,
    sourceMessageId: candidate.sourceMessageId as string | null,
    contentHash: candidate.contentHash as `sha256:${string}`,
    classification: 'INTERNAL',
    reasonCode: candidate.reasonCode as BackendObservationRejectionReason,
    notice: 'Backend observation rejected by projection policy',
  }) as SanitizedBackendObservation;
}

export class MoonshiftStore {
  constructor(private readonly pool: Pool) {}

  async commitAggregate(input: AggregateCommit): Promise<{ version: number }> {
    return inTransaction(this.pool, (client) => this.commitAggregateInTransaction(client, input));
  }

  private async commitAggregateInTransaction(
    client: PoolClient,
    input: AggregateCommit,
    allowFencedExternalEffect = false,
  ): Promise<{ version: number }> {
    if (
      input.aggregate.type === 'EXTERNAL_EFFECT' &&
      input.aggregate.state === 'EXECUTING' &&
      !allowFencedExternalEffect
    ) {
      throw new FencingAuthorityError(
        'ExternalEffect EXECUTING must use the atomic fenced commit boundary',
      );
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RangeError('Expected version must be a non-negative safe integer');
    }
    const current = await client.query<{ version: number }>(
      'SELECT version FROM aggregates WHERE aggregate_type = $1 AND aggregate_id = $2 FOR UPDATE',
      [input.aggregate.type, input.aggregate.id],
    );
    const actualVersion = current.rows[0]?.version ?? 0;
    if (actualVersion !== input.expectedVersion) {
      throw new OptimisticConcurrencyError(input.expectedVersion, actualVersion);
    }
    const version = actualVersion + 1;
    if (actualVersion === 0) {
      await client.query(
        `INSERT INTO aggregates
            (aggregate_type, aggregate_id, project_id, version, state, data)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.aggregate.type,
          input.aggregate.id,
          input.aggregate.projectId ?? null,
          version,
          input.aggregate.state,
          input.aggregate.data,
        ],
      );
    } else {
      await client.query(
        `UPDATE aggregates
           SET project_id = $3, version = $4, state = $5, data = $6, updated_at = clock_timestamp()
           WHERE aggregate_type = $1 AND aggregate_id = $2`,
        [
          input.aggregate.type,
          input.aggregate.id,
          input.aggregate.projectId ?? null,
          version,
          input.aggregate.state,
          input.aggregate.data,
        ],
      );
    }
    await client.query(
      `INSERT INTO audit_events
          (audit_event_id, aggregate_type, aggregate_id, aggregate_version, actor_type, actor_id,
           action, reason_code, outcome, correlation_id, causation_id, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.audit.id,
        input.aggregate.type,
        input.aggregate.id,
        version,
        input.audit.actorType,
        input.audit.actorId,
        input.audit.action,
        input.audit.reasonCode,
        input.audit.outcome,
        input.audit.correlationId,
        input.audit.causationId ?? null,
        input.audit.metadata ?? {},
        input.audit.occurredAt,
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
          (event_id, project_id, project_sequence, aggregate_type, aggregate_id, aggregate_version, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.outbox.id,
        input.outbox.projectId,
        input.outbox.projectSequence.toString(),
        input.aggregate.type,
        input.aggregate.id,
        version,
        input.outbox.payload,
      ],
    );
    return { version };
  }

  async commitFencedExternalEffectExecution(
    input: FencedExternalEffectCommit,
  ): Promise<{ version: number }> {
    const { aggregate, audit } = input.commit;
    const data = aggregate.data;
    if (
      aggregate.type !== 'EXTERNAL_EFFECT' ||
      aggregate.state !== 'EXECUTING' ||
      audit.actorType !== 'RUNTIME' ||
      audit.actorId !== input.ownerId ||
      data.executorExecutionId !== input.executionId ||
      data.executorLeaseId !== input.leaseId ||
      data.executorOwnerId !== input.ownerId ||
      data.executorFencingToken !== input.fencingToken.toString()
    ) {
      throw new FencingAuthorityError('ExternalEffect commit is not bound to its lease authority');
    }
    return inTransaction(this.pool, async (client) => {
      const current = await client.query(
        `SELECT 1 FROM leases
         WHERE resource_type = 'EXECUTION' AND resource_id = $1 AND lease_id = $2
           AND owner_id = $3 AND fencing_token = $4 AND status = 'ACTIVE'
           AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [input.executionId, input.leaseId, input.ownerId, input.fencingToken.toString()],
      );
      if ((current.rowCount ?? 0) !== 1) throw new FencingAuthorityError();
      const persisted = await client.query<{
        state: string;
        data: Readonly<Record<string, unknown>>;
      }>(
        `SELECT state, data FROM aggregates
         WHERE aggregate_type = 'EXTERNAL_EFFECT' AND aggregate_id = $1
         FOR UPDATE`,
        [aggregate.id],
      );
      const existing = persisted.rows[0];
      if (
        existing === undefined ||
        existing.state !== 'REQUESTED' ||
        existing.data.executorExecutionId !== input.executionId ||
        existing.data.executorLeaseId !== input.leaseId ||
        existing.data.executorOwnerId !== input.ownerId ||
        existing.data.executorFencingToken !== input.fencingToken.toString()
      ) {
        throw new FencingAuthorityError(
          'ExternalEffect persistent authority does not match the current lease',
        );
      }
      return this.commitAggregateInTransaction(client, input.commit, true);
    });
  }

  async commitIdempotentAggregate(input: {
    readonly scope: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly response: unknown;
    readonly commit: AggregateCommit;
  }): Promise<{ reused: boolean; response: unknown; version: number | null }> {
    return inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `idempotency:${input.scope}:${input.idempotencyKey}`,
      ]);
      const existing = await client.query<{ request_hash: string; response: unknown }>(
        `SELECT request_hash, response FROM idempotency_records
         WHERE scope = $1 AND idempotency_key = $2`,
        [input.scope, input.idempotencyKey],
      );
      const record = existing.rows[0];
      if (record !== undefined) {
        if (record.request_hash !== input.requestHash) {
          throw new IdempotencyConflictError(input.scope, input.idempotencyKey);
        }
        return { reused: true, response: record.response, version: null };
      }
      const committed = await this.commitAggregateInTransaction(client, input.commit);
      await client.query(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response)
         VALUES ($1, $2, $3, $4)`,
        [input.scope, input.idempotencyKey, input.requestHash, input.response],
      );
      return { reused: false, response: input.response, version: committed.version };
    });
  }

  async rememberIdempotent(
    scope: string,
    idempotencyKey: string,
    requestHash: string,
    response: unknown,
  ): Promise<{ reused: boolean; response: unknown }> {
    return inTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ response: unknown }>(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (scope, idempotency_key) DO NOTHING
         RETURNING response`,
        [scope, idempotencyKey, requestHash, response],
      );
      if ((inserted.rowCount ?? 0) > 0)
        return { reused: false, response: inserted.rows[0]?.response };
      const existing = await client.query<{ request_hash: string; response: unknown }>(
        `SELECT request_hash, response FROM idempotency_records
         WHERE scope = $1 AND idempotency_key = $2 FOR UPDATE`,
        [scope, idempotencyKey],
      );
      const record = existing.rows[0];
      if (record === undefined || record.request_hash !== requestHash) {
        throw new IdempotencyConflictError(scope, idempotencyKey);
      }
      return { reused: true, response: record.response };
    });
  }

  async enqueue(item: QueueItem): Promise<void> {
    await this.pool.query(
      `INSERT INTO queue_items (queue_item_id, queue_name, payload, available_at)
       VALUES ($1, $2, $3, $4)`,
      [item.id, item.queueName, item.payload, item.availableAt],
    );
  }

  async claimQueue(
    queueName: string,
    workerId: string,
    now: Date,
    claimUntil: Date,
  ): Promise<QueueClaim | null> {
    const claimDurationMs = positiveDurationMs(
      now,
      claimUntil,
      'Queue claim expiry must be in the future',
    );
    return inTransaction(this.pool, async (client) => {
      const databaseTime = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const databaseNow = databaseTime.rows[0]?.now;
      if (databaseNow === undefined) throw new Error('PostgreSQL clock unavailable');
      const authoritativeClaimUntil = new Date(databaseNow.getTime() + claimDurationMs);
      const result = await client.query<{
        queue_item_id: string;
        payload: Readonly<Record<string, unknown>>;
        claimed_by: string;
        claim_token: string;
      }>(
        `WITH candidate AS (
           SELECT queue_item_id FROM queue_items
           WHERE queue_name = $1 AND available_at <= $3
             AND (status = 'AVAILABLE' OR (status = 'CLAIMED' AND claim_expires_at <= $3))
           ORDER BY available_at, queue_item_id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE queue_items AS queued
         SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3,
             claim_expires_at = $4, claim_token = queued.claim_token + 1
         FROM candidate
         WHERE queued.queue_item_id = candidate.queue_item_id
         RETURNING queued.queue_item_id, queued.payload, queued.claimed_by, queued.claim_token`,
        [queueName, workerId, databaseNow, authoritativeClaimUntil],
      );
      const claimed = result.rows[0];
      return claimed === undefined
        ? null
        : {
            id: claimed.queue_item_id,
            payload: claimed.payload,
            claimedBy: claimed.claimed_by,
            claimToken: BigInt(claimed.claim_token),
          };
    });
  }

  async completeQueue(
    itemId: string,
    workerId: string,
    claimToken: bigint,
    now: Date,
  ): Promise<boolean> {
    void now;
    const result = await this.pool.query(
      `UPDATE queue_items
       SET status = 'COMPLETED', completed_at = clock_timestamp(), claim_expires_at = NULL
       WHERE queue_item_id = $1 AND status = 'CLAIMED' AND claimed_by = $2 AND claim_token = $3
         AND claim_expires_at > clock_timestamp()`,
      [itemId, workerId, claimToken.toString()],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async releaseQueue(
    itemId: string,
    workerId: string,
    claimToken: bigint,
    now: Date,
    availableAt: Date,
  ): Promise<boolean> {
    const releaseDelayMs = nonNegativeDurationMs(
      now,
      availableAt,
      'Queue release availability must not precede release time',
    );
    const result = await this.pool.query(
      `WITH claimed AS MATERIALIZED (
         SELECT queue_item_id
         FROM queue_items
         WHERE queue_item_id = $1 AND status = 'CLAIMED' AND claimed_by = $2 AND claim_token = $3
         FOR UPDATE
       ), authoritative AS MATERIALIZED (
         SELECT clock_timestamp() AS now FROM claimed
       )
       UPDATE queue_items AS queued
       SET status = 'AVAILABLE',
           available_at = date_trunc(
             'milliseconds',
             authoritative.now + ($4::double precision * interval '1 millisecond')
           ),
           claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
       FROM authoritative
       WHERE queued.queue_item_id = $1 AND queued.claim_expires_at > authoritative.now`,
      [itemId, workerId, claimToken.toString(), releaseDelayMs],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async claimOutbox(workerId: string, now: Date, claimUntil: Date): Promise<OutboxClaim | null> {
    const claimDurationMs = positiveDurationMs(
      now,
      claimUntil,
      'Outbox claim expiry must be in the future',
    );
    return inTransaction(this.pool, async (client) => {
      const databaseTime = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const databaseNow = databaseTime.rows[0]?.now;
      if (databaseNow === undefined) throw new Error('PostgreSQL clock unavailable');
      const authoritativeClaimUntil = new Date(databaseNow.getTime() + claimDurationMs);
      const result = await client.query<{
        event_id: string;
        project_id: string;
        project_sequence: string;
        aggregate_type: string;
        aggregate_id: string;
        aggregate_version: number;
        payload: Readonly<Record<string, unknown>>;
        claimed_by: string;
        claim_token: string;
      }>(
        `WITH candidate AS (
           SELECT event_id FROM outbox_events
           WHERE status = 'PENDING' OR (status = 'CLAIMED' AND claim_expires_at <= $2)
           ORDER BY created_at, event_id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE outbox_events AS pending
         SET status = 'CLAIMED', claimed_by = $1, claimed_at = $2,
             claim_expires_at = $3, claim_token = pending.claim_token + 1
         FROM candidate
         WHERE pending.event_id = candidate.event_id
         RETURNING pending.event_id, pending.project_id, pending.project_sequence,
           pending.aggregate_type, pending.aggregate_id, pending.aggregate_version,
           pending.payload, pending.claimed_by, pending.claim_token`,
        [workerId, databaseNow, authoritativeClaimUntil],
      );
      const claim = result.rows[0];
      return claim === undefined
        ? null
        : {
            id: claim.event_id,
            projectId: claim.project_id,
            projectSequence: BigInt(claim.project_sequence),
            aggregateType: claim.aggregate_type,
            aggregateId: claim.aggregate_id,
            aggregateVersion: claim.aggregate_version,
            payload: claim.payload,
            claimedBy: claim.claimed_by,
            claimToken: BigInt(claim.claim_token),
          };
    });
  }

  async publishOutbox(
    eventId: string,
    workerId: string,
    claimToken: bigint,
    now: Date,
  ): Promise<boolean> {
    void now;
    const result = await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PUBLISHED', published_at = clock_timestamp(), claim_expires_at = NULL
       WHERE event_id = $1 AND status = 'CLAIMED' AND claimed_by = $2 AND claim_token = $3
         AND claim_expires_at > clock_timestamp()`,
      [eventId, workerId, claimToken.toString()],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async releaseOutbox(
    eventId: string,
    workerId: string,
    claimToken: bigint,
    now: Date,
  ): Promise<boolean> {
    void now;
    const result = await this.pool.query(
      `UPDATE outbox_events
       SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL
       WHERE event_id = $1 AND status = 'CLAIMED' AND claimed_by = $2 AND claim_token = $3
         AND claim_expires_at > clock_timestamp()`,
      [eventId, workerId, claimToken.toString()],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async acquireLease(input: LeaseRequest): Promise<Lease> {
    const leaseDurationMs = positiveDurationMs(
      input.now,
      input.expiresAt,
      'Lease expiry must be after acquisition time',
    );
    return inTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${input.resourceType}:${input.resourceId}`,
      ]);
      const databaseTime = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const databaseNow = databaseTime.rows[0]?.now;
      if (databaseNow === undefined) throw new Error('PostgreSQL clock unavailable');
      const authoritativeExpiresAt = new Date(databaseNow.getTime() + leaseDurationMs);
      await client.query(
        `UPDATE leases SET status = 'EXPIRED', updated_at = $3
         WHERE resource_type = $1 AND resource_id = $2 AND status = 'ACTIVE' AND expires_at <= $3`,
        [input.resourceType, input.resourceId, databaseNow],
      );
      const active = await client.query(
        `SELECT 1 FROM leases
         WHERE resource_type = $1 AND resource_id = $2 AND status = 'ACTIVE'`,
        [input.resourceType, input.resourceId],
      );
      if ((active.rowCount ?? 0) > 0)
        throw new LeaseConflictError(input.resourceType, input.resourceId);
      const previous = await client.query<{ fencing_token: string }>(
        `SELECT fencing_token FROM leases
         WHERE resource_type = $1 AND resource_id = $2
         ORDER BY fencing_token DESC LIMIT 1`,
        [input.resourceType, input.resourceId],
      );
      const fencingToken = BigInt(previous.rows[0]?.fencing_token ?? '0') + 1n;
      if (fencingToken > MAX_RUNNER_FENCE_VALUE) {
        throw new Error('Lease fencing token space exhausted for the runner protocol');
      }
      await client.query(
        `INSERT INTO leases
          (lease_id, resource_type, resource_id, owner_id, fencing_token, expires_at, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)`,
        [
          input.id,
          input.resourceType,
          input.resourceId,
          input.ownerId,
          fencingToken.toString(),
          authoritativeExpiresAt,
          databaseNow,
        ],
      );
      return { ...input, now: databaseNow, expiresAt: authoritativeExpiresAt, fencingToken };
    });
  }

  async revokeLease(leaseId: string, now: Date): Promise<void> {
    void now;
    await this.pool.query(
      `UPDATE leases SET status = 'REVOKED', updated_at = clock_timestamp()
       WHERE lease_id = $1 AND status = 'ACTIVE'`,
      [leaseId],
    );
  }

  async isCurrentFence(
    resourceType: string,
    resourceId: string,
    leaseId: string,
    ownerId: string,
    fencingToken: bigint,
    now: Date,
  ): Promise<boolean> {
    void now;
    const result = await this.pool.query(
      `SELECT 1 FROM leases
       WHERE resource_type = $1 AND resource_id = $2 AND lease_id = $3
         AND owner_id = $4 AND fencing_token = $5 AND status = 'ACTIVE'
         AND expires_at > clock_timestamp()`,
      [resourceType, resourceId, leaseId, ownerId, fencingToken.toString()],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async advanceProjection(
    projectionName: string,
    projectId: string,
    lastSequence: number | bigint,
  ): Promise<bigint> {
    const result = await this.pool.query<{ last_sequence: string }>(
      `INSERT INTO projection_checkpoints (projection_name, project_id, last_sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (projection_name, project_id) DO UPDATE
       SET last_sequence = GREATEST(projection_checkpoints.last_sequence, EXCLUDED.last_sequence),
           updated_at = clock_timestamp()
       RETURNING last_sequence`,
      [projectionName, projectId, lastSequence.toString()],
    );
    return BigInt(result.rows[0]?.last_sequence ?? '0');
  }

  async recordBackendObservation(observation: unknown): Promise<void> {
    const normalized = normalizeBackendObservation(observation);
    const sourceMessageId =
      !normalized.accepted &&
      normalized.sourceMessageId !== null &&
      isUuid(normalized.sourceMessageId)
        ? normalized.sourceMessageId
        : null;
    const messageId = normalized.accepted
      ? normalized.event.messageId
      : (sourceMessageId ?? deterministicUuidFromHash(normalized.contentHash));
    const sourceContentHash = normalized.accepted
      ? normalized.sourceContentHash
      : normalized.contentHash;
    const projection = normalized.accepted
      ? { event: normalized.event }
      : {
          reasonCode: normalized.reasonCode,
          notice: normalized.notice,
          sourceMessageId,
        };
    const result = await this.pool.query(
      `INSERT INTO backend_event_projections
        (message_id, execution_id, source_content_hash, accepted, classification, projection)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id) DO UPDATE SET message_id = EXCLUDED.message_id
       WHERE backend_event_projections.execution_id IS NOT DISTINCT FROM EXCLUDED.execution_id
         AND backend_event_projections.source_content_hash = EXCLUDED.source_content_hash
         AND backend_event_projections.accepted = EXCLUDED.accepted
         AND backend_event_projections.classification = EXCLUDED.classification
         AND backend_event_projections.projection = EXCLUDED.projection
       RETURNING message_id`,
      [
        messageId,
        normalized.accepted ? normalized.event.executionId : null,
        sourceContentHash,
        normalized.accepted,
        'INTERNAL',
        projection,
      ],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new IdempotencyConflictError('backend-observation', messageId);
    }
  }
}
