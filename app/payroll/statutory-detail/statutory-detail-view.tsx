/**
 * Feedback 6b4ca488 part 2 — the Statutory Explanation display.
 *
 * ONE DISPLAY, TWO DOORS — the shape 45df860a settled for the PCB working and the reason it settled on
 * it: "This avoids having two different calculation engines or two different calculation displays." The
 * Individual Payslip links here for the slip on screen (/payroll/statutory-detail?payslipId=…), and
 * Transaction View mounts this same component under its own `?tab=statutory`. Both render THIS file, so
 * the two entry points structurally cannot tell a reader different stories about one payslip.
 *
 * EVERY FIGURE IS READ, NOTHING IS RECOMPUTED. The whole derivation is `explainStatutory`
 * (core/statutory-explain.ts), which takes the payslip's own `statutory` blob and no SessionContext at
 * all — it cannot consult today's EPF table or today's PERKESO schedule even by accident. This component
 * formats what that returns and adds nothing arithmetical of its own.
 *
 * THREE THINGS THIS SCREEN REFUSES TO DO, each of which would be easy and wrong:
 *
 *   1. IT DOES NOT FILL IN A MISSING WAGE BASE. `statutory.bases` is stamped only from r187 and is
 *      present on a MINORITY of payslips. Where it is absent the screen says "working not recorded" in
 *      the base's place. Substituting gross pay would be a lie of exactly the kind this screen exists to
 *      end: EPF excludes overtime and SOCSO/EIS do not, so no earnings figure is any of the bases.
 *   2. IT DOES NOT PRESENT A SCHEDULE LOOKUP AS A PERCENTAGE. SOCSO, EIS and SKBBK come from PERKESO's
 *      contribution SCHEDULE — a band, not a rate — so their percentage is captioned as an effective
 *      check figure and their working line says which schedule produced the amount. Only EPF and the HRD
 *      Corp levy get a `base × rate` line, because for those two that is the actual working.
 *   3. IT DOES NOT REBUILD THE MTD CALCULATION. PCB's full working already lives at /payroll/pcb-detail,
 *      read off the same payslip's `pcbMeta`. This screen shows the tax's wage base and amount and links
 *      across. A second MTD display is precisely what 45df860a's plan ruled out.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import type { StatutoryExplainKey, StatutoryExplanation, StatutoryItemExplanation } from '@/core/statutory-explain';

export type StatutoryDetailContext = {
  payslipId: string;
  employeeCode: string | null;
  employeeName: string;
  company: string;
  /** Already formatted for the reader's locale by the caller ("January 2026"). */
  periodLabel: string;
  payPeriod: string;
  runType: string;
  runSeq: number;
  currency: string | null;
};

/** STATIC keys, exhaustively mapped. A computed `t()` key is invisible to the i18n coverage scan, which
 *  is how a caption reaches production as MISSING_MESSAGE having passed tsc, the suite and next build. */
const ITEM_LABEL: Record<StatutoryExplainKey, string> = {
  epf: 'itemEpf',
  socso: 'itemSocso',
  skbbk: 'itemSkbbk',
  eis: 'itemEis',
  hrdf: 'itemHrdf',
  pcb: 'itemPcb',
};
/** The agency each item is filed with — the sentence that answers "who is this money going to?". */
const ITEM_AGENCY: Record<StatutoryExplainKey, string> = {
  epf: 'agencyEpf',
  socso: 'agencySocso',
  skbbk: 'agencySocso',
  eis: 'agencySocso',
  hrdf: 'agencyHrdf',
  pcb: 'agencyPcb',
};
const CYCLE_LABEL: Record<string, string> = {
  regular: 'cycleRegular',
  off_cycle: 'cycleOffCycle',
  bonus: 'cycleBonus',
  adjustment: 'cycleAdjustment',
};
const RULE_LABEL: Record<StatutoryItemExplanation['ruleKind'], string> = {
  rate: 'ruleRate',
  schedule: 'ruleSchedule',
  mtd: 'ruleMtd',
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </Card>
  );
}

