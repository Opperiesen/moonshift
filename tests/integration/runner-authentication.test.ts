import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { connect as connectPlain } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import * as fileSystem from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_FIXTURE_CAPACITY,
  FixtureEffectLedger,
  FixtureLeaseRegistry,
  FixtureProcessExecutor,
  FixtureRunnerJournal,
  type RunnerJournalFileSystem,
  FixtureRunnerServer,
  evaluateFixtureEligibility,
  fixtureRuntimeDiscovery,
  readOwnedTlsMaterial,
} from '../../apps/runner/src/index.js';

const execFileAsync = promisify(execFile);
const uuid = (suffix: number): string =>
  `30000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const now = new Date('2026-08-30T12:00:00.000Z');
const instanceId = uuid(1);
const runnerId = uuid(2);
const goodSerial = '1001';
const enrolledSerial = '1002';
const runnerPeerSerial = '1003';
const runnerCertificateSerial = '1100';
const hash = `sha256:${'a'.repeat(64)}`;

type Certificates = {
  root: string;
  ca: Buffer;
  serverCert: Buffer;
  serverKey: Buffer;
  mismatchedServerCert: Buffer;
  mismatchedServerKey: Buffer;
  clientCert: Buffer;
  clientKey: Buffer;
  enrolledClientCert: Buffer;
  enrolledClientKey: Buffer;
  runnerClientCert: Buffer;
  runnerClientKey: Buffer;
  rogueCa: Buffer;
  rogueClientCert: Buffer;
  rogueClientKey: Buffer;
};

async function openssl(args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync('openssl', args, { cwd });
}

async function createCertificates(): Promise<Certificates> {
  const root = await mkdtemp(join(tmpdir(), 'moonshift-runner-certs-'));
  const validity = ['-not_before', '20260101000000Z', '-not_after', '20301231235959Z'];
  const ca = async (prefix: string, subject: string, serial: string) => {
    await openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-noenc',
        '-sha256',
        '-batch',
        '-subj',
        subject,
        '-set_serial',
        serial,
        ...validity,
        '-addext',
        'basicConstraints=critical,CA:TRUE,pathlen:1',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
        '-keyout',
        `${prefix}.key`,
        '-out',
        `${prefix}.crt`,
      ],
      root,
    );
  };
  const leaf = async (prefix: string, caPrefix: string, serial: string, extensions: string) => {
    await writeFile(join(root, `${prefix}.ext`), `[leaf]\n${extensions}\n`, { mode: 0o600 });
    await openssl(
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-noenc',
        '-sha256',
        '-batch',
        '-subj',
        `/CN=${prefix}`,
        '-keyout',
        `${prefix}.key`,
        '-out',
        `${prefix}.csr`,
      ],
      root,
    );
    await openssl(
      [
        'x509',
        '-req',
        '-in',
        `${prefix}.csr`,
        '-CA',
        `${caPrefix}.crt`,
        '-CAkey',
        `${caPrefix}.key`,
        '-set_serial',
        serial,
        ...validity,
        '-sha256',
        '-extfile',
        `${prefix}.ext`,
        '-extensions',
        'leaf',
        '-out',
        `${prefix}.crt`,
      ],
      root,
    );
  };

  await ca('ca', '/CN=Moonshift Test CA', '0x1000');
  await leaf(
    'server',
    'ca',
    '0x1100',
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,URI:urn:moonshift:runner:${runnerId}`,
  );
  await leaf(
    'mismatched-server',
    'ca',
    '0x1101',
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,URI:urn:moonshift:runner:${uuid(999)}`,
  );
  await leaf(
    'client',
    'ca',
    `0x${goodSerial}`,
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:moonshift:instance:${instanceId}`,
  );
  await leaf(
    'enrolled-client',
    'ca',
    `0x${enrolledSerial}`,
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:moonshift:instance:${instanceId}`,
  );
  await leaf(
    'runner-client',
    'ca',
    `0x${runnerPeerSerial}`,
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:moonshift:runner:${runnerId}`,
  );
  await ca('rogue-ca', '/CN=Rogue Test CA', '0x2000');
  await leaf(
    'rogue-client',
    'rogue-ca',
    '0x2001',
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:moonshift:instance:${instanceId}`,
  );

  return {
    root,
    ca: await readFile(join(root, 'ca.crt')),
    serverCert: await readFile(join(root, 'server.crt')),
    serverKey: await readFile(join(root, 'server.key')),
    mismatchedServerCert: await readFile(join(root, 'mismatched-server.crt')),
    mismatchedServerKey: await readFile(join(root, 'mismatched-server.key')),
    clientCert: await readFile(join(root, 'client.crt')),
    clientKey: await readFile(join(root, 'client.key')),
    enrolledClientCert: await readFile(join(root, 'enrolled-client.crt')),
    enrolledClientKey: await readFile(join(root, 'enrolled-client.key')),
    runnerClientCert: await readFile(join(root, 'runner-client.crt')),
    runnerClientKey: await readFile(join(root, 'runner-client.key')),
    rogueCa: await readFile(join(root, 'rogue-ca.crt')),
    rogueClientCert: await readFile(join(root, 'rogue-client.crt')),
    rogueClientKey: await readFile(join(root, 'rogue-client.key')),
  };
}

function base(messageId: string) {
  return {
    schemaVersion: '1.0',
    messageId,
    instanceId,
    runnerId,
    correlationId: uuid(10),
    sentAt: now.toISOString(),
  };
}

const resourceRequest = {
  memoryBytes: 134_217_728,
  cpuUnits: 1,
  processLimit: 1,
  diskBytes: 8_388_608,
  maxRuntimeMs: 30_000,
  networkMode: 'DENY' as const,
  gpuUnits: 0,
};

function leaseOffer(messageId = uuid(11)) {
  return {
    ...base(messageId),
    kind: 'runner.lease_offer',
    leaseId: uuid(12),
    executionId: uuid(13),
    fencingToken: 1,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    resources: resourceRequest,
  };
}

function fixtureCommand(messageId = uuid(14)) {
  return {
    ...base(messageId),
    kind: 'runner.run_fixture',
    leaseId: uuid(12),
    executionId: uuid(13),
    fencingToken: 1,
    operation: 'WRITE_APPROVED_MARKER',
    effectId: uuid(15),
    actionDigest: hash,
  };
}

async function connect(
  port: number,
  certificates: Certificates,
  identity: 'primary' | 'enrolled' | 'runner' | 'rogue' = 'primary',
): Promise<TLSSocket> {
  const socket = connectTls({
    host: '127.0.0.1',
    port,
    ca: certificates.ca,
    cert:
      identity === 'rogue'
        ? certificates.rogueClientCert
        : identity === 'runner'
          ? certificates.runnerClientCert
          : identity === 'enrolled'
            ? certificates.enrolledClientCert
            : certificates.clientCert,
    key:
      identity === 'rogue'
        ? certificates.rogueClientKey
        : identity === 'runner'
          ? certificates.runnerClientKey
          : identity === 'enrolled'
            ? certificates.enrolledClientKey
            : certificates.clientKey,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
  });
  const serverIdentity = socket.getPeerCertificate().subjectaltname;
  if (!serverIdentity?.split(/,\s*/u).includes(`URI:urn:moonshift:runner:${runnerId}`)) {
    socket.destroy();
    throw new Error('Control plane did not authenticate the expected runner certificate identity');
  }
  return socket;
}

async function waitForClose(socket: {
  once(event: 'close', listener: () => void): unknown;
  destroyed: boolean;
}): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket did not close')), 2_000);
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function readProcessLine(
  child: ChildProcessWithoutNullStreams,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Runner daemon did not become ready: ${stderr.slice(-512)}`));
    }, 5_000);
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Runner daemon exited ${String(code)} before ready: ${stderr.slice(-512)}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });
}

