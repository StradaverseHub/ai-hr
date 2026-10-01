/**
 * Malaysia statutory payroll calculators (MY localization pack, ADR-0008).
 *
 * Figures come from localization/my/statutory-tables.ts (each sourced + dated + verify-flagged).
 * Provenance and the human sign-off checklist: docs/architecture/STATUTORY-SOURCES.md.
 *
 * Accuracy posture:
 *  - PCB/MTD  — the FULL official LHDN 2026 computerised method for a RESIDENT employee, with
 *               prior-month accumulators (∑(Y−K), K, X) and the (n+1) spread, incl. additional
 *               remuneration Steps 1–5 and the §E rounding rules (truncate 2dp, 5-sen round-up,
 *               RM10 floor). Verified against the spec's Exhibit 5 worked example (Jan–Apr).
 *               TP1 deductions (LP₁) and zakat are captured per employee per batch and
 *               accumulate into ∑LP / Z through the payslip replay.
 *  - EPF      — statutory % with round-up to the next ringgit (Third Schedule convention; exact
 *               RM20 low-wage banding still flagged — KWSP PDF pending, see sources doc).
 *  - SOCSO    — exact Act 4 schedule amounts, verified to the RM6,000 ceiling (2026.1).
 *  - EIS      — exact Act 800 Second Schedule amounts, verified to the RM6,000 ceiling (2026.1).
 */
import {
  DEFAULT_MY_STATUTORY,
  EPF_NO_CONTRIB_AGE,
  EPF_SCHEDULE_MAX,
  EPF_SENIOR_AGE,
  MY_EPF_THIRD_SCHEDULE_PART_A,
  MY_EPF_THIRD_SCHEDULE_PART_E,
  MY_HRDF,
  MY_OT_WAGE_CEILING,
  type ContribBand,
  type SocsoBand,
  type HrdfStatus,
  type PcbBand,
  type StatutoryRuleset,
  type TaxCategory,
} from './statutory-tables';
// 04b88724 — the ONE child-relief derivation (the count, the money and the working). Kept in its own
// db-free leaf because the Identification & Tax card calls the same function through the CLIENT seam, and
// this module must not be dragged into a browser bundle to make that possible.
import { childReliefFor, childReliefPrices } from './child-relief';

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Round a contribution up to the next whole ringgit (KWSP Third Schedule convention). */
const ceilRinggit = (n: number) => Math.ceil(n);

/** A malformed ruleset reached a calculator (e.g. an empty band table). Named so the payroll kernel's
 *  transaction can identify a malformed-ruleset abort and roll the batch back (ADR-0020 §7). */
export class StatutoryRulesetMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatutoryRulesetMalformedError';
  }
}

export type TaxProfile = {
  category?: TaxCategory;
  children?: number;
  /** d64d0df4 — the employee is a registered disabled individual (OKU), which entitles them to a FURTHER
   *  annual deduction on top of D. Undefined/false ⇒ exactly today's projection of P, so every employee
   *  who has not been flagged computes byte-identically. */
  disabled?: boolean;
  /** d64d0df4 — the employee's SPOUSE is a registered disabled individual (OKU), which entitles the
   *  employee to a FURTHER annual deduction on top of the spouse deduction. Like the spouse deduction
   *  itself this is claimable ONLY by category 2 (married, spouse not working); for categories 1 and 3
   *  it is stored and displayed but adds nothing. Undefined/false ⇒ exactly today's projection of P. */
  disabledSpouse?: boolean;
  /** d64d0df4 — the TOTAL child deduction in RM, already worked out category by category (and halved
   *  for any child recorded at the 50% share) by the caller. Supplied ONLY for an employee in
   *  'auto_table' child-relief mode. When supplied it REPLACES `children × perChild` in the relief sum;
   *  when absent (every 'manual' and 'auto' employee) the arithmetic below is untouched to the cent. */
  childReliefAmount?: number;
  /** Forward-only evidence from the same country-pack derivation used by payroll. */
  childWorking?: {
    mode: 'auto_table' | 'manual';
    table: Record<string, { full?: unknown; half?: unknown } | undefined> | null;
    rows: Array<{ category: string; sharePercent: number; children: number; units: number; amountRM: number }>;
    headCount: number;
    categoryUnits: Record<string, number>;
  };
};

/**
 * Per-employee EPF contribution mode (Wave 2B, statutory-aligned). The only above-statutory
 * mechanism KWSP recognises is i-Topup (Form 17A/18A (AHL)) — a RATE election, never a fixed RM
 * amount — and it can only raise the rate, never lower it below the Third Schedule (EPF Act s.43).
 *  - 'auto'             — statutory rates both sides (default).
 *  - 'voluntary_excess' — i-Topup: an elected rate AT OR ABOVE statutory, per side. A null elected
 *                         rate on a side keeps that side statutory (this is the "semi-auto" case).
 *  - 'exempt'           — no contribution, for legitimately-exempt employees ONLY (never a way to
 *                         drop a mandatory employee below the floor).
 *  - 'manual_amount'     — item 70b14723: an exact RINGGIT FIGURE per side, typed on the employee's own
 *                         record and used by every Process and Reprocess. A null side is NOT a zero: it
 *                         keeps that side on the rule this function would otherwise apply, which is the
 *                         same "a blank side stays statutory" rule the elected rates follow. That is what
 *                         makes the ticket's three categories — employee only, employer only, both — the
 *                         three combinations of two nullable amounts rather than three modes.
 *
 * ⚠️ 'manual_amount' REVERSES A DEFERRAL, TWICE MADE. ADR-0035 §4 and ADR-0046 both refused it, and
 * ADR-0046's words were "no KWSP fixed-amount election". RETIRED, NOT DELETED, and the reasoning is in
 * docs/adr/0087-epf-manual-amount-categories.md: the old claim is true of what KWSP's FORMS offer and
 * false as a statement about what a lawful contribution can be. docs/architecture/STATUTORY-SOURCES.md §2
 * records the case, in its own words: "pre-1998 legacy (5.5% / 6-6.5%) is NOT auto-applied (rare - flag if
 * any such grandfathered member exists)". Those legacy figures ARE rates, and the rate election still cannot
 * carry them: `voluntary_excess` is max(elected, statutory) by design, so i-Topup can only RAISE. No table
 * produces 5.5% and no election expresses it. So this mode does NOT floor at statutory; it is the one EPF
 * mode that can go down, and it is the only affordance the system has for that member.
 */
export type EpfMode = 'auto' | 'voluntary_excess' | 'exempt' | 'manual_amount';
export type EpfElection = {
  mode: EpfMode;
  employeeRate?: number | null;
  employerRate?: number | null;
  /** Item 70b14723 — the typed monthly employee share in RM. Read ONLY when `mode === 'manual_amount'`;
   *  null ⇒ that side keeps the rule. */
  employeeAmount?: number | null;
  /** Item 70b14723 — the typed monthly employer share in RM. Same reading as `employeeAmount`. */
  employerAmount?: number | null;
};

/**
 * ══ ITEM 70b14723 — THE TYPED AMOUNT, SUBSTITUTED PER SIDE. THE ONE PLACE IT HAPPENS. ══
 *
 * Applied INSIDE the EPF computation, on the figures the rule produced, and NOT after the kernel has
 * composed a payslip from them. Three consequences follow from the placement alone, and only the first is
 * obvious:
 *
 *  1. A MONTHLY AMOUNT IS CHARGED ONCE ACROSS A REGULAR + BONUS PAIR. `deltaStat` (core/payroll.ts) takes
 *     the month WITH and WITHOUT this run's additional remuneration. For a constant M both sides are M, so
 *     an additional run charges `max(0, M − M) = 0` and a restating regular run charges `M − 0 = M`. Any
 *     order, charged once, with no `isAdditionalRun` special case anywhere. Applying it after `stCore`
 *     instead would slap the whole monthly amount onto the bonus run too — the mis-application ADR-0046
 *     predicted, and the reason that objection is answered by WHERE this sits rather than by an exception.
 *  2. K₁ + Kₜ STILL EQUALS THE EMPLOYEE EPF, EXACTLY. Kₜ is not a rate times a bonus (ADR-0046's other
 *     objection): `epfContribution` defines it as the month's lookup MINUS the same lookup on the normal
 *     wage alone. Both are M here, through the SAME function, so Kₜ = 0 by construction and K₁ = M.
 *  3. SAME-MONTH PCB IS COMPUTED ON THE REAL EPF. `statutory()` hands `pcbMonth` the employee EPF as the
 *     relief leg. After-the-fact substitution would leave month N's PCB on the schedule figure while month
 *     N+1's accumulator replay folded the typed one, and would make the PCB 2(II) cross-employer report
 *     (localization/my/reports.ts) manufacture a divergence against the filed PCB.
 *
 * NO ROUND-UP TO THE RINGGIT. Every computed EPF figure here is `ceilRinggit`'d because the KWSP Third
 * Schedule prescribes it; a typed figure is not a schedule reading, and rounding somebody's 500.50 up to
 * 501 would silently file a number they did not type. `Math.max(0, …)` is defence only — `resolveEpfElection`
 * refuses a negative at SAVE time, which is where it has to be refused because
 * `lib/kwsp-borang-a-file.ts`'s `cents()` only throws on one when the submission file is being written.
 *
 * NO STATUTORY FLOOR, DELIBERATELY. See the note on `EpfMode` above and the ADR.
 */
function manualEpfSide(election: EpfElection | undefined, side: 'employeeAmount' | 'employerAmount'): number | null {
  if ((election?.mode ?? 'auto') !== 'manual_amount') return null;
  const v = election?.[side];
  if (v == null || Number.isNaN(Number(v))) return null;
  return Math.max(0, round2(Number(v)));
}

/**
 * Effective EPF rates for a wage given an election, enforcing the statutory FLOOR: an elected rate
 * is `max(elected, statutory)` so i-Topup can only raise it. 'exempt' is 0/0. The statutory employer
 * rate is wage-banded (13% ≤ threshold, else 12%).
 *
 * `wage` is whatever base the caller is charging: since bdf7d248 `epf()` passes the COMBINED month
 * (normal wage + additional remuneration), because the schedule row it reads carries that same step.
 */
export function resolveEpfRates(
  wage: number,
  cfg: StatutoryRuleset['epf'] = DEFAULT_MY_STATUTORY.epf,
  election?: EpfElection,
): { employeeRate: number; employerRate: number } {
  const statutoryEmployer = wage <= cfg.employerThreshold ? cfg.employerRateLow : cfg.employerRateHigh;
  const mode = election?.mode ?? 'auto';
  if (mode === 'exempt') return { employeeRate: 0, employerRate: 0 };
  const elect = (elected: number | null | undefined, floor: number) =>
    mode === 'voluntary_excess' && elected != null ? Math.max(elected, floor) : floor;
  return {
    employeeRate: elect(election?.employeeRate, cfg.employeeRate),
    employerRate: elect(election?.employerRate, statutoryEmployer),
  };
}

