'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
// RSC: import the pure calc engine + constants from core/loans-compute (NO db import), not core/loans
// (which imports postgres at module scope and would be dragged into this client bundle → next build fails).
import { computeLoan, LOAN_INTEREST_METHODS, LOAN_TYPES, type LoanInterestMethod } from '@/core/loans-compute';
import { createLoanAction } from '@/app/admin/loans/actions';

/**
 * New-loan form with a CLIENT-SIDE live preview of the computed monthly instalment (reuses the pure
 * computeLoan engine, so the preview matches the server exactly). Admin-only (the page is admin-gated).
 *
 * 6d72816e — THE EMPLOYEE DROPDOWN IS GONE AND THAT IS THE POINT. This form used to sit permanently open
 * at the bottom of the loans list carrying its own `<select name="employmentId">`, so the screen had TWO
 * employee controls that could disagree: you picked somebody in the panel on the left and the form was
 * still addressed to whoever happened to be first alphabetically. It now opens from an Add button, on its
 * own page, and the employee is FIXED from the scope-guarded `?employmentId=` the page resolved — passed
 * as a hidden input, because a loan without an employee is not a loan.
 *
 * Every prop is plain data (`cancelHref` is a string, not a callback): a function prop crossing from a
 * server component to a client one returns a 500 on every request while tsc, the suite and `next build`
 * all stay green.
 */
export function LoanNewForm({ employmentId, cancelHref }: { employmentId: string; cancelHref: string }) {
  const t = useTranslations('loans');
  const tType = useTranslations('loans.loanType');
  const [principal, setPrincipal] = useState('');
  const [rate, setRate] = useState('0');
  const [method, setMethod] = useState<LoanInterestMethod>('none');
  const [duration, setDuration] = useState('12');

  const preview = useMemo(() => {
    const p = Number(principal);
    const d = Number(duration);
    const r = Number(rate);
    if (!(p > 0) || !(d >= 1) || !Number.isInteger(d) || r < 0) return null;
    try {
      const c = computeLoan({ principal: p, annualInterestPct: r, durationMonths: d, method });
      return {
        instalment: (c.monthlyInstalmentCents / 100).toFixed(2),
        total: (c.totalRepayableCents / 100).toFixed(2),
      };
    } catch {
      return null;
    }
  }, [principal, rate, method, duration]);

  return (
    <form action={createLoanAction} className="space-y-4">
      <input type="hidden" name="employmentId" value={employmentId} />
      {/* The list this form returns to, carried through so a created loan lands back on the employee the
          operator was working on rather than on the everyone view. */}
      <input type="hidden" name="returnEmploymentId" value={employmentId} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('loanTypeLabel')}>
          <select name="loanType" required className={`${inputCls} w-40`}>
            {LOAN_TYPES.map((lt) => (
              <option key={lt} value={lt}>
                {tType(lt)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('principal')}>
          <input
            name="principal"
            type="number"
            step="0.01"
            min="0.01"
            required
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            className={`${inputCls} w-36 tabular-nums`}
          />
        </Field>
        <Field label={t('interestMethod')}>
          <select
            name="interestMethod"
            value={method}
            onChange={(e) => setMethod(e.target.value as LoanInterestMethod)}
            className={`${inputCls} w-36`}
          >
            {LOAN_INTEREST_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`method.${m}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('interestRate')}>
          <input
            name="interestRate"
            type="number"
            step="0.001"
            min="0"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            disabled={method === 'none'}
            className={`${inputCls} w-28 tabular-nums disabled:opacity-50`}
          />
        </Field>
        <Field label={t('durationMonths')}>
          <input
            name="durationMonths"
            type="number"
            step="1"
            min="1"
            required
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className={`${inputCls} w-28 tabular-nums`}
          />
        </Field>
        <Field label={t('startDate')}>
          <input name="startDate" type="date" required className={`${inputCls} w-40`} />
        </Field>
      </div>

      <Field label={t('notes')}>
        <input name="notes" className={`${inputCls} w-full`} placeholder={t('notesPlaceholder')} />
      </Field>

      {preview && (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <span className="text-muted-foreground">{t('previewInstalment')}: </span>
          <span className="font-semibold tabular-nums">RM {preview.instalment}</span>
          <span className="mx-2 text-muted-foreground">·</span>
          <span className="text-muted-foreground">{t('previewTotal')}: </span>
          <span className="font-semibold tabular-nums">RM {preview.total}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">{t('createButton')}</Button>
        <Link
          href={cancelHref}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('backToList')}
        </Link>
      </div>
    </form>
  );
}
