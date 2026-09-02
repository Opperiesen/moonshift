type PostgresError = Error & { readonly code?: unknown };

type PostgresPool = {
  end(): Promise<void>;
  on(event: 'error', listener: (error: PostgresError) => void): unknown;
  off(event: 'error', listener: (error: PostgresError) => void): unknown;
};

type EmbeddedPostgres = {
  stop(): Promise<void>;
};

export async function stopEmbeddedPostgres(
  embedded: EmbeddedPostgres | undefined,
  pools: readonly (PostgresPool | undefined)[],
): Promise<void> {
  const activePools = pools.filter((pool): pool is PostgresPool => pool !== undefined);
  const shutdownErrors: Array<{ readonly error: PostgresError; readonly whileStopping: boolean }> =
    [];
  const teardownFailures: unknown[] = [];
  let stoppingEmbedded = false;
  const recordShutdownError = (error: PostgresError): void => {
    shutdownErrors.push({ error, whileStopping: stoppingEmbedded });
  };

  for (const pool of activePools) pool.on('error', recordShutdownError);
  try {
    const poolEndResults = await Promise.allSettled(activePools.map((pool) => pool.end()));
    for (const result of poolEndResults) {
      if (result.status === 'rejected') teardownFailures.push(result.reason);
    }

    if (embedded !== undefined) {
      stoppingEmbedded = true;
      try {
        await embedded.stop();
      } catch (error) {
        teardownFailures.push(error);
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    teardownFailures.push(
      ...shutdownErrors
        .filter(({ error, whileStopping }) => error.code !== '57P01' || !whileStopping)
        .map(({ error }) => error),
    );
    if (teardownFailures.length > 0) {
      throw new AggregateError(
        teardownFailures,
        'Embedded PostgreSQL teardown produced an unexpected error',
      );
    }
  } finally {
    for (const pool of activePools) pool.off('error', recordShutdownError);
  }
}