/**
 * EPF. **The month is ONE Third Schedule lookup** (bdf7d248, r210). The normal monthly wage and the
 * month's additional remuneration (`additional` — a bonus) are ADDED FIRST, and that combined base is
 * what the EPF Act 1991 **Third Schedule Part A** band is read for (≤ RM20,000; #95) — or, where the
 * schedule ends above RM20,000, what the exact percentage is applied to, rounded up to RM1 ONCE
 * (employee 11%, employer 12%). The employer 13%/12% step therefore resolves on the COMBINED base too:
 * it is a step baked into the Part A rows, so reading the row for the month's whole pay is the same act
 * as resolving the rate on it.
 *
 * WHAT THIS REPLACED, and why it is not a rounding crumb. Until r210 the band was read on the NORMAL
 * wage alone and `ceil(bonus × rate)` was added beside it. On the reporter's own month — RM7,413.00
 * salary + RM1,650.71 bonus — that gave employee RM1,007 / employer RM1,099, while the single lookup on
 * RM9,063.71 (the RM9,100 row) gives RM1,001 / RM1,092. Two readings of one schedule, six and seven
 * ringgit apart, and the schedule only ever describes a month. Feeding the combined base also makes the
 * per-run increment method in `core/payroll.ts` (`deltaStat`) land on the reporter's figures: the bonus
 * run contributes 1,001 − 825 = RM176 employee and 1,092 − 900 = RM192 employer.
 *
 * An `election` can RAISE a side above the statutory floor (i-Topup) or `exempt` the employee (0/0);
 * the raise is measured on the same combined base, so it can still only ever raise.
 *
 * The employee EPF attributable to the bonus alone (the PCB relief leg Kₜ) is NOT computed here — it is
 * `epfContribution`'s difference between this lookup and the same lookup on the normal wage alone, so
 * the two legs always add back up to exactly this number.
 */
export function epf(
  wage: number,
  additional = 0,
  cfg: StatutoryRuleset['epf'] = DEFAULT_MY_STATUTORY.epf,
  election?: EpfElection,
) {
  if ((election?.mode ?? 'auto') === 'exempt') return { employee: 0, employer: 0 };

  const partA = cfg.partA ?? MY_EPF_THIRD_SCHEDULE_PART_A;
  const scheduleMax = cfg.scheduleMax ?? EPF_SCHEDULE_MAX;
  // The month's EPF base: normal wage + additional remuneration, formed BEFORE any lookup. The `round2`
  // is the same guard `statutory()` puts on every other base it builds, and it matters more here than
  // anywhere else because this base is looked up in a table whose rows are RM20/RM100 wide: a base
  // arriving as 9063.710000000001 instead of 9063.71 reads the next row up and moves the contribution
  // by a whole ringgit. (A search over 3M random cent-accurate pairs found 641k whose raw sum differs
  // from `round2` in the last bits and none that crossed a band edge — so this is a guard against a
  // narrow case, not a demonstrated bug, and it costs one multiplication.)
  const base = round2(Math.max(0, wage) + Math.max(0, additional));
  const statEmployerRate = base <= cfg.employerThreshold ? cfg.employerRateLow : cfg.employerRateHigh;

  // Statutory floor: exact Third Schedule band (incl. the NIL first band), or the percentage rounded
  // up where the schedule ends (> RM20,000).
  const band = base <= scheduleMax ? bandFor(partA, base) : null;
  let employee = band ? band.employee : ceilRinggit(base * cfg.employeeRate);
  let employer = band ? band.employer : ceilRinggit(base * statEmployerRate);

  // i-Topup / voluntary excess can only RAISE a side above the statutory floor. `resolveEpfRates`
  // floors the elected rate at statutory, and the schedule amount is itself ≥ the statutory percentage
  // of the base, so `max` here is what makes an under-floor election a no-op rather than a reduction.
  if ((election?.mode ?? 'auto') === 'voluntary_excess') {
    const { employeeRate, employerRate } = resolveEpfRates(base, cfg, election);
    if (election?.employeeRate != null) employee = Math.max(employee, ceilRinggit(base * employeeRate));
    if (election?.employerRate != null) employer = Math.max(employer, ceilRinggit(base * employerRate));
  }

  // Item 70b14723 — THE TYPED AMOUNT REPLACES THE SCHEDULE READING, per side, last. `max` is deliberately
  // NOT used: this is the one EPF mode that can go BELOW the Third Schedule, which is the whole point of
  // it (the pre-1998 grandfathered member). Read `manualEpfSide`'s block for why the substitution lives
  // here and not after `stComputed` — it is what makes a monthly amount charge once across a bonus pair
  // and what keeps Kₜ = 0 by construction rather than by a special case. Null on a side ⇒ that side keeps
  // whatever the lines above produced.
  const mEmployee = manualEpfSide(election, 'employeeAmount');
  const mEmployer = manualEpfSide(election, 'employerAmount');
  if (mEmployee != null) employee = mEmployee;
  if (mEmployer != null) employer = mEmployer;

  return { employee, employer };
}

export type EpfCitizenship = 'citizen' | 'pr' | 'non_citizen';

/** Flat-rate EPF side (non-citizen 2%/2%), round up to RM1; respects exempt / i-Topup excess. */
function epfFlatSide(base: number, statRate: number, electedRate: number | null | undefined, mode: string): number {
  if (mode === 'exempt' || statRate === 0 || base <= 0) return 0;
  const rate = mode === 'voluntary_excess' && electedRate != null ? Math.max(electedRate, statRate) : statRate;
  return ceilRinggit(base * rate);
}

/**
 * EPF contribution by employee age + citizenship (Third Schedule rule selection; #95 follow-on):
 *  - citizen / PR, age < 60        → Part A (`epf()`)
 *  - Malaysian citizen 60–<75      → Part E (employee 0%, employer 4% banded)
 *  - age ≥ 75                      → no mandatory EPF
 *  - non-citizen (and PR aged 60+) → flat 2% / 2% (post-1998 mandatory, eff 1 Oct 2025)
 * Returns the month total plus the employee EPF attributable to the bonus (for the PCB relief split Kₜ).
 * Source: KWSP Jadual Ketiga (1 Oct 2025) + YiWei Law statutory deck (10 Jun 2026, slides 7–9).
 */
export function epfContribution(
  wage: number,
  additional = 0,
  cfg: StatutoryRuleset['epf'] = DEFAULT_MY_STATUTORY.epf,
  election?: EpfElection,
  sel?: { age?: number | null; citizenship?: EpfCitizenship },
): { employee: number; employer: number; employeeOnBonus: number } {
  const byRule = epfContributionByRule(wage, additional, cfg, election, sel);
  // ── Item 70b14723 — THE TYPED AMOUNT, APPLIED ACROSS EVERY RULE BRANCH ──────────────────────────────
  // `epf()` already substitutes for the Part A path (citizen/PR under 60), which is why the Kₜ difference
  // below comes out at 0 through the SAME function rather than by a rule written here. This covers the
  // three branches that never reach `epf()` at all — the non-citizen flat 2%/2%, the citizen 60–<75
  // Part E, and the age ≥ 75 no-contribution short-circuit. Leaving them out would have made the feature
  // silently inert for exactly the employees a hand-set figure is most often agreed for, and the
  // substitution is idempotent, so applying it twice on the Part A path changes nothing.
  //
  // ⚠️ IT OVERRIDES THE AGE ≥ 75 ZERO TOO, and that is a decision rather than an oversight. The mode says
  // "this employee's EPF is this figure"; an admin who typed one for a 76-year-old meant it, and silently
  // paying 0 against a typed 500 is the half-built-feature failure. The mode is never reached by accident
  // — it requires a category, an amount and a written reason.
  const mEmployee = manualEpfSide(election, 'employeeAmount');
  const mEmployer = manualEpfSide(election, 'employerAmount');
  if (mEmployee == null && mEmployer == null) return byRule;
  return {
    employee: mEmployee ?? byRule.employee,
    employer: mEmployer ?? byRule.employer,
    // Kₜ, the employee EPF attributable to the bonus, is "the month's figure minus the same figure on the
    // normal wage alone". For a CONSTANT M those are the same number, so this is 0 — not a convention, the
    // subtraction. Which also means K₁ = M: the whole typed amount is claimed as the month's normal-wage
    // EPF relief in PCB, once, and `employee − employeeOnBonus` still equals it exactly.
    employeeOnBonus: mEmployee != null ? 0 : byRule.employeeOnBonus,
  };
}

/** The contribution the RULE produces — Third Schedule Part A / Part E / the non-citizen flat rate — with
 *  no typed-amount substitution. Split out of `epfContribution` by item 70b14723 so the typed amount is
 *  applied in ONE place across all four branches; this is the function `epfContribution` was before it. */
function epfContributionByRule(
  wage: number,
  additional = 0,
  cfg: StatutoryRuleset['epf'] = DEFAULT_MY_STATUTORY.epf,
  election?: EpfElection,
  sel?: { age?: number | null; citizenship?: EpfCitizenship },
): { employee: number; employer: number; employeeOnBonus: number } {
  const age = sel?.age ?? null;
  const citizenship = sel?.citizenship ?? 'citizen';
  const mode = election?.mode ?? 'auto';
  const bonus = Math.max(0, additional);

  if (age != null && age >= EPF_NO_CONTRIB_AGE) return { employee: 0, employer: 0, employeeOnBonus: 0 };
  const senior = age != null && age >= EPF_SENIOR_AGE;

  // Non-citizen (and PR aged 60+): flat 2% / 2%, round up to RM1, on wage and bonus alike.
  if (citizenship === 'non_citizen' || (citizenship === 'pr' && senior)) {
    const eeRate = cfg.nonCitizenEmployeeRate ?? 0.02;
    const erRate = cfg.nonCitizenEmployerRate ?? 0.02;
    const employeeOnBonus = epfFlatSide(bonus, eeRate, election?.employeeRate, mode);
    return {
      employee: epfFlatSide(wage, eeRate, election?.employeeRate, mode) + employeeOnBonus,
      employer: epfFlatSide(wage, erRate, election?.employerRate, mode) + epfFlatSide(bonus, erRate, election?.employerRate, mode),
      employeeOnBonus,
    };
  }

  // Malaysian citizen 60–<75: Part E (employee 0%, employer 4% banded; bonus employer 4%).
  if (citizenship === 'citizen' && senior) {
    if (mode === 'exempt') return { employee: 0, employer: 0, employeeOnBonus: 0 };
    const partE = cfg.partE ?? MY_EPF_THIRD_SCHEDULE_PART_E;
    const scheduleMax = cfg.scheduleMax ?? EPF_SCHEDULE_MAX;
    const erRate = cfg.seniorEmployerRate ?? 0.04;
    const band = wage <= scheduleMax ? bandFor(partE, wage) : null;
    const wageEmployer = band ? band.employer : ceilRinggit(wage * erRate);
    return {
      employee: 0,
      employer: wageEmployer + (bonus > 0 ? ceilRinggit(bonus * erRate) : 0),
      employeeOnBonus: 0,
    };
  }

  // Citizen / PR < 60: standard Part A — ONE combined-month lookup (bdf7d248).
  const e = epf(wage, bonus, cfg, election);
  // Kₜ, the employee EPF attributable to the additional remuneration, for the PCB relief split. Under
  // the combined lookup there is no separate "percentage of the bonus" to report: the bonus leg is the
  // DIFFERENCE between the month's lookup and the same lookup on the normal wage alone. Derived from
  // the SAME function so `employee − employeeOnBonus` is exactly the normal-wage schedule amount that
  // `statutory()` hands `pcbMonth` as K₁ — the two legs cannot drift apart or double-count against the
  // annual EPF relief cap. `max(0, …)` is defence only: the Part A employee column is monotonic in the
  // base, so a larger base never yields a smaller employee amount. (The EMPLOYER column is NOT
  // monotonic — it steps DOWN from 13% to 12% at RM5,000 — but the employer side has no Kₜ leg.)
  const wageOnly = bonus > 0 ? epf(wage, 0, cfg, election) : e;
  return {
    employee: e.employee,
    employer: e.employer,
    employeeOnBonus: bonus > 0 ? Math.max(0, e.employee - wageOnly.employee) : 0,
  };
}

