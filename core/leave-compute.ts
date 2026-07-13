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
  /** Feedback 9d8cf621 — Maximum Balance Days cap resolved from the winning service band (null = no cap).
   *  The granting engines clamp the running balance against this via `applyMaxBalance`. */
  maxBalanceDays?: number | null;
};

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
};

/**
 * Whether carry-forward is enabled for a resolved policy. The carry-forward rule has an explicit
 * on/off switch (`carryForwardEnabled`); when it is absent (every pre-existing policy) we fall back
 * to the original implicit rule: carry is on iff the cap is positive. An explicit `false` disables
 * carry even when a positive cap or an expiry offset is still present in the JSONB.
 */
export function carryEnabled(pol: ResolvedPolicy | null | undefined): boolean {
  if (pol == null) return false;
  return pol.carryForwardEnabled ?? (pol.carryMax ?? 0) > 0;
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

/** Leave Entitlement Rules Engine — the admin preview's result shape. Mirrors what resolveGradePolicy +
 *  the floor-clamp produce, plus which scope tier won, so the UI can show "policy beats floor" etc. without
 *  duplicating the resolution logic. */
export type PreviewResult = {
  /** The statutory floor for this leave type / service length, or null when no pack applies (non-MY company). */
  floorDays: number | null;
  /** The resolved policy's days (band-resolved), or null when no policy matches at all (no default exists). */
  policyDays: number | null;
  /** The final granted amount: max(floorDays ?? 0, policyDays ?? 0). */
  days: number;
  /** Which scope tier the winning policy came from. 'none' = no policy matched (floor-only, or nothing). */
  scope: 'company' | 'group' | 'none';
  /** Whether the statutory floor is what determined the final amount (floorDays > policyDays, or no policy). */
  floorApplied: boolean;
};

/**
 * Leave Entitlement Rules Engine — runs the EXACT SAME resolveGradePolicy the server engines use, so the
 * admin preview can never disagree with a real grant. `floorDays` is passed in by the caller (the client
 * component imports `entitlement` from localization/my/leave directly — see components/leave-rule-preview.tsx
 * — because the full pack registry is not client-safe); pass null when no statutory pack applies.
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
  const floor = floorDays ?? 0;
  const days = Math.max(floor, policyDays ?? 0);
  // Derive which scope tier actually won, mirroring resolveGradePolicy's own subset filters exactly —
  // including the case where the company scope EXISTS but resolves to a policy days of 0 (i.e. the
  // company has only other-grade rows and no null-grade default): scope is still 'company' (short-circuit
  // never falls back to group), policyDays reflects whatever pick() returned (possibly null).
  const companyScope = employeeCompanyId != null ? rows.filter((r) => r.companyId === employeeCompanyId) : [];
  const scope: PreviewResult['scope'] = companyScope.length > 0 ? 'company' : policy ? 'group' : 'none';
  const floorApplied = policyDays == null || floor > policyDays;
  return { floorDays, policyDays, days, scope, floorApplied };
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
