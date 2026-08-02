/**
 * Pure leave-policy resolution + client-safe types/constants — RSC-SAFE: this module imports NO db/postgres.
 *
 * Split out of core/leave.ts (which imports ../db/client → postgres at module scope) following the
 * core/loans-compute.ts precedent verbatim, so a client component (components/leave-rule-preview.tsx) can
 * import `resolveGradePolicy` / `previewEntitlement` + the constants without dragging postgres into the
 * browser bundle. `next build` rejects a 'use client' → core/leave → db/client edge as module-not-found;
 * tsc + vitest do NOT run `next build`, so that boundary must be kept clean by construction. core/leave.ts
 * imports and re-exports everything here, so server callers + tests keep importing from '@/core/leave'
 * (including core/admin.ts's isValidMonthDay import).
 *
 * Leave Entitlement Rules Engine (feedback a0228655) — adds optional service-length bands ABOVE the flat
 * annualDays on a leave_policy (see AccrualConfig.serviceBands), resolved by `bandDaysFor`, plus a pure
 * `previewEntitlement` that runs the SAME resolveGradePolicy the server uses so the admin preview can never
 * disagree with the real engine.
 */

export type GradePolicyRow = { gradeId: string | null; accrual: unknown; companyId?: string | null };

/** ADR-0038 carry-forward expiry: the month+day on which the carried-forward ANNUAL portion expires
 *  (e.g. {month:3, day:31} = 31 March of the leave year following the one it was carried into). Stored
 *  as an OFFSET, not a hardcoded date, so it works for any leave-year start. null = never expires. */
export type CarryExpiry = { month: number; day: number };

/** True iff (month, day) is a real calendar day in *some* year — i.e. month∈1..12 and day is within the
 *  month's length, treating Feb's max as 29 (a leap year) for the "is this EVER valid" question. Config-time
 *  validation uses this so 29 Feb is savable as a legitimate intent; the resolvers then year-clamp it via
 *  `lastRealDayOfMonth` so a common year never produces a phantom 29-Feb. Round-trips through a UTC `Date`
 *  against a known leap year (2024) — no static max-day table, so it can never drift leap-blind. */
export function isValidMonthDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1) return false;
  const dt = new Date(Date.UTC(2024, month - 1, day)); // 2024 is a leap year ⇒ 29 Feb accepted
  return dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** Last real day of (year, month), leap-correct. Reuses the day-0-of-next-month round-trip (see
 *  `subtractMonths`): Date.UTC(year, month, 0) rolls back to the final day of `month` (1-based). This is the
 *  year-aware clamp the resolvers apply so every emitted expiry date is a real calendar day. */
export function lastRealDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export type ResolvedPolicy = {
  days: number;
  carryMax: number;
  method?: string;
  carryExpiry?: CarryExpiry | null;
  /** Carry-forward enhancement: explicit on/off switch for the carry rule. When absent, carry is
   *  enabled iff `carryMax > 0` (the back-compat default — see `carryEnabled`). */
  carryForwardEnabled?: boolean;
  /** 7cd914b1 — carry forward as a PERCENTAGE (0–100) of the balance held at year end, resolved by
   *  `resolveCarryAllowance`. null/absent ⇒ no percentage, i.e. `carryMax` alone decides, which is every
   *  pre-7cd914b1 policy. When both are set the max is a CEILING on the percentage, never an alternative. */
  carryPercent?: number | null;
  /** Feedback 9d8cf621 — Maximum Balance Days cap resolved from the winning service band (null = no cap).
   *  The granting engines clamp the running balance against this via `applyMaxBalance`. */
  maxBalanceDays?: number | null;
  /** Feedback b81d3c52 — Rounding Method, resolved from the SAME winning policy row as days/method.
   *  Absent/undefined ⇒ 'none' (no rounding, byte-identical to pre-b81d3c52 behaviour). */
  roundingMethod?: LeaveRoundingMethod;
  /** Feedback 9f5164d8 — the custom decimal threshold, read ONLY by the 'nearest_half' method. Absent ⇒
   *  DEFAULT_ROUNDING_THRESHOLD. Meaningless (and ignored) for every other method, so a stored value can
   *  never change what 'up' / 'down' / 'none' produce. */
  roundingThreshold?: number | null;
};

/** Feedback b81d3c52 — how a CALCULATED leave entitlement is tidied before it is credited:
 *   - 'none' (or absent) — keep the calculated value exactly as-is (today's behaviour);
 *   - 'up'              — always lift a part-day to the next WHOLE day (10.10 ⇒ 11, 10.50 ⇒ 11);
 *   - 'down'            — always drop a part-day to the previous WHOLE day (10.90 ⇒ 10, 10.49 ⇒ 10).
 *   - 'nearest_half'    — feedback 9f5164d8: snap to the 0.5-day grid, up or down according to where the
 *                         value's DECIMAL PORTION falls relative to a configurable threshold. See
 *                         `applyRounding` for the rule and `DEFAULT_ROUNDING_THRESHOLD` for the default.
 *
 *  The first three are UNCHANGED by 9f5164d8 and are the only values migration 0325 ever backfilled, so
 *  every leave type configured before that item behaves byte-identically (pinned by
 *  test/leave-entitlement-rounding-thresholds.test.ts, which runs all three through the new evaluator).
 *
 *  This is a SEPARATE concept from the pay-component `roundingMethod` (core/pay-components.ts, values
 *  none/nearest) — different domain, different values, deliberately no shared code. */
export type LeaveRoundingMethod = 'none' | 'up' | 'down' | 'nearest_half';

/**
 * Feedback 9f5164d8 — the threshold the reporter documented as the STANDARD rule, used whenever
 * 'nearest_half' is configured without a custom one: decimal 0.000–0.499 rounds down, 0.500–1.000 rounds up.
 *
 * The request describes TWO ranges (a round-down range and a round-up range) and requires them to cover
 * 0.000–1.000 with no gaps and no overlaps. Two complementary ranges over a fixed interval have exactly ONE
 * degree of freedom — the boundary between them — so the whole configuration is this single number, and the
 * "no gap / no overlap / full coverage" invariant holds by construction rather than by validation. The
 * editor still presents both rows, and `roundingThresholdRanges` derives them from this value.
 */
export const DEFAULT_ROUNDING_THRESHOLD = 0.5;

/**
 * The stored threshold as a usable number: a finite value in (0, 1], else the default. Defensive for the
 * same reason every other resolver in this file is — it runs inside cron sweeps over hand-written and
 * seeded rows, where garbage must degrade to the documented default rather than abort a tenant's sweep.
 * Postgres numerics arrive as strings, hence the string branch.
 */
