'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EmployeeCode } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { formatMoney } from '@/lib/money';
import { removeEmployeePayrollAction } from '../../actions';

/** One tickable row: an employee who HAS a payslip on this run. Plain serialisable data — the server
 *  page resolves it (department, later months) so no closure crosses to the client. */
export type RemoveCandidate = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  department: string | null;
  /** `numeric` columns arrive as strings; `formatMoney` takes either and refuses a non-number. */
  gross: string | number;
  net: string | number;
  /** Later months already processed/closed for this person — a warning, never a gate. */
  laterPeriods: string[];
};

/**
 * 9066bd6c — the selection half of the Remove Employee Payroll screen.
 *
 * IT IS A SCREEN, NOT A PANEL, for the same reason the Reprocess selection is: e440991b established
 * that shape after the reporter rejected a selection buried at the bottom of the long run screen.
 *
 * IT IS NOT RESET, AND EVERY PIECE OF COPY HERE SAYS SO IN ITS OWN WORDS. Reset clears the whole run
 * and drops it to Draft; this takes the ticked people off and leaves the run Processed. The two must
 * never share a confirmation dialog or a phrase — an operator who reads Reset's wording on this button
 * has been told the wrong thing about what is going to happen to the other twenty-two people.
 *
 * THE WHOLE-RUN CASE IS REFUSED HERE AND AGAIN IN THE SERVICE. Ticking everybody IS a Reset, and
 * honouring it would leave a run that is still Processed with no payslips at all. The button goes away
 * with the reason stated; `removeEmployeePayroll` throws `RemoveWholeRunError` regardless, which is
 * what decides it when the two disagree.
 */
export function RemoveForm({
  batchId,
  employees,
  currency,
  from,
}: {
  batchId: string;
  employees: RemoveCandidate[];
  currency: string | null;
  /** The Payroll Process list's own query when the operator arrived from it — carried through the
   *  submit so the screen they land on can still send Back to the list as they left it. */
  from: string | null;
}) {
  const t = useTranslations('payroll.batch');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [reason, setReason] = useState('');

  const total = employees.length;
  // Search on employee ID **or** name, which is what the reporter asked for. Deliberately no Employee
  // Status filter: every row on this list has a result on this run, so the control would have exactly
  // one value and filter nothing.
  const needle = q.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle === ''
        ? employees
        : employees.filter(
            (e) =>
              (e.employeeCode ?? '').toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle),
          ),
    [employees, needle],
  );
  const picked = employees.filter((e) => selected.has(e.employmentId));
  const wholeRun = total > 0 && picked.length === total;
  const laterPeriods = [...new Set(picked.flatMap((e) => e.laterPeriods))].sort();

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <form action={removeEmployeePayrollAction} className="space-y-4">
      <input type="hidden" name="batchId" value={batchId} />
      {from && <input type="hidden" name="from" value={from} />}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('removeSearchPlaceholder')}
          className="w-full max-w-xs rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
        />
        <span className="text-sm font-medium">{t('removeSummary', { n: selected.size, total })}</span>
        <button
          type="button"
          onClick={() => setSelected(new Set(visible.map((e) => e.employmentId)))}
          className="text-sm font-medium text-primary hover:underline"
        >
          {t('removeSelectAll')}
        </button>
        <button
          type="button"
          onClick={() => setSelected(new Set())}
          className="text-sm font-medium text-primary hover:underline"
        >
          {t('removeClear')}
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
              <th className="px-3 py-2 font-medium">{t('removeColDepartment')}</th>
              <th className="px-3 py-2 font-medium">{t('removeColLater')}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('colGross')}</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t('colNet')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((e) => {
              const on = selected.has(e.employmentId);
              return (
                <tr key={e.employmentId} className={on ? 'bg-destructive/5' : undefined}>
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="employmentIds"
                        value={e.employmentId}
                        checked={on}
                        onChange={() => toggle(e.employmentId)}
                        className="size-4 rounded"
                      />
                      <EmployeeCode code={e.employeeCode} />
                      <span>{e.name}</span>
                    </label>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{e.department ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {e.laterPeriods.length > 0 ? e.laterPeriods.join(', ') : '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatMoney(e.gross, currency)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatMoney(e.net, currency)}</td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {total === 0 ? t('removeNoEmployees') : t('removeNoMatches')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* THE REVIEW STEP — whose result is going, and what it is worth, in names and figures rather
          than a count. Rendered from the same state as the ticks above, in the same form. */}
      {picked.length > 0 && (
        <div className="rounded-xl border border-dashed border-destructive/45 bg-destructive/5 px-4 py-3">
          <p className="text-sm font-medium">{t('removeReviewTitle', { n: picked.length, total })}</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {picked.map((e) => (
              <li key={e.employmentId} className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="inline-flex items-baseline gap-1.5">
                  <EmployeeCode code={e.employeeCode} />
                  <span>{e.name}</span>
                  {e.department && <span className="text-xs text-muted-foreground">{e.department}</span>}
                </span>
                <span className="tabular-nums">{formatMoney(e.net, currency)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">{t('removeReviewNote', { n: total - picked.length })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('removeReviewBackNote')}</p>
          {laterPeriods.length > 0 && (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
              {t('removeWarnLaterPeriods', { periods: laterPeriods.join(', ') })}
            </p>
          )}
        </div>
      )}

      {/* Ticking everybody is a Reset. Said here, with the reason, rather than discovered by pressing a
          button that then refuses — the service refuses it either way. */}
      {wholeRun && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          {t('removeWholeRunRefused')}
        </p>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-foreground">{t('removeReasonLabel')}</span>
        <textarea
          name="reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('removeReasonPlaceholder')}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
        />
      </label>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link
          href={`/payroll/${batchId}`}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          {t('removeCancel')}
        </Link>
        {/* Its OWN confirmation copy, never Reset's — see the file header. The reason already lives in
            the form above (it is part of the review, not an afterthought inside a dialog), so no
            `reasonField` here; the button stays disabled until there is one. */}
        <ConfirmSubmit
          disabled={picked.length === 0 || wholeRun || reason.trim().length === 0}
          title={t('removeConfirmTitle')}
          description={t('removeConfirmBody', { n: picked.length })}
          confirmLabel={t('removeConfirmYes')}
        >
          {t('removeSubmitN', { n: picked.length })}
        </ConfirmSubmit>
      </div>
    </form>
  );
}
