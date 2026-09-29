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
 * FOUR THINGS THIS SCREEN REFUSES TO DO, each of which would be easy and wrong:
 *
 *   1. IT DOES NOT FILL IN A MISSING WAGE BASE. `statutory.bases` is stamped only from r187 and is
 *      present on a MINORITY of payslips. Where it is absent the screen says "working not recorded" in
 *      the base's place. Substituting gross pay would be a lie of exactly the kind this screen exists to
 *      end: EPF excludes overtime and SOCSO/EIS do not, so no earnings figure is any of the bases.
 *   2. IT DOES NOT PRESENT A SCHEDULE LOOKUP AS A PERCENTAGE, and that refusal is enforced by the SHAPE
 *      OF THE LINE, not only by the caption under it. A schedule item prints `wage → amount`, never
 *      `wage × rate = amount`: the amount is the figure its band prescribes, so a multiplication would
 *      be a working that does not evaluate. Only the HRD Corp levy gets a `base × rate` line, because it
 *      alone is a percentage of the wage — and only when the LEVY ITSELF produced the amount; a levy typed
 *      by hand loses the multiplication too (refusal #5). EPF IS A SCHEDULE ITEM — the KWSP Third Schedule bands every
 *      monthly wage up to RM20,000 (localization/my/payroll.ts:126) — and the first cut of this screen
 *      called it "Percentage of wage", which is exactly the sin this paragraph refuses, committed on the
 *      largest deduction on the slip.
 *   3. IT DOES NOT REBUILD THE MTD CALCULATION. PCB's full working already lives at /payroll/pcb-detail,
 *      read off the same payslip's `pcbMeta`. This screen shows the tax's wage base and amount and links
 *      across. A second MTD display is precisely what 45df860a's plan ruled out.
 *   4. IT DOES NOT PRINT A RATE ON AN ADDITIONAL RUN. A bonus / off-cycle / adjustment run stamps the
 *      CUMULATIVE month's wage against THIS run's INCREMENTAL amount, so no quotient of the two is a
 *      statutory rate (RM5,000 basic plus a RM10,000 bonus gives 1,100 ÷ 15,000 = 7.33%, an EPF rate
 *      that does not exist). `explainStatutory` returns both rates as null there, and the working line
 *      prints the amount alone under a note that says which figure is which.
 *   5. IT DOES NOT CREDIT A RULE WITH A FIGURE A PERSON TYPED (208beb8b). Payroll › Statutory Adjustment
 *      can set any of nine statutory lines to an exact amount. This screen used to divide that amount by
 *      the recorded wage and print the quotient as an effective rate UNDER THE NAME OF THE SCHEDULE —
 *      RM500 on RM3,000 became "3,000.00 → 500.00 (16.67%), KWSP Third Schedule", three false statements
 *      in one line, on the screen a payroll officer hands an auditor. A hand-set item now names itself
 *      (`ruleKind: 'manual'`), prints the amount ALONE with no rate at all, shows the figure the system
 *      had calculated beside it, and the reason the officer recorded rides at the top in its own banner.
 *      WHERE THAT ANSWER COMES FROM: `statutoryProvenance` in core/statutory-explain.ts, through
 *      `item.provenance` and `explanation.setByHand`. This file never reads `statutory.adjustment`
 *      itself — item 70b14723 extends that one function and this screen follows it.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui';
import { formatMoney } from '@/lib/money';
// `isSetByHand` is the derivation's OWN predicate over `provenance` — imported rather than re-spelled as
// `source !== 'computed'` here, so 70b14723's second source is recognised by this screen automatically.
import { isSetByHand, type StatutoryProvenanceSource } from '@/core/statutory-explain';
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
/** ⚠️ EXHAUSTIVE BY TYPE, ON PURPOSE. A new `StatutoryRuleKind` breaks tsc HERE and in the export route,
 *  which is how 208beb8b's 'manual' could not reach production labelled on the screen and unlabelled in
 *  the file an auditor is emailed. Never widen this to `Partial<…>` or `Record<string, string>`. */
const RULE_LABEL: Record<StatutoryItemExplanation['ruleKind'], string> = {
  rate: 'ruleRate',
  schedule: 'ruleSchedule',
  mtd: 'ruleMtd',
  // NOT a rule at all, and the label says so rather than naming an instrument: nothing looked this up.
  manual: 'ruleManual',
};
/**
 * The rule NAMES the schedule, because there are two of them and they are different instruments: EPF is
 * banded by the KWSP Third Schedule, SOCSO/EIS/SKBBK by PERKESO's contribution schedule. `ruleSchedule`
 * says "PERKESO contribution schedule" in all six catalogues, so reusing it for EPF would have replaced
 * one wrong label with another. Still a STATIC lookup — both literals appear in source, so the i18n
 * coverage scan sees them. Same map as the export route's, kept in step for the same reason.
 */
const ruleLabelKey = (i: StatutoryItemExplanation) =>
  i.key === 'epf' && i.ruleKind === 'schedule' ? 'ruleScheduleEpf' : RULE_LABEL[i.ruleKind];
/**
 * ⚠️ EXHAUSTIVE BY TYPE for the same reason `RULE_LABEL` is — 70b14723 added a source and this is where a
 * new one has to be worded, in both files, or the banner explains one decision and attributes it to another.
 *
 * ONE BANNER, TWO SENTENCES. The heading, the styling, the item list and the suppressed rates are shared:
 * these two maps carry only the part that genuinely differs — WHO decided the figure and what their recorded
 * words are called. "A payroll officer entered this under Payroll, Statutory Adjustment" and "this
 * employee's EPF Category is a fixed amount" are different facts about where a reader should go to change
 * it, and a shared sentence would have to be vague about both. 'computed' never reaches here (`isSetByHand`
 * is the gate) but is mapped rather than omitted so tsc stays the enforcement.
 */
const SOURCE_BODY: Record<StatutoryProvenanceSource, string> = {
  computed: 'manualBannerBody',
  statutoryAdjustment: 'manualBannerBody',
  epfManualAmount: 'manualBannerBodyElection',
};
const SOURCE_REASON_LABEL: Record<StatutoryProvenanceSource, string> = {
  computed: 'manualReason',
  statutoryAdjustment: 'manualReason',
  epfManualAmount: 'manualReasonElection',
};

/** Bare 2-decimal number for use INSIDE a working expression, where a currency prefix on every term is
 *  noise. The unit is stated once, on the line above the expression — the pcb-detail convention. */
const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (r: number) =>
  `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

/**
 * ONE SIDE OF THE WORKING — and the whole of refusal #2's enforcement, because the SHAPE of the
 * expression follows the rule that produced the amount:
 *
 *   additional run → the amount ALONE. The wage above it is the cumulative month's and this figure is
 *                    the run's increment (refusal #4), so any expression relating the two would assert
 *                    an arithmetic that is not there.
 *   'manual'       → the amount ALONE, for the same reason one step further along: a person typed it, so
 *                    NO expression relating it to the wage is true (refusal #5). This is the arm the HRD
 *                    Corp levy most needed — it is the only `base × rate = amount` line on the screen,
 *                    and a typed levy made it a product that does not evaluate.
 *   'schedule'     → `wage → amount`, the effective percentage in brackets as a check figure. The
 *                    amount is the one its band prescribes, so an `=` between a product and it would
 *                    simply not hold: EPF wage 2,990 pays the 3,000 band's 330, and 11.04% × 2,990 is
 *                    330.10. An arrow says "this wage maps to this amount", which is what happened.
 *   'rate'         → `wage × rate = amount`, true for the HRD Corp levy and nothing else here.
 *
 * A plain string rather than JSX, so a caller cannot reorder the terms of a working.
 */
function workingExpression(
  i: StatutoryItemExplanation,
  amount: number,
  rate: number | null,
  incremental: boolean,
): string {
  // `totalBase == null` is already caught by `workingNotRecorded` upstream; kept total anyway, because a
  // formula box that throws on a hand-edited blob takes the whole payslip screen down with it.
  // 'manual' is tested through `ruleKind` rather than through `provenance` so there is ONE decision:
  // core/statutory-explain.ts decided it, and the label, the rates and this shape all follow that decision.
  if (incremental || i.ruleKind === 'manual' || i.totalBase == null) return b2(amount);
  if (i.ruleKind === 'schedule') {
    return `${b2(i.totalBase)} → ${b2(amount)}${rate == null ? '' : `  (${pct(rate)})`}`;
  }
  return rate == null ? b2(amount) : `${b2(i.totalBase)} × ${pct(rate)} = ${b2(amount)}`;
}

/**
 * WHICH caveat sits under the working. Static keys, all five literal in this file for the coverage scan.
 *
 * 'manual' WINS OVER 'incremental' WHEN BOTH HOLD, and that is not an oversight. `incrementalNote` says
 * the amount IS the increase this run added — true of a figure the engine produced, FALSE of one somebody
 * typed, which is neither the increment nor anything derived from the wage above. `manualNote` denies any
 * relation between the two figures, which is the stronger true statement; the cumulative-wage half is
 * still disclosed by the whole-month banner at the top of the screen, where both banners sit together.
 */
function workingNoteKey(i: StatutoryItemExplanation, incremental: boolean): string {
  if (i.ruleKind === 'manual') return 'manualNote';
  if (incremental) return 'incrementalNote';
  if (i.ruleKind !== 'schedule') return 'effectiveRateNote';
  // Two different instruments: the KWSP Third Schedule bands EPF, PERKESO's schedule bands the rest.
  return i.key === 'epf' ? 'effectiveRateEpfNote' : 'effectiveRateScheduleNote';
}

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
  /** The "not recorded" chip, as a single reusable ELEMENT rather than a component declared inside the
   *  render. `react-hooks/static-components` rejects the latter (a component created during render
   *  resets its state each time), and pcb-detail-view.tsx still carries that older shape — one new
   *  instance of a lint error the repo already has is one too many. An element is immutable, so reusing
   *  the same one everywhere the working is missing is exactly what React expects. */
  const notRecorded = <span className="font-normal text-muted-foreground">{t('notRecordedShort')}</span>;

  const cycleKey = CYCLE_LABEL[ctx.runType];
  /** THIS run's amounts are increments of the cumulative month whose wages are shown beside them — the
   *  one fact that decides whether a percentage may be printed at all. Read off the explanation rather
   *  than off `ctx.runType` so the display and the derivation cannot disagree about which run this is. */
  const incremental = explanation.basesCoverWholeMonth;

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

      {/* ── 208beb8b: A PERSON DECIDED ONE OF THESE FIGURES, SAID BEFORE ANY NUMBER IS READ.
          Its own banner beside the other two rather than folded into either, because the three disclose
          three unrelated things and any of them can be true at once — a pre-r187 slip, an additional run,
          and a line typed by hand. Each says only its own half. The amber styling and the classes are the
          `basesNotRecorded` card's, so the family reads as one.
          It names WHICH items and carries the one reason the officer recorded: without the reason a reader
          knows a figure was overridden and still cannot defend it, which is the whole job of this screen.
          Read off `explanation.setByHand` — `statutoryProvenance`'s answer — never from a second read. ── */}
      {explanation.setByHand && (
        <Card className="border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm font-medium">{t('manualBannerHeading')}</p>
          {/* 70b14723 — ONE paragraph per SOURCE, in `notes` order. Still one banner: a payslip can carry a
              per-run adjustment AND a standing manual EPF amount, and a reader who is told only one of them
              will look for the figure in the wrong place. */}
          {explanation.setByHand.notes.map((n) => (
            <p key={`body-${n.source}`} className="mt-1 text-xs text-muted-foreground">
              {t(SOURCE_BODY[n.source])}
            </p>
          ))}
          <div className="mt-2">
            <Row
              label={t('manualBannerItems')}
              value={explanation.setByHand.keys.map((k) => t(ITEM_LABEL[k])).join(' · ')}
            />
            {/* The reason is mandatory at the point of entry — for both sources — so '' here means a
                pre-2961a7ae stamp, not an officer who declined to say. Named as unrecorded rather than
                rendered as a blank row. Each reason is labelled with ITS OWN source's caption, because
                "reason recorded for the adjustment" is false of an EPF-category figure. */}
            {explanation.setByHand.notes.map((n) => (
              <Row key={`reason-${n.source}`} label={t(SOURCE_REASON_LABEL[n.source])} value={n.reason || notRecorded} />
            ))}
          </div>
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
                  <td className="px-4 py-2 text-xs text-muted-foreground">{t(ruleLabelKey(i))}</td>
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
          <Row label={t('fieldRuleApplied')} value={t(ruleLabelKey(i))} />

          {/* THE WORKING. Its SHAPE is chosen by the rule, not decorated after the fact — `wage × rate =
              amount` appears ONLY where a percentage really produced the amount. See `workingExpression`
              and the header's refusals #2 and #4. */}
          <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('workingLabel')}</p>
            {i.workingNotRecorded ? (
              <p className="text-sm text-muted-foreground">{t('workingNotRecorded')}</p>
            ) : i.ruleKind === 'mtd' ? (
              <>
                <p className="text-sm text-muted-foreground">{t('workingMtd')}</p>
                {/* PCB alone keeps `ruleKind: 'mtd'` — one MTD display, and its own screen discloses the
                    override in full. But "worked out from the tax table" left standing beside an amount
                    somebody typed is refusal #5 committed by omission, so the caveat is printed here too. */}
                {isSetByHand(i.provenance) && (
                  <p className="text-xs text-muted-foreground">{t('manualNote')}</p>
                )}
              </>
            ) : (
              <>
                {i.employeeReported > 0 && (
                  <p className="break-words font-mono text-sm tabular-nums">
                    {t('workingEmployeeLine')}
                    {'  '}
                    {workingExpression(i, i.employeeReported, i.effectiveEmployeeRate, incremental)}
                  </p>
                )}
                {i.employer > 0 && (
                  <p className="break-words font-mono text-sm tabular-nums">
                    {t('workingEmployerLine')}
                    {'  '}
                    {workingExpression(i, i.employer, i.effectiveEmployerRate, incremental)}
                  </p>
                )}
                {i.employeeReported === 0 && i.employer === 0 && (
                  <p className="text-sm text-muted-foreground">{t('workingNilCharge')}</p>
                )}
                {/* Any percentage above is DERIVED (amount ÷ recorded wage), not stamped — the runs never
                    wrote a rate down. Said plainly rather than left for a reader to assume it was looked
                    up; said differently for a schedule item, where the percentage is a check figure and
                    the band is the rule; and said differently again on an additional run, where there is
                    no percentage at all because the amount and the wage are not the same month's money. */}
                <p className="text-xs text-muted-foreground">{t(workingNoteKey(i, incremental))}</p>
              </>
            )}
          </div>

          {/* THE SYSTEM FIGURE BESIDE THE TYPED ONE, per leg and only for a leg that was typed. The rows
              below already carry the APPLIED figures — they are what the payslip charged — so what was
              missing was the one the rule produced, and the difference a reader can then see for
              themselves. A leg nobody touched grows no row: its figure is the system's already, and a
              second identical line would read as a discrepancy. `system` comes off the stamp the run
              wrote, never from re-running the rule (core/statutory-explain.ts's one rule). */}
          <div className="mt-3">
            {i.provenance.employee && (
              <Row label={t('fieldSystemEmployeeShare')} value={rm(i.provenance.employee.system)} muted />
            )}
            <Row label={t('fieldEmployeeShare')} value={rm(i.employeeReported)} />
            {i.employerBorne > 0 && (
              <>
                <Row label={t('fieldEmployerBorne')} value={rm(i.employerBorne)} muted />
                <Row label={t('fieldTakeHome')} value={rm(i.employeeTakeHome)} />
              </>
            )}
            {i.provenance.employer && (
              <Row label={t('fieldSystemEmployerShare')} value={rm(i.provenance.employer.system)} muted />
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
