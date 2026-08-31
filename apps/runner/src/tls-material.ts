import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export type TlsMaterialPaths = {
  readonly caPath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
};

export type TlsMaterialReadHooks = {
  readonly afterDirectoryPinned?: () => Promise<void>;
};

async function openDirectory(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Runner daemon TLS directory ancestry must not contain symlinks');
  }
}

async function validateDirectoryAncestry(
  tlsDirectory: string,
  effectiveUid: number,
): Promise<void> {
  let current = dirname(tlsDirectory);
  for (;;) {
    const handle = await openDirectory(current);
    try {
      const info = await handle.stat();
      const permissions = info.mode & 0o7777;
      const trustedOwner = info.uid === effectiveUid || info.uid === 0;
      const writableByAnotherClass = (permissions & 0o022) !== 0;
      const sticky = (permissions & 0o1000) !== 0;
      if (!info.isDirectory() || !trustedOwner || (writableByAnotherClass && !sticky)) {
        throw new Error('Runner daemon TLS directory ancestry is replaceable by another user');
      }
    } finally {
      await handle.close();
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readOwnedFile(
  path: string,
  effectiveUid: number,
  privateKey: boolean,
): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Runner daemon TLS files must be regular non-symlink files');
  }
  try {
    const info = await handle.stat();
    const permissions = info.mode & 0o777;
    if (!info.isFile() || info.uid !== effectiveUid) {
      throw new Error('Runner daemon TLS files must be regular owner-owned files');
    }
    if (privateKey ? permissions !== 0o600 : (permissions & 0o022) !== 0) {
      throw new Error(
        privateKey
          ? 'Runner daemon private key must have mode 0600'
          : 'Runner daemon CA and certificate must not be group/world writable',
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sameIdentity(
  first: { readonly dev: number; readonly ino: number },
  second: { readonly dev: number; readonly ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export async function readOwnedTlsMaterial(
  tls: TlsMaterialPaths,
  hooks: TlsMaterialReadHooks = {},
): Promise<{ readonly ca: Buffer; readonly cert: Buffer; readonly key: Buffer }> {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) {
    throw new Error('Runner daemon requires effective-UID ownership checks');
  }
  const paths = {
    ca: resolve(tls.caPath),
    cert: resolve(tls.certificatePath),
    key: resolve(tls.privateKeyPath),
  };
  const lexicalDirectory = dirname(paths.ca);
  if (dirname(paths.cert) !== lexicalDirectory || dirname(paths.key) !== lexicalDirectory) {
    throw new Error('Runner daemon TLS files must share one owner-only directory');
  }
  if ((await lstat(lexicalDirectory)).isSymbolicLink()) {
    throw new Error('Runner daemon TLS directory must not be a symlink');
  }
  const tlsDirectory = await realpath(lexicalDirectory);
  await validateDirectoryAncestry(tlsDirectory, effectiveUid);

  const directoryHandle = await openDirectory(tlsDirectory);
  try {
    const pinnedDirectory = await directoryHandle.stat();
    if (
      !pinnedDirectory.isDirectory() ||
      pinnedDirectory.uid !== effectiveUid ||
      (pinnedDirectory.mode & 0o777) !== 0o700
    ) {
      throw new Error('Runner daemon TLS directory must be owner-owned with mode 0700');
    }

    await hooks.afterDirectoryPinned?.();
    const materialPaths = {
      ca: join(tlsDirectory, basename(paths.ca)),
      cert: join(tlsDirectory, basename(paths.cert)),
      key: join(tlsDirectory, basename(paths.key)),
    };
    const material = {
      ca: await readOwnedFile(materialPaths.ca, effectiveUid, false),
      cert: await readOwnedFile(materialPaths.cert, effectiveUid, false),
      key: await readOwnedFile(materialPaths.key, effectiveUid, true),
    };

    const currentDirectoryHandle = await openDirectory(tlsDirectory);
    try {
      if (!sameIdentity(pinnedDirectory, await currentDirectoryHandle.stat())) {
        throw new Error('Runner daemon TLS directory changed while material was being read');
      }
    } finally {
      await currentDirectoryHandle.close();
    }
    return material;
  } finally {
    await directoryHandle.close();
  }
}
