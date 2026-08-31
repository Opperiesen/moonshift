import { readFile } from 'node:fs/promises';

import { isRfc3339DateTime } from '@moonshift/contracts';

import { FixtureRunnerServer, type ControlPlaneEnrollment } from './server.js';
import { readOwnedTlsMaterial } from './tls-material.js';

type DaemonConfig = {
  readonly instanceId: string;
  readonly runnerId: string;
  readonly stateDirectory: string;
  readonly tls: {
    readonly caPath: string;
    readonly certificatePath: string;
    readonly privateKeyPath: string;
  };
  readonly controlPlaneEnrollments: readonly ControlPlaneEnrollment[];
  readonly fixedNow?: string;
};

function parseConfig(value: unknown): DaemonConfig {
  if (value === null || typeof value !== 'object') throw new Error('Invalid runner daemon config');
  const config = value as Partial<DaemonConfig>;
  if (
    typeof config.instanceId !== 'string' ||
    typeof config.runnerId !== 'string' ||
    typeof config.stateDirectory !== 'string' ||
    config.tls === undefined ||
    typeof config.tls.caPath !== 'string' ||
    typeof config.tls.certificatePath !== 'string' ||
    typeof config.tls.privateKeyPath !== 'string' ||
    !Array.isArray(config.controlPlaneEnrollments) ||
    (config.fixedNow !== undefined && !isRfc3339DateTime(config.fixedNow))
  ) {
    throw new Error('Invalid runner daemon config');
  }
  for (const enrollment of config.controlPlaneEnrollments) {
    if (
      enrollment === null ||
      typeof enrollment !== 'object' ||
      typeof enrollment.serialNumber !== 'string' ||
      typeof enrollment.instanceId !== 'string'
    ) {
      throw new Error('Invalid runner daemon enrollment');
    }
  }
  return config as DaemonConfig;
}

const configPath = process.argv[2];
if (configPath === undefined) throw new Error('Runner daemon requires one config file path');
const config = parseConfig(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
const tls = await readOwnedTlsMaterial(config.tls);

const fixedNow = config.fixedNow === undefined ? undefined : new Date(config.fixedNow);
const runner = new FixtureRunnerServer({
  instanceId: config.instanceId,
  runnerId: config.runnerId,
  stateDirectory: config.stateDirectory,
  tls,
  controlPlaneEnrollments: config.controlPlaneEnrollments,
  now: fixedNow === undefined ? () => new Date() : () => new Date(fixedNow),
});

const address = await runner.listen();
process.stdout.write(
  `${JSON.stringify({ kind: 'runner.ready', host: address.host, port: address.port, pid: process.pid })}\n`,
);

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await runner.close();
};
process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
