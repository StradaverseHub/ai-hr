/**
 * Pure entitlement resolution + client-safe types/constants — RSC-SAFE: this module imports NO db/postgres.
 *
 * Split out of core/leave.ts (which imports ../db/client → postgres at module scope) following the
 * core/loans-compute.ts precedent verbatim, so client components can import the pure band/rounding
 * resolvers and the constants without dragging postgres into the browser bundle. `next build` rejects a
 * 'use client' → core/leave → db/client edge as module-not-found; tsc + vitest do NOT run `next build`, so
 * that boundary must be kept clean by construction. core/leave.ts imports and re-exports everything here,
 * so server callers + tests keep importing from '@/core/leave' (including core/admin.ts's isValidMonthDay
 * import).
 *
 * 6e9a126e RELEASE THREE — THE TWO OLD LAYERS ARE GONE FROM THIS FILE. `resolveGradePolicy` (the
 * grade/company `leave_policy` resolver), `previewEntitlement`, `entitledDays`, `bandDaysFor`,
 * `hasAnyCarryExpiry` and the whole benefit-scheme match (`resolveEffectiveSchemeId` / `schemeBandDays`)
 * were deleted with the surface that fed them: nothing reads `leave_policy`, `benefit_scheme` or
 * `scheme_leave_entitlement` any more, so a pure resolver over rows nobody loads is a trap, not a spare
 * part. An entitlement template's band is now the ONLY source of days — see `composeEntitlement`.
 *
 * WHAT SURVIVED AND WHY: `bandFor` / `bandCarryMax` / `bandCarryExpiry` / `bandMaxBalance` /
 * `validateServiceBands` are the SERVICE-BAND vocabulary, and `entitlement_template.service_bands` stores
 * exactly that shape — core/entitlement-template.ts resolves through them. `AccrualConfig` survives as
 * their argument shape (and `parseCarryExpiry`'s), not as a live storage format.
 */

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
  /** bc36c768 — the day of the month 'earned_monthly' credits on (1..31), resolved from the leave TYPE.
   *  null/absent ⇒ day 1, which is byte-identical to every pre-bc36c768 configuration and is what the
   *  pre-consolidation `leave_policy.accrual` path always resolves to (the JSONB has no such key: an
   *  accrual day is a type-level rule and was never a per-policy one). Read ONLY by `earnedToDateFor`'s
   *  monthly branch. */
  accrualDay?: number | null;
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
  /** 8fec719e — the CUSTOM ROUNDING TABLE, read ONLY by the 'custom' method. null/absent ⇒ nothing to
   *  apply, so 'custom' with no table is byte-identical to No Rounding. See `applyRoundingBands`. */
  roundingBands?: RoundingBand[] | null;
};

/**
 * 8fec719e — ONE ROW of the custom rounding table the reporter fills in: "a decimal portion from `from`
 * up to `to` becomes `result`".
 *
 * THE UNIT IS THE DECIMAL PORTION, NOT THE WHOLE VALUE. A band is matched against `value − floor(value)`,
 * and the whole-day part is added back untouched. That is what makes ONE table usable at every
 * entitlement size: the reporter writes the table once for 0.000–1.000 and it shapes 1.17, 10.17 and
 * 21.17 identically, which is exactly how the three fixed methods it replaces behaved.
 *
 *   from   inclusive lower bound of the decimal portion, 0 <= from < to
 *   to     upper bound. EXCLUSIVE, except for a band ending at exactly 1.000, which is inclusive — so a
 *          table ending at 1.000 has no unreachable sliver at the top and `result: 1` means "round up to
 *          the next whole day" (the old 'up' method, expressible as a single row 0 → 1 ⇒ 1).
 *   result what the decimal portion becomes, 0 <= result <= 1. `whole + result` is credited.
 */
export type RoundingBand = { from: number; to: number; result: number };

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
 *  none/nearest) — different domain, different values, deliberately no shared code.
 *
 *  8fec719e — THE CHOICE IS NOW TWO, THE VOCABULARY IS STILL FIVE, and the difference is the whole point:
 *   - 'none' and 'custom' are what an administrator may CHOOSE (see USER_ROUNDING_METHODS). 'custom'
 *     evaluates the leave type's own `roundingBands` table and subsumes all three fixed methods —
 *     one row 0→1 ⇒ 1 is Round Up, one row 0→1 ⇒ 0 is Round Down, and the two-row 0→0.5 ⇒ 0 /
 *     0.5→1 ⇒ 0.5 table is Nearest 0.5 Day.
 *   - 'up' / 'down' / 'nearest_half' are RETIRED AS CHOICES but NOT as values. `applyRounding` still
 *     honours them, deliberately: migration 0358 clears both storage surfaces, but this evaluator also
 *     runs against seeds, fixtures and hand-written JSONB that no migration reaches, and quietly turning
 *     a stored 'up' into no-rounding would move a figure without anybody asking. They can no longer be
 *     WRITTEN (setLeaveTypeRules refuses them) — only read. */
