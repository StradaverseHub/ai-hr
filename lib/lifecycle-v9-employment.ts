import { isCalendarDate } from './calendar-date';
import { employmentConfirmationDate, type EmploymentConfirmationDates } from './employment-confirmation';
export type V9EmploymentClass = 'permanent' | 'contract' | 'probation';
export type V9EmploymentFacts = EmploymentConfirmationDates & { employmentType: string; joinDate?: string; noticeDate?: string };
/** Owner-approved V9 matching categories; underlying employment types and IDs are retained. */
export function v9EmploymentClass(source: V9EmploymentFacts): V9EmploymentClass | null {
  if (source.employmentType === 'contract') return 'contract';
  if (source.employmentType !== 'full_time') return null;
  const confirmation = employmentConfirmationDate({ finalConfirmationDate: source.finalConfirmationDate || null, confirmationDate: source.confirmationDate || null, probationEndDate: source.probationEndDate || null, provisionalEndOn: source.provisionalEndOn || null });
  if (!confirmation) return 'permanent';
  const asOf = source.noticeDate || source.joinDate;
  if (!asOf || !isCalendarDate(asOf) || !isCalendarDate(confirmation)) return null;
  return asOf < confirmation ? 'probation' : 'permanent';
}
/** Null is an unclassified category, including for an inverse category condition. */
export function v9EmploymentRule(value: string, source: V9EmploymentFacts): boolean | null {
  const category = value.toLowerCase();
  if (['permanent','contract','probation'].includes(category)) {
    const actual = v9EmploymentClass(source); return actual === null ? null : category === actual;
  }
  return null;
}
export const v9EmploymentLabels = { Permanent: 'Permanent', Contract: 'Contract', Probation: 'Probation' } as const;
export function canonicalV9EmploymentRule(value: string): string | null {
  const category = value.toLowerCase(); return ['permanent','contract','probation'].includes(category) ? category[0].toUpperCase() + category.slice(1) : null;
}
export function v9EmploymentRuleLabel(value: string): string {
  return canonicalV9EmploymentRule(value) ?? ({ full_time: 'Full time (existing rule)', part_time: 'Part time (existing rule)', intern: 'Intern (existing rule)', assignment: 'Assignment (existing rule)' } as Record<string,string>)[value] ?? value;
}
