import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listEmployees } from '@/core/read';
import { getLoanWithSchedule } from '@/core/loans';
import { Button, Card, EmployeeName, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  amendLoanAction,
  cancelLoanAction,
  resumeLoanAction,
  settleLoanAction,
  suspendLoanAction,
} from '../actions';

/**
 * 6d72816e — the View / Edit page for ONE loan.
 *
 * WHAT IT REPLACES. All five lifecycle actions and the whole repayment schedule used to unfold INSIDE a
 * `<td colSpan={8}>` in the loan list. So the two things that most need room had the least: the sentence
 * that says what "Settle" actually does to an outstanding balance, and the schedule itself. Each action now
 * states its own consequence beside its own button, and the schedule is a table rather than a fold.
 *
 * THE READ IS MATCHED ON BOTH THE ID AND THE RESOLVED EMPLOYMENT. `?employmentId=` is scope-guarded against
 * this admin's own employee list, and the loan is then checked to belong to that employment — so a tampered
 * id 404s instead of quietly resolving onto somebody else's loan. RLS scopes the tenant; it does not decide
 * which employee a URL is allowed to name.
 *
 * EVERY ACTION RETURNS TO THE LIST, which is what the existing actions already did — this page keeps that
 * rather than "improving" it into a redirect back to a loan that may have just been settled or cancelled.
 * It carries `returnEmploymentId` so the list it returns to is the one narrowed to this employee.
 *
 * NOTHING ABOUT THE MONEY MOVED. amendLoan / suspendLoan / resumeLoan / settleLoan / cancelLoan are the
 * unchanged services (core/loans.ts, ADR-0060): the same guards, the same recomputation on the remaining
 * tail, the same domain events. This page only gives them somewhere legible to be invoked from.
 */
