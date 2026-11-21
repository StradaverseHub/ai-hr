import {DATABASE_CAPACITY_DIGEST, DatabaseAdmissionError} from './admission';
import {databaseReadSignal} from './workload';
import {pgSqlState} from '../lib/db-error';
import {isPoolerCapacityError} from './pooling';

/** Admission did not start the work, PostgreSQL cancelled the statement (57014), or PgBouncer had no capacity. */
export function isDatabaseCapacityFailure(error: unknown): boolean {
  return error instanceof DatabaseAdmissionError || pgSqlState(error) === '57014' || isPoolerCapacityError(error);
}

/** Lets a client error boundary recognise the failure; only the digest crosses to the browser. */
export function markDatabaseCapacityFailure(error: unknown): unknown {
  if ((pgSqlState(error) === '57014' || isPoolerCapacityError(error)) && typeof error === 'object' && error !== null && Object.isExtensible(error)) {
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
 * earlier work in the same callback. The budget covers two full 30-second admission stalls.
 */
export function retryIdempotentRead<T>(read: () => PromiseLike<T>, signal?: AbortSignal, options: ReadRetryOptions = {}): Promise<T> {
  return retryCapacity(read, isDatabaseCapacityFailure, signal, options);
}

/**
 * Asks again for an admission permit the pool refused. A refusal (DatabaseAdmissionError) is raised before any work
 * starts, so this is safe for reads and writes alike: it only repeats the request for a permit, never work that ran.
 * Same attempts, jitter and budget as a read retry.
 */
export function retryAdmissionRefusal<T>(admit: () => PromiseLike<T>, signal?: AbortSignal, options: ReadRetryOptions = {}): Promise<T> {
  return retryCapacity(admit, error => error instanceof DatabaseAdmissionError, signal, options);
}

async function retryCapacity<T>(run: () => PromiseLike<T>, retriable: (error: unknown) => boolean, signal: AbortSignal | undefined, options: ReadRetryOptions): Promise<T> {
  const {maxAttempts = 3, budgetMs = 75_000, sleep = waitFor, now = () => performance.now()} = options;
  const inherited = databaseReadSignal(signal);
  const startedAt = now();
  for (let attempt = 1; ; attempt++) {
    const attemptStartedAt = now();
    try {
      return await run();
    } catch (error) {
      if (!retriable(error) || attempt >= maxAttempts || inherited?.aborted) throw markDatabaseCapacityFailure(error);
      // Small random delays spread out readers that failed together; a full queue drains quickly.
      const delay = (attempt * 150) + Math.random() * 250;
      const lastAttemptMs = now() - attemptStartedAt;
      if (now() - startedAt + delay + lastAttemptMs > budgetMs) throw markDatabaseCapacityFailure(error);
      await sleep(delay);
      inherited?.throwIfAborted();
    }
  }
}
