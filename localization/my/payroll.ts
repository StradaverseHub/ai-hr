/**
 * Malaysia statutory payroll calculators (MY localization pack, ADR-0008).
 *
 * Figures come from localization/my/statutory-tables.ts (each sourced + dated + verify-flagged).
 * Provenance and the human sign-off checklist: docs/architecture/STATUTORY-SOURCES.md.
 *
 * Accuracy posture:
 *  - PCB/MTD  — implements the official LHDN 2026 computerised-calculation formula for a RESIDENT
 *               employee, NORMAL remuneration. Steady-state monthly = annual tax / 12 (correct for
 *               constant monthly income with no prior-month accumulators; bonuses / mid-year changes
 *               need the full (n+1, X) spread — a documented follow-up).
 *  - EPF      — statutory % with round-up to the next ringgit (Third Schedule convention).
 *  - SOCSO    — official band table for wages ≤ RM5000; statutory % for the RM5000–6000 ceiling band
 *               (UNVERIFIED — see sources doc).
 *  - EIS      — statutory % on the capped wage (exact Act 800 band table not yet encoded).
 */
import {
  MY_CONTRIB_CEILING,
  MY_EIS_RATES,
  MY_EPF,
  MY_PCB_BANDS,
  MY_RELIEFS,
  MY_SOCSO_CATEGORY1,
  MY_SOCSO_RATES,
  MY_SOCSO_VERIFIED_UP_TO,
  MY_STATUTORY_VERSION,
  type TaxCategory,
} from './statutory-tables';

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Round a contribution up to the next whole ringgit (KWSP Third Schedule convention). */
const ceilRinggit = (n: number) => Math.ceil(n);

export type TaxProfile = { category?: TaxCategory; children?: number };

/**
 * EPF: employee 11%; employer 13% (wage ≤ RM5000) or 12% (> RM5000). Each rounded up to RM1.
 * A bonus (`additional`) is subject to EPF too: KWSP fixes the employer rate by the NORMAL monthly
 * wage — a ≤RM5000 earner stays at 13% even when the bonus pushes the month over — then applies it
 * to the full wage incl. the bonus.
 */
export function epf(wage: number, additional = 0) {
  const employerRate = wage <= MY_EPF.employerThreshold ? MY_EPF.employerRateLow : MY_EPF.employerRateHigh;
  const base = wage + Math.max(0, additional);
  return {
    employee: ceilRinggit(base * MY_EPF.employeeRate),
    employer: ceilRinggit(base * employerRate),
  };
}

/** SOCSO First Category: official band amounts ≤ RM5000, statutory % up to the RM6000 ceiling. */
export function socso(wage: number) {
  if (wage <= MY_SOCSO_VERIFIED_UP_TO) {
    const band = MY_SOCSO_CATEGORY1.find((b) => wage <= b.upTo) ?? MY_SOCSO_CATEGORY1[0];
    return { employer: band.employer, employee: band.employee };
  }
  const w = Math.min(wage, MY_CONTRIB_CEILING);
  return { employer: round2(w * MY_SOCSO_RATES.employer), employee: round2(w * MY_SOCSO_RATES.employee) };
}

/** EIS: 0.2% employer / 0.2% employee on the wage, capped at the RM6000 ceiling. */
export function eis(wage: number) {
  const w = Math.min(wage, MY_CONTRIB_CEILING);
  return { employer: round2(w * MY_EIS_RATES.employer), employee: round2(w * MY_EIS_RATES.employee) };
}

/** Annual chargeable income P = annual income − reliefs (individual, spouse for Cat 2, children, EPF capped). */
function chargeableIncome(
  annualIncome: number,
  category: TaxCategory,
  children: number,
  annualEpf: number,
): number {
  const reliefs =
    MY_RELIEFS.individual +
    (category === 2 ? MY_RELIEFS.spouse : 0) +
    children * MY_RELIEFS.perChild +
    Math.min(annualEpf, MY_RELIEFS.epfReliefCap);
  return annualIncome - reliefs;
}

