/** Only lock conflicts are recoverable between test fixtures; application failures must escape. */
export function isFixtureResetLockError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  try {
    for (let depth = 0; depth < 8; depth++) {
      if (current === null || typeof current !== 'object' || seen.has(current)) return false;
      seen.add(current);
      const detail = current as {code?: unknown; message?: unknown; cause?: unknown; query?: unknown};
      if (detail.code === '40P01' || detail.code === '55P03') return true;
      // A real non-lock SQLSTATE, including general query cancellation, is never a reset conflict.
      if (typeof detail.code === 'string' && /^[0-9A-Z]{5}$/.test(detail.code)) return false;
      if (detail.cause !== undefined) { current = detail.cause; continue; }
      // Drizzle's wrapper message includes SQL; it cannot stand in for a missing server cause.
      if (typeof detail.query === 'string') return false;
      return typeof detail.message === 'string'
        && /deadlock detected|canceling statement due to lock timeout|could not obtain lock on relation/i.test(detail.message);
    }
  } catch { /* Unknown/unreadable metadata must not authorize a destructive reset retry. */ }
  return false;
}
