/**
 * Feedback 45df860a — THE ONE PCB / MTD calculation screen, shared by Transaction Detail and the
 * Individual Payslip.
 *
 * WHY IT IS A COMPONENT AND NOT TWO SCREENS. The reporter's own words: "This avoids having two different
 * PCB calculation engines or two different calculation displays." There was already one engine; there
 * were two displays in prospect (a drill-down on the payslip, a new panel on Transaction Detail), and two
 * displays of one calculation drift. Both entry points now LINK here, so there is exactly one.
 *
 * IT DOES NO ARITHMETIC. Not one figure on this screen is computed here: every number is read out of
 * `explainPcb`, which reads it out of the payslip's own `pcbMeta` stamp, which `pcbMonth` wrote at the
 * moment it deducted the tax. The substituted formula below is STRING ASSEMBLY over those stored figures
 * — the "= RM x" it ends on is the stored engine value, not this file's evaluation of the expression it
 * just printed. A screen that evaluated the formula itself could disagree with the payslip, and a screen
 * that disagrees with the payslip about tax is worse than no screen.
 *
 * WHICH PUTS THE WHOLE BURDEN ON THE EXPRESSION BEING THE RIGHT ONE. Since nothing here evaluates, a
 * printed term that does not belong is invisible in every test that checks numbers — it can only be
 * caught by reading the string against the engine. Three rules, each of which this screen got wrong once:
 *
 *   · P₁ AND P₂ ARE TWO CALCULATIONS, NOT ONE WITH AN OPTIONAL LIMB. In a bonus month the engine runs
 *     §D.1 on P₁ and §D.2 on P₂, and P₂ re-estimates the projected EPF leg (K₂ₜ, not K₂) because the
 *     bonus has eaten into the same annual relief cap. Appending "+ (Yₜ − Kₜ)" to the P₁ line produced an
 *     expression belonging to neither, overshooting the P printed beside it by the whole bonus.
 *
 *   · THE LAST LINE IS §E.3 + §E.5, NOT A SUBTRACTION. Between the two calculated legs and the deducted
 *     figure sit the RM10 rule on each leg and two zero-clamped subtractions (zakat takes the normal leg
 *     first, only its remainder reaches the additional leg). "normal + additional − zakat" is a different
 *     number whenever a leg is under RM10 or the zakat exceeds it.
 *
 *   · A HAND-SET PCB IS NOT EXPLAINED BY ANY OF IT. An operator override replaces `statutory.pcb` and
 *     leaves `pcbMeta` alone, so every figure below still describes the engine's calculation. The screen
 *     says so at the top and lands the working on `pcbSystem`, never on the overridden deduction.
 *
 * WHAT AN OLD PAYSLIP GETS. Runs processed before 45df860a carry no `trace`, so `explainPcb` hands back
 * `trace: null` and this screen says "not recorded for this run" in the places the legs would have gone.
 * It does NOT print them as RM 0.00 and it does NOT back-derive them from P: both would be a statement
 * about someone's tax that nobody computed. Historical months are deliberately never recomputed — the
 * figure on the screen must stay the figure that was deducted.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import type { PcbExplanation } from '@/core/pcb-explain';

export type PcbDetailContext = {
  employeeCode: string | null;
  employeeName: string;
  company: string;
  /** Already formatted for the reader's locale by the caller ("January 2026"). */
  periodLabel: string;
  /** The raw stored period, `YYYY-MM` — the tax YEAR is read off it. */
  payPeriod: string;
  runType: string;
  runSeq: number;
  currency: string | null;
  /** Statutory ruleset version stamped on the payslip (`payslipProvenance`), or null when it predates it. */
  rulesetVersion: string | null;
};

/** The four payroll cycles, mapped to STATIC keys in this screen's own namespace. A computed `t()` key is
 *  invisible to the i18n coverage scan, so the map is exhaustive and every value is pinned by
 *  test/pcb-detail.test.ts in all six catalogs. */
const CYCLE_LABEL: Record<string, 'cycleRegular' | 'cycleOffCycle' | 'cycleBonus' | 'cycleAdjustment'> = {
  regular: 'cycleRegular',
  off_cycle: 'cycleOffCycle',
  bonus: 'cycleBonus',
  adjustment: 'cycleAdjustment',
};