/**
 * HRD Corp levy (employer-only) on the HRDF wage base. `base` is basic + fixed allowances net of
 * unpaid leave (the kernel builds it — it is NOT the EPF/SOCSO wage; bonus/commission/overtime are
 * excluded). Rate by the employer's registration band: mandatory 1% (10+ Malaysian employees),
 * optional 0.5% (5–9). Not registered → 0. No employee deduction, no wage cap (PSMB Act 2001 s.14/15).
 * The levy carries sen — HRD Corp prescribes no round-up-to-ringgit (unlike KWSP), so round to 2dp.
 */
export function hrdfLevy(
  base: number,
  status: HrdfStatus,
  cfg: { mandatoryRate: number; optionalRate: number } = MY_HRDF,
): number {
  if (status === 'not_registered' || base <= 0) return 0;
  const rate = status === 'mandatory' ? cfg.mandatoryRate : cfg.optionalRate;
  return round2(Math.max(0, base) * rate);
}

/**
 * Feedback 0df0c635 — effective per-employee HRDF subjectivity (the "Subject to HRDF" checkbox on the
 * Others Statutory card). Tri-state stored value resolved against the employer's registration band:
 *   • explicit false → the employee's base is excluded from the levy entirely;
 *   • explicit true  → included (the registration band still sets the rate — not_registered stays 0);
 *   • null (untouched) → follow the company default: registered (mandatory/optional) ⇒ subject,
 *     not_registered ⇒ not — exactly the pre-flag behaviour, so a null row is byte-identical.
 * Exposed on the pack (D6 vocabulary pattern) so the kernel consumes it via `pack.payroll` without a
 * direct core→localization/my import (ADR-0080 ratchet).
 */
export function hrdfSubject(subjectToHrdf: boolean | null | undefined, status: HrdfStatus): boolean {
  if (subjectToHrdf != null) return subjectToHrdf;
  return status !== 'not_registered';
}

/** Exact schedule lookup: first band the wage fits in; wages above the table contribute at the
 *  top band (both Act 4 and Act 800 prescribe this for wages exceeding RM6,000 — their row 65). */
function bandFor(bands: ContribBand[], wage: number): ContribBand {
  if (!bands || bands.length === 0) throw new StatutoryRulesetMalformedError('Statutory contribution band table is empty');
  return bands.find((b) => wage <= b.upTo) ?? bands[bands.length - 1];
}

/** SOCSO — exact Act 4 schedule amounts (verified to the RM6,000 ceiling). Category 1 =
 *  Employment Injury + Invalidity (< 60); Category 2 = Employment Injury only, employer-only
 *  (age 60+). */
export function socso(wage: number, category: 1 | 2 = 1, cfg: StatutoryRuleset['socso'] = DEFAULT_MY_STATUTORY.socso) {
  const band = bandFor(category === 2 ? cfg.category2 : cfg.category1, wage) as SocsoBand;
  // SKBBK (Lindung 24 Jam, eff 1 Jun 2026) — employee-paid leg on top of the standard SOCSO; 0 for any
  // pre-2026.3 ruleset/DB override that lacks the column.
  return { employer: band.employer, employee: band.employee, skbbk: band.skbbk ?? 0 };
}

/** EIS — exact Act 800 Second Schedule amounts (verified to the RM6,000 ceiling). */
export function eis(wage: number, cfg: StatutoryRuleset['eis'] = DEFAULT_MY_STATUTORY.eis) {
  const band = bandFor(cfg.bands, wage);
  return { employer: band.employer, employee: band.employee };
}

/** Annual tax on chargeable income P: the (M, R, B) band that contains P; category selects B.
 *  Negative B encodes the RM400/RM800 rebate; tax floors at 0 (spec: P ≤ 5,000 → no tax).
 *
 *  45df860a — IT NOW RETURNS THE BAND IT USED, not just the tax. M, R and B are the three figures a
 *  reader needs to check the MTD formula by hand ("which bracket was I in, and at what rate?"), and this
 *  function was computing all three and returning only their product. The arithmetic is UNCHANGED — the
 *  `tax` member is byte-for-byte the number this used to return, including the P ≤ 5,000 short-circuit
 *  that deliberately runs BEFORE the empty-table check. For that short-circuit the band is Table 1's own
 *  first row (M = 0, R = 0, B = 0), which is what the spec says applies there — not "unknown". */
function annualTaxFor(
  P: number,
  category: TaxCategory,
  bands: PcbBand[],
): { tax: number; M: number; R: number; B: number } {
  if (P <= 5000) return { tax: 0, M: 0, R: 0, B: 0 };
  if (!bands || bands.length === 0) throw new StatutoryRulesetMalformedError('Statutory PCB band table is empty');
  const band = bands.find((b) => P <= b.upTo) ?? bands[bands.length - 1];
  const B = category === 2 ? band.bCat2 : band.bCat13;
  return { tax: Math.max(0, (P - band.M) * band.R + B), M: band.M, R: band.R, B };
}

// ── PCB / MTD — LHDN 2026 computerised method WITH prior-month accumulators ──
// Source (verbatim): "Amendment to: Specification for MTD Calculations Using Computerized
// Calculation for 2026" (LHDN, updated 01 Jan 2026) §D.1 (normal), §D.2 Steps 1–5 (additional),
// §E Terms & Conditions (truncation, 5-sen round-up, RM10 floor), Exhibit 5 (worked example).
//   MTD = [(P − M) × R + B − (Z + X)] / (n + 1)
//   P   = ∑(Y−K) + (Y₁−K₁) + (Y₂−K₂)·n [+ (Yₜ−Kₜ)] − [D + S + QC + (∑LP + LP₁)]
// Accumulators (∑(Y−K), K, X, Z) come from the year's prior payslips + TP3 opening balances
// (ADR-0014); the EPF relief cap is enforced CUMULATIVELY across K, K₁, K₂, Kₜ.

export type PcbAccumulators = {
  /** ∑(Y−K): accumulated net remuneration paid in prior months this year (incl. previous employer / TP3). */
  netRemuneration: number;
  /** K: EPF already CLAIMED toward the annual relief cap (≤ RM4,000). */
  epfClaimed: number;
  /** X: accumulated MTD paid in prior months this year (normal + additional; excl. CP38). */
  pcbPaid: number;
  /** Z: accumulated zakat paid via salary deduction in prior months (replayed from payslips). */
  zakatPaid?: number;
  /** ∑LP: accumulated TP1 optional deductions claimed in prior months (replayed from payslips). */
  lpAccumulated?: number;
  /** 4011903e — Y: accumulated remuneration FOR MTD PURPOSES in prior months, before EPF.
   *  `netRemuneration` is this less `epfClaimed`; the caller derives both from ONE list over ONE figure
   *  so the pair cannot disagree. Optional: a caller that omits it simply gets no Y row, which is what
   *  every caller had before this item — LHDN's Y was never stored and the worksheet said so. */
  grossRemuneration?: number;
  /** 4011903e — prior payslips carrying no `bases.pcb` stamp, which fell back to `gross_pay`. Non-zero
   *  means Y and Σ(Y−K) include a month measured a different way; the explanation discloses it rather
   *  than printing a figure nobody can reconcile. */
  legacyBaseSlips?: number;
};

export const PCB_ZERO_ACC: PcbAccumulators = { netRemuneration: 0, epfClaimed: 0, pcbPaid: 0 };

/**
 * A TP3 Section C/D declaration, as both replays read it: the five stored columns and the year they
 * belong to. `year` is compared with the payroll year by the caller's own rule, so this takes the
 * already-decided `applies`.
 */
export type Tp3OpeningBalances = {
  netRemuneration: number;
  epfClaimed: number;
  pcbPaid: number;
  zakatPaid: number;
  lpAccumulated: number;
};

/**
 * ═══ THE YEAR'S OPENING BALANCES FROM A PREVIOUS EMPLOYER'S TP3 (r356) ═══════════════════════════
 *
 * The twin of `foldPriorSlipIntoAccumulators`, and separated out for the same reason: the kernel and
 * the multicycle worksheet each built this, and the worksheet's copy was already behind. It seeds
 * `lpAccumulated` from nothing at all — a hard 0 — where the kernel seeds it from `tp3_lp`; that is item
 * 20837372's defect verbatim, still live in the second copy. The specification's printed p.22 names ∑LP
 * as one of the FOUR variables a TP3 feeds ("(Y–K*), X, Z and ∑LP"), and ∑LP is SUBTRACTED inside P, so
 * a zero makes P too high and over-deducts every new joiner who handed in a Section D.
 *
 * ONE CAPPED EPF FIGURE FEEDS BOTH SEEDS (4011903e). `tp3_epf_claimed` holds what the employee CLAIMED;
 * core/tp3.ts subtracted `min(claimed, cap)` when it computed `tp3_net`. Seeding Y from the uncapped
 * figure would break the invariant Y − K = Σ(Y−K) for anyone over the cap, silently, on the one screen
 * that exists to reconcile the two.
 *
 * Y IS RECONSTRUCTED, NOT STORED A THIRD TIME. core/tp3.ts computes `netRemuneration = gross +
 * excessTotal − epfAllowable`, so the remuneration before EPF is that figure plus the allowable EPF it
 * subtracted. Derived from the two stored columns, so a TP3 correction moves all of them together.
 */
export function openingAccumulatorsFromTp3(
  tp3: Tp3OpeningBalances | null,
  epfReliefCap: number,
): Required<PcbAccumulators> {
  if (!tp3) {
    return {
      netRemuneration: 0,
      epfClaimed: 0,
      pcbPaid: 0,
      zakatPaid: 0,
      lpAccumulated: 0,
      grossRemuneration: 0,
      legacyBaseSlips: 0,
    };
  }
  const epfAllowed = Math.min(Number(tp3.epfClaimed ?? 0), epfReliefCap);
  return {
    netRemuneration: Number(tp3.netRemuneration ?? 0),
    epfClaimed: epfAllowed,
    pcbPaid: Number(tp3.pcbPaid ?? 0),
    zakatPaid: Number(tp3.zakatPaid ?? 0),
    lpAccumulated: Number(tp3.lpAccumulated ?? 0),
    grossRemuneration: round2(Number(tp3.netRemuneration ?? 0) + epfAllowed),
    legacyBaseSlips: 0,
  };
}

