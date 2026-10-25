/** Classify only the underlying reset failure; Drizzle's outer message contains SQL, not the cause. */
export function isResetLockError(error: unknown): boolean {
  const seen = new Set<unknown>();
  try {
    for (let depth = 0; depth < 8; depth++) {
      if (typeof error === 'string') return /lock_timeout|deadlock detected|canceling statement/i.test(error);
      if (typeof error !== 'object' || error === null || seen.has(error)) return false;
      seen.add(error);
      const current = error as { cause?: unknown; code?: unknown; message?: unknown; query?: unknown };
      if (current.cause !== undefined && current.cause !== null) { error = current.cause; continue; }
      // SQLSTATE is stable across message language changes. Query cancellation was already one of
      // the reset's intended retry cases; every retry still rolls back the whole reset transaction.
      if (typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
        return ['40P01', '55P03', '57014'].includes(current.code);
      }
      // A wrapper with no available cause must not classify SQL text as a PostgreSQL error message.
      if (typeof current.query === 'string') return false;
      return typeof current.message === 'string' && /lock_timeout|deadlock detected|canceling statement/i.test(current.message);
    }
  } catch { /* Unreadable error metadata must not turn a non-lock failure into a destructive retry. */ }
  return false;
}