/** The s.48 tax category, likewise static-keyed. */
const CATEGORY_LABEL: Record<number, 'category1' | 'category2' | 'category3'> = {
  1: 'category1',
  2: 'category2',
  3: 'category3',
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

/** Formula and its substitution, side by side — requirement 14: never the symbols alone. */
function Formula({
  formulaLabel,
  formula,
  substitutedLabel,
  substituted,
  resultLabel,
  result,
}: {
  formulaLabel: string;
  formula: string;
  substitutedLabel: string;
  substituted: React.ReactNode;
  resultLabel: string;
  result: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{formulaLabel}</p>
        <p className="font-mono text-sm">{formula}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{substitutedLabel}</p>
        <p className="break-words font-mono text-sm tabular-nums">{substituted}</p>
      </div>
      <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{resultLabel}</span>
        <span className="font-mono text-sm font-semibold tabular-nums">{result}</span>
      </div>
    </div>
  );
}

export async function PcbDetailView({
  ctx,
  explanation,
}: {
  ctx: PcbDetailContext;
  explanation: PcbExplanation;
}) {
  const t = await getTranslations('payroll.pcbDetail');
  const cur = ctx.currency;
  const rm = (v: unknown) => formatMoney(v, cur);
  /** Bare 2-decimal number for use INSIDE a formula, where a currency prefix on every term is noise.
   *  The unit is stated once, on the line above each expression. */
  const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (r: number) => `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  const NotRecorded = () => <span className="font-normal text-muted-foreground">{t('notRecordedShort')}</span>;

  const cycleKey = CYCLE_LABEL[ctx.runType];
  const taxYear = /^\d{4}/.exec(ctx.payPeriod)?.[0] ?? ctx.payPeriod;

  const trace = explanation.kind === 'mtd' ? explanation.trace : null;
  /** The hand-set-PCB stamp, and the figure the working on this screen actually explains. With no
   *  override `sys` IS `explanation.pcb` and every line below reads exactly as it always did. */
  const override = explanation.override;
  const sys = explanation.pcbSystem;

  return (
    <div className="space-y-6">
      {/* ── Who and when. Requirement 1: the working must be tied to an employee, a company, a payroll
          month and a cycle, or it is a worksheet about nobody. ── */}
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
      </Block>

      {/* ── THE HAND-SET PCB, SAID FIRST. Above every working and outside every `kind` branch, because
          the sentence a reader needs before reading a single figure is that the figures below explain a
          calculation whose answer was then replaced. Rendering the working without this would make the
          screen a competent-looking derivation of an amount nobody deducted. ── */}
      {override && (
        <Card className="border-amber-500/40 bg-amber-500/10 p-4">
          <h2 className="mb-2 text-sm font-semibold">{t('overrideHeading')}</h2>
          <p className="mb-3 text-sm">{t('overrideBanner')}</p>
          <Row label={t('overrideSystem')} value={rm(override.system)} />
          <Row label={t('overrideApplied')} value={rm(override.applied)} />
          <Row label={t('overrideReason')} value={override.reason || t('notRecordedShort')} />
        </Card>
      )}

      {/* ── The working was never recorded at all (imported history, or a run predating the stamp). ── */}
      {explanation.kind === 'unavailable' && (
        <Block title={t('summaryHeading')}>
          <Row label={t('netMtd')} value={rm(explanation.pcb)} />
          <p className="pt-2 text-sm text-muted-foreground">{t('unavailable')}</p>
        </Block>
      )}

      {/* ── Flat rate: no reliefs, no accumulators, no bracket. An empty relief table would read as a
          gap; the flat percentage IS the whole calculation. ── */}
      {explanation.kind === 'flat' && (
        <Block title={t('flatHeading')}>
          <Row
            label={explanation.nonResident ? t('flatNonResident') : t('flatIncentive')}
            value={pct(explanation.rate)}
          />
          <Row
            label={t('flatRemuneration')}
            value={explanation.trace ? rm(explanation.trace.remuneration) : <NotRecorded />}
          />
          <Row
            label={t('flatAdditional')}
            value={explanation.trace ? rm(explanation.trace.additional) : <NotRecorded />}
          />
          <Row label={override ? t('netMtdSystem') : t('netMtd')} value={rm(sys)} />
          {override && <Row label={t('netMtdDeducted')} value={rm(explanation.pcb)} />}
          <div className="mt-3">
            <Formula
              formulaLabel={t('formulaLabel')}
              formula={t('flatFormula')}
              substitutedLabel={t('substitutedLabel')}
              substituted={
                explanation.trace ? (
                  `(${b2(explanation.trace.remuneration)} + ${b2(explanation.trace.additional)}) × ${pct(explanation.rate)}`
                ) : (
                  <NotRecorded />
                )
              }
              resultLabel={t('resultLabel')}
              // The ENGINE's figure, not the deduction: a hand-set PCB is not what this multiplication
              // produced, and printing it here would make the flat rate look like it explained the override.
              result={rm(sys)}
            />
          </div>
          {/* The flat leg is truncated, rounded up to 5 sen and RM10-floored exactly as the MTD leg is, so
              the product above lands within 5 sen of the figure rather than on it. Said, not hidden. */}
          <p className="pt-2 text-xs text-muted-foreground">{t('flatRoundingNote')}</p>
          <p className="pt-2 text-xs text-muted-foreground">{t('flatNote')}</p>
          {!explanation.trace && <p className="pt-2 text-xs text-muted-foreground">{t('traceNotRecorded')}</p>}
        </Block>
      )}

      {explanation.kind === 'mtd' && (
        <>
          {/* THE HONEST BANNER. It sits ABOVE the working, not under it, because a reader who scrolls
              past a table of dashes without seeing this will read the dashes as zeroes. */}
          {!trace && (
            <Card className="border-amber-500/40 bg-amber-500/10 p-4">
              <p className="text-sm">{t('traceNotRecorded')}</p>
            </Card>
          )}

          {/* ── Calculation summary (requirement 2 / 11) ── */}
          <Block title={t('summaryHeading')}>
            <Row label={t('mtdNormal')} value={trace ? rm(trace.mtdNormalCalc) : <NotRecorded />} />
            <Row label={t('mtdAdditional')} value={trace ? rm(trace.mtdAdditionalCalc) : <NotRecorded />} />
            <Row label={t('currentZakat')} value={rm(explanation.zakat)} muted />
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
              <span>{override ? t('netMtdSystem') : t('netMtd')}</span>
              <span className="tabular-nums">{rm(sys)}</span>
            </div>
            {override && (
              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                <span>{t('netMtdDeducted')}</span>
                <span className="tabular-nums">{rm(explanation.pcb)}</span>
              </div>
            )}
            <p className="pt-2 text-xs text-muted-foreground">{t('netMtdNote')}</p>
          </Block>

          {/* ── The formula, symbolically and substituted (requirements 4, 10, 14) ──
              THE TWO max( 0, … ) ARE NOT DECORATION. The inner one is `annualTaxFor`'s floor: B carries
              the RM400 / RM800 rebate as a NEGATIVE number, so for a small P the bracket line is below
              zero and the engine takes 0. The outer one is pcbMonth's, for a month whose accumulated
              Z + X already exceeds the year's tax. Print the bare bracket and a low earner's screen shows
              a negative expression beside a RM 0.00 answer. ── */}
          <Block title={t('formulaHeading')}>
            <Formula
              formulaLabel={t('formulaLabel')}
              formula={t('formulaMtd')}
              substitutedLabel={t('substitutedLabel')}
              substituted={
                trace ? (
                  `max( 0, max( 0, ( ${b2(explanation.chargeableIncome)} − ${b2(trace.M)} ) × ${pct(trace.R)} + ${b2(trace.B)} ) − ( ${b2(trace.Z)} + ${b2(explanation.pcbPaidYtd)} ) ) ÷ ( ${explanation.remainingMonths} + 1 )`
                ) : (
                  <NotRecorded />
                )
              }
              resultLabel={t('resultLabel')}
              result={trace ? rm(trace.mtdNormalCalc) : <NotRecorded />}
            />
            <p className="pt-2 text-xs text-muted-foreground">{t('roundingNote')}</p>

            {/* ── …and the LAST line: §E.3 then §E.5. The two calculated legs above are not the deduction.
                A is the normal leg after the RM10 rule, E the additional leg after the same rule, and the
                month's zakat reduces A first — only what it cannot absorb reaches E. Every one of those
                figures is stored by the engine (`zakatOffsetWorking`), so the expression below is the
                arithmetic that ran, and it lands on the figure the payslip carries. ── */}
            <div className="mt-3">
              <Row label={t('netA')} value={trace ? rm(trace.mtdNormalFloored) : <NotRecorded />} />
              <Row label={t('netE')} value={trace ? rm(trace.mtdAdditionalFloored) : <NotRecorded />} />
              <Row label={t('netZ1')} value={trace ? rm(trace.zakatCurrent) : rm(explanation.zakat)} muted />
              <Row label={t('netLeftover')} value={trace ? rm(trace.zakatLeftover) : <NotRecorded />} muted />
            </div>
            <div className="mt-3">
              <Formula
                formulaLabel={t('formulaLabel')}
                formula={t('formulaNet')}
                substitutedLabel={t('substitutedLabel')}
                substituted={
                  trace ? (
                    `max( 0, ${b2(trace.mtdNormalFloored)} − ${b2(trace.zakatCurrent)} ) + max( 0, ${b2(trace.mtdAdditionalFloored)} − max( 0, ${b2(trace.zakatCurrent)} − ${b2(trace.mtdNormalFloored)} ) )`
                  ) : (
                    <NotRecorded />
                  )
                }
                resultLabel={t('resultLabel')}
                result={rm(sys)}
              />
            </div>
            <p className="pt-2 text-xs text-muted-foreground">{t('netFormulaNote')}</p>
            <p className="pt-2 text-xs text-muted-foreground">{t('currencyNote', { currency: cur ?? '—' })}</p>
          </Block>

          {/* ── P and its components (requirement 5) ──
              P₁ HAS NO Yₜ LEG. §D.1 projects the year on normal remuneration alone; the bonus enters
              only through §D.2's separate P₂, which ALSO re-estimates the projected EPF leg (K₂ₜ rather
              than K₂, because the bonus has already consumed part of the same annual relief cap). They
              are two expressions landing on two stored numbers, so they are printed as two. ── */}
          <Block title={t('pHeading')}>
            <Formula
              formulaLabel={t('formulaLabel')}
              formula={t('pFormula')}
              substitutedLabel={t('substitutedLabel')}
              substituted={
                trace ? (
                  `${b2(explanation.ytdNetRemuneration)} + ( ${b2(trace.Y1)} − ${b2(trace.K1)} ) + ( ${b2(trace.Y2)} − ${b2(trace.K2)} ) × ${explanation.remainingMonths} − ${b2(explanation.reliefs.total)} − ${b2(explanation.reliefs.lp)}`
                ) : (
                  <NotRecorded />
                )
              }
              resultLabel={t('pResult')}
              result={rm(explanation.chargeableIncome)}
            />
            {trace && trace.Yt > 0 && explanation.chargeableIncomeWithAdditional != null && (
              <div className="mt-3">
                <Formula
                  formulaLabel={t('formulaLabel')}
                  formula={t('p2Formula')}
                  substitutedLabel={t('substitutedLabel')}
                  substituted={`${b2(explanation.ytdNetRemuneration)} + ( ${b2(trace.Y1)} − ${b2(trace.K1)} ) + ( ${b2(trace.Y2)} − ${b2(trace.K2t)} ) × ${explanation.remainingMonths} + ( ${b2(trace.Yt)} − ${b2(trace.Kt)} ) − ${b2(explanation.reliefs.total)} − ${b2(explanation.reliefs.lp)}`}
                  resultLabel={t('p2Result')}
                  result={rm(explanation.chargeableIncomeWithAdditional)}
                />
                <p className="pt-2 text-xs text-muted-foreground">{t('p2Note')}</p>
              </div>
            )}
            <div className="mt-3">
              <Row label={t('compAccNet')} value={rm(explanation.ytdNetRemuneration)} />
              <Row label={t('compEpfClaimed')} value={rm(explanation.epfClaimedYtd)} />
              <Row label={t('compY1')} value={trace ? rm(trace.Y1) : <NotRecorded />} />
              <Row label={t('compK1')} value={trace ? rm(trace.K1) : rm(explanation.epfThisMonth)} />
              <Row label={t('compY2')} value={trace ? rm(trace.Y2) : <NotRecorded />} />
              <Row label={t('compK2')} value={trace ? rm(trace.K2) : <NotRecorded />} />
              {trace && trace.Yt > 0 && <Row label={t('compK2t')} value={rm(trace.K2t)} muted />}
              <Row label={t('compN')} value={explanation.remainingMonths} />
              {explanation.chargeableIncomeWithAdditional != null && (
                <Row label={t('pWithAdditional')} value={rm(explanation.chargeableIncomeWithAdditional)} />
              )}
            </div>
            <p className="pt-2 text-xs text-muted-foreground">{t('grossYNote')}</p>
          </Block>

          {/* ── Tax relief (requirement 6) ── */}
          <Block title={t('reliefsHeading')}>
            <Row label={t('reliefIndividual')} value={rm(explanation.reliefs.individual)} />
            <Row label={t('reliefSpouse')} value={rm(explanation.reliefs.spouse)} />
            <Row label={t('reliefDisabledIndividual')} value={rm(explanation.reliefs.disabledIndividual)} />
            <Row label={t('reliefDisabledSpouse')} value={rm(explanation.reliefs.disabledSpouse)} />
            <Row label={t('reliefChildren')} value={rm(explanation.reliefs.children)} />
            <Row
              label={t('reliefChildCount')}
              value={trace ? trace.childCount : <NotRecorded />}
              muted
            />
            <Row label={t('reliefLpAccumulated')} value={trace ? rm(trace.lpAccumulated) : <NotRecorded />} muted />
            <Row label={t('reliefLpCurrent')} value={trace ? rm(trace.lpCurrent) : <NotRecorded />} muted />
            <Row label={t('reliefLpCombined')} value={rm(explanation.reliefs.lp)} muted />
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
              <span>{t('reliefTotal')}</span>
              <span className="tabular-nums">{rm(explanation.reliefs.total)}</span>
            </div>
            {/* WHICH relief position is on screen. A silent fallback would explain a closed month with a
                position that did not exist when it was calculated. */}
            <p className="pt-2 text-xs text-muted-foreground">
              {explanation.reliefSource === 'snapshot' ? t('reliefFromSnapshot') : t('reliefFromCurrent')}
            </p>
          </Block>

          {/* ── Tax bracket (requirement 7) ── */}
          <Block title={t('bracketHeading')}>
            <Row label={t('bracketM')} value={trace ? rm(trace.M) : <NotRecorded />} />
            <Row label={t('bracketR')} value={trace ? pct(trace.R) : <NotRecorded />} />
            <Row label={t('bracketB')} value={trace ? rm(trace.B) : <NotRecorded />} />
            <Row label={t('bracketTaxOnP')} value={trace ? rm(trace.taxOnP1) : <NotRecorded />} />
            <Row
              label={t('bracketCategory')}
              value={trace && CATEGORY_LABEL[trace.category] ? t(CATEGORY_LABEL[trace.category]) : <NotRecorded />}
              muted
            />
            <p className="pt-2 text-xs text-muted-foreground">{t('bracketNote')}</p>
          </Block>

          {/* ── Prior-month accumulators and the divisor (requirements 8, 9) ── */}
          <Block title={t('priorHeading')}>
            <Row label={t('priorZakat')} value={trace ? rm(trace.Z) : <NotRecorded />} />
            <Row label={t('priorPcb')} value={rm(explanation.pcbPaidYtd)} />
            <Row label={t('currentZakat')} value={rm(explanation.zakat)} />
            <Row label={t('monthOfYear')} value={`${explanation.month} / 12`} />
            <Row label={t('monthsRemaining')} value={explanation.remainingMonths} />
            <Row label={t('monthsDivisor')} value={explanation.remainingMonths + 1} />
            <p className="pt-2 text-xs text-muted-foreground">{t('monthsNote')}</p>
          </Block>

          {/* ── Additional remuneration (requirements 10, 12). Shown ALWAYS: the reporter asked for an
              explicit zero rather than an absent section, because absence reads as "not handled". ── */}
          <Block title={t('additionalHeading')}>
            <Row label={t('additionalAmount')} value={trace ? rm(trace.Yt) : <NotRecorded />} />
            <Row label={t('additionalEpf')} value={trace ? rm(trace.Kt) : <NotRecorded />} />
            <Row
              label={t('additionalChargeable')}
              value={
                explanation.chargeableIncomeWithAdditional != null ? (
                  rm(explanation.chargeableIncomeWithAdditional)
                ) : (
                  <span className="font-normal text-muted-foreground">{t('additionalNone')}</span>
                )
              }
            />
            <Row label={t('additionalMtdCalc')} value={trace ? rm(trace.mtdAdditionalCalc) : <NotRecorded />} />
            <Row label={t('additionalMtdDeducted')} value={rm(explanation.pcbAdditional)} />
            <div className="mt-3 border-t border-border pt-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('yearHeading')}
              </h3>
              {trace && trace.totalTaxYear != null && trace.totalMtdYear != null ? (
                <>
                  <Row label={t('yearTotalTax')} value={rm(trace.totalTaxYear)} />
                  <Row label={t('yearTotalMtd')} value={rm(trace.totalMtdYear)} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{trace ? t('yearNoAdditional') : t('notRecordedShort')}</p>
              )}
            </div>
          </Block>

          {/* ── The step-by-step trace (requirement 13) ──
              IT HAS TO REACH THE FINAL FIGURE. A chain that stopped at the normal leg and then printed
              the deducted PCB underneath was skipping the bonus leg, the RM10 rule and the zakat offset —
              three steps that between them can move the answer by the whole amount. ── */}
          <Block title={t('stepsHeading')}>
            <ol className="space-y-0">
              {(
                [
                  ['step1', rm(explanation.ytdNetRemuneration)],
                  ['step2', rm(explanation.epfClaimedYtd)],
                  ['step3', trace ? `${rm(trace.Y1)} − ${rm(trace.K1)}` : null],
                  ['step4', trace ? `(${rm(trace.Y2)} − ${rm(trace.K2)}) × ${explanation.remainingMonths}` : null],
                  ['step5', rm(explanation.reliefs.total)],
                  ['step6', rm(explanation.chargeableIncome)],
                  ['step7', trace ? `${t('bracketM')} ${rm(trace.M)} · ${t('bracketR')} ${pct(trace.R)} · ${t('bracketB')} ${rm(trace.B)}` : null],
                  ['step8', trace ? rm(trace.taxOnP1) : null],
                  ['step9', trace ? `${rm(trace.Z)} + ${rm(explanation.pcbPaidYtd)}` : null],
                  ['step10', trace ? rm(trace.mtdNormalCalc) : null],
                  ['step11', trace ? rm(trace.mtdAdditionalCalc) : null],
                  ['step12', trace ? `${rm(trace.mtdNormalFloored)} · ${rm(trace.mtdAdditionalFloored)}` : null],
                  ['step13', trace ? rm(trace.zakatCurrent) : rm(explanation.zakat)],
                ] as [
                  | 'step1' | 'step2' | 'step3' | 'step4' | 'step5' | 'step6' | 'step7'
                  | 'step8' | 'step9' | 'step10' | 'step11' | 'step12' | 'step13',
                  string | null,
                ][]
              ).map(([key, value], i) => (
                <li
                  key={key}
                  className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0"
                >
                  <span>
                    <span className="me-2 text-xs text-muted-foreground">{i + 1}</span>
                    {t(key)}
                  </span>
                  <span className="tabular-nums">{value ?? <NotRecorded />}</span>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3 text-base font-semibold">
              <span>{override ? t('finalPcbSystem') : t('finalPcb')}</span>
              <span className="tabular-nums">{rm(sys)}</span>
            </div>
            {/* The chain above ends at the ENGINE's figure. When the PCB was set by hand the deduction is
                a separate line with its own label — never the quiet answer to a working that did not
                produce it. */}
            {override && (
              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-base font-semibold">
                <span>{t('finalPcbDeducted')}</span>
                <span className="tabular-nums">{rm(explanation.pcb)}</span>
              </div>
            )}
            {override && <p className="pt-2 text-xs text-muted-foreground">{t('overrideNote')}</p>}
          </Block>
        </>
      )}

      {/* ── Calculation source (requirement 15) ── */}
      <Block title={t('sourceHeading')}>
        <Row label={t('sourceTaxYear')} value={taxYear} />
        <Row
          label={t('sourceTaxMethod')}
          value={explanation.kind === 'flat' ? t('methodFlat') : t('methodMtd')}
        />
        <Row
          label={t('sourceTaxTable')}
          value={ctx.rulesetVersion ?? <NotRecorded />}
        />
        <Row label={t('sourcePeriod')} value={ctx.periodLabel} />
        <Row label={t('sourceCycle')} value={cycleKey ? t(cycleKey) : ctx.runType} />
        <p className="pt-2 text-xs text-muted-foreground">{t('sourceNote')}</p>
      </Block>
    </div>
  );
}