export function resolveRoundingThreshold(v: string | number | null | undefined): number {
  if (v == null) return DEFAULT_ROUNDING_THRESHOLD;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_ROUNDING_THRESHOLD;
  return n;
}

/**
 * The two ranges the reporter's editor shows, derived from ONE threshold. Returned as the exact shape the
 * request tabulated: a round-DOWN range [0, t) and a round-UP range [t, 1]. There is no second stored
 * number to disagree with the first, which is why "the ranges must not overlap" and "there must not be any
 * gaps" can never fail at runtime.
 */
export function roundingThresholdRanges(threshold: string | number | null | undefined): {
  down: { from: number; to: number };
  up: { from: number; to: number };
} {
  const t = resolveRoundingThreshold(threshold);
  return { down: { from: 0, to: t }, up: { from: t, to: 1 } };
}

/** Leave Entitlement Rules Engine: one contiguous service-length band. `toYears` null = open-ended (the
 *  final band). Matching is half-open on completed service years: fromYears <= years < toYears.
 *
 *  Feedback 9d8cf621 — per-range entitlement columns. Beyond the resolver-critical `days`, a band may
 *  carry the reporter's per-range overrides. All are OPTIONAL and DEFENSIVELY read (a bad value is ignored,
 *  never thrown) so seeds / hand-written rows / legacy bands without them resolve exactly as before:
 *   - `carryForwardDays`      — this band's carry-forward cap; when a non-negative number, it OVERRIDES the
 *                               policy-level `carryForwardMax` for employees who resolve to this band.
 *   - `carryForwardExpiryMonth`/`Day` — this band's carry-forward expiry offset; when a valid (month, day)
 *                               pair, it OVERRIDES the policy-level carry-expiry for this band.
 *   - `maxBalanceDays`        — this band's Maximum Balance cap; the running ledger balance is clamped so it
 *                               never exceeds this at grant / earned-accrual / carry-in (see `applyMaxBalance`). */
export type ServiceBand = {
  fromYears: number;
  toYears: number | null;
  days: number;
  carryForwardDays?: number | null;
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  maxBalanceDays?: number | null;
};

/** Shape of the `leave_policy.accrual` JSONB (a documented JSONB extension point — no DDL). */
export type AccrualConfig = {
  annualDays?: number;
  carryForwardMax?: number;
  method?: string;
  carryForwardExpiryMonth?: number;
  carryForwardExpiryDay?: number;
  /** Carry-forward expiry mode (R4 Build #1). Absent ⇒ 'date' (back-compat: read month/day). 'months' ⇒
   *  "expire X months after year-end", where X = carryForwardExpiryMonths (see `parseCarryExpiry`). */
  carryForwardExpiryMode?: 'date' | 'months';
  /** X ∈ 1..12 — only meaningful in 'months' mode: the carried portion expires at the end of month X of the
   *  carry's leave-year (year-open is 1 Jan, so month X = X months after year-end). */
  carryForwardExpiryMonths?: number;
  /** Carry-forward enhancement: explicit on/off switch. Absent ⇒ back-compat default (`carryForwardMax > 0`). */
  carryForwardEnabled?: boolean;
  // config-only (carry-forward follow-up): persisted but NOT yet read by the year-end engine. The
  // include-monthly-earned-balance behaviour is deferred (see "Out of scope"); the flag round-trips so
  // the admin can configure it now.
  carryForwardIncludeEarned?: boolean;
  /** Leave Entitlement Rules Engine: optional service-length bands ABOVE annualDays. Omitted (undefined) on
   *  legacy policies ⇒ byte-identical resolution at any serviceYears (bandDaysFor falls back to annualDays).
   *  Contiguous, first fromYears = 0, last toYears = null, max 10 bands — enforced at write time
   *  (core/admin.ts); the resolver is DEFENSIVE and ignores a malformed array rather than throwing. */
  serviceBands?: ServiceBand[];
  /** Feedback b81d3c52 — Rounding Method for this policy's calculated entitlement. PERSISTED ONLY when it
   *  is 'up' or 'down': a No-Rounding policy OMITS the key entirely, so a re-saved untouched row stays
   *  byte-identical to what it was before this feature existed. Absent is read as 'none' everywhere. */
  roundingMethod?: LeaveRoundingMethod;
  /** Feedback 9f5164d8 — the custom decimal threshold for 'nearest_half'. Read for symmetry with the
   *  type-level rule columns; nothing writes it here, because the only rounding editor writes the TYPE. */
  roundingThreshold?: number | null;
};

/**
 * Whether carry-forward is enabled for a resolved policy. The carry-forward rule has an explicit
 * on/off switch (`carryForwardEnabled`); when it is absent (every pre-existing policy) we fall back
 * to the original implicit rule: carry is on iff the cap is positive. An explicit `false` disables
 * carry even when a positive cap or an expiry offset is still present in the JSONB.
 */
export function carryEnabled(pol: ResolvedPolicy | null | undefined): boolean {
  if (pol == null) return false;
  // 7cd914b1: a percentage is carry configuration too. Without this clause a type configured as
  // "carry 50% of the balance" with no fixed cap would read as carry-OFF under the back-compat rule
  // (`carryMax > 0`) and forfeit everything — the silent-zero failure this whole area is prone to.
  if ((pol.carryPercent ?? 0) > 0) return true;
  return pol.carryForwardEnabled ?? (pol.carryMax ?? 0) > 0;
}

/**
 * 7cd914b1 — HOW MANY DAYS MAY BE CARRIED, given the balance standing at year end.
 *
 * THE SINGLE DEFINITION. openLeaveYear, accrueEarnedLeave's cycle-boundary cap and the projection kernel
 * must all ask this one function, for the same reason `entitledDays` exists: three call sites that each
 * re-derive "how much carries" is how the ledger and the kernel come to disagree.
 *
 * The rule, in order:
 *   1. Carry off (`carryEnabled` false) ⇒ 0. Full forfeit, which is the existing "disable carry" behaviour
 *      and is what EVERY non-annual type resolves to until someone configures it.
 *   2. A percentage ⇒ that share of the balance actually held. 50% of 20 days is 10.
 *   3. A maximum ⇒ a CEILING, applied after the percentage. Both set ⇒ the smaller wins. This is a clamp,
 *      not a mode: `min()` cannot produce a figure the reporter did not authorise by both settings.
 *   4. Neither set, carry on ⇒ 0 by construction (carryMax defaults to 0), unchanged from before.
 *
 * NOT ROUNDED HERE, deliberately. openLeaveYear rounds the ENTITLEMENT, never the carry-in — half of 7
 * days is 3.5 and stays 3.5 unless the leave type's own rounding says otherwise at the entitlement step.
 * Introducing a second rounding rule for carry forward is explicitly out of scope (8fec719e is
 * redesigning that surface and would then have two places to change).
 */
