import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, batchInputRows, leaverAdvisory } from '@/core/payroll';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { closeAction, generateAction, prefillClaimsAction, prefillOvertimeAction, setPayrollInputAction } from '../actions';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  const { batchId } = await params;
  const { error } = await searchParams;
  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;
  const totals = (batch.totals ?? {}) as Record<string, number>;
  const inputs = batch.status === 'draft' ? await batchInputRows(s, batchId) : [];
  const leavers = batch.status === 'draft' ? await leaverAdvisory(s, batchId) : [];
  const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
  const periodDays = new Date(pYear, pMonth, 0).getDate(); // calendar days in the pay period

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/payroll', label: t('back') }}
        title={batch.payPeriod}
        description={
          <>
            {t('subtitle')} · <span className="capitalize">{batch.status}</span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {batch.status !== 'draft' && (
              <a
                href={`/payroll/reports/payment-summary?batchId=${batch.id}`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                title={t('paymentSummaryTitle')}
              >
                ⬇ {t('paymentSummary')}
              </a>
            )}
            {batch.status === 'draft' && (
              <form action={generateAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit">{t('generatePayslips')}</Button>
              </form>
            )}
            {batch.status === 'processed' && (
              <form action={closeAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" variant="secondary">
                  {t('closeBatch')}
                </Button>
              </form>
            )}
          </div>
        }
      />

      <ErrorBanner message={error} />

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
        ⚠️{' '}
        {t.rich('disclaimer', {
          strong: (chunks) => <span className="font-medium">{chunks}</span>,
          mono: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </div>

      {batch.status === 'draft' && leavers.length > 0 && (
        <Card className="overflow-hidden border-blue-200 dark:border-blue-500/30">
          <SectionHeader title={t('leaversTitle')} count={leavers.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            {t.rich('leaversHint', {
              strong: (chunks) => <span className="font-medium">{chunks}</span>,
            })}
          </p>
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 font-medium">{t('colLastDay')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colUnusedAnnual')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colOrpPerDay')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colSuggestedInLieu')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leavers.map((l) => (
                <tr key={l.employmentId}>
                  <td className="px-4 py-2.5 font-medium">{l.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{l.terminatedOn}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{t('daysShort', { d: l.annualBalance })}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(l.basic / 26)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{rm(l.suggested)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {batch.status === 'draft' && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('inputsTitle')} count={inputs.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            {t('inputsHint')}
          </p>
          <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">
              {t.rich('prefillHint', {
                strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </p>
            <div className="flex items-center gap-2">
              <form action={prefillOvertimeAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillOt')}
                </Button>
              </form>
              <form action={prefillClaimsAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillClaims')}
                </Button>
              </form>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colBasic')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colOtBonusTp1Zakat')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colUnpaidDays')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inputs.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(r.basic)}</td>
                    <td className="px-4 py-2.5">
                      <form action={setPayrollInputAction} className="flex items-center justify-end gap-2">
                        <input type="hidden" name="batchId" value={batch.id} />
                        <input type="hidden" name="employmentId" value={r.employmentId} />
                        <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                          {t('fieldOt')}
                          <input
                            name="overtimeAmount"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={r.overtimeAmount}
                            className={`${inputCls} w-24 text-right`}
                          />
                        </label>
                        <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground">
                          {t('fieldBonus')}
                          <input
                            name="bonusAmount"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={r.bonusAmount}
                            className={`${inputCls} w-24 text-right`}
                          />
                        </label>
                        <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldTp1Title')}>
                          {t('fieldTp1')}
                          <input
                            name="tp1Deduction"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={r.tp1Deduction}
                            className={`${inputCls} w-20 text-right`}
                          />
                        </label>
                        <label className="flex items-center gap-1 text-[10px] uppercase text-muted-foreground" title={t('fieldZakatTitle')}>
                          {t('fieldZakat')}
                          <input
                            name="zakat"
                            type="number"
                            min="0"
                            step="0.01"
                            defaultValue={r.zakat}
                            className={`${inputCls} w-20 text-right`}
                          />
                        </label>
                        <Button type="submit" variant="secondary">
                          {t('save')}
                        </Button>
                      </form>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {r.unpaidDays > 0 ? r.unpaidDays : '—'}
                    </td>
                  </tr>
                ))}
                {inputs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noActiveEmployees')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {batch.status !== 'draft' && (
        <div className="grid grid-cols-2 divide-x divide-border rounded-lg border border-border sm:grid-cols-4">
          {(
            [
              ['totalGross', totals.gross],
              ['totalDeductions', totals.deductions],
              ['totalNet', totals.net],
              ['totalEmployerCost', totals.employerCost],
            ] as const
          ).map(([key, v]) => (
            <div key={key} className="p-4">
              <div className="text-xs text-muted-foreground">{t(key)}</div>
              <div className="text-lg font-semibold tabular-nums">{rm(v)}</div>
            </div>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title={t('payslipsTitle')} count={slips.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colGross')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colBonus')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEpf')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colSocso')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEis')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colPcb')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colNet')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {slips.map((sl) => {
                const st = sl.statutory as Record<string, number>;
                return (
                  <tr key={sl.id}>
                    <td className="px-4 py-2.5 font-medium">
                      {sl.name}
                      {sl.daysWorked != null && Number(sl.daysWorked) < periodDays && (
                        <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                          {t('proratedDays', { worked: Number(sl.daysWorked), total: periodDays })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rm(sl.gross)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {Number(sl.bonus) > 0 ? rm(sl.bonus) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.epfEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.socsoEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.eisEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.pcb)}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(sl.net)}</td>
                  </tr>
                );
              })}
              {slips.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noPayslips')}
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
