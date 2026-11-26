/**
 * Board 4ce2c481 — INCOME-TAX HISTORY FOLLOWS THE EMPLOYEE ACROSS THE GROUP ("Automatic group TP3", owner decision of
 * 26 November 2026).
 *
 * THE DEFECT. Since 6cd6667e88e (30 October 2026) live PCB replays only the run company's own payslips. An employee
 * moved from one group company to another during the year (an Entity Transfer keeps the employment; a resignation and
 * rehire makes a new one) therefore arrived at the new company with an empty year: CHANG MEI EN's November PCB at the
 * new company was worked out from October and November only, although January to September at the old company were in
 * the system. Too little tax was taken, and nothing on the payslip said so.
 *
 * THE RULE. Earlier months of the same assessment year that OTHER companies of the tenant paid the same person, whether
 * imported history or processed payroll, enter this company's PCB exactly as a Form TP3 does: as a previous-employer
 * opening of the accumulators (Y, Σ(Y−K), K, X, Z, ∑LP), the annual exemption ledger and the BIK/VOLA accumulation. No
 * LHDN table, rate, relief or formula changes; EA/CP8A, CP39 and Form E stay per company; no payroll row is moved,
 * copied or changed. Each contributing month is folded in pay-period order beside this company's own months, through
 * the SAME pack fold (`foldPriorSlipIntoAccumulators`), so a person who moved companies pays what a person who never
 * moved would have paid (the board item's acceptance test computes that independently).
 *
 *   - A TP3 that lists a contributing group company (by its LHDN E-number or TIN) is REPLACED by the group history,
 *     never added on top. A TP3 that lists such a company together with an outside employer cannot be split (Form TP3
 *     carries one total), so the employee is held for income tax review rather than guessed.
 *   - Two jobs held at the same time stay separate (ADR-0009 section 4, ADR-0014 point 4): another employment of the
 *     person contributes only when it ended before this employment started.
 *   - A contributing month without a usable tax basis (an imported month still waiting for review, a processed month
 *     without its tax stamp) holds the employee with that month named. Never gross pay, never zero.
 *
 * WHO MAY READ WHAT. The run company's payroll administrator usually cannot read the other company's payslips. The only
 * bridge is the definer `app.payroll_group_tax_opening` (migration 7520), which returns totals per contributing company
 * and month for the run company's own employments, gated by payroll administration of the run company. No payslip,
 * line or item leaves it. The calculation therefore never depends on who presses Process.
 *
 * SCALE. One statement per processing chunk (SCALE rule 2), keyed by employment; no per-employee loop.
 */