export function resolveCarryAllowance(pol: ResolvedPolicy | null | undefined, balance: number): number {
  if (!carryEnabled(pol)) return 0;
  return carryAllowanceFrom({ balance, carryMax: pol?.carryMax ?? 0, carryPercent: pol?.carryPercent ?? null });
}

/**
 * The arithmetic half of `resolveCarryAllowance`, without the carry-enabled question.
 *
 * Split out because the RECONSTRUCTION path (`reconstructCarry`, which re-derives what openLeaveYear
 * posted from the flat ledger) has no ResolvedPolicy to hand — it is given the resolved figures. Both
 * paths must produce the identical number or the carry-forward report contradicts the ledger it is
 * reporting on, so they share this one function rather than each writing `min(balance, cap)`.
 */
export function carryAllowanceFrom(p: { balance: number; carryMax: number; carryPercent?: number | null }): number {
  const held = Math.max(0, p.balance);
  const pct = p.carryPercent ?? null;
  const max = p.carryMax ?? 0;
  // A percentage of nothing is nothing; a percentage of a held balance is that share of it.
  const fromPct = pct != null && pct > 0 ? (held * pct) / 100 : null;
  // No percentage ⇒ the cap alone decides, exactly as it did before this change.
  const allowed = fromPct != null ? (max > 0 ? Math.min(fromPct, max) : fromPct) : max;
  return Math.max(0, Math.min(held, allowed));
}

/** Is carry forward configured at all — a cap, a percentage, or neither? Drives whether an expiry DATE is
 *  emitted: a percentage-only type has no `carryMax` and must still expire what it carried. */
export function carryConfigured(p: { carryMax: number; carryPercent?: number | null }): boolean {
  return p.carryMax > 0 || (p.carryPercent ?? 0) > 0;
}

/** Parse the carry-forward expiry config into a `{month, day}` OFFSET, or null (never expires).
 *
 *  Mode is authoritative (R4 Build #1):
 *   - 'months' mode: "expire X months after year-end" ⇒ `{ month: X, day: 31 }`. The `31` is an over-max
 *     sentinel that the two build sites clamp with `lastRealDayOfMonth(year, month)` to the real last day of
 *     that month in the carry's own leave-year (so month 2 becomes 28/29, month 6 becomes 30, etc.). An
 *     empty/invalid X ⇒ null (never expires), mirroring the date "both unset" branch. Month/day keys are
 *     IGNORED in this mode so a stale cross-mode pair can never leak.
 *   - 'date' mode (or mode absent — back-compat): read month/day. Reject legacy garbage (e.g. a stored
 *     31-Feb) via `isValidMonthDay` so a phantom pre-existing value resolves to null (no expiry, no crash)
 *     rather than an impossible date. A savable 29-Feb passes here and is year-clamped at the build site.
 */
export function parseCarryExpiry(acc: AccrualConfig | null): CarryExpiry | null {
  if (acc?.carryForwardExpiryMode === 'months') {
    const x = Number(acc?.carryForwardExpiryMonths ?? 0);
    if (Number.isInteger(x) && x >= 1 && x <= 12) return { month: x, day: 31 };
    return null; // empty/invalid X ⇒ never expires
  }
  const m = Number(acc?.carryForwardExpiryMonth ?? 0);
  const d = Number(acc?.carryForwardExpiryDay ?? 0);
  if (isValidMonthDay(m, d)) return { month: m, day: d };
  return null;
}

/**
 * Leave Entitlement Rules Engine — the matching band's days for `serviceYears`, else `annualDays`.
 * DEFENSIVE BY DESIGN (parseCarryExpiry / R4-crash-fix precedent): if `serviceBands` is not an array, or
 * any row is non-numeric/negative/mis-ordered/overlapping/non-contiguous, ignore bands entirely and fall
 * back to annualDays — never throw. This runs inside openLeaveYear / accrueEarnedLeave / expireCarriedLeave
 * cron loops where a bad JSONB row must not abort a tenant sweep; seeds and hand-written rows bypass
 * write-time validation, so the runtime path must tolerate garbage.
 */
export function bandDaysFor(acc: AccrualConfig | null, serviceYears: number): number {
  return bandFor(acc, serviceYears)?.days ?? Number(acc?.annualDays ?? 0);
}

/**
 * Leave Entitlement Rules Engine — the matching well-formed band for `serviceYears`, or null (no bands /
 * malformed / no match). Same defensive contract as `bandDaysFor` (never throws inside cron sweeps), but
 * returns the whole band so callers can also read its per-range overrides (feedback 9d8cf621:
 * carryForwardDays / carryForwardExpiry / maxBalanceDays). `bandDaysFor` is a thin `?.days` over this.
 */
export function bandFor(acc: AccrualConfig | null, serviceYears: number): ServiceBand | null {
  const bands = acc?.serviceBands;
  if (!Array.isArray(bands) || bands.length === 0) return null;
  if (!isWellFormedBands(bands)) return null;
  for (const b of bands) {
    const upper = b.toYears;
    if (serviceYears >= b.fromYears && (upper == null || serviceYears < upper)) return b;
  }
  // Contiguous + open-ended-last is enforced by isWellFormedBands, so this is unreachable for a
  // well-formed array — but keep the fallback for defence-in-depth.
  return null;
}

/** Feedback 9d8cf621 — read a band's optional per-range carry-forward cap. A finite number ≥ 0 OVERRIDES
 *  the policy-level `carryForwardMax`; anything else (absent / null / negative / non-numeric) ⇒ null (fall
 *  back to the policy-level cap). Defensive: a hand-written/seed band with garbage never throws. */
