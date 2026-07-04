import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, batchInputRows, leaverAdvisory } from '@/core/payroll';
import { loanSummaryForBatch } from '@/core/loans';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { closeAction, generateAction, prefillClaimsAction, prefillFixedZakatAction, prefillLoansAction, prefillOvertimeAction, prefillShiftDifferentialAction } from '../actions';
import { ComponentImport } from './component-import';
import { OtInputRow } from './ot-input-row';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; from?: string; hw?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  const { batchId } = await params;
  const { error, from, hw } = await searchParams;
  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;
  const totals = (batch.totals ?? {}) as Record<string, number>;
  const inputs = batch.status === 'draft' ? await batchInputRows(s, batchId) : [];
  const leavers = batch.status === 'draft' ? await leaverAdvisory(s, batchId) : [];
  // 1.2.8 (ADR-0060): loan deductions are RESERVED onto a regular draft run only; show the running summary.
  const isRegular = batch.runType === 'regular';
  const loanSummary = batch.status === 'draft' && isRegular ? await loanSummaryForBatch(s, batchId) : { loans: 0, total: 0 };
  const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
  const periodDays = new Date(pYear, pMonth, 0).getDate(); // calendar days in the pay period
  // Bulk component import (1D) is only meaningful when the kernel reads typed components.
  const typedComponentsOn = process.env.TYPED_PAY_COMPONENTS_ENABLED === 'true';
  // Payroll Process wizard: this draft is presented as "Step 3 of 3" when it arrived straight from the
  // wizard's terminal create action. A compact one-shot holiday-warning code list rides the query string
  // ('country|state|year|loaded|required' ';'-joined) — the domain event appended in createBatch is the
  // durable record; this is only shown for this one render right after creation.
  const fromWizard = from === 'process' && batch.status === 'draft';
  const holidayWarnings = hw
    ? hw.split(';').map((code) => {
        const [country, state, year, loaded, required] = code.split('|');
        return { country, state: state || null, year, loaded, required };
      })
    : [];
  const scope = (batch.scope ?? null) as { departmentIds?: string[]; employmentIds?: string[] } | null;
  const isScoped = !!(scope?.departmentIds?.length || scope?.employmentIds?.length);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/payroll', label: t('back') }}
        title={batch.payPeriod}
        description={
          <>
            {fromWizard ? `${t('step3Title')} · ` : ''}
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

      {batch.status === 'draft' && (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 divide-x divide-border sm:grid-cols-4">
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryPeriod')}</div>
              <div className="text-sm font-medium">{batch.payPeriod}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryCycle')}</div>
              <div className="text-sm font-medium">{t(`runType.${batch.runType}`)}{batch.remarks ? ` — ${batch.remarks}` : ''}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryPaymentDate')}</div>
              <div className="text-sm font-medium">{batch.batchDate}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryHeadcount')}</div>
              <div className="text-sm font-medium">{inputs.length}</div>
            </div>
          </div>
        </Card>
      )}

      {holidayWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          {holidayWarnings.map((w, i) => (
            <div key={i}>{t('holidayWarning', { country: w.country, state: w.state || '—', year: w.year, loaded: w.loaded, required: w.required })}</div>
          ))}
        </div>
      )}

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
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
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
                  <td className="px-4 py-2.5">
                    <EmployeeCode code={l.employeeCode} />
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    {l.name}
                    {/* ADR-0069: badge the source of annualBalance/suggested — a frozen resignation-
                        approval snapshot wins over the live ledger balance when one exists. */}
                    {l.encashmentSource === 'frozen_snapshot' && (
                      <span
                        className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                        title={l.frozenAsOf ? t('encashmentFrozenAsOfTitle', { date: l.frozenAsOf }) : undefined}
                      >
                        {l.overridden ? t('encashmentOverriddenBadge') : t('encashmentFrozenBadge')}
                      </span>
                    )}
                  </td>
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
          <div className="mx-4 mt-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
            <div className="mb-1.5 text-xs font-semibold text-foreground">{t('consolidateTitle')}</div>
            <p className="text-xs text-muted-foreground">
              {t.rich('prefillHint', {
                strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </p>
            {isScoped && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('scopedCaption')}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
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
              {/* 1.2.8 Loan deductions — reserve onto a regular draft run only (ADR-0060). */}
              {isRegular && (
                <form action={prefillLoansAction} className="flex items-center gap-2">
                  <input type="hidden" name="batchId" value={batch.id} />
                  <Button type="submit" size="sm" variant="secondary">
                    {t('prefillLoans')}
                  </Button>
                  {loanSummary.loans > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t('loanSummary', {
                        count: loanSummary.loans,
                        amount: loanSummary.total.toLocaleString('en-MY', { minimumFractionDigits: 2 }),
                      })}
                    </span>
                  )}
                </form>
              )}
              <form action={prefillShiftDifferentialAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillShiftDiff')}
                </Button>
              </form>
              <form action={prefillFixedZakatAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillFixedZakat')}
                </Button>
              </form>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colBasic')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colOtBonusTp1Zakat')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colUnpaidDays')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inputs.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5">
                      <EmployeeCode code={r.employeeCode} />
                    </td>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(r.basic)}</td>
                    <td className="px-4 py-2.5">
                      {/* Fix-5: manual OT (RM you enter) with the s.60I(1A) ORP/hourly basis surfaced, a
                          >RM4,000 eligibility note, and a clobber warning before overwriting an
                          attendance-prefilled row. See ot-input-row.tsx. */}
                      <OtInputRow
                        batchId={batch.id}
                        row={{
                          employmentId: r.employmentId,
                          otBreakdown: r.otBreakdown,
                          otSource: r.otSource,
                          orp: r.orp,
                          hourly: r.hourly,
                          otEligible: r.otEligible,
                          otWageCeiling: r.otWageCeiling,
                          bonusAmount: r.bonusAmount,
                          tp1Deduction: r.tp1Deduction,
                          zakat: r.zakat,
                        }}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {r.unpaidDays > 0 ? r.unpaidDays : '—'}
                    </td>
                  </tr>
                ))}
                {inputs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noActiveEmployees')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {batch.status === 'draft' && typedComponentsOn && (
        <Card>
          <SectionHeader title={t('componentImport.title')} />
          <div className="px-4 pb-4">
            <p className="mb-3 text-xs text-muted-foreground">{t('componentImport.description')}</p>
            <ComponentImport batchId={batch.id} />
          </div>
        </Card>
      )}

      {batch.status !== 'draft' &&
        (() => {
          // HRD Corp levy is an employer-only cost; show its tile only when the company is registered.
          const tiles: [string, number][] = [
            ['totalGross', totals.gross],
            ['totalDeductions', totals.deductions],
            ['totalNet', totals.net],
          ];
          if (Number(totals.hrdfEmployer) > 0) tiles.push(['totalHrdf', totals.hrdfEmployer]);
          tiles.push(['totalEmployerCost', totals.employerCost]);
          return (
            <div
              className={`grid grid-cols-2 divide-x divide-border rounded-lg border border-border ${
                tiles.length === 5 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'
              }`}
            >
              {tiles.map(([key, v]) => (
                <div key={key} className="p-4">
                  <div className="text-xs text-muted-foreground">{t(key)}</div>
                  <div className="text-lg font-semibold tabular-nums">{rm(v)}</div>
                </div>
              ))}
            </div>
          );
        })()}

      <Card className="overflow-hidden">
        <SectionHeader title={t('payslipsTitle')} count={slips.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colGross')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colBonus')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEpf')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colSocso')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colSkbbk')}</th>
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
                    <td className="px-4 py-2.5">
                      <EmployeeCode code={sl.employeeCode} />
                    </td>
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
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.socsoSkbbk)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.eisEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.pcb)}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(sl.net)}</td>
                  </tr>
                );
              })}
              {slips.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
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
