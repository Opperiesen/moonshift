import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { isRfc3339DateTime, isUuid } from '@moonshift/contracts';

import type { FixtureEffectRecord } from './fixture-executor.js';
import type { DurableFixtureLeaseRecord } from './leases.js';
import type { ControlPlaneEnrollment } from './server.js';

export type DurableFixtureEffectRecord = FixtureEffectRecord & {
  readonly operationMessageId: string;
  readonly executionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
};

type RunnerSnapshot = {
  readonly version: 1;
  readonly runnerDisabled: boolean;
  readonly controlPlaneEnrollments: readonly ControlPlaneEnrollment[];
  readonly revokedSerials: readonly string[];
  readonly processedMessageIds: readonly string[];
  readonly effects: readonly DurableFixtureEffectRecord[];
  readonly leaseOffers: readonly DurableFixtureLeaseRecord[];
};

const EMPTY_SNAPSHOT: RunnerSnapshot = Object.freeze({
  version: 1,
  runnerDisabled: false,
  controlPlaneEnrollments: [],
  revokedSerials: [],
  processedMessageIds: [],
  effects: [],
  leaseOffers: [],
});

export type RunnerJournalFileSystem = {
  readonly openSync: typeof openSync;
  readonly writeSync: typeof import('node:fs').writeSync;
  readonly fsyncSync: typeof fsyncSync;
  readonly closeSync: typeof closeSync;
  readonly renameSync: typeof renameSync;
  readonly unlinkSync: typeof unlinkSync;
};

const DEFAULT_FILE_SYSTEM: RunnerJournalFileSystem = {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
};

type DirectoryIdentity = {
  readonly dev: number;
  readonly ino: number;
};

function sameDirectoryIdentity(first: DirectoryIdentity, second: DirectoryIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function openStateDirectory(path: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Runner journal state directory must be a regular non-symlink directory');
  }
}

function assertTrustedDirectory(info: Stats, effectiveUid: number): void {
  const permissions = info.mode & 0o7777;
  const trustedOwner = info.uid === effectiveUid || info.uid === 0;
  const writableByAnotherClass = (permissions & 0o022) !== 0;
  const sticky = (permissions & 0o1000) !== 0;
  if (!info.isDirectory() || !trustedOwner || (writableByAnotherClass && !sticky)) {
    throw new Error('Runner journal state directory ancestry is replaceable by another user');
  }
}