/** One prior payslip, as both replays read it: the gross the row stored, and its statutory blob. */
export type PriorSlipForAccumulators = {
  gross: number | string;
  statutory: unknown;
};

/**
 * ═══ FOLD ONE PRIOR PAYSLIP INTO THE PCB ACCUMULATORS. ONE DERIVATION, TWO CALLERS ═══════════════
 *
 * WHY THIS EXISTS (r356). There were two implementations of this replay: `core/payroll.ts`, which feeds
 * the month being paid, and `localization/my/multicycle-worksheet.ts` `loadPriorAccumulators`, which
 * feeds the worksheet's model of an already-paid month. The second was a copy, and it drifted from the
 * first TWICE inside two rounds:
 *
 *   · r352 (72d1a390) stamped `zakatRebateTp1` beside `zakat` and added it to Z in the kernel. The
 *     worksheet kept summing `zakat` alone, so an employee who claimed a TP1 zakat rebate carried a
 *     short Z into every later month of the worksheet.
 *   · r354 (4011903e) moved Σ(Y−K) off `payslip.gross_pay` and onto the stamped `bases.pcb`, because
 *     PCB is charged on that and the difference is real money (tax-exempt allowances, unpaid leave, any
 *     pay item deducted before tax). The worksheet kept folding `gross_pay`.
 *
 * Neither drift is cosmetic: the worksheet MODELS the month from these accumulators and compares the
 * model against what the payslips actually paid. A wrong Σ(Y−K) moves the modelled PCB, the comparison
 * fails under BOTH readings, and a correctly-computed month is reported as `unexplained` on the
 * document an accountant is being asked to sign — or, worse, a month that really does differ is given
 * the wrong delta. The figures were right; the second opinion about them was wrong.
 *
 * So the fold lives HERE, beside `PcbAccumulators`, which is the pack's own type. The kernel reaches it
 * through the pack seam (`pack.payroll.foldPriorSlipIntoAccumulators`) like every other statutory
 * derivation; the worksheet is in this pack and imports it directly.
 *
 * MUTATES `acc`, because both callers hold one accumulator per employee and walk their slips in order.
 * `epfReliefCap` is passed in rather than read from a ruleset here: the kernel has the year's cap in
 * hand and the worksheet takes it from `rules.pcb.reliefs.epfReliefCap` — one figure, no second lookup.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: the caller's side-maps. `lpFedByEmp`, `rebateFedByEmp` and
 * `exemptionUsed` answer different questions (what THIS employer has fed, versus what the year holds)
 * and only the kernel asks them. Folding them in here would hand the worksheet balances it must not use.
 */
export function foldPriorSlipIntoAccumulators(
  acc: PcbAccumulators,
  slip: PriorSlipForAccumulators,
  epfReliefCap: number,
): void {
  const st = (slip.statutory ?? {}) as {
    epfEmployee?: number;
    pcb?: number;
    lp?: number;
    zakat?: number;
    zakatRebateTp1?: number;
    bases?: { pcb?: number };
  };
  const claimed = Math.min(Number(st.epfEmployee ?? 0), Math.max(0, epfReliefCap - acc.epfClaimed));
  // ── Σ(Y−K) ACCUMULATES WHAT THE ENGINE CHARGED, NOT WHAT THE PAYSLIP PAID (4011903e) ──────────────
  // `bases.pcb` is the figure PCB was charged on; `gross_pay` is the figure the employee was paid. They
  // differ by every ringgit that is exempt, deducted before tax, or docked as unpaid leave — spec rule 9,
  // printed p.20: "All the tax exemption … shall be EXCLUDED FROM THE REMUNERATION for MTD purposes."
  // A slip predating the r187 stamp has no base and falls back to gross: a DIFFERENT figure, not a
  // rounding difference, so it is COUNTED and disclosed rather than absorbed.
  const stampedBase = st.bases?.pcb;
  const y = stampedBase == null ? Number(slip.gross) : Number(stampedBase);
  if (stampedBase == null) acc.legacyBaseSlips = (acc.legacyBaseSlips ?? 0) + 1;
  acc.grossRemuneration = round2((acc.grossRemuneration ?? 0) + y);
  acc.netRemuneration = round2(acc.netRemuneration + y - claimed);
  acc.epfClaimed = round2(acc.epfClaimed + claimed);
  acc.pcbPaid = round2(acc.pcbPaid + Number(st.pcb ?? 0));
  // §E.5 / rule 5: the FULL amount accrues to Z, spent or not — the spec's column (d) equals its column
  // (b) in every printed row. 72d1a390: column (b) is "Zakat AND DEPARTURE LEVY for current month", so
  // the TP1-claimed rebate accrues here too. It is stamped separately because rule 15 keeps it off the
  // payslip's zakat line; Z is an accumulator, not a disclosure, so both belong in it.
  acc.zakatPaid = round2((acc.zakatPaid ?? 0) + Number(st.zakat ?? 0) + Number(st.zakatRebateTp1 ?? 0));
  acc.lpAccumulated = round2((acc.lpAccumulated ?? 0) + Number(st.lp ?? 0));
}

/** Spec §E.1: calculations are limited to two decimals — TRUNCATE, do not round. */
const trunc2 = (n: number) => Math.trunc(n * 100 + (n >= 0 ? 1e-7 : -1e-7)) / 100;
/** Spec §E.2: the MTD amount rounds UP to the next 5 sen (287.02 → 287.05, 152.06 → 152.10). */
const ceil5sen = (n: number) => Math.ceil(n * 20 - 1e-7) / 20;
/** Spec §E.3/4: an MTD amount below RM10 is not deducted. */
const rm10Floor = (n: number) => (n < 10 ? 0 : n);

/**
 * Spec §E.5 (verbatim tables): the month's zakat offsets the NORMAL MTD first (floor 0); any
 * remainder offsets the additional-remuneration MTD; the FULL zakat amount still accrues to Z.
 * The RM10 floor applies to each component BEFORE offsetting (table (ii) rows a–b).
 *
 * ═══ 72d1a390 (r352) — THE SPECIFICATION IS NOW IN THE REPO, AND IT SETTLES TWO THINGS ═══
 *
 * docs/forms/pcb-spec-2026-computerised-calculation.pdf, printed p.19, rule 5, transcribed verbatim into
 * docs/forms/pcb-spec-2026-extracts.txt. (The /media/arvlrzh5/ URL this repo used to cite is dead; the
 * live path is /wp-content/uploads/. STATUTORY-SOURCES.md records the retrieval.)
 *
 * 1. THE COLUMN IS "ZAKAT AND DEPARTURE LEVY", NOT ZAKAT ALONE. Rule 5 is headed "Zakat and departure
 *    levy shall be treated as follows", and its table's column (b) is "Zakat and departure levy for
 *    current month (RM)". So the Umrah / religious-travel departure levy is offset by THIS function, on
 *    the same footing as zakat. We capture it on Form TP1 D1(b) and it currently reaches nothing —
 *    that is the over-deduction 72d1a390 reports, and the reporter's "single column" reading is correct.
 *
 * 2. THERE IS NO UNUSED-BALANCE CARRY-FORWARD, AND OUR OWN TICKET SAID THERE WAS. Column (d) is headed
 *    "Zakat and departure levy carried forward to the following month (value of Z)" — which reads like a
 *    carry-forward of the UNUSED part, and is not. Read the rows: (c) MTD 15.00, zakat 8.00, net 7.00,
 *    column (d) = 8.00; (d) MTD 120.00, zakat 100.00, net 20.00, column (d) = 100.00. Column (d) equals
 *    column (b) in every row, spent or not. It is the Z ACCUMULATOR taking the FULL amount — exactly what
 *    core/payroll.ts already does ("§E.5: full zakat accrues to Z"). Anything left after the additional
 *    leg is dropped, and dropping it is correct. Do not build a residual ledger.
 *
 * Rule 15 (printed p.35) governs what may be SHOWN: zakat deducted from remuneration "should appear in
 * the payslip and EA Form", while zakat claimed through Form TP1 "should not appear in the payslip and
 * EA Form due to employee himself paid directly to Pusat Zakat" and "is treated as zakat for current
 * month in the month claimed by the employee". So a TP1-sourced amount enters THIS offset and the Z
 * accumulator, and must NOT be folded into the payslip's zakat line or the EA — the two are different
 * money with the same effect on the month's tax.
 *
 * 45df860a — THE WORKING, not just the two answers. Between `mtdNormalCalc` and the figure on the
 * payslip sit FOUR steps that a reader cannot see and cannot infer: the §E.3 RM10 rule on each leg, and
 * then two zero-clamped subtractions. A screen that printed "normal + additional − zakat" would be
 * stating an expression that does not evaluate to the number beside it whenever either leg falls under
 * RM10 or the zakat exceeds the normal leg — so the intermediate legs are returned and recorded, and the
 * screen substitutes THESE.
 *
 * `applyZakatOffset` below keeps its exact two-member shape: the golden suite asserts it with `toEqual`,
 * and widening a return type to serve a screen is how a contract quietly acquires members nobody checks.
 */
export function zakatOffsetWorking(
  normalCalc: number,
  additionalCalc: number,
  zakatCurrent: number,
): {
  /** A — the normal leg after the §E.3 RM10 rule (below RM10 is not deducted at all). */
  flooredNormal: number;
  /** E — the additional leg after the same rule. */
  flooredAdditional: number;
  /** What is left of this month's zakat once the normal leg has absorbed all it can; it reduces E. */
  zakatLeftover: number;
  normal: number;
  additional: number;
} {
  const A = rm10Floor(normalCalc);
  const E = rm10Floor(additionalCalc);
  const z = Math.max(0, zakatCurrent);
  const normal = Math.max(0, round2(A - z));
  const leftover = Math.max(0, round2(z - A));
  const additional = Math.max(0, round2(E - leftover));
  return { flooredNormal: A, flooredAdditional: E, zakatLeftover: leftover, normal, additional };
}

/** The two answers alone — the shape the kernel and the golden tests have always seen. */
export function applyZakatOffset(
  normalCalc: number,
  additionalCalc: number,
  zakatCurrent: number,
): { normal: number; additional: number } {
  const { normal, additional } = zakatOffsetWorking(normalCalc, additionalCalc, zakatCurrent);
  return { normal, additional };
}

