/** Temporary isolated-load diagnostic. No hook is installed by an application or build. */
export type TransactionTimingEvent = {
  scope: 'tenant' | 'entitlements';
  phase: 'start' | 'entered' | 'left' | 'finished';
  durationMs?: number;
  entered?: boolean;
  failed?: boolean;
};
type ProfileGlobal = typeof globalThis & { __aihrTransactionTiming?: (event: TransactionTimingEvent) => void };
const noop = () => {};

export function profileDatabaseTransaction<T>(
  scope: TransactionTimingEvent['scope'],
  run: (entered: () => void, left: () => void) => Promise<T>,
): Promise<T> {
  const hook = (globalThis as ProfileGlobal).__aihrTransactionTiming;
  if (!hook) return run(noop, noop);
  // A diagnostic failure must never turn a committed business operation into an apparent failure.
  const emit = (event: Omit<TransactionTimingEvent, 'scope'>) => { try { hook({ scope, ...event }); } catch {} };
  const started = performance.now();
  let enteredAt: number | undefined, leftAt: number | undefined;
  emit({ phase: 'start' });
  const entered = () => { enteredAt = performance.now(); emit({ phase: 'entered', durationMs: enteredAt - started }); };
  const left = () => { leftAt = performance.now(); emit({ phase: 'left', durationMs: leftAt - (enteredAt ?? started) }); };
  const finished = (failed: boolean) => emit({ phase: 'finished', failed, entered: enteredAt !== undefined,
    durationMs: performance.now() - (leftAt ?? started) });
  try {
    return run(entered, left).then(value => { finished(false); return value; }, error => { finished(true); throw error; });
  } catch (error) { finished(true); throw error; }
}
