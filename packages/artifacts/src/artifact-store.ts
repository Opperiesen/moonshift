import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type ArtifactMetadata = {
  artifactId: string;
  taskId?: string;
  projectId?: string;
  executionId?: string;
  gitRevision?: string;
  kind?: string;
  mediaType?: string;
};
export type StoredArtifact = ArtifactMetadata & {
  contentHash: `sha256:${string}`;
  size: number;
  ownerId: string;
  storageKey: string;
};
export class ArtifactStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

export type ArtifactDurabilityBoundary = {
  readonly kind: 'file' | 'directory';
  readonly purpose: 'bucket-ready' | 'temporary-file' | 'bytes-published' | 'metadata-published';
  readonly path: string;
};

export type ArtifactStoreDurability = {
  readonly sync: (handle: FileHandle, boundary: ArtifactDurabilityBoundary) => Promise<void>;
};

const DEFAULT_DURABILITY: ArtifactStoreDurability = {
  sync: async (handle) => handle.sync(),
};

export type ArtifactStoreOptions = {
  root: string;
  ownerId: string;
  maxBytes?: number;
  durability?: ArtifactStoreDurability;
};

type DirectoryIdentity = {
  readonly dev: number;
  readonly ino: number;
};

type FileInfo = DirectoryIdentity & {
  readonly uid: number;
  readonly mode: number;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
};

type PinnedRoot = {
  readonly identity: DirectoryIdentity;
};

function sameIdentity(first: DirectoryIdentity, second: DirectoryIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function unsafeStorage(message: string): ArtifactStoreError {
  return new ArtifactStoreError('UNSAFE_STORAGE', message);
}

async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw unsafeStorage('Artifact storage directories must be regular non-symlink directories');
  }
}

function assertOwnerOnlyDirectory(info: FileInfo, effectiveUid: number): void {
  if (!info.isDirectory() || info.uid !== effectiveUid || (info.mode & 0o777) !== 0o700) {
    throw unsafeStorage('Artifact storage directories must be owner-owned with mode 0700');
  }
}