export type PcbMonthResult = {
  /** MTD on normal remuneration for the month (post rounding + RM10 rule). */
  normal: number;
  /** MTD on additional remuneration (bonus) for the month (post rounding + RM10 rule). */
  additional: number;
  /** Amount to deduct this month. */
  total: number;
  /** 1.2.4 Zakat — the NORMAL-remuneration MTD BEFORE any zakat offset, post §E.2 ceil5sen, pre §E.3
   *  RM10-floor (the `mtdNormalCalc` value). The zakat 'percent_of_pcb' election multiplies this so the
   *  zakat figure tracks ordinary monthly tax only (bonus-month additional MTD excluded). Additive — does
   *  not change any other output. */
  normalPreZakat: number;
  /** Audit snapshot stamped into the payslip (reproducibility, ADR-0006). */
  snapshot: {
    month: number;
    n: number;
    ytdNet: number;
    /** 4011903e — Y: accumulated remuneration for MTD purposes, before EPF. Absent on a slip stamped
     *  before this item, which is why every reader treats it as optional. */
    ytdGross?: number;
    /** 4011903e — prior months that fell back to `gross_pay` for want of a `bases.pcb` stamp. */
    ytdLegacyBaseSlips?: number;
    epfClaimed: number;
    pcbPaid: number;
    P1: number;
    P2?: number;
    /**
     * 169e3c24 — the RELIEF working behind P, recorded so a payslip can explain its own tax figure.
     *
     * Purely ADDITIVE keys inside the snapshot that is already stored on every payslip: no DDL, no
     * existing payslip rewritten, and every equality assertion over the other keys still holds because
     * both sides of a comparison gain the same fields.
     *
     * WHY IT MATTERS that this is stored rather than re-derived: an employee who marries or has a child
     * changes `category` / `children`, and a tax panel that re-derived the reliefs would then explain a
     * CLOSED payslip with a relief position that did not exist when it was calculated. Runs from this
     * change onward explain themselves exactly as they were computed; earlier ones fall back to the
     * employee's current position, and the panel must SAY which of the two it is showing.
     */
    reliefs: {
      individual: number;
      spouse: number;
      children: number;
      disabledIndividual: number;
      disabledSpouse: number;
      total: number;
      /** The optional-deduction / TP1 total (Σ LP) already netted off P beside the reliefs. */
      lp: number;
    };
    /**
     * 45df860a — THE REST OF THE WORKING. Same posture and the same reasons as `reliefs` above: purely
     * ADDITIVE keys inside a snapshot that is already stored on every payslip, so no DDL, no existing
     * payslip rewritten, and no equality assertion over the other keys disturbed.
     *
     * Every figure below was an in-scope local of `pcbMonth` that the function then threw away. Recording
     * them is what lets a screen restate the LHDN formula with THIS run's numbers substituted rather than
     * an approximation of them — the reader's complaint was that the stored working stopped short of the
     * bracket and the EPF legs, so the formula could not be closed.
     *
     * FORWARD-ONLY, AND THE ABSENCE MUST BE SAID OUT LOUD. A payslip processed before this shipped has a
     * snapshot with no `trace`, and there is no honest way to reconstruct one: back-deriving M/R/B from a
     * stored P would be a SECOND calculation, and the whole point of the snapshot is that there is only
     * ever one. `core/pcb-explain.ts` therefore reports a missing trace as "not recorded for this run"
     * and the screen prints that sentence — it never renders the missing legs as zeroes.
     */
    trace?: {
      /** LHDN Table 1 row that P₁ fell into, and the annual tax it yields. `B` is already the
       *  category-selected column (negative B encodes the RM400/RM800 rebate). */
      M: number;
      R: number;
      B: number;
      taxOnP1: number;
      /**
       * The s.48 category the B column was read from, and THE SPEC'S OWN Q AND C.
       *
       * ⚠️ r359 fda53352 — `childCount` WAS `num_children`, THE COUNT OF CHILD RECORDS, AND THAT IS NOT
       * WHAT C MEANS. LHDN's specification, printed p.10, defines the two letters of the QC term:
       * "Q  Deduction for qualifying children" and "C  Number of qualifying children"; printed p.27
       * decides C under the heading "Relief to be given AS IF THE EMPLOYEE HAS THIS NUMBER OF CHILDREN"
       * (4 / 4 / 4 / 8). So C is the WEIGHTED figure. The slip printed Q as the RM total and C as the
       * record count, and the two did not multiply to the relief on the same slip — for a disabled child
       * in higher education plus a child under 18 it read Q RM18,000 and C 2, whose product is RM36,000.
       *
       * THE MONEY DID NOT MOVE AND DOES NOT MOVE HERE. `reliefs.children` is and was the relief that was
       * netted off P; these two are what the slip CALLS it, and they now satisfy `q * c === reliefs
       * .children` by construction rather than by coincidence.
       */
      category: TaxCategory;
      /** C — the number of qualifying children in the spec's weighted sense. Fractional where a child's
       *  relief is shared 50/50, because `childReliefFor` halves such a child and the product must still
       *  reach the relief. The spec has no half child; a shared claim settles at the annual assessment. */
      childCount: number;
      /** Q — the deduction FOR ONE qualifying child, straight off the ruleset. */
      childDeductionPerChild: number;
      childWorking?: NonNullable<TaxProfile['childWorking']> & {
        disabledIndividual: boolean;
        disabledSpouse: boolean;
      };
      /** The remuneration legs exactly as they entered P₁. Y₂ IS Y₁ by construction — the projection
       *  assumes each remaining month repeats the current one — and is stored rather than left implied,
       *  because a reader checking `(Y₂−K₂)·n` cannot otherwise tell which figure was projected. */
      Y1: number;
      K1: number;
      Y2: number;
      K2: number;
      /** The additional-remuneration legs (Yₜ, Kₜ) and the estimated-EPF leg recomputed alongside them.
       *  All three are 0 for a month that paid no additional remuneration — which is the answer, not a
       *  gap: LHDN §D.2 does not run at all in that month. */
      Yt: number;
      Kt: number;
      K2t: number;
      /** Accumulators the snapshot did not already carry: Z (zakat paid via salary in PRIOR months),
       *  Σ LP and LP₁ split out of the combined `reliefs.lp`, and this month's own zakat (the §E.5
       *  offset). ∑(Y−K) is `ytdNet`, K is `epfClaimed` and X is `pcbPaid`, all above. */
      Z: number;
      lpAccumulated: number;
      lpCurrent: number;
      zakatCurrent: number;
      /** §D.2 Step 3 and Step 1[E]. Present ONLY when additional remuneration was paid, because those
       *  two steps only run then — an absent key means "this month had no additional remuneration",
       *  which is a different statement from "zero". */
      totalTaxYear?: number;
      totalMtdYear?: number;
      /** The two MTD legs as the formula produced them: post §E.1 truncation and §E.2 5-sen round-up,
       *  BEFORE the §E.3 RM10 floor and the §E.5 zakat offset. `normal`/`additional` on the result are
       *  the same figures after both. */
      mtdNormalCalc: number;
      mtdAdditionalCalc: number;
      /** …and the SAME two legs after the §E.3 RM10 rule (A and E in the spec's own tables), plus the
       *  zakat left over once the normal leg absorbed what it could. Without these three the last line
       *  of the working — legs → RM10 rule → zakat offset → the deducted figure — cannot be written as
       *  an expression that evaluates to the deducted figure, which is the only kind worth printing. */
      mtdNormalFloored: number;
      mtdAdditionalFloored: number;
      zakatLeftover: number;
    };
  };
};

/**
 * Item d64d0df4 — one employee's keyed child-relief GRID → the total child deduction in RM.
 *
 * The grid is `{ <s.48 category>: { full: n, half: n } }`, exactly as stored on
 * employee_statutory_my.child_relief_table. `full` is the count of children claimed at 100%, `half` the
 * count claimed at 50% (LHDN: 100% to one parent, or 50% each when parents split the claim), so a half
 * child is worth exactly half the category's amount — no rounding is applied here, because the
 * projection of P is truncated once, downstream, exactly as it is today.
 *
 * WHERE THE AMOUNTS COME FROM: the RULESET (`pcb.reliefs.childByCategory`), falling back to the pack's
 * built-in map when the resolved ruleset predates 2026.7 — the same optional-with-fallback shape
 * `hrdfLevy` uses. A category present in the grid but absent from BOTH maps contributes nothing rather
 * than throwing: an unknown key is a data error, not a reason to fail a payroll run, and the setter
 * already drops unknown keys on write.
 *
 * This is a PURE function on the pack surface (`pack.payroll.childReliefAmountFor`) so the kernel never
 * names a Malaysian relief figure; it hands the grid + the resolved reliefs back to the pack.
 */
export function childReliefAmountFor(
  table: unknown,
  reliefs?: StatutoryRuleset['pcb']['reliefs'],
): number {
  // 04b88724 (r340 fix pass) — THE WALK MOVED, THE ANSWER DID NOT. This is now one field of
  // `childReliefFor`'s return value, which also carries the qualifying-children COUNT and the per-line
  // working. Before the move, three places multiplied category counts by category prices — here,
  // core/dependents.ts and the Identification & Tax card — and the card's copy under-stated the relief it
  // printed on screen. One derivation, in ./child-relief.ts; the money and the count are two fields of one
  // value and cannot come apart. Every input this returned a figure for returns the identical figure.
  return childReliefFor({ from: 'table', table, prices: childReliefPrices(reliefs) }).amountRM;
}

/**
 * One month's PCB under the full computerised method. `monthlyWage` is Y₁ (taxable cash, incl.
 * OT, prorated actual); `epfMonthly` the actual employee EPF on it; `additional`/`epfOnAdditional`
 * the bonus (Yₜ/Kₜ). `month` is the calendar month of the pay period (1–12).
 */