export function bandCarryMax(band: ServiceBand | null | undefined): number | null {
  const v = band?.carryForwardDays;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Feedback 9d8cf621 — read a band's optional per-range carry-forward expiry offset. A valid (month, day)
 *  pair OVERRIDES the policy-level carry-expiry for this band; anything else ⇒ null (fall back). Uses the
 *  same `isValidMonthDay` guard as `parseCarryExpiry` so legacy garbage resolves to "no expiry". */
export function bandCarryExpiry(band: ServiceBand | null | undefined): CarryExpiry | null {
  const m = Number(band?.carryForwardExpiryMonth ?? NaN);
  const d = Number(band?.carryForwardExpiryDay ?? NaN);
  return isValidMonthDay(m, d) ? { month: m, day: d } : null;
}

/** Feedback 9d8cf621 — read a band's optional Maximum Balance Days cap. A finite number ≥ 0 caps the
 *  running balance (see `applyMaxBalance`); anything else ⇒ null (no cap). Defensive by the same rule. */
export function bandMaxBalance(band: ServiceBand | null | undefined): number | null {
  const v = band?.maxBalanceDays;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Feedback 9d8cf621 — true iff a policy carries ANY carry-forward expiry, either policy-level
 *  (`parseCarryExpiry`) or on any well-formed service band. Used by `expireCarriedLeave` to compute the
 *  back-compat "earliest sweepable year" boundary so a purely per-range expiry is not missed. */
export function hasAnyCarryExpiry(acc: AccrualConfig | null): boolean {
  if (parseCarryExpiry(acc) != null) return true;
  const bands = acc?.serviceBands;
  if (!Array.isArray(bands) || bands.length === 0 || !isWellFormedBands(bands)) return false;
  return bands.some((b) => bandCarryExpiry(b) != null);
}

/**
 * Feedback 9d8cf621 — Maximum Balance Days enforcement. Given the carry-in and the grant about to be
 * posted, clamp BOTH so the resulting balance (carry + grant) never exceeds the policy's cap:
 *   - the carry-in itself is clamped to the cap (a carry-in can never exceed Maximum Balance);
 *   - the grant is then clamped to the remaining room (cap − clamped carry), never below 0.
 * `maxBalanceDays` null/undefined ⇒ no cap (pass-through, byte-identical to pre-9d8cf621 behaviour).
 * Pure + rounded to 2dp to match the ledger's `toFixed(2)` precision.
 */
export function applyMaxBalance(
  carry: number,
  grant: number,
  maxBalanceDays: number | null | undefined,
): { carry: number; grant: number } {
  if (maxBalanceDays == null) return { carry, grant };
  const cap = Math.max(0, maxBalanceDays);
  const clampedCarry = Math.min(carry, cap);
  const room = Math.max(0, Math.round((cap - clampedCarry) * 100) / 100);
  return { carry: clampedCarry, grant: Math.min(Math.max(grant, 0), room) };
}

/** 2dp normalisation, mirroring the ledger's `toFixed(2)` precision (the same rule core/leave.ts's own
 *  private `round2` applies). Module-local: leave.ts keeps its own copy, so nothing is re-exported. */
function round2dp(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Feedback b81d3c52 — Rounding Method. Tidy a CALCULATED entitlement to a whole day per the leave type's
 * configured method, as the FINAL step after the earning calculation (the earning maths itself is
 * untouched). Applied by every granting/projection engine at the same point — the hire grant, the
 * year-open grant, the earned-accrual cumulative, the recalc kernel's projection and the admin preview —
 * so the credited balance, every ledger-derived display surface and the preview can never disagree.
 *
 * DEFENSIVE like `bandDaysFor` / `bandMaxBalance`: an unknown method string, null/undefined, or a
 * non-finite value passes straight through unchanged rather than throwing — these run inside cron sweeps
 * over hand-written / seeded JSONB where a bad row must not abort a tenant's whole sweep.
 *
 * 'up' ⇒ ceil to a whole day, 'down' ⇒ floor to a whole day, anything else ⇒ unchanged. Those three are
 * exactly as b81d3c52 shipped them and 9f5164d8 did not touch them — `threshold` is read by NOTHING except
 * the 'nearest_half' branch, so passing one can never move an existing type's figures.
 *
 * FEEDBACK 9f5164d8 — 'nearest_half'. The value is snapped to the 0.5-day grid, and the threshold decides
 * which way:
 *
 *     f = value − floor(value)                    the DECIMAL PORTION the request talks about
 *     f <  threshold  ⇒  floor to the 0.5 grid    (the "Round down to nearest 0.5 day" range)
 *     f >= threshold  ⇒  ceil  to the 0.5 grid    (the "Round up to nearest 0.5 day" range)
 *
 * With the default 0.500 threshold this reproduces the request's own worked default: 1.17 ⇒ 1.0 (0.17 is in
 * the down range, floor to grid), 1.50 ⇒ 1.5, 1.60 ⇒ 2.0 (0.60 is in the up range, ceil to grid). Raising
 * the threshold is what makes the half-day step visible — at 0.750, 1.60 lands on 1.5 instead of 2.0, which
 * is the behaviour a company that rounds late actually wants.
 *
 * DEFENSIVE like the rest of this file: a non-finite value or an unknown method passes straight through,
 * and a garbage threshold degrades to the default rather than throwing.
 */
export function applyRounding(
  value: number,
  method: LeaveRoundingMethod | string | null | undefined,
  threshold?: string | number | null,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (method === 'up') return round2dp(Math.ceil(value));
  if (method === 'down') return round2dp(Math.floor(value));
  if (method === 'nearest_half') {
    const t = resolveRoundingThreshold(threshold);
    const whole = Math.floor(value);
    // THE DECIMAL PORTION, ROUNDED TO THREE PLACES FIRST — the precision the threshold itself is stored at.
    // Everything below is derived from `f`, never from `value`, and that is load-bearing rather than tidy:
    // a naive `Math.ceil(value * 2) / 2` turns 1.5000000000000002 (which is what 0.1 + 0.2 + 1.2 actually
    // is in IEEE754) into 2.0 instead of 1.5, because the binary tail survives the multiply. Snapping the
    // FRACTION to the grid and adding the whole part back cannot do that.
    const f = Math.round((value - whole) * 1000) / 1000;
    // Down ⇒ the 0.5 step at or below f. Up ⇒ the 0.5 step at or above it.
    const down = f < 0.5 ? 0 : 0.5;
    const up = f === 0 ? 0 : f <= 0.5 ? 0.5 : 1;
    return round2dp(whole + (f < t ? down : up));
  }
  return value;
}

/** Validates the contiguity/shape invariant used by both the defensive resolver (bandDaysFor) and the
 *  write-time validator (core/admin.ts): every row numeric, days >= 0, fromYears integers >= 0, sorted with
 *  no gaps/overlaps, first fromYears = 0, last toYears = null, max 10 bands. */
export function isWellFormedBands(bands: unknown): bands is ServiceBand[] {
  if (!Array.isArray(bands) || bands.length === 0 || bands.length > 10) return false;
  for (const b of bands) {
    if (b == null || typeof b !== 'object') return false;
    const row = b as Record<string, unknown>;
    if (!Number.isInteger(row.fromYears) || (row.fromYears as number) < 0) return false;
    if (row.toYears !== null && !Number.isInteger(row.toYears)) return false;
    if (typeof row.days !== 'number' || !Number.isFinite(row.days) || row.days < 0) return false;
    if (row.toYears !== null && (row.toYears as number) <= (row.fromYears as number)) return false;
  }
  const rows = bands as ServiceBand[];
  if (rows[0].fromYears !== 0) return false;
  if (rows[rows.length - 1].toYears !== null) return false;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].fromYears !== rows[i - 1].toYears) return false;
  }
  // every band except the last must be closed (non-null toYears) — enforced implicitly: if an earlier
  // band had toYears === null the next band's fromYears (a number) could never equal it, so the
  // contiguity check above already rejects that shape.
  return true;
}

