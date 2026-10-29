/**
 * b6dbadc5 — THE ONE-OFF CONVERSION OF PRE-ADDITIVE TOP-UP ELECTIONS, as pure arithmetic (no db imports).
 *
 * Before b6dbadc5 a Top-up (existing percentage election) row was `voluntary_excess` holding TOTAL per-side
 * rates, paid as max(total, statutory). It is now `topup_percentage` holding INCREMENTS, paid as
 * statutory + increment (localization/my/payroll.ts `topupRate`). A row keeps paying exactly what it pays
 * today when increment = max(0, total − statutory) for the statutory rate of the rule and wage band that
 * applied to it, because statutory + max(0, total − statutory) = max(total, statutory) — the old formula,
 * term for term, inside the same whole-ringgit round-up.
 *
 * WHICH STATUTORY RATE. The rule the employee's latest processed regular payslip was charged under (its
 * combined EPF base, the employee's age at that period end, their EPF citizenship), or the rule for their
 * current salary when no such payslip exists. Where the OLD election had no effect at all — Part E
 * (citizen 60–<75), which never read `voluntary_excess`, and age 75+ — the increment is 0, so the result
 * is unchanged there too.
 *
 * WHAT IS NOT GUARANTEED, and is why HR gets the CSV: equality holds at the wage band the increment was
 * derived from. If the combined wage later crosses the RM5,000 employer step, the employer side pays the new
 * step's statutory rate + the increment, not the old total (e.g. a stored 13% employer total at RM4,800 is a
 * 0% top-up; at RM5,200 it pays 12%, where the old row paid 13%).
 *
 * The database side (candidates, basis, the audited write) is ./epf-topup-conversion-db.ts; the operator
 * entry point is scripts/convert-epf-topup-percentage.ts.
 */
import { DEFAULT_MY_STATUTORY, EPF_NO_CONTRIB_AGE, EPF_SENIOR_AGE, type StatutoryRuleset } from './statutory-tables';
import type { EpfCitizenship } from './payroll';

type EpfConfig = StatutoryRuleset['epf'];

/** The Third Schedule rule a month falls under, as `epfContribution` selects it. */
export type EpfStatutoryRule = 'part_a' | 'flat' | 'part_e' | 'none';

/** The statutory per-side rates of the rule `epfContribution` would apply to this base, age and citizenship. */
export function epfStatutoryRule(
  base: number,
  sel: { age: number | null; citizenship: EpfCitizenship },
  cfg: EpfConfig = DEFAULT_MY_STATUTORY.epf,
): { rule: EpfStatutoryRule; employeeRate: number; employerRate: number } {
  const age = sel.age;
  if (age != null && age >= EPF_NO_CONTRIB_AGE) return { rule: 'none', employeeRate: 0, employerRate: 0 };
  const senior = age != null && age >= EPF_SENIOR_AGE;
  if (sel.citizenship === 'non_citizen' || (sel.citizenship === 'pr' && senior))
    return { rule: 'flat', employeeRate: cfg.nonCitizenEmployeeRate ?? 0.02, employerRate: cfg.nonCitizenEmployerRate ?? 0.02 };
  if (sel.citizenship === 'citizen' && senior) return { rule: 'part_e', employeeRate: 0, employerRate: cfg.seniorEmployerRate ?? 0.04 };
  return {
    rule: 'part_a',
    employeeRate: cfg.employeeRate,
    employerRate: base <= cfg.employerThreshold ? cfg.employerRateLow : cfg.employerRateHigh,
  };
}

/** Where the statutory rate was read from. `payslip` names its period; `current_salary` is the fallback. */
export type LegacyTopupBasis = {
  source: 'payslip' | 'current_salary';
  payPeriod: string | null;
  /** The combined monthly EPF base (normal wage + additional remuneration) the rule is resolved on. */
  base: number;
  age: number | null;
  citizenship: EpfCitizenship;
};

export type LegacyTopupPlan = {
  action: 'convert' | 'skip';
  /** Why a row is skipped, or a note HR should read on a converted row; null when there is nothing to say. */
  note: 'no_basis' | 'election_had_no_effect' | null;
  rule: EpfStatutoryRule | null;
  statutoryEmployeeRate: number | null;
  statutoryEmployerRate: number | null;
  /** The new per-side increments; null where the stored side was null (that side keeps adding nothing). */
  employeeTopup: number | null;
  employerTopup: number | null;
};

const bp = (rate: number) => Math.round(rate * 10000);
const increment = (stored: number | null, statutory: number) => (stored == null ? null : Math.max(0, bp(stored) - bp(statutory)) / 10000);

/**
 * The conversion of ONE stored legacy row. `stored` rates are the TOTAL fractions on the row (null = that
 * side stayed statutory). With no basis at all the row is skipped and reported, never guessed.
 */
