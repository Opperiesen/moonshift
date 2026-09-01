import { FixtureEffectLedger, FixtureProcessExecutor } from '../fixture-executor.js';
import { FixtureRunnerJournal } from '../journal.js';
import { FixtureLeaseRegistry } from '../leases.js';

type ApprovedFixtureEffectInput = {
  readonly messageId: string;
  readonly correlationId: string;
  readonly effectId: string;
  readonly actionDigest: `sha256:${string}`;
  readonly operation: 'WRITE_APPROVED_MARKER';
  readonly executionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly approval: {
    readonly state: 'APPROVED';
    readonly actionDigest: `sha256:${string}`;
    readonly expiresAt: string;
  };
  readonly authority: {
    readonly authorizedAt: string;
    readonly leaseExpiresAt: string;
  };
};

type EffectAuthorityReference = {
  readonly messageId: string;
  readonly correlationId: string;
  readonly effectId: string;
  readonly actionDigest: `sha256:${string}`;
  readonly executionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
};

function assertAuthorized(input: ApprovedFixtureEffectInput): void {
  if (input.approval.state !== 'APPROVED') throw new Error('APPROVAL_NOT_APPROVED');
  if (input.approval.actionDigest !== input.actionDigest) throw new Error('ACTION_DIGEST_MISMATCH');
  const authorizedAt = Date.parse(input.authority.authorizedAt);
  const approvalExpiresAt = Date.parse(input.approval.expiresAt);
  const leaseExpiresAt = Date.parse(input.authority.leaseExpiresAt);
  if (
    !Number.isFinite(authorizedAt) ||
    !Number.isFinite(approvalExpiresAt) ||
    !Number.isFinite(leaseExpiresAt)
  ) {
    throw new Error('EFFECT_AUTHORITY_TIMESTAMP_INVALID');
  }
  if (authorizedAt >= approvalExpiresAt) throw new Error('APPROVAL_EXPIRED');
  if (authorizedAt >= leaseExpiresAt) throw new Error('EFFECT_AUTHORITY_EXPIRED');
  if (input.operation !== 'WRITE_APPROVED_MARKER') throw new Error('FIXTURE_OPERATION_DENIED');
}

export class ApprovedFixtureEffectExecutor {
  private readonly journal: FixtureRunnerJournal;
  private readonly ledger: FixtureEffectLedger;
  private readonly executor: FixtureProcessExecutor;
  private readonly leases: FixtureLeaseRegistry;
  private readonly active = new Map<
    string,
    { readonly controller: AbortController; readonly execution: Promise<unknown> }
  >();

  constructor(
    stateDirectory: string,
    private readonly runnerId = '70000000-0000-4000-8000-000000000001',
  ) {
    this.journal = new FixtureRunnerJournal(stateDirectory);
    this.ledger = new FixtureEffectLedger(this.journal.effects);
    this.executor = new FixtureProcessExecutor(this.ledger, this.journal);
    this.leases = new FixtureLeaseRegistry(
      this.journal.leaseOffers,
      this.journal.revokedLeaseAuthorities,
    );
  }

  get size(): number {
    return this.ledger.size;
  }

  async lookup(input: EffectAuthorityReference) {
    const result = this.ledger.lookup(input.effectId, input.actionDigest);
    if (result.outcome !== 'APPLIED') return result;
    const durable = this.journal.effects.find(({ effectId }) => effectId === input.effectId);
    if (
      durable === undefined ||
      durable.executionId !== input.executionId ||
      durable.leaseId !== input.leaseId ||
      durable.fencingToken !== input.fencingToken
    ) {
      return { outcome: 'INDETERMINATE' as const, groundTruthDigest: null };
    }
    return result;
  }

  async revoke(input: EffectAuthorityReference) {
    const running = this.active.get(input.leaseId);
    this.journal.recordLeaseRevocationAndMessage(input.messageId, input);
    this.leases.revoke(input.leaseId, input.executionId, input.fencingToken);
    running?.controller.abort();
    if (running !== undefined) await Promise.allSettled([running.execution]);
    return this.lookup(input);
  }

  async execute(input: ApprovedFixtureEffectInput) {
    assertAuthorized(input);
    const resources = {
      memoryBytes: 134_217_728,
      cpuUnits: 1,
      processLimit: 1,
      diskBytes: 8_388_608,
      maxRuntimeMs: 2_000,
      networkMode: 'DENY' as const,
      gpuUnits: 0,
    };
    const lease = {
      leaseId: input.leaseId,
      executionId: input.executionId,
      fencingToken: input.fencingToken,
      effectId: input.effectId,
      actionDigest: input.actionDigest,
      authorizedAt: input.authority.authorizedAt,
      approvalExpiresAt: input.approval.expiresAt,
      expiresAt: input.authority.leaseExpiresAt,
      resources,
    };
    const leaseMessageId = `${input.messageId}:lease`;
    if (!this.journal.hasProcessed(leaseMessageId)) {
      this.journal.recordLeaseAndMessage(leaseMessageId, {
        ...lease,
        runnerId: this.runnerId,
        revoked: false,
        consumed: false,
      });
    }
    this.leases.offer(lease, this.runnerId);
    if (
      this.leases.availableForEffect(
        input.leaseId,
        input.executionId,
        input.fencingToken,
        input.effectId,
        input.actionDigest,
      ) === null
    ) {
      throw new Error('Runner lease is not authorized for this effect or is already consumed');
    }
    this.journal.recordLeaseConsumption(input);
    this.leases.consumeEffect(
      input.leaseId,
      input.executionId,
      input.fencingToken,
      input.effectId,
      input.actionDigest,
    );
    const controller = new AbortController();
    const execution = this.executor.run(input, resources, {
      signal: controller.signal,
      isCurrent: () => this.leases.isCurrent(input.leaseId, input.executionId, input.fencingToken),
    });
    this.active.set(input.leaseId, { controller, execution });
    try {
      return await execution;
    } finally {
      this.active.delete(input.leaseId);
    }
  }
}