export type LeaveRoundingMethod = 'none' | 'up' | 'down' | 'nearest_half' | 'custom';

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
  /** Leave Entitlement Rules Engine: the service-length band table. Contiguous, first fromYears = 0, last
   *  toYears = null, at most MAX_SERVICE_BANDS bands — enforced at write time (`validateServiceBands`); the
   *  resolver (`bandFor`) is DEFENSIVE and ignores a malformed array rather than throwing. Since 6e9a126e
   *  release three this is the ONLY field of this type anything still reads: it is the shape
   *  `entitlement_template.service_bands` stores, wrapped by core/entitlement-template.ts. */
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
 * must all ask this one function, for the same reason `composeEntitlement` exists: three call sites that
 * each re-derive "how much carries" is how the ledger and the kernel come to disagree.
 *
 * The rule, in order:
 *   1. Carry off (`carryEnabled` false) ⇒ 0. Full forfeit, which is the existing "disable carry" behaviour
 *      and is what EVERY non-annual type resolves to until someone configures it.
 *   2. A percentage ⇒ that share of the balance actually held. 50% of 20 days is 10.
 *   3. A maximum ⇒ a CEILING, applied after the percentage. Both set ⇒ the smaller wins. This is a clamp,
 *      not a mode: `min()` cannot produce a figure the reporter did not authorise by both settings.
 *      7cd914b1 rev 2 — THE EDITOR NO LONGER OFFERS THE TWO TOGETHER. Percentage mode posts
 *      carryForwardMax=0, and migration 0386 cleared the rows that already held both, so this clamp is
 *      unreachable from the UI for new saves. IT STAYS ON PURPOSE: it is the defence against a
 *      hand-written UPDATE that sets both columns, and against a row restored from an old dump. Do not
 *      "simplify" it away — a stored cap silently trimming a percentage is exactly the reported defect,
 *      and this function is the only place that would still catch it.
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
 * Leave Entitlement Rules Engine — the matching well-formed band for `serviceYears`, or null (no bands /
 * malformed / no match). DEFENSIVE BY DESIGN (parseCarryExpiry / R4-crash-fix precedent): if
 * `serviceBands` is not an array, or any row is non-numeric/negative/mis-ordered/overlapping/
 * non-contiguous, ignore bands entirely and return null — never throw. This runs inside openLeaveYear /
 * accrueEarnedLeave / expireCarriedLeave cron loops where a bad JSONB row must not abort a tenant sweep;
 * seeds and hand-written rows bypass write-time validation, so the runtime path must tolerate garbage.
 *
 * Returns the whole band so callers can also read its per-range overrides (feedback 9d8cf621:
 * carryForwardDays / carryForwardExpiry / maxBalanceDays).
 *
 * 6e9a126e release three deleted `bandDaysFor`, the `?.days ?? annualDays` wrapper over this: `annualDays`
 * was the flat `leave_policy` figure a band sat ABOVE, and there is no policy row left to fall back to.
 * An entitlement template is bands and nothing else, so the caller reads `bandFor(...)?.days`.
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

// 6e9a126e release three deleted `hasAnyCarryExpiry`. It answered "does this leave_policy row carry a
// carry-expiry anywhere, policy-level or per-band", and its ONE caller was `expireCarriedLeave`'s
// unfiltered `leave_policy` scan — the back-compat arm that decided the earliest sweepable year for a type
// step 1 (9816a5ad) never reached. With no policy rows to scan, the sweep reads the leave TYPE's own
// carry-expiry columns and nothing else, which is what every consolidated type already used.

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
 * DEFENSIVE like `bandFor` / `bandMaxBalance`: an unknown method string, null/undefined, or a
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
 *
 * FEEDBACK 8fec719e — 'custom'. The value's decimal portion is looked up in the leave type's own band
 * table and replaced by that band's `result` (see `applyRoundingBands`). This is the ONLY method an
 * administrator can now choose besides No Rounding, and it expresses all three of the fixed methods it
 * replaces. `bands` is read by NOTHING except this branch, so passing one can never move a figure on a
 * type configured with any other method — the same containment 9f5164d8's `threshold` has.
 */