async function waitForProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Runner daemon did not exit after termination'));
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function collectProcessExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Runner daemon did not exit after invalid configuration'));
    }, 5_000);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

describe.sequential('fixture runner authenticated boundary', () => {
  let certificates: Certificates;
  let runner: FixtureRunnerServer;
  let port: number;

  beforeAll(async () => {
    certificates = await createCertificates();
    runner = new FixtureRunnerServer({
      instanceId,
      runnerId,
      stateDirectory: join(certificates.root, 'main-runner-state'),
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
      now: () => now,
    });
    ({ port } = await runner.listen());
  }, 120_000);

  afterAll(async () => {
    await runner?.close();
    if (certificates?.root !== undefined)
      await rm(certificates.root, { recursive: true, force: true });
  });

  it('reports capability-minimal resource discovery and fails closed eligibility', () => {
    expect(runner.registration()).toMatchObject({
      runnerId,
      certificateSerial: runnerCertificateSerial,
      profile: 'FIXTURE_PROCESS',
      capabilities: {
        fixtureOperations: true,
        arbitraryShell: false,
        maxJobs: 1,
        networkMode: 'DENY',
        gpuUnits: 0,
      },
      runtimeDiscovery: fixtureRuntimeDiscovery(),
    });
    expect(evaluateFixtureEligibility(resourceRequest, DEFAULT_FIXTURE_CAPACITY)).toEqual({
      eligible: false,
      reason: 'MEMORY_NOT_ENFORCEABLE',
    });
    expect(
      evaluateFixtureEligibility(resourceRequest, {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: { ...DEFAULT_FIXTURE_CAPACITY.enforcement, memory: false },
      }),
    ).toMatchObject({ eligible: false, reason: 'MEMORY_NOT_ENFORCEABLE' });
    expect(
      evaluateFixtureEligibility(resourceRequest, {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: { ...DEFAULT_FIXTURE_CAPACITY.enforcement, memory: true },
      }),
    ).toMatchObject({ eligible: false, reason: 'CPU_NOT_ENFORCEABLE' });
    expect(
      evaluateFixtureEligibility({ ...resourceRequest, gpuUnits: 1 }, DEFAULT_FIXTURE_CAPACITY),
    ).toMatchObject({ eligible: false });
  });

  it('rejects a CA-valid server certificate bound to another runner before durable startup', () => {
    const stateDirectory = join(certificates.root, 'mismatched-server-identity-state');
    expect(
      () =>
        new FixtureRunnerServer({
          instanceId,
          runnerId,
          stateDirectory,
          tls: {
            ca: certificates.ca,
            cert: certificates.mismatchedServerCert,
            key: certificates.mismatchedServerKey,
          },
          controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
          now: () => now,
        }),
    ).toThrow('does not match configured runnerId');
    expect(fileSystem.existsSync(stateDirectory)).toBe(false);
  });

  it('supersedes stale execution leases only with a strictly higher fencing token', () => {
    const registry = new FixtureLeaseRegistry();
    const first = { ...leaseOffer(uuid(61)), leaseId: uuid(62), executionId: uuid(63) };
    const second = { ...first, leaseId: uuid(64), fencingToken: 2 };
    registry.offer(first, runnerId, now);
    registry.offer(second, runnerId, now);
    expect(registry.isCurrent(first.leaseId, first.executionId, first.fencingToken, now)).toBe(
      false,
    );
    expect(registry.isCurrent(second.leaseId, second.executionId, second.fencingToken, now)).toBe(
      true,
    );
    expect(() => registry.offer({ ...first, leaseId: uuid(65) }, runnerId, now)).toThrow(
      'not monotonic',
    );
    expect(() =>
      registry.offer(
        {
          ...leaseOffer(uuid(141)),
          leaseId: uuid(142),
          executionId: uuid(143),
          fencingToken: Number.MAX_SAFE_INTEGER + 1,
        },
        runnerId,
        now,
      ),
    ).toThrow('positive safe integer');
  });

  it('rejects unsafe durable lease fences without corrupting restart state', () => {
    const stateDirectory = join(certificates.root, 'unsafe-fence-journal-state');
    const journal = new FixtureRunnerJournal(stateDirectory);
    expect(() =>
      journal.recordLeaseAndMessage(uuid(147), {
        ...leaseOffer(uuid(144)),
        leaseId: uuid(145),
        executionId: uuid(146),
        fencingToken: Number.MAX_SAFE_INTEGER + 1,
        runnerId,
        revoked: false,
      }),
    ).toThrow('positive safe integer');
    expect(new FixtureRunnerJournal(stateDirectory).leaseOffers).toEqual([]);
  });

  it('runs the authenticated daemon separately and refuses scheduling without hard isolation', async () => {
    const configPath = join(certificates.root, 'daemon-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        instanceId,
        runnerId,
        stateDirectory: join(certificates.root, 'daemon-state'),
        tls: {
          caPath: join(certificates.root, 'ca.crt'),
          certificatePath: join(certificates.root, 'server.crt'),
          privateKeyPath: join(certificates.root, 'server.key'),
        },
        controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
        fixedNow: now.toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const daemon = spawn(
      process.execPath,
      [join(process.cwd(), 'apps/runner/dist/daemon.js'), configPath],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const ready = await readProcessLine(daemon);
    expect(ready).toMatchObject({ kind: 'runner.ready', host: '127.0.0.1' });
    expect(ready.pid).not.toBe(process.pid);
    const daemonPort = ready.port;
    if (typeof daemonPort !== 'number') throw new Error('Daemon did not report a port');
    const socket = await connect(daemonPort, certificates);
    const offer = { ...leaseOffer(uuid(71)), leaseId: uuid(72), executionId: uuid(73) };
    socket.write(`${JSON.stringify(offer)}\n`);
    await waitForClose(socket);
    daemon.kill('SIGTERM');
    await waitForProcessExit(daemon);
  });

  it.each([
    ['date-only', '2026-08-30'],
    ['impossible calendar date', '2026-02-30T00:00:00.000Z'],
    ['malformed offset', '2026-08-30T12:00:00+25:00'],
  ])('rejects a %s fixed daemon clock', async (label, fixedNow) => {
    const configPath = join(certificates.root, `invalid-daemon-config-${label}.json`);
    await writeFile(
      configPath,
      `${JSON.stringify({
        instanceId,
        runnerId,
        stateDirectory: join(certificates.root, `invalid-daemon-state-${label}`),
        tls: {
          caPath: join(certificates.root, 'ca.crt'),
          certificatePath: join(certificates.root, 'server.crt'),
          privateKeyPath: join(certificates.root, 'server.key'),
        },
        controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
        fixedNow,
      })}\n`,
      { mode: 0o600 },
    );
    const daemon = spawn(
      process.execPath,
      [join(process.cwd(), 'apps/runner/dist/daemon.js'), configPath],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exited = await collectProcessExit(daemon);
    expect(exited.code).not.toBe(0);
    expect(exited.stderr).toContain('Invalid runner daemon config');
  });

  it('rejects a symlinked runner private key', async () => {
    const linkedKeyPath = join(certificates.root, 'server-linked.key');
    await symlink(join(certificates.root, 'server.key'), linkedKeyPath);
    const configPath = join(certificates.root, 'symlinked-key-daemon-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        instanceId,
        runnerId,
        stateDirectory: join(certificates.root, 'symlinked-key-daemon-state'),
        tls: {
          caPath: join(certificates.root, 'ca.crt'),
          certificatePath: join(certificates.root, 'server.crt'),
          privateKeyPath: linkedKeyPath,
        },
        controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
        fixedNow: now.toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const daemon = spawn(
      process.execPath,
      [join(process.cwd(), 'apps/runner/dist/daemon.js'), configPath],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exited = await collectProcessExit(daemon);
    expect(exited.code).not.toBe(0);
    expect(exited.stderr).toContain('regular non-symlink files');
  });

  it('rejects TLS material stored in a non-owner-only directory', async () => {
    const tlsDirectory = join(certificates.root, 'insecure-tls-directory');
    await mkdir(tlsDirectory, { mode: 0o755 });
    await Promise.all([
      copyFile(join(certificates.root, 'ca.crt'), join(tlsDirectory, 'ca.crt')),
      copyFile(join(certificates.root, 'server.crt'), join(tlsDirectory, 'server.crt')),
      copyFile(join(certificates.root, 'server.key'), join(tlsDirectory, 'server.key')),
    ]);
    await chmod(join(tlsDirectory, 'server.key'), 0o600);
    await chmod(tlsDirectory, 0o755);
    const configPath = join(certificates.root, 'insecure-tls-daemon-config.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        instanceId,
        runnerId,
        stateDirectory: join(certificates.root, 'insecure-tls-daemon-state'),
        tls: {
          caPath: join(tlsDirectory, 'ca.crt'),
          certificatePath: join(tlsDirectory, 'server.crt'),
          privateKeyPath: join(tlsDirectory, 'server.key'),
        },
        controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
        fixedNow: now.toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const daemon = spawn(
      process.execPath,
      [join(process.cwd(), 'apps/runner/dist/daemon.js'), configPath],
      { env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exited = await collectProcessExit(daemon);
    expect(exited.code).not.toBe(0);
    expect(exited.stderr).toContain('owner-owned with mode 0700');
  });

  it('fails closed if the validated TLS directory is replaced before file reads', async () => {
    const swapRoot = join(certificates.root, 'tls-directory-swap');
    const trustedDirectory = join(swapRoot, 'trusted');
    const replacementDirectory = join(swapRoot, 'replacement');
    const displacedDirectory = join(swapRoot, 'displaced');
    await mkdir(trustedDirectory, { recursive: true, mode: 0o700 });
    await mkdir(replacementDirectory, { mode: 0o700 });
    for (const filename of ['ca.crt', 'server.crt', 'server.key']) {
      await Promise.all([
        copyFile(join(certificates.root, filename), join(trustedDirectory, filename)),
        copyFile(join(certificates.root, filename), join(replacementDirectory, filename)),
      ]);
    }
    await chmod(join(trustedDirectory, 'server.key'), 0o600);
    await chmod(join(replacementDirectory, 'server.key'), 0o600);

    await expect(
      readOwnedTlsMaterial(
        {
          caPath: join(trustedDirectory, 'ca.crt'),
          certificatePath: join(trustedDirectory, 'server.crt'),
          privateKeyPath: join(trustedDirectory, 'server.key'),
        },
        {
          afterDirectoryPinned: async () => {
            await rename(trustedDirectory, displacedDirectory);
            await rename(replacementDirectory, trustedDirectory);
          },
        },
      ),
    ).rejects.toThrow('TLS directory changed while material was being read');
  });

  it('runs only the allowlisted fixture operation in a child and durably binds its effect fence', async () => {
    const stateDirectory = join(certificates.root, 'direct-executor-state');
    const journal = new FixtureRunnerJournal(stateDirectory);
    const ledger = new FixtureEffectLedger(journal.effects);
    const executor = new FixtureProcessExecutor(ledger, journal);
    const offer = leaseOffer();
    const registry = new FixtureLeaseRegistry();
    registry.offer(offer, runnerId, now);
    const command = fixtureCommand();
    expect(
      registry.isCurrent(command.leaseId, command.executionId, command.fencingToken, now),
    ).toBe(true);
    await expect(
      executor.run(command, {
        memoryBytes: resourceRequest.memoryBytes,
        maxRuntimeMs: resourceRequest.maxRuntimeMs,
      }),
    ).resolves.toMatchObject({
      outcome: 'APPLIED',
      groundTruthDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(executor.lastProcessId).not.toBe(process.pid);
    expect(journal.effects[0]).toMatchObject({
      effectId: command.effectId,
      operationMessageId: command.messageId,
      executionId: command.executionId,
      leaseId: command.leaseId,
      fencingToken: command.fencingToken,
    });
  });

  it('rejects reattributing an applied effect to a newer lease and fencing token', async () => {
    const stateDirectory = join(certificates.root, 'effect-binding-state');
    const bindingServer = new FixtureRunnerServer({
      instanceId,
      runnerId,
      stateDirectory,
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
      now: () => now,
      capacity: {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: {
          cpu: true,
          memory: true,
          process: true,
          disk: true,
          time: true,
          network: true,
          gpu: true,
        },
      },
    });
    const address = await bindingServer.listen();
    const firstLease = {
      ...leaseOffer(uuid(133)),
      leaseId: uuid(134),
      executionId: uuid(135),
    };
    const secondLease = {
      ...firstLease,
      messageId: uuid(136),
      leaseId: uuid(137),
      fencingToken: 2,
    };
    const firstCommand = {
      ...fixtureCommand(uuid(138)),
      leaseId: firstLease.leaseId,
      executionId: firstLease.executionId,
      fencingToken: firstLease.fencingToken,
      effectId: uuid(139),
    };
    const reboundCommand = {
      ...firstCommand,
      messageId: uuid(140),
      leaseId: secondLease.leaseId,
      fencingToken: secondLease.fencingToken,
    };
    const socket = await connect(address.port, certificates);
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    try {
      socket.write(`${JSON.stringify(firstLease)}\n`);
      await bindingServer.waitForMessage(firstLease.messageId);
      socket.write(`${JSON.stringify(firstCommand)}\n`);
      await bindingServer.waitForMessage(firstCommand.messageId);
      await waitForCondition(() => received.includes(firstCommand.messageId));
      socket.write(`${JSON.stringify(secondLease)}\n`);
      await bindingServer.waitForMessage(secondLease.messageId);
      socket.write(`${JSON.stringify(reboundCommand)}\n`);
      await waitForClose(socket);

      expect(received).toContain(`\"operationMessageId\":\"${firstCommand.messageId}\"`);
      expect(received).not.toContain(`\"operationMessageId\":\"${reboundCommand.messageId}\"`);
      const journal = new FixtureRunnerJournal(stateDirectory);
      expect(journal.effects).toMatchObject([
        {
          effectId: firstCommand.effectId,
          executionId: firstLease.executionId,
          leaseId: firstLease.leaseId,
          fencingToken: firstLease.fencingToken,
        },
      ]);
      expect(journal.hasProcessed(reboundCommand.messageId)).toBe(false);
    } finally {
      socket.destroy();
      await bindingServer.close();
    }
  });

  it('aborts an in-flight fixture child and records no effect after lease authority is revoked', async () => {
    const stateDirectory = join(certificates.root, 'revoked-executor-state');
    const journal = new FixtureRunnerJournal(stateDirectory);
    const ledger = new FixtureEffectLedger(journal.effects);
    const executor = new FixtureProcessExecutor(ledger, journal);
    const registry = new FixtureLeaseRegistry();
    const offer = leaseOffer(uuid(91));
    registry.offer(offer, runnerId, now);
    const command = fixtureCommand(uuid(92));
    const controller = new AbortController();
    const execution = executor.run(
      command,
      {
        memoryBytes: resourceRequest.memoryBytes,
        maxRuntimeMs: resourceRequest.maxRuntimeMs,
      },
      {
        signal: controller.signal,
        isCurrent: () =>
          registry.isCurrent(command.leaseId, command.executionId, command.fencingToken, now),
      },
    );
    expect(executor.lastProcessId).toEqual(expect.any(Number));
    registry.revokeRunner(runnerId);
    controller.abort();
    await expect(execution).rejects.toThrow(/authority revoked/);
    expect(ledger.size).toBe(0);
    expect(journal.effects).toEqual([]);
    expect(journal.hasProcessed(command.messageId)).toBe(false);
  });

  it('cancels the active fixture child when its control-plane certificate is revoked', async () => {
    const revokingRunner = new FixtureRunnerServer({
      instanceId,
      runnerId,
      stateDirectory: join(certificates.root, 'certificate-revocation-race-state'),
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [
        { serialNumber: goodSerial, instanceId },
        { serialNumber: enrolledSerial, instanceId },
      ],
      now: () => now,
      // This injected capacity isolates the revocation race; production/default discovery remains
      // fail-closed for CPU and RSS enforcement.
      capacity: {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: {
          cpu: true,
          memory: true,
          process: true,
          disk: true,
          time: true,
          network: true,
          gpu: true,
        },
      },
    });
    const address = await revokingRunner.listen();
    try {
      const socket = await connect(address.port, certificates);
      const alreadyEnrolledSocket = await connect(address.port, certificates, 'enrolled');
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });
      const offer = leaseOffer(uuid(93));
      socket.write(`${JSON.stringify(offer)}\n`);
      await revokingRunner.waitForMessage(offer.messageId);
      const command = fixtureCommand(uuid(94));
      socket.write(`${JSON.stringify(command)}\n`);
      await waitForCondition(() => revokingRunner.lastFixtureProcessId !== undefined);
      const activeProcessId = revokingRunner.lastFixtureProcessId;
      if (activeProcessId === undefined) throw new Error('Fixture process did not start');
      process.kill(activeProcessId, 0);
      const revocation = revokingRunner.revokeControlPlaneCertificate(goodSerial);
      expect(revokingRunner.isAuthorityQuarantined).toBe(true);
      await revocation;
      expect(revokingRunner.isAuthorityQuarantined).toBe(true);
      expect(() => process.kill(activeProcessId, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
      await waitForClose(socket);
      await waitForClose(alreadyEnrolledSocket);
      const rejectedAlreadyEnrolled = await connect(address.port, certificates, 'enrolled');
      await waitForClose(rejectedAlreadyEnrolled);
      await revokingRunner.close();
      expect(revokingRunner.effectLedger.size).toBe(0);
      expect(received).not.toContain('"kind":"runner.result"');
      expect(received).not.toContain('"outcome":"APPLIED"');
    } finally {
      await revokingRunner.close();
    }
  });

  it('quarantines authority when certificate revocation fails before journal rename', async () => {
    const stateDirectory = join(certificates.root, 'revocation-persistence-failure-state');
    let failNextTemporaryFsync = false;
    const injectedFs: RunnerJournalFileSystem = {
      openSync: fileSystem.openSync,
      writeSync: fileSystem.writeSync,
      fsyncSync: (fd) => {
        if (failNextTemporaryFsync) {
          failNextTemporaryFsync = false;
          throw new Error('injected revocation fsync failure');
        }
        return fileSystem.fsyncSync(fd);
      },
      closeSync: fileSystem.closeSync,
      renameSync: fileSystem.renameSync,
      unlinkSync: fileSystem.unlinkSync,
    };
    const quarantinedRunner = new FixtureRunnerServer({
      instanceId,
      runnerId,
      stateDirectory,
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
      now: () => now,
      journalFileSystem: injectedFs,
      capacity: {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: {
          cpu: true,
          memory: true,
          process: true,
          disk: true,
          time: true,
          network: true,
          gpu: true,
        },
      },
    });
    const address = await quarantinedRunner.listen();
    const socket = await connect(address.port, certificates);
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    const offer = {
      ...leaseOffer(uuid(121)),
      leaseId: uuid(122),
      executionId: uuid(123),
    };
    socket.write(`${JSON.stringify(offer)}\n`);
    await quarantinedRunner.waitForMessage(offer.messageId);
    const command = {
      ...fixtureCommand(uuid(124)),
      leaseId: offer.leaseId,
      executionId: offer.executionId,
      effectId: uuid(125),
    };
    socket.write(`${JSON.stringify(command)}\n`);
    await waitForCondition(() => quarantinedRunner.lastFixtureProcessId !== undefined);
    const snapshotBeforeRevocation = await readFile(
      join(stateDirectory, 'runner-state.json'),
      'utf8',
    );

    const unknownSerial = 'FFFF';
    await expect(quarantinedRunner.revokeControlPlaneCertificate(unknownSerial)).rejects.toThrow(
      'Unknown control-plane certificate serial',
    );
    expect(quarantinedRunner.isAuthorityQuarantined).toBe(false);
    expect(
      quarantinedRunner.leaseRegistry.isCurrent(
        offer.leaseId,
        offer.executionId,
        offer.fencingToken,
        now,
      ),
    ).toBe(true);

    failNextTemporaryFsync = true;
    await expect(quarantinedRunner.revokeControlPlaneCertificate(goodSerial)).rejects.toThrow(
      'injected revocation fsync failure',
    );
    await waitForClose(socket);
    await quarantinedRunner.close();
    expect(quarantinedRunner.isAuthorityQuarantined).toBe(true);
    expect(quarantinedRunner.effectLedger.size).toBe(0);
    expect(received).not.toContain('"kind":"runner.result"');
    await expect(connect(address.port, certificates)).rejects.toThrow();
    const failedJournal = new FixtureRunnerJournal(stateDirectory);
    expect(failedJournal.revokedSerials).not.toContain(unknownSerial);
    expect(failedJournal.runnerDisabled).toBe(true);

    await writeFile(join(stateDirectory, 'runner-state.json'), snapshotBeforeRevocation, {
      mode: 0o600,
    });
    await rm(join(stateDirectory, 'runner-revocation-pending'));
    expect(new FixtureRunnerJournal(stateDirectory).runnerDisabled).toBe(false);

    const restartedAfterFailure = new FixtureRunnerServer({
      instanceId,
      runnerId,
      stateDirectory,
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
      now: () => now,
      capacity: {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: {
          cpu: true,
          memory: true,
          process: true,
          disk: true,
          time: true,
          network: true,
          gpu: true,
        },
      },
    });
    const restartedAddress = await restartedAfterFailure.listen();
    try {
      expect(restartedAfterFailure.isAuthorityQuarantined).toBe(true);
      const rejectedAfterRestart = await connect(restartedAddress.port, certificates);
      await waitForClose(rejectedAfterRestart);
    } finally {
      await restartedAfterFailure.close();
    }
  });

  it('accepts a separately enrolled control-plane certificate bound to the same instance', async () => {
    runner.enrollControlPlaneCertificate({ serialNumber: enrolledSerial, instanceId });
    const rejectedConnectionsBefore = runner.metrics.rejectedConnections;
    const rejectedMessagesBefore = runner.metrics.rejectedMessages;
    const socket = await connect(port, certificates, 'enrolled');
    const offer = { ...leaseOffer(uuid(18)), leaseId: uuid(19), executionId: uuid(20) };
    socket.write(`${JSON.stringify(offer)}\n`);
    await waitForClose(socket);
    expect(runner.metrics.rejectedConnections).toBe(rejectedConnectionsBefore);
    expect(runner.metrics.rejectedMessages).toBe(rejectedMessagesBefore + 1);
  });

  it('persists replay denial and semantic effect ground truth across runner restarts', async () => {
    const stateDirectory = join(certificates.root, 'restart-state');
    const command = {
      ...fixtureCommand(uuid(84)),
      leaseId: uuid(82),
      executionId: uuid(83),
      effectId: uuid(85),
    };
    const beforeJournal = new FixtureRunnerJournal(stateDirectory);
    const beforeExecutor = new FixtureProcessExecutor(
      new FixtureEffectLedger(beforeJournal.effects),
      beforeJournal,
    );
    await expect(
      beforeExecutor.run(command, {
        memoryBytes: resourceRequest.memoryBytes,
        maxRuntimeMs: resourceRequest.maxRuntimeMs,
      }),
    ).resolves.toMatchObject({ outcome: 'APPLIED' });

    const afterJournal = new FixtureRunnerJournal(stateDirectory);
    const afterLedger = new FixtureEffectLedger(afterJournal.effects);
    const afterExecutor = new FixtureProcessExecutor(afterLedger, afterJournal);
    expect(afterLedger.lookup(command.effectId, command.actionDigest)).toMatchObject({
      outcome: 'APPLIED',
    });
    const retryCommand = { ...command, messageId: uuid(87) };
    await expect(
      afterExecutor.run(retryCommand, {
        memoryBytes: resourceRequest.memoryBytes,
        maxRuntimeMs: resourceRequest.maxRuntimeMs,
      }),
    ).resolves.toMatchObject({ outcome: 'ALREADY_APPLIED' });
    expect(afterJournal.hasProcessed(command.messageId)).toBe(true);
    expect(() => afterJournal.recordProcessed(command.messageId)).toThrow(/replayed/);
  });

  it('persists the highest execution fence and rejects a superseded lease after restart', async () => {
    const stateDirectory = join(certificates.root, 'lease-fence-restart-state');
    const capacity = {
      ...DEFAULT_FIXTURE_CAPACITY,
      enforcement: {
        cpu: true,
        memory: true,
        process: true,
        disk: true,
        time: true,
        network: true,
        gpu: true,
      },
    } as const;
    const options = {
      instanceId,
      runnerId,
      stateDirectory,
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
      now: () => now,
      capacity,
    };
    const firstServer = new FixtureRunnerServer(options);
    const firstAddress = await firstServer.listen();
    const firstLease = {
      ...leaseOffer(uuid(108)),
      leaseId: uuid(109),
      executionId: uuid(110),
    };
    const secondLease = {
      ...firstLease,
      messageId: uuid(111),
      leaseId: uuid(112),
      fencingToken: 2,
    };
    try {
      const socket = await connect(firstAddress.port, certificates);
      socket.write(`${JSON.stringify(firstLease)}\n`);
      await firstServer.waitForMessage(firstLease.messageId);
      socket.write(`${JSON.stringify(secondLease)}\n`);
      await firstServer.waitForMessage(secondLease.messageId);
    } finally {
      await firstServer.close();
    }

    const persistedBeforeRestart = new FixtureRunnerJournal(stateDirectory);
    expect(persistedBeforeRestart.leaseOffers).toMatchObject([
      { leaseId: firstLease.leaseId, fencingToken: 1, revoked: true },
      { leaseId: secondLease.leaseId, fencingToken: 2, revoked: false },
    ]);

    const restarted = new FixtureRunnerServer(options);
    const restartedAddress = await restarted.listen();
    try {
      expect(
        restarted.leaseRegistry.isCurrent(
          firstLease.leaseId,
          firstLease.executionId,
          firstLease.fencingToken,
          now,
        ),
      ).toBe(false);
      expect(
        restarted.leaseRegistry.isCurrent(
          secondLease.leaseId,
          secondLease.executionId,
          secondLease.fencingToken,
          now,
        ),
      ).toBe(true);

      const staleOfferSocket = await connect(restartedAddress.port, certificates);
      staleOfferSocket.write(`${JSON.stringify({ ...firstLease, messageId: uuid(113) })}\n`);
      await waitForClose(staleOfferSocket);

      const staleCommand = {
        ...fixtureCommand(uuid(114)),
        leaseId: firstLease.leaseId,
        executionId: firstLease.executionId,
        fencingToken: firstLease.fencingToken,
        effectId: uuid(115),
      };
      const staleCommandSocket = await connect(restartedAddress.port, certificates);
      staleCommandSocket.write(`${JSON.stringify(staleCommand)}\n`);
      await waitForClose(staleCommandSocket);
      expect(restarted.lastFixtureProcessId).toBeUndefined();
      expect(restarted.effectLedger.size).toBe(0);
      expect(new FixtureRunnerJournal(stateDirectory).leaseOffers).toMatchObject([
        { leaseId: firstLease.leaseId, fencingToken: 1, revoked: true },
        { leaseId: secondLease.leaseId, fencingToken: 2, revoked: false },
      ]);
    } finally {
      await restarted.close();
    }
  });

  it('persists lease invalidation across certificate revocation and runner restart', async () => {
    const stateDirectory = join(certificates.root, 'lease-revocation-restart-state');
    const capacity = {
      ...DEFAULT_FIXTURE_CAPACITY,
      enforcement: {
        cpu: true,
        memory: true,
        process: true,
        disk: true,
        time: true,
        network: true,
        gpu: true,
      },
    } as const;
    const options = {
      instanceId,
      runnerId,
      stateDirectory,
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
      now: () => now,
      capacity,
    };
    const firstServer = new FixtureRunnerServer(options);
    const firstAddress = await firstServer.listen();
    const lease = {
      ...leaseOffer(uuid(116)),
      leaseId: uuid(117),
      executionId: uuid(118),
    };
    try {
      const primary = await connect(firstAddress.port, certificates);
      primary.write(`${JSON.stringify(lease)}\n`);
      await firstServer.waitForMessage(lease.messageId);
      await firstServer.revokeControlPlaneCertificate(goodSerial);
      await waitForClose(primary);
    } finally {
      await firstServer.close();
    }

    const restarted = new FixtureRunnerServer(options);
    const restartedAddress = await restarted.listen();
    try {
      expect(restarted.isAuthorityQuarantined).toBe(true);
      expect(
        restarted.leaseRegistry.isCurrent(
          lease.leaseId,
          lease.executionId,
          lease.fencingToken,
          now,
        ),
      ).toBe(false);
      const revokedIdentity = await connect(restartedAddress.port, certificates);
      await waitForClose(revokedIdentity);
      restarted.enrollControlPlaneCertificate({ serialNumber: enrolledSerial, instanceId });
      expect(restarted.isAuthorityQuarantined).toBe(false);
      const staleCommand = {
        ...fixtureCommand(uuid(119)),
        leaseId: lease.leaseId,
        executionId: lease.executionId,
        fencingToken: lease.fencingToken,
        effectId: uuid(120),
      };
      const enrolled = await connect(restartedAddress.port, certificates, 'enrolled');
      enrolled.write(`${JSON.stringify(staleCommand)}\n`);
      await waitForClose(enrolled);
      expect(restarted.lastFixtureProcessId).toBeUndefined();
      expect(restarted.effectLedger.size).toBe(0);
    } finally {
      await restarted.close();
    }
  });

  it('rejects forged certificates before domain handling', async () => {
    const handledBefore = runner.metrics.handledMessages;
    const forged = await connect(port, certificates, 'rogue');
    await waitForClose(forged);
    expect(runner.metrics.handledMessages).toBe(handledBefore);
  });

  it('rejects a runner-role certificate that attempts to issue leases or fixture commands', async () => {
    runner.enrollControlPlaneCertificate({ serialNumber: runnerPeerSerial, instanceId });
    const handledBefore = runner.metrics.handledMessages;
    const runnerPeer = await connect(port, certificates, 'runner');
    runnerPeer.write(`${JSON.stringify(leaseOffer(uuid(22)))}\n`);
    runnerPeer.write(`${JSON.stringify(fixtureCommand(uuid(23)))}\n`);
    await waitForClose(runnerPeer);
    expect(runner.metrics.handledMessages).toBe(handledBefore);
  });

  it('rejects a message whose identities do not match the authenticated control-plane stream', async () => {
    const handledBefore = runner.metrics.handledMessages;
    const socket = await connect(port, certificates);
    socket.write(`${JSON.stringify({ ...leaseOffer(uuid(21)), runnerId: uuid(99) })}\n`);
    await waitForClose(socket);
    expect(runner.metrics.handledMessages).toBe(handledBefore);
  });

  it('rejects replayed message IDs before executing another operation', async () => {
    const journal = new FixtureRunnerJournal(join(certificates.root, 'replay-state'));
    const messageId = uuid(32);
    journal.recordProcessed(messageId);
    expect(journal.hasProcessed(messageId)).toBe(true);
    expect(() => journal.recordProcessed(messageId)).toThrow(/replayed/);
  });

  it('rejects symlinked state directories and replaceable state ancestry', async () => {
    const actualDirectory = join(certificates.root, 'actual-journal-state');
    const symlinkedDirectory = join(certificates.root, 'symlinked-journal-state');
    await mkdir(actualDirectory, { mode: 0o700 });
    await symlink(actualDirectory, symlinkedDirectory);
    expect(() => new FixtureRunnerJournal(symlinkedDirectory)).toThrow(/non-symlink/);

    const replaceableParent = join(certificates.root, 'replaceable-journal-parent');
    await mkdir(replaceableParent, { mode: 0o777 });
    await chmod(replaceableParent, 0o777);
    expect(() => new FixtureRunnerJournal(join(replaceableParent, 'state'))).toThrow(
      /replaceable by another user/,
    );
  });

  it('fails closed when the pinned journal directory is replaced before a rollback attempt', async () => {
    const stateDirectory = join(certificates.root, 'pinned-journal-state');
    const displacedDirectory = join(certificates.root, 'displaced-journal-state');
    const journal = new FixtureRunnerJournal(stateDirectory);
    await rename(stateDirectory, displacedDirectory);
    await mkdir(stateDirectory, { mode: 0o700 });

    expect(() => journal.recordProcessed(uuid(131))).toThrow(/state directory changed/);
    expect(journal.isDurabilityUncertain).toBe(true);
    expect(() => journal.recordProcessed(uuid(132))).toThrow(/durability is uncertain/);
  });

  it('writes snapshots through fsync, atomic rename, and directory fsync boundaries', async () => {
    const stateDirectory = join(certificates.root, 'journal-boundaries');
    const order: string[] = [];
    const fs: RunnerJournalFileSystem = {
      openSync: (...args) => {
        order.push(`open:${String(args[1])}`);
        return fileSystem.openSync(...args);
      },
      writeSync: (...args) => {
        order.push('write');
        return fileSystem.writeSync(...args);
      },
      fsyncSync: (fd) => {
        order.push('fsync');
        return fileSystem.fsyncSync(fd);
      },
      closeSync: (fd) => {
        order.push('close');
        return fileSystem.closeSync(fd);
      },
      renameSync: (...args) => {
        order.push('rename');
        return fileSystem.renameSync(...args);
      },
      unlinkSync: (...args) => fileSystem.unlinkSync(...args),
    };
    const journal = new FixtureRunnerJournal(stateDirectory, fs);
    journal.recordProcessed(uuid(101));
    expect(order).toEqual([
      'open:wx',
      'write',
      'fsync',
      'close',
      'rename',
      'open:r',
      'fsync',
      'close',
      'open:wx',
      'write',
      'fsync',
      'close',
      'rename',
      'open:r',
      'fsync',
      'close',
    ]);
    expect(
      JSON.parse(await readFile(join(stateDirectory, 'runner-state.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      processedMessageIds: [uuid(101)],
    });
  });

  it('keeps the previous complete snapshot and cleans the temporary file when fsync fails', async () => {
    const stateDirectory = join(certificates.root, 'journal-fsync-failure');
    new FixtureRunnerJournal(stateDirectory);
    const messageId = uuid(102);
    let fsyncCount = 0;
    const failingFs: RunnerJournalFileSystem = {
      openSync: fileSystem.openSync,
      writeSync: fileSystem.writeSync,
      fsyncSync: (fd) => {
        fsyncCount += 1;
        if (fsyncCount === 1) throw new Error('injected temporary fsync failure');
        return fileSystem.fsyncSync(fd);
      },
      closeSync: fileSystem.closeSync,
      renameSync: fileSystem.renameSync,
      unlinkSync: fileSystem.unlinkSync,
    };
    const failingJournal = new FixtureRunnerJournal(stateDirectory, failingFs);
    expect(() => failingJournal.recordProcessed(messageId)).toThrow(
      'injected temporary fsync failure',
    );
    expect(
      JSON.parse(await readFile(join(stateDirectory, 'runner-state.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      processedMessageIds: [],
    });
    expect((await import('node:fs/promises')).readdir(stateDirectory)).resolves.not.toContain(
      expect.stringContaining('.tmp'),
    );
  });

  it('does not replay a message after a snapshot has been renamed and durably synced', async () => {
    const stateDirectory = join(certificates.root, 'journal-restart-boundary');
    const messageId = uuid(103);
    const journal = new FixtureRunnerJournal(stateDirectory);
    journal.recordProcessed(messageId);
    const restarted = new FixtureRunnerJournal(stateDirectory);
    expect(restarted.hasProcessed(messageId)).toBe(true);
    expect(() => restarted.recordProcessed(messageId)).toThrow(/replayed/);
  });

  it('never exposes partial JSON when the parent-directory fsync boundary fails', async () => {
    const stateDirectory = join(certificates.root, 'journal-directory-failure');
    new FixtureRunnerJournal(stateDirectory);
    const messageId = uuid(106);
    let fsyncCount = 0;
    const failingFs: RunnerJournalFileSystem = {
      openSync: fileSystem.openSync,
      writeSync: fileSystem.writeSync,
      fsyncSync: (fd) => {
        fsyncCount += 1;
        if (fsyncCount === 2) throw new Error('injected directory fsync failure');
        return fileSystem.fsyncSync(fd);
      },
      closeSync: fileSystem.closeSync,
      renameSync: fileSystem.renameSync,
      unlinkSync: fileSystem.unlinkSync,
    };
    const journal = new FixtureRunnerJournal(stateDirectory, failingFs);
    expect(() => journal.recordProcessed(messageId)).toThrow('injected directory fsync failure');
    expect(
      JSON.parse(await readFile(join(stateDirectory, 'runner-state.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      processedMessageIds: [messageId],
    });
    const restarted = new FixtureRunnerJournal(stateDirectory);
    expect(restarted.hasProcessed(messageId)).toBe(true);
  });

  it('quarantines the live executor after an uncertain post-rename durability failure', async () => {
    const stateDirectory = join(certificates.root, 'journal-post-rename-quarantine');
    new FixtureRunnerJournal(stateDirectory);
    let fsyncCount = 0;
    const failingFs: RunnerJournalFileSystem = {
      openSync: fileSystem.openSync,
      writeSync: fileSystem.writeSync,
      fsyncSync: (fd) => {
        fsyncCount += 1;
        if (fsyncCount === 2) throw new Error('injected directory fsync failure');
        return fileSystem.fsyncSync(fd);
      },
      closeSync: fileSystem.closeSync,
      renameSync: fileSystem.renameSync,
      unlinkSync: fileSystem.unlinkSync,
    };
    const journal = new FixtureRunnerJournal(stateDirectory, failingFs);
    const ledger = new FixtureEffectLedger(journal.effects);
    const executor = new FixtureProcessExecutor(ledger, journal);
    const command = fixtureCommand(uuid(107));
    const limits = {
      memoryBytes: resourceRequest.memoryBytes,
      maxRuntimeMs: resourceRequest.maxRuntimeMs,
    };

    await expect(executor.run(command, limits)).rejects.toThrow('injected directory fsync failure');
    const firstProcessId = executor.lastProcessId;
    expect(firstProcessId).toEqual(expect.any(Number));
    expect(ledger.size).toBe(0);
    await expect(executor.run(command, limits)).rejects.toThrow(
      'Runner journal durability is uncertain',
    );
    expect(executor.lastProcessId).toBe(firstProcessId);
    expect(ledger.size).toBe(0);

    const restarted = new FixtureRunnerJournal(stateDirectory);
    expect(restarted.hasProcessed(command.messageId)).toBe(true);
    expect(
      new FixtureEffectLedger(restarted.effects).lookup(command.effectId, command.actionDigest),
    ).toMatchObject({ outcome: 'APPLIED' });
  });

  it('closes the runner listener after an uncertain post-rename journal failure', async () => {
    const stateDirectory = join(certificates.root, 'server-post-rename-quarantine');
    let failNextDirectorySync = false;
    const failingFs: RunnerJournalFileSystem = {
      openSync: fileSystem.openSync,
      writeSync: fileSystem.writeSync,
      fsyncSync: (fd) => {
        if (failNextDirectorySync && fileSystem.fstatSync(fd).isDirectory()) {
          failNextDirectorySync = false;
          throw new Error('injected server directory fsync failure');
        }
        return fileSystem.fsyncSync(fd);
      },
      closeSync: fileSystem.closeSync,
      renameSync: fileSystem.renameSync,
      unlinkSync: fileSystem.unlinkSync,
    };
    const uncertainRunner = new FixtureRunnerServer({
      instanceId,
      runnerId,
      stateDirectory,
      tls: { ca: certificates.ca, cert: certificates.serverCert, key: certificates.serverKey },
      controlPlaneEnrollments: [{ serialNumber: goodSerial, instanceId }],
      now: () => now,
      journalFileSystem: failingFs,
      capacity: {
        ...DEFAULT_FIXTURE_CAPACITY,
        enforcement: {
          cpu: true,
          memory: true,
          process: true,
          disk: true,
          time: true,
          network: true,
          gpu: true,
        },
      },
    });
    const address = await uncertainRunner.listen();
    try {
      const socket = await connect(address.port, certificates);
      failNextDirectorySync = true;
      socket.write(`${JSON.stringify({ ...leaseOffer(uuid(126)), leaseId: uuid(127) })}\n`);
      await waitForClose(socket);
      expect(uncertainRunner.isAuthorityQuarantined).toBe(true);
      await expect(connect(address.port, certificates)).rejects.toThrow();
    } finally {
      await uncertainRunner.close();
    }
  });

  it('rejects invalid and already-expired lease offers and uses the injected clock', () => {
    const registry = new FixtureLeaseRegistry();
    const invalid = { ...leaseOffer(uuid(104)), expiresAt: 'not-a-timestamp' };
    expect(() => registry.offer(invalid, runnerId, now)).toThrow('Invalid lease expiry timestamp');
    expect(() =>
      registry.offer({ ...invalid, expiresAt: now.toISOString() }, runnerId, now),
    ).toThrow('already expired');
    const advancing = { ...leaseOffer(uuid(105)), expiresAt: now.toISOString() };
    const later = new Date(now.getTime() - 1);
    registry.offer(advancing, runnerId, later);
    expect(registry.isCurrent(advancing.leaseId, advancing.executionId, 1, now)).toBe(false);
  });

  it('rejects a result operation bound to a stale fencing token', async () => {
    const registry = new FixtureLeaseRegistry();
    const offer = leaseOffer(uuid(35));
    registry.offer(offer, runnerId, now);
    expect(registry.isCurrent(offer.leaseId, offer.executionId, offer.fencingToken + 1, now)).toBe(
      false,
    );
  });

  it('closes authenticated streams and fences their leases on revocation', async () => {
    const socket = await connect(port, certificates);
    const offer = leaseOffer(uuid(41));
    runner.leaseRegistry.offer(offer, runnerId, now);
    expect(
      runner.leaseRegistry.isCurrent(offer.leaseId, offer.executionId, offer.fencingToken, now),
    ).toBe(true);
    await runner.revokeControlPlaneCertificate(goodSerial);
    await waitForClose(socket);
    expect(
      runner.leaseRegistry.isCurrent(offer.leaseId, offer.executionId, offer.fencingToken, now),
    ).toBe(false);
    const rejected = await connect(port, certificates);
    await waitForClose(rejected);
  });

  it('rejects plaintext at the TLS boundary', async () => {
    const handledBefore = runner.metrics.handledMessages;
    const socket = connectPlain({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        socket.write(`${JSON.stringify(leaseOffer(uuid(51)))}\n`);
        resolve();
      });
      socket.once('error', reject);
    });
    await waitForClose(socket);
    expect(runner.metrics.handledMessages).toBe(handledBefore);
  });
});
