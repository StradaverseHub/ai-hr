import type { PayrollCycleOverview, PreSalaryState, SalaryState } from '@/core/loops/payroll-cycle-views';
import { auditLoopDone } from '@/components/payroll-audit/audit-loop-column';

/** The three payroll loops' group states, from one month's Payroll cycle overview (core/loops/payroll-cycle-views.ts).
 * One owner for the rule the Payroll cycle page's cards and the Operations › Loops list both show; nothing here reads
 * or computes pay. Moved verbatim from app/control-tower/loops/payroll-cycle/page.tsx (AI Centre navigation, 4 Nov 2026). */
export const DONE = 'text-emerald-700 dark:text-emerald-300';
export const ATTENTION = 'text-amber-700 dark:text-amber-300';
export const pill = 'rounded-full border border-border px-2.5 py-1 text-xs font-medium';

/** The group's state of one loop: the worst of its companies', in the order a person should look at them. */
export const PRE_ORDER: readonly PreSalaryState[] = ['missed', 'open', 'not_checked', 'paused', 'done', 'off'];
export const SALARY_ORDER: readonly SalaryState[] = ['attention', 'ready_to_start', 'in_progress', 'not_checked', 'paused', 'before_cut_off', 'done', 'off'];
export const worst = <T extends string>(order: readonly T[], states: readonly T[]): T | null =>
  states.length ? order.find(state => states.includes(state)) ?? states[0] : null;

export type PayrollLoopStates = Readonly<{ pre: PreSalaryState | null; daysToCutOff: number; salary: SalaryState | null; audit: 'done' | 'after_pay_day' | null }>;

export function payrollLoopStates(view: PayrollCycleOverview): PayrollLoopStates {
  return Object.freeze({
    pre: worst(PRE_ORDER, view.companies.map(c => c.preSalary.state)),
    daysToCutOff: Math.min(...view.companies.map(c => c.preSalary.daysToCutOff)),
    salary: worst(SALARY_ORDER, view.companies.map(c => c.salary.state)),
    audit: view.audit ? (auditLoopDone(view.audit) ? 'done' : 'after_pay_day') : null,
  });
}
