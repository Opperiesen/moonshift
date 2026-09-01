import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { FOUNDATION_MIGRATIONS } from './migrations/manifest.js';
import { withRestoreMaintenance, type RestoreMaintenanceContext } from './maintenance.js';

const BACKUP_SCHEMA_VERSION = '1.0' as const;
const DATABASE_FILE = 'database.json';
const MANIFEST_FILE = 'manifest.json';

const BACKUP_TABLES = [
  'aggregates',
  'audit_events',
  'outbox_events',
  'idempotency_records',
  'queue_items',
  'leases',
  'backend_event_projections',
  'project_snapshots',
  'project_events',
  'verification_policies',
  'verification_rules',
  'verification_artifacts',
  'verification_evidence',
  'verification_evaluations',
] as const;

const RESTORE_EMPTY_TABLES = [...BACKUP_TABLES, 'projection_checkpoints'] as const;

type BackupTableName = (typeof BACKUP_TABLES)[number];

type DatabaseSnapshot = {
  readonly schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  readonly tables: readonly {
    readonly name: BackupTableName;
    /** JSON text stays opaque so PostgreSQL bigint values never pass through a JS number. */
    readonly rows: readonly string[];
  }[];
};

export type BackupFile = {
  readonly path: string;
  readonly size: number;
  readonly sha256: `sha256:${string}`;
};

export type FixtureBackupManifest = {
  readonly schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  readonly kind: 'MOONSHIFT_FIXTURE_BACKUP';
  readonly createdAt: string;
  readonly migrationVersion: number;
  readonly migrations: readonly {
    readonly version: number;
    readonly name: string;
    readonly checksum: string;
  }[];
  readonly database: BackupFile;
  readonly artifacts: readonly BackupFile[];
  readonly configurationReferences: Readonly<Record<string, string>>;
  readonly contractHashes: Readonly<Record<string, `sha256:${string}`>>;
  readonly projectionRebuild: 'PROJECT_EVENTS_CHECKPOINT';
};

export type FixtureBackupMetrics = {
  readonly backupBytes: number;
  readonly databaseBytes: number;
  readonly artifactBytes: number;
  readonly temporaryDiskBytesHighWater: number;
  readonly inMemoryBytesHighWater: number;
};

export type FixtureRestoreMetrics = {
  readonly restoredBytes: number;
  readonly temporaryDiskBytesHighWater: number;
  readonly inMemoryBytesHighWater: number;
  readonly schedulingDowntimeMs: number;
};

export type FixtureProjectionRebuildProof = {
  readonly schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  readonly projection: 'project-events';
  readonly validatedProjectIds: readonly string[];
  readonly blockedProjectIds: readonly string[];
};

export type ValidatedFixtureBackup = {
  readonly manifest: FixtureBackupManifest;
  readonly database: DatabaseSnapshot;
  readonly metrics: FixtureBackupMetrics;
};

function hash(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeRelativePath(value: string): void {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    isAbsolute(value) ||
    value.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    throw new Error('Backup contains an unsafe relative path');
  }
}