export async function StatutoryDetailView({
  ctx,
  explanation,
}: {
  ctx: StatutoryDetailContext;
  explanation: StatutoryExplanation;
}) {
  const t = await getTranslations('payroll.statutoryDetail');
  const cur = ctx.currency;
  const rm = (v: number) => formatMoney(v, cur);
  /** Bare 2-decimal number for use INSIDE a working expression, where a currency prefix on every term is
   *  noise. The unit is stated once, on the line above the expression — the pcb-detail convention. */
  const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (r: number) =>
    `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  /** The "not recorded" chip, as a single reusable ELEMENT rather than a component declared inside the
   *  render. `react-hooks/static-components` rejects the latter (a component created during render
   *  resets its state each time), and pcb-detail-view.tsx still carries that older shape — one new
   *  instance of a lint error the repo already has is one too many. An element is immutable, so reusing
   *  the same one everywhere the working is missing is exactly what React expects. */
  const notRecorded = <span className="font-normal text-muted-foreground">{t('notRecordedShort')}</span>;

  const cycleKey = CYCLE_LABEL[ctx.runType];

  return (
    <div className="space-y-6">
      {/* ── Who and when. A working that is not tied to a person, a company, a payroll month and a cycle
          is a worksheet about nobody — the same first block pcb-detail opens with, deliberately. ── */}
      <Block title={t('identificationHeading')}>
        <Row
          label={t('fieldEmployee')}
          value={ctx.employeeCode ? `${ctx.employeeCode} · ${ctx.employeeName}` : ctx.employeeName}
        />
        <Row label={t('fieldCompany')} value={ctx.company} />
        <Row label={t('fieldPeriod')} value={ctx.periodLabel} />
        <Row
          label={t('fieldCycle')}
          value={`${cycleKey ? t(cycleKey) : ctx.runType}${ctx.runSeq > 1 ? ` #${ctx.runSeq}` : ''}`}
        />
        <Row
          label={t('fieldRuleset')}
          value={explanation.rulesetVersion ?? notRecorded}
          muted={explanation.rulesetVersion == null}
        />
      </Block>

      {/* ── THE HONEST BANNER, and the reason it is a banner rather than six repeated captions.
          A payslip written before r187 stamped no wage bases at all, so no item on this screen has a
          working. Saying that once, at the top, in place of printing six identical apologies. ── */}
      {explanation.basesNotRecorded && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium">{t('basesNotRecordedHeading')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('basesNotRecordedBody')}</p>
        </Card>
      )}

      {/* An additional run's bases describe the CUMULATIVE month, not the money this run paid. Without
          this sentence the wage below looks like a charge the payslip beside it does not show. */}
      {explanation.basesCoverWholeMonth && !explanation.basesNotRecorded && (
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">{t('wholeMonthNote')}</p>
        </Card>
      )}

      {/* ── The summary: all six with their employee and employer amounts, so the totals can be checked
          at a glance before any single working is opened. The request asked for this at the top. ── */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          {t('summaryHeading')}
          <p className="mt-1 text-xs font-normal text-muted-foreground">{t('summaryHint')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colItem')}</th>
                <th className="px-4 py-2 font-medium">{t('colRule')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colBase')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEmployer')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {explanation.items.map((i) => (
                <tr key={i.key}>
                  <td className="px-4 py-2 font-medium">{t(ITEM_LABEL[i.key])}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{t(RULE_LABEL[i.ruleKind])}</td>
                  {/* An UNRECORDED base is named, never rendered as 0.00. On a reconciliation screen a
                      wrong zero is the most damaging cell there is: it reads as a fact. */}
                  <td className="px-4 py-2 text-right tabular-nums">
                    {i.totalBase == null ? notRecorded : rm(i.totalBase)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{rm(i.employeeReported)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{rm(i.employer)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-muted/30 text-sm font-semibold">
              <tr>
                <td className="px-4 py-2" colSpan={3}>
                  {t('totalRow')}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{rm(explanation.totals.employeeReported)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{rm(explanation.totals.employer)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {/* The employer-bears disclosure, because otherwise the Employee column above and the payslip's
            Total Deductions cannot be reconciled: the FILED share is the full one, the DEDUCTED share is
            not. Rendered only when this payslip's own blob records the election. */}
        {explanation.employerBorne.any && (
          <div className="border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">{t('employerBorneNote')}</p>
            <div className="mt-2">
              <Row label={t('fieldEmployerBorneTotal')} value={rm(explanation.totals.employerBorne)} />
              <Row label={t('fieldTakeHomeTotal')} value={rm(explanation.totals.employeeTakeHome)} />
            </div>
          </div>
        )}
      </Card>

      {/* ── One working per item. ── */}
      {explanation.items.map((i) => (
        <Block key={i.key} title={t(ITEM_LABEL[i.key])}>
          <p className="-mt-1 mb-3 text-xs text-muted-foreground">{t(ITEM_AGENCY[i.key])}</p>

          <Row
            label={t('fieldStatutoryWage')}
            value={i.base == null ? notRecorded : rm(i.base)}
            muted={i.base == null}
          />
          {/* EPF alone charges a second stream. Rendered only when the run recorded one, so the other
              five items do not grow an empty row that reads as a gap. */}
          {i.key === 'epf' && i.additionalBase != null && (
            <Row label={t('fieldAdditionalWage')} value={rm(i.additionalBase)} />
          )}
          <Row label={t('fieldRuleApplied')} value={t(RULE_LABEL[i.ruleKind])} />

          {/* THE WORKING. Only the two rate-based items get a `wage × rate` line, because only for those
              two is that what actually happened. See the header's refusal #2. */}
          <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('workingLabel')}</p>
            {i.workingNotRecorded ? (
              <p className="text-sm text-muted-foreground">{t('workingNotRecorded')}</p>
            ) : i.ruleKind === 'mtd' ? (
              <p className="text-sm text-muted-foreground">{t('workingMtd')}</p>
            ) : (
              <>
                {i.employeeReported > 0 && (
                  <p className="break-words font-mono text-sm tabular-nums">
                    {t('workingEmployeeLine')}
                    {'  '}
                    {b2(i.totalBase ?? 0)} ×{' '}
                    {i.effectiveEmployeeRate == null ? '—' : pct(i.effectiveEmployeeRate)} ={' '}
                    {b2(i.employeeReported)}
                  </p>
                )}
                {i.employer > 0 && (
                  <p className="break-words font-mono text-sm tabular-nums">
                    {t('workingEmployerLine')}
                    {'  '}
                    {b2(i.totalBase ?? 0)} ×{' '}
                    {i.effectiveEmployerRate == null ? '—' : pct(i.effectiveEmployerRate)} ={' '}
                    {b2(i.employer)}
                  </p>
                )}
                {i.employeeReported === 0 && i.employer === 0 && (
                  <p className="text-sm text-muted-foreground">{t('workingNilCharge')}</p>
                )}
                {/* The percentages above are DERIVED (amount ÷ recorded wage), not stamped — the runs
                    never wrote a rate down. Said plainly rather than left for a reader to assume it was
                    looked up, and said differently for a schedule item, where the percentage is a check
                    figure and the band is the rule. */}
                <p className="text-xs text-muted-foreground">
                  {i.ruleKind === 'schedule' ? t('effectiveRateScheduleNote') : t('effectiveRateNote')}
                </p>
              </>
            )}
          </div>

          <div className="mt-3">
            <Row label={t('fieldEmployeeShare')} value={rm(i.employeeReported)} />
            {i.employerBorne > 0 && (
              <>
                <Row label={t('fieldEmployerBorne')} value={rm(i.employerBorne)} muted />
                <Row label={t('fieldTakeHome')} value={rm(i.employeeTakeHome)} />
              </>
            )}
            <Row label={t('fieldEmployerShare')} value={rm(i.employer)} />
          </div>

          {/* PCB's full MTD working lives at pcb-detail off this same payslip. One display, not two. */}
          {i.key === 'pcb' && (
            <Link
              href={`/payroll/pcb-detail?payslipId=${encodeURIComponent(ctx.payslipId)}`}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              {t('pcbViewCalculation')}
            </Link>
          )}
        </Block>
      ))}
    </div>
  );
}
