import { describe, expect, it, vi } from 'vitest';
import { ClockAccessUnavailableError, withWebClockAccess } from '../core/attendance-clock-admission';

describe('web clock Access admission', () => {
  it('releases each failed attempt before trying again and runs the command once', async () => {
    const steps: string[] = [];
    let attempts = 0;
    const receipt = await withWebClockAccess(
      async run => {
        const tx = ++attempts;
        steps.push('checkout ' + tx);
        try {
          return await run(tx);
        } finally {
          steps.push('release ' + tx);
        }
      },
      async (tx: number) => {
        steps.push('try ' + tx);
        return tx === 2;
      },
      async tx => {
        steps.push('write ' + tx);
        return {direction: 'in'};
      },
    );

    expect(receipt).toEqual({direction: 'in'});
    expect(steps).toEqual(['checkout 1', 'try 1', 'release 1', 'checkout 2', 'try 2', 'write 2', 'release 2']);
  });

  it('stops a contended command after disconnect, with no second checkout or write', async () => {
    const request = new AbortController();
    const rolledBack = Promise.withResolvers<void>();
    const disconnected = new Error('Disconnected');
    let attempts = 0;
    let writes = 0;
    const result = withWebClockAccess(
      async run => {
        attempts++;
        try {
          return await run({});
        } finally {
          rolledBack.resolve();
        }
      },
      async () => false,
      async () => { writes++; },
      request.signal,
    );

    await rolledBack.promise;
    request.abort(disconnected);
    await expect(result).rejects.toBe(disconnected);
    expect(attempts).toBe(1);
    expect(writes).toBe(0);
  });

  it('refuses when the admission deadline elapses with the lock still held', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    let attempts = 0;
    let writes = 0;
    try {
      const result = withWebClockAccess(
        run => {
          attempts++;
          return run({});
        },
        async () => false,
        async () => { writes++; },
      );
      const refusal = expect(result).rejects.toBeInstanceOf(ClockAccessUnavailableError);
      await vi.advanceTimersByTimeAsync(5_000);
      await refusal;
      expect(attempts).toBeGreaterThan(0);
      expect(attempts).toBeLessThanOrEqual(8);
      expect(writes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry if the transaction cannot roll back a missed attempt', async () => {
    const failure = new Error('Rollback failed');
    let attempts = 0;
    let writes = 0;
    const result = withWebClockAccess(
      run => {
        attempts++;
        return run({}).catch(() => { throw failure; });
      },
      async () => false,
      async () => { writes++; },
    );

    await expect(result).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(writes).toBe(0);
  });

  it('does not retry a lock error from the admitted command or an ambiguous commit', async () => {
    for (const phase of ['write', 'commit']) {
      const error = Object.assign(new Error(phase), {code: '55P03'});
      let attempts = 0;
      let writes = 0;
      const result = withWebClockAccess(
        async run => {
          attempts++;
          await run({});
          throw error;
        },
        async () => true,
        async () => {
          writes++;
          if (phase === 'write') throw error;
        },
      );
      await expect(result).rejects.toBe(error);
      expect(attempts).toBe(1);
      expect(writes).toBe(1);
    }
  });

  it('lets an admitted command finish after the request disconnects', async () => {
    const request = new AbortController();
    const receipt = await withWebClockAccess(
      run => run({}),
      async () => true,
      async () => {
        request.abort();
        return {direction: 'in'};
      },
      request.signal,
    );

    expect(receipt).toEqual({direction: 'in'});
  });
});
