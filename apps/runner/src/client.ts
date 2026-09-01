import { createHash } from 'node:crypto';
import { connect, type ConnectionOptions } from 'node:tls';

import { planningValidators } from '@moonshift/contracts';

type Sha256Digest = `sha256:${string}`;

type ApprovedEffectExecution = {
  readonly messageId: string;
  readonly correlationId: string;
  readonly effectId: string;
  readonly actionDigest: Sha256Digest;
  readonly operation: 'WRITE_APPROVED_MARKER';
  readonly executionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly approval: {
    readonly state: 'APPROVED';
    readonly actionDigest: Sha256Digest;
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
  readonly actionDigest: Sha256Digest;
  readonly executionId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
};

type RunnerResult = {
  readonly kind: 'runner.result';
  readonly instanceId: string;
  readonly runnerId: string;
  readonly operationMessageId: string;
  readonly leaseId: string;
  readonly executionId: string;
  readonly fencingToken: number;
  readonly outcome:
    | 'APPLIED'
    | 'NOT_APPLIED'
    | 'ALREADY_APPLIED'
    | 'INDETERMINATE'
    | 'REJECTED_STALE_FENCE'
    | 'CANCELLED';
  readonly groundTruthDigest: Sha256Digest | null;
};

function uuidFrom(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function hasExclusiveRunnerIdentity(
  subjectAlternativeName: string | undefined,
  runnerId: string,
): boolean {
  const moonshiftUris =
    subjectAlternativeName
      ?.split(/,\s*/u)
      .filter((value) => value.startsWith('URI:urn:moonshift:')) ?? [];
  return moonshiftUris.length === 1 && moonshiftUris[0] === `URI:urn:moonshift:runner:${runnerId}`;
}

export class AuthenticatedFixtureRunnerClient {
  constructor(
    private readonly options: {
      readonly instanceId: string;
      readonly runnerId: string;
      readonly host: '127.0.0.1';
      readonly port: number;
      readonly tls: {
        readonly ca: Buffer | string;
        readonly cert: Buffer | string;
        readonly key: Buffer | string;
      };
      readonly now?: () => Date;
      readonly timeoutMs?: number;
    },
  ) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private async exchange(
    messages: readonly Readonly<Record<string, unknown>>[],
    operationMessageId: string,
    authority: {
      readonly leaseId: string;
      readonly executionId: string;
      readonly fencingToken: number;
    },
  ): Promise<RunnerResult> {
    const connection: ConnectionOptions = {
      host: this.options.host,
      port: this.options.port,
      ca: this.options.tls.ca,
      cert: this.options.tls.cert,
      key: this.options.tls.key,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: true,
    };
    return new Promise<RunnerResult>((resolve, reject) => {
      const socket = connect(connection);
      let settled = false;
      let buffered = '';
      const timeout = setTimeout(
        () => finish(new Error('Authenticated fixture runner timed out')),
        this.options.timeoutMs ?? 5_000,
      );
      const finish = (error: Error | null, result?: RunnerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error !== null) reject(error);
        else if (result !== undefined) resolve(result);
      };
      socket.once('error', (error) => finish(error));
      socket.once('close', () => {
        if (!settled) finish(new Error('Authenticated fixture runner closed without a result'));
      });
      socket.once('secureConnect', () => {
        if (
          !socket.authorized ||
          !hasExclusiveRunnerIdentity(
            socket.getPeerCertificate().subjectaltname,
            this.options.runnerId,
          )
        ) {
          finish(new Error('Authenticated fixture runner identity mismatch'));
          return;
        }
        socket.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(''));
      });
      socket.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          let candidate: unknown;
          try {
            candidate = JSON.parse(line);
          } catch {
            finish(new Error('Authenticated fixture runner returned invalid JSON'));
            return;
          }
          if (!planningValidators().runnerProtocol.validate(candidate)) {
            finish(new Error('Authenticated fixture runner returned an invalid protocol result'));
            return;
          }
          const result = candidate as RunnerResult;
          if (
            result.kind !== 'runner.result' ||
            result.instanceId !== this.options.instanceId ||
            result.runnerId !== this.options.runnerId ||
            result.operationMessageId !== operationMessageId ||
            result.leaseId !== authority.leaseId ||
            result.executionId !== authority.executionId ||
            result.fencingToken !== authority.fencingToken
          ) {
            finish(new Error('Authenticated fixture runner result authority mismatch'));
            return;
          }
          finish(null, result);
          return;
        }
      });
    });
  }

  async execute(input: ApprovedEffectExecution) {
    const sentAt = this.now().toISOString();
    if (input.approval.state !== 'APPROVED') throw new Error('APPROVAL_NOT_APPROVED');
    if (input.approval.actionDigest !== input.actionDigest)
      throw new Error('ACTION_DIGEST_MISMATCH');
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
    const authority = {
      leaseId: input.leaseId,
      executionId: input.executionId,
      fencingToken: input.fencingToken,
    };
    const offer = {
      schemaVersion: '1.0',
      messageId: uuidFrom(`lease:${input.messageId}`),
      kind: 'runner.lease_offer',
      instanceId: this.options.instanceId,
      runnerId: this.options.runnerId,
      correlationId: input.correlationId,
      sentAt,
      ...authority,
      effectId: input.effectId,
      actionDigest: input.actionDigest,
      authorizedAt: input.authority.authorizedAt,
      approvalExpiresAt: input.approval.expiresAt,
      expiresAt: input.authority.leaseExpiresAt,
      resources: {
        memoryBytes: 134_217_728,
        cpuUnits: 1,
        processLimit: 1,
        diskBytes: 8_388_608,
        maxRuntimeMs: 2_000,
        networkMode: 'DENY',
        gpuUnits: 0,
      },
    };
    const command = {
      schemaVersion: '1.0',
      messageId: input.messageId,
      kind: 'runner.run_fixture',
      instanceId: this.options.instanceId,
      runnerId: this.options.runnerId,
      correlationId: input.correlationId,
      sentAt,
      ...authority,
      operation: input.operation,
      effectId: input.effectId,
      actionDigest: input.actionDigest,
    };
    const result = await this.exchange([offer, command], input.messageId, authority);
    if (
      (result.outcome !== 'APPLIED' && result.outcome !== 'ALREADY_APPLIED') ||
      result.groundTruthDigest === null
    ) {
      throw new Error(`Fixture runner did not apply the approved effect: ${result.outcome}`);
    }
    return { outcome: result.outcome, groundTruthDigest: result.groundTruthDigest };
  }

  async revoke(input: EffectAuthorityReference & { readonly reason: string }) {
    const sentAt = this.now().toISOString();
    const authority = {
      leaseId: input.leaseId,
      executionId: input.executionId,
      fencingToken: input.fencingToken,
    };
    const result = await this.exchange(
      [
        {
          schemaVersion: '1.0',
          messageId: input.messageId,
          kind: 'runner.cancel',
          instanceId: this.options.instanceId,
          runnerId: this.options.runnerId,
          correlationId: input.correlationId,
          sentAt,
          ...authority,
          reason: input.reason,
        },
      ],
      input.messageId,
      authority,
    );
    return {
      outcome:
        result.outcome === 'APPLIED' || result.outcome === 'ALREADY_APPLIED'
          ? ('APPLIED' as const)
          : result.outcome === 'CANCELLED' || result.outcome === 'NOT_APPLIED'
            ? ('NOT_APPLIED' as const)
            : ('INDETERMINATE' as const),
      groundTruthDigest: result.groundTruthDigest,
    };
  }

  async lookup(input: EffectAuthorityReference) {
    const sentAt = this.now().toISOString();
    const authority = {
      leaseId: input.leaseId,
      executionId: input.executionId,
      fencingToken: input.fencingToken,
    };
    const result = await this.exchange(
      [
        {
          schemaVersion: '1.0',
          messageId: input.messageId,
          kind: 'runner.reconcile',
          instanceId: this.options.instanceId,
          runnerId: this.options.runnerId,
          correlationId: input.correlationId,
          sentAt,
          effectId: input.effectId,
          actionDigest: input.actionDigest,
          ...authority,
        },
      ],
      input.messageId,
      authority,
    );
    return {
      outcome:
        result.outcome === 'APPLIED' || result.outcome === 'ALREADY_APPLIED'
          ? ('APPLIED' as const)
          : result.outcome === 'NOT_APPLIED' || result.outcome === 'CANCELLED'
            ? ('NOT_APPLIED' as const)
            : ('INDETERMINATE' as const),
      groundTruthDigest: result.groundTruthDigest,
    };
  }
}
