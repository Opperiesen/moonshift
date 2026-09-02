import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { stopEmbeddedPostgres } from '../fixtures/postgres.js';

class FixturePool extends EventEmitter {
  constructor(private readonly onEnd: () => void | Promise<void> = () => undefined) {
    super();
  }

  async end(): Promise<void> {
    await this.onEnd();
  }
}

function postgresError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`PostgreSQL ${code}`), { code });
}

describe('embedded PostgreSQL fixture teardown', () => {
  it('accepts only administrative shutdown errors emitted during explicit stop', async () => {
    const pool = new FixturePool();

    await expect(
      stopEmbeddedPostgres(
        {
          stop: async () => {
            pool.emit('error', postgresError('57P01'));
          },
        },
        [pool],
      ),
    ).resolves.toBeUndefined();
    expect(pool.listenerCount('error')).toBe(0);
  });

  it('rejects shutdown errors before stop and unexpected errors during stop', async () => {
    const beforeStop = new FixturePool(() => beforeStop.emit('error', postgresError('57P01')));
    await expect(
      stopEmbeddedPostgres({ stop: async () => undefined }, [beforeStop]),
    ).rejects.toThrow('unexpected error');
    expect(beforeStop.listenerCount('error')).toBe(0);

    const wrongCode = new FixturePool();
    await expect(
      stopEmbeddedPostgres(
        {
          stop: async () => {
            wrongCode.emit('error', postgresError('08006'));
          },
        },
        [wrongCode],
      ),
    ).rejects.toThrow('unexpected error');
    expect(wrongCode.listenerCount('error')).toBe(0);
  });

  it('waits for every pool to close and preserves every close failure before stop', async () => {
    const firstFailure = new Error('first pool close failed');
    const secondFailure = new Error('second pool close failed');
    let releaseSecond: (() => void) | undefined;
    const secondCanFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let stopCalled = false;
    const first = new FixturePool(async () => {
      throw firstFailure;
    });
    const second = new FixturePool(async () => {
      await secondCanFinish;
      throw secondFailure;
    });

    const teardown = stopEmbeddedPostgres(
      {
        stop: async () => {
          stopCalled = true;
        },
      },
      [first, second],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopCalled).toBe(false);
    releaseSecond?.();

    const error = await teardown.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstFailure, secondFailure]);
    expect(stopCalled).toBe(true);
    expect(first.listenerCount('error')).toBe(0);
    expect(second.listenerCount('error')).toBe(0);
  });
});
