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
 */
export type EpfMode = 'auto' | 'voluntary_excess' | 'exempt';
export type EpfElection = { mode: EpfMode; employeeRate?: number | null; employerRate?: number | null };

/**
 * Effective EPF rates for a wage given an election, enforcing the statutory FLOOR: an elected rate
 * is `max(elected, statutory)` so i-Topup can only raise it. 'exempt' is 0/0. The statutory employer
 * rate is wage-banded (13% ≤ threshold, else 12%).
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
 * EPF. The contribution on the NORMAL monthly wage is the exact EPF Act 1991 **Third Schedule Part A**
 * band amount (≤ RM20,000; #95) — not a flat percentage of the exact wage — or, above RM20,000 where the
 * schedule ends, the exact percentage rounded up to RM1 (employee 11%, employer 12%). A bonus
 * (`additional`) is **additional remuneration**: KWSP fixes the employer rate by the NORMAL monthly wage
 * (a ≤RM5,000 earner stays 13% even when the bonus pushes the month over) and applies the percentage to
 * the bonus, rounded up to RM1 on its own. An `election` can RAISE a side above the statutory floor
 * (i-Topup) or `exempt` the employee (0/0). The normal-wage statutory floor here matches the existing
 * `epfOnBonus` split in `statutory()` (so `employee − epfOnBonus` is exactly the schedule wage-amount).
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
  const statEmployerRate = wage <= cfg.employerThreshold ? cfg.employerRateLow : cfg.employerRateHigh;

  // Statutory floor on the normal monthly wage: exact Third Schedule band (incl. the NIL first band),
  // or the percentage rounded up where the schedule ends (> RM20,000).
  const band = wage <= scheduleMax ? bandFor(partA, wage) : null;
  let wageEmployee = band ? band.employee : ceilRinggit(wage * cfg.employeeRate);
  let wageEmployer = band ? band.employer : ceilRinggit(wage * statEmployerRate);

  // i-Topup / voluntary excess can only RAISE a side above the statutory floor.
  if ((election?.mode ?? 'auto') === 'voluntary_excess') {
    if (election?.employeeRate != null) wageEmployee = Math.max(wageEmployee, ceilRinggit(wage * election.employeeRate));
    if (election?.employerRate != null) wageEmployer = Math.max(wageEmployer, ceilRinggit(wage * election.employerRate));
  }

  // Additional remuneration (bonus): percentage by the resolved rate (employer rate fixed by the normal
  // wage band), each rounded up to RM1 on its own.
  const bonus = Math.max(0, additional);
  const { employeeRate: rEe, employerRate: rEr } = resolveEpfRates(wage, cfg, election);
  return {
    employee: wageEmployee + (bonus > 0 ? ceilRinggit(bonus * rEe) : 0),
    employer: wageEmployer + (bonus > 0 ? ceilRinggit(bonus * rEr) : 0),
  };
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

  // Citizen / PR < 60: standard Part A.
  const e = epf(wage, additional, cfg, election);
  const { employeeRate } = resolveEpfRates(wage, cfg, election);
  return { employee: e.employee, employer: e.employer, employeeOnBonus: bonus > 0 ? ceilRinggit(bonus * employeeRate) : 0 };
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
 *  Negative B encodes the RM400/RM800 rebate; tax floors at 0 (spec: P ≤ 5,000 → no tax). */
function annualTaxFor(P: number, category: TaxCategory, bands: PcbBand[]): number {
  if (P <= 5000) return 0;
  if (!bands || bands.length === 0) throw new StatutoryRulesetMalformedError('Statutory PCB band table is empty');
  const band = bands.find((b) => P <= b.upTo) ?? bands[bands.length - 1];
  const B = category === 2 ? band.bCat2 : band.bCat13;
  return Math.max(0, (P - band.M) * band.R + B);
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
};

export const PCB_ZERO_ACC: PcbAccumulators = { netRemuneration: 0, epfClaimed: 0, pcbPaid: 0 };

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
 */