export function pcbMonth(p: {
  monthlyWage: number;
  epfMonthly: number;
  month: number;
  profile?: TaxProfile;
  acc?: PcbAccumulators;
  additional?: number;
  epfOnAdditional?: number;
  /** LP₁ — current-month TP1 optional deductions. */
  lpCurrent?: number;
  /** Zakat paid via salary deduction this month — offsets the MTD per §E.5. */
  zakatCurrent?: number;
  /** PCB bands + reliefs (ADR-0019); defaults to the verified built-in set. */
  pcb?: StatutoryRuleset['pcb'];
}): PcbMonthResult {
  const category: TaxCategory = p.profile?.category ?? 1;
  const children = p.profile?.children ?? 0;
  const acc = p.acc ?? PCB_ZERO_ACC;
  const month = Math.min(12, Math.max(1, Math.trunc(p.month)));
  const n = 12 - month; // balance of months AFTER the current one
  const pcb = p.pcb ?? DEFAULT_MY_STATUTORY.pcb;
  const cap = pcb.reliefs.epfReliefCap;
  // d64d0df4 — the further OKU deduction. Read from the RULESET (the pack / an admin override), falling
  // back to the verified built-in when the ruleset predates 2026.6 — the same shape `hrdfLevy` uses for
  // rules.hrdf, so a relief amount is never an inline constant in the calculation. Applied ONLY when this
  // employee is flagged, so an unflagged employee's P is arithmetically identical to before.
  const disabledRelief = p.profile?.disabled
    ? (pcb.reliefs.disabledIndividual ?? DEFAULT_MY_STATUTORY.pcb.reliefs.disabledIndividual ?? 0)
    : 0;
  // d64d0df4 — the further deduction for a DISABLED SPOUSE. Read from the RULESET with the same
  // optional-with-fallback shape as `disabledIndividual` above, and GATED TO CATEGORY 2 exactly as the
  // `spouse` deduction beside it is: a single (cat 1) or spouse-working/divorced/widowed (cat 3)
  // employee has no spouse deduction to add to, so the flag is stored and shown but moves nothing.
  const disabledSpouseRelief =
    p.profile?.disabledSpouse && category === 2
      ? (pcb.reliefs.disabledSpouse ?? DEFAULT_MY_STATUTORY.pcb.reliefs.disabledSpouse ?? 0)
      : 0;
  // d64d0df4 — the child leg. `childReliefAmount` is supplied ONLY for an employee in 'auto_table'
  // child-relief mode, where the caller has already worked the total out category by category from the
  // ruleset's `childByCategory` map (halving any 50%-share child). For every other employee it is
  // undefined and this is `children * perChild` — the identical expression that was here before.
  const childRelief = p.profile?.childReliefAmount ?? children * pcb.reliefs.perChild;
  const reliefs =
    pcb.reliefs.individual +
    (category === 2 ? pcb.reliefs.spouse : 0) +
    childRelief +
    disabledRelief +
    disabledSpouseRelief;
  const lp = (acc.lpAccumulated ?? 0) + (p.lpCurrent ?? 0);
  const Z = acc.zakatPaid ?? 0;
  const X = acc.pcbPaid;
  const Y1 = p.monthlyWage;
  const K = Math.min(acc.epfClaimed, cap);
  const K1 = Math.min(p.epfMonthly, Math.max(0, cap - K));

  // Step 1 — MTD on net NORMAL remuneration (additional remuneration excluded).
  const K2n = n > 0 ? trunc2(Math.min((cap - K - K1) / n, K1)) : 0;
  const P1 = trunc2(acc.netRemuneration + (Y1 - K1) + (Y1 - K2n) * n - reliefs - lp);
  // 45df860a — the bracket is now KEPT rather than consumed inline. `bracket.tax` is the exact number
  // `annualTaxFor` used to return, so this line is arithmetically identical to the one it replaces.
  const bracket = annualTaxFor(P1, category, pcb.bands);
  const mtdNormalCalc = ceil5sen(trunc2(Math.max(0, (bracket.tax - (Z + X)) / (n + 1))));

  // Steps 2–4 — additional remuneration via the year-total difference.
  const Yt = Math.max(0, p.additional ?? 0);
  let additionalCalc = 0;
  let P2: number | undefined;
  // 45df860a — hoisted out of the branch so the snapshot can record them. They stay 0/undefined for a
  // month with no additional remuneration, which is exactly what the branch not running means.
  let Kt = 0;
  let K2a = 0;
  let totalTaxYear: number | undefined;
  let totalMtdYear: number | undefined;
  if (Yt > 0) {
    Kt = Math.min(p.epfOnAdditional ?? 0, Math.max(0, cap - K - K1));
    K2a = n > 0 ? trunc2(Math.min((cap - K - K1 - Kt) / n, K1)) : 0;
    P2 = trunc2(acc.netRemuneration + (Y1 - K1) + (Y1 - K2a) * n + (Yt - Kt) - reliefs - lp);
    totalTaxYear = annualTaxFor(P2, category, pcb.bands).tax; // Step 3
    totalMtdYear = X + mtdNormalCalc * (n + 1); // Step 1[E]
    additionalCalc = ceil5sen(trunc2(Math.max(0, totalTaxYear - totalMtdYear + Z))); // Step 4
  }

  // §E.5: current-month zakat offsets normal first, remainder offsets additional. The WORKING form is
  // called (identical arithmetic — `applyZakatOffset` is now a two-member view of it) so the RM10-floored
  // legs and the zakat remainder can be recorded instead of thrown away with everything else.
  const offset = zakatOffsetWorking(mtdNormalCalc, additionalCalc, p.zakatCurrent ?? 0);
  const { normal, additional } = offset;
  return {
    normal,
    additional,
    total: round2(normal + additional),
    // 1.2.4 Zakat — the pre-offset normal MTD (mtdNormalCalc), so the percent-of-PCB election can multiply
    // it without re-deriving. Additive; the offset/total above are unchanged.
    normalPreZakat: mtdNormalCalc,
    snapshot: {
      month,
      n,
      ytdNet: round2(acc.netRemuneration),
      // 4011903e — Y, STORED rather than reconstructed. core/pcb-explain.ts printed a labelled
      // "not recorded separately" row because adding `ytdNet + epfClaimed` back together would have been
      // correct arithmetic producing a figure this system never wrote down, and a guard in
      // test/7f251381-pcb-lhdn-worksheet.test.ts refuses exactly that sum. It is written down now, by the
      // same replay that produced ytdNet, so the row can print a figure instead of an apology.
      // Undefined when the caller did not supply it — the old row still renders in that case.
      ...(acc.grossRemuneration == null ? {} : { ytdGross: round2(acc.grossRemuneration) }),
      ...(acc.legacyBaseSlips ? { ytdLegacyBaseSlips: acc.legacyBaseSlips } : {}),
      epfClaimed: round2(K),
      pcbPaid: round2(X),
      P1,
      ...(P2 !== undefined ? { P2 } : {}),
      // 169e3c24 — the relief legs exactly as they entered `reliefs` above, so the tax panel restates the
      // arithmetic that ran rather than an approximation of it.
      reliefs: {
        individual: pcb.reliefs.individual,
        spouse: category === 2 ? pcb.reliefs.spouse : 0,
        children: round2(childRelief),
        disabledIndividual: disabledRelief,
        disabledSpouse: disabledSpouseRelief,
        total: round2(reliefs),
        lp: round2(lp),
      },
      // 45df860a — the rest of the working. Every member was already computed above; none of them is
      // derived here, and none of them is rounded differently from the value that entered the formula.
      trace: {
        M: bracket.M,
        R: bracket.R,
        B: bracket.B,
        taxOnP1: round2(bracket.tax),
        category,
        // r359 — C from the money, not from `children` (which is `num_children`, the record count).
        // `childRelief` is what was actually deducted, weighted by the s.48 grid where one applies, so
        // dividing by the per-child figure gives the spec's C and keeps Q x C === the relief exactly.
        childCount: round2(childRelief / pcb.reliefs.perChild),
        childDeductionPerChild: pcb.reliefs.perChild,
        ...(p.profile?.childWorking ? {
          childWorking: {
            ...structuredClone(p.profile.childWorking),
            disabledIndividual: p.profile.disabled ?? false,
            disabledSpouse: p.profile.disabledSpouse ?? false,
          },
        } : {}),
        Y1,
        K1: round2(K1),
        // Y₂ = Y₁: the projection repeats the current month across the balance of the year.
        Y2: Y1,
        K2: K2n,
        Yt,
        Kt: round2(Kt),
        K2t: K2a,
        Z: round2(Z),
        lpAccumulated: round2(acc.lpAccumulated ?? 0),
        lpCurrent: round2(p.lpCurrent ?? 0),
        zakatCurrent: round2(Math.max(0, p.zakatCurrent ?? 0)),
        ...(totalTaxYear !== undefined ? { totalTaxYear: round2(totalTaxYear) } : {}),
        ...(totalMtdYear !== undefined ? { totalMtdYear: round2(totalMtdYear) } : {}),
        mtdNormalCalc,
        mtdAdditionalCalc: additionalCalc,
        mtdNormalFloored: offset.flooredNormal,
        mtdAdditionalFloored: offset.flooredAdditional,
        zakatLeftover: offset.zakatLeftover,
      },
    },
  };
}

/**
 * ADR-0029 group-PCB allocation. When one person holds concurrent employments across the group's
 * companies, their month is taxed ONCE on the combined remuneration (a single `pcbMonth`), then the
 * resulting `total` / `additional` MTD is split back across the employments pro-rata to each one's
 * taxable share (normal: Y₁−K₁; bonus: Yₜ). §E rounding is already applied to the person total by
 * `pcbMonth`; here each slice is rounded to 2dp and the **residual is pinned to the largest-share
 * employment** so the slices sum to the combined total to the sen. Pure + golden-tested; the kernel calls
 * this only when `pcb_aggregation_mode = 'group_coordinated'` (gated, default off — Slice 2 wires it).
 */
export function allocatePcb(
  total: number,
  additional: number,
  shares: { employmentId: string; normalShare: number; bonusShare: number }[],
): Map<string, { pcb: number; pcbBonus: number }> {
  const split = (amount: number, weightOf: (s: (typeof shares)[number]) => number): Map<string, number> => {
    const out = new Map<string, number>();
    if (shares.length === 0) return out;
    const weights = shares.map((s) => ({ id: s.employmentId, w: Math.max(0, weightOf(s)) }));
    const totalW = weights.reduce((a, b) => a + b.w, 0);
    // The employment carrying the rounding residual: largest weight (first, when all weights are 0).
    let residualId = weights[0].id;
    let maxW = -1;
    for (const x of weights) if (x.w > maxW) { maxW = x.w; residualId = x.id; }
    let assigned = 0;
    for (const x of weights) {
      if (x.id === residualId) { out.set(x.id, 0); continue; }
      const v = totalW > 0 ? round2((amount * x.w) / totalW) : 0;
      out.set(x.id, v);
      assigned = round2(assigned + v);
    }
    out.set(residualId, round2(amount - assigned));
    return out;
  };
  const pcbBy = split(total, (s) => s.normalShare);
  const bonusBy = split(additional, (s) => s.bonusShare);
  const result = new Map<string, { pcb: number; pcbBonus: number }>();
  for (const s of shares) {
    result.set(s.employmentId, { pcb: pcbBy.get(s.employmentId) ?? 0, pcbBonus: bonusBy.get(s.employmentId) ?? 0 });
  }
  return result;
}

/**
 * ADR-0029 group coordinator (gated, default off — the kernel calls this only under the coordination flag;
 * the in-kernel peer-slip read + fail-closed wiring is the integration slice). Tax a person's month ONCE
 * on the COMBINED remuneration across their concurrent employments (one `pcbMonth`), then allocate the
 * resulting MTD back per employment (`allocatePcb`). The combined MTD is ≥ the sum of the per-employment
 * MTDs (progressive tax), so per-employer filing UNDER-deducts — this returns the correct combined-month
 * figure, split so the slices sum to it. The EPF relief K is capped ONCE on the combined inputs inside
 * `pcbMonth`. EPF/SOCSO/EIS are NOT coordinated (correctly per-employer); only `pcb`/`pcbBonus` change.
 */
