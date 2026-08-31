import { createHash } from 'node:crypto';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';

import { planningValidators } from '@moonshift/contracts';

import { FixtureEffectLedger, FixtureProcessExecutor } from './fixture-executor.js';
import { FixtureRunnerJournal, type RunnerJournalFileSystem } from './journal.js';
import { FixtureLeaseRegistry, type FixtureLeaseOffer } from './leases.js';
import {
  DEFAULT_FIXTURE_CAPACITY,
  evaluateFixtureEligibility,
  fixtureRuntimeDiscovery,
  type FixtureResourceCapacity,
} from './resources.js';

export type ControlPlaneEnrollment = {
  readonly serialNumber: string;
  readonly instanceId: string;
};

type RunnerServerOptions = {
  readonly instanceId: string;
  readonly runnerId: string;
  readonly tls: {
    readonly ca: Buffer | string;
    readonly cert: Buffer | string;
    readonly key: Buffer | string;
  };
  readonly controlPlaneEnrollments: readonly ControlPlaneEnrollment[];
  readonly stateDirectory: string;
  readonly now: () => Date;
  readonly capacity?: FixtureResourceCapacity;
  readonly journalFileSystem?: RunnerJournalFileSystem;
};

type AuthenticatedSocket = {
  readonly socket: TLSSocket;
  readonly serialNumber: string;
  readonly enrollment: ControlPlaneEnrollment;
};

function normalizeSerial(serial: string): string {
  const normalized = serial.replaceAll(':', '').replace(/^0+/u, '').toUpperCase();
  return normalized.length === 0 ? '0' : normalized;
}

function hasUriIdentity(
  subjectAlternativeName: string | undefined,
  kind: 'instance' | 'runner',
  identity: string,
): boolean {
  if (subjectAlternativeName === undefined) return false;
  const expected = `URI:urn:moonshift:${kind}:${identity}`;
  return subjectAlternativeName.split(/,\s*/u).includes(expected);
}

function hasUriKind(subjectAlternativeName: string | undefined, kind: 'instance' | 'runner') {
  return subjectAlternativeName
    ?.split(/,\s*/u)
    .some((value) => value.startsWith(`URI:urn:moonshift:${kind}:`));
}

function hasExclusiveUriIdentity(
  subjectAlternativeName: string | undefined,
  kind: 'instance' | 'runner',
  identity: string,
): boolean {
  const moonshiftUris =
    subjectAlternativeName
      ?.split(/,\s*/u)
      .filter((value) => value.startsWith('URI:urn:moonshift:')) ?? [];
  return moonshiftUris.length === 1 && moonshiftUris[0] === `URI:urn:moonshift:${kind}:${identity}`;
}

