import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { listEmploymentPayComponents, listPayComponents, FIXED_TRANSACTION_CYCLES } from '@/core/pay-components';
import { Badge, Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { PayrollTabs } from '@/components/payroll-tabs';
import { EmployeePicker, type PickerEmployee } from './employee-picker';
import { FixedToolbar } from './add-fixed-dialog';
import {
  updateFixedTransactionAction,
  endFixedTransactionAction,
  archiveFixedTransactionAction,
} from './actions';

/**
 * Fixed Transaction (feedback b7fc8583) — a SELF-CONTAINED screen. Pick an employee (mandatory, via
 * ?employmentId=), then add a recurring fixed pay component directly here: pay item, Payroll Cycle, amount,
 * start/(optional)end date, remarks. The existing fixed transactions for the selected employee list below,
 * each marked active or ended. Writes route through the event-logged setEmploymentPayComponent — the SAME
 * aggregate the people-detail editor uses (that deep per-employee editor stays as the alternate entry point).
 *
 * The Payroll Cycle is captured + stored + shown but does NOT route which payroll run pays the item in this
 * build (payout follows the valid_from/valid_to window, exactly as recurring amounts work today). See the PR
 * scope note — steering payout by cycle is a deliberate follow-up that would touch payroll processing.
 */
export default async function FixedTransactionPage({
  searchParams,
}: {
  searchParams: Promise<{ employmentId?: string; error?: string; toast?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const { employmentId, error } = await searchParams;
  const typedComponentsOn = process.env.TYPED_PAY_COMPONENTS_ENABLED === 'true';

  const employees = await listEmployees(s, scopeIds);
  // SCOPE-GUARD the param (mirror individual/page.tsx line 36): the ?employmentId= must be in the admin's
  // scoped list. Company scope is an application concern (RLS only isolates tenants), so without this an
  // admin could cross-company read/write by URL tampering. An out-of-scope param is treated as no selection.
  const selected = employmentId && employees.some((e) => e.employmentId === employmentId) ? employmentId : null;
  const selectedEmp = selected ? employees.find((e) => e.employmentId === selected) ?? null : null;

  // Step-1 search/filter panel source (feedback ee21508c). Derive employment status ('active' when not
  // terminated, else 'ended') for the Status filter — matches the Individual Transaction wizard convention.
  const pickerEmployees: PickerEmployee[] = employees.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    employeeCode: e.employeeCode,
    company: e.company,
    companyId: e.companyId,
    department: e.department,
    departmentId: e.departmentId,
    businessUnit: e.businessUnit,
    businessUnitId: e.businessUnitId,
    status: e.terminatedOn == null ? 'active' : 'ended',
  }));

  const [components, existing] = selected
    ? await Promise.all([listPayComponents(s), listEmploymentPayComponents(s, selected)])
    : [[], []];
  const activeComponents = components.filter((c) => c.archivedAt == null);

  const today = new Date().toISOString().slice(0, 10);
  // Friendly error keys thrown by the action → localised; anything else is a raw message.
  const errorKeys = new Set(['dateError', 'currencyUnsupported', 'amountError', 'required', 'outOfScope', 'notFound']);
  const errorMessage = error && errorKeys.has(error) ? t(`fixed.${error}`) : error;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/payroll/transactions', label: t('title') }}
        title={t('fixed.title')}
        description={t('fixed.subtitle')}
      />
      <PayrollTabs active="transactions" />

      {!typedComponentsOn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">{t('gatedTitle')}</p>
          <p className="mt-1 text-xs">{t('gatedBody')}</p>
        </div>
      )}

      <ErrorBanner message={errorMessage} />

      <Card className="p-4">
        <h2 className="text-sm font-medium">{t('fixed.pickEmployee')}</h2>
        {employees.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t('fixed.empty')}</p>
        ) : (
          <div className="mt-3">
            <EmployeePicker employees={pickerEmployees} selectedId={selected} />
          </div>
        )}
      </Card>

      {selectedEmp && (
        <>
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
                <span>
                  {t('fixed.employeeId')}:{' '}
                  <span className="font-medium text-foreground">{selectedEmp.employeeCode ?? '—'}</span>
                </span>
                <span>
                  {t('fixed.employeeName')}:{' '}
                  <span className="font-medium text-foreground">{selectedEmp.name}</span>
                </span>
              </div>
              <FixedToolbar
                employmentId={selected!}
                defaultStart={selectedEmp.hiredOn}
                components={activeComponents.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
                cycles={FIXED_TRANSACTION_CYCLES}
              />
            </div>
          </Card>

          <Card className="overflow-hidden">
            <SectionHeader title={t('fixed.title')} count={existing.length} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('fixed.payrollItem')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('fixed.amount')}</th>
                    <th className="px-4 py-2 font-medium">{t('fixed.payrollCycle')}</th>
                    <th className="px-4 py-2 font-medium">{t('fixed.startDate')}</th>
                    <th className="px-4 py-2 font-medium">{t('fixed.endDate')}</th>
                    <th className="px-4 py-2 font-medium">{t('fixed.status')}</th>
                    <th className="px-4 py-2 text-right font-medium">{t('fixed.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {existing.map((r) => {
                    // ENDED once the inclusive end-date is in the past; otherwise ACTIVE.
                    const ended = r.validTo != null && r.validTo < today;
                    return (
                      <tr key={r.id}>
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-xs">{r.code}</span>{' '}
                          <span className="text-muted-foreground">{r.name}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums">{Number(r.amount).toFixed(2)}</td>
                        <td className="px-4 py-2.5">
                          {/* Legacy + people-editor rows have null run_type → show "unspecified". New writes
                              from this screen always carry a cycle (the select is required). */}
                          {r.runType ? t(`individual.cycle.${r.runType}`) : t('fixed.cycleUnspecified')}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{r.validFrom}</td>
                        <td className="px-4 py-2.5 tabular-nums">{r.validTo ?? '—'}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant={ended ? 'default' : 'success'}>
                            {ended ? t('fixed.statusEnded') : t('fixed.statusActive')}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          {/* Full lifecycle maintenance (feedback 1e2704f2): Edit (versions the value from a
                              new effective date), Stop (end-date it — keeps paying through, then drops from
                              payroll), Remove (void — excluded from payroll and hidden). Mirrors the proven
                              Individual page pattern. */}
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <details className="group">
                              <summary className="cursor-pointer list-none rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted">
                                {t('fixed.edit')}
                              </summary>
                              <form
                                action={updateFixedTransactionAction}
                                className="mt-2 grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/30 p-3 text-left"
                              >
                                <input type="hidden" name="employmentId" value={selected!} />
                                <input type="hidden" name="id" value={r.id} />
                                <label className="text-[10px] uppercase text-muted-foreground">
                                  {t('fixed.amount')}
                                  <input name="amount" type="number" min="0.01" step="0.01" defaultValue={r.amount} className={`${inputCls} text-right`} />
                                </label>
                                <label className="text-[10px] uppercase text-muted-foreground">
                                  {t('fixed.payrollCycle')}
                                  <select name="runType" defaultValue={r.runType ?? ''} className={inputCls}>
                                    <option value="">—</option>
                                    {FIXED_TRANSACTION_CYCLES.map((c) => (
                                      <option key={c} value={c}>
                                        {t(`individual.cycle.${c}`)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="text-[10px] uppercase text-muted-foreground">
                                  {t('fixed.startDate')}
                                  <input name="effectiveFrom" type="date" defaultValue={r.validFrom} className={inputCls} />
                                </label>
                                <label className="text-[10px] uppercase text-muted-foreground">
                                  {t('fixed.endDate')}
                                  <input name="effectiveTo" type="date" defaultValue={r.validTo ?? ''} className={inputCls} />
                                </label>
                                <label className="col-span-2 text-[10px] uppercase text-muted-foreground">
                                  {t('fixed.remarks')}
                                  <input name="remarks" type="text" defaultValue={r.remarks ?? ''} className={inputCls} />
                                </label>
                                <p className="col-span-2 text-[10px] text-muted-foreground">{t('fixed.editHint')}</p>
                                <div className="col-span-2 flex justify-end">
                                  <Button type="submit" size="sm">
                                    {t('fixed.save')}
                                  </Button>
                                </div>
                              </form>
                            </details>
                            {!ended && (
                              <details className="group">
                                <summary className="cursor-pointer list-none rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted">
                                  {t('fixed.stop')}
                                </summary>
                                <form
                                  action={endFixedTransactionAction}
                                  className="mt-2 grid gap-2 rounded-md border border-border bg-muted/30 p-3 text-left"
                                >
                                  <input type="hidden" name="employmentId" value={selected!} />
                                  <input type="hidden" name="id" value={r.id} />
                                  <label className="text-[10px] uppercase text-muted-foreground">
                                    {t('fixed.stopDate')}
                                    <input name="effectiveTo" type="date" required min={r.validFrom} defaultValue={today} className={inputCls} />
                                  </label>
                                  <p className="text-[10px] text-muted-foreground">{t('fixed.stopHint')}</p>
                                  <div className="flex justify-end">
                                    <Button type="submit" size="sm" variant="secondary">
                                      {t('fixed.stopConfirm')}
                                    </Button>
                                  </div>
                                </form>
                              </details>
                            )}
                            <form action={archiveFixedTransactionAction}>
                              <input type="hidden" name="employmentId" value={selected!} />
                              <input type="hidden" name="id" value={r.id} />
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
                        </td>
                      </tr>
                    );
                  })}
                  {existing.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                        {t('fixed.noTransactions')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
