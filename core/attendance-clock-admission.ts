import { setTimeout as delay } from 'node:timers/promises';

const WEB_CLOCK_ADMISSION_MS = 5_000;
const RETRY_DELAYS_MS = [100, 200, 400, 700, 1_000, 1_000, 1_000];

export class ClockAccessUnavailableError extends Error {
  constructor() {
    super('Clock command admission expired.');
    this.name = 'ClockAccessUnavailableError';
  }
}

/** Only the first Access lock may be retried. A miss rolls back and returns the connection before
 * the delay. Once the clock owner starts, its transaction keeps the normal completion boundary. */
export async function withWebClockAccess<Tx, T>(
  withAttempt: (run: (tx: Tx) => Promise<T>, signal: AbortSignal) => Promise<T>,
  tryAccess: (tx: Tx) => Promise<boolean>,
  write: (tx: Tx) => Promise<T>,
  requestSignal?: AbortSignal,
): Promise<T> {
  const missed = new Error('Clock Access lock was held.');
  const expired = new ClockAccessUnavailableError();
  const deadline = new AbortController();
  const signal = requestSignal ? AbortSignal.any([requestSignal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(expired), WEB_CLOCK_ADMISSION_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await withAttempt(async tx => {
          signal.throwIfAborted();
          const acquired = await tryAccess(tx);
          signal.throwIfAborted();
          if (!acquired) throw missed;
          clearTimeout(timer);
          return write(tx);
        }, signal);
      } catch (error) {
        if (error !== missed) throw error;
      }

      const retryDelay = RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) throw expired;
      try {
        await delay(retryDelay + Math.random() * 100, undefined, {signal});
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