function validateDirectoryChain(start: string, effectiveUid: number): void {
  let current = start;
  for (;;) {
    const descriptor = openStateDirectory(current);
    try {
      assertTrustedDirectory(fstatSync(descriptor), effectiveUid);
    } finally {
      closeSync(descriptor);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function prepareStateDirectory(
  requestedPath: string,
  effectiveUid: number,
): { readonly path: string; readonly descriptor: number; readonly identity: DirectoryIdentity } {
  const lexicalPath = resolve(requestedPath);
  if (existsSync(lexicalPath)) {
    const lexicalInfo = lstatSync(lexicalPath);
    if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isDirectory()) {
      throw new Error('Runner journal state directory must be a regular non-symlink directory');
    }
  } else {
    let canonicalParent: string;
    try {
      canonicalParent = realpathSync(dirname(lexicalPath));
    } catch {
      throw new Error('Runner journal state directory parent must already exist');
    }
    validateDirectoryChain(canonicalParent, effectiveUid);
    mkdirSync(join(canonicalParent, basename(lexicalPath)), { recursive: false, mode: 0o700 });
  }

  const canonicalPath = realpathSync(lexicalPath);
  validateDirectoryChain(dirname(canonicalPath), effectiveUid);
  const descriptor = openStateDirectory(canonicalPath);
  const info = fstatSync(descriptor);
  if (!info.isDirectory() || info.uid !== effectiveUid || (info.mode & 0o777) !== 0o700) {
    closeSync(descriptor);
    throw new Error('Runner journal state directory must be owner-owned with mode 0700');
  }
  return { path: canonicalPath, descriptor, identity: { dev: info.dev, ino: info.ino } };
}

function readOwnedSnapshot(path: string, effectiveUid: number): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Runner journal snapshot must be a regular non-symlink file');
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== effectiveUid || (info.mode & 0o777) !== 0o600) {
      throw new Error('Runner journal snapshot must be owner-owned with mode 0600');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function assertSnapshot(value: unknown): asserts value is RunnerSnapshot {
  if (value === null || typeof value !== 'object') throw new Error('Invalid runner journal');
  const snapshot = value as Partial<RunnerSnapshot>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.runnerDisabled !== 'boolean' ||
    !Array.isArray(snapshot.controlPlaneEnrollments) ||
    !Array.isArray(snapshot.revokedSerials) ||
    !snapshot.revokedSerials.every((serial) => typeof serial === 'string') ||
    !Array.isArray(snapshot.processedMessageIds) ||
    !snapshot.processedMessageIds.every((messageId) => typeof messageId === 'string') ||
    !Array.isArray(snapshot.effects) ||
    !Array.isArray(snapshot.leaseOffers)
  ) {
    throw new Error('Invalid runner journal');
  }
  for (const enrollment of snapshot.controlPlaneEnrollments) {
    if (
      enrollment === null ||
      typeof enrollment !== 'object' ||
      typeof enrollment.serialNumber !== 'string' ||
      typeof enrollment.instanceId !== 'string'
    ) {
      throw new Error('Invalid control-plane enrollment journal entry');
    }
  }
  for (const effect of snapshot.effects) {
    if (
      effect === null ||
      typeof effect !== 'object' ||
      typeof effect.effectId !== 'string' ||
      typeof effect.actionDigest !== 'string' ||
      effect.outcome !== 'APPLIED' ||
      typeof effect.groundTruthDigest !== 'string' ||
      typeof effect.operationMessageId !== 'string' ||
      typeof effect.executionId !== 'string' ||
      typeof effect.leaseId !== 'string' ||
      !Number.isSafeInteger(effect.fencingToken) ||
      effect.fencingToken <= 0
    ) {
      throw new Error('Invalid runner effect journal entry');
    }
  }
  const leaseIds = new Set<string>();
  const highestFenceByExecution = new Map<string, number>();
  for (const lease of snapshot.leaseOffers) {
    const resourceKeys =
      lease !== null && typeof lease === 'object' && lease.resources !== null
        ? Object.keys(lease.resources).sort()
        : [];
    if (
      lease === null ||
      typeof lease !== 'object' ||
      Object.keys(lease).sort().join(',') !==
        'executionId,expiresAt,fencingToken,leaseId,resources,revoked,runnerId' ||
      !isUuid(lease.leaseId) ||
      !isUuid(lease.executionId) ||
      !isUuid(lease.runnerId) ||
      !Number.isSafeInteger(lease.fencingToken) ||
      lease.fencingToken <= 0 ||
      !isRfc3339DateTime(lease.expiresAt) ||
      lease.resources === null ||
      typeof lease.resources !== 'object' ||
      resourceKeys.join(',') !==
        'cpuUnits,diskBytes,gpuUnits,maxRuntimeMs,memoryBytes,networkMode,processLimit' ||
      !Number.isSafeInteger(lease.resources.memoryBytes) ||
      lease.resources.memoryBytes <= 0 ||
      !Number.isSafeInteger(lease.resources.cpuUnits) ||
      lease.resources.cpuUnits <= 0 ||
      !Number.isSafeInteger(lease.resources.processLimit) ||
      lease.resources.processLimit <= 0 ||
      !Number.isSafeInteger(lease.resources.diskBytes) ||
      lease.resources.diskBytes <= 0 ||
      !Number.isSafeInteger(lease.resources.maxRuntimeMs) ||
      lease.resources.maxRuntimeMs <= 0 ||
      lease.resources.maxRuntimeMs > 600_000 ||
      lease.resources.networkMode !== 'DENY' ||
      lease.resources.gpuUnits !== 0 ||
      typeof lease.revoked !== 'boolean' ||
      leaseIds.has(lease.leaseId) ||
      lease.fencingToken <= (highestFenceByExecution.get(lease.executionId) ?? 0)
    ) {
      throw new Error('Invalid runner lease journal entry');
    }
    leaseIds.add(lease.leaseId);
    highestFenceByExecution.set(lease.executionId, lease.fencingToken);
  }
}

export class FixtureRunnerJournal {
  private readonly snapshotPath: string;
  private readonly pendingRevocationPath: string;
  private readonly runtimeSessionPath: string;
  private readonly stateDirectory: string;
  private readonly stateDirectoryDescriptor: number;
  private readonly stateDirectoryIdentity: DirectoryIdentity;
  private readonly effectiveUid: number;
  private readonly fileSystem: RunnerJournalFileSystem;
  private snapshot: RunnerSnapshot;
  private writeSequence = 0;
  private durabilityUncertain = false;
  private runtimeSessionStarted = false;
  private uncleanRuntimeSessionDetected = false;

  constructor(stateDirectory: string, fileSystem: RunnerJournalFileSystem = DEFAULT_FILE_SYSTEM) {
    const effectiveUid = process.geteuid?.();
    if (effectiveUid === undefined) {
      throw new Error('Runner journal requires effective-UID ownership checks');
    }
    const preparedDirectory = prepareStateDirectory(stateDirectory, effectiveUid);
    this.stateDirectory = preparedDirectory.path;
    this.stateDirectoryDescriptor = preparedDirectory.descriptor;
    this.stateDirectoryIdentity = preparedDirectory.identity;
    this.effectiveUid = effectiveUid;
    this.fileSystem = fileSystem;
    this.snapshotPath = join(this.stateDirectory, 'runner-state.json');
    this.pendingRevocationPath = join(this.stateDirectory, 'runner-revocation-pending');
    this.runtimeSessionPath = join(this.stateDirectory, 'runner-runtime-active');
    try {
      if (existsSync(this.snapshotPath)) {
        const parsed: unknown = JSON.parse(readOwnedSnapshot(this.snapshotPath, effectiveUid));
        assertSnapshot(parsed);
        this.snapshot = parsed;
      } else {
        this.snapshot = EMPTY_SNAPSHOT;
        this.persist(this.snapshot);
      }
    } catch (error) {
      closeSync(this.stateDirectoryDescriptor);
      throw error;
    }
  }

  get controlPlaneEnrollments(): readonly ControlPlaneEnrollment[] {
    this.assertOperational();
    return this.snapshot.controlPlaneEnrollments;
  }

  get runnerDisabled(): boolean {
    this.assertOperational();
    return (
      this.snapshot.runnerDisabled ||
      existsSync(this.pendingRevocationPath) ||
      this.uncleanRuntimeSessionDetected
    );
  }

  get isRunnerDurablyDisabled(): boolean {
    this.assertOperational();
    return this.snapshot.runnerDisabled;
  }

  get isDurabilityUncertain(): boolean {
    if (!this.durabilityUncertain) {
      try {
        this.assertStateDirectoryIdentity();
      } catch {
        this.durabilityUncertain = true;
      }
    }
    return this.durabilityUncertain;
  }

  get effects(): readonly DurableFixtureEffectRecord[] {
    this.assertOperational();
    return this.snapshot.effects;
  }

  get revokedSerials(): readonly string[] {
    this.assertOperational();
    return this.snapshot.revokedSerials;
  }

  get leaseOffers(): readonly DurableFixtureLeaseRecord[] {
    this.assertOperational();
    return this.snapshot.leaseOffers;
  }

  isRevoked(serialNumber: string): boolean {
    this.assertOperational();
    return this.snapshot.revokedSerials.includes(serialNumber);
  }

  hasProcessed(messageId: string): boolean {
    this.assertOperational();
    return this.snapshot.processedMessageIds.includes(messageId);
  }

  assertOperational(): void {
    if (this.durabilityUncertain) {
      throw new Error('Runner journal durability is uncertain; restart and reconcile before retry');
    }
    try {
      this.assertStateDirectoryIdentity();
    } catch (error) {
      this.durabilityUncertain = true;
      throw error;
    }
  }

  beginRuntimeSession(): void {
    this.assertOperational();
    if (this.runtimeSessionStarted) return;
    this.uncleanRuntimeSessionDetected = existsSync(this.runtimeSessionPath);
    if (!this.uncleanRuntimeSessionDetected) {
      let descriptor: number | undefined;
      try {
        descriptor = this.fileSystem.openSync(this.runtimeSessionPath, 'wx', 0o600);
        const bytes = Buffer.from('runner authority session active\n', 'utf8');
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = this.fileSystem.writeSync(descriptor, bytes, offset);
          if (written <= 0) throw new Error('Runner session marker write made no progress');
          offset += written;
        }
        this.fileSystem.fsyncSync(descriptor);
        this.fileSystem.closeSync(descriptor);
        descriptor = undefined;
        this.syncStateDirectory();
      } catch (error) {
        this.durabilityUncertain = true;
        throw error;
      } finally {
        if (descriptor !== undefined) this.fileSystem.closeSync(descriptor);
      }
    }
    this.runtimeSessionStarted = true;
  }

  endRuntimeSession(): void {
    this.assertOperational();
    if (!this.runtimeSessionStarted) return;
    try {
      this.fileSystem.unlinkSync(this.runtimeSessionPath);
      this.syncStateDirectory();
      this.runtimeSessionStarted = false;
      this.uncleanRuntimeSessionDetected = false;
    } catch (error) {
      this.durabilityUncertain = true;
      throw error;
    }
  }

  recordControlPlaneEnrollment(
    enrollment: ControlPlaneEnrollment,
    options: { readonly reactivateDisabledRunner?: boolean } = {},
  ): void {
    this.assertOperational();
    const reactivate = options.reactivateDisabledRunner === true && this.runnerDisabled;
    const existing = this.snapshot.controlPlaneEnrollments.find(
      ({ serialNumber }) => serialNumber === enrollment.serialNumber,
    );
    if (existing !== undefined && !reactivate) {
      if (existing.instanceId !== enrollment.instanceId) {
        throw new Error('Control-plane certificate serial is already bound to another identity');
      }
      return;
    }
    this.replace({
      ...this.snapshot,
      runnerDisabled: reactivate ? false : this.snapshot.runnerDisabled,
      controlPlaneEnrollments: reactivate
        ? [enrollment]
        : [...this.snapshot.controlPlaneEnrollments, enrollment],
    });
    if (reactivate) {
      this.clearPendingRevocation();
      this.uncleanRuntimeSessionDetected = false;
    }
  }

  beginRevocation(): void {
    this.assertOperational();
    if (existsSync(this.pendingRevocationPath)) return;
    let descriptor: number | undefined;
    try {
      descriptor = this.fileSystem.openSync(this.pendingRevocationPath, 'wx', 0o600);
      const bytes = Buffer.from('runner authority disabled pending durable revocation\n', 'utf8');
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = this.fileSystem.writeSync(descriptor, bytes, offset);
        if (written <= 0) throw new Error('Runner revocation marker write made no progress');
        offset += written;
      }
      this.fileSystem.fsyncSync(descriptor);
      this.fileSystem.closeSync(descriptor);
      descriptor = undefined;
      this.syncStateDirectory();
    } catch (error) {
      this.durabilityUncertain = true;
      throw error;
    } finally {
      if (descriptor !== undefined) this.fileSystem.closeSync(descriptor);
    }
  }

  recordRevocation(serialNumber: string): void {
    const alreadyRevoked = this.isRevoked(serialNumber);
    const hasActiveLease = this.snapshot.leaseOffers.some(({ revoked }) => !revoked);
    if (alreadyRevoked && !hasActiveLease) return;
    this.replace({
      ...this.snapshot,
      runnerDisabled: true,
      revokedSerials: alreadyRevoked
        ? this.snapshot.revokedSerials
        : [...this.snapshot.revokedSerials, serialNumber],
      leaseOffers: this.snapshot.leaseOffers.map((lease) =>
        lease.revoked ? lease : { ...lease, revoked: true },
      ),
    });
    this.clearPendingRevocation();
  }

  recordProcessed(messageId: string): void {
    if (this.hasProcessed(messageId)) throw new Error('Runner message replayed');
    this.replace({
      ...this.snapshot,
      processedMessageIds: [...this.snapshot.processedMessageIds, messageId],
    });
  }

  recordEffectAndMessage(messageId: string, effect: DurableFixtureEffectRecord): void {
    if (this.hasProcessed(messageId)) throw new Error('Runner message replayed');
    if (!Number.isSafeInteger(effect.fencingToken) || effect.fencingToken <= 0) {
      throw new Error('Fixture effect fencing token must be a positive safe integer');
    }
    const existing = this.snapshot.effects.find(({ effectId }) => effectId === effect.effectId);
    if (existing !== undefined && existing.actionDigest !== effect.actionDigest) {
      throw new Error('Fixture effect identity reused with another action digest');
    }
    if (
      existing !== undefined &&
      (existing.executionId !== effect.executionId ||
        existing.leaseId !== effect.leaseId ||
        existing.fencingToken !== effect.fencingToken)
    ) {
      throw new Error('Fixture effect authority binding conflicts with its durable application');
    }
    if (existing !== undefined && existing.groundTruthDigest !== effect.groundTruthDigest) {
      throw new Error('Fixture effect ground truth conflicts with its durable application');
    }
    this.replace({
      ...this.snapshot,
      processedMessageIds: [...this.snapshot.processedMessageIds, messageId],
      effects: existing === undefined ? [...this.snapshot.effects, effect] : this.snapshot.effects,
    });
  }

  recordLeaseAndMessage(messageId: string, lease: DurableFixtureLeaseRecord): void {
    if (this.hasProcessed(messageId)) throw new Error('Runner message replayed');
    if (!Number.isSafeInteger(lease.fencingToken) || lease.fencingToken <= 0) {
      throw new Error('Lease fencing token must be a positive safe integer');
    }
    const existing = this.snapshot.leaseOffers.find(({ leaseId }) => leaseId === lease.leaseId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(lease)) {
      throw new Error('Lease identity or fencing conflict');
    }
    const highestFence = this.snapshot.leaseOffers
      .filter(({ executionId }) => executionId === lease.executionId)
      .reduce((highest, candidate) => Math.max(highest, candidate.fencingToken), 0);
    if (existing === undefined && lease.fencingToken <= highestFence) {
      throw new Error('Lease fencing token is not monotonic for the execution');
    }
    const supersededLeaseOffers =
      existing === undefined
        ? this.snapshot.leaseOffers.map((candidate) =>
            candidate.executionId === lease.executionId && !candidate.revoked
              ? { ...candidate, revoked: true }
              : candidate,
          )
        : this.snapshot.leaseOffers;
    this.replace({
      ...this.snapshot,
      processedMessageIds: [...this.snapshot.processedMessageIds, messageId],
      leaseOffers:
        existing === undefined ? [...supersededLeaseOffers, lease] : supersededLeaseOffers,
    });
  }

  private replace(snapshot: RunnerSnapshot): void {
    this.assertOperational();
    this.persist(snapshot);
    this.snapshot = snapshot;
  }

  private clearPendingRevocation(): void {
    this.assertOperational();
    if (!existsSync(this.pendingRevocationPath)) return;
    try {
      this.fileSystem.unlinkSync(this.pendingRevocationPath);
      this.syncStateDirectory();
    } catch (error) {
      this.durabilityUncertain = true;
      throw error;
    }
  }

  private syncStateDirectory(): void {
    this.assertStateDirectoryIdentity();
    const directoryFd = this.fileSystem.openSync(this.stateDirectory, 'r');
    try {
      if (!sameDirectoryIdentity(this.stateDirectoryIdentity, fstatSync(directoryFd))) {
        throw new Error('Runner journal state directory changed during a durable write');
      }
      this.fileSystem.fsyncSync(directoryFd);
    } finally {
      this.fileSystem.closeSync(directoryFd);
    }
    this.assertStateDirectoryIdentity();
  }

  private persist(snapshot: RunnerSnapshot): void {
    this.assertStateDirectoryIdentity();
    this.writeSequence += 1;
    const temporaryPath = `${this.snapshotPath}.${process.pid}.${this.writeSequence}.tmp`;
    let temporaryFd: number | undefined;
    let renamed = false;
    try {
      temporaryFd = this.fileSystem.openSync(temporaryPath, 'wx', 0o600);
      const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = this.fileSystem.writeSync(temporaryFd, bytes, offset);
        if (written <= 0) throw new Error('Runner journal temporary write made no progress');
        offset += written;
      }
      this.fileSystem.fsyncSync(temporaryFd);
      try {
        this.fileSystem.closeSync(temporaryFd);
      } finally {
        temporaryFd = undefined;
      }

      this.fileSystem.renameSync(temporaryPath, this.snapshotPath);
      renamed = true;
      chmodSync(this.snapshotPath, 0o600);
      this.syncStateDirectory();
    } catch (error) {
      if (renamed) this.durabilityUncertain = true;
      throw error;
    } finally {
      if (temporaryFd !== undefined) this.fileSystem.closeSync(temporaryFd);
      if (!renamed) {
        try {
          this.fileSystem.unlinkSync(temporaryPath);
        } catch {
          // The temporary file may not have been created, or may already be gone.
        }
      }
    }
  }

  private assertStateDirectoryIdentity(): void {
    const pinned = fstatSync(this.stateDirectoryDescriptor);
    if (
      !sameDirectoryIdentity(this.stateDirectoryIdentity, pinned) ||
      !pinned.isDirectory() ||
      pinned.uid !== this.effectiveUid ||
      (pinned.mode & 0o777) !== 0o700
    ) {
      throw new Error('Runner journal pinned state directory identity is no longer trustworthy');
    }
    const currentDescriptor = openStateDirectory(this.stateDirectory);
    try {
      const current = fstatSync(currentDescriptor);
      if (!sameDirectoryIdentity(this.stateDirectoryIdentity, current)) {
        throw new Error('Runner journal state directory changed during operation');
      }
    } finally {
      closeSync(currentDescriptor);
    }
  }
}
