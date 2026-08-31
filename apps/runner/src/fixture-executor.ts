import { spawn } from 'node:child_process';

import { FixtureRunnerJournal, type DurableFixtureEffectRecord } from './journal.js';

export type FixtureEffectRecord = {
  readonly effectId: string;
  readonly actionDigest: string;
  readonly outcome: 'APPLIED';
  readonly groundTruthDigest: `sha256:${string}`;
};

export class FixtureEffectLedger {
  private readonly records = new Map<string, FixtureEffectRecord>();

  constructor(records: readonly FixtureEffectRecord[] = []) {
    for (const record of records) this.record(record);
  }

  get size(): number {
    return this.records.size;
  }

  record(record: FixtureEffectRecord): void {
    const existing = this.records.get(record.effectId);
    if (existing !== undefined && existing.actionDigest !== record.actionDigest) {
      throw new Error('Fixture effect identity reused with another action digest');
    }
    this.records.set(record.effectId, Object.freeze(record));
  }

  lookup(
    effectId: string,
    actionDigest: string,
  ): {
    readonly outcome: 'APPLIED' | 'NOT_APPLIED' | 'INDETERMINATE';
    readonly groundTruthDigest?: string | null;
  } {
    const record = this.records.get(effectId);
    if (record === undefined) return { outcome: 'NOT_APPLIED', groundTruthDigest: null };
    if (record.actionDigest !== actionDigest)
      return { outcome: 'INDETERMINATE', groundTruthDigest: null };
    return record;
  }
}

const FIXTURE_JOB_SOURCE = String.raw`
import { createHash } from 'node:crypto';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 4096) process.exit(65);
});
process.stdin.on('end', () => {
  const command = JSON.parse(input);
  if (command.operation !== 'WRITE_APPROVED_MARKER') process.exit(66);
  setTimeout(() => {
    const groundTruthDigest = 'sha256:' + createHash('sha256')
      .update(JSON.stringify({
        effectId: command.effectId,
        actionDigest: command.actionDigest,
        marker: 'APPROVED',
      }))
      .digest('hex');
    process.stdout.write(JSON.stringify({ groundTruthDigest }));
  }, 50);
});
`;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function runIsolatedFixtureJob(
  input: { readonly operation: string; readonly effectId: string; readonly actionDigest: string },
  limits: { readonly memoryBytes: number; readonly maxRuntimeMs: number },
  signal: AbortSignal | undefined,
  onStarted: (processId: number) => void,
): Promise<{ readonly groundTruthDigest: `sha256:${string}`; readonly processId: number }> {
  if (isAborted(signal)) throw new Error('Fixture execution authority revoked');
  const oldSpaceMiB = Math.max(16, Math.floor(limits.memoryBytes / 1_048_576));
  const child = spawn(
    process.execPath,
    [
      '--permission',
      `--max-old-space-size=${oldSpaceMiB}`,
      '--input-type=module',
      '--eval',
      FIXTURE_JOB_SOURCE,
    ],
    {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: limits.maxRuntimeMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
    },
  );
  const processId = child.pid;
  if (processId === undefined) throw new Error('Fixture process did not start');
  onStarted(processId);
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  child.stdin.end(JSON.stringify(input));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > 4096) child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 4096) child.kill('SIGKILL');
  });
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (isAborted(signal)) throw new Error('Fixture execution authority revoked');
  if (exitCode !== 0) {
    throw new Error(`Fixture process failed with exit ${String(exitCode)}: ${stderr.slice(-512)}`);
  }
  const result: unknown = JSON.parse(stdout);
  if (
    result === null ||
    typeof result !== 'object' ||
    !('groundTruthDigest' in result) ||
    typeof result.groundTruthDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(result.groundTruthDigest)
  ) {
    throw new Error('Fixture process returned an invalid bounded result');
  }
  return {
    groundTruthDigest: result.groundTruthDigest as `sha256:${string}`,
    processId,
  };
}

export class FixtureProcessExecutor {
  private activeJobs = 0;
  lastProcessId: number | undefined;

  constructor(
    readonly ledger: FixtureEffectLedger,
    private readonly journal: FixtureRunnerJournal,
  ) {}

  async run(
    input: {
      readonly messageId: string;
      readonly operation: string;
      readonly effectId: string;
      readonly actionDigest: string;
      readonly executionId: string;
      readonly leaseId: string;
      readonly fencingToken: number;
    },
    limits: { readonly memoryBytes: number; readonly maxRuntimeMs: number },
    authority?: {
      readonly signal: AbortSignal;
      readonly isCurrent: () => boolean;
    },
  ) {
    this.journal.assertOperational();
    if (input.operation !== 'WRITE_APPROVED_MARKER')
      throw new Error('Unsupported fixture operation');
    if (authority !== undefined && (authority.signal.aborted || !authority.isCurrent())) {
      throw new Error('Fixture execution authority revoked');
    }
    if (this.activeJobs >= 1) throw new Error('Fixture process capacity exhausted');
    const before = this.ledger.lookup(input.effectId, input.actionDigest);
    if (before.outcome === 'INDETERMINATE') {
      this.journal.recordProcessed(input.messageId);
      return before;
    }
    if (before.outcome === 'APPLIED') {
      const existing = this.journal.effects.find(({ effectId }) => effectId === input.effectId);
      if (existing === undefined) throw new Error('Durable fixture ledger is inconsistent');
      this.journal.recordEffectAndMessage(input.messageId, {
        ...existing,
        operationMessageId: input.messageId,
        executionId: input.executionId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
      });
      return { outcome: 'ALREADY_APPLIED' as const, groundTruthDigest: before.groundTruthDigest };
    }

    this.activeJobs += 1;
    try {
      const isolated = await runIsolatedFixtureJob(
        input,
        limits,
        authority?.signal,
        (processId) => {
          this.lastProcessId = processId;
        },
      );
      if (authority !== undefined && (authority.signal.aborted || !authority.isCurrent())) {
        throw new Error('Fixture execution authority revoked');
      }
      const record: DurableFixtureEffectRecord = Object.freeze({
        effectId: input.effectId,
        actionDigest: input.actionDigest,
        outcome: 'APPLIED',
        groundTruthDigest: isolated.groundTruthDigest,
        operationMessageId: input.messageId,
        executionId: input.executionId,
        leaseId: input.leaseId,
        fencingToken: input.fencingToken,
      });
      this.journal.recordEffectAndMessage(input.messageId, record);
      this.ledger.record(record);
      return { outcome: 'APPLIED' as const, groundTruthDigest: isolated.groundTruthDigest };
    } finally {
      this.activeJobs -= 1;
    }
  }
}
