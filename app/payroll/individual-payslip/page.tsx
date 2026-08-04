/**
 * Feedback 169e3c24 — Individual Payslip: one named place to review, verify, print and download an
 * employee's payslip BEFORE it is released.
 *
 * REPRODUCED FIRST, AND THE FINDING WAS "adjacent screen". Most of what the ticket asks for already
 * shipped — the itemised admin breakdown lives on Transaction View → History, deliberately without the
 * ESS release gate so a processed-but-unreleased run can be inspected. What was genuinely missing:
 *   1. an entry point. Nothing in the menu said "payslip", so almost nobody found it.
 *   2. print / PDF BEFORE release. The existing PDF route reads through payslipDetail, whose release gate
 *      returns null until the batch is closed AND released — exactly backwards for a reviewer.
 *   3. year-to-date beside the current month.
 *   4. any explanation of the PCB figure, whose every input has been persisted (`pcbMeta`) and displayed
 *      nowhere since it was introduced.
 *
 * SO THIS SCREEN BORROWS RATHER THAN REBUILDS. The earnings / deductions / employer-contribution
 * derivation is `deriveHistoryBreakdown`, the same function History renders, so the two screens cannot
 * drift apart about one payslip's figures.
 *
 * THE RELEASE GATE IS NOT TOUCHED. `payslipDetail` keeps its gate for ESS; this screen and its PDF read
 * through `payslipForReview`, an admin read fenced on the caller's authorised companyIds. Different read,
 * different fence — the gate is not weakened, parameterised or bypassed.
 *
 * READ-ONLY END TO END. No row is inserted, updated, deleted or recomputed, and no employee-visible
 * figure changes.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees, listCompanies } from '@/core/read';
import { currentPcbReliefs, listProcessedPayslipsAcross, payslipForReview } from '@/core/payroll-view';
import { explainPcb } from '@/core/pcb-explain';
import { payslipEmployerBorne, type EmployerBorneKey } from '@/core/payslip-employer-borne';
import { payrollPublicationState, PAYROLL_PUBLICATION_PILL } from '@/lib/payroll-publication';
import { payslipProvenance } from '@/core/payslip-recompute';
import { formatMoney } from '@/lib/money';
import { employeeLabel } from '@/lib/employee-code';
import { packFor } from '@/localization/registry';
import { Button, Card, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { deriveHistoryBreakdown } from '../transaction-view/history-breakdown';

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;
const CYCLES = ['regular', 'off_cycle', 'bonus', 'adjustment'] as const;

/** Parse an optional positive-int query param within [min, max]; anything else ⇒ undefined. */
function intParam(v: string | undefined, min: number, max: number): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** The label key for each employer-borne component, exhaustive over EmployerBorneKey. */
const EMPLOYER_BORNE_LABEL: Record<EmployerBorneKey, 'epf' | 'socso' | 'skbbk' | 'eis' | 'pcb'> = {
  epf: 'epf', socso: 'socso', skbbk: 'skbbk', eis: 'eis', tax: 'pcb',
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value || '—'}</dd>
    </div>
  );
}

