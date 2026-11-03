import type { AuditLoopSummary } from '@/core/payroll-audit/status';
import type { PayrollCycleCompany } from '@/core/loops/payroll-cycle-views';
import { AuditLoopColumn, type AuditBankReconciliation } from '@/components/payroll-audit/audit-loop-column';

/** AI v2 P2-2a — the Audit loop's place in the Payroll cycle pipeline (the third loop, after pay day).
 *
 * Wave 1 integration: the slot now shows P2-2b's real Audit loop status, its column (components/payroll-audit/
 * audit-loop-column.tsx) read from auditLoopSummary for this month and these companies (core/loops/payroll-cycle-views.ts).
 * Its "Bank paid vs payroll" item is the Salary payroll loop's own bank check (bank file total against net pay, P2-2a),
 * counted over the processed runs in view; nothing is computed from money here. When the summary is null (no company in
 * view, or the Audit loop's read refused) the card shows what the loop is for and no status, as before. */
export type AuditLoopStatus = AuditLoopSummary | null;
export type AuditLoopCopy = Readonly<{ title: string; done: string; note: string }>;

const MISMATCH = new Set(['total_mismatch', 'count_mismatch', 'blocked']);

/** The Salary payroll loop's bank check over the processed (not draft) runs of the companies in view. */
export function bankReconciliation(companies: readonly PayrollCycleCompany[]): AuditBankReconciliation {
  const processed = companies.flatMap(c => c.salary.runs).filter(run => run.status !== 'draft');
  return Object.freeze({ processed: processed.length, matched: processed.filter(run => run.bank === 'match').length,
    mismatched: processed.filter(run => MISMATCH.has(run.bank)).length });
}

export function AuditLoopCard({ status, bank, copy }: { status: AuditLoopStatus; bank: AuditBankReconciliation; copy: AuditLoopCopy }) {
  if (status) {
    return (
      <li data-loop-card="audit" data-audit-status="read" className="flex min-w-0 flex-col">
        <AuditLoopColumn summary={status} position={3} heading="h2" bank={bank} className="h-full rounded-xl" />
      </li>
    );
  }
  return (
    <li data-loop-card="audit" data-audit-status="none" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{copy.title}</h2>
      </div>
      <p className="text-sm text-muted-foreground">{copy.done}</p>
      <p className="border-t border-border pt-2 text-xs text-muted-foreground">{copy.note}</p>
    </li>
  );
}
