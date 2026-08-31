import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('secret scan', () => {
  it('scans .env.example while allowing an explicit harmless placeholder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonshift-secret-scan-'));
    try {
      const environmentPath = join(root, '.env.example');
      const credentialKey = ['API', 'KEY'].join('_');
      await writeFile(environmentPath, `${credentialKey}=replace_me\n`, { mode: 0o600 });
      await expect(
        execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
      ).resolves.toMatchObject({ stdout: expect.stringContaining('no credential-like material') });

      const credentialLikeValue = ['live', 'fixture', 'credential', 'material'].join('_');
      await writeFile(environmentPath, `${credentialKey}=${credentialLikeValue}\n`, {
        mode: 0o600,
      });
      await expect(
        execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('.env.example') });

      const prefixedCredentialKeys = [
        ['OPENAI', 'API', 'KEY'].join('_'),
        ['SERVICE', 'AUTH', 'TOKEN'].join('_'),
        ['MOONSHIFT', 'DATABASE', 'PASSWORD'].join('_'),
        ['CLAIM', 'TOKEN'].join('_'),
        ['FENCING', 'TOKEN'].join('_'),
      ];
      for (const prefixedCredentialKey of prefixedCredentialKeys) {
        await writeFile(environmentPath, `${prefixedCredentialKey}=${credentialLikeValue}\n`, {
          mode: 0o600,
        });
        await expect(
          execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
        ).rejects.toMatchObject({ stderr: expect.stringContaining('.env.example') });
      }

      await writeFile(environmentPath, `${credentialKey}=replace_me\n`, { mode: 0o600 });
      const npmCredentialKey = ['_auth', 'Token'].join('');
      const passwordKey = ['PASS', 'WORD'].join('');
      const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
      const sensitiveFiles = [
        {
          name: '.npmrc',
          content: `//registry.example/:${npmCredentialKey}=${credentialLikeValue}\n`,
        },
        { name: 'deployment.key', content: `${privateKeyHeader}\nfixture-material\n` },
        { name: 'credentials', content: `${passwordKey}=${credentialLikeValue}\n` },
      ];
      for (const sensitiveFile of sensitiveFiles) {
        const path = join(root, sensitiveFile.name);
        await writeFile(path, sensitiveFile.content, { mode: 0o600 });
        await expect(
          execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
        ).rejects.toMatchObject({ stderr: expect.stringContaining(sensitiveFile.name) });
        await rm(path);
      }

      const binaryCredentialPath = join(root, 'credential-container.bin');
      await writeFile(
        binaryCredentialPath,
        Buffer.concat([
          Buffer.from([0]),
          Buffer.from(`${prefixedCredentialKeys[0]}=${credentialLikeValue}\n`, 'utf8'),
        ]),
        { mode: 0o600 },
      );
      await expect(
        execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('credential-container.bin') });
      await rm(binaryCredentialPath);

      const encodedCredential = `${prefixedCredentialKeys[1]}=${credentialLikeValue}\n`;
      const utf16LittleEndianPath = join(root, 'credential-utf16le.bin');
      await writeFile(utf16LittleEndianPath, Buffer.from(encodedCredential, 'utf16le'), {
        mode: 0o600,
      });
      await expect(
        execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('credential-utf16le.bin') });
      await rm(utf16LittleEndianPath);

      const utf16BigEndian = Buffer.from(encodedCredential, 'utf16le').swap16();
      const utf16BigEndianPath = join(root, 'credential-utf16be.bin');
      await writeFile(utf16BigEndianPath, utf16BigEndian, { mode: 0o600 });
      await expect(
        execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('credential-utf16be.bin') });
      await rm(utf16BigEndianPath);

      const selfScanDirectory = join(root, 'scripts');
      await (await import('node:fs/promises')).mkdir(selfScanDirectory);
      await writeFile(
        join(selfScanDirectory, 'check-secrets.mjs'),
        `${prefixedCredentialKeys[2]}=${credentialLikeValue}\n`,
        { mode: 0o600 },
      );
      await expect(
        execFileAsync(process.execPath, [join(process.cwd(), 'scripts/check-secrets.mjs'), root]),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('scripts/check-secrets.mjs') });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
