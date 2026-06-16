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
  MY_OT_WAGE_CEILING,
  type ContribBand,
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

export type TaxProfile = { category?: TaxCategory; children?: number };

/**
 * EPF: employee 11%; employer 13% (wage ≤ RM5000) or 12% (> RM5000). Each rounded up to RM1.
 * A bonus (`additional`) is subject to EPF too: KWSP fixes the employer rate by the NORMAL monthly
 * wage — a ≤RM5000 earner stays at 13% even when the bonus pushes the month over — then applies it
 * to the full wage incl. the bonus.
 */
export function epf(wage: number, additional = 0, cfg: StatutoryRuleset['epf'] = DEFAULT_MY_STATUTORY.epf) {
  const employerRate = wage <= cfg.employerThreshold ? cfg.employerRateLow : cfg.employerRateHigh;
  const base = wage + Math.max(0, additional);
  return {
    employee: ceilRinggit(base * cfg.employeeRate),
    employer: ceilRinggit(base * employerRate),
  };
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
  const band = bandFor(category === 2 ? cfg.category2 : cfg.category1, wage);
  return { employer: band.employer, employee: band.employee };
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
  /** Audit snapshot stamped into the payslip (reproducibility, ADR-0006). */
  snapshot: {
    month: number;
    n: number;
    ytdNet: number;
    epfClaimed: number;
    pcbPaid: number;
    P1: number;
    P2?: number;
  };
};

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
  const reliefs =
    pcb.reliefs.individual + (category === 2 ? pcb.reliefs.spouse : 0) + children * pcb.reliefs.perChild;
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
    snapshot: {
      month,
      n,
      ytdNet: round2(acc.netRemuneration),
      epfClaimed: round2(K),
      pcbPaid: round2(X),
      P1,
      ...(P2 !== undefined ? { P2 } : {}),
    },
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
   *  EIS eligibility (false at 60+, or the profile flag), residency (non-residents: flat 30%). */
  opts?: { socsoCategory?: 1 | 2; eisEligible?: boolean; resident?: boolean },
  /** The active statutory ruleset (ADR-0019); defaults to the verified built-in set. */
  rules: StatutoryRuleset = DEFAULT_MY_STATUTORY,
) {
  const cashWage = round2(wage + Math.max(0, overtime)); // wages incl. OT (SOCSO/EIS/PCB base)
  const e = epf(wage, additional, rules.epf); // bonus IS subject to EPF; overtime is NOT
  const s = socso(cashWage, opts?.socsoCategory ?? 1, rules.socso); // bonus excluded; overtime included
  const eisOn = opts?.eisEligible ?? true;
  const i = eisOn ? eis(cashWage, rules.eis) : { employer: 0, employee: 0 }; // bonus excluded; OT included
  // EPF relief split: the employee share on the bonus (Kₜ) is the rate on the bonus alone; the
  // remainder of the month's actual EPF belongs to normal remuneration (K₁).
  const epfOnBonus = additional > 0 ? ceilRinggit(additional * rules.epf.employeeRate) : 0;
  if (opts?.resident === false) {
    // Non-resident MTD (spec §D.a): flat 30% of taxable remuneration, no reliefs/accumulators.
    const pcbAll = rm10Floor(ceil5sen(trunc2((cashWage + additional) * 0.3)));
    const pcbBonusOnly = rm10Floor(ceil5sen(trunc2(additional * 0.3)));
    return {
      epfEmployee: e.employee,
      epfEmployer: e.employer,
      socsoEmployee: s.employee,
      socsoEmployer: s.employer,
      eisEmployee: i.employee,
      eisEmployer: i.employer,
      pcb: pcbAll,
      pcbBonus: Math.min(pcbBonusOnly, pcbAll),
      pcbMeta: { nonResident: true as const, rate: 0.3 },
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
    eisEmployee: i.employee,
    eisEmployer: i.employer,
    pcb: m.total,
    /** PCB attributable to the bonus alone (audit / payslip breakdown). */
    pcbBonus: m.additional,
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
}): OvertimePayResult {
  const hoursPerDay = p.normalDailyHours ?? 8;
  const orp = round2(p.monthlyWages / 26);
  const hourly = round2(orp / hoursPerDay);
  const eligible = p.monthlyWages <= (p.wageCeiling ?? MY_OT_WAGE_CEILING);
  const out: OvertimePayResult = { eligible, orp, hourly, workday: 0, restDay: 0, holiday: 0, total: 0 };
  if (!eligible) return out;
  const normalMin = hoursPerDay * 60;
  for (const d of p.days) {
    const m = Math.max(0, d.minutes);
    if (m === 0) continue;
    if (d.dayType === 'workday') {
      out.workday += (m / 60) * 1.5 * hourly;
    } else if (d.dayType === 'rest_day') {
      const within = Math.min(m, normalMin);
      out.restDay += within <= normalMin / 2 ? 0.5 * orp : orp;
      out.restDay += (Math.max(0, m - normalMin) / 60) * 2 * hourly;
    } else {
      out.holiday += 2 * orp;
      out.holiday += (Math.max(0, m - normalMin) / 60) * 3 * hourly;
    }
  }
  out.workday = round2(out.workday);
  out.restDay = round2(out.restDay);
  out.holiday = round2(out.holiday);
  out.total = round2(out.workday + out.restDay + out.holiday);
  return out;
}
