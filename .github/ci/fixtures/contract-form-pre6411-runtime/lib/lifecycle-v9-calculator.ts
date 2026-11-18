/** V9 settlement advisory. Leave supplies the remaining balance; Payroll alone enacts pay. */
import { addDays, validDate, V9Error, type ExitType } from './lifecycle-v9-model';
export type NoticePeriod = { value: number; unit: 'month' | 'week' | 'day' };
export type SettlementPolicy = {
  bands: { id: string; name: string; grades: string[]; permanent: NoticePeriod; contract: NoticePeriod; probation: NoticePeriod }[];
  defaultNotice: NoticePeriod; noticeDays: 'calendar' | 'working'; allowLeaveOffset: boolean;
  includeAllowances: boolean; encashmentCap: number | null; rateBasis: number; payDay: number; leaveTypeIds: string[];
};
export type SettlementInput = {
  type: ExitType; noticeDate: string; sourceLastDay: string; grade: string;
  employmentType: 'permanent' | 'contract' | 'probation'; contractNotice: NoticePeriod | null;
  override: { date: string; reason: string; kind: 'earlyRelease' | 'waived' | 'payInLieu' | 'immediate' | 'other' } | null;
  keepSourceDate: boolean; remainingLeave: number | null; basic: number | null; allowances: number;
  currency: string; offsetLeave: boolean; reduceEncashment: { days: number; reason: string } | null;
};
export type Settlement = {
  lastDay: string; calculatedLastDay: string; sourceLastDay: string; mismatch: boolean; notice: NoticePeriod; noticeSource: string;
  unservedDays: number; remainingLeave: number | null; offsetDays: number; encashDays: number | null;
  dailyRate: number | null; amount: number | null; currency: string; payDate: string;
  reductionStale: boolean; deduction: boolean; ready: boolean; missing: string[];
};
export function defaultSettlementPolicy(): SettlementPolicy { return {
  bands: [
    { id: 'non-executive', name: 'Non-exec and executive', grades: ['NE1', 'NE2', 'E1', 'E2', 'E3'], permanent: { value: 1, unit: 'month' }, contract: { value: 1, unit: 'month' }, probation: { value: 2, unit: 'week' } },
    { id: 'manager', name: 'Manager', grades: ['M1', 'M2', 'M3'], permanent: { value: 2, unit: 'month' }, contract: { value: 1, unit: 'month' }, probation: { value: 1, unit: 'month' } },
    { id: 'senior', name: 'Senior management', grades: ['S1', 'S2', 'GM'], permanent: { value: 3, unit: 'month' }, contract: { value: 2, unit: 'month' }, probation: { value: 1, unit: 'month' } },
  ], defaultNotice: { value: 1, unit: 'month' }, noticeDays: 'calendar', allowLeaveOffset: true, includeAllowances: false, encashmentCap: null, rateBasis: 26, payDay: 25, leaveTypeIds: [],
}; }
function checkPeriod(period: NoticePeriod): boolean { return Number.isInteger(period.value) && period.value >= 0 && period.value <= 120 && ['month', 'week', 'day'].includes(period.unit); }
export function addNotice(date: string, period: NoticePeriod, working = false): string {
  if (!validDate(date) || !checkPeriod(period)) throw new V9Error('Enter a valid notice date and period.');
  if (period.unit !== 'month') return addDays(date, period.value * (period.unit === 'week' ? 7 : 1), working && period.unit === 'day');
  const [year, month, day] = date.split('-').map(Number), first = new Date(Date.UTC(year, month - 1 + period.value, 1));
  const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, end)).padStart(2, '0')}`;
}
const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
function span(start: string, end: string, working: boolean): number {
  if (end <= start) return 0; let count = 0;
  for (let date = addDays(start, 1); date <= end; date = addDays(date, 1)) { const day = new Date(date + 'T00:00:00Z').getUTCDay(); if (!working || day !== 0 && day !== 6) count++; }
  return count;
}
export function settlement(input: SettlementInput, policy: SettlementPolicy): Settlement {
  if (!checkPeriod(policy.defaultNotice) || !Number.isFinite(policy.rateBasis) || policy.rateBasis <= 0 || policy.rateBasis > 366 || !Number.isInteger(policy.payDay) || policy.payDay < 1 || policy.payDay > 31) throw new V9Error('Complete the notice and final-pay policy.');
  if (!validDate(input.sourceLastDay) || !validDate(input.noticeDate)) throw new V9Error('Enter valid notice and last working dates.');
  if (input.override && (!validDate(input.override.date) || !input.override.reason.trim())) throw new V9Error('An adjusted last working day requires a date and reason.');
  const band = policy.bands.find(b => b.grades.some(g => g.toLocaleLowerCase() === input.grade.toLocaleLowerCase()));
  const notice = input.contractNotice && checkPeriod(input.contractNotice) ? input.contractNotice : band?.[input.employmentType] ?? policy.defaultNotice;
  const noticeSource = input.contractNotice && checkPeriod(input.contractNotice) ? 'Employment contract' : band ? `Policy table: ${band.name}` : 'Policy default';
  const fixed = input.type === 'Contract end' || input.type === 'Retirement', calculated = fixed ? input.sourceLastDay : addNotice(input.noticeDate, notice, policy.noticeDays === 'working');
  const lastDay = input.override?.date ?? (input.keepSourceDate ? input.sourceLastDay : calculated);
  const unservedDays = input.override && lastDay < calculated ? span(lastDay, calculated, policy.noticeDays === 'working') : 0;
  const remaining = input.remainingLeave, missing: string[] = [];
  if (remaining === null || !Number.isFinite(remaining)) missing.push('Leave balance as at the last working day');
  if (input.basic === null || !Number.isFinite(input.basic) || input.basic < 0) missing.push('Effective basic salary');
  if (!input.currency) missing.push('Salary currency');
  if (!Number.isFinite(input.allowances) || input.allowances < 0) missing.push('Effective allowance amount');
  const offsetDays = remaining !== null && policy.allowLeaveOffset && input.offsetLeave && unservedDays > 0 ? Math.min(Math.max(0, remaining), unservedDays) : 0;
  const positive = remaining === null ? null : Math.max(0, round1(remaining - offsetDays));
  const defaults = positive === null ? null : policy.encashmentCap === null ? positive : Math.min(positive, policy.encashmentCap);
  const reduction = input.reduceEncashment;
  const applies = defaults !== null && remaining !== null && remaining >= 0 && reduction !== null && Number.isFinite(reduction.days) && reduction.days >= 0 && reduction.days < defaults && !!reduction.reason.trim();
  const encashDays = remaining === null ? null : remaining < 0 ? remaining : applies ? round1(reduction!.days) : defaults;
  const dailyRate = input.basic === null ? null : (input.basic + (policy.includeAllowances ? input.allowances : 0)) / policy.rateBasis;
  const amount = encashDays !== null && dailyRate !== null ? round2(encashDays * dailyRate) : null;
  let [year, month, day] = lastDay.split('-').map(Number);
  if (day > policy.payDay) { month++; if (month > 12) { month = 1; year++; } }
  const payDate = `${year}-${String(month).padStart(2, '0')}-${String(Math.min(policy.payDay, new Date(Date.UTC(year, month, 0)).getUTCDate())).padStart(2, '0')}`;
  return { lastDay, calculatedLastDay: calculated, sourceLastDay: input.sourceLastDay, mismatch: calculated !== input.sourceLastDay && !input.keepSourceDate, notice, noticeSource, unservedDays, remainingLeave: remaining, offsetDays, encashDays, dailyRate, amount, currency: input.currency, payDate, reductionStale: !!reduction && !applies, deduction: (encashDays ?? 0) < 0, ready: !missing.length, missing };
}