// ── Type-level leave RULES (feedback 9816a5ad, STEP 2 OF 3) ─────────────────────────────────────────
// Step 1 (migration 0325) added ten rule columns to `leave_type` and backfilled them from the single
// distinct value each type carried across all of its `leave_policy` rows. They were INERT — read by
// nothing. This is the seam that makes them live.
//
// THE TARGET STRUCTURE, in the reporter's words: "Annual Leave rules are the same for everyone and only
// the entitlement days differ by grade." So Leave Year Type, Earning Method, Carry Forward Policy,
// Rounding and Maximum Balance belong to the LEAVE TYPE; Benefit Scheme → Service Based Entitlements
// controls DAYS ONLY. `resolveGradePolicy` keeps doing exactly what it did — it resolves the winning
// policy row and its DAYS — and this overlay then replaces every RULE on the result with the type's own.
// Splitting it this way is deliberate: the days half is the risky half (it is what the ledger is made of)
// and it is left completely untouched, so a defect in step 2 can only ever be a wrong RULE, never a wrong
// day count from the wrong policy row.

/** The ten step-1 `leave_type` rule columns, in the shape drizzle selects them. `numeric` columns arrive
 *  as STRINGS from postgres, so both spellings are accepted and normalised below. */
export type LeaveTypeRules = {
  accrualMethod?: string | null;
  carryForwardMax?: string | number | null;
  /** 7cd914b1 (migration 0349) — the twelfth column. A percentage of the year-end balance, 0–100. */
  carryForwardPercent?: string | number | null;
  carryForwardEnabled?: boolean | null;
  carryForwardExpiryMode?: string | null;
  carryForwardExpiryMonths?: number | null;
  carryForwardExpiryMonth?: number | null;
  carryForwardExpiryDay?: number | null;
  carryForwardIncludeEarned?: boolean | null;
  roundingMethod?: string | null;
  /** Feedback 9f5164d8 (migration 0335) — the eleventh column. Read only alongside a 'nearest_half' method. */
  roundingThreshold?: string | number | null;
  maxBalanceDays?: string | number | null;
};

/** A finite number, or null — the same "absent / garbage ⇒ not configured" contract every other resolver
 *  in this file applies. Accepts postgres's numeric-as-string spelling. */
function finiteOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Does this leave type actually CARRY type-level rules? — the engagement test for `applyLeaveTypeRules`.
 *
 * THIS IS THE BACK-COMPAT GUARANTEE OF STEP 2, and it is the reason the repointing cannot move a balance
 * on a type step 1 never reached. Migration 0325's backfill only fires on a type that has `leave_policy`
 * rows to collapse, and it deliberately no-ops on a type whose columns are already set. So a type created
 * (or given its first policy) AFTER 0325 ran has ten NULL columns while its policies carry real rules —
 * and for that type the ONLY correct answer is still the policy's own rules. Engaging unconditionally
 * would silently strip such a type of its earning method, carry cap and rounding.
 *
 * `carryForwardIncludeEarned` is EXCLUDED from the test on purpose. It is config-only — persisted so HR
 * can set it, read by no engine (see AccrualConfig) — so on its own it says nothing about whether this
 * type's rules have been consolidated, and letting it flip a type onto the type-level rule set would
 * change behaviour on the strength of a field that has none.
 */
export function hasAnyLeaveTypeRule(rules: LeaveTypeRules | null | undefined): boolean {
  if (rules == null) return false;
  return (
    rules.accrualMethod != null ||
    rules.carryForwardMax != null ||
    // 7cd914b1: a percentage alone is a configured rule set. Omitting it here would leave a
    // percentage-only type "unruled", so applyLeaveTypeRules would fall through to the grade policy and
    // the percentage would be silently ignored — the whole-set overlay's failure mode.
    rules.carryForwardPercent != null ||
    rules.carryForwardEnabled != null ||
    rules.carryForwardExpiryMode != null ||
    rules.carryForwardExpiryMonths != null ||
    rules.carryForwardExpiryMonth != null ||
    rules.carryForwardExpiryDay != null ||
    rules.roundingMethod != null ||
    rules.maxBalanceDays != null
  );
}

/** Feedback 9f5164d8 — the rounding methods the ENGINE acts on, i.e. the ones `applyRounding` changes a
 *  value for. Anything else (including 'none' and NULL) means "leave the calculated value alone". One
 *  definition so the overlay, the write-time validator and the editor cannot drift apart. */
export type EngineRoundingMethod = Exclude<LeaveRoundingMethod, 'none'>;
export const ENGINE_ROUNDING_METHODS: readonly EngineRoundingMethod[] = ['up', 'down', 'nearest_half'];
export function isEngineRoundingMethod(v: unknown): v is EngineRoundingMethod {
  return typeof v === 'string' && (ENGINE_ROUNDING_METHODS as readonly string[]).includes(v);
}

