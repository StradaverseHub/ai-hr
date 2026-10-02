/** Policy-free child-qualification configuration arithmetic. Jurisdictions supply category keys/prices. */
export type ChildQualificationReliefs = {
  perChild: number;
  childByCategory?: Record<string, number>;
  childQualificationVersion?: 1;
  childQualificationWeights?: Record<string, number>;
};
export class ChildReliefConfigurationError extends Error {
  readonly code = 'pcb_child_relief_configuration_invalid';
  constructor() { super('Child qualification configuration is inconsistent.'); this.name = 'ChildReliefConfigurationError'; }
}
const map = (v: unknown): v is Record<string, number> => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.values(v).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
const same = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
const closeMoney = (a: number, b: number) => Math.abs(a - b) < 0.0000001;

/** Existing versioned weights are authoritative; a monetary map is their configuration projection. */
export function assertChildQualificationReliefs(r: ChildQualificationReliefs, fallback: Record<string, number> = {}): void {
  const amounts = r.childByCategory ?? fallback;
  if (!Number.isFinite(r.perChild) || r.perChild < 0 || !map(amounts)) throw new ChildReliefConfigurationError();
  if (r.childQualificationVersion == null && r.childQualificationWeights == null) {
    if (r.perChild === 0 && Object.values(amounts).some(n => n > 0)) throw new ChildReliefConfigurationError();
    return;
  }
  if (r.childQualificationVersion !== 1 || !map(r.childQualificationWeights)) throw new ChildReliefConfigurationError();
  const weights = r.childQualificationWeights;
  if (Object.keys(amounts).length !== Object.keys(weights).length ||
      Object.keys(weights).some(k => !closeMoney(amounts[k], weights[k] * r.perChild))) throw new ChildReliefConfigurationError();
}

/** Convert a legacy monetary declaration once, preserving its current exact qualifying weights. */
export function childQualificationWeightsOf(r: ChildQualificationReliefs, fallback: Record<string, number> = {}): Record<string, number> {
  assertChildQualificationReliefs(r, fallback);
  if (r.childQualificationVersion === 1) return { ...r.childQualificationWeights };
  return Object.fromEntries(Object.entries(r.childByCategory ?? fallback).map(([key, amount]) => [key, r.perChild > 0 ? amount / r.perChild : 0]));
}

/** An editor changes Q against the ORIGINAL configuration, never divides the old prices by the new Q. */
export function repriceChildQualificationReliefs<T extends ChildQualificationReliefs>(r: T, basis: ChildQualificationReliefs, fallback: Record<string, number> = {}): T {
  const weights = childQualificationWeightsOf(basis, fallback);
  return { ...r, childQualificationVersion: 1, childQualificationWeights: weights,
    childByCategory: Object.fromEntries(Object.entries(weights).map(([key, units]) => [key, units * r.perChild])) };
}

/** Called only when appending a NEW effective-dated configuration, not while resolving historical rows.
 * Unchanged legacy category prices mean a Q edit: preserve the previous weights. Deliberately changed
 * prices are an explicit monetary declaration: convert against the submitted Q, preserving that money.
 * Explicit versioned submissions must already reconcile; they are never silently corrected here. */
export function prepareChildQualificationReliefs<T extends ChildQualificationReliefs>(input: T, previous: ChildQualificationReliefs, fallback: Record<string, number> = {}): T {
  if (input.childQualificationVersion != null || input.childQualificationWeights != null) {
    assertChildQualificationReliefs(input, fallback);
    return { ...input, childQualificationWeights: { ...input.childQualificationWeights } };
  }
  const amounts = input.childByCategory ?? fallback;
  const beforeAmounts = previous.childByCategory ?? fallback;
  if (map(amounts) && map(beforeAmounts) && same(amounts, beforeAmounts)) return repriceChildQualificationReliefs(input, previous, fallback);
  return repriceChildQualificationReliefs(input, input, fallback);
}

/** Shared count presentation: counts are not monetary values and are never rounded to 1 or 2 decimals. */
export const formatQualifyingChildCount = (count: number): string => String(count);