export function applyRounding(
  value: number,
  method: LeaveRoundingMethod | string | null | undefined,
  threshold?: string | number | null,
  bands?: unknown,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (method === 'custom') return applyRoundingBands(value, bands);
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

/**
 * 8fec719e — WHAT IS WRONG WITH A CUSTOM ROUNDING TABLE. One shape, returned as a LIST rather than a
 * first-failure, because the editor draws every problem at once and the service names every problem it
 * refuses. `checkRoundingBands` is the SINGLE authority: the client component imports this exact function
 * for its live hints (this module is RSC-safe, which is why it can), and `setLeaveTypeRules` calls it
 * again before writing. The UI hints are a courtesy; the service call is the guard. A second
 * implementation for the browser is a second thing that can disagree with what actually saves.
 *
 * THE GAP IS A WARNING, NOT AN ERROR, and that asymmetry is deliberate. An overlap or a duplicate means
 * the table has TWO answers for one decimal and the engine would silently pick one — unresolvable, so it
 * is refused. A gap means the table has NO answer for part of the range, and there IS a defined answer
 * for that: the value is left exactly as calculated (`applyRoundingBands` falls through). A
 * half-finished table must be savable, or an administrator cannot build one row at a time.
 */
export type RoundingBandProblem =
  /** a row that is not three finite numbers at all */
  | { kind: 'shape'; index: number }
  /** a bound outside 0.000–1.000 (from, to and result all live in the decimal portion) */
  | { kind: 'range'; index: number }
  /** from >= to — an empty or inverted band, which can never match anything */
  | { kind: 'order'; index: number }
  /** the SAME (from, to) appears twice; `index` is the later row */
  | { kind: 'duplicate'; index: number }
  /** this row's interval intersects an earlier row's; `index` is the later row */
  | { kind: 'overlap'; index: number }
  /** part of 0.000–1.000 that no row covers. WARNING only — see the header. */
  | { kind: 'gap'; from: number; to: number };

/** Three decimal places, matching the precision the reporter's own tables are written at and the one
 *  `applyRounding`'s nearest-half branch already snaps the decimal portion to. Comparing at this
 *  precision is what stops 0.1 + 0.2 = 0.30000000000000004 from reading as an overlap. */
const bandRound = (n: number) => Math.round(n * 1000) / 1000;

export function checkRoundingBands(bands: unknown): RoundingBandProblem[] {
  const out: RoundingBandProblem[] = [];
  if (!Array.isArray(bands)) return [{ kind: 'shape', index: 0 }];
  const rows: { from: number; to: number; i: number }[] = [];
  bands.forEach((b, i) => {
    const row = b as Record<string, unknown> | null;
    const nums = [row?.from, row?.to, row?.result];
    if (row == null || typeof row !== 'object' || nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      out.push({ kind: 'shape', index: i });
      return;
    }
    const from = bandRound(row.from as number);
    const to = bandRound(row.to as number);
    const result = bandRound(row.result as number);
    if (from < 0 || from > 1 || to < 0 || to > 1 || result < 0 || result > 1) {
      out.push({ kind: 'range', index: i });
      return;
    }
    if (from >= to) {
      out.push({ kind: 'order', index: i });
      return;
    }
    rows.push({ from, to, i });
  });
  // Pairwise rather than sort-then-compare-neighbours: the rows are in the order the administrator typed
  // them, a table is a handful of rows, and reporting the LATER row of a clashing pair is what lets the
  // editor highlight the row the person is working on rather than the one they finished earlier.
  for (let a = 0; a < rows.length; a++) {
    for (let z = a + 1; z < rows.length; z++) {
      const x = rows[a];
      const y = rows[z];
      if (x.from === y.from && x.to === y.to) out.push({ kind: 'duplicate', index: y.i });
      else if (x.from < y.to && y.from < x.to) out.push({ kind: 'overlap', index: y.i });
    }
  }
  // Coverage is only meaningful once the rows are individually sane; on a broken table the gaps would be
  // an artefact of the rows we already refused, and reporting both would bury the real problem.
  if (out.length === 0) {
    let cursor = 0;
    for (const r of [...rows].sort((p, q) => p.from - q.from)) {
      if (r.from > cursor) out.push({ kind: 'gap', from: cursor, to: r.from });
      cursor = Math.max(cursor, r.to);
    }
    if (cursor < 1) out.push({ kind: 'gap', from: cursor, to: 1 });
  }
  return out;
}

/** The half of `checkRoundingBands` that REFUSES a save: everything except the gap warning. */
export function roundingBandErrors(bands: unknown): RoundingBandProblem[] {
  return checkRoundingBands(bands).filter((p) => p.kind !== 'gap');
}

/** A table the engine will act on: a non-empty array with no ERROR-class problem. Gaps are permitted (the
 *  uncovered decimals simply keep their calculated value), so a part-built table rounds what it covers. */
export function isWellFormedRoundingBands(bands: unknown): bands is RoundingBand[] {
  return Array.isArray(bands) && bands.length > 0 && roundingBandErrors(bands).length === 0;
}

/**
 * 8fec719e — evaluate a custom rounding table against a calculated entitlement.
 *
 *     whole = floor(value)
 *     f     = the decimal portion, snapped to three places FIRST (the 9f5164d8 precedent, and load-bearing
 *             for the same reason: 0.1 + 0.2 + 1.2 is 1.5000000000000002 in IEEE754, and a raw compare
 *             would drop it in the band above the one an administrator reading the table expects)
 *     hit   = the band with from <= f < to, or from <= f <= to for a band closing at exactly 1.000
 *     out   = whole + hit.result
 *
 * A WHOLE VALUE IS NEVER MOVED. f === 0 returns immediately, before any lookup. Every method this
 * replaces behaved that way (ceil, floor and the nearest-half branch all leave 11.0 at 11.0), and without
 * the guard a first band of 0.000→0.500 ⇒ 0.500 would quietly hand out half a day to everyone whose
 * entitlement came out whole — a table that looks like "round the stragglers up" silently inflating the
 * exact figures.
 *
 * DEFENSIVE, like every other resolver here: a malformed table, an unmatched decimal (a gap) or a
 * non-finite value all leave the value EXACTLY as calculated. Refusing to round is always recoverable;
 * rounding on a table nobody could validate is not.
 */
export function applyRoundingBands(value: number, bands: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (!isWellFormedRoundingBands(bands)) return value;
  const whole = Math.floor(value);
  const f = Math.round((value - whole) * 1000) / 1000;
  if (f === 0) return round2dp(value);
  for (const b of bands) {
    const from = bandRound(b.from);
    const to = bandRound(b.to);
    if (f >= from && (to >= 1 ? f <= to : f < to)) return round2dp(whole + bandRound(b.result));
  }
  return value;
}

/**
 * 6e9a126e — THE BAND CEILING. Twenty, and it MUST equal core/admin.ts's write-time limit.
 *
 * These are the defensive resolver and the write-time validator for the SAME array. If they disagree the
 * writer accepts a table the resolver then silently rejects as malformed — which does not throw, it just
 * resolves to no band, i.e. the wrong number of days with nothing on screen to say so. So the constant is
 * declared ONCE here and imported by core/admin.ts's `validateServiceBands`; there is no second literal to
 * forget.
 *
 * The reporter asked for HR-defined service ranges instead of the three hardcoded ones and did NOT name a
 * ceiling — 20 is OUR number, stated in the plan's business half. It only ever widens: every existing
 * table (production's are all 3 bands) stays valid, and nobody loses a band.
 */
export const MAX_SERVICE_BANDS = 20;

/** Validates the contiguity/shape invariant used by both the defensive resolver (bandFor) and the
 *  write-time validator (core/admin.ts): every row numeric, days >= 0, fromYears integers >= 0, sorted with
 *  no gaps/overlaps, first fromYears = 0, last toYears = null, at most MAX_SERVICE_BANDS bands. */
export function isWellFormedBands(bands: unknown): bands is ServiceBand[] {
  if (!Array.isArray(bands) || bands.length === 0 || bands.length > MAX_SERVICE_BANDS) return false;
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

/**
 * Leave Entitlement Rules Engine — write-time validation of the service-band array (the runtime resolver
 * `bandFor` is separately DEFENSIVE for rows that bypass this, e.g. seeds/hand-written data). Throws a
 * plain-English Error naming the specific defect: integers for
 * fromYears/toYears, days >= 0, first band fromYears = 0, contiguous (each next fromYears = previous
 * toYears), last band toYears = null (open-ended), at most MAX_SERVICE_BANDS bands (20 since 6e9a126e).

 *
 * 6e9a126e MOVED IT HERE FROM core/admin.ts, byte-identical apart from the ceiling constant. Release
 * three retired the two `leave_policy` writers it also guarded, so `entitlement_template`'s create and
 * update are now its only callers — and it belongs beside `isWellFormedBands`, whose ceiling it must
 * always match. A private copy
 * per writer is the duplicate-maintenance defect this feedback item is about.
 */
export function validateServiceBands(bands: ServiceBand[]): void {
  if (bands.length === 0) throw new Error('Service bands: provide at least one band, or remove the block entirely.');
  // 6e9a126e — the ceiling is imported, not restated. This validator and `isWellFormedBands` (the defensive
  // resolver's twin) must move together or the writer accepts a table the resolver rejects as malformed —
  // which does not throw, it resolves to NO band, i.e. a wrong day count with nothing on screen to say so.
  if (bands.length > MAX_SERVICE_BANDS) {
    throw new Error(`Service bands: at most ${MAX_SERVICE_BANDS} bands are allowed.`);
  }
  for (const b of bands) {
    if (!Number.isInteger(b.fromYears) || b.fromYears < 0) {
      throw new Error('Service bands: "from" years must be a whole number ≥ 0.');
    }
    if (b.toYears !== null && (!Number.isInteger(b.toYears) || b.toYears <= b.fromYears)) {
      throw new Error('Service bands: "to" years must be a whole number greater than "from", or left open-ended.');
    }
    // 4a1abc4a — A BLANK Entitled Days IS ITS OWN REFUSAL, ahead of the numeric check below, because the
    // two mean different things and only one of them was ever typed. The editor posts a blank cell as null
    // (it used to post 0); accepted as 0 it read as "this range grants nothing", closed the running version
    // and opened a successor granting nothing — with a green "Saved" and no error. A deliberate 0 is still
    // legal and still falls through to the check below.
    if (b.days == null) {
      throw new Error('Service bands: enter the entitled days for every range — a blank box is not zero.');
    }
    if (typeof b.days !== 'number' || !Number.isFinite(b.days) || b.days < 0) {
      throw new Error('Service bands: days must be zero or a positive number.');
    }
    // Feedback 9d8cf621 — per-range entitlement columns (all optional; absent/null = "no override"). The
    // runtime resolver is separately defensive, but reject a genuinely bad value at write time so HR gets a
    // clear message instead of a silently-ignored override.
    if (b.carryForwardDays != null && (typeof b.carryForwardDays !== 'number' || !Number.isFinite(b.carryForwardDays) || b.carryForwardDays < 0)) {
      throw new Error('Service bands: carry-forward days must be zero or a positive number.');
    }
    if (b.maxBalanceDays != null && (typeof b.maxBalanceDays !== 'number' || !Number.isFinite(b.maxBalanceDays) || b.maxBalanceDays < 0)) {
      throw new Error('Service bands: maximum balance days must be zero or a positive number.');
    }
    const hasMonth = b.carryForwardExpiryMonth != null;
    const hasDay = b.carryForwardExpiryDay != null;
    if (hasMonth !== hasDay) {
      throw new Error('Service bands: carry-forward expiry needs both a month and a day, or neither.');
    }
    if (hasMonth && hasDay && !isValidMonthDay(Number(b.carryForwardExpiryMonth), Number(b.carryForwardExpiryDay))) {
      throw new Error('Service bands: carry-forward expiry must be a real calendar date (valid month and day).');
    }
  }
  if (bands[0].fromYears !== 0) {
    throw new Error('Service bands: the first band must start at 0 years (no gap before it).');
  }
  if (bands[bands.length - 1].toYears !== null) {
    throw new Error('Service bands: the last band must be open-ended (no "to" years) so every service length is covered.');
  }
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].fromYears !== bands[i - 1].toYears) {
      throw new Error('Service bands: bands must be contiguous — each band\'s "from" must equal the previous band\'s "to" (no gaps or overlaps).');
    }
  }
  if (!isWellFormedBands(bands)) {
    // Defence-in-depth: should be unreachable given the checks above, but never persist something the
    // resolver itself would reject as malformed.
    throw new Error('Service bands: the band list is not well-formed.');
  }
}