/**
 * Overlay a leave type's own rules onto a policy resolved by `resolveGradePolicy`. DAYS ARE NEVER TOUCHED.
 *
 * Returns, in order:
 *   - `null` when `pol` is null. A null policy means NO policy row matched this employee's scope at all,
 *     and this function deliberately does NOT fabricate one from the type's rules. Synthesising a policy
 *     here would hand a carry cap, a rounding method and an earning method to employees who resolve no
 *     policy today (e.g. a company-scoped type where the employee's company has only other-grade rows),
 *     which is a behaviour change — and a balance change — that nothing in this item asked for. The
 *     entitlement DAYS for such an employee still come from the statutory floor / benefit scheme through
 *     `entitledDays`, exactly as before.
 *   - `pol` unchanged when the type carries no rules at all (see `hasAnyLeaveTypeRule`).
 *   - otherwise a policy with `days` from the resolved row and EVERY rule from the type.
 *
 * PER-BAND CARRY-FORWARD IS DELIBERATELY NOT READ HERE (the step-2 decision — see also `bandCarryMax` /
 * `bandCarryExpiry`, which remain exported and are still exercised by the pre-consolidation path). Once
 * the bands are days-only, a per-band carry cap or per-band carry expiry has no home and no meaning: it is
 * by definition a rule that differs per band, which is the exact duplication this consolidation removes.
 * The columns are NOT dropped — the JSONB keys, the `ServiceBand` fields and the two band readers all
 * survive untouched — they simply stop being consulted once a type's rules are consolidated. Migration
 * 0334 refuses the release if any policy actually uses them, so this can never silently reprice anyone.
 *
 * Every value is read with the SAME defensive filters the pre-consolidation resolver applies, so the
 * overlay can only ever produce a rule the engine would already have acted on:
 *   - method: a non-empty string, else undefined (⇒ the lump-sum path, per `isEarnedMethod`);
 *   - carryMax: a finite number clamped at 0, absent ⇒ 0 (`Math.max(0, Number(acc?.carryForwardMax ?? 0))`);
 *   - carryExpiry: routed through `parseCarryExpiry` itself, so mode precedence and the 31-Feb rejection
 *     are literally the same code rather than a re-implementation that could drift;
 *   - carryForwardEnabled: a real boolean, else undefined (⇒ the `carryEnabled` cap > 0 back-compat rule);
 *   - roundingMethod: only 'up' / 'down' are honoured, matching `resolveGradePolicy` exactly;
 *   - maxBalanceDays: a finite number >= 0, else null (no cap).
 */
export function applyLeaveTypeRules(
  pol: ResolvedPolicy | null,
  rules: LeaveTypeRules | null | undefined,
): ResolvedPolicy | null {
  if (pol == null) return null;
  if (!hasAnyLeaveTypeRule(rules)) return pol;
  const r = rules as LeaveTypeRules;
  const carryMax = finiteOrNull(r.carryForwardMax);
  const carryPercent = finiteOrNull(r.carryForwardPercent);
  const maxBalance = finiteOrNull(r.maxBalanceDays);
  const method = typeof r.accrualMethod === 'string' && r.accrualMethod !== '' ? r.accrualMethod : undefined;
  return {
    days: pol.days,
    carryMax: carryMax != null ? Math.max(0, carryMax) : 0,
    method,
    // Reuse parseCarryExpiry rather than restate it: a NULL mode is the back-compat 'date' branch, exactly
    // as an absent `carryForwardExpiryMode` is on the JSONB side.
    carryExpiry: parseCarryExpiry({
      carryForwardExpiryMode: r.carryForwardExpiryMode === 'months' ? 'months' : 'date',
      carryForwardExpiryMonths: r.carryForwardExpiryMonths ?? undefined,
      carryForwardExpiryMonth: r.carryForwardExpiryMonth ?? undefined,
      carryForwardExpiryDay: r.carryForwardExpiryDay ?? undefined,
    }),
    carryForwardEnabled: typeof r.carryForwardEnabled === 'boolean' ? r.carryForwardEnabled : undefined,
    // 7cd914b1 — clamped to 0..100 here, at the same defensive boundary every other rule is filtered at,
    // so a stored 500 cannot hand back five times the balance even if the write-time validator is bypassed.
    carryPercent: carryPercent != null ? Math.min(100, Math.max(0, carryPercent)) : null,
    maxBalanceDays: maxBalance != null ? Math.max(0, maxBalance) : null,
    // 9f5164d8 widened this from the 'up'/'down' pair to the ENGINE_ROUNDING_METHODS set. 'none' and NULL
    // still resolve to undefined (no rounding) exactly as before, so no configured type moves.
    roundingMethod: isEngineRoundingMethod(r.roundingMethod) ? r.roundingMethod : undefined,
    // Carried alongside so the 'nearest_half' branch can read it. Deliberately NOT gated on the method:
    // applyRounding ignores it for every other method, and dropping it here would mean a type that
    // temporarily switches away from 'nearest_half' and back loses the threshold it had configured.
    roundingThreshold: finiteOrNull(r.roundingThreshold),
  };
}

/** Resolve the leave policy for an employee's grade among a type's active policies: the most-generous
 *  policy scoped to the employee's grade, else the most-generous null-grade (all-grades) policy, else
 *  null. With no grades assigned (employee + every policy null-grade) this is exactly the pre-2E
 *  "most generous active policy" pick, so existing behavior is unchanged.
 *
 *  ADR-0066 — PER-COMPANY SCOPE (strict short-circuit). When `employeeCompanyId` is provided, resolution
 *  happens entirely within ONE scope tier: if ANY active policy is scoped to the employee's company, the
 *  company-scoped subset RESOLVES the policy (grade-match beats null-grade, max-days within that subset) and
 *  the group (null-company) tier is NEVER consulted — so a company override ALWAYS wins for that company,
 *  even when it grants FEWER days than the group default. Otherwise we fall back to the group (null-company)
 *  subset, resolved exactly as before. Grade tiering (grade > null-grade) and the max-days "most generous"
 *  pick are preserved WITHIN whichever scope wins. When `employeeCompanyId` is undefined OR no row is
 *  company-scoped, behaviour is byte-identical to the pre-0066 resolver (the back-compat guarantee).
 *
 *  Leave Entitlement Rules Engine: `serviceYears` is REQUIRED (not defaulted) so every call site must
 *  supply it explicitly — a silent default would resolve the 0-year band without the caller intending it.
 *  The "most generous" comparison and all tiering operate on BAND-RESOLVED days (via `bandDaysFor`), so a
 *  policy with a lower flat `annualDays` but a higher band for this service length can still win. Back-compat:
 *  a policy with no `serviceBands` resolves to the same `annualDays` at any serviceYears (bandDaysFor no-op).
 */
