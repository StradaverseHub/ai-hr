/** The instants an HR resolver may choose for a held offline punch: whole seconds inside the claim's proven interval
 * when it holds at most ten minutes of them, otherwise whole minutes (whole minutes of the epoch are whole minutes in
 * Malaysia time). The service applies the same interval rule again; this only shapes the time select. Plain module:
 * the client panel and its tests read it. */
export const OFFLINE_SECOND_STEP_LIMIT = 600;
export type OfflineResolutionTimes = { step: 'second' | 'minute'; values: number[] };

export function offlineResolutionTimes(minimum: number | null, maximum: number | null): OfflineResolutionTimes {
  if (minimum === null || maximum === null || !Number.isFinite(minimum) || !Number.isFinite(maximum)) return { step: 'second', values: [] };
  const low = Math.ceil(minimum / 1000) * 1000, high = Math.floor(maximum / 1000) * 1000;
  if (low > high) return { step: 'second', values: [] };
  const values: number[] = [];
  if ((high - low) / 1000 <= OFFLINE_SECOND_STEP_LIMIT) {
    for (let at = low; at <= high; at += 1000) values.push(at);
    return { step: 'second', values };
  }
  for (let at = Math.ceil(low / 60000) * 60000; at <= high; at += 60000) values.push(at);
  return { step: 'minute', values };
}

/** The option nearest `preferred` (the decided time, else the phone's claimed time); ties take the earlier one. */
export function defaultOfflineResolutionTime(values: readonly number[], preferred: number): number | null {
  let best: number | null = null;
  for (const value of values) if (best === null || Math.abs(value - preferred) < Math.abs(best - preferred)) best = value;
  return best;
}
