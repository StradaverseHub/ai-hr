import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { getEmploymentPayComponent } from '@/core/pay-components';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { Badge, Button, Card, EmployeeName, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { formatMoney } from '@/lib/money';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { updateFixedTransactionAction, endFixedTransactionAction, archiveFixedTransactionAction } from '../actions';
import { FixedCycleSelect, type FixedCycleOption } from '../cycle-select';

/**
 * f3ae3245 — the dedicated View/Edit page for ONE recurring fixed pay item.
 *
 * WHAT IT REPLACES. Edit used to unfold a `<details>` form INSIDE the Action cell of the row you clicked,
 * so the operator typed an amount, a cycle, two dates and a remark into boxes wedged into a table cell,
 * with the one sentence that explains what Save actually does printed at 10px beside the button. That
 * sentence is the most important thing on this screen and it had the least room.
 *
 * THE TRAP THIS PAGE IS BUILT AROUND: THE ID YOU OPENED IS NOT THE ID THAT COMES BACK.
 * `updateEmploymentPayComponent` does NOT update. The aggregate is effective-dated and supersede-on-write:
 * an edit re-invokes the `set` path from the new effective date, which CLOSES the row you were editing at
 * that date and INSERTS a new one (core/pay-components.ts). So after a successful Save this row's id
 * describes a closed historical value, and re-rendering this page against it would show a stale record and
 * invite a second edit of a row that no longer applies. Every action here therefore returns to the LIST,
 * which is what the existing actions already do — this page keeps that rather than "improving" it into a
 * redirect back to an id that has been superseded.
 *
 * WHY THE PAY ITEM IS NOT EDITABLE HERE. The service resolves `componentId` FROM THE ROW precisely so a
 * tampered id cannot retarget the write onto a different pay item. Rendering it as a picker would offer a
 * change the service is designed to refuse. Changing which item an employee is paid is adding one and
 * ending the other, which is what Add and Stop are for.
 *
 * Read is `getEmploymentPayComponent`, matched on BOTH id and employmentId and excluding superseded rows,
 * so a URL to a removed item is a 404 rather than a resurrection.
 */
export default async function FixedTransactionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    employmentId?: string;
    error?: string;
    // 2aed39d4 — the clashing record's identity, carried beside the error key so the banner can name it.
    clashCode?: string;
    clashFrom?: string;
    clashTo?: string;
    clashPeriod?: string;
    // a3d485f6 — the first-of-month the mid-month refusal offers instead.
    nextFirst?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { id } = await params;
  const { employmentId, error, clashCode, clashFrom, clashTo, clashPeriod, nextFirst } = await searchParams;

  // Scope-guard the employment exactly as the list does: RLS isolates tenants, company scope does not
  // travel with it, so an out-of-scope (or absent) employmentId is simply not found.
  const employees = await listEmployees(s, scopeIds);
  const emp = employmentId ? (employees.find((e) => e.employmentId === employmentId) ?? null) : null;
  if (!emp) notFound();

  const row = await getEmploymentPayComponent(s, { id, employmentId: emp.employmentId });
  if (!row) notFound();

  // 4fffe638 — the employee's OWN company's active configured cycles, in the Payroll Cycles order. A row
  // linked to a cycle since made inactive shows that cycle as the selected option, marked inactive, so an
  // untouched save keeps it (it is not offered to anyone choosing afresh). An unlinked row that carries an
  // old run-type tag shows that label as the placeholder; the untouched save keeps the tag.
  const activeCycles = await listPayrollCycles(s, emp.companyId, { activeOnly: true });
  const cycleOptions: FixedCycleOption[] = activeCycles.map((c) => ({ id: c.id, label: c.name }));
  if (row.payrollCycleId && !activeCycles.some((c) => c.id === row.payrollCycleId)) {
    cycleOptions.unshift({
      id: row.payrollCycleId,
      label: t('fixed.cycleInactive', { name: row.payrollCycleName ?? '—' }),
    });
  }
  const cyclePlaceholder =
    !row.payrollCycleId && row.runType ? t(`individual.cycle.${row.runType}` as never) : '—';

  const today = todayInKualaLumpur();
  const ended = row.validTo != null && row.validTo < today;
  const backHref = `/payroll/transactions/fixed?employmentId=${encodeURIComponent(emp.employmentId)}`;

  const errorKeys = new Set([
    'dateError',
    'currencyUnsupported',
    'amountError',
    'required',
    'outOfScope',
    'notFound',
    'paidOnPayslip',
    // 2aed39d4 — the two overlap refusals. Both take the clashing record's identity as ICU arguments;
    // a bare key would render "{code}" on screen.
    'overlap',
    'backwards',
    // a3d485f6 — the mid-month refusal, same contract: it renders "{code}" and "{nextFirst}".
    'midMonth',
    // 4fffe638 — the chosen Payroll Cycle is missing, inactive or another company's.
    'cycleInvalid',
  ]);
  // The clash arguments are passed to EVERY key rather than only to the ones that use them: next-intl
  // ignores unused arguments, and branching here would mean a second place to update when a message
  // starts naming the record. `—` rather than an empty string so a missing param is visible, not blank.
  const errorMessage =
    error && errorKeys.has(error)
      ? t(`fixed.${error}`, {
          code: clashCode ?? '—',
          from: clashFrom ?? '—',
          to: clashTo ?? t('fixed.openEnded'),
          period: clashPeriod ?? '—',
          nextFirst: nextFirst ?? '—',
        })
      : error;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        back={{ href: backHref, label: t('fixed.title') }}
        title={`${row.code} — ${row.name}`}
        description={t('fixed.detailSubtitle')}
      />

      <ErrorBanner message={errorMessage} />

      {/* Employee + the facts that are NOT editable here, stated as facts rather than as disabled inputs. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <EmployeeName code={emp.employeeCode} name={emp.name} className="text-sm font-semibold text-foreground" />
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {emp.company} · {emp.department ?? '—'} · {emp.position ?? '—'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              {t('fixed.currentAmount')}{' '}
              <span className="font-medium tabular-nums text-foreground">
                {formatMoney(row.amount, row.currency ?? null)}
              </span>
            </span>
            <span className="text-muted-foreground">
              {t('fixed.status')}{' '}
              <Badge variant={ended ? 'default' : 'success'}>
                {ended ? t('fixed.statusEnded') : t('fixed.statusActive')}
              </Badge>
            </span>
          </div>
        </div>
      </Card>

      {/* ── THE VERSIONING STATEMENT, given the room it never had ── */}
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
        <p className="font-medium">{t('fixed.versioningTitle')}</p>
        <p className="mt-1 text-xs">{t('fixed.versioningBody')}</p>
      </div>

      <Card className="overflow-hidden">
        <SectionHeader title={t('fixed.edit')} />
        <form action={updateFixedTransactionAction} className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="id" value={row.id} />
          <Field label={t('fixed.amount')} required requiredAriaLabel={t('fixed.requiredField')}>
            <input
              name="amount"
              type="number"
              min="0.01"
              step="0.01"
              required
              defaultValue={row.amount}
              className={`${inputCls} text-right`}
            />
          </Field>
          <Field label={t('fixed.payrollCycle')}>
            <FixedCycleSelect
              options={cycleOptions}
              defaultValue={row.payrollCycleId ?? ''}
              placeholderLabel={cyclePlaceholder}
            />
          </Field>
          <Field label={t('fixed.startDate')} required requiredAriaLabel={t('fixed.requiredField')}>
            <input name="effectiveFrom" type="date" required defaultValue={row.validFrom} className={inputCls} />
          </Field>
          <Field label={t('fixed.endDate')}>
            <input name="effectiveTo" type="date" defaultValue={row.validTo ?? ''} className={inputCls} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('fixed.remarks')}>
              <input name="remarks" type="text" defaultValue={row.remarks ?? ''} className={inputCls} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" size="sm">
              {t('fixed.save')}
            </Button>
            <Link
              href={backHref}
              className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t('fixed.cancel')}
            </Link>
          </div>
        </form>
      </Card>

      {/* ── Stop from a date: the correct action for an item that should simply stop paying ── */}
      {!ended && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('fixed.stop')} />
          <form action={endFixedTransactionAction} className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="id" value={row.id} />
            <Field label={t('fixed.stopDate')} required requiredAriaLabel={t('fixed.requiredField')}>
              <input
                name="effectiveTo"
                type="date"
                required
                min={row.validFrom}
                defaultValue={today}
                className={inputCls}
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" size="sm" variant="secondary">
                {t('fixed.stopConfirm')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('fixed.stopHint')}</p>
          </form>
        </Card>
      )}

      {/* ── Remove: refused by the service when the item has been paid on a processed payslip (f1123afd) ── */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('fixed.delete')} />
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">{t('fixed.deleteHint')}</p>
          <form action={archiveFixedTransactionAction}>
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="id" value={row.id} />
            <ConfirmSubmit
              size="sm"
              title={t('fixed.deleteTitle')}
              description={t('fixed.deleteBody')}
              confirmLabel={t('fixed.delete')}
            >
              {t('fixed.delete')}
            </ConfirmSubmit>
          </form>
        </div>
      </Card>
    </div>
  );
}