export function coordinatedPcbForPerson(
  employments: {
    employmentId: string;
    monthlyWage: number;
    epfMonthly: number;
    additional?: number;
    epfOnAdditional?: number;
    acc?: PcbAccumulators;
    lpCurrent?: number;
    zakatCurrent?: number;
  }[],
  shared: { month: number; profile?: TaxProfile; pcb?: StatutoryRuleset['pcb'] },
): {
  combinedMtd: number;
  combinedAdditional: number;
  byEmployment: Map<string, { pcb: number; pcbBonus: number }>;
  /** 45df860a — the PRE-SPLIT person-level working. The coordinator taxes the month ONCE on the combined
   *  remuneration, so the formula, the bracket and every leg belong to the PERSON, not to any one
   *  employment: a trace per slice would restate a calculation that never ran. Returned rather than
   *  discarded so the kernel slice that wires coordination has one snapshot to stamp on the slips it
   *  splits. Additive — the three existing members are unchanged. */
  snapshot: PcbMonthResult['snapshot'];
} {
  const sum = (f: (e: (typeof employments)[number]) => number | undefined) =>
    employments.reduce((a, e) => a + (f(e) ?? 0), 0);
  const combinedAcc: PcbAccumulators = {
    netRemuneration: sum((e) => e.acc?.netRemuneration),
    epfClaimed: sum((e) => e.acc?.epfClaimed), // K capped ONCE at the annual relief inside pcbMonth
    pcbPaid: sum((e) => e.acc?.pcbPaid),
    zakatPaid: sum((e) => e.acc?.zakatPaid),
    lpAccumulated: sum((e) => e.acc?.lpAccumulated),
  };
  const m = pcbMonth({
    monthlyWage: sum((e) => e.monthlyWage),
    epfMonthly: sum((e) => e.epfMonthly),
    month: shared.month,
    profile: shared.profile,
    acc: combinedAcc,
    additional: sum((e) => e.additional),
    epfOnAdditional: sum((e) => e.epfOnAdditional),
    lpCurrent: sum((e) => e.lpCurrent),
    zakatCurrent: sum((e) => e.zakatCurrent),
    pcb: shared.pcb,
  });
  const shares = employments.map((e) => ({
    employmentId: e.employmentId,
    normalShare: Math.max(0, e.monthlyWage - e.epfMonthly),
    bonusShare: Math.max(0, e.additional ?? 0),
  }));
  return {
    combinedMtd: m.total,
    combinedAdditional: m.additional,
    byEmployment: allocatePcb(m.total, m.additional, shares),
    snapshot: m.snapshot,
  };
}

/**
 * All statutory contributions for a monthly wage. `profile` defaults to Category 1 (single).
 * `additional` is a bonus / additional remuneration paid this month: subject to EPF (rate by the
 * normal wage) and PCB (difference method), but EXCLUDED from SOCSO and EIS.
 *
 * `overtime` is the month's OT pay. Agency bases differ (STATUTORY-SOURCES.md §6):
 * EPF EXCLUDES overtime (KWSP non-liable list); SOCSO and EIS INCLUDE it (PERKESO wages
 * definition); PCB taxes all cash remuneration. `wage` must therefore be EX-overtime.
 */
export function statutory(
  wage: number,
  profile?: TaxProfile,
  additional = 0,
  overtime = 0,
  /** PCB context: pay-period month (1–12), the year's accumulators (ADR-0014), and this
   *  month's TP1 deduction / zakat inputs. Defaults to January-with-no-priors. */
  pcbCtx?: { month?: number; acc?: PcbAccumulators; lpCurrent?: number; zakatCurrent?: number },
  /** Employee attributes the engine derives: SOCSO category (2 = age 60+, employer-only),
   *  EIS eligibility (false at 60+, or the profile flag), residency (non-residents: flat 30%),
   *  and the EPF contribution-mode election (Wave 2B; i-Topup / exempt). */
  opts?: {
    socsoCategory?: 1 | 2;
    eisEligible?: boolean;
    /** Item 5a461b99 — "Subject to SOCSO" / "Subject to SKBBK". Unchecked ⇒ that scheme is not contributed
     *  (zero employer + employee legs). Both default TRUE so existing callers/golden tests are byte-identical
     *  (SOCSO + the mandatory SKBBK leg stay on). Gated here so the REPORTED figure is zero when exempt. */
    subjectToSocso?: boolean;
    subjectToSkbbk?: boolean;
    resident?: boolean;
    /** Item 8b5334db — an explicit flat PCB rate for the incentive tax-residency statuses, overriding the
     *  resident/non-resident branch selection. null/undefined ⇒ resolve from `resident` (back-compat). 0.30 ⇒
     *  non-resident (identical to resident:false); 0.15 ⇒ REP / Knowledge Worker (specific region). A flat rate
     *  means the same "flat % of taxable remuneration, no reliefs, no accumulators" shape as the non-resident MTD. */
    flatTaxRate?: number | null;
    epfElection?: EpfElection;
    /** Employee age + citizenship select the EPF rule (Part A / Part E senior / non-citizen 2%/2%). */
    epfAge?: number | null;
    epfCitizenship?: EpfCitizenship;
    // ── Feedback 017d9c25 (r187) — PER-AGENCY BASE CARVE-OUTS ──────────────────────────────────────
    // `wage` / `additional` / `overtime` keep their meanings EXACTLY (the whole golden suite is pinned
    // to them). These four numbers say how much of that money a specific agency's base must NOT (or
    // must ALSO) see, because the pay item carrying it is ticked in/out of that agency.
    //
    // WHY THEY EXIST. Before r187 a pay item's `pcb_remuneration_type` decided which statutory pot the
    // amount fell into and the EPF / SOCSO-EIS ticks were not read at all once it was declared. An
    // allowance ticked "not subject to EPF" but classified 'normal' still landed in the EPF wage; an
    // overtime code ticked "not EPF, yes SOCSO" but classified 'additional' was charged EPF AND left
    // out of SOCSO — backwards in both directions. The kernel now routes by the declaration (which is
    // a PCB question: Y1 vs Yt) and carves the bases by the ticks (which is the agency question).
    //
    // ALL DEFAULT 0 ⇒ byte-identical for every existing caller and every golden test.
    /** Money inside `wage` that is NOT EPF-liable (a 'normal'-stream item ticked not-subject-to-EPF). */
    epfWageExcluded?: number;
    /** Money inside `additional` that is NOT EPF-liable (an 'additional'-stream item ticked not-subject-to-EPF). */
    epfAdditionalExcluded?: number;
    /** Money inside `wage` that is NOT SOCSO/EIS-liable (a 'normal'-stream item ticked not-subject-to-SOCSO/EIS). */
    socsoWageExcluded?: number;
    /** Money inside `additional` that IS SOCSO/EIS-liable (an 'additional'-stream item ticked subject-to-SOCSO/EIS —
     *  the overtime-classified-as-additional case). The only carve-out that ADDS a contribution. */
    socsoWageExtra?: number;
    // ── Feedback 2333b7fb (r193) — DEDUCTION-SIDE BASE REDUCTIONS ─────────────────────────────────────
    // The r187 carve-outs above all describe money that is INSIDE `wage`/`additional` and must be taken
    // back out of one agency's base. These four describe money that is NOT inside `wage` at all: a
    // kind='deduction' pay item (unpaid leave, absence, short notice) whose amount was subtracted from
    // take-home AFTER every contribution was computed, while its own EPF / SOCSO / PCB / HRDF boxes were
    // read by nothing. Ticked, the item now reduces each base whose box it carries — judged separately,
    // one box per agency, exactly as the operator set them.
    //
    // ⚠️ PCB IS CARVED HERE AND IS NOT AN OVERSIGHT — it is a DELIBERATE ASYMMETRY WITH r187, and the
    // next reader will otherwise "fix" it back to match the comment above. For an EARNING the money is
    // still taxable remuneration, so r187 correctly leaves the PCB base alone: the ticks there answer
    // "which agency is liable", never "was this earned". For a DEDUCTION the money WAS NEVER EARNED —
    // an unpaid-leave day is pay that did not happen — so the remuneration LHDN taxes legitimately
    // falls with it. Removing `pcbWageDeduction` would tax an employee on wages they never received.
    //
    // ALL DEFAULT 0 ⇒ byte-identical for every existing caller and every golden test.
    /** Deduction money to take OUT of the EPF wage base (item ticked "subject to EPF"). */
    epfWageDeduction?: number;
    /** Deduction money to take OUT of the SOCSO/EIS/SKBBK base (item ticked "subject to SOCSO/EIS"). */
    socsoWageDeduction?: number;
    /** Deduction money to take OUT of the PCB remuneration base (item ticked "subject to PCB"). */
    pcbWageDeduction?: number;
  },
  /** The active statutory ruleset (ADR-0019); defaults to the verified built-in set. */
  rules: StatutoryRuleset = DEFAULT_MY_STATUTORY,
) {
  const cashWage = round2(wage + Math.max(0, overtime)); // wages incl. OT (SOCSO/EIS/PCB base)
  // Feedback 017d9c25 — the agency bases after the EARNING-side pay-item ticks are honoured. PCB is
  // deliberately NOT carved by those: every one of those items is still taxable remuneration (their
  // ticks are about EPF/PERKESO liability, not about tax), so `epfWageExcluded` / `socsoWageExcluded` /
  // `socsoWageExtra` never touch `pcbWage` below.
  // Feedback 2333b7fb — …and the DEDUCTION-side reductions, subtracted at the same points and clamped
  // the same way. `pcbWageDeduction` IS applied to `pcbWage`, and that asymmetry with r187 is the whole
  // point: an earning is remuneration that WAS received, a ticked deduction is wage that was NOT. Read
  // the opts doc block before changing either half.
  const epfWage = Math.max(
    0,
    round2(wage - Math.max(0, opts?.epfWageExcluded ?? 0) - Math.max(0, opts?.epfWageDeduction ?? 0)),
  );
  const epfAdditional = Math.max(0, round2(additional - Math.max(0, opts?.epfAdditionalExcluded ?? 0)));
  const socsoWage = Math.max(
    0,
    round2(
      cashWage -
        Math.max(0, opts?.socsoWageExcluded ?? 0) +
        Math.max(0, opts?.socsoWageExtra ?? 0) -
        Math.max(0, opts?.socsoWageDeduction ?? 0),
    ),
  );
  /** The cash remuneration PCB is charged on. Identical to `cashWage` unless a ticked deduction says
   *  some of that wage was never earned this month (unpaid leave / absence / short notice). */
  const pcbWage = Math.max(0, round2(cashWage - Math.max(0, opts?.pcbWageDeduction ?? 0)));
  // EPF by age + citizenship (Part A / Part E senior / non-citizen 2%/2%; #95). Bonus IS subject to
  // EPF; overtime is NOT.
  const eC = epfContribution(epfWage, epfAdditional, rules.epf, opts?.epfElection, {
    age: opts?.epfAge,
    citizenship: opts?.epfCitizenship,
  });
  const e = { employee: eC.employee, employer: eC.employer };
  const sRaw = socso(socsoWage, opts?.socsoCategory ?? 1, rules.socso); // bonus excluded; overtime included
  // Item 5a461b99 — "Subject to SOCSO" gates the SOCSO Injury/Invalidity legs; "Subject to SKBBK" gates the
  // (independent) SKBBK leg. Both default on so existing behaviour is byte-identical. Unchecked ⇒ 0 in the
  // reported figure (the employee is exempt), not merely undeducted (that is the separate employer-bears case).
  const socsoOn = opts?.subjectToSocso ?? true;
  const skbbkOn = opts?.subjectToSkbbk ?? true;
  const s = {
    employee: socsoOn ? sRaw.employee : 0,
    employer: socsoOn ? sRaw.employer : 0,
    skbbk: skbbkOn ? sRaw.skbbk : 0,
  };
  const eisOn = opts?.eisEligible ?? true;
  const i = eisOn ? eis(socsoWage, rules.eis) : { employer: 0, employee: 0 }; // bonus excluded; OT included
  // EPF relief split: the employee share on the bonus (Kₜ). 0 for seniors (Part E, no employee share);
  // the flat rate on the bonus for a non-citizen; and for citizens < 60 (bdf7d248) the DIFFERENCE
  // between the combined-month Third Schedule lookup and the same lookup on the normal wage alone, so
  // `e.employee − epfOnBonus` below is exactly the normal-wage schedule amount K₁ is taken from.
  const epfOnBonus = eC.employeeOnBonus;
  // Item 8b5334db — resolve the flat PCB rate: an explicit flatTaxRate wins (REP/Knowledge Worker = 0.15,
  // non_resident = 0.30); otherwise fall back to the legacy resident=false ⇒ 0.30 branch. A resident (null
  // rate, resident !== false) takes the full computerised-MTD path below. This keeps every existing caller
  // byte-identical: resident:false with no flatTaxRate still yields exactly 0.30.
  const flatRate = opts?.flatTaxRate != null ? opts.flatTaxRate : opts?.resident === false ? 0.3 : null;
  if (flatRate != null) {
    // Flat-rate MTD (spec §D.a for non-residents; the REP/Knowledge-Worker incentive schemes use the same
    // shape at 15%): flat % of taxable remuneration, no reliefs / accumulators.
    const pcbAll = rm10Floor(ceil5sen(trunc2((pcbWage + additional) * flatRate)));
    const pcbBonusOnly = rm10Floor(ceil5sen(trunc2(additional * flatRate)));
    return {
      epfEmployee: e.employee,
      epfEmployer: e.employer,
      socsoEmployee: s.employee,
      socsoEmployer: s.employer,
      socsoSkbbk: s.skbbk,
      eisEmployee: i.employee,
      eisEmployer: i.employer,
      pcb: pcbAll,
      pcbBonus: Math.min(pcbBonusOnly, pcbAll),
      // 1.2.4 Zakat — undefined for flat-rate payees (zakat-via-salary % is undefined here): the
      // percent_of_pcb election yields 0 for them by construction.
      pcbNormalPreZakat: 0,
      // 45df860a — the flat working, which is two multiplications and no reliefs at all. It is recorded
      // for the same reason the MTD trace is: the detail screen must be able to say WHICH remuneration
      // the flat rate was applied to, and RM x % is not checkable without the x. Additive; the three
      // keys that were here are untouched.
      pcbMeta: {
        nonResident: flatRate === 0.3,
        flatRate,
        rate: flatRate,
        trace: { remuneration: pcbWage, additional, rate: flatRate },
      },
      version: rules.version,
    };
  }
  const m = pcbMonth({
    monthlyWage: pcbWage,
    epfMonthly: Math.max(0, e.employee - epfOnBonus),
    month: pcbCtx?.month ?? 1,
    profile,
    acc: pcbCtx?.acc,
    additional,
    epfOnAdditional: epfOnBonus,
    lpCurrent: pcbCtx?.lpCurrent,
    zakatCurrent: pcbCtx?.zakatCurrent,
    pcb: rules.pcb,
  });
  return {
    epfEmployee: e.employee,
    epfEmployer: e.employer,
    socsoEmployee: s.employee,
    socsoEmployer: s.employer,
    socsoSkbbk: s.skbbk,
    eisEmployee: i.employee,
    eisEmployer: i.employer,
    pcb: m.total,
    /** PCB attributable to the bonus alone (audit / payslip breakdown). */
    pcbBonus: m.additional,
    /** 1.2.4 Zakat — the normal MTD before any zakat offset (mtdNormalCalc); the kernel multiplies this by
     *  the employee's zakatPercent for the 'percent_of_pcb' election. Additive. */
    pcbNormalPreZakat: m.normalPreZakat,
    /** Accumulator snapshot the PCB was computed from (audit / reproducibility, ADR-0014). */
    pcbMeta: m.snapshot,
    /** Statutory-table version that produced these figures (audit / reproducibility). */
    version: rules.version,
  };
}

