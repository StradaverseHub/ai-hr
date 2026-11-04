import Link from 'next/link';
import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AuditLoopSummary } from '@/core/payroll-audit/status';

/** AI v2 P2-2b — the Audit loop's column on the Payroll cycle page (approved mock-up PayrollLoops.dc.html, "3 · Audit loop").
 *
 * Presentational: the page reads `auditLoopSummary` (core/payroll-audit/status.ts) for its pay month and company filter and
 * mounts this. Every figure is a count from its owner; no amount is shown. With one company in view the audit pack downloads
 * from here; with several, the Audit loop page has one per company. The loop stays at Prepare: a person files with EPF,
 * PERKESO and LHDN. Names are the AI Centre's; nothing here says Noveri.
 *
 * Wave 1 integration: on the Payroll cycle page the column also takes `bank`, the Salary payroll loop's own check of each
 * processed run's bank file total against its net pay (P2-2a, owner decision 1, core/loops/salary-payroll.ts), and shows it
 * as "Bank paid vs payroll" in place of the bank file count. Runs are counted here; no amount is compared or shown. */
export const AUDIT_LOOP_HREF = '/control-tower/loops/loop_payroll_audit';
const DONE = 'text-emerald-700 dark:text-emerald-300';
const WAITING = 'text-amber-700 dark:text-amber-300';

export function auditPackHref(companyId: string, payPeriod: string) {
  return `${AUDIT_LOOP_HREF}/pack?${new URLSearchParams({ company: companyId, period: payPeriod })}`;
}

/** The Audit loop is done for the month when every company in view is: the column's badge, and the loop's status in the
 * Operations › Loops list. */
export const auditLoopDone = (summary: AuditLoopSummary) => summary.companies.length > 0 && summary.totals.companiesDone === summary.companies.length;

/** The Salary payroll loop's bank check over the processed runs in view: how many match their net pay and how many do not. */
export type AuditBankReconciliation = Readonly<{ processed: number; matched: number; mismatched: number }>;

export function AuditLoopColumn({ summary, position, className, bank, heading: Heading = 'h3' }: { summary: AuditLoopSummary; position?: number; className?: string;
  bank?: AuditBankReconciliation; heading?: 'h2' | 'h3' }) {
  const t = useTranslations('payrollAudit.column');
  const f = useFormatter();
  const { totals } = summary;
  const due = f.dateTime(new Date(`${summary.dueDate}T00:00:00Z`), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const single = summary.companies.length === 1 ? summary.companies[0] : null;
  const href = `${AUDIT_LOOP_HREF}?${new URLSearchParams({ period: summary.payPeriod, ...(single ? { company: single.companyId } : {}) })}`;
  const allDone = auditLoopDone(summary);
  const item = (key: string, value: ReactNode, tone?: 'done' | 'waiting') => (
    <li key={key} data-audit-item={key} className="flex justify-between gap-2">
      <span>{t(`items.${key}`)}</span>
      <span className={cn('text-right', tone === 'done' ? DONE : tone === 'waiting' ? WAITING : 'text-muted-foreground')}>{value}</span>
    </li>
  );
  return (
    <Card data-audit-loop className={cn('flex flex-col gap-3 p-4', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Heading className="m-0 text-base font-semibold">{position ? t('titleNumbered', { n: position }) : t('title')}</Heading>
        <span data-audit-badge className={cn('rounded-full px-2.5 py-0.5 text-xs', allDone ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-muted text-foreground')}>
          {allDone ? t('done') : t('badge')}
        </span>
      </div>
      <p className="m-0 text-sm text-muted-foreground">{t('doneMeans')}</p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
        {item('payslips', t('values.payslips', { released: totals.released, total: totals.payslips, opened: totals.opened }),
          totals.payslips > 0 && totals.released === totals.payslips ? 'done' : undefined)}
        {item('statutory', t('values.statutory', { prepared: totals.formsPrepared, filed: totals.formsFiled, forms: totals.forms, due }),
          totals.forms > 0 && totals.formsFiled === totals.forms ? 'done' : undefined)}
        {bank
          ? item('bankPaid', bank.mismatched > 0 ? t('values.bankMismatch', { count: bank.mismatched })
            : bank.processed === 0 ? t('values.bankNone')
              : bank.matched === bank.processed ? t('values.bankReconciled') : t('values.bankPartial', { matched: bank.matched, total: bank.processed }),
          bank.mismatched > 0 ? 'waiting' : bank.processed > 0 && bank.matched === bank.processed ? 'done' : undefined)
          : item('bank', t('values.bank', { count: totals.bankFiles }))}
        {item('corrections', t('values.corrections', { count: totals.corrections }), totals.corrections > 0 ? 'waiting' : undefined)}
        {item('findings', t('values.findings', { count: totals.openFindings }), totals.openFindings > 0 ? 'waiting' : undefined)}
        {item('approvals', single
          ? <a href={auditPackHref(single.companyId, summary.payPeriod)} className="inline-flex min-h-9 items-center font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">{t('values.packLink')}</a>
          : t('values.pack'))}
        {item('repeat', t('values.repeat', { count: totals.repeatIssues }))}
      </ul>
      <p className="m-0 border-t border-border pt-2 text-xs text-muted-foreground">{t('note')}</p>
      <Link href={href} className="inline-flex min-h-9 items-center text-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">{t('open')}</Link>
    </Card>
  );
}
