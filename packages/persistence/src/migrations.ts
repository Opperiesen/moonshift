import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Pool, PoolClient } from 'pg';

import { MigrationIntegrityError } from './errors.js';
import { FOUNDATION_MIGRATIONS } from './migrations/manifest.js';

type AppliedMigration = { version: number; name: string; checksum: string };

async function tableExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('moonshift_schema_migrations')::text AS table_name",
  );
  return result.rows[0]?.table_name !== null;
}

async function readAndVerifyMigration(filename: string, expectedChecksum: string): Promise<string> {
  const sql = await readFile(new URL(`./migrations/${filename}`, import.meta.url), 'utf8');
  const actualChecksum = createHash('sha256').update(sql).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw new MigrationIntegrityError(`Migration ${filename} checksum mismatch`);
  }
  return sql;
}

export async function runMigrations(
  pool: Pool,
): Promise<{ applied: number[]; currentVersion: number }> {
  const client = await pool.connect();
  const newlyApplied: number[] = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('moonshift:migrations'))");
    const known = new Map<number, (typeof FOUNDATION_MIGRATIONS)[number]>(
      FOUNDATION_MIGRATIONS.map((migration) => [migration.version, migration]),
    );
    let applied: AppliedMigration[] = [];
    if (await tableExists(client)) {
      applied = (
        await client.query<AppliedMigration>(
          'SELECT version, name, checksum FROM moonshift_schema_migrations ORDER BY version',
        )
      ).rows;
    }
    for (const recorded of applied) {
      const declared = known.get(recorded.version);
      if (declared === undefined) {
        throw new MigrationIntegrityError(
          `Database migration ${recorded.version} is newer than this runtime`,
        );
      }
      if (recorded.name !== declared.name || recorded.checksum !== declared.checksum) {
        throw new MigrationIntegrityError(
          `Applied migration ${recorded.version} does not match the immutable manifest`,
        );
      }
    }
    const appliedVersions = new Set(applied.map(({ version }) => version));
    for (const migration of FOUNDATION_MIGRATIONS) {
      const sql = await readAndVerifyMigration(migration.filename, migration.checksum);
      if (appliedVersions.has(migration.version)) continue;
      await client.query(sql);
      await client.query(
        'INSERT INTO moonshift_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
      newlyApplied.push(migration.version);
    }
    await client.query('COMMIT');
    return {
      applied: newlyApplied,
      currentVersion: FOUNDATION_MIGRATIONS.at(-1)?.version ?? 0,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
