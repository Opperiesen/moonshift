import type { FixtureResourceRequest } from './resources.js';
import { isRfc3339DateTime } from '@moonshift/contracts';

export type FixtureLeaseOffer = {
  readonly leaseId: string;
  readonly executionId: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
  readonly resources: FixtureResourceRequest;
};

export type DurableFixtureLeaseRecord = FixtureLeaseOffer & {
  readonly runnerId: string;
  readonly revoked: boolean;
};

type LeaseRecord = FixtureLeaseOffer & { readonly runnerId: string; revoked: boolean };

export class FixtureLeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly highestFenceByExecution = new Map<string, number>();

  constructor(records: readonly DurableFixtureLeaseRecord[] = []) {
    for (const record of records) this.accept(record, record.runnerId, record.revoked);
  }

  offer(offer: FixtureLeaseOffer, runnerId: string, now: Date): void {
    if (!isRfc3339DateTime(offer.expiresAt)) throw new Error('Invalid lease expiry timestamp');
    const expiresAt = new Date(offer.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) throw new Error('Invalid lease expiry timestamp');
    if (!(expiresAt > now)) throw new Error('Lease offer is already expired');
    this.accept(offer, runnerId, false);
  }

  private accept(offer: FixtureLeaseOffer, runnerId: string, revoked: boolean): void {
    if (!Number.isSafeInteger(offer.fencingToken) || offer.fencingToken <= 0) {
      throw new Error('Lease fencing token must be a positive safe integer');
    }
    const existing = this.leases.get(offer.leaseId);
    if (existing !== undefined) {
      if (
        existing.executionId !== offer.executionId ||
        existing.fencingToken !== offer.fencingToken ||
        existing.runnerId !== runnerId ||
        existing.expiresAt !== offer.expiresAt ||
        JSON.stringify(existing.resources) !== JSON.stringify(offer.resources)
      ) {
        throw new Error('Lease identity or fencing conflict');
      }
      if (existing.revoked || revoked) {
        throw new Error('Lease fencing token is not monotonic for the execution');
      }
      return;
    }
    const highestFence = this.highestFenceByExecution.get(offer.executionId) ?? 0;
    if (offer.fencingToken <= highestFence) {
      throw new Error('Lease fencing token is not monotonic for the execution');
    }
    for (const lease of this.leases.values()) {
      if (lease.executionId === offer.executionId) lease.revoked = true;
    }
    this.highestFenceByExecution.set(offer.executionId, offer.fencingToken);
    this.leases.set(offer.leaseId, { ...offer, runnerId, revoked });
  }

  isCurrent(leaseId: string, executionId: string, fencingToken: number, now: Date): boolean {
    return this.current(leaseId, executionId, fencingToken, now) !== null;
  }

  current(
    leaseId: string,
    executionId: string,
    fencingToken: number,
    now: Date,
  ): FixtureLeaseOffer | null {
    const lease = this.leases.get(leaseId);
    const current =
      lease !== undefined &&
      !lease.revoked &&
      lease.executionId === executionId &&
      lease.fencingToken === fencingToken &&
      new Date(lease.expiresAt) > now;
    return current ? lease : null;
  }

  revokeRunner(runnerId: string): void {
    for (const lease of this.leases.values()) {
      if (lease.runnerId === runnerId) lease.revoked = true;
    }
  }
}