export function applyZakatOffset(
  normalCalc: number,
  additionalCalc: number,
  zakatCurrent: number,
): { normal: number; additional: number } {
  const A = rm10Floor(normalCalc);
  const E = rm10Floor(additionalCalc);
  const z = Math.max(0, zakatCurrent);
  const normal = Math.max(0, round2(A - z));
  const leftover = Math.max(0, round2(z - A));
  const additional = Math.max(0, round2(E - leftover));
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
  if (!table || typeof table !== 'object' || Array.isArray(table)) return 0;
  const amounts = reliefs?.childByCategory ?? DEFAULT_MY_STATUTORY.pcb.reliefs.childByCategory ?? {};
  let total = 0;
  for (const [key, cell] of Object.entries(table as Record<string, unknown>)) {
    const amount = amounts[key];
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    if (!cell || typeof cell !== 'object') continue;
    const c = cell as { full?: unknown; half?: unknown };
    const full = typeof c.full === 'number' && Number.isFinite(c.full) ? Math.max(0, Math.floor(c.full)) : 0;
    const half = typeof c.half === 'number' && Number.isFinite(c.half) ? Math.max(0, Math.floor(c.half)) : 0;
    total += full * amount + half * (amount / 2);
  }
  return total;
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
  const mtdNormalCalc = ceil5sen(trunc2(Math.max(0, (annualTaxFor(P1, category, pcb.bands) - (Z + X)) / (n + 1))));

  // Steps 2–4 — additional remuneration via the year-total difference.
  const Yt = Math.max(0, p.additional ?? 0);
  let additionalCalc = 0;
  let P2: number | undefined;
  if (Yt > 0) {
    const Kt = Math.min(p.epfOnAdditional ?? 0, Math.max(0, cap - K - K1));
    const K2a = n > 0 ? trunc2(Math.min((cap - K - K1 - Kt) / n, K1)) : 0;
    P2 = trunc2(acc.netRemuneration + (Y1 - K1) + (Y1 - K2a) * n + (Yt - Kt) - reliefs - lp);
    const totalTaxYear = annualTaxFor(P2, category, pcb.bands); // Step 3
    const totalMtdYear = X + mtdNormalCalc * (n + 1); // Step 1[E]
    additionalCalc = ceil5sen(trunc2(Math.max(0, totalTaxYear - totalMtdYear + Z))); // Step 4
  }

  // §E.5: current-month zakat offsets normal first, remainder offsets additional.
  const { normal, additional } = applyZakatOffset(mtdNormalCalc, additionalCalc, p.zakatCurrent ?? 0);
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
): { combinedMtd: number; combinedAdditional: number; byEmployment: Map<string, { pcb: number; pcbBonus: number }> } {
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
  },
  /** The active statutory ruleset (ADR-0019); defaults to the verified built-in set. */
  rules: StatutoryRuleset = DEFAULT_MY_STATUTORY,
) {
  const cashWage = round2(wage + Math.max(0, overtime)); // wages incl. OT (SOCSO/EIS/PCB base)
  // EPF by age + citizenship (Part A / Part E senior / non-citizen 2%/2%; #95). Bonus IS subject to
  // EPF; overtime is NOT.
  const eC = epfContribution(wage, additional, rules.epf, opts?.epfElection, {
    age: opts?.epfAge,
    citizenship: opts?.epfCitizenship,
  });
  const e = { employee: eC.employee, employer: eC.employer };
  const sRaw = socso(cashWage, opts?.socsoCategory ?? 1, rules.socso); // bonus excluded; overtime included
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
  const i = eisOn ? eis(cashWage, rules.eis) : { employer: 0, employee: 0 }; // bonus excluded; OT included
  // EPF relief split: the employee share on the bonus (Kₜ) — 0 for seniors (Part E) and the flat
  // non-citizen rate; for citizens < 60 it is the effective (incl. i-Topup) employee rate on the bonus.
  const epfOnBonus = eC.employeeOnBonus;
  // Item 8b5334db — resolve the flat PCB rate: an explicit flatTaxRate wins (REP/Knowledge Worker = 0.15,
  // non_resident = 0.30); otherwise fall back to the legacy resident=false ⇒ 0.30 branch. A resident (null
  // rate, resident !== false) takes the full computerised-MTD path below. This keeps every existing caller
  // byte-identical: resident:false with no flatTaxRate still yields exactly 0.30.
  const flatRate = opts?.flatTaxRate != null ? opts.flatTaxRate : opts?.resident === false ? 0.3 : null;
  if (flatRate != null) {
    // Flat-rate MTD (spec §D.a for non-residents; the REP/Knowledge-Worker incentive schemes use the same
    // shape at 15%): flat % of taxable remuneration, no reliefs / accumulators.
    const pcbAll = rm10Floor(ceil5sen(trunc2((cashWage + additional) * flatRate)));
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
      pcbMeta: { nonResident: flatRate === 0.3, flatRate, rate: flatRate },
      version: rules.version,
    };
  }
  const m = pcbMonth({
    monthlyWage: cashWage,
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

export type OvertimePayResult = {
  eligible: boolean;
  orp: number;
  hourly: number;
  workday: number;
  restDay: number;
  holiday: number;
  total: number;
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
  const out: OvertimePayResult = { eligible, orp, hourly, workday: 0, restDay: 0, holiday: 0, total: 0 };
  if (!eligible) return out;
  // The two EXCESS-hours factors are HR-configurable (ADR-0019 ot ruleset); the workday 1.5× and the base-day
  // legs (rest-day ½/1-day ORP, holiday 2-days ORP) are EA-fixed and stay literal.
  const restExcess = p.restDayExcessMultiplier ?? 2;
  const holidayExcess = p.holidayExcessMultiplier ?? 3;
  const normalMin = hoursPerDay * 60;
  for (const d of p.days) {
    const m = Math.max(0, d.minutes);
    if (m === 0) continue;
    if (d.dayType === 'workday') {
      out.workday += (m / 60) * 1.5 * hourly;
    } else if (d.dayType === 'rest_day') {
      const within = Math.min(m, normalMin);
      out.restDay += within <= normalMin / 2 ? 0.5 * orp : orp;
      out.restDay += (Math.max(0, m - normalMin) / 60) * restExcess * hourly;
    } else {
      out.holiday += 2 * orp;
      out.holiday += (Math.max(0, m - normalMin) / 60) * holidayExcess * hourly;
    }
  }
  out.workday = round2(out.workday);
  out.restDay = round2(out.restDay);
  out.holiday = round2(out.holiday);
  out.total = round2(out.workday + out.restDay + out.holiday);
  return out;
}
