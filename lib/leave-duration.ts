/**
 * ADR-0048 — render a leave request's duration as a human label for history tables.
 * Full day → null (callers show the bare day figure). Half day → "Half day (AM/PM)". Hourly → the stored
 * hours ("2h"), NOT back-computed from `days` (round(hours/8,2) is lossy: 1h → 0.13). `t` is a `leave`
 * namespace translator. Returns null for full_day so the caller can decide to show nothing extra.
 */
export function durationLabel(
  t: (key: string, values?: Record<string, string | number>) => string,
  durationType: string | null | undefined,
  hours: string | number | null | undefined,
): string | null {
  switch (durationType) {
    case 'half_day_am':
      return t('duration.half_day_am');
    case 'half_day_pm':
      return t('duration.half_day_pm');
    case 'hourly': {
      const h = hours == null ? null : Number(hours);
      // hours is the source of truth for display; fall back to the generic label if it's missing.
      return h != null && Number.isFinite(h) ? t('hoursUnit', { hours: trimNum(h) }) : t('duration.hourly');
    }
    default:
      return null; // full_day (or unknown) — no extra label
  }
}

/** "2.00" → "2", "2.50" → "2.5" — keeps the hours label tidy. */
function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}