export default async function IndividualPayslipPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    employmentId?: string;
    year?: string;
    month?: string;
    cycle?: string;
    payslipId?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.individualPayslip');
  const tSlip = await getTranslations('me.payslip');
  const tTxn = await getTranslations('payroll.transactions');
  const sp = await searchParams;

  const [employees, companies] = await Promise.all([listEmployees(s, scopeIds), listCompanies(s)]);
  const scopedCompanies = companies.filter((c) => scopeIds.includes(c.id));

  // SCOPE-GUARD every ?param, exactly as Transaction View does: an out-of-scope companyId/employmentId is
  // treated as "no selection", so URL tampering can only ever narrow, never widen.
  const companyId = sp.companyId && scopeIds.includes(sp.companyId) ? sp.companyId : undefined;
  const companyIds = companyId ? [companyId] : scopeIds;
  const employmentId =
    sp.employmentId && employees.some((e) => e.employmentId === sp.employmentId) ? sp.employmentId : undefined;
  const year = intParam(sp.year, 2000, 2100);
  const month = intParam(sp.month, 1, 12);
  const cycle = CYCLES.includes(sp.cycle as (typeof CYCLES)[number]) ? sp.cycle : undefined;

  const nowYear = new Date().getFullYear();
  const years = Array.from({ length: 11 }, (_, i) => nowYear + 1 - i);

  // A payslip only loads once an EMPLOYEE is chosen — the ticket's flow (period → employee → payslip),
  // and also what keeps this screen from becoming a second, slower copy of History.
  const matches = employmentId
    ? await listProcessedPayslipsAcross(s, { companyIds, year, month, employmentId, cycle, limit: 25 })
    : [];
  // The chosen run, or the most recent match. A tampered payslipId simply does not match.
  const chosen = sp.payslipId ? matches.find((r) => r.id === sp.payslipId) : matches[0];

  const row = chosen ? await payslipForReview(s, { companyIds, payslipId: chosen.id }) : null;

  // Year-to-date: the same read for the whole year, no month. No new query shape is needed — the totals
  // are summed from the rows it already returns, so YTD can never disagree with the months it lists.
  const ytdRows =
    row && employmentId
      ? await listProcessedPayslipsAcross(s, {
          companyIds,
          year: Number(row.payPeriod.slice(0, 4)),
          employmentId,
        })
      : [];
  const num = (v: unknown) => Number(v ?? 0);
  const ytd = ytdRows.reduce(
    (acc, r) => {
      const st = (r.statutory ?? {}) as Record<string, unknown>;
      return {
        gross: acc.gross + num(r.gross),
        epf: acc.epf + num(st.epfEmployee),
        socso: acc.socso + num(st.socsoEmployee),
        eis: acc.eis + num(st.eisEmployee),
        pcb: acc.pcb + num(st.pcb),
        net: acc.net + num(r.net),
      };
    },
    { gross: 0, epf: 0, socso: 0, eis: 0, pcb: 0, net: 0 },
  );

  const b = row ? deriveHistoryBreakdown(row) : null;
  const eb = row ? payslipEmployerBorne(row.statutory) : null;
  // The PCB working. The relief FALLBACK is only consulted for a payslip calculated before the working
  // was recorded on the slip itself, and `explainPcb` reports which of the two it used so the panel can
  // say so on screen.
  const fallbackReliefs = row
    ? await currentPcbReliefs(s, {
        companyIds,
        employmentId: row.employmentId,
        asOf: `${row.payPeriod}-28`,
      })
    : null;
  const pcb = row ? explainPcb(row.statutory, fallbackReliefs) : null;
  const prov = row ? payslipProvenance(row.statutory) : null;
  const cur = row?.currency ?? null;
  const rm = (n: unknown) => formatMoney(n, cur);
  const hrdfRegistered = row
    ? ((await packFor('MY')?.companyStatutory.list(s)) ?? [])
        .filter((r) => r.hrdfStatus !== 'not_registered')
        .some((r) => r.companyId === row.companyId)
    : false;

  const pubState = row ? payrollPublicationState({ status: row.batchStatus, releasedAt: row.releasedAt }) : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="print:hidden">
        <PageHeader title={t('title')} description={t('subtitle')} />
      </div>

      {/* ── Selection (GET form — pure navigation, no mutation) ── */}
      <Card className="p-4 print:hidden">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <Field label={t('filterCompany')}>
            <select name="companyId" defaultValue={companyId ?? ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {scopedCompanies.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterYear')}>
            <select name="year" defaultValue={year != null ? String(year) : ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterMonth')}>
            <select name="month" defaultValue={month != null ? String(month).padStart(2, '0') : ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {MONTHS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterCycle')}>
            <select name="cycle" defaultValue={cycle ?? ''} className={inputCls}>
              <option value="">{tTxn('view.filters.all')}</option>
              {CYCLES.map((c) => (
                <option key={c} value={c}>{tTxn(`individual.cycle.${c}`)}</option>
              ))}
            </select>
          </Field>
          <Field label={t('filterEmployee')}>
            <select name="employmentId" defaultValue={employmentId ?? ''} className={inputCls}>
              <option value="">{t('chooseEmployee')}</option>
              {employees.map((e) => (
                <option key={e.employmentId} value={e.employmentId}>
                  {employeeLabel(e.employeeCode, e.name)} · {e.company}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="secondary">
            {tTxn('view.filters.apply')}
          </Button>
        </form>
      </Card>

      {!employmentId && <p className="text-sm text-muted-foreground">{t('chooseEmployeeHint')}</p>}
      {employmentId && !row && <p className="text-sm text-muted-foreground">{t('noPayslip')}</p>}

      {/* More than one run in the selected window (a regular plus a bonus cycle, or a re-issue): offer
          them rather than silently showing the newest. */}
      {matches.length > 1 && (
        <Card className="p-4 print:hidden">
          <SectionHeader title={t('otherRuns')} count={matches.length} />
          <div className="flex flex-wrap gap-2 pt-2">
            {matches.map((m) => (
              <Link
                key={m.id}
                href={`/payroll/individual-payslip?${new URLSearchParams({
                  ...(companyId ? { companyId } : {}),
                  ...(year != null ? { year: String(year) } : {}),
                  ...(month != null ? { month: String(month) } : {}),
                  ...(cycle ? { cycle } : {}),
                  employmentId: employmentId!,
                  payslipId: m.id,
                }).toString()}`}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  m.id === row?.id ? 'border-primary font-medium text-primary' : 'border-border hover:bg-muted'
                }`}
              >
                {m.payPeriod} · {tTxn(`individual.cycle.${m.runType}`)}
                {m.runSeq > 1 ? ` #${m.runSeq}` : ''}
              </Link>
            ))}
          </div>
        </Card>
      )}

      {row && b && eb && pcb && (
        <Card className="space-y-5 p-6">
          {/* Letterhead. There is NO company logo anywhere in this product — no column, no upload, no
              storage — so none is rendered. Inventing a placeholder would be a promise the data cannot
              keep; adding real logo storage is its own piece of work, disclosed in the plan. */}
          <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{row.company}</h1>
              {row.companyReg && <p className="text-xs text-muted-foreground">{row.companyReg}</p>}
              <p className="mt-1 text-sm text-muted-foreground">
                {t('payPeriodLine', { period: row.payPeriod })}
                {row.payDate ? ` · ${t('payDateLine', { date: row.payDate })}` : ''}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PAYROLL_PUBLICATION_PILL[pubState!]}`}>
                {t(`state_${pubState}`)}
              </span>
              {row.version > 1 && (
                <span className="text-xs text-muted-foreground">{t('revision', { n: row.version })}</span>
              )}
              <div className="flex items-center gap-2 print:hidden">
                <a
                  href={`/payroll/individual-payslip/${row.id}/pdf`}
                  download
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
                >
                  {tSlip('downloadPdf')}
                </a>
                <PrintButton />
              </div>
            </div>
          </div>

          {/* ── Employee information ── */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('employeeHeading')}
            </h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Info label={t('fieldEmployeeCode')} value={row.employeeCode} />
              <Info label={t('fieldEmployeeName')} value={row.employeeName} />
              <Info
                label={row.identityIsPassport ? t('fieldPassport') : t('fieldIc')}
                value={row.identityNumber}
              />
              <Info label={t('fieldDepartment')} value={row.department} />
              <Info label={t('fieldPosition')} value={row.position} />
              <Info label={t('fieldGrade')} value={row.jobGrade} />
              <Info
                label={t('fieldEmploymentType')}
                value={row.employmentType ? t(`employmentType_${row.employmentType}`) : null}
              />
              <Info
                label={t('fieldPaymentMethod')}
                value={row.paymentMethod ? t(`paymentMethod_${row.paymentMethod}`) : null}
              />
              {/* Masked in the READ, not here: the full account number never reaches the client. */}
              <Info
                label={t('fieldBankAccount')}
                value={row.bankAccountMasked ? `${row.bankName ?? ''} ${row.bankAccountMasked}`.trim() : null}
              />
              <Info label={t('fieldCurrency')} value={row.currency} />
              <Info label={t('fieldDaysWorked')} value={row.daysWorked ?? '—'} />
              <Info label={t('fieldCycle')} value={tTxn(`individual.cycle.${row.runType}`)} />
            </dl>
          </section>

          <div className="grid gap-5 sm:grid-cols-2">
            {/* ── Earnings ── */}
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tSlip('earnings')}
              </h2>
              <Row label={tSlip('basicSalary')} value={rm(b.basic)} />
              <Row label={tSlip('allowances')} value={rm(b.allowanceNet)} />
              {b.componentsByBucket.wage.map((l, i) => (
                <p key={`w${i}`} className="flex justify-between ps-3 text-xs text-muted-foreground">
                  <span>{l.name}</span>
                  <span className="tabular-nums">{rm(l.amount)}</span>
                </p>
              ))}
              <Row label={tSlip('overtime')} value={rm(b.overtime)} />
              {b.otConvertAmount > 0 && (
                <Row
                  label={tSlip('otConverted', { item: (b.st.otConvert?.name ?? '') })}
                  value={rm(b.otConvertAmount)}
                />
              )}
              <Row label={tSlip('bonus')} value={rm(b.bonus)} />
              {b.claim > 0 && <Row label={tSlip('claim')} value={rm(b.claim)} />}
              {b.detailNotRecorded && (
                <p className="pt-1 text-[11px] text-muted-foreground">{tTxn('view.history.detailNotRecorded')}</p>
              )}
              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                <span>{tSlip('grossPay')}</span>
                <span className="tabular-nums">{rm(b.gross)}</span>
              </div>
            </section>

            {/* ── Deductions ── */}
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tSlip('deductionsHeading')}
              </h2>
              <Row label={tSlip('epf')} value={rm(eb.employee.epf)} />
              <Row label={tSlip('socso')} value={rm(eb.employee.socso)} />
              {Number(b.st.socsoSkbbk) > 0 && <Row label={tSlip('skbbk')} value={rm(eb.employee.skbbk)} />}
              <Row label={tSlip('eis')} value={rm(eb.employee.eis)} />
              <Row label={tSlip('pcb')} value={rm(eb.employee.pcb)} />
              {Number(b.st.cp38) > 0 && <Row label={tSlip('cp38')} value={rm(b.st.cp38)} />}
              {Number(b.st.zakat) > 0 && (
                <Row label={tSlip('zakat')} value={`${rm(b.st.zakat)} · ${tSlip('zakatOffsetNote')}`} muted />
              )}
              {Number(row.otherDeductions) > 0 && (
                <Row label={tSlip('otherDeductions')} value={rm(row.otherDeductions)} />
              )}
              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                <span>{tSlip('totalDeductions')}</span>
                <span className="tabular-nums">−{rm(b.totalDeductions)}</span>
              </div>
            </section>
          </div>

          {/* ── PCB drill-down (169e3c24) ──
              Every figure here was already recorded on the payslip when it ran (`pcbMeta`) and had never
              been shown anywhere. Nothing is recomputed: a panel that re-derived the tax could disagree
              with the figure it claims to explain. Rendered as a native disclosure so it needs no client
              JavaScript and prints open on request. */}
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('pcbHeading')}</summary>
            <div className="pt-3">
              {pcb.kind === 'unavailable' && <p className="text-sm text-muted-foreground">{t('pcbUnavailable')}</p>}
              {pcb.kind === 'flat' && (
                <>
                  <Row
                    label={pcb.nonResident ? t('pcbFlatNonResident') : t('pcbFlatIncentive')}
                    value={`${(pcb.rate * 100).toFixed(0)}%`}
                  />
                  <Row label={tSlip('pcb')} value={rm(pcb.pcb)} />
                  <p className="pt-2 text-xs text-muted-foreground">{t('pcbFlatNote')}</p>
                </>
              )}
              {pcb.kind === 'mtd' && (
                <>
                  <Row label={t('pcbMonthOfYear')} value={`${pcb.month} / 12`} />
                  <Row label={t('pcbYtdNet')} value={rm(pcb.ytdNetRemuneration)} />
                  <Row label={t('pcbEpfThisMonth')} value={rm(pcb.epfThisMonth)} />
                  <Row label={t('pcbEpfClaimedYtd')} value={rm(pcb.epfClaimedYtd)} />
                  <Row label={t('pcbPaidYtd')} value={rm(pcb.pcbPaidYtd)} />
                  <Row label={t('pcbChargeable')} value={rm(pcb.chargeableIncome)} />
                  {pcb.chargeableIncomeWithAdditional != null && (
                    <Row label={t('pcbChargeableWithAdditional')} value={rm(pcb.chargeableIncomeWithAdditional)} />
                  )}
                  <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('pcbReliefsHeading')}
                  </h3>
                  <Row label={t('reliefIndividual')} value={rm(pcb.reliefs.individual)} muted />
                  <Row label={t('reliefSpouse')} value={rm(pcb.reliefs.spouse)} muted />
                  <Row label={t('reliefChildren')} value={rm(pcb.reliefs.children)} muted />
                  <Row label={t('reliefDisabledIndividual')} value={rm(pcb.reliefs.disabledIndividual)} muted />
                  <Row label={t('reliefDisabledSpouse')} value={rm(pcb.reliefs.disabledSpouse)} muted />
                  <Row label={t('reliefLp')} value={rm(pcb.reliefs.lp)} muted />
                  <Row label={t('reliefTotal')} value={rm(pcb.reliefs.total)} />
                  {Number(pcb.zakat) > 0 && <Row label={tSlip('zakat')} value={rm(pcb.zakat)} muted />}
                  <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                    <span>{tSlip('pcb')}</span>
                    <span className="tabular-nums">{rm(pcb.pcb)}</span>
                  </div>
                  {pcb.pcbAdditional > 0 && (
                    <p className="pt-1 text-xs text-muted-foreground">
                      {t('pcbSplit', { normal: rm(pcb.pcbNormal), additional: rm(pcb.pcbAdditional) })}
                    </p>
                  )}
                  {/* WHICH relief position is on screen. A silent fallback would explain a closed month
                      with a position that did not exist when it was calculated. */}
                  <p className="pt-2 text-xs text-muted-foreground">
                    {pcb.reliefSource === 'snapshot' ? t('pcbReliefFromSnapshot') : t('pcbReliefFromCurrent')}
                  </p>
                </>
              )}
            </div>
          </details>

          {/* ── Employer-borne statutory contributions (3c473773) ── */}
          {eb.any && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tSlip('employerBorneHeading')}
              </h2>
              {eb.keys.map((k) => (
                <Row key={k} label={tSlip(EMPLOYER_BORNE_LABEL[k])} value={rm(eb.borne[k])} />
              ))}
              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                <span>{tSlip('employerBorneTotal')}</span>
                <span className="tabular-nums">{rm(eb.total)}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{tSlip('employerBorneNote')}</p>
            </section>
          )}

          {/* ── Employer contributions ── */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {tSlip('employerContributionsHeading')}
            </h2>
            <Row label={tSlip('epf')} value={rm(b.employerContributions.epf)} muted />
            <Row label={tSlip('socso')} value={rm(b.employerContributions.socso)} muted />
            <Row label={tSlip('eis')} value={rm(b.employerContributions.eis)} muted />
            <Row
              label={tSlip('hrdf')}
              value={hrdfRegistered ? rm(b.employerContributions.hrdf) : tTxn('view.history.hrdfNotRegistered')}
              muted
            />
            <Row label={tSlip('totalEmployerCost')} value={rm(row.employerCost)} muted />
          </section>

          {/* ── Year to date ──
              Summed from the SAME read that lists this employee's months, so the column beside the
              current month can never disagree with the months it is made of. */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('ytdHeading', { year: row.payPeriod.slice(0, 4) })}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">{t('ytdItem')}</th>
                    <th className="py-1 text-right font-medium">{t('ytdCurrent')}</th>
                    <th className="py-1 text-right font-medium">{t('ytdToDate')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {(
                    [
                      [tSlip('grossPay'), b.gross, ytd.gross],
                      [tSlip('epf'), b.st.epfEmployee ?? 0, ytd.epf],
                      [tSlip('socso'), b.st.socsoEmployee ?? 0, ytd.socso],
                      [tSlip('eis'), b.st.eisEmployee ?? 0, ytd.eis],
                      [tSlip('pcb'), b.st.pcb ?? 0, ytd.pcb],
                      [tSlip('netPay'), b.net, ytd.net],
                    ] as [string, unknown, number][]
                  ).map(([label, current, total]) => (
                    <tr key={label}>
                      <td className="py-1.5">{label}</td>
                      <td className="py-1.5 text-right tabular-nums">{rm(current)}</td>
                      <td className="py-1.5 text-right tabular-nums">{rm(total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* The YTD column is the FULL employee share as computed and filed, which is why it can differ
                from the deduction lines above when the employer bore part of them. Said, not hidden. */}
            <p className="mt-2 text-xs text-muted-foreground">{t('ytdNote')}</p>
          </section>

          {/* ── Net pay ── */}
          <div className="flex items-baseline justify-between rounded-lg bg-primary/5 px-4 py-3">
            <span className="text-sm font-semibold">{tSlip('netPay')}</span>
            <span className="text-lg font-bold tabular-nums text-primary">{rm(b.net)}</span>
          </div>

          {b.recordLines.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tTxn('view.history.itemsHeading')}
              </h2>
              {b.recordLines.map((l, i) => (
                <Row key={`${l.code}-${i}`} label={`${l.code} · ${l.name}`} value={rm(l.amount)} muted />
              ))}
              <p className="mt-2 text-xs text-muted-foreground">{tTxn('view.history.itemsNote')}</p>
            </section>
          )}

          {prov?.rulesetVersion && (
            <p className="text-xs text-muted-foreground">
              {tSlip('provenanceFooter', { ruleset: prov.rulesetVersion })}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
