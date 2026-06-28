'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { LoanRow, RepaymentRow } from '@/core/loans';
import {
  amendLoanAction,
  cancelLoanAction,
  resumeLoanAction,
  settleLoanAction,
  suspendLoanAction,
} from '@/app/admin/loans/actions';

type LoanWithSchedule = LoanRow & { schedule: RepaymentRow[] };

const STATUS_CLS: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  suspended: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  settled: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  cancelled: 'bg-muted text-muted-foreground',
};

function money(n: number): string {
  return `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function LoanList({ loans }: { loans: LoanWithSchedule[] }) {
  const t = useTranslations('loans');
  const tType = useTranslations('loans.loanType');
  const tStatus = useTranslations('loans.status');
  const [open, setOpen] = useState<string | null>(null);

  if (loans.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
          <th className="px-4 py-2 font-medium">{t('colType')}</th>
          <th className="px-4 py-2 font-medium">{t('colPrincipal')}</th>
          <th className="px-4 py-2 font-medium">{t('colInstalment')}</th>
          <th className="px-4 py-2 font-medium">{t('colOutstanding')}</th>
          <th className="px-4 py-2 font-medium">{t('colProgress')}</th>
          <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
          <th className="px-4 py-2 font-medium" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {loans.map((l) => (
          <Fragment key={l.id}>
            <tr className="hover:bg-muted/40">
              <td className="px-4 py-2.5 font-medium">{l.employeeName}</td>
              <td className="px-4 py-2.5">{tType(l.loanType)}</td>
              <td className="px-4 py-2.5 tabular-nums">{money(l.principal)}</td>
              <td className="px-4 py-2.5 tabular-nums">{money(l.monthlyInstalment)}</td>
              <td className="px-4 py-2.5 tabular-nums">{money(l.outstandingBalance)}</td>
              <td className="px-4 py-2.5 tabular-nums">
                {l.instalmentsPaid}/{l.durationMonths}
              </td>
              <td className="px-4 py-2.5">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLS[l.status] ?? ''}`}>
                  {tStatus(l.status)}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right">
                <button
                  type="button"
                  onClick={() => setOpen(open === l.id ? null : l.id)}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                >
                  {open === l.id ? t('hide') : t('manage')}
                </button>
              </td>
            </tr>
            {open === l.id && (
              <tr className="bg-muted/20">
                <td colSpan={8} className="px-4 py-4">
                  <div className="space-y-4">
                    {/* Lifecycle actions, gated by status. */}
                    <div className="flex flex-wrap gap-2">
                      {(l.status === 'active' || l.status === 'suspended') && (
                        <form action={amendLoanAction} className="flex items-end gap-2">
                          <input type="hidden" name="loanId" value={l.id} />
                          <label className="text-xs text-muted-foreground">
                            {t('durationMonths')}
                            <input
                              name="durationMonths"
                              type="number"
                              min="1"
                              defaultValue={l.durationMonths}
                              className="ml-2 w-20 rounded-md border border-border bg-background px-2 py-1 text-sm tabular-nums"
                            />
                          </label>
                          <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{t('amend')}</button>
                        </form>
                      )}
                      {l.status === 'active' && (
                        <ActionButton action={suspendLoanAction} loanId={l.id} label={t('suspend')} />
                      )}
                      {l.status === 'suspended' && (
                        <ActionButton action={resumeLoanAction} loanId={l.id} label={t('resume')} />
                      )}
                      {(l.status === 'active' || l.status === 'suspended') && (
                        <ActionButton action={settleLoanAction} loanId={l.id} label={t('settle')} />
                      )}
                      {(l.status === 'active' || l.status === 'suspended') && l.instalmentsPaid === 0 && (
                        <ActionButton action={cancelLoanAction} loanId={l.id} label={t('cancel')} />
                      )}
                    </div>

                    {/* Repayment schedule. */}
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('scheduleTitle')}
                      </p>
                      <table className="w-full text-xs">
                        <thead className="text-left text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1 font-medium">{t('seq')}</th>
                            <th className="px-2 py-1 font-medium">{t('due')}</th>
                            <th className="px-2 py-1 font-medium">{t('applied')}</th>
                            <th className="px-2 py-1 font-medium">{t('colStatus')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {l.schedule.map((r) => (
                            <tr key={r.id}>
                              <td className="px-2 py-1 tabular-nums">{r.sequenceNo}</td>
                              <td className="px-2 py-1 tabular-nums">{money(r.dueAmount)}</td>
                              <td className="px-2 py-1 tabular-nums">{r.appliedAmount > 0 ? money(r.appliedAmount) : '—'}</td>
                              <td className="px-2 py-1">{t(`repaymentStatus.${r.status}`)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function ActionButton({
  action,
  loanId,
  label,
}: {
  action: (fd: FormData) => void | Promise<void>;
  loanId: string;
  label: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="loanId" value={loanId} />
      <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">{label}</button>
    </form>
  );
}