// ── Type-level leave RULES (feedback 9816a5ad, STEP 2 OF 3) ─────────────────────────────────────────
// Step 1 (migration 0325) added ten rule columns to `leave_type` and backfilled them from the single
// distinct value each type carried across all of its `leave_policy` rows. They were INERT — read by
// nothing. This is the seam that makes them live.
//
// THE TARGET STRUCTURE, in the reporter's words: "Annual Leave rules are the same for everyone and only
// the entitlement days differ by grade." So Leave Year Type, Earning Method, Carry Forward Policy,
// Rounding and Maximum Balance belong to the LEAVE TYPE; the entitlement layer controls DAYS ONLY. The
// days resolver (release three: the entitlement template's band, `policyFromTemplateBand`) does exactly
// what it did — it resolves the winning band and its DAYS — and this overlay then replaces every RULE on
// the result with the type's own. Splitting it this way is deliberate: the days half is the risky half (it
// is what the ledger is made of) and it is left completely untouched, so a defect in step 2 can only ever
// be a wrong RULE, never a wrong day count from the wrong band.

/** The ten step-1 `leave_type` rule columns, in the shape drizzle selects them. `numeric` columns arrive
 *  as STRINGS from postgres, so both spellings are accepted and normalised below. */
export type LeaveTypeRules = {
  accrualMethod?: string | null;
  /** bc36c768 (migration 0375) — the day of the month Monthly Accrual credits on, 1..31. NULL/absent ⇒
   *  day 1, which is byte-identical to every pre-bc36c768 row. Read only by `earnedToDateFor`'s
   *  'earned_monthly' branch. */
  accrualDay?: string | number | null;
  /** bc36c768 (migrations 0375 + 0376) — THE NOT-CONFIGURED MARKER. Set ⇒ this type grants nothing and
   *  earns nothing until HR saves an earning method.
   *
   *  DELIBERATELY ABSENT FROM `hasAnyLeaveTypeRule` — see the note there. It is carried on this type (and
   *  in `leaveTypeRuleColumns`) so every gate can read it off the type row it already selects, NOT so it
   *  can engage the overlay. `applyLeaveTypeRules` never reads it either: the marker decides whether a
   *  type is granted AT ALL, upstream of what its rules say, and letting it leak into the resolved policy
   *  would invite an engine to treat "not configured" as one more accrual method. */
  accrualUnconfigured?: Date | string | null;
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
  /** 8fec719e (migration 0358) — the thirteenth column: the custom rounding table. jsonb, so it arrives as
   *  a parsed value of unknown shape and is validated at the boundary rather than trusted. */
  roundingBands?: unknown;
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
 *
 * `accrualUnconfigured` (bc36c768) IS EXCLUDED FOR THE SAME REASON, AND THE EXCLUSION IS LOAD-BEARING.
 * The 0376 clear-out stamps that marker on EVERY non-archived leave type at once — including the ones
 * step 1 never consolidated, whose real carry / rounding / max-balance configuration still lives in
 * `leave_policy.accrual`. If the marker counted here, every one of those types would flip to "ruled" on
 * deploy day, `applyLeaveTypeRules` would overlay their NULL carryMax / roundingMethod / maxBalanceDays
 * over the policy's real values, and a reset that was scoped to the EARNING METHOD would silently wipe
 * carry-forward and rounding configuration nobody asked to touch. The marker says "do not grant this
 * type"; it says nothing whatever about which rule set a type resolves through, and it must not be
 * allowed to answer a question it was never asked. test/leave-earning-method-simplified.test.ts pins it.
 */
export function hasAnyLeaveTypeRule(rules: LeaveTypeRules | null | undefined): boolean {
  if (rules == null) return false;
  return (
    rules.accrualMethod != null ||
    // bc36c768: a configured accrual DAY is a configured rule in its own right — the same disjunct
    // 7cd914b1 shipped without for carryForwardPercent and 8fec719e had to add for roundingBands. A
    // day-only type without it reads as unruled, applyLeaveTypeRules falls through to the legacy grade
    // policy, and the administrator's chosen credit day is silently ignored.
    rules.accrualDay != null ||
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
    // 8fec719e: the band table is a configured rule in its own right. This disjunct is NOT optional — it
    // is the exact omission 7cd914b1 shipped with carryForwardPercent and documented four lines above. A
    // bands-only type without it reads as unruled, applyLeaveTypeRules falls through to the legacy grade
    // policy, and the administrator's table is silently ignored while a stale JSONB rule set comes back.
    rules.roundingBands != null ||
    rules.maxBalanceDays != null
  );
}

/** Feedback 9f5164d8 — the rounding methods the ENGINE acts on, i.e. the ones `applyRounding` changes a
 *  value for. Anything else (including 'none' and NULL) means "leave the calculated value alone". One
 *  definition so the overlay, the write-time validator and the editor cannot drift apart. */
export type EngineRoundingMethod = Exclude<LeaveRoundingMethod, 'none'>;
export const ENGINE_ROUNDING_METHODS: readonly EngineRoundingMethod[] = ['up', 'down', 'nearest_half', 'custom'];
export function isEngineRoundingMethod(v: unknown): v is EngineRoundingMethod {
  return typeof v === 'string' && (ENGINE_ROUNDING_METHODS as readonly string[]).includes(v);
}

/**
 * 8fec719e — THE METHODS AN ADMINISTRATOR MAY CHOOSE. Exactly two, which is the whole request: No
 * Rounding, or a table you write yourself.
 *
 * DISTINCT FROM `ENGINE_ROUNDING_METHODS`, and the gap between the two sets is the migration story rather
 * than an oversight. The engine set is what `applyRounding` still ACTS on — it keeps 'up', 'down' and
 * 'nearest_half' so a stored value the migration did not reach (a seed, a fixture, hand-written JSONB)
 * keeps producing the figure it always produced. The user set is what may be WRITTEN, and it is the one
 * the editor renders and `setLeaveTypeRules` enforces. Retiring a choice and silently re-interpreting
 * every value already stored under it are two different changes, and only the first one was asked for.
 */
export const USER_ROUNDING_METHODS = ['none', 'custom'] as const;
export type UserRoundingMethod = (typeof USER_ROUNDING_METHODS)[number];
export function isUserRoundingMethod(v: unknown): v is UserRoundingMethod {
  return typeof v === 'string' && (USER_ROUNDING_METHODS as readonly string[]).includes(v);
}

/** The retired methods, kept READABLE and named so nothing has to spell the three strings again. Nothing
 *  may write these; `applyRounding` still evaluates them. */
export const LEGACY_ROUNDING_METHODS = ['up', 'down', 'nearest_half'] as const;

/**
 * Overlay a leave type's own rules onto the carrier `policyFromTemplateBand` resolved. DAYS ARE NEVER
 * TOUCHED.
 *
 * Returns, in order:
 *   - `null` when `pol` is null. A null carrier means NO entitlement template resolved for this employee
 *     and type at all, and this function deliberately does NOT fabricate one from the type's rules.
 *     Synthesising a policy here would hand a carry cap, a rounding method and an earning method to
 *     employees nothing is configured for — and, since release three, would turn `noEntitlementOpinion`'s
 *     "nothing is set up" into a confident zero, which is exactly the clawback that guard exists to
 *     prevent.
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
 *   - roundingMethod: filtered through `isEngineRoundingMethod`; 'none' / NULL ⇒ undefined (no rounding);
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
  // bc36c768 — the accrual DAY rides the method it belongs to, filtered at this boundary like every other
  // rule: anything outside 1..31 resolves to null (⇒ day 1) rather than reaching the engine. Deliberately
  // NOT gated on the method being 'earned_monthly': `earnedToDateFor` ignores it for every other method,
  // and dropping it here would mean a type that switches away from monthly and back loses its day.
  const accrualDayRaw = finiteOrNull(r.accrualDay ?? null);
  const accrualDay =
    accrualDayRaw != null && Number.isInteger(accrualDayRaw) && accrualDayRaw >= 1 && accrualDayRaw <= 31
      ? accrualDayRaw
      : null;
  return {
    days: pol.days,
    carryMax: carryMax != null ? Math.max(0, carryMax) : 0,
    method,
    accrualDay,
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
    // 8fec719e — the band table, filtered at this boundary exactly like every other rule: a malformed or
    // self-contradictory table resolves to null (no rounding) rather than reaching the engine, so a row
    // that bypassed the write-time validator can never round a balance by an unresolvable rule.
    roundingBands: isWellFormedRoundingBands(r.roundingBands) ? r.roundingBands : null,
  };
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


/**
 * 6e9a126e RELEASE THREE — AN ENTITLEMENT TEMPLATE'S BAND, AS A RESOLVED POLICY CARRIER.
 *
 * Release two called this `templateOverPolicy(base, band)` and laid the band OVER whatever
 * `resolveGradePolicy` had resolved from `leave_policy`. There is no `base` any more: nothing reads
 * `leave_policy`, so the only thing that can resolve is the template's own band. What survives from that
 * function is the half that mattered — it MATERIALISES A CARRIER OUT OF NOTHING, and that is still the
 * point.
 *
 * ⚠️ WHY THE CARRIER MUST EXIST AT ALL. `applyLeaveTypeRules(null, rules)` returns null, by design: a null
 * policy stays null. Without a seed object here, every consolidated leave type would resolve carryMax 0 /
 * no expiry for everybody once `leave_policy` was gone, and the Carry Forward report would print a closed
 * year as "everything forfeited". Returning a `{ days, carryMax: 0 }` seed is what lets the leave TYPE's
 * own rules (7cd914b1 / 9816a5ad) still reach the reader. This is the specific breakage the approved plan
 * warned release three would cause, and this line is where it does not happen.
 *
 * WHAT THE BAND SUPPLIES, AND WHAT IT DOES NOT:
 *   - `days` — always, from the winning band. This is the layer's entire purpose.
 *   - `carryMax` / `carryExpiry` / `maxBalanceDays` — from the band's own per-range columns WHEN IT CARRIES
 *     THEM (`bandCarryMax` / `bandCarryExpiry` / `bandMaxBalance`). These are the reporter's own "Max
 *     Brought Forward" and "Max Entitled + Brought Forward" columns and they map to nothing else. Absent ⇒
 *     the neutral 0 / null, which `applyLeaveTypeRules` then overwrites from the leave type.
 *   - NOTHING ELSE. `method`, `accrualDay`, rounding and `carryPercent` come from the leave TYPE. An
 *     entitlement template is a DAY TABLE; it has no earning-method column, and inventing one here would
 *     make a template silently stop an earned type accruing.
 *
 * ⚠️ THIS ADDS NO SECOND CARRY DEFINITION, which db/schema.ts's `entitlement_template` note requires.
 * 7cd914b1 put carry forward on `leave_type`, and `applyLeaveTypeRules` overlays the type's rules WHOLESALE
 * over whatever this returns — so for a consolidated type the band's carry columns are read and then
 * discarded, exactly as a leave_policy band's were. There is still exactly one carry rule per leave type.
 */
/**
 * The carrier the DATED READERS need — and the reason release three does not print "everything forfeited".
 *
 * ⚠️ THIS IS THE DEFECT THE APPROVED PLAN PREDICTED, fixed at the line it predicted it would land on.
 *
 * `applyLeaveTypeRules(null, rules)` returns NULL at its first line, by design: a null policy means "no
 * entitlement resolved", and inventing one would fabricate days. While `leave_policy` existed, the two
 * dated readers always had SOMETHING to hand it — a grade policy row, or a template band. With the old
 * layer dropped and the new one not yet configured, both would hand it `null`, `carryMax` would read 0,
 * and a CLOSED YEAR would report every carried day as forfeited. That is not a display nicety: the carry
 * forward report is what an employee is shown about a year they can no longer affect.
 *
 * So when there is no band but the leave TYPE carries rules of its own, we materialise a carrier with
 * ZERO DAYS. Days are the one thing that must not be invented — no template means no entitlement, and
 * both readers derive their day figures from the ledger anyway. What the carrier exists to carry is the
 * type's carry cap, percentage and expiry, which live on `leave_type` and are just as true after the drop
 * as before it. `applyLeaveTypeRules` then overlays them exactly as it always did.
 *
 * A type with NO rules still resolves to null — genuinely no opinion, which is what `noEntitlementOpinion`
 * depends on and what keeps the recalc posting a delta of exactly 0 during the blank window.
 */
export function policyForDatedReader(
  band: ServiceBand | null,
  rules: LeaveTypeRules | null | undefined,
): ResolvedPolicy | null {
  const fromBand = policyFromTemplateBand(band);
  if (fromBand) return fromBand;
  if (!hasAnyLeaveTypeRule(rules)) return null;
  return { days: 0, carryMax: 0, carryExpiry: null, maxBalanceDays: null };
}

export function policyFromTemplateBand(band: ServiceBand | null): ResolvedPolicy | null {
  if (!band) return null;
  return {
    days: band.days,
    carryMax: bandCarryMax(band) ?? 0,
    carryExpiry: bandCarryExpiry(band),
    maxBalanceDays: bandMaxBalance(band),
  };
}

/**
 * 6e9a126e — THE SINGLE COMPOSITION HOOK. Every granting engine, the projection kernel and every dated
 * reader resolve an employee's entitlement HERE and nowhere else.
 *
 * It exists because there were four hand-written copies of the resolve-then-overlay expression, and
 * release two had to add a layer above both halves of it. Four edits that must agree is how openLeaveYear
 * and the reprojection kernel come to disagree by a day and post a permanent oscillating delta — the
 * failure mode `leaveTypeRuleColumns` already exists to prevent. One function, four call sites.
 *
 * RELEASE THREE COLLAPSED IT TO ONE LAYER. `schemeDays` and `gradePolicy` are gone from the signature
 * because the tables behind them are gone from the code: `benefit_scheme` /`scheme_leave_entitlement` and
 * `leave_policy` are read by nothing. Removing the PARAMETERS rather than passing `null` at every site is
 * deliberate — a parameter that is always null is an invitation to re-point something at it, and arity is
 * the only mechanism that makes `tsc` enumerate every composition site for whoever adds the next layer.
 *
 * The returned `policy` is THE CARRIER: the object every rule (earning method, carry cap, expiry,
 * rounding, maximum balance) must be read from. The returned `days` is the composed entitlement.
 *
 * `noOpinion` is `noEntitlementOpinion` over the RESOLUTION, not the composed number — see that function.
 * A caller that gets `noOpinion` must post NOTHING (delta exactly 0), never 0 days.
 */
export function composeEntitlement(p: {
  /** Statutory floor for this type/service length. ADVISORY since fa3f4ccb — flagged, never applied. */
  floorDays: number;
  /** The winning entitlement template's band for this employee/type/service length, or null. */
  templateBand: ServiceBand | null;
  /** The leave TYPE's own rule columns (9816a5ad step 2). */
  rules: LeaveTypeRules | null | undefined;
}): {
  days: number;
  belowStatutoryFloor: boolean;
  policy: ResolvedPolicy | null;
  noOpinion: boolean;
} {
  const policy = applyLeaveTypeRules(policyFromTemplateBand(p.templateBand), p.rules);
  const templateDays = p.templateBand ? p.templateBand.days : null;
  return {
    // No template ⇒ 0 days AND `noOpinion` true, which is the caller's instruction to post nothing at all.
    // The 0 is what a caller that IGNORES noOpinion would see, and it is never the granted figure.
    days: templateDays ?? 0,
    belowStatutoryFloor: belowStatutoryFloor(p.floorDays, templateDays ?? 0),
    policy,
    noOpinion: noEntitlementOpinion({ templateDays }),
  };
}

/**
 * 6e9a126e — "NOTHING IS SET UP" IS NOT "ZERO DAYS". THE GUARD, AND IT SHIPPED BEFORE ANY CLEARING DID.
 *
 * The composition used to be `schemeDays ?? policyDays` with callers passing `pol?.days ?? 0` — so an
 * employee for whom NO layer resolved anything composed to a confident **0**. That was fine while
 * something was always configured. It stopped being fine the moment configuration could be absent:
 *
 *   - `projectExpectedEntitlement` yields expected 0;
 *   - its callers compute `delta = 0 − alreadyPosted` and post a NEGATIVE `adjustment`;
 *   - the employee's remaining balance is driven down toward zero.
 *
 * That is a CLAWBACK OF DAYS PEOPLE ALREADY HOLD, triggered by an ordinary profile save (the reproject is
 * wired to `app/admin/personnel/[employmentId]/actions.ts`, `core/movement-apply.ts` and the leave-type
 * rules writer). And the statutory floor no longer props the figure up, because fa3f4ccb made it ADVISORY
 * at the reporter's written request. The approved plan promises the reporter that the reset moves nobody's
 * balance; without this guard that promise is false the first time anyone saves a profile.
 *
 * THE GUARD WAS BUILT IN RELEASE ONE, THE RELEASE THAT CLEARED NOTHING, rather than in the release that
 * clears. A safety property that lands in the same change as the hazard has never been tested against the
 * world without it. RELEASE THREE IS THAT HAZARD — this is the function keeping every balance still during
 * the blank window while the reporter retypes their configuration.
 *
 * The distinction it draws is between ABSENCE and an EXPLICIT ZERO:
 *   - no entitlement template resolves for this employee and type ⇒ NO OPINION ⇒ the caller posts nothing;
 *   - a template band saying 0 days is a real answer somebody typed ⇒ 0 days.
 * That is why the test is on the RESOLUTION, not on the composed number: a band of 0 and no band at all
 * are different facts that `days ?? 0` flattens into the same 0.
 *
 * It kept the same shape through three releases and needed no edit as layers were added and removed —
 * which is the whole reason it is a named predicate rather than an `if` inlined at the composition site.
 * Its only caller is `composeEntitlement`.
 */
export function noEntitlementOpinion(p: { templateDays: number | null }): boolean {
  return p.templateDays == null;
}
