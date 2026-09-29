/**
 * ADR-0024 §7 — Multi-Cycle Statutory Worksheet.
 *
 * THE SCREEN AN ACCOUNTANT SIGNS BEFORE ANYTHING CHANGES. ADR-0024 §5 gates enabling the
 * month-as-one statutory aggregation on sign-off of the §7 worksheet, and this is that worksheet run
 * over the customer's OWN payroll history instead of the single hand-written scenario in the ADR
 * (which lands on the same figures under both readings and can therefore settle nothing).
 *
 * READ-ONLY END TO END. Nothing on this route writes: no server action, no form POST, no recompute of
 * an issued payslip, no mutation of any payroll row. The whole page is one `multiCycleWorksheet` read
 * inside a transaction that only SELECTs. That is a requirement of the thing, not an implementation
 * detail — a worksheet whose purpose is to be reviewed BEFORE a change may not itself be the change.
 *
 * THE JURISDICTION OWNS THE QUESTION, so the computation comes off the acting company's country pack
 * (`pack.payroll.multiCycleWorksheet`) rather than being imported here. Act 4 s.6(7)'s monthly unit and
 * the EPF Third Schedule's monthly bands are what make two runs in one month a correctness question at
 * all; a company under a pack that declares no such worksheet is told so instead of being shown a
 * Malaysian answer (ADR-0080 D1/D7 — this route never names `localization/my`).
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin, actingCompanyCountry } from '@/lib/scope';
import { packFor } from '@/localization/registry';
import type { MultiCycleWorksheet, WorksheetItem, WorksheetRow } from '@/localization/country-pack';
import { Card, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';

/** The order the eight figures are read in — scheme by scheme, each scheme's legs together, then tax.
 *  `socsoSkbbk` (Lindung 24 Jam) is the employee-deducted leg riding the SOCSO bands, so it sits with
 *  its scheme. This list is pinned against the pack's WORKSHEET_ITEMS by test — a figure the worksheet
 *  computes but this array omits would be silently absent from every table on the sign-off document. */
const ITEMS: WorksheetItem[] = [
  'epfEmployee',
  'epfEmployer',
  'socsoEmployee',
  'socsoEmployer',
  'socsoSkbbk',
  'eisEmployee',
  'eisEmployer',
  'pcb',
];

const YEAR_RE = /^\d{4}$/;