import {eq,inArray,sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {employeeStatutoryMy, employment} from '../db/schema';
import {PayrollTaxBasisError} from '../lib/payroll-tax-basis';
import {companySegmentsForPeriodBulk,segmentForCompany} from './employment-company';
import {importedTaxRulesStatesTx} from './payroll-import-tax-source';
import type {GroupTaxMonth,GroupTaxOpening,GroupTp3Outcome} from '../lib/payroll-group-tax-stamp';
export * from '../lib/payroll-group-tax-stamp';

type Row = {
  employment_id: string; company_id: string; company_name: string; employer_numbers: string[] | null; period: string;
  source: string; slips: number; ends_on: string | Date | null; y: string; epf: string; pcb: string; zakat: string;
  zakat_rebate: string; lp: string; tp1_lp: string; exemption_used: Record<string, unknown> | null; bik: string;
  vola: string; noncash_complete: boolean; unusable: string | null; rules_receipts: unknown[] | null; tp3_numbers: string[] | null; tp3_unnumbered: number;
};
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const canonical = (v: unknown): string => JSON.stringify(v, (_key, item) => plain(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const isoDate = (v: string | Date | null) => v == null ? null : typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
const uuidArray = (ids: readonly string[]) => sql`array[${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]`;
/** The bound the definer refuses above. A processing chunk and a recalculation preview are both well below it. */
export const GROUP_TAX_OPENING_MAX = 2000;

/**
 * The first day of `payPeriod` that `runCompanyId` pays each employment for: its entity segment's start when the month
 * is split by an Entity Transfer, otherwise the later of the month start and the employment's start. Used only to
 * decide which same-month rows are a company the person LEFT before this one began (they count) and which are not.
 */
export async function groupTaxRunStartsTx(tx: Tx, runCompanyId: string, payPeriod: string, employmentIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(employmentIds)];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const [y, m] = payPeriod.split('-').map(Number);
  const start = `${payPeriod}-01`, end = `${payPeriod}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const rows = await tx.select({id: employment.id, companyId: employment.companyId, hiredOn: employment.hiredOn, joinDate: employment.joinDate})
    .from(employment).where(inArray(employment.id, ids));
  const segments = await companySegmentsForPeriodBulk(tx, ids, start, end, new Map(rows.map(r => [r.id, r.companyId])));
  for (const r of rows) {
    const mine = segmentForCompany(segments.get(r.id) ?? [], runCompanyId);
    const began = r.joinDate ?? r.hiredOn;
    out.set(r.id, [start, mine?.from ?? start, began && began > start ? began : start].sort().at(-1)!);
  }
  return out;
}

/** Strip a tax reference to letters and digits, upper case, as the definer does: "E 1234567-08" matches "E123456708". */
export const normalizeTaxNumber = (v: string) => v.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/**
 * The group opening for the run's employments, as one statement (`app.payroll_group_tax_opening`). A same-month row
 * counts only when that company's part of the month ended before this company's part began; the starts are read (two
 * set-based statements, `groupTaxRunStartsTx`) only when a same-month row exists, so a run with no transfer in the month
 * pays one statement. Without a start for an employment, same-month rows are left out.
 */
export async function groupTaxOpeningTx(tx: Tx, p: {runCompanyId: string; payPeriod: string; employmentIds: readonly string[]}): Promise<Map<string, GroupTaxOpening>> {
  const out = new Map<string, GroupTaxOpening>();
  const ids = [...new Set(p.employmentIds)];
  if (!ids.length) return out;
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += GROUP_TAX_OPENING_MAX) {
    const slice = ids.slice(i, i + GROUP_TAX_OPENING_MAX);
    rows.push(...await tx.execute<Row>(sql`select * from app.payroll_group_tax_opening(${p.runCompanyId}::uuid,${p.payPeriod},${uuidArray(slice)})`));
  }
  // An imported month's assessment-year rules receipt must still match today's rules for that month, as the canonical
  // reader requires (core/payroll-tax-basis-read.ts); otherwise it needs review like any other changed import.
  const importedPeriods = [...new Set(rows.filter(r => (r.rules_receipts ?? []).length).map(r => r.period))];
  const rulesStates = importedPeriods.length ? await importedTaxRulesStatesTx(tx, importedPeriods) : new Map<string, unknown>();
  for (const r of rows) {
    if (!r.unusable && (r.rules_receipts ?? []).some(receipt => canonical(receipt) !== canonical(rulesStates.get(r.period)))) r.unusable = 'imported_review';
  }
  const sameMonth = [...new Set(rows.filter(r => r.period === p.payPeriod).map(r => r.employment_id))];
  const startsInMonth = sameMonth.length ? await groupTaxRunStartsTx(tx, p.runCompanyId, p.payPeriod, sameMonth) : new Map<string, string>();
  const tp3ByEmployment = new Map<string, {numbers: string[]; unnumbered: number}>();
  for (const r of rows) {
    const endsOn = isoDate(r.ends_on);
    if (r.period > p.payPeriod) continue;
    if (r.period === p.payPeriod) {
      const startsOn = startsInMonth.get(r.employment_id);
      if (!startsOn || !endsOn || endsOn >= startsOn) continue;
    }
    const used: Record<string, number> = {};
    for (const [code, amount] of Object.entries(r.exemption_used ?? {})) { const n = num(amount); if (n > 0) used[code] = n; }
    const month: GroupTaxMonth & {numbers: string[]} = {
      companyId: r.company_id, companyName: r.company_name, period: r.period,
      source: r.source === 'imported' || r.source === 'mixed' ? r.source : 'processed', slips: Number(r.slips),
      y: num(r.y), epf: num(r.epf), pcb: num(r.pcb), zakat: num(r.zakat), zakatRebate: num(r.zakat_rebate), lp: num(r.lp),
      tp1Lp: num(r.tp1_lp), exemptionUsed: used, bik: num(r.bik), vola: num(r.vola), noncashComplete: r.noncash_complete === true,
      unusable: r.unusable === 'imported_review' || r.unusable === 'no_tax_basis' ? r.unusable : null,
      numbers: (r.employer_numbers ?? []).map(normalizeTaxNumber).filter(Boolean),
    };
    const opening = out.get(r.employment_id) ?? {employmentId: r.employment_id, months: [], tp3: 'apply' as GroupTp3Outcome};
    opening.months.push(month);
    out.set(r.employment_id, opening);
    tp3ByEmployment.set(r.employment_id, {numbers: (r.tp3_numbers ?? []).map(normalizeTaxNumber).filter(Boolean), unnumbered: Number(r.tp3_unnumbered ?? 0)});
  }
  for (const opening of out.values()) {
    const tp3 = tp3ByEmployment.get(opening.employmentId);
    const group = new Set(opening.months.flatMap(m => (m as GroupTaxMonth & {numbers: string[]}).numbers));
    opening.tp3 = groupTp3Outcome(tp3?.numbers ?? [], tp3?.unnumbered ?? 0, group);
    opening.months = opening.months.map(({numbers: _numbers, ...m}: GroupTaxMonth & {numbers?: string[]}) => m);
    opening.months.sort((a, b) => a.period.localeCompare(b.period) || a.companyId.localeCompare(b.companyId));
  }
  return out;
}

/**
 * Pure. A TP3 listing a contributing group company is replaced by that company's history; one that ALSO lists any other
 * employer (or one without a tax number, which cannot be told apart) carries a single total that cannot be split, so it
 * holds; a TP3 naming no contributing group company applies as today.
 */
export function groupTp3Outcome(tp3Numbers: readonly string[], unnumbered: number, groupNumbers: ReadonlySet<string>): GroupTp3Outcome {
  const matched = tp3Numbers.filter(n => groupNumbers.has(n));
  if (!matched.length) return 'apply';
  return matched.length === tp3Numbers.length && unnumbered === 0 ? 'replaced' : 'conflict';
}

/** The first reason this opening cannot be used, as the hold the employee gets (the month is always named). Pure. */
export function groupTaxHoldReason(opening: GroupTaxOpening | undefined, tp3Applies: boolean): {period: string; reason: string} | null {
  if (!opening) return null;
  const bad = opening.months.find(m => m.unusable);
  if (bad) {
    return {period: bad.period, reason: bad.unusable === 'imported_review'
      ? `Income tax history from ${bad.companyName} for ${bad.period} requires review. Preview the historical tax inputs of that company and resolve the named missing evidence.`
      : `Income tax history from ${bad.companyName} for ${bad.period} has no recorded tax basis. Reprocess that month at ${bad.companyName} before this one.`};
  }
  if (tp3Applies && opening.tp3 === 'conflict' && opening.months.length) {
    const first = opening.months[0];
    return {period: first.period, reason: `The employee's Form TP3 lists ${first.companyName} together with another employer. Record the other employer's figures on their own TP3, because ${first.companyName}'s months are already counted from the group's payroll history.`};
  }
  return null;
}

/**
 * Which of the given employments the group opening holds, with the month named and whether it is imported history
 * waiting for review: the set processing holds (core/payroll-tax-holds.ts) and the draft readiness check
 * (core/payroll-draft-tax-readiness.ts) both ask, through the same reader as the calculation. The TP3 year is read
 * only for an employee whose TP3 conflicts with the group history.
 */
export async function groupTaxHoldsTx(tx: Tx, runCompanyId: string, payPeriod: string, employmentIds: readonly string[]): Promise<Map<string, {period: string; reason: string; imported: boolean}>> {
  const out = new Map<string, {period: string; reason: string; imported: boolean}>();
  const group = await groupTaxOpeningTx(tx, {runCompanyId, payPeriod, employmentIds});
  const conflicted = [...group.values()].filter(o => o.tp3 === 'conflict' && !o.months.some(m => m.unusable)).map(o => o.employmentId);
  const tp3Years = new Map<string, number | null>();
  if (conflicted.length) {
    for (const r of await tx.select({id: employment.id, tp3Year: employeeStatutoryMy.tp3Year}).from(employment)
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId)).where(inArray(employment.id, conflicted))) tp3Years.set(r.id, r.tp3Year);
  }
  for (const [employmentId, opening] of group) {
    const hold = groupTaxHoldReason(opening, tp3Years.get(employmentId) === Number(payPeriod.slice(0, 4)));
    if (hold) out.set(employmentId, {...hold, imported: opening.months.some(m => m.period === hold.period && m.unusable === 'imported_review')});
  }
  return out;
}

/** Throws the hold as the tax-basis error the non-chunked paths already raise for an unreadable history. */
export function assertGroupTaxOpeningUsable(opening: GroupTaxOpening | undefined, tp3Applies: boolean) {
  const hold = groupTaxHoldReason(opening, tp3Applies);
  if (hold) throw new PayrollTaxBasisError(hold.reason);
}

