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

/** EPF: employee 11%; employer 13% (wage ≤ RM5000) or 12% (> RM5000). Each rounded up to RM1. */
export function epf(wage: number) {
  const employerRate = wage <= MY_EPF.employerThreshold ? MY_EPF.employerRateLow : MY_EPF.employerRateHigh;
  return {
    employee: ceilRinggit(wage * MY_EPF.employeeRate),
    employer: ceilRinggit(wage * employerRate),
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

/**
 * PCB/MTD — LHDN 2026 computerised calculation (resident, normal remuneration).
 * Projects annual chargeable income P, looks up the (M, R, B) band, and spreads the annual
 * tax evenly across 12 months. `monthlyEpf` defaults to the employee EPF for relief purposes.
 */
export function pcb(monthlyGross: number, opts?: TaxProfile & { monthlyEpf?: number }): number {
  const category: TaxCategory = opts?.category ?? 1;
  const children = opts?.children ?? 0;
  const monthlyEpf = opts?.monthlyEpf ?? ceilRinggit(monthlyGross * MY_EPF.employeeRate);

  const annualEpfRelief = Math.min(monthlyEpf * 12, MY_RELIEFS.epfReliefCap);
  const reliefs =
    MY_RELIEFS.individual +
    (category === 2 ? MY_RELIEFS.spouse : 0) +
    children * MY_RELIEFS.perChild +
    annualEpfRelief;

  const P = monthlyGross * 12 - reliefs; // projected annual chargeable income
  if (P <= 5000) return 0;

  const band = MY_PCB_BANDS.find((b) => P <= b.upTo) ?? MY_PCB_BANDS[MY_PCB_BANDS.length - 1];
  const B = category === 2 ? band.bCat2 : band.bCat13;
  const annualTax = (P - band.M) * band.R + B;
  return Math.max(0, round2(annualTax / 12));
}

/** All statutory contributions for a monthly wage. `profile` defaults to Category 1 (single). */
export function statutory(wage: number, profile?: TaxProfile) {
  const e = epf(wage);
  const s = socso(wage);
  const i = eis(wage);
  return {
    epfEmployee: e.employee,
    epfEmployer: e.employer,
    socsoEmployee: s.employee,
    socsoEmployer: s.employer,
    eisEmployee: i.employee,
    eisEmployer: i.employer,
    pcb: pcb(wage, { category: profile?.category, children: profile?.children, monthlyEpf: e.employee }),
    /** Statutory-table version that produced these figures (audit / reproducibility). */
    version: MY_STATUTORY_VERSION,
  };
}
