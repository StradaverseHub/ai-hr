/** Missing/malformed counters must not masquerade as a provider-reported zero. */
export function hasTokenCounts(value: unknown, fields: readonly string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const counters = value as Record<string, unknown>;
  return fields.every(key => typeof counters[key] === 'number' && Number.isSafeInteger(counters[key]) && Number(counters[key]) >= 0);
}