export function resolveGradePolicy(
  rows: GradePolicyRow[],
  employeeGradeId: string | null,
  employeeCompanyId: string | null | undefined,
  serviceYears: number,
): ResolvedPolicy | null {
  const pick = (subset: GradePolicyRow[]): ResolvedPolicy | null => {
    let best: ResolvedPolicy | null = null;
    for (const r of subset) {
      const acc = r.accrual as AccrualConfig | null;
      // Feedback 9d8cf621: resolve the winning band ONCE so days AND its per-range overrides
      // (carryForwardDays / carryForwardExpiry / maxBalanceDays) all come from the SAME band.
      const band = bandFor(acc, serviceYears);
      const days = band?.days ?? Number(acc?.annualDays ?? 0);
      // CRITICAL (panel): carryExpiry must be chosen from the SAME winning policy as days/carryMax/method.
      // Assign it inside this block — never outside — or a rejected lower-`days` policy's expiry can leak
      // onto the selected policy. The per-range band overrides ride along under the same discipline.
      if (!best || days > best.days) {
        // Feedback 9d8cf621: a per-range carry-forward cap on the winning band OVERRIDES the policy-level
        // carryForwardMax; a per-range expiry OVERRIDES the policy-level carry-expiry. Absent ⇒ fall back.
        const perRangeCarry = bandCarryMax(band);
        const perRangeExpiry = bandCarryExpiry(band);
        best = {
          days,
          carryMax: perRangeCarry ?? Math.max(0, Number(acc?.carryForwardMax ?? 0)),
          method: acc?.method,
          carryExpiry: perRangeExpiry ?? parseCarryExpiry(acc),
          // Same discipline as carryExpiry above: take the enable flag from the SAME winning policy —
          // never let a rejected lower-`days` policy's flag leak onto the selected one. Absent ⇒ undefined
          // (the `carryEnabled` back-compat default then applies).
          carryForwardEnabled:
            typeof acc?.carryForwardEnabled === 'boolean' ? acc.carryForwardEnabled : undefined,
          // Feedback 9d8cf621: Maximum Balance Days from the winning band (null = no cap).
          maxBalanceDays: bandMaxBalance(band),
          // Feedback b81d3c52: the Rounding Method rides the SAME winning policy row as days/method —
          // assigned INSIDE this block under the identical discipline as carryExpiry/carryForwardEnabled,
          // so a rejected lower-`days` policy can never leak its rounding onto the selected one.
          // Only real engine methods are honoured; anything else (absent / garbage) ⇒ undefined ⇒ none.
          // 9f5164d8 widened the set here as well as on the type-level overlay, deliberately: an engine that
          // honoured a method through one storage home and silently ignored it through the other is the
          // shape of defect that takes a release to notice. Nothing writes 'nearest_half' into this JSONB
          // today — the only editor writes the leave TYPE — so this is symmetry, not a live path.
          roundingMethod: isEngineRoundingMethod(acc?.roundingMethod) ? acc.roundingMethod : undefined,
          roundingThreshold: finiteOrNull(acc?.roundingThreshold),
        };
      }
    }
    return best;
  };
  // Resolve grade tiering (grade-match beats null-grade) within a single scope subset.
  const resolveWithinScope = (scope: GradePolicyRow[]): ResolvedPolicy | null => {
    const graded = employeeGradeId ? pick(scope.filter((r) => r.gradeId === employeeGradeId)) : null;
    return graded ?? pick(scope.filter((r) => r.gradeId == null));
  };
  // ADR-0066 strict scope short-circuit: if the employee's company has ANY policy, resolve entirely
  // within that company tier and NEVER fall back to group — even if the group default is more generous.
  if (employeeCompanyId != null) {
    const companyScope = rows.filter((r) => r.companyId === employeeCompanyId);
    if (companyScope.length > 0) return resolveWithinScope(companyScope);
  }
  // Group tier: only null-company policies. Filtering to companyId == null keeps a company-scoped policy
  // from leaking into the group fallback for employees of OTHER companies.
  const groupScope = rows.filter((r) => r.companyId == null);
  return resolveWithinScope(groupScope);
}

/**
 * THE STATUTORY FLOOR IS ADVISORY, NOT AN OVERRIDE (feedback fa3f4ccb).
 *
 * Until fa3f4ccb the entitlement composition was `max(statutoryFloor, configured)`: a configured figure
 * below the Employment Act minimum was silently replaced by the minimum, with nothing on screen saying so.
 * The reporter asked twice for that override to go and approved the change in writing, on the record that
 * the people who configure this are trained HR practitioners and that responsibility for staying lawful
 * moves to them. So the floor no longer participates in the arithmetic anywhere.
 *
 * It is still COMPUTED and still carried, because the surfaces have to warn. `belowStatutoryFloor` is that
 * one signal: derived HERE, beside the resolution it describes, so a screen never recomputes the floor for
 * itself — recomputation is exactly how the figure shown and the figure granted drift apart.
 *
 * NOT part of this change, and deliberately untouched: the EA-1955 right to APPLY for annual and sick
 * leave (core/leave.ts), and the statutory guard in updateLeaveType that stops lawful-entitlement codes
 * being misconfigured. Different protections; neither was asked about.
 */
export function belowStatutoryFloor(floorDays: number | null | undefined, days: number): boolean {
  return floorDays != null && Number.isFinite(floorDays) && days < floorDays;
}

/** Leave Entitlement Rules Engine — the admin preview's result shape. Mirrors what resolveGradePolicy
 *  produces, plus which scope tier won and whether the resolved figure sits under the statutory minimum,
 *  so the UI can render the warning without duplicating the resolution logic. */
export type PreviewResult = {
  /** The statutory floor for this leave type / service length, or null when no pack applies (non-MY company).
   *  fa3f4ccb: ADVISORY — it is what the warning quotes, never what the grant uses. */
  floorDays: number | null;
  /** The resolved policy's days (band-resolved), or null when no policy matches at all (no default exists). */
  policyDays: number | null;
  /** The final granted amount: the CONFIGURED figure (policyDays ?? 0), rounded. fa3f4ccb removed the
   *  `max(floorDays, …)` clamp that used to sit here. */
  days: number;
  /** Which scope tier the winning policy came from. 'none' = no policy matched (nothing configured). */
  scope: 'company' | 'group' | 'none';
  /** fa3f4ccb (was `floorApplied`): the resolved figure is BELOW the statutory minimum. The rename is the
   *  point — it used to mean "the floor overrode you", it now means "you are under the minimum, and we let
   *  you". The UI reads exactly this rather than comparing the two numbers itself. */
  belowStatutoryFloor: boolean;
};

/**
 * Leave Entitlement Rules Engine — runs the EXACT SAME resolveGradePolicy the server engines use, so the
 * admin preview can never disagree with a real grant. `floorDays` is passed in by the caller (the client
 * component imports `entitlement` from localization/my/leave directly — see components/leave-rule-preview.tsx
 * — because the full pack registry is not client-safe); pass null when no statutory pack applies.
 *
 * fa3f4ccb: this and `entitledDays` MUST move together — the guarantee above is why the preview restates
 * the composition at all, and a preview that still clamped to the floor would promise days the engines no
 * longer grant.
 */