/** Annual tax on chargeable income P: the (M, R, B) band that contains P; category selects B. */
function annualTaxFor(P: number, category: TaxCategory): number {
  if (P <= 5000) return 0;
  const band = MY_PCB_BANDS.find((b) => P <= b.upTo) ?? MY_PCB_BANDS[MY_PCB_BANDS.length - 1];
  const B = category === 2 ? band.bCat2 : band.bCat13;
  return Math.max(0, (P - band.M) * band.R + B);
}

/**
 * PCB/MTD — LHDN 2026 computerised calculation (resident, normal remuneration).
 * Projects annual chargeable income P, looks up the (M, R, B) band, and spreads the annual
 * tax evenly across 12 months. `monthlyEpf` defaults to the employee EPF for relief purposes.
 */
export function pcb(monthlyGross: number, opts?: TaxProfile & { monthlyEpf?: number }): number {
  const category: TaxCategory = opts?.category ?? 1;
  const children = opts?.children ?? 0;
  const monthlyEpf = opts?.monthlyEpf ?? ceilRinggit(monthlyGross * MY_EPF.employeeRate);
  const P = chargeableIncome(monthlyGross * 12, category, children, monthlyEpf * 12);
  return round2(annualTaxFor(P, category) / 12);
}

/**
 * PCB on additional remuneration (bonus) — LHDN difference method: the bonus's MTD is the extra
 * ANNUAL tax it creates — tax on (annual chargeable incl. bonus) minus tax on (annual chargeable
 * excl. bonus) — taken in the bonus month. The bonus carries its own 11% EPF relief (pooled with
 * the normal EPF under the same cap). Same simplified, no-prior-accumulator model as pcb() above.
 */
export function pcbAdditional(
  monthlyGross: number,
  additional: number,
  opts?: TaxProfile & { monthlyEpf?: number },
): number {
  if (additional <= 0) return 0;
  const category: TaxCategory = opts?.category ?? 1;
  const children = opts?.children ?? 0;
  const monthlyEpf = opts?.monthlyEpf ?? ceilRinggit(monthlyGross * MY_EPF.employeeRate);
  const epfOnBonus = ceilRinggit(additional * MY_EPF.employeeRate);
  const P0 = chargeableIncome(monthlyGross * 12, category, children, monthlyEpf * 12);
  const P1 = chargeableIncome(monthlyGross * 12 + additional, category, children, monthlyEpf * 12 + epfOnBonus);
  return Math.max(0, round2(annualTaxFor(P1, category) - annualTaxFor(P0, category)));
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
export function statutory(wage: number, profile?: TaxProfile, additional = 0, overtime = 0) {
  const cashWage = round2(wage + Math.max(0, overtime)); // wages incl. OT (SOCSO/EIS/PCB base)
  const e = epf(wage, additional); // bonus IS subject to EPF; overtime is NOT
  const s = socso(cashWage); // bonus excluded from SOCSO; overtime included
  const i = eis(cashWage); // bonus excluded from EIS; overtime included
  const pcbNormal = pcb(cashWage, { category: profile?.category, children: profile?.children });
  const pcbBonus = pcbAdditional(cashWage, additional, { category: profile?.category, children: profile?.children });
  return {
    epfEmployee: e.employee,
    epfEmployer: e.employer,
    socsoEmployee: s.employee,
    socsoEmployer: s.employer,
    eisEmployee: i.employee,
    eisEmployer: i.employer,
    pcb: round2(pcbNormal + pcbBonus),
    /** PCB attributable to the bonus alone (audit / payslip breakdown). */
    pcbBonus,
    /** Statutory-table version that produced these figures (audit / reproducibility). */
    version: MY_STATUTORY_VERSION,
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
export const MY_OT_WAGE_CEILING = 4000;

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
}): OvertimePayResult {
  const hoursPerDay = p.normalDailyHours ?? 8;
  const orp = round2(p.monthlyWages / 26);
  const hourly = round2(orp / hoursPerDay);
  const eligible = p.monthlyWages <= MY_OT_WAGE_CEILING;
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
