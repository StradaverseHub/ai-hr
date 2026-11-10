import {DATABASE_CAPACITY_DIGEST, DatabaseAdmissionError} from './admission';
import {databaseReadSignal} from './workload';
import {pgSqlState} from '../lib/db-error';

/** Admission did not start the work, or PostgreSQL cancelled the statement (57014). */
export function isDatabaseCapacityFailure(error: unknown): boolean {
  return error instanceof DatabaseAdmissionError || pgSqlState(error) === '57014';
}

/** Lets a client error boundary recognise the failure; only the digest crosses to the browser. */
export function markDatabaseCapacityFailure(error: unknown): unknown {
  if (pgSqlState(error) === '57014' && typeof error === 'object' && error !== null && Object.isExtensible(error)) {
    Object.assign(error, {digest: DATABASE_CAPACITY_DIGEST});
  }
  return error;
}

export type ReadRetryOptions = {
  maxAttempts?: number;
  /** A retry starts only when it could finish inside this total. */
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const waitFor = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Re-runs an IDEMPOTENT read after a capacity failure, invisibly to the user. Never use it for a
 * write: an admission failure means nothing started, but a statement cancellation can follow
 * earlier work in the same callback. The budget covers two full 30-second admission waits.
 */
export async function retryIdempotentRead<T>(read: () => PromiseLike<T>, signal?: AbortSignal, options: ReadRetryOptions = {}): Promise<T> {
  const {maxAttempts = 3, budgetMs = 75_000, sleep = waitFor, now = () => performance.now()} = options;
  const inherited = databaseReadSignal(signal);
  const startedAt = now();
  for (let attempt = 1; ; attempt++) {
    const attemptStartedAt = now();
    try {
      return await read();
    } catch (error) {
      if (!isDatabaseCapacityFailure(error) || attempt >= maxAttempts || inherited?.aborted) throw markDatabaseCapacityFailure(error);
      // Small random delays spread out readers that failed together; a full queue drains quickly.
      const delay = (attempt * 150) + Math.random() * 250;
      const lastAttemptMs = now() - attemptStartedAt;
      if (now() - startedAt + delay + lastAttemptMs > budgetMs) throw markDatabaseCapacityFailure(error);
      await sleep(delay);
      inherited?.throwIfAborted();
    }
  }
}