// ───────────────────── Overtime monetization (EA 1955) ─────────────────────
/**
 * Sources (verified 2026-06-10, STATUTORY-SOURCES.md §6):
 * - ORP (ordinary rate of pay) = monthly wages / 26 (s.60I(1A)); hourly = ORP / normal hours.
 * - Normal workday OT: 1.5× hourly (s.60A(3)(a)).
 * - Rest day, monthly-rated: work ≤ half normal hours = ½ day ORP; more (up to normal) =
 *   1 day ORP (s.60(3)(b)); hours beyond normal = 2× hourly (s.60(3)(c)).
 * - Public holiday: working it earns 2 extra days' ORP (s.60D(3)(a), on top of the paid
 *   holiday already in monthly wages); hours beyond normal = 3× hourly (s.60D(3)(aa)).
 * - First Schedule (Amendment Order 2022): employees with wages > RM4,000/month are not
 *   entitled to ss.60/60A(3)/60D(3) pay (the manual-worker exception is NOT modelled —
 *   such employees should be handled with a manual override; documented in §6).
 */
export { MY_OT_WAGE_CEILING };

export type OtDay = { dayType: 'workday' | 'rest_day' | 'holiday'; minutes: number };

/**
 * a96d320c — WHICH RULE PAID WHICH PART, AS QUANTITY × UNIT RATE.
 *
 * The board item asked for "the overtime rate and the hours behind it". `total` is one number; the five
 * legs below are what produced it, and each one is a genuine quantity times a genuine unit rate under the
 * EA sections cited above — not a reconstruction. They are RETURNED, not printed: the kernel stamps them
 * onto the payroll_input row the figure was written to, and the payslip reads them back (see
 * `prefillOvertimeFromAttendance`). Nothing here changes a figure: `total` is composed exactly as it was.
 *
 * `kind` is a STORED CONTRACT, like `EarningBucket` — a reader maps it to a localized label and must never
 * reinterpret it.
 *
 * WHY `rate` IS NOT ROUNDED TO THE SEN. A workday hour is paid at `1.5 × hourly`, which carries three
 * decimals whenever the hourly rate's cents are odd. Rounding it here would stop `qty × rate` reproducing
 * `amount`, and a payslip that prints a quantity, a rate and a product that do not multiply out is worse
 * than one that prints the total alone. The rate is stored exactly and the document prints it at the
 * precision it actually has.
 *
 * `qty` IS rounded to two places, because it is what a reader multiplies: the rounded quantity is the one
 * `amount` is computed from, so the arithmetic on the page is the arithmetic that happened. A day count
 * that rounding moved would make the legs stop summing to `total`, and the kernel refuses to stamp a
 * decomposition that does not sum — see `prefillOvertimeFromAttendance`.
 */
export type OvertimeLineKind = 'workday' | 'rest_day' | 'rest_day_excess' | 'holiday' | 'holiday_excess';
export type OvertimeLine = {
  kind: OvertimeLineKind;
  /** HOURS for the three hourly legs; DAYS of ordinary rate of pay for the two base-day legs. */
  qty: number;
  unit: 'hours' | 'days';
  /** What ONE unit was paid at. Exact, not rounded — see the type's header. */
  rate: number;
  /** `round2(qty × rate)`. */
  amount: number;
};

export type OvertimePayResult = {
  eligible: boolean;
  orp: number;
  hourly: number;
  workday: number;
  restDay: number;
  holiday: number;
  total: number;
  /** a96d320c — the legs behind `total`. Empty when the employee is not entitled (no OT was computed).
   *  ADDITIVE: every caller that only reads the totals is untouched. */
  lines: OvertimeLine[];
};

/** Monetize a month of classified OT minutes (one entry per day — the rest-day ½/1-day
 *  rule is per day, so aggregates would be wrong). `monthlyWages` is s.2 wages ex-OT/bonus. */
export function overtimePay(p: {
  monthlyWages: number;
  days: OtDay[];
  normalDailyHours?: number;
  /** Statutory OT entitlement ceiling (ADR-0019); defaults to the EA First Schedule RM4,000. */
  wageCeiling?: number;
  /** Rest-day EXCESS-hours factor (s.60(3)(c)); configurable via the ot ruleset. Default EA 2×. */
  restDayExcessMultiplier?: number;
  /** Public-holiday EXCESS-hours factor (s.60D(3)(aa)); configurable via the ot ruleset. Default EA 3×. */
  holidayExcessMultiplier?: number;
}): OvertimePayResult {
  const hoursPerDay = p.normalDailyHours ?? 8;
  const orp = round2(p.monthlyWages / 26);
  const hourly = round2(orp / hoursPerDay);
  const eligible = p.monthlyWages <= (p.wageCeiling ?? MY_OT_WAGE_CEILING);
  const out: OvertimePayResult = { eligible, orp, hourly, workday: 0, restDay: 0, holiday: 0, total: 0, lines: [] };
  if (!eligible) return out;
  // The two EXCESS-hours factors are HR-configurable (ADR-0019 ot ruleset); the workday 1.5× and the base-day
  // legs (rest-day ½/1-day ORP, holiday 2-days ORP) are EA-fixed and stay literal.
  const restExcess = p.restDayExcessMultiplier ?? 2;
  const holidayExcess = p.holidayExcessMultiplier ?? 3;
  const normalMin = hoursPerDay * 60;
  // a96d320c — the QUANTITIES, accumulated alongside the money they produce. Every `+=` below sits beside
  // the `out.*` line it belongs to, deliberately: an accumulator added anywhere else is how a quantity and
  // an amount start describing different days. Nothing here feeds `out.total`.
  let workdayHours = 0;
  let restOrpDays = 0;
  let restExcessHours = 0;
  let holidayOrpDays = 0;
  let holidayExcessHours = 0;
  for (const d of p.days) {
    const m = Math.max(0, d.minutes);
    if (m === 0) continue;
    if (d.dayType === 'workday') {
      out.workday += (m / 60) * 1.5 * hourly;
      workdayHours += m / 60;
    } else if (d.dayType === 'rest_day') {
      const within = Math.min(m, normalMin);
      out.restDay += within <= normalMin / 2 ? 0.5 * orp : orp;
      restOrpDays += within <= normalMin / 2 ? 0.5 : 1;
      out.restDay += (Math.max(0, m - normalMin) / 60) * restExcess * hourly;
      restExcessHours += Math.max(0, m - normalMin) / 60;
    } else {
      out.holiday += 2 * orp;
      holidayOrpDays += 2;
      out.holiday += (Math.max(0, m - normalMin) / 60) * holidayExcess * hourly;
      holidayExcessHours += Math.max(0, m - normalMin) / 60;
    }
  }
  out.workday = round2(out.workday);
  out.restDay = round2(out.restDay);
  out.holiday = round2(out.holiday);
  out.total = round2(out.workday + out.restDay + out.holiday);
  const leg = (kind: OvertimeLineKind, qty: number, unit: 'hours' | 'days', rate: number) => {
    const q = round2(qty);
    if (q <= 0) return;
    out.lines.push({ kind, qty: q, unit, rate, amount: round2(q * rate) });
  };
  leg('workday', workdayHours, 'hours', 1.5 * hourly);
  leg('rest_day', restOrpDays, 'days', orp);
  leg('rest_day_excess', restExcessHours, 'hours', restExcess * hourly);
  leg('holiday', holidayOrpDays, 'days', orp);
  leg('holiday_excess', holidayExcessHours, 'hours', holidayExcess * hourly);
  return out;
}