export function previewEntitlement(
  rows: GradePolicyRow[],
  employeeGradeId: string | null,
  employeeCompanyId: string | null,
  serviceYears: number,
  floorDays: number | null,
): PreviewResult {
  const policy = resolveGradePolicy(rows, employeeGradeId, employeeCompanyId, serviceYears);
  const policyDays = policy?.days ?? null;
  // Feedback b81d3c52 — the preview must show the TIDIED figure, because that is what the engines credit.
  // Rounding is applied to the composed entitlement (the `entitledDays` equivalent) at exactly the point
  // the granting engines apply it, so this function's docstring guarantee ("the admin preview can never
  // disagree with the real engine") still holds once a Rounding Method is configured. `floorDays` /
  // `policyDays` stay RAW so the UI can still quote the minimum in its warning.
  const days = applyRounding(policyDays ?? 0, policy?.roundingMethod, policy?.roundingThreshold);
  // Derive which scope tier actually won, mirroring resolveGradePolicy's own subset filters exactly —
  // including the case where the company scope EXISTS but resolves to a policy days of 0 (i.e. the
  // company has only other-grade rows and no null-grade default): scope is still 'company' (short-circuit
  // never falls back to group), policyDays reflects whatever pick() returned (possibly null).
  const companyScope = employeeCompanyId != null ? rows.filter((r) => r.companyId === employeeCompanyId) : [];
  const scope: PreviewResult['scope'] = companyScope.length > 0 ? 'company' : policy ? 'group' : 'none';
  return { floorDays, policyDays, days, scope, belowStatutoryFloor: belowStatutoryFloor(floorDays, days) };
}

// ── Benefit Scheme & Leave Entitlement resolution (feedback b83c6a3b) — RSC-SAFE, pure ───────────────
// A friendlier configuration LAYER over the grade-scoped engine above. A benefit scheme names a
// (company × employment_type × grade_group) target and carries per-leave-type service-band day tables
// (scheme_leave_entitlement.serviceBands, the SAME ServiceBand shape resolved by `bandDaysFor`). An
// employee resolves to ONE scheme — a manual override on their employment, else an auto-match — and that
// scheme's entitlement days SUPERSEDE the grade leave_policy days. The EA-1955 floor still applies on top
// (max(floor, schemeDays)) exactly as it does for policy days, so a scheme can never drop below statute.

/** A benefit scheme's auto-match identity (the columns the resolver needs). `status` gates usability. */
export type BenefitSchemeRow = {
  id: string;
  companyId: string;
  employmentType: string;
  gradeGroupId: string | null;
  status: string; // 'active' | 'inactive'
};

/** The employee attributes that pick a scheme: their company, CURRENT-assignment employment type, the
 *  grade group their grade belongs to (null = ungrouped), and any manual override scheme id. */
export type SchemeMatchSubject = {
  companyId: string;
  employmentType: string | null;
  gradeGroupId: string | null;
  overrideSchemeId: string | null;
};

/**
 * Resolve the effective benefit-scheme id for an employee. Precedence:
 *   1. Manual override — when `overrideSchemeId` points at an ACTIVE scheme, it wins outright (HR's
 *      explicit assignment on the employee record).
 *   2. Auto-match — the ACTIVE scheme whose (companyId, employmentType, gradeGroupId) all equal the
 *      employee's. The DB keeps at most one active scheme per that triple (partial-unique index), but the
 *      resolver is defensive: if several match it picks the lowest id (deterministic), never throws.
 *   3. Otherwise null — the employee falls back to the grade-scoped leave_policy (back-compat).
 * An override pointing at an INACTIVE / unknown scheme is ignored (falls through to auto-match), so
 * deactivating a scheme cleanly reverts its overridden employees to auto-match.
 */
export function resolveEffectiveSchemeId(
  schemes: BenefitSchemeRow[],
  subject: SchemeMatchSubject,
): string | null {
  if (subject.overrideSchemeId) {
    const ov = schemes.find((s) => s.id === subject.overrideSchemeId && s.status === 'active');
    if (ov) return ov.id;
  }
  const matches = schemes.filter(
    (s) =>
      s.status === 'active' &&
      s.companyId === subject.companyId &&
      s.employmentType === subject.employmentType &&
      s.gradeGroupId === subject.gradeGroupId,
  );
  if (matches.length === 0) return null;
  return matches.slice().sort((a, b) => a.id.localeCompare(b.id))[0].id;
}

/**
 * The scheme entitlement days for a service length: the matching service band's `days`, else null.
 * REUSES `bandFor` (defensive — never throws on malformed JSONB inside cron sweeps) by wrapping the
 * scheme's stored `serviceBands` in an AccrualConfig. Returns null when the bands are absent / malformed
 * / non-matching, which the caller reads as "this scheme has no usable entitlement for this type — fall
 * back to the grade policy". A well-formed contiguous band set (from 0, open-ended last) always matches,
 * so a configured scheme returns its band days (possibly 0, an explicit "no days" — still supersedes).
 */
export function schemeBandDays(serviceBands: unknown, serviceYears: number): number | null {
  const band = bandFor({ serviceBands: serviceBands as ServiceBand[] } as AccrualConfig, serviceYears);
  return band ? band.days : null;
}

/**
 * Auto-link entitlement to profile (feedback ae5b84d5) — the ONE composition of benefit-scheme days ×
 * grade-policy days used by EVERY granting/projection site (openLeaveYear, the hire grant,
 * accrueEarnedLeave, projectExpectedEntitlement): a resolved scheme entitlement SUPERSEDES the grade
 * policy days (even an explicit 0). `schemeDays` null = no scheme / no entitlement for the type ⇒ fall
 * back to the policy days. Keeping the formula in one pure helper removes the drift class the recalc/cron
 * idempotency depends on.
 *
 * fa3f4ccb — THE STATUTORY FLOOR NO LONGER CLAMPS. This used to be
 * `Math.max(floorDays, schemeDays ?? policyDays)`; the resolved value is now `schemeDays ?? policyDays`
 * and nothing else. See `belowStatutoryFloor` above for why (approved in writing, twice asked for) and
 * for the boundaries of the change.
 *
 * `floorDays` STAYS in the signature and stays computed at every call site, and the helper returns it as
 * a FLAG rather than folding it into the number. Two reasons, both learned the hard way:
 *   - a screen that wants to warn "this is under the EA minimum" must read the same floor the engine saw,
 *     not recompute one of its own;
 *   - a silently-ignored argument is worse than no argument. Returning `{ days, belowStatutoryFloor }`
 *     means every input still has a job, and a reader can see at a glance that the floor informs but does
 *     not decide.
 * `floorDays` is supplied by the CALLER from the company's country pack and is 0 / null for jurisdictions
 * with no pack — those already ran with no floor, so this makes MY behave like everywhere else.
 */
export function entitledDays(
  floorDays: number,
  schemeDays: number | null,
  policyDays: number,
): { days: number; belowStatutoryFloor: boolean } {
  const days = schemeDays ?? policyDays;
  return { days, belowStatutoryFloor: belowStatutoryFloor(floorDays, days) };
}
