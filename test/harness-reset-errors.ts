/** Only lock conflicts are recoverable between test fixtures; application failures must escape. */
export function isFixtureResetLockError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const detail = current as {code?: unknown; message?: unknown; cause?: unknown};
    if (detail.code === '40P01' || detail.code === '55P03') return true;
    // Never reinterpret a real non-lock SQL error using words in its SQL/message.
    if (typeof detail.code === 'string' && /^[0-9A-Z]{5}$/.test(detail.code)) return false;
    if (detail.cause !== undefined) { current = detail.cause; continue; }
    return typeof detail.message === 'string'
      && /deadlock detected|canceling statement due to lock timeout|could not obtain lock on relation/i.test(detail.message);
  }
  return false;
}
