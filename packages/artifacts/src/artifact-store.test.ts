import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FsArtifactStore,
  type ArtifactDurabilityBoundary,
  type ArtifactStoreDurability,
} from './artifact-store.js';

function failOnceAt(purpose: ArtifactDurabilityBoundary['purpose']): ArtifactStoreDurability {
  let failed = false;
  return {
    sync: async (handle, boundary) => {
      if (!failed && boundary.purpose === purpose) {
        failed = true;
        throw new Error(`injected ${purpose} failure`);
      }
      await handle.sync();
    },
  };
}

describe('FsArtifactStore', () => {
  it('writes content-addressed bytes atomically and verifies metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonshift-artifacts-'));
    try {
      const store = new FsArtifactStore({ root, ownerId: 'owner-a', maxBytes: 100 });
      const saved = await store.put(Buffer.from('hello'), {
        artifactId: 'artifact-1',
        taskId: 'task-1',
        gitRevision: 'rev-1',
      });
      expect(saved.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(saved.size).toBe(5);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(store.pathFor(saved.contentHash))).mode & 0o777).toBe(0o600);
      await expect(
        store.get(saved.contentHash, {
          artifactId: 'artifact-1',
          taskId: 'task-1',
          gitRevision: 'rev-1',
        }),
      ).resolves.toEqual(Buffer.from('hello'));
      await expect(
        store.get(saved.contentHash, { artifactId: 'artifact-1', taskId: 'other' }),
      ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal, oversize, tampering and missing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonshift-artifacts-'));
    try {
      const store = new FsArtifactStore({ root, ownerId: 'owner-a', maxBytes: 3 });
      await expect(store.put('four', { artifactId: 'artifact-oversize' })).rejects.toMatchObject({
        code: 'SIZE_LIMIT',
      });
      await expect(
        store.get('../secret', { artifactId: 'artifact-invalid-key' }),
      ).rejects.toMatchObject({ code: 'TRAVERSAL' });
      const saved = await new FsArtifactStore({ root, ownerId: 'owner-a', maxBytes: 100 }).put(
        'abc',
        { artifactId: 'artifact-2', taskId: 'task' },
      );
      const bytePath = store.pathFor(saved.contentHash);
      await expect(readFile(bytePath)).resolves.toEqual(Buffer.from('abc'));
      await import('node:fs/promises').then((fs) => fs.writeFile(bytePath, 'bad'));
      await expect(
        store.get(saved.contentHash, { artifactId: 'artifact-2' }),
      ).rejects.toMatchObject({ code: 'TAMPERED' });
      await rm(bytePath);
      await expect(
        store.get(saved.contentHash, { artifactId: 'artifact-2' }),
      ).rejects.toMatchObject({ code: 'MISSING_BYTES' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked storage paths and replaceable ancestry', async () => {
    const container = await mkdtemp(join(tmpdir(), 'moonshift-artifact-security-'));
    const external = await mkdtemp(join(tmpdir(), 'moonshift-artifact-external-'));
    try {
      const actualRoot = join(container, 'actual-root');
      const symlinkedRoot = join(container, 'symlinked-root');
      await mkdir(actualRoot, { mode: 0o700 });
      await symlink(actualRoot, symlinkedRoot);
      await expect(
        new FsArtifactStore({ root: symlinkedRoot, ownerId: 'owner-a' }).put('bytes', {
          artifactId: 'symlinked-root',
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE' });

      const metadataSymlinkRoot = join(container, 'metadata-symlink-root');
      await mkdir(metadataSymlinkRoot, { mode: 0o700 });
      await symlink(external, join(metadataSymlinkRoot, 'metadata'));
      await expect(
        new FsArtifactStore({ root: metadataSymlinkRoot, ownerId: 'owner-a' }).put('bytes', {
          artifactId: 'symlinked-metadata',
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE' });

      const bucketSymlinkRoot = join(container, 'bucket-symlink-root');
      await mkdir(bucketSymlinkRoot, { mode: 0o700 });
      const bucketStore = new FsArtifactStore({ root: bucketSymlinkRoot, ownerId: 'owner-a' });
      const contentHash = `sha256:${createHash('sha256').update('bytes').digest('hex')}`;
      await symlink(external, join(bucketSymlinkRoot, contentHash.slice(7, 9)));
      await expect(
        bucketStore.put('bytes', { artifactId: 'symlinked-bucket' }),
      ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE' });

      const replaceableParent = join(container, 'replaceable-parent');
      await mkdir(replaceableParent, { mode: 0o777 });
      await chmod(replaceableParent, 0o777);
      await expect(
        new FsArtifactStore({
          root: join(replaceableParent, 'store'),
          ownerId: 'owner-a',
        }).put('bytes', { artifactId: 'replaceable-ancestry' }),
      ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE' });
    } finally {
      await rm(container, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });

  it('fails closed when a pinned artifact directory is replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonshift-artifact-pinned-'));
    try {
      const store = new FsArtifactStore({ root, ownerId: 'owner-a' });
      const saved = await store.put('pinned-bytes', { artifactId: 'pinned-artifact' });
      const metadataDirectory = join(root, 'metadata');
      await rename(metadataDirectory, join(root, 'metadata-displaced'));
      await mkdir(metadataDirectory, { mode: 0o700 });

      await expect(
        store.get(saved.contentHash, { artifactId: 'pinned-artifact' }),
      ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('converges concurrent identical publications on one durable artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonshift-artifacts-'));
    try {
      const store = new FsArtifactStore({ root, ownerId: 'owner-a', maxBytes: 100 });
      const [first, second] = await Promise.all([
        store.put('concurrent', {
          artifactId: 'artifact-concurrent',
          taskId: 'task-concurrent',
        }),
        store.put('concurrent', {
          artifactId: 'artifact-concurrent',
          taskId: 'task-concurrent',
        }),
      ]);
      expect(first).toEqual(second);
      await expect(
        store.get(first.contentHash, {
          artifactId: 'artifact-concurrent',
          taskId: 'task-concurrent',
        }),
      ).resolves.toEqual(Buffer.from('concurrent'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates identical bytes without conflating distinct artifact provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'moonshift-artifacts-'));
    try {
      const store = new FsArtifactStore({ root, ownerId: 'owner-a', maxBytes: 100 });
      const [first, second] = await Promise.all([
        store.put('shared-bytes', {
          artifactId: 'artifact-a',
          taskId: 'task-a',
          executionId: 'execution-a',
        }),
        store.put('shared-bytes', {
          artifactId: 'artifact-b',
          taskId: 'task-b',
          executionId: 'execution-b',
        }),
      ]);

      expect(first.contentHash).toBe(second.contentHash);
      expect(first.storageKey).toBe(second.storageKey);
      await expect(
        store.get(first.contentHash, {
          artifactId: 'artifact-a',
          taskId: 'task-a',
          executionId: 'execution-a',
        }),
      ).resolves.toEqual(Buffer.from('shared-bytes'));
      await expect(
        store.get(second.contentHash, {
          artifactId: 'artifact-b',
          taskId: 'task-b',
          executionId: 'execution-b',
        }),
      ).resolves.toEqual(Buffer.from('shared-bytes'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['bytes-published', 'metadata-published'] as const)(
    'recovers an interrupted %s durability barrier on retry',
    async (purpose) => {
      const root = await mkdtemp(join(tmpdir(), 'moonshift-artifacts-'));
      try {
        const interrupted = new FsArtifactStore({
          root,
          ownerId: 'owner-a',
          maxBytes: 100,
          durability: failOnceAt(purpose),
        });
        await expect(
          interrupted.put('recoverable', {
            artifactId: 'artifact-recovery',
            taskId: 'task-recovery',
          }),
        ).rejects.toThrow(`injected ${purpose} failure`);

        const recovered = new FsArtifactStore({ root, ownerId: 'owner-a', maxBytes: 100 });
        const saved = await recovered.put('recoverable', {
          artifactId: 'artifact-recovery',
          taskId: 'task-recovery',
        });
        await expect(
          recovered.get(saved.contentHash, {
            artifactId: 'artifact-recovery',
            taskId: 'task-recovery',
          }),
        ).resolves.toEqual(Buffer.from('recoverable'));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