function assertHash(value: unknown, label: string): asserts value is `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
}

function assertOpaqueConfigurationReferences(value: Readonly<Record<string, string>>): void {
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error('Too many configuration references');
  for (const [key, reference] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key)) {
      throw new Error('Invalid configuration reference name');
    }
    if (!/^(?:env|secret-ref|credential-ref):[A-Za-z0-9_.:/-]{1,200}$/u.test(reference)) {
      throw new Error('Configuration values must be opaque references');
    }
    if (reference.split(/[/:]/u).includes('..')) {
      throw new Error('Configuration references must not contain traversal segments');
    }
  }
}

function normalizedRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  assertSafeRelativePath(value);
  return value;
}

async function readRegularFile(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error('Backup files must be regular files');
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined || info.uid !== effectiveUid || (info.mode & 0o777) !== 0o600) {
    throw new Error('Backup files must be owner-owned with mode 0600');
  }
  return readFile(path);
}

function assertOwnerDirectory(info: Awaited<ReturnType<typeof lstat>>): void {
  const effectiveUid = process.geteuid?.();
  if (
    effectiveUid === undefined ||
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    Number(info.uid) !== effectiveUid ||
    (Number(info.mode) & 0o777) !== 0o700
  ) {
    throw new Error('Backup directories must be owner-owned with mode 0700');
  }
}

async function listRegularFiles(root: string): Promise<readonly string[]> {
  const rootInfo = await lstat(root);
  assertOwnerDirectory(rootInfo);
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Artifact backup refuses symbolic links');
      if (info.isDirectory()) {
        assertOwnerDirectory(info);
        await visit(path);
      } else if (info.isFile()) paths.push(path);
      else throw new Error('Artifact backup accepts only regular files and directories');
    }
  };
  await visit(root);
  return paths;
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function writeOwnerFile(path: string, bytes: Uint8Array | string): Promise<void> {
  await ensureDirectory(dirname(path));
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
}

async function snapshotDatabase(client: PoolClient): Promise<DatabaseSnapshot> {
  const tables: { name: BackupTableName; rows: string[] }[] = [];
  for (const name of BACKUP_TABLES) {
    const result = await client.query<{ payload: string }>(
      `SELECT row_to_json(source_row)::text AS payload
       FROM (SELECT * FROM ${name}) source_row
       ORDER BY to_jsonb(source_row)::text`,
    );
    tables.push({ name, rows: result.rows.map(({ payload }) => payload) });
  }
  return { schemaVersion: BACKUP_SCHEMA_VERSION, tables };
}

async function copyArtifactsForBackup(
  sourceRoot: string,
  backupRoot: string,
): Promise<readonly BackupFile[]> {
  const files = await listRegularFiles(sourceRoot);
  await ensureDirectory(join(backupRoot, 'artifacts'));
  const recorded: BackupFile[] = [];
  for (const source of files) {
    const relativePath = normalizedRelative(sourceRoot, source);
    const bytes = await readRegularFile(source);
    const manifestPath = `artifacts/${relativePath}`;
    await writeOwnerFile(join(backupRoot, ...manifestPath.split('/')), bytes);
    recorded.push({ path: manifestPath, size: bytes.byteLength, sha256: hash(bytes) });
  }
  return Object.freeze(recorded);
}

function currentMigrationManifest(): FixtureBackupManifest['migrations'] {
  return Object.freeze(
    FOUNDATION_MIGRATIONS.map(({ version, name, checksum }) =>
      Object.freeze({ version, name, checksum }),
    ),
  );
}

function assertDatabaseArtifactConsistency(
  database: DatabaseSnapshot,
  artifacts: readonly BackupFile[],
): void {
  const artifactTable = database.tables.find(({ name }) => name === 'verification_artifacts');
  if (artifactTable === undefined) throw new Error('Verification artifact table is missing');
  const byPath = new Map(artifacts.map((file) => [file.path, file]));
  for (const row of artifactTable.rows) {
    const value: unknown = JSON.parse(row);
    if (!isRecord(value)) throw new Error('Invalid verification artifact backup row');
    const storageKey = value.storage_key;
    const contentHash = value.content_hash;
    const size = value.size;
    if (
      typeof storageKey !== 'string' ||
      typeof contentHash !== 'string' ||
      (typeof size !== 'number' && typeof size !== 'string')
    ) {
      throw new Error('Verification artifact backup row is incomplete');
    }
    assertSafeRelativePath(storageKey.split(sep).join('/'));
    assertHash(contentHash, 'Verification artifact');
    const numericSize = Number(size);
    if (!Number.isSafeInteger(numericSize) || numericSize < 0) {
      throw new Error('Verification artifact size is invalid');
    }
    const file = byPath.get(`artifacts/${storageKey.split(sep).join('/')}`);
    if (file === undefined || file.sha256 !== contentHash || file.size !== numericSize) {
      throw new Error('Database artifact metadata does not match the artifact backup');
    }
  }
}

export async function createFixtureBackup(input: {
  readonly pool: Pool;
  readonly artifactRoot: string;
  readonly outputDirectory: string;
  readonly configurationReferences: Readonly<Record<string, string>>;
  readonly contractHashes: Readonly<Record<string, `sha256:${string}`>>;
  readonly now?: () => Date;
}): Promise<{ readonly manifest: FixtureBackupManifest; readonly metrics: FixtureBackupMetrics }> {
  assertOpaqueConfigurationReferences(input.configurationReferences);
  for (const [name, digest] of Object.entries(input.contractHashes)) {
    if (!/^[A-Za-z0-9_.\/-]{1,200}$/u.test(name)) throw new Error('Invalid contract name');
    assertHash(digest, `Contract ${name}`);
  }
  await mkdir(input.outputDirectory, { recursive: false, mode: 0o700 });
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const applied = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM moonshift_schema_migrations ORDER BY version',
    );
    const expectedMigrations = currentMigrationManifest();
    if (JSON.stringify(applied.rows) !== JSON.stringify(expectedMigrations)) {
      throw new Error('Database migration manifest is not current');
    }
    const database = await snapshotDatabase(client);
    const databaseBytes = Buffer.from(`${JSON.stringify(database, null, 2)}\n`);
    await writeOwnerFile(join(input.outputDirectory, DATABASE_FILE), databaseBytes);
    const artifacts = await copyArtifactsForBackup(input.artifactRoot, input.outputDirectory);
    assertDatabaseArtifactConsistency(database, artifacts);
    const databaseFile = Object.freeze({
      path: DATABASE_FILE,
      size: databaseBytes.byteLength,
      sha256: hash(databaseBytes),
    });
    const manifest: FixtureBackupManifest = Object.freeze({
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind: 'MOONSHIFT_FIXTURE_BACKUP',
      createdAt: (input.now?.() ?? new Date()).toISOString(),
      migrationVersion: FOUNDATION_MIGRATIONS.at(-1)?.version ?? 0,
      migrations: expectedMigrations,
      database: databaseFile,
      artifacts,
      configurationReferences: Object.freeze({ ...input.configurationReferences }),
      contractHashes: Object.freeze({ ...input.contractHashes }),
      projectionRebuild: 'PROJECT_EVENTS_CHECKPOINT',
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeOwnerFile(join(input.outputDirectory, MANIFEST_FILE), manifestBytes);
    await client.query('COMMIT');
    const artifactBytes = artifacts.reduce((total, file) => total + file.size, 0);
    return Object.freeze({
      manifest,
      metrics: Object.freeze({
        backupBytes: databaseBytes.byteLength + artifactBytes + manifestBytes.byteLength,
        databaseBytes: databaseBytes.byteLength,
        artifactBytes,
        temporaryDiskBytesHighWater: 0,
        inMemoryBytesHighWater: databaseBytes.byteLength + manifestBytes.byteLength,
      }),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await rm(input.outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    client.release();
  }
}

function parseManifest(value: unknown): FixtureBackupManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    value.kind !== 'MOONSHIFT_FIXTURE_BACKUP' ||
    typeof value.createdAt !== 'string' ||
    !Number.isSafeInteger(value.migrationVersion) ||
    !Array.isArray(value.migrations) ||
    !isRecord(value.database) ||
    !Array.isArray(value.artifacts) ||
    !isRecord(value.configurationReferences) ||
    !isRecord(value.contractHashes) ||
    value.projectionRebuild !== 'PROJECT_EVENTS_CHECKPOINT'
  ) {
    throw new Error('Invalid fixture backup manifest');
  }
  const database = value.database;
  if (
    database.path !== DATABASE_FILE ||
    !Number.isSafeInteger(database.size) ||
    (database.size as number) < 0
  ) {
    throw new Error('Invalid database backup entry');
  }
  assertHash(database.sha256, 'Database backup');
  const artifacts = value.artifacts.map((entry): BackupFile => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !entry.path.startsWith('artifacts/')
    ) {
      throw new Error('Invalid artifact backup entry');
    }
    assertSafeRelativePath(entry.path);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
      throw new Error('Invalid artifact backup size');
    }
    assertHash(entry.sha256, 'Artifact backup');
    return { path: entry.path, size: entry.size as number, sha256: entry.sha256 };
  });
  if (new Set(artifacts.map(({ path }) => path)).size !== artifacts.length) {
    throw new Error('Duplicate artifact backup path');
  }
  const configurationReferences = Object.fromEntries(
    Object.entries(value.configurationReferences).map(([key, reference]) => {
      if (typeof reference !== 'string') throw new Error('Invalid configuration reference');
      return [key, reference];
    }),
  );
  assertOpaqueConfigurationReferences(configurationReferences);
  const contractHashes = Object.fromEntries(
    Object.entries(value.contractHashes).map(([name, digest]) => {
      assertHash(digest, `Contract ${name}`);
      return [name, digest];
    }),
  );
  const migrations = value.migrations.map((migration) => {
    if (
      !isRecord(migration) ||
      !Number.isSafeInteger(migration.version) ||
      typeof migration.name !== 'string' ||
      typeof migration.checksum !== 'string'
    ) {
      throw new Error('Invalid migration manifest entry');
    }
    return {
      version: migration.version as number,
      name: migration.name,
      checksum: migration.checksum,
    };
  });
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: 'MOONSHIFT_FIXTURE_BACKUP',
    createdAt: value.createdAt,
    migrationVersion: value.migrationVersion as number,
    migrations,
    database: {
      path: DATABASE_FILE,
      size: database.size as number,
      sha256: database.sha256,
    },
    artifacts,
    configurationReferences,
    contractHashes,
    projectionRebuild: 'PROJECT_EVENTS_CHECKPOINT',
  };
}

function parseDatabase(value: unknown): DatabaseSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    !Array.isArray(value.tables)
  ) {
    throw new Error('Invalid database snapshot');
  }
  const tables = value.tables.map((table) => {
    if (!isRecord(table) || typeof table.name !== 'string' || !Array.isArray(table.rows)) {
      throw new Error('Invalid database snapshot table');
    }
    if (!BACKUP_TABLES.includes(table.name as BackupTableName)) {
      throw new Error('Unknown database snapshot table');
    }
    const rows = table.rows.map((row) => {
      if (typeof row !== 'string' || row.length > 16 * 1024 * 1024) {
        throw new Error('Invalid database snapshot row');
      }
      const parsed: unknown = JSON.parse(row);
      if (!isRecord(parsed)) throw new Error('Database snapshot rows must be objects');
      return row;
    });
    return { name: table.name as BackupTableName, rows };
  });
  if (
    tables.length !== BACKUP_TABLES.length ||
    tables.some(({ name }, index) => name !== BACKUP_TABLES[index])
  ) {
    throw new Error('Database snapshot table set is incomplete or reordered');
  }
  return { schemaVersion: BACKUP_SCHEMA_VERSION, tables };
}

function assertSameRecord(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  label: string,
): void {
  const normalize = (record: Readonly<Record<string, string>>) =>
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
    throw new Error(`${label} mismatch`);
  }
}

export async function validateFixtureBackup(input: {
  readonly backupDirectory: string;
  readonly expectedConfigurationReferences?: Readonly<Record<string, string>>;
  readonly expectedContractHashes?: Readonly<Record<string, `sha256:${string}`>>;
}): Promise<ValidatedFixtureBackup> {
  const rootInfo = await lstat(input.backupDirectory);
  assertOwnerDirectory(rootInfo);
  const rootEntries = (await readdir(input.backupDirectory)).sort();
  if (JSON.stringify(rootEntries) !== JSON.stringify(['artifacts', DATABASE_FILE, MANIFEST_FILE])) {
    throw new Error('Backup root contains an unexpected file set');
  }
  const manifestBytes = await readRegularFile(join(input.backupDirectory, MANIFEST_FILE));
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  if (
    manifest.migrationVersion !== (FOUNDATION_MIGRATIONS.at(-1)?.version ?? 0) ||
    JSON.stringify(manifest.migrations) !== JSON.stringify(currentMigrationManifest())
  ) {
    throw new Error('Backup migration range is incompatible with this runtime');
  }
  if (input.expectedConfigurationReferences !== undefined) {
    assertOpaqueConfigurationReferences(input.expectedConfigurationReferences);
    assertSameRecord(
      manifest.configurationReferences,
      input.expectedConfigurationReferences,
      'Configuration reference',
    );
  }
  if (input.expectedContractHashes !== undefined) {
    assertSameRecord(manifest.contractHashes, input.expectedContractHashes, 'Contract hash');
  }
  const databaseBytes = await readRegularFile(join(input.backupDirectory, DATABASE_FILE));
  if (
    databaseBytes.byteLength !== manifest.database.size ||
    hash(databaseBytes) !== manifest.database.sha256
  ) {
    throw new Error('Database backup failed integrity validation');
  }
  const database = parseDatabase(JSON.parse(databaseBytes.toString('utf8')));
  let artifactBytes = 0;
  for (const entry of manifest.artifacts) {
    const bytes = await readRegularFile(join(input.backupDirectory, ...entry.path.split('/')));
    if (bytes.byteLength !== entry.size || hash(bytes) !== entry.sha256) {
      throw new Error(`Artifact backup failed integrity validation: ${entry.path}`);
    }
    artifactBytes += bytes.byteLength;
  }
  const actualArtifactPaths = (
    await listRegularFiles(join(input.backupDirectory, 'artifacts'))
  ).map(
    (path) => `artifacts/${normalizedRelative(join(input.backupDirectory, 'artifacts'), path)}`,
  );
  if (
    JSON.stringify(actualArtifactPaths) !==
    JSON.stringify(manifest.artifacts.map(({ path }) => path))
  ) {
    throw new Error('Artifact backup file set does not match its manifest');
  }
  assertDatabaseArtifactConsistency(database, manifest.artifacts);
  return Object.freeze({
    manifest,
    database,
    metrics: Object.freeze({
      backupBytes: databaseBytes.byteLength + artifactBytes + manifestBytes.byteLength,
      databaseBytes: databaseBytes.byteLength,
      artifactBytes,
      temporaryDiskBytesHighWater: 0,
      inMemoryBytesHighWater: databaseBytes.byteLength + manifestBytes.byteLength,
    }),
  });
}

async function assertRestoreTargetEmpty(pool: Pick<Pool, 'query'>): Promise<void> {
  for (const table of RESTORE_EMPTY_TABLES) {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table}`,
    );
    if (result.rows[0]?.count !== '0')
      throw new Error(`Restore target table ${table} is not empty`);
  }
  const migrations = await pool.query<{ version: number; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM moonshift_schema_migrations ORDER BY version',
  );
  if (JSON.stringify(migrations.rows) !== JSON.stringify(currentMigrationManifest())) {
    throw new Error('Restore target migration manifest is incompatible');
  }
}