const money = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function LoanDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ employmentId?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('loans');
  const { id } = await params;
  const { employmentId, error } = await searchParams;

  const employees = await listEmployees(s);
  const emp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  if (!emp) notFound();

  const found = await getLoanWithSchedule(s, id);
  // BOTH halves, not either: a visible loan that belongs to a DIFFERENT employment must 404 here rather
  // than render under this employee's name.
  if (!found || found.loan.employmentId !== emp.employmentId) notFound();
  const { loan, schedule } = found;

  const backHref = `/admin/loans?employmentId=${encodeURIComponent(emp.employmentId)}`;
  const live = loan.status === 'active' || loan.status === 'suspended';
  const remaining = Math.max(0, loan.durationMonths - loan.instalmentsPaid);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: t('title') }}
        title={`${t(`loanType.${loan.loanType}`)} · ${money(loan.principal)}`}
        description={t('detailSubtitle')}
      />

      <ErrorBanner message={error} />

      {/* Employee + the figures that are NOT editable here, stated as facts rather than disabled inputs. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <EmployeeName code={emp.employeeCode} name={emp.name} className="text-sm font-semibold text-foreground" />
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {emp.company} · {emp.department ?? '—'} · {emp.position ?? '—'}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {t('colStatus')}{' '}
            <span className="font-medium text-foreground">{t(`status.${loan.status}`)}</span>
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">{t('colPrincipal')}</dt>
            <dd className="font-medium tabular-nums">{money(loan.principal)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('colInstalment')}</dt>
            <dd className="font-medium tabular-nums">{money(loan.monthlyInstalment)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('colOutstanding')}</dt>
            <dd className="font-medium tabular-nums">{money(loan.outstandingBalance)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('colProgress')}</dt>
            <dd className="font-medium tabular-nums">
              {loan.instalmentsPaid}/{loan.durationMonths}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('startDate')}</dt>
            <dd className="font-medium tabular-nums">{loan.startDate}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('interestMethod')}</dt>
            <dd className="font-medium">{t(`method.${loan.interestMethod}`)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('interestRate')}</dt>
            <dd className="font-medium tabular-nums">{loan.interestRate.toFixed(3)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('previewTotal')}</dt>
            <dd className="font-medium tabular-nums">{money(loan.totalRepayable)}</dd>
          </div>
          <div className="col-span-2 sm:col-span-4">
            <dt className="text-xs text-muted-foreground">{t('notes')}</dt>
            <dd className="font-medium">{loan.notes ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      {/* ── Amend: the terms, recomputed over the REMAINING tail ── */}
      {live && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('amend')} />
          <form action={amendLoanAction} className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            <input type="hidden" name="loanId" value={loan.id} />
            <input type="hidden" name="returnEmploymentId" value={emp.employmentId} />
            <Field label={t('durationMonths')}>
              <input
                name="durationMonths"
                type="number"
                min="1"
                defaultValue={loan.durationMonths}
                className={`${inputCls} tabular-nums`}
              />
            </Field>
            <Field label={t('interestRate')}>
              <input
                name="interestRate"
                type="number"
                step="0.001"
                min="0"
                defaultValue={loan.interestRate}
                className={`${inputCls} tabular-nums`}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('notes')}>
                <input name="notes" type="text" defaultValue={loan.notes ?? ''} className={inputCls} />
              </Field>
            </div>
            {/* The sentence that had no room inside a table cell: an amendment does NOT rewrite what has
                already been deducted. Only the still-scheduled instalments are rebuilt, and they are
                rebuilt to sum to the CURRENT outstanding balance — not the original principal. */}
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {t('amendHint', { remaining, outstanding: money(loan.outstandingBalance) })}
            </p>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <Button type="submit" size="sm">
                {t('amend')}
              </Button>
              <Link
                href={backHref}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {t('backToList')}
              </Link>
            </div>
          </form>
        </Card>
      )}

      {/* ── Lifecycle: one block per action, each saying what it does before it is pressed ── */}
      {live && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('lifecycleTitle')} />
          <div className="divide-y divide-border">
            {loan.status === 'active' && (
              <div className="space-y-2 p-4">
                <p className="text-sm font-medium">{t('suspend')}</p>
                <p className="text-xs text-muted-foreground">{t('suspendHint')}</p>
                <form action={suspendLoanAction}>
                  <input type="hidden" name="loanId" value={loan.id} />
                  <input type="hidden" name="returnEmploymentId" value={emp.employmentId} />
                  <Button type="submit" size="sm" variant="secondary">
                    {t('suspend')}
                  </Button>
                </form>
              </div>
            )}

            {loan.status === 'suspended' && (
              <div className="space-y-2 p-4">
                <p className="text-sm font-medium">{t('resume')}</p>
                <p className="text-xs text-muted-foreground">{t('resumeHint')}</p>
                <form action={resumeLoanAction}>
                  <input type="hidden" name="loanId" value={loan.id} />
                  <input type="hidden" name="returnEmploymentId" value={emp.employmentId} />
                  <Button type="submit" size="sm" variant="secondary">
                    {t('resume')}
                  </Button>
                </form>
              </div>
            )}

            <div className="space-y-2 p-4">
              <p className="text-sm font-medium">{t('settle')}</p>
              <p className="text-xs text-muted-foreground">{t('settleHint')}</p>
              <form action={settleLoanAction}>
                <input type="hidden" name="loanId" value={loan.id} />
                <input type="hidden" name="returnEmploymentId" value={emp.employmentId} />
                <ConfirmSubmit
                  size="sm"
                  title={t('settle')}
                  description={t('settleConfirm', { outstanding: money(loan.outstandingBalance) })}
                  confirmLabel={t('settle')}
                >
                  {t('settle')}
                </ConfirmSubmit>
              </form>
            </div>

            {loan.instalmentsPaid === 0 && (
              <div className="space-y-2 p-4">
                <p className="text-sm font-medium">{t('cancel')}</p>
                <p className="text-xs text-muted-foreground">{t('cancelHint')}</p>
                <form action={cancelLoanAction}>
                  <input type="hidden" name="loanId" value={loan.id} />
                  <input type="hidden" name="returnEmploymentId" value={emp.employmentId} />
                  <ConfirmSubmit
                    size="sm"
                    title={t('cancel')}
                    description={t('cancelConfirm')}
                    confirmLabel={t('cancel')}
                  >
                    {t('cancel')}
                  </ConfirmSubmit>
                </form>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── The repayment schedule: what is due, what was actually taken, and what is still to come ── */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('scheduleTitle')} count={schedule.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('seq')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('due')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('applied')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {schedule.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 tabular-nums">{r.sequenceNo}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(r.dueAmount)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {r.appliedAmount > 0 ? money(r.appliedAmount) : '—'}
                  </td>
                  <td className="px-4 py-2">{t(`repaymentStatus.${r.status}`)}</td>
                </tr>
              ))}
              {schedule.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    {t('scheduleEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
