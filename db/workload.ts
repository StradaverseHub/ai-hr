import {AsyncLocalStorage} from 'node:async_hooks';
import type {DatabaseWorkload} from './admission';
const workload = new AsyncLocalStorage<DatabaseWorkload>();
const readCancellation = new AsyncLocalStorage<AbortSignal>();
export const currentDatabaseWorkload = (): DatabaseWorkload => workload.getStore() ?? 'interactive';
/** Classify a service operation before it opens transactions. This never changes authority. */
export function withBackgroundDatabaseWork<T>(work: () => Promise<T>): Promise<T> {
  return workload.run('background', work);
}

/** Only an owned read response may install this scope. Cancellation prevents later
 * checkouts; an already executing transaction retains its normal completion boundary. */
export function withDatabaseReadCancellation<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  return readCancellation.run(databaseReadSignal(signal)!, read);
}

export function databaseReadSignal(explicit?: AbortSignal): AbortSignal | undefined {
  const inherited = readCancellation.getStore();
  return inherited && explicit && inherited !== explicit
    ? AbortSignal.any([inherited, explicit])
    : explicit ?? inherited;
}