async function validateTrustedDirectoryChain(start: string, effectiveUid: number): Promise<void> {
  let current = start;
  for (;;) {
    const handle = await openDirectoryNoFollow(current);
    try {
      const info = (await handle.stat()) as FileInfo;
      const permissions = info.mode & 0o7777;
      const trustedOwner = info.uid === effectiveUid || info.uid === 0;
      const writableByAnotherClass = (permissions & 0o022) !== 0;
      const sticky = (permissions & 0o1000) !== 0;
      if (!info.isDirectory() || !trustedOwner || (writableByAnotherClass && !sticky)) {
        throw unsafeStorage('Artifact storage ancestry is replaceable by another user');
      }
    } finally {
      await handle.close();
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function lstatIfPresent(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Owner-local, content-addressed filesystem store with durable, recoverable file publication. */
export class FsArtifactStore {
  readonly root: string;
  readonly ownerId: string;
  readonly maxBytes: number;
  private readonly durability: ArtifactStoreDurability;
  private readonly effectiveUid: number;
  private readonly directoryIdentities = new Map<string, DirectoryIdentity>();
  private rootStatePromise: Promise<PinnedRoot> | undefined;
  constructor(options: ArtifactStoreOptions) {
    this.root = resolve(options.root);
    this.ownerId = options.ownerId;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.durability = options.durability ?? DEFAULT_DURABILITY;
    const effectiveUid = process.geteuid?.();
    if (effectiveUid === undefined) {
      throw unsafeStorage('Artifact storage requires effective-UID ownership checks');
    }
    this.effectiveUid = effectiveUid;
  }

  pathFor(contentHash: string): string {
    const hex = this.parseHash(contentHash);
    return join(this.root, hex.slice(0, 2), `${hex.slice(2)}.bin`);
  }
  private metadataPath(artifactIdentity: string) {
    const artifactId = this.parseArtifactId(artifactIdentity);
    const identityHash = createHash('sha256').update(artifactId).digest('hex');
    return join(this.root, 'metadata', `${identityHash}.json`);
  }
  private parseArtifactId(value: string) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 256 ||
      /[\u0000-\u001f]/u.test(value)
    ) {
      throw new ArtifactStoreError('INVALID_ARTIFACT_ID', 'Invalid artifact identity');
    }
    return value;
  }
  private parseHash(value: string) {
    if (!/^sha256:[a-f0-9]{64}$/.test(value))
      throw new ArtifactStoreError('TRAVERSAL', 'Invalid artifact storage key');
    const path = this.pathForUnchecked(value);
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || basename(path).includes('..'))
      throw new ArtifactStoreError('TRAVERSAL', 'Artifact path escapes store');
    return value.slice(7);
  }
  private pathForUnchecked(hash: string) {
    const hex = hash.slice(7);
    return join(this.root, hex.slice(0, 2), `${hex.slice(2)}.bin`);
  }

  private async syncDirectory(
    path: string,
    expectedIdentity: DirectoryIdentity,
    purpose: Extract<
      ArtifactDurabilityBoundary['purpose'],
      `${string}-ready` | `${string}-published`
    >,
  ): Promise<void> {
    await this.assertRootIdentity();
    const handle = await openDirectoryNoFollow(path);
    try {
      const info = (await handle.stat()) as FileInfo;
      assertOwnerOnlyDirectory(info, this.effectiveUid);
      if (!sameIdentity(expectedIdentity, info)) {
        throw unsafeStorage('Artifact storage directory changed during publication');
      }
      await this.durability.sync(handle, { kind: 'directory', purpose, path });
    } finally {
      await handle.close();
    }
    await this.assertDirectoryIdentity(path, expectedIdentity);
  }

  private async writeDurableTemporaryFile(
    path: string,
    data: Uint8Array | string,
    parentIdentity: DirectoryIdentity,
  ): Promise<void> {
    await this.assertDirectoryIdentity(dirname(path), parentIdentity);
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = (await handle.stat()) as FileInfo;
      if (!info.isFile() || info.uid !== this.effectiveUid || (info.mode & 0o777) !== 0o600) {
        throw unsafeStorage('Artifact temporary files must be owner-owned with mode 0600');
      }
      await handle.writeFile(data);
      await this.durability.sync(handle, { kind: 'file', purpose: 'temporary-file', path });
    } finally {
      await handle.close();
    }
    await this.assertDirectoryIdentity(dirname(path), parentIdentity);
  }

  private async commitWithoutReplacement(
    temporaryPath: string,
    targetPath: string,
    purpose: 'bytes-published' | 'metadata-published',
    parentIdentity: DirectoryIdentity,
  ): Promise<void> {
    await this.assertDirectoryIdentity(dirname(targetPath), parentIdentity);
    try {
      await link(temporaryPath, targetPath);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
    await this.syncDirectory(dirname(targetPath), parentIdentity, purpose);
  }

  private async verifyPublishedBytes(
    bytesPath: string,
    contentHash: string,
    expectedSize: number,
    parentIdentity: DirectoryIdentity,
  ): Promise<Buffer> {
    await this.assertDirectoryIdentity(dirname(bytesPath), parentIdentity);
    let bytes: Buffer;
    try {
      bytes = await this.readOwnedFile(bytesPath);
    } catch {
      throw new ArtifactStoreError('MISSING_BYTES', 'Artifact bytes are missing');
    }
    if (
      bytes.byteLength !== expectedSize ||
      bytes.byteLength > this.maxBytes ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== contentHash
    ) {
      throw new ArtifactStoreError('TAMPERED', 'Artifact bytes failed integrity validation');
    }
    await this.assertDirectoryIdentity(dirname(bytesPath), parentIdentity);
    return bytes;
  }

  private async prepareRoot(): Promise<PinnedRoot> {
    const rootInfo = await lstatIfPresent(this.root);
    if (rootInfo !== undefined && (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())) {
      throw unsafeStorage('Artifact storage root must be a regular non-symlink directory');
    }
    if (rootInfo === undefined) {
      let canonicalParent: string;
      try {
        canonicalParent = await realpath(dirname(this.root));
      } catch {
        throw unsafeStorage('Artifact storage root parent must already exist');
      }
      await validateTrustedDirectoryChain(canonicalParent, this.effectiveUid);
      try {
        await mkdir(join(canonicalParent, basename(this.root)), { recursive: false, mode: 0o700 });
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    }

    const canonicalRoot = await realpath(this.root);
    await validateTrustedDirectoryChain(dirname(canonicalRoot), this.effectiveUid);
    const handle = await openDirectoryNoFollow(this.root);
    try {
      const info = (await handle.stat()) as FileInfo;
      assertOwnerOnlyDirectory(info, this.effectiveUid);
      return { identity: { dev: info.dev, ino: info.ino } };
    } finally {
      await handle.close();
    }
  }

  private async rootState(): Promise<PinnedRoot> {
    this.rootStatePromise ??= this.prepareRoot();
    const state = await this.rootStatePromise;
    await this.assertRootIdentity(state);
    return state;
  }

  private async assertRootIdentity(state?: PinnedRoot): Promise<void> {
    const pinned = state ?? (await this.rootState());
    const currentHandle = await openDirectoryNoFollow(this.root);
    try {
      const current = (await currentHandle.stat()) as FileInfo;
      assertOwnerOnlyDirectory(current, this.effectiveUid);
      if (!sameIdentity(pinned.identity, current)) {
        throw unsafeStorage('Artifact storage root changed during operation');
      }
    } finally {
      await currentHandle.close();
    }
  }

  private async ensureChildDirectory(path: string, create: boolean): Promise<DirectoryIdentity> {
    await this.rootState();
    if (dirname(path) !== this.root) {
      throw unsafeStorage('Artifact storage directory escapes the pinned root');
    }
    const initial = await lstatIfPresent(path);
    if (initial === undefined && create) {
      try {
        await mkdir(path, { recursive: false, mode: 0o700 });
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
    } else if (initial === undefined) {
      throw new ArtifactStoreError('MISSING_BYTES', 'Artifact storage directory is missing');
    } else if (initial.isSymbolicLink() || !initial.isDirectory()) {
      throw unsafeStorage('Artifact storage directories must be regular non-symlink directories');
    }

    const handle = await openDirectoryNoFollow(path);
    try {
      const info = (await handle.stat()) as FileInfo;
      assertOwnerOnlyDirectory(info, this.effectiveUid);
      const identity = { dev: info.dev, ino: info.ino };
      const expected = this.directoryIdentities.get(path);
      if (expected !== undefined && !sameIdentity(expected, identity)) {
        throw unsafeStorage('Artifact storage directory changed during operation');
      }
      this.directoryIdentities.set(path, identity);
      await this.assertRootIdentity();
      return identity;
    } finally {
      await handle.close();
    }
  }

  private async assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
    await this.assertRootIdentity();
    const handle = await openDirectoryNoFollow(path);
    try {
      const info = (await handle.stat()) as FileInfo;
      assertOwnerOnlyDirectory(info, this.effectiveUid);
      if (!sameIdentity(expected, info)) {
        throw unsafeStorage('Artifact storage directory changed during operation');
      }
    } finally {
      await handle.close();
    }
  }

  private async readOwnedFile(path: string): Promise<Buffer> {
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw unsafeStorage('Artifact files must be regular non-symlink files');
    }
    try {
      const info = (await handle.stat()) as FileInfo;
      if (!info.isFile() || info.uid !== this.effectiveUid || (info.mode & 0o777) !== 0o600) {
        throw unsafeStorage('Artifact files must be owner-owned with mode 0600');
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async put(bytes: Uint8Array | string, metadata: ArtifactMetadata): Promise<StoredArtifact> {
    const data = Buffer.from(bytes);
    if (data.byteLength > this.maxBytes)
      throw new ArtifactStoreError('SIZE_LIMIT', 'Artifact exceeds configured size limit');
    const hex = createHash('sha256').update(data).digest('hex');
    const contentHash = `sha256:${hex}` as `sha256:${string}`;
    const storageKey = this.pathFor(contentHash);
    const metadataPath = this.metadataPath(metadata.artifactId);
    const rootState = await this.rootState();
    const bucketIdentity = await this.ensureChildDirectory(dirname(storageKey), true);
    const metadataIdentity = await this.ensureChildDirectory(dirname(metadataPath), true);
    await this.syncDirectory(this.root, rootState.identity, 'bucket-ready');
    const record: StoredArtifact = {
      ...metadata,
      contentHash,
      size: data.byteLength,
      ownerId: this.ownerId,
      storageKey: relative(this.root, storageKey),
    };
    const operationId = randomUUID();
    const tmp = `${storageKey}.${process.pid}.${operationId}.tmp`;
    const metaTmp = `${metadataPath}.${process.pid}.${operationId}.tmp`;
    try {
      await this.writeDurableTemporaryFile(tmp, data, bucketIdentity);
      await this.commitWithoutReplacement(tmp, storageKey, 'bytes-published', bucketIdentity);
      await this.verifyPublishedBytes(storageKey, contentHash, data.byteLength, bucketIdentity);
      await this.writeDurableTemporaryFile(metaTmp, JSON.stringify(record), metadataIdentity);
      await this.commitWithoutReplacement(
        metaTmp,
        metadataPath,
        'metadata-published',
        metadataIdentity,
      );
      await this.get(contentHash, metadata);
      await this.assertDirectoryIdentity(dirname(metadataPath), metadataIdentity);
      const publishedMetadata = JSON.parse(
        (await this.readOwnedFile(metadataPath)).toString('utf8'),
      ) as StoredArtifact;
      await this.assertDirectoryIdentity(dirname(metadataPath), metadataIdentity);
      return publishedMetadata;
    } finally {
      await rm(tmp, { force: true });
      await rm(metaTmp, { force: true });
    }
  }

  async get(contentHash: string, expected: ArtifactMetadata): Promise<Buffer> {
    const bytesPath = this.pathFor(contentHash); // validates key
    const bucketIdentity = await this.ensureChildDirectory(dirname(bytesPath), false);
    const metadataPath = this.metadataPath(expected.artifactId);
    const metadataIdentity = await this.ensureChildDirectory(dirname(metadataPath), false);
    let metadata: StoredArtifact;
    try {
      await this.assertDirectoryIdentity(dirname(metadataPath), metadataIdentity);
      metadata = JSON.parse(
        (await this.readOwnedFile(metadataPath)).toString('utf8'),
      ) as StoredArtifact;
      await this.assertDirectoryIdentity(dirname(metadataPath), metadataIdentity);
    } catch {
      throw new ArtifactStoreError('MISSING_BYTES', 'Artifact metadata is missing');
    }
    const provenanceMismatch = Object.entries(expected).some(
      ([k, v]) => v !== undefined && metadata[k as keyof StoredArtifact] !== v,
    );
    if (
      metadata.ownerId !== this.ownerId ||
      provenanceMismatch ||
      metadata.contentHash !== contentHash ||
      metadata.storageKey !== relative(this.root, bytesPath)
    )
      throw new ArtifactStoreError(
        metadata.contentHash !== contentHash || metadata.artifactId !== expected.artifactId
          ? 'ARTIFACT_ID_CONFLICT'
          : metadata.ownerId !== this.ownerId || provenanceMismatch
            ? 'OWNERSHIP_MISMATCH'
            : 'TAMPERED',
        'Artifact ownership/provenance does not match',
      );
    return this.verifyPublishedBytes(bytesPath, contentHash, metadata.size, bucketIdentity);
  }

  read(contentHash: string, expected: ArtifactMetadata) {
    return this.get(contentHash, expected);
  }
}