export default async function MultiCycleWorksheetPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.multiCycleWorksheet');
  const locale = await getLocale();
  const sp = await searchParams;
  const year = typeof sp.year === 'string' && YEAR_RE.test(sp.year) ? sp.year : undefined;

  const country = await actingCompanyCountry();
  const pack = packFor(country);
  const worksheet: MultiCycleWorksheet | null = pack?.payroll.multiCycleWorksheet
    ? await pack.payroll.multiCycleWorksheet(s, { companyIds: scopeIds, year })
    : null;

  const money = (n: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  const signed = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
  const itemLabel = (k: WorksheetItem) => t(`item.${k}`);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        back={{ href: '/payroll/reports', label: t('backToReports') }}
      />

      {/* Said first and said plainly. The reviewer's first question about a screen that shows what
          their statutory figures "would be" is whether opening it has already changed something. */}
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
        {t('readOnlyBanner')}
      </div>

      {!worksheet && (
        <Card>
          <p className="px-4 py-6 text-sm text-muted-foreground">{t('noPackForCountry', { country })}</p>
        </Card>
      )}

      {worksheet && (
        <>
          <Card>
            <SectionHeader title={t('filterTitle')} />
            <form method="get" className="flex flex-wrap items-end gap-3 p-4">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">{t('fieldYear')}</span>
                <input name="year" defaultValue={year ?? ''} placeholder={t('yearPlaceholder')} className={inputCls} />
              </label>
              <button className={btnPrimary}>{t('apply')}</button>
              <p className="text-xs text-muted-foreground">{t('yearHint')}</p>
            </form>
          </Card>

          {/* THE ANSWER, in one sentence, before any table. The customer asked how often this happens on
              their data; everything below is the working behind this line. */}
          <Card>
            <div className="space-y-3 p-4">
              <p className="text-base font-medium">
                {t('headline', {
                  changed: worksheet.verdicts.would_change,
                  compared: worksheet.employeeMonthsCompared,
                  periods: worksheet.periodsWithMultipleRuns,
                })}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Tile label={t('tile.periods')} value={String(worksheet.periodsWithMultipleRuns)} />
                <Tile label={t('tile.examined')} value={String(worksheet.employeeMonthsExamined)} />
                <Tile label={t('tile.compared')} value={String(worksheet.employeeMonthsCompared)} />
                <Tile label={t('tile.wouldChange')} value={String(worksheet.verdicts.would_change)} />
                <Tile label={t('tile.excluded')} value={String(worksheet.employeeMonthsExcluded)} />
                <Tile label={t('tile.flagged')} value={String(worksheet.employeeMonthsFlagged)} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('verdictBreakdown', {
                  agree: worksheet.verdicts.agree,
                  aggregated: worksheet.verdicts.already_aggregated,
                  // Item 70b14723 — the fifth verdict is counted here too, or the four numbers on this line
                  // stop adding up to `employeeMonthsCompared` and a reader has to guess where the rest went.
                  // On a document an accountant signs, a count that does not reconcile is the whole problem.
                  manualEpf: worksheet.verdicts.manual_epf_amount,
                  unexplained: worksheet.verdicts.unexplained,
                })}
              </p>
              <p className="text-xs text-muted-foreground">{t('replayVersion', { version: worksheet.replayVersion })}</p>
            </div>
          </Card>

          <Card>
            <SectionHeader title={t('totalsTitle')} />
            <p className="px-4 pb-2 text-xs text-muted-foreground">{t('totalsHint')}</p>
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}>
                  <tr>
                    <th className={thCls}>{t('col.item')}</th>
                    <th className={`${thCls} text-right`}>{t('col.paid')}</th>
                    <th className={`${thCls} text-right`}>{t('col.perRun')}</th>
                    <th className={`${thCls} text-right`}>{t('col.monthAsOne')}</th>
                    <th className={`${thCls} text-right`}>{t('col.movement')}</th>
                  </tr>
                </thead>
                <tbody className={tbodyCls}>
                  {ITEMS.map((k) => (
                    <tr key={k}>
                      <td className="px-3 py-2">{itemLabel(k)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(worksheet.totals.paid[k])}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(worksheet.totals.perRun[k])}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(worksheet.totals.monthAsOne[k])}</td>
                      <td
                        className={`px-3 py-2 text-right font-medium tabular-nums ${
                          Math.abs(worksheet.movement[k]) < 0.005 ? 'text-muted-foreground' : ''
                        }`}
                      >
                        {signed(worksheet.movement[k])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <WorkedExample worksheet={worksheet} money={money} t={t} itemLabel={itemLabel} />

          <Card>
            <SectionHeader title={t('rowsTitle')} count={worksheet.rows.length} />
            <p className="px-4 pb-2 text-xs text-muted-foreground">{t('rowsHint')}</p>
            {worksheet.rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">{t('noRows')}</p>
            ) : (
              <div className={tableWrapCls}>
                <table className="w-full text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}>{t('col.company')}</th>
                      <th className={thCls}>{t('col.month')}</th>
                      <th className={thCls}>{t('col.employee')}</th>
                      <th className={`${thCls} text-right`}>{t('col.runs')}</th>
                      <th className={thCls}>{t('col.verdict')}</th>
                      {ITEMS.map((k) => (
                        <th key={k} className={`${thCls} text-right`}>
                          {itemLabel(k)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className={tbodyCls}>
                    {worksheet.rows.map((r) => (
                      <tr key={`${r.companyId}|${r.period}|${r.employmentId}`}>
                        <td className="px-3 py-2">{r.companyName}</td>
                        <td className="px-3 py-2 tabular-nums">{r.period}</td>
                        <td className="px-3 py-2">
                          {r.employeeName}
                          {r.employeeCode ? <span className="ml-1 text-xs text-muted-foreground">{r.employeeCode}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.runCount}</td>
                        <td className="px-3 py-2">{t(`verdict.${r.verdict}`)}</td>
                        {ITEMS.map((k) => (
                          <td
                            key={k}
                            className={`px-3 py-2 text-right tabular-nums ${
                              Math.abs(r.difference[k]) < 0.005 ? 'text-muted-foreground' : 'font-medium'
                            }`}
                          >
                            {signed(r.difference[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {worksheet.truncated && <p className="px-4 py-2 text-xs text-muted-foreground">{t('truncated')}</p>}
          </Card>

          <Card>
            <SectionHeader title={t('skipsTitle')} count={worksheet.skips.length} />
            <p className="px-4 pb-2 text-xs text-muted-foreground">{t('skipsHint')}</p>
            {worksheet.skips.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">{t('noSkips')}</p>
            ) : (
              <>
                <ul className="flex flex-wrap gap-2 px-4 pb-3 text-xs">
                  {Object.entries(worksheet.skipCounts).map(([reason, count]) => (
                    <li key={reason} className="rounded-md border border-border px-2 py-1">
                      {t(`reason.${reason}`)} · {count}
                    </li>
                  ))}
                </ul>
                <div className={tableWrapCls}>
                  <table className="w-full text-sm">
                    <thead className={theadCls}>
                      <tr>
                        <th className={thCls}>{t('col.company')}</th>
                        <th className={thCls}>{t('col.month')}</th>
                        <th className={thCls}>{t('col.employee')}</th>
                        <th className={thCls}>{t('col.disposition')}</th>
                        <th className={thCls}>{t('col.reason')}</th>
                      </tr>
                    </thead>
                    <tbody className={tbodyCls}>
                      {worksheet.skips.map((k) => (
                        <tr key={`${k.companyId}|${k.period}|${k.employmentId}|${k.reason}`}>
                          <td className="px-3 py-2">{k.companyName}</td>
                          <td className="px-3 py-2 tabular-nums">{k.period}</td>
                          <td className="px-3 py-2">{k.employeeName}</td>
                          <td className="px-3 py-2">{k.excluded ? t('disposition.excluded') : t('disposition.flagged')}</td>
                          <td className="px-3 py-2">{t(`reason.${k.reason}`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>

          <Card>
            <SectionHeader title={t('signOffTitle')} />
            <div className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
              <p>{t('signOffBody')}</p>
              <p>
                {t('signOffAdr')}{' '}
                <Link href="/payroll/reports" className="text-primary hover:underline">
                  {t('backToReports')}
                </Link>
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * THE WORKING, end to end, for ONE employee. A total nobody can follow is a total nobody can sign, so
 * the page always shows the arithmetic: the real employee-month if the history has one that differs,
 * and otherwise the RM5,001 + RM1,001 illustration — chosen because it is the smallest pair that tells
 * the two readings apart (the ADR's RM5,000 + RM10,000 gives the same answer under both and proves
 * nothing). The illustration's figures come from the live statutory tables, never from a literal.
 */
function WorkedExample({
  worksheet,
  money,
  t,
  itemLabel,
}: {
  worksheet: MultiCycleWorksheet;
  money: (n: number) => string;
  t: (key: string, values?: Record<string, string | number>) => string;
  itemLabel: (k: WorksheetItem) => string;
}) {
  const row: WorksheetRow | undefined =
    worksheet.rows.find((r) => r.verdict === 'would_change') ?? worksheet.rows[0];
  const ill = worksheet.illustration;
  return (
    <Card>
      <SectionHeader title={t('exampleTitle')} />
      <div className="space-y-4 p-4 text-sm">
        <p className="text-xs text-muted-foreground">{t('exampleHint')}</p>

        <div className="rounded-md border border-border p-3">
          <p className="font-medium">
            {t('illustrationTitle', { normal: money(ill.normalWage), second: money(ill.secondRun) })}
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>{t('illustrationStep1', { wage: money(ill.normalWage), epf: money(ill.epfNormalOnly.employee) })}</li>
            <li>{t('illustrationStep2', { wage: money(ill.secondRun), epf: money(ill.epfSecondRunAlone.employee) })}</li>
            <li>{t('illustrationStep3', { total: money(ill.perRunTotal.employee) })}</li>
            <li>
              {t('illustrationStep4', {
                normal: money(ill.normalWage),
                second: money(ill.secondRun),
                epf: money(ill.monthAsOneTotal.employee),
              })}
            </li>
            <li className="font-medium text-foreground">
              {t('illustrationStep5', {
                diff: money(Math.round((ill.perRunTotal.employee - ill.monthAsOneTotal.employee) * 100) / 100),
              })}
            </li>
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">{t('illustrationVersion', { version: ill.version })}</p>
        </div>

        {!row && <p className="text-muted-foreground">{t('exampleNoRow')}</p>}

        {row && (
          <div className="space-y-2">
            <p className="font-medium">
              {t('exampleFor', { employee: row.employeeName, period: row.period, company: row.companyName })}
            </p>
            <p className="text-xs text-muted-foreground">{t(`verdict.${row.verdict}`)}</p>
            <div className={tableWrapCls}>
              <table className="w-full text-sm">
                <thead className={theadCls}>
                  <tr>
                    <th className={thCls}>{t('col.run')}</th>
                    <th className={`${thCls} text-right`}>{t('col.normal')}</th>
                    <th className={`${thCls} text-right`}>{t('col.additional')}</th>
                    <th className={`${thCls} text-right`}>{t('col.overtime')}</th>
                    <th className={thCls}>{t('col.reading')}</th>
                    {ITEMS.map((k) => (
                      <th key={k} className={`${thCls} text-right`}>
                        {itemLabel(k)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className={tbodyCls}>
                  {row.runs.flatMap((r) =>
                    (['paid', 'perRun', 'monthAsOne'] as const).map((reading, i) => (
                      <tr key={`${r.runSeq}-${reading}`}>
                        {i === 0 ? (
                          <>
                            <td className="px-3 py-2" rowSpan={3}>
                              {t('runLabel', { seq: r.runSeq, type: t(`runType.${r.runType}`) })}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums" rowSpan={3}>
                              {money(r.normal)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums" rowSpan={3}>
                              {money(r.additional)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums" rowSpan={3}>
                              {money(r.overtime)}
                            </td>
                          </>
                        ) : null}
                        <td className="px-3 py-2 text-xs text-muted-foreground">{t(`col.${reading}`)}</td>
                        {ITEMS.map((k) => (
                          <td key={k} className="px-3 py-2 text-right tabular-nums">
                            {money(r[reading][k])}
                          </td>
                        ))}
                      </tr>
                    )),
                  )}
                  {(['paid', 'perRun', 'monthAsOne'] as const).map((reading) => (
                    <tr key={`total-${reading}`} className="bg-muted/40">
                      <td className="px-3 py-2 font-medium" colSpan={4}>
                        {t('monthTotal')}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{t(`col.${reading}`)}</td>
                      {ITEMS.map((k) => (
                        <td key={k} className="px-3 py-2 text-right font-medium tabular-nums">
                          {money(row[reading][k])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
