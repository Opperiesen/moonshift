import { isRfc3339DateTime } from '@moonshift/contracts';

import type { FixtureResourceRequest } from './resources.js';

export type FixtureLeaseOffer = {
  readonly leaseId: string;
  readonly executionId: string;
  readonly fencingToken: number;
  readonly effectId: string;
  readonly actionDigest: string;
  readonly authorizedAt: string;
  readonly approvalExpiresAt: string;
  readonly expiresAt: string;
  readonly resources: FixtureResourceRequest;
};

export type DurableFixtureLeaseRecord = FixtureLeaseOffer & {
  readonly runnerId: string;
  readonly revoked: boolean;
  readonly consumed: boolean;
};

export type FixtureLeaseFence = {
  readonly leaseId: string;
  readonly executionId: string;
  readonly fencingToken: number;
};

type LeaseRecord = FixtureLeaseOffer & {
  readonly runnerId: string;
  revoked: boolean;
  consumed: boolean;
};

export class FixtureLeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly highestAuthorityByExecution = new Map<string, FixtureLeaseFence>();
  private readonly revokedAuthorities = new Map<string, FixtureLeaseFence>();

  constructor(
    records: readonly DurableFixtureLeaseRecord[] = [],
    revokedAuthorities: readonly FixtureLeaseFence[] = [],
  ) {
    for (const record of records)
      this.accept(record, record.runnerId, record.revoked, record.consumed);
    for (const authority of revokedAuthorities) {
      this.revoke(authority.leaseId, authority.executionId, authority.fencingToken);
    }
  }

  offer(offer: FixtureLeaseOffer, runnerId: string): void {
    if (
      !isRfc3339DateTime(offer.authorizedAt) ||
      !isRfc3339DateTime(offer.approvalExpiresAt) ||
      !isRfc3339DateTime(offer.expiresAt)
    ) {
      throw new Error('Invalid lease authority timestamp');
    }
    const authorizedAt = Date.parse(offer.authorizedAt);
    if (
      authorizedAt >= Date.parse(offer.approvalExpiresAt) ||
      authorizedAt >= Date.parse(offer.expiresAt)
    ) {
      throw new Error('Lease was not authorized before approval and authority expiry');
    }
    this.accept(offer, runnerId, false, false);
  }

  private accept(
    offer: FixtureLeaseOffer,
    runnerId: string,
    revoked: boolean,
    consumed: boolean,
  ): void {
    if (!Number.isSafeInteger(offer.fencingToken) || offer.fencingToken <= 0) {
      throw new Error('Lease fencing token must be a positive safe integer');
    }
    const existing = this.leases.get(offer.leaseId);
    if (existing !== undefined) {
      if (
        existing.executionId !== offer.executionId ||
        existing.fencingToken !== offer.fencingToken ||
        existing.effectId !== offer.effectId ||
        existing.actionDigest !== offer.actionDigest ||
        existing.runnerId !== runnerId ||
        existing.authorizedAt !== offer.authorizedAt ||
        existing.approvalExpiresAt !== offer.approvalExpiresAt ||
        existing.expiresAt !== offer.expiresAt ||
        JSON.stringify(existing.resources) !== JSON.stringify(offer.resources)
      ) {
        throw new Error('Lease identity or fencing conflict');
      }
      if (existing.revoked || revoked) {
        throw new Error('Lease fencing token is not monotonic for the execution');
      }
      if (existing.consumed || consumed) throw new Error('Runner lease is already consumed');
      return;
    }
    const highestAuthority = this.highestAuthorityByExecution.get(offer.executionId);
    if (offer.fencingToken <= (highestAuthority?.fencingToken ?? 0)) {
      throw new Error('Lease fencing token is not monotonic for the execution');
    }
    for (const lease of this.leases.values()) {
      if (lease.executionId === offer.executionId) lease.revoked = true;
    }
    this.highestAuthorityByExecution.set(offer.executionId, {
      leaseId: offer.leaseId,
      executionId: offer.executionId,
      fencingToken: offer.fencingToken,
    });
    this.revokedAuthorities.delete(offer.executionId);
    this.leases.set(offer.leaseId, { ...offer, runnerId, revoked, consumed });
  }

  isCurrent(leaseId: string, executionId: string, fencingToken: number): boolean {
    return this.current(leaseId, executionId, fencingToken) !== null;
  }

  current(leaseId: string, executionId: string, fencingToken: number): FixtureLeaseOffer | null {
    const lease = this.leases.get(leaseId);
    const current =
      lease !== undefined &&
      !lease.revoked &&
      lease.executionId === executionId &&
      lease.fencingToken === fencingToken;
    return current ? lease : null;
  }

  availableForEffect(
    leaseId: string,
    executionId: string,
    fencingToken: number,
    effectId: string,
    actionDigest: string,
  ): FixtureLeaseOffer | null {
    const lease = this.current(leaseId, executionId, fencingToken);
    return lease !== null &&
      !this.leases.get(leaseId)?.consumed &&
      lease.effectId === effectId &&
      lease.actionDigest === actionDigest
      ? lease
      : null;
  }

  consumeEffect(
    leaseId: string,
    executionId: string,
    fencingToken: number,
    effectId: string,
    actionDigest: string,
  ): void {
    if (
      this.availableForEffect(leaseId, executionId, fencingToken, effectId, actionDigest) === null
    ) {
      throw new Error('Runner lease is not authorized for this effect or is already consumed');
    }
    const lease = this.leases.get(leaseId);
    if (lease === undefined) throw new Error('Runner lease disappeared before consumption');
    lease.consumed = true;
  }

  revoke(leaseId: string, executionId: string, fencingToken: number): void {
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
      throw new Error('Lease fencing token must be a positive safe integer');
    }
    const lease = this.leases.get(leaseId);
    if (
      lease !== undefined &&
      (lease.executionId !== executionId || lease.fencingToken !== fencingToken)
    ) {
      throw new Error('Stale or invalid runner lease fence');
    }
    const highestAuthority = this.highestAuthorityByExecution.get(executionId);
    if (
      highestAuthority !== undefined &&
      (fencingToken < highestAuthority.fencingToken ||
        (fencingToken === highestAuthority.fencingToken && leaseId !== highestAuthority.leaseId))
    ) {
      throw new Error('Stale or invalid runner lease fence');
    }
    for (const candidate of this.leases.values()) {
      if (candidate.executionId === executionId && candidate.fencingToken <= fencingToken) {
        candidate.revoked = true;
      }
    }
    const authority = Object.freeze({ leaseId, executionId, fencingToken });
    this.highestAuthorityByExecution.set(executionId, authority);
    this.revokedAuthorities.set(executionId, authority);
  }

  revokeRunner(runnerId: string): void {
    for (const lease of this.leases.values()) {
      if (lease.runnerId === runnerId) lease.revoked = true;
    }
  }
}