async function stageRestoredArtifacts(
  backupDirectory: string,
  stageDirectory: string,
  entries: readonly BackupFile[],
): Promise<void> {
  await mkdir(stageDirectory, { recursive: false, mode: 0o700 });
  for (const entry of entries) {
    const relativePath = entry.path.slice('artifacts/'.length);
    const source = join(backupDirectory, ...entry.path.split('/'));
    const destination = join(stageDirectory, ...relativePath.split('/'));
    await ensureDirectory(dirname(destination));
    await copyFile(source, destination);
    const bytes = await readRegularFile(destination);
    if (bytes.byteLength !== entry.size || hash(bytes) !== entry.sha256) {
      throw new Error('Staged artifact failed integrity validation');
    }
  }
}

function assertProjectionRebuildProof(
  value: unknown,
): asserts value is FixtureProjectionRebuildProof {
  if (
    !isRecord(value) ||
    value.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    value.projection !== 'project-events' ||
    !Array.isArray(value.validatedProjectIds) ||
    !Array.isArray(value.blockedProjectIds) ||
    !value.validatedProjectIds.every((projectId) => typeof projectId === 'string') ||
    !value.blockedProjectIds.every((projectId) => typeof projectId === 'string')
  ) {
    throw new Error('Projection rebuild did not return a valid verification proof');
  }
  if (new Set(value.validatedProjectIds).size !== value.validatedProjectIds.length) {
    throw new Error('Projection rebuild proof contains duplicate project identities');
  }
  if (value.blockedProjectIds.length > 0) {
    throw new Error('Projection rebuild proof contains blocked projects');
  }
}

