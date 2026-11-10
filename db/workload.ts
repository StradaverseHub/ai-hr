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

const readDeadline = new AsyncLocalStorage<AbortSignal>();
/** A hard read deadline: stronger than read cancellation, and only for reads that own one (Home cards).
 * When `deadline` aborts, later checkouts are refused as above AND the statement a transaction opened in
 * this scope is still running is cancelled in PostgreSQL, so the transaction rolls back and its
 * connection returns to the pool. Plain disconnect cancellation keeps its normal completion boundary. */
export function withDatabaseReadDeadline<T>(deadline: AbortSignal, read: () => Promise<T>): Promise<T> {
  return readDeadline.run(deadline, () => withDatabaseReadCancellation(deadline, read));
}
export const currentDatabaseReadDeadline = (): AbortSignal | undefined => readDeadline.getStore();

/** The parts of a postgres.js query and transaction client this relies on. `canceller` is the driver's
 * own CancelRequest sender (what `query.cancel()` calls); it is invoked directly so a refused cancel
 * connection is caught here instead of surfacing as an unhandled rejection. */
type DriverQuery = { canceller?: ((query: DriverQuery) => unknown) | null };
type DriverClient = { unsafe: (...args: never[]) => DriverQuery };

/** Track the statements one transaction client opens and cancel them when `deadline` aborts. Statements
 * requested after the deadline are refused before they reach the connection. Returns the release. */
export function cancelStatementsAtDeadline(session: { client: DriverClient }, deadline: AbortSignal): () => void {
  const driver = session.client, unsafe = driver.unsafe, statements = new Set<DriverQuery>();
  driver.unsafe = (...args: never[]) => {
    deadline.throwIfAborted();
    const query = unsafe(...args);
    statements.add(query);
    return query;
  };
  const cancel = () => {
    for (const query of statements) {
      const send = query.canceller;
      if (!send) continue;
      query.canceller = null;
      // A settled statement only records the request; a running one receives a protocol CancelRequest.
      try { void Promise.resolve(send(query)).catch(() => {}); } catch { /* The rollback still follows. */ }
    }
  };
  deadline.addEventListener('abort', cancel, { once: true });
  return () => { deadline.removeEventListener('abort', cancel); driver.unsafe = unsafe; statements.clear(); };
}
