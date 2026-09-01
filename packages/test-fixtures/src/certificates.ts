import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FIXTURE_CERTIFICATE_NOT_BEFORE = '2026-01-01T00:00:00.000Z';
export const FIXTURE_CERTIFICATE_NOT_AFTER = '2030-12-31T23:59:59.000Z';

const opensslNotBefore = '20260101000000Z';
const opensslNotAfter = '20301231235959Z';

type CertificateAuthorityOptions = {
  readonly directory: string;
  readonly prefix: string;
  readonly subject: string;
  readonly serial: string;
};

type LeafCertificateOptions = {
  readonly directory: string;
  readonly prefix: string;
  readonly certificateAuthorityPrefix: string;
  readonly subject: string;
  readonly serial: string;
  readonly extensions: string;
};

async function openssl(args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync('openssl', args, { cwd });
}

function serialFileValue(serial: string): string {
  return `${serial.replace(/^0x/iu, '')}\n`;
}

export async function createFixtureCertificateAuthority(
  options: CertificateAuthorityOptions,
): Promise<void> {
  const { directory, prefix, subject, serial } = options;
  const config = `[ca]
default_ca = fixture_ca

[fixture_ca]
dir = .
database = ${prefix}.index
new_certs_dir = ${prefix}-certificates
certificate = ${prefix}.crt
private_key = ${prefix}.key
serial = ${prefix}.serial
default_md = sha256
policy = fixture_policy
unique_subject = no

[fixture_policy]
commonName = supplied

[certificate_authority]
basicConstraints = critical,CA:TRUE,pathlen:1
keyUsage = critical,keyCertSign,cRLSign
`;

  await Promise.all([
    mkdir(join(directory, `${prefix}-certificates`), { mode: 0o700 }),
    writeFile(join(directory, `${prefix}.cnf`), config, { mode: 0o600 }),
    writeFile(join(directory, `${prefix}.index`), '', { mode: 0o600 }),
    writeFile(join(directory, `${prefix}.serial`), serialFileValue(serial), { mode: 0o600 }),
  ]);
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
      subject,
      '-keyout',
      `${prefix}.key`,
      '-out',
      `${prefix}.csr`,
    ],
    directory,
  );
  await openssl(
    [
      'ca',
      '-selfsign',
      '-batch',
      '-notext',
      '-config',
      `${prefix}.cnf`,
      '-keyfile',
      `${prefix}.key`,
      '-in',
      `${prefix}.csr`,
      '-out',
      `${prefix}.crt`,
      '-startdate',
      opensslNotBefore,
      '-enddate',
      opensslNotAfter,
      '-extensions',
      'certificate_authority',
    ],
    directory,
  );
}

export async function createFixtureLeafCertificate(options: LeafCertificateOptions): Promise<void> {
  const { directory, prefix, certificateAuthorityPrefix, subject, serial, extensions } = options;
  const extensionFile = `${prefix}.ext`;
  await writeFile(join(directory, extensionFile), `[leaf]\n${extensions}\n`, { mode: 0o600 });
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
      subject,
      '-keyout',
      `${prefix}.key`,
      '-out',
      `${prefix}.csr`,
    ],
    directory,
  );
  await writeFile(
    join(directory, `${certificateAuthorityPrefix}.serial`),
    serialFileValue(serial),
    { mode: 0o600 },
  );
  await openssl(
    [
      'ca',
      '-batch',
      '-notext',
      '-config',
      `${certificateAuthorityPrefix}.cnf`,
      '-in',
      `${prefix}.csr`,
      '-out',
      `${prefix}.crt`,
      '-startdate',
      opensslNotBefore,
      '-enddate',
      opensslNotAfter,
      '-extfile',
      extensionFile,
      '-extensions',
      'leaf',
    ],
    directory,
  );
}
