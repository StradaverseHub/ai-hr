import {AsyncLocalStorage} from 'node:async_hooks';
import type {DatabaseWorkload} from './admission';
const workload = new AsyncLocalStorage<DatabaseWorkload>();
export const currentDatabaseWorkload = (): DatabaseWorkload => workload.getStore() ?? 'interactive';
/** Classify a service operation before it opens transactions. This never changes authority. */
export function withBackgroundDatabaseWork<T>(work: () => Promise<T>): Promise<T> {
  return workload.run('background', work);
}