async function assertRestoredProjectEventProjection(
  pool: Pick<Pool, 'query'>,
  proof: FixtureProjectionRebuildProof,
): Promise<void> {
  const state = await pool.query<{
    project_id: string;
    expected_last_sequence: string | null;
    checkpoint_last_sequence: string | null;
  }>(
    `SELECT snapshots.project_id::text,
            snapshots.record -> 'view' ->> 'lastSequence' AS expected_last_sequence,
            checkpoints.last_sequence::text AS checkpoint_last_sequence
     FROM project_snapshots snapshots
     LEFT JOIN projection_checkpoints checkpoints
       ON checkpoints.projection_name = 'project-events'
      AND checkpoints.project_id = snapshots.project_id
     ORDER BY snapshots.project_id`,
  );
  const expectedProjectIds = state.rows.map(({ project_id }) => project_id);
  const validatedProjectIds = [...proof.validatedProjectIds].sort((left, right) =>
    left.localeCompare(right),
  );
  if (JSON.stringify(validatedProjectIds) !== JSON.stringify(expectedProjectIds)) {
    throw new Error('Projection rebuild proof does not cover every restored project');
  }
  for (const row of state.rows) {
    if (
      row.expected_last_sequence === null ||
      row.checkpoint_last_sequence === null ||
      row.checkpoint_last_sequence !== row.expected_last_sequence
    ) {
      throw new Error(`Project-event projection checkpoint is incomplete for ${row.project_id}`);
    }
  }
  const checkpoints = await pool.query<{ project_id: string }>(
    `SELECT project_id::text
     FROM projection_checkpoints
     WHERE projection_name = 'project-events'
     ORDER BY project_id`,
  );
  if (
    JSON.stringify(checkpoints.rows.map(({ project_id }) => project_id)) !==
    JSON.stringify(expectedProjectIds)
  ) {
    throw new Error('Project-event projection checkpoints do not match restored projects');
  }
  const pending = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM outbox_events
     WHERE status <> 'PUBLISHED'`,
  );
  if (pending.rows[0]?.count !== '0') {
    throw new Error('Projection rebuild left unpublished durable events');
  }
}

type RestoreFixtureBackupInput = {
  readonly pool: Pool;
  readonly backupDirectory: string;
  readonly artifactRoot: string;
  readonly expectedConfigurationReferences: Readonly<Record<string, string>>;
  readonly expectedContractHashes: Readonly<Record<string, `sha256:${string}`>>;
  readonly rebuildAndValidateProjections: (
    context: RestoreMaintenanceContext,
  ) => Promise<FixtureProjectionRebuildProof>;
  readonly monotonicNow?: () => number;
};

async function restoreFixtureBackupUnlocked(
  input: RestoreFixtureBackupInput,
  context: RestoreMaintenanceContext,
): Promise<{
  readonly schedulingMayResume: true;
  readonly manifest: FixtureBackupManifest;
  readonly projectionRebuildProof: FixtureProjectionRebuildProof;
  readonly metrics: FixtureRestoreMetrics;
}> {
  if (typeof input.rebuildAndValidateProjections !== 'function') {
    throw new Error('Restore requires projection reconstruction and validation');
  }
  const startedAt = input.monotonicNow?.() ?? performance.now();
  const validated = await validateFixtureBackup({
    backupDirectory: input.backupDirectory,
    expectedConfigurationReferences: input.expectedConfigurationReferences,
    expectedContractHashes: input.expectedContractHashes,
  });
  await assertRestoreTargetEmpty(context.client);
  try {
    await lstat(input.artifactRoot);
    throw new Error('Restore artifact target must not already exist');
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const stageDirectory = `${input.artifactRoot}.restore-${randomUUID()}`;
  await ensureDirectory(dirname(input.artifactRoot));
  try {
    await stageRestoredArtifacts(
      input.backupDirectory,
      stageDirectory,
      validated.manifest.artifacts,
    );
    const client = context.client;
    try {
      await client.query('BEGIN');
      for (const table of validated.database.tables) {
        for (const row of table.rows) {
          await client.query(
            `INSERT INTO ${table.name} SELECT * FROM json_populate_record(NULL::${table.name}, $1::json)`,
            [row],
          );
        }
      }
      await client.query(
        `UPDATE outbox_events
         SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL,
             claim_expires_at = NULL, published_at = NULL`,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    await rename(stageDirectory, input.artifactRoot);
    const projectionRebuildProof = await input.rebuildAndValidateProjections(context);
    assertProjectionRebuildProof(projectionRebuildProof);
    await assertRestoredProjectEventProjection(context.client, projectionRebuildProof);
    const finishedAt = input.monotonicNow?.() ?? performance.now();
    return Object.freeze({
      schedulingMayResume: true,
      manifest: validated.manifest,
      projectionRebuildProof: Object.freeze({
        ...projectionRebuildProof,
        validatedProjectIds: Object.freeze([...projectionRebuildProof.validatedProjectIds]),
        blockedProjectIds: Object.freeze([...projectionRebuildProof.blockedProjectIds]),
      }),
      metrics: Object.freeze({
        restoredBytes: validated.metrics.databaseBytes + validated.metrics.artifactBytes,
        temporaryDiskBytesHighWater: validated.metrics.artifactBytes,
        inMemoryBytesHighWater: validated.metrics.inMemoryBytesHighWater,
        schedulingDowntimeMs: Math.max(0, finishedAt - startedAt),
      }),
    });
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreFixtureBackup(
  input: RestoreFixtureBackupInput,
): Promise<Awaited<ReturnType<typeof restoreFixtureBackupUnlocked>>> {
  return withRestoreMaintenance(input.pool, (context) =>
    restoreFixtureBackupUnlocked(input, context),
  );
}