export function planLegacyTopupConversion(
  stored: { employeeRate: number | null; employerRate: number | null },
  basis: LegacyTopupBasis | null,
  cfg: EpfConfig = DEFAULT_MY_STATUTORY.epf,
): LegacyTopupPlan {
  if (!basis)
    return { action: 'skip', note: 'no_basis', rule: null, statutoryEmployeeRate: null, statutoryEmployerRate: null, employeeTopup: null, employerTopup: null };
  const applied = epfStatutoryRule(basis.base, basis, cfg);
  // Part E never read a voluntary_excess election and from 75 there is no contribution: the old row paid
  // statutory, so the faithful top-up is 0.
  if (applied.rule === 'part_e' || applied.rule === 'none')
    return {
      action: 'convert',
      note: 'election_had_no_effect',
      rule: applied.rule,
      statutoryEmployeeRate: applied.employeeRate,
      statutoryEmployerRate: applied.employerRate,
      employeeTopup: stored.employeeRate == null ? null : 0,
      employerTopup: stored.employerRate == null ? null : 0,
    };
  return {
    action: 'convert',
    note: null,
    rule: applied.rule,
    statutoryEmployeeRate: applied.employeeRate,
    statutoryEmployerRate: applied.employerRate,
    employeeTopup: increment(stored.employeeRate, applied.employeeRate),
    employerTopup: increment(stored.employerRate, applied.employerRate),
  };
}

/** One line of the HR review file. Rates are fractions here; the CSV prints percent. */
export type LegacyTopupReportRow = {
  status: 'converted' | 'would_convert' | 'skipped' | 'changed_since_read' | 'draft_review';
  employeeCode: string | null;
  name: string | null;
  personId: string | null;
  draftId?: string | null;
  basis: LegacyTopupBasis | null;
  oldEmployeeRate: number | null;
  oldEmployerRate: number | null;
  plan: LegacyTopupPlan | null;
};

const pct = (rate: number | null | undefined) => (rate == null ? '' : String(Number((rate * 100).toFixed(2))));
const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export const LEGACY_TOPUP_CSV_HEADER = [
  'status', 'employee_code', 'name', 'person_id', 'draft_id', 'basis', 'basis_period', 'epf_base_rm', 'age', 'epf_citizenship', 'rule',
  'old_mode', 'old_employee_rate_pct', 'old_employer_rate_pct', 'statutory_employee_rate_pct', 'statutory_employer_rate_pct',
  'new_mode', 'new_topup_employee_pct', 'new_topup_employer_pct', 'resulting_employee_rate_pct', 'resulting_employer_rate_pct', 'note',
] as const;

/** The old/new review file for HR: one row per candidate, every rate in percent. */
export function legacyTopupConversionCsv(rows: readonly LegacyTopupReportRow[]): string {
  const lines = [LEGACY_TOPUP_CSV_HEADER.join(',')];
  for (const r of rows) {
    const p = r.plan;
    const resulting = (statutory: number | null | undefined, topup: number | null | undefined) =>
      statutory == null ? '' : pct(Math.min(10000, bp(statutory) + bp(topup ?? 0)) / 10000);
    const converted = p?.action === 'convert' && r.status !== 'draft_review';
    lines.push([
      r.status, r.employeeCode ?? '', r.name ?? '', r.personId ?? '', r.draftId ?? '',
      r.basis?.source ?? '', r.basis?.payPeriod ?? '', r.basis ? r.basis.base.toFixed(2) : '', r.basis?.age == null ? '' : String(r.basis.age),
      r.basis?.citizenship ?? '', p?.rule ?? '',
      r.status === 'draft_review' ? 'draft' : 'voluntary_excess', pct(r.oldEmployeeRate), pct(r.oldEmployerRate),
      pct(p?.statutoryEmployeeRate), pct(p?.statutoryEmployerRate),
      converted ? 'topup_percentage' : '', converted ? pct(p?.employeeTopup) : '', converted ? pct(p?.employerTopup) : '',
      converted ? resulting(p?.statutoryEmployeeRate, p?.employeeTopup) : '', converted ? resulting(p?.statutoryEmployerRate, p?.employerTopup) : '',
      r.status === 'draft_review' ? 'draft_full_rates_reenter_as_topup' : p?.note ?? '',
    ].map(v => cell(String(v))).join(','));
  }
  return lines.join('\n') + '\n';
}

/** Age in whole years on `onDate` (YYYY-MM-DD), the way the payroll kernel's `ageAt` counts it; null without a DOB. */
export function epfAgeOn(dateOfBirth: string | null | undefined, onDate: string): number | null {
  if (!dateOfBirth) return null;
  const d = new Date(`${dateOfBirth}T00:00:00Z`), ref = new Date(`${onDate}T00:00:00Z`);
  let age = ref.getUTCFullYear() - d.getUTCFullYear();
  if (ref.getUTCMonth() < d.getUTCMonth() || (ref.getUTCMonth() === d.getUTCMonth() && ref.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

/** `YYYY-MM` → its last day (the period end the kernel measures age at). */
export function payPeriodEnd(payPeriod: string): string {
  const [y, m] = payPeriod.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