function uuidFrom(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class FixtureRunnerServer {
  readonly leaseRegistry: FixtureLeaseRegistry;
  readonly effectLedger: FixtureEffectLedger;
  readonly metrics = { handledMessages: 0, rejectedConnections: 0, rejectedMessages: 0 };
  private readonly server: Server;
  private readonly executor: FixtureProcessExecutor;
  private readonly journal: FixtureRunnerJournal;
  private readonly controlPlaneEnrollments = new Map<string, ControlPlaneEnrollment>();
  private readonly revokedSerials = new Set<string>();
  private readonly authenticatedSockets = new Set<AuthenticatedSocket>();
  private readonly acceptedMessageIds = new Set<string>();
  private readonly messageWaiters = new Map<string, Set<() => void>>();
  private readonly activeExecutionControllers = new Set<AbortController>();
  private readonly activeExecutionPromises = new Set<Promise<unknown>>();
  private readonly capacity: FixtureResourceCapacity;
  private readonly runnerCertificateSerial: string;
  private authorityQuarantined = false;
  private restartRequired = false;

  constructor(private readonly options: RunnerServerOptions) {
    this.capacity = options.capacity ?? DEFAULT_FIXTURE_CAPACITY;
    const runnerCertificate = new X509Certificate(options.tls.cert);
    if (!hasExclusiveUriIdentity(runnerCertificate.subjectAltName, 'runner', options.runnerId)) {
      throw new Error('Runner server certificate identity does not match configured runnerId');
    }
    this.runnerCertificateSerial = normalizeSerial(runnerCertificate.serialNumber);
    this.journal = new FixtureRunnerJournal(options.stateDirectory, options.journalFileSystem);
    this.journal.beginRuntimeSession();
    this.leaseRegistry = new FixtureLeaseRegistry(this.journal.leaseOffers);
    this.effectLedger = new FixtureEffectLedger(this.journal.effects);
    this.executor = new FixtureProcessExecutor(this.effectLedger, this.journal);
    const mayBootstrapConfiguredEnrollments =
      this.journal.controlPlaneEnrollments.length === 0 && !this.journal.runnerDisabled;
    for (const serialNumber of this.journal.revokedSerials) this.revokedSerials.add(serialNumber);
    for (const enrollment of this.journal.controlPlaneEnrollments) {
      this.controlPlaneEnrollments.set(enrollment.serialNumber, enrollment);
    }
    if (mayBootstrapConfiguredEnrollments) {
      for (const enrollment of options.controlPlaneEnrollments) {
        const serialNumber = normalizeSerial(enrollment.serialNumber);
        if (!this.revokedSerials.has(serialNumber)) {
          this.persistControlPlaneEnrollment(enrollment, false, false);
        }
      }
    }
    this.authorityQuarantined = this.journal.runnerDisabled;
    if (this.authorityQuarantined) this.leaseRegistry.revokeRunner(this.options.runnerId);
    this.server = createServer(
      {
        ca: options.tls.ca,
        cert: options.tls.cert,
        key: options.tls.key,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        requestCert: true,
        rejectUnauthorized: true,
      },
      (socket) => this.acceptSocket(socket),
    );
    this.server.on('tlsClientError', () => {
      this.metrics.rejectedConnections += 1;
    });
  }

  private acceptSocket(socket: TLSSocket): void {
    if (this.authorityQuarantined) {
      this.metrics.rejectedConnections += 1;
      socket.destroy();
      return;
    }
    const certificate = socket.getPeerCertificate();
    const serialNumber = normalizeSerial(certificate.serialNumber ?? '');
    const enrollment = this.controlPlaneEnrollments.get(serialNumber);
    if (
      !socket.authorized ||
      enrollment === undefined ||
      this.revokedSerials.has(serialNumber) ||
      enrollment.instanceId !== this.options.instanceId ||
      !hasUriIdentity(certificate.subjectaltname, 'instance', enrollment.instanceId) ||
      hasUriKind(certificate.subjectaltname, 'runner')
    ) {
      this.metrics.rejectedConnections += 1;
      socket.destroy();
      return;
    }
    const authenticated = { socket, serialNumber, enrollment };
    this.authenticatedSockets.add(authenticated);
    socket.once('close', () => this.authenticatedSockets.delete(authenticated));
    let buffered = '';
    let chain = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (Buffer.byteLength(buffered, 'utf8') > 65_536) {
        this.rejectMessage(socket);
        return;
      }
      for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        chain = chain
          .then(() => this.handleLine(authenticated, line))
          .catch(() => {
            if (this.journal.isDurabilityUncertain) this.failClosedUntilRestart();
            this.rejectMessage(socket);
          });
      }
    });
  }

  private rejectMessage(socket: TLSSocket): void {
    this.metrics.rejectedMessages += 1;
    socket.destroy();
  }

  private async handleLine(authenticated: AuthenticatedSocket, line: string): Promise<void> {
    if (this.authorityQuarantined) throw new Error('Runner authority is quarantined');
    if (this.revokedSerials.has(authenticated.serialNumber))
      throw new Error('Runner certificate revoked');
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      throw new Error('Invalid runner frame');
    }
    if (!planningValidators().runnerProtocol.validate(message))
      throw new Error('Invalid runner protocol message');
    const bound = message as Record<string, unknown>;
    if (
      bound.instanceId !== authenticated.enrollment.instanceId ||
      bound.runnerId !== this.options.runnerId
    ) {
      throw new Error('Runner message identity mismatch');
    }
    const messageId = bound.messageId as string;
    if (this.journal.hasProcessed(messageId)) throw new Error('Runner message replayed');

    if (bound.kind === 'runner.lease_offer') {
      const offer = bound as unknown as FixtureLeaseOffer;
      const eligibility = evaluateFixtureEligibility(offer.resources, this.capacity);
      if (!eligibility.eligible) throw new Error(eligibility.reason);
      const offeredAt = this.options.now();
      const candidateRegistry = new FixtureLeaseRegistry(this.journal.leaseOffers);
      candidateRegistry.offer(offer, this.options.runnerId, offeredAt);
      this.journal.recordLeaseAndMessage(messageId, {
        leaseId: offer.leaseId,
        executionId: offer.executionId,
        fencingToken: offer.fencingToken,
        expiresAt: offer.expiresAt,
        resources: offer.resources,
        runnerId: this.options.runnerId,
        revoked: false,
      });
      this.leaseRegistry.offer(offer, this.options.runnerId, offeredAt);
    } else if (bound.kind === 'runner.run_fixture') {
      const command = bound as {
        messageId: string;
        correlationId: string;
        leaseId: string;
        executionId: string;
        fencingToken: number;
        operation: string;
        effectId: string;
        actionDigest: string;
      };
      const lease = this.leaseRegistry.current(
        command.leaseId,
        command.executionId,
        command.fencingToken,
        this.options.now(),
      );
      if (lease === null) {
        throw new Error('Stale or invalid runner lease fence');
      }
      const controller = new AbortController();
      this.activeExecutionControllers.add(controller);
      const executionPromise = this.executor.run(
        command,
        {
          memoryBytes: lease.resources.memoryBytes,
          maxRuntimeMs: lease.resources.maxRuntimeMs,
        },
        {
          signal: controller.signal,
          isCurrent: () =>
            !this.revokedSerials.has(authenticated.serialNumber) &&
            this.leaseRegistry.isCurrent(
              command.leaseId,
              command.executionId,
              command.fencingToken,
              this.options.now(),
            ),
        },
      );
      this.activeExecutionPromises.add(executionPromise);
      const execution = await executionPromise.finally(() => {
        this.activeExecutionControllers.delete(controller);
        this.activeExecutionPromises.delete(executionPromise);
      });
      const result = {
        schemaVersion: '1.0',
        messageId: uuidFrom(`runner-result:${command.messageId}`),
        kind: 'runner.result',
        instanceId: authenticated.enrollment.instanceId,
        runnerId: this.options.runnerId,
        correlationId: command.correlationId,
        sentAt: this.options.now().toISOString(),
        operationMessageId: command.messageId,
        leaseId: command.leaseId,
        executionId: command.executionId,
        fencingToken: command.fencingToken,
        outcome: execution.outcome,
        groundTruthDigest: execution.groundTruthDigest,
      };
      if (!planningValidators().runnerProtocol.validate(result))
        throw new Error('Runner produced invalid result');
      authenticated.socket.write(`${JSON.stringify(result)}\n`);
    } else {
      throw new Error('Runner daemon accepts only lease offers and fixture commands');
    }
    this.metrics.handledMessages += 1;
    this.acceptedMessageIds.add(messageId);
    const waiters = this.messageWaiters.get(messageId);
    if (waiters !== undefined) {
      for (const waiter of waiters) waiter();
      this.messageWaiters.delete(messageId);
    }
  }

  async listen(): Promise<{ readonly host: '127.0.0.1'; readonly port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Runner did not bind a loopback TCP port');
    return { host: '127.0.0.1', port: address.port };
  }

  private persistControlPlaneEnrollment(
    enrollment: ControlPlaneEnrollment,
    reactivateDisabledRunner: boolean,
    failClosedOnError: boolean,
  ): void {
    const normalized: ControlPlaneEnrollment = {
      ...enrollment,
      serialNumber: normalizeSerial(enrollment.serialNumber),
    };
    if (normalized.instanceId !== this.options.instanceId) {
      throw new Error('Control-plane enrollment belongs to another Moonshift instance');
    }
    if (this.revokedSerials.has(normalized.serialNumber)) {
      throw new Error('Revoked control-plane certificate cannot be re-enrolled');
    }
    const existing = this.controlPlaneEnrollments.get(normalized.serialNumber);
    if (reactivateDisabledRunner && existing !== undefined) {
      throw new Error('Runner reactivation requires a new control-plane certificate');
    }
    if (existing !== undefined) {
      if (existing.instanceId !== normalized.instanceId) {
        throw new Error('Control-plane certificate serial is already bound to another identity');
      }
      return;
    }
    try {
      this.journal.recordControlPlaneEnrollment(normalized, {
        reactivateDisabledRunner,
      });
    } catch (error) {
      if (failClosedOnError && this.journal.isDurabilityUncertain) {
        this.failClosedUntilRestart();
      }
      throw error;
    }
    if (reactivateDisabledRunner) this.controlPlaneEnrollments.clear();
    this.controlPlaneEnrollments.set(normalized.serialNumber, Object.freeze(normalized));
  }

  enrollControlPlaneCertificate(enrollment: ControlPlaneEnrollment): void {
    if (this.restartRequired) {
      throw new Error('Runner restart and reconciliation required before enrollment');
    }
    const reactivateDisabledRunner = this.journal.runnerDisabled;
    this.persistControlPlaneEnrollment(enrollment, reactivateDisabledRunner, true);
    if (reactivateDisabledRunner) this.authorityQuarantined = false;
  }

  private failClosedUntilRestart(): void {
    this.restartRequired = true;
    this.authorityQuarantined = true;
    this.leaseRegistry.revokeRunner(this.options.runnerId);
    for (const controller of this.activeExecutionControllers) controller.abort();
    for (const authenticated of this.authenticatedSockets) authenticated.socket.destroy();
    if (this.server.listening) this.server.close();
  }

  registration() {
    return Object.freeze({
      schemaVersion: '1.0',
      messageId: uuidFrom(`runner-register:${this.options.instanceId}:${this.options.runnerId}`),
      kind: 'runner.register',
      instanceId: this.options.instanceId,
      runnerId: this.options.runnerId,
      correlationId: uuidFrom(`runner-register-correlation:${this.options.runnerId}`),
      sentAt: this.options.now().toISOString(),
      runnerVersion: '1.0.0',
      certificateSerial: this.runnerCertificateSerial,
      profile: 'FIXTURE_PROCESS',
      capabilities: this.capacity,
      runtimeDiscovery: fixtureRuntimeDiscovery(),
    });
  }

  get lastFixtureProcessId(): number | undefined {
    return this.executor.lastProcessId;
  }

  get isAuthorityQuarantined(): boolean {
    return this.authorityQuarantined;
  }

  async revokeControlPlaneCertificate(serialNumber: string): Promise<void> {
    const normalized = normalizeSerial(serialNumber);
    const enrollment = this.controlPlaneEnrollments.get(normalized);
    if (enrollment === undefined) {
      throw new Error('Unknown control-plane certificate serial');
    }
    this.authorityQuarantined = true;
    this.revokedSerials.add(normalized);
    this.leaseRegistry.revokeRunner(this.options.runnerId);
    for (const controller of this.activeExecutionControllers) controller.abort();
    for (const authenticated of this.authenticatedSockets) authenticated.socket.destroy();
    try {
      this.journal.beginRevocation();
      this.journal.recordRevocation(normalized);
    } catch (error) {
      this.failClosedUntilRestart();
      throw error;
    }
    await Promise.allSettled([...this.activeExecutionPromises]);
  }

  async waitForMessage(messageId: string): Promise<void> {
    if (this.acceptedMessageIds.has(messageId)) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Runner did not accept ${messageId}`)),
        2_000,
      );
      const waiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      const waiters = this.messageWaiters.get(messageId) ?? new Set<() => void>();
      waiters.add(waiter);
      this.messageWaiters.set(messageId, waiters);
    });
  }

  async close(): Promise<void> {
    this.leaseRegistry.revokeRunner(this.options.runnerId);
    for (const controller of this.activeExecutionControllers) controller.abort();
    for (const authenticated of this.authenticatedSockets) authenticated.socket.destroy();
    await Promise.allSettled([...this.activeExecutionPromises]);
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) =>
        this.server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    if (
      !this.restartRequired &&
      !this.journal.isDurabilityUncertain &&
      (!this.authorityQuarantined || this.journal.isRunnerDurablyDisabled)
    ) {
      this.journal.endRuntimeSession();
    }
  }
}
