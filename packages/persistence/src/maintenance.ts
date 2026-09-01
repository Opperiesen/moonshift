import type { Pool, PoolClient } from 'pg';

const MAINTENANCE_LOCK = 'moonshift:postgres-maintenance';

export type RestoreMaintenanceContext = Readonly<{ client: PoolClient }>;

export async function acquireMaintenanceSharedLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    MAINTENANCE_LOCK,
  ]);
}

async function releaseSessionLock(
  client: PoolClient,
  query: 'pg_advisory_unlock' | 'pg_advisory_unlock_shared',
): Promise<void> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      `SELECT ${query}(hashtextextended($1, 0)) AS unlocked`,
      [MAINTENANCE_LOCK],
    );
    if (result.rows[0]?.unlocked !== true) {
      throw new Error('PostgreSQL maintenance lock ownership was lost');
    }
  } catch (error) {
    const releaseError =
      error instanceof Error ? error : new Error('PostgreSQL maintenance lock release failed');
    client.release(releaseError);
    throw releaseError;
  }
  client.release();
}

export async function withRestoreMaintenance<T>(
  pool: Pool,
  work: (context: RestoreMaintenanceContext) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MAINTENANCE_LOCK]);
    locked = true;
    return await work({ client });
  } finally {
    if (locked) await releaseSessionLock(client, 'pg_advisory_unlock');
    else client.release();
  }
}

export async function withMaintenanceOperation<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock_shared(hashtextextended($1, 0))', [
      MAINTENANCE_LOCK,
    ]);
    locked = true;
    return await work(client);
  } finally {
    if (locked) await releaseSessionLock(client, 'pg_advisory_unlock_shared');
    else client.release();
  }
}
