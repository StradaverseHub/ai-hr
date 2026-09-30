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
 *   · P₁ AND P₂ ARE TWO CALCULATIONS OF ONE PUBLISHED FORMULA, NOT ONE CALCULATION WITH AN OPTIONAL LIMB.
 *     In a bonus month the engine runs §D.1 on P₁ and §D.2 on P₂, and P₂ re-estimates the projected EPF
 *     leg (K₂ₜ, not K₂) because the bonus has eaten into the same annual relief cap. Appending
 *     "+ (Yₜ − Kₜ)" to the P₁ line produced an expression belonging to neither, overshooting the P
 *     printed beside it by the whole bonus.
 *
 *     r351 REVERSED THE GUARD THAT HID THE LIMB, AND KEPT THE POINT BEHIND IT. The limb used to be
 *     printed only when `trace.Yt > 0`, so on most payslips the P line simply had no (Yₜ − Kₜ) term and
 *     did not look like the agency's formula at all. The specification publishes ONE P formula and its own
 *     worked examples annotate it "Where (Yt – Kt ) = 0" for a month with no additional pay, so the limb
 *     is now always printed — as that zero, in figures. It is still NOT `trace.Yt`: the zero is a fact
 *     about §D.1, which excludes additional remuneration in a bonus month too, and the bonus still
 *     reaches the page only through the second calculation. `test/pcb-detail.test.ts` still forbids
 *     `trace.Yt` in the P₁ expression, now reading it out of `formulas.ts` where the expression lives.
 *
 *   · THE LAST LINE IS §E.3 + §E.5, NOT A SUBTRACTION. Between the two calculated legs and the deducted
 *     figure sit the RM10 rule on each leg and two zero-clamped subtractions (zakat takes the normal leg
 *     first, only its remainder reaches the additional leg). "normal + additional − zakat" is a different
 *     number whenever a leg is under RM10 or the zakat exceeds it.
 *
 *   · THE WORKING IS NOT ALWAYS ABOUT THE DEDUCTED FIGURE, AND THERE ARE TWO WAYS THAT HAPPENS. An
 *     operator override replaces `statutory.pcb` and leaves `pcbMeta` alone; an ADDITIONAL (bonus /
 *     off-cycle) run deducts the month's INCREMENT while `pcbMeta` stays the cumulative month. Either
 *     way every figure below still describes a different number from the one on the payslip. The screen
 *     says which at the top, lands every working on `pcbSystem`, and prints the deduction on its own
 *     labelled line — never as the quiet answer to a formula that did not produce it.
 *
 * 7f251381 — AND THE SAME FIGURES AGAIN, IN LHDN'S ORDER. The block at the top of the screen is the
 * identical set of recorded numbers laid out as LHDN's worksheet lays them out, under LHDN's symbols, so
 * a reader can put the two sheets side by side and find the ROW that disagrees instead of only the total.
 * It is NOT a second calculation and not even a second mapping: `core/pcb-explain.ts` builds the row list
 * (symbol, caption key, value) and this file only paints it, so the mapping that could be wrong is
 * testable without rendering anything. The symbols are language-neutral and come from core untranslated;
 * only the captions are looked up, which is why no Malay caption is hardcoded here.
 *
 * r351 — AND THE SAME FIGURES ONE MORE TIME, IN THE AGENCY'S OWN FIVE STEPS. The page below is ordered
 * and titled by the specification's lettering (Step 1 [A] category, [B] chargeable income for a year,
 * [C] the monthly deduction on net normal remuneration, [D] the net deduction after zakat, [E] the total
 * for the year). It used to carry five differently-named blocks and a thirteen-step trace of this file's
 * own invention, which a reader holding the agency's worked example could not follow down the page. The
 * thirteen captions are retired in the catalogue, not deleted. Three further consequences:
 *
 *   · EVERY EXPRESSION NOW LIVES IN `./formulas.ts`, because the DOWNLOADED PDF carried none of them.
 *   · EACH STEP SHOWS FOUR ROWS — formula, actual values, calculation, result — and the third is ABSENT
 *     wherever the engine stored no intermediate, rather than being computed here.
 *   · THE FORMULA ROW IS THE AGENCY'S, WHICH PRINTS NO FLOORS, WHILE THE SUBSTITUTION KEEPS THE CLAMPS
 *     THE ENGINE APPLIED. The difference is not left to be noticed: §E's zero floors and the RM10 rule
 *     are a visible step of their own between [C] and [D].
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
// ad7bc503 — CYCLE_LABEL and CATEGORY_LABEL moved to core/ so the DOWNLOADED document resolves the same
// two maps this screen does. They were private to this file and the document therefore printed neither
// the payroll cycle nor the marital tax status the reporter's section 1 asks for.
import { CATEGORY_LABEL, CYCLE_LABEL, pcbBasisLabels } from '@/core/pcb-explain';
import type { PcbExplanation, PcbSlipSection, PcbWorksheet, PcbWorksheetValue } from '@/core/pcb-explain';
// r351 — THE SUBSTITUTED EXPRESSIONS MOVED OUT OF THIS FILE, and not for tidiness: the DOWNLOADED PDF
// carried none of them. One assembly, painted by this screen and by `shared.ts`, is the only way the
// promise that the document shows "the same calculation details displayed on screen" survives an edit.
import { pcbFormulaBlocks, pcbFormulaByKey } from './formulas';

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
  /**
   * ad7bc503 — the reporter's section 1, completed. IC, or the PASSPORT number when the employee has no
   * IC (`payslipForReview` already resolves which and says so), so the screen can LABEL which document it
   * is printing rather than calling a passport an identity card.
   */
  identityNumber: string | null;
  identityIsPassport: boolean;
  /** LHDN's tax reference (TIN), as recorded. Null ⇒ nothing was recorded; never an empty-looking zero. */
  taxNumber: string | null;
  /**
   * The s.48 category as STORED on the employee (1 / 2 / 3), which the screen prints both as the category
   * and — the reporter asks for both — as the marital tax status it means. ONE stored fact, printed twice
   * under the two headings the agency's own slip uses, rather than two facts that could disagree.
   *
   * ⚠️ NOT the same thing as `trace.category`, which is the category the RUN applied. Both are shown: a
   * disagreement between them is exactly the kind of after-the-fact edit this screen exists to surface,
   * and collapsing them into one row is how it would go unnoticed.
   */
  taxCategory: number | null;
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

/**
 * Muted, secondary text — a module-level component on purpose. The `NotRecorded` helper further down
 * closes over `t` and so has to be created inside the render, which react-hooks/static-components
 * objects to at every use site; the rows ad7bc503 adds pass the resolved string in instead, so they add
 * no new instance of that objection to a file that already carries it.
 */
function Muted({ children }: { children: React.ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-6">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </Card>
  );
}

/**
 * 7f251381 — ONE LINE OF LHDN's WORKSHEET: its symbol, its caption, its figure.
 *
 * THE SYMBOL IS NOT TRANSLATED AND NOT STORED IN A CATALOGUE. Y, K₁, Σ(Y−K), M, R, B, Z, X are the same
 * characters on every copy of the form in every language — they are what the two sheets are matched on,
 * so a locale that "translated" one would break the matching this screen exists to enable. They come
 * through from `core/pcb-explain.ts` as data. The CAPTION beside each one is a key, resolved here, which
 * is why nothing in this file hardcodes a caption in any language.
 */
function WorksheetRow({
  symbol,
  label,
  value,
  previous,
}: {
  symbol: string;
  label: string;
  value: React.ReactNode;
  previous?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0 ${
        previous ? 'bg-amber-500/5' : ''
      }`}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          aria-hidden={symbol ? undefined : true}
          className="inline-block w-16 shrink-0 font-mono text-xs font-semibold text-primary"
        >
          {symbol}
        </span>
        <span className="min-w-0">{label}</span>
      </span>
      <span className="shrink-0 tabular-nums font-medium">{value}</span>
    </div>
  );
}

/**
 * ad7bc503 — ONE LINE OF THE REPORTER'S CALCULATION SLIP: its line marker, its caption, one or two
 * figures, and the annual limit the agency's own schedule prints beside it.
 *
 * IT IS A SECOND LAYOUT AND NOT A SECOND SOURCE. `WorksheetRow` above draws LHDN's symbol block, which
 * has one figure per symbol; the reporter's sections 2, 4, 7 and 8 are SCHEDULES, with a Current column
 * and an Accumulated column and a limit — the shape of the paper form, which is why they need their own
 * row rather than a third optional prop on that one. Both are painted from a list built in core/, both
 * resolve their captions through the catalogue, and neither reads a figure of its own.
 */
function SlipRow({
  line,
  label,
  limit,
  first,
  second,
  third,
  sub,
  dual,
  triple,
}: {
  line: string;
  label: string;
  limit?: React.ReactNode;
  first: React.ReactNode;
  second?: React.ReactNode;
  third?: React.ReactNode;
  sub?: boolean;
  dual?: boolean;
  triple?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span
        aria-hidden={line ? undefined : true}
        className={`inline-block w-10 shrink-0 font-mono text-xs font-semibold ${sub ? 'text-muted-foreground' : 'text-primary'}`}
      >
        {line}
      </span>
      <span className={`min-w-0 flex-1 ${sub ? 'ps-3 text-muted-foreground' : ''}`}>{label}</span>
      {limit !== undefined && (
        <span className="w-24 shrink-0 text-end text-xs tabular-nums text-muted-foreground">{limit}</span>
      )}
      <span className="w-32 shrink-0 text-end tabular-nums font-medium">{first}</span>
      {dual && <span className="w-32 shrink-0 text-end tabular-nums font-medium">{second}</span>}
      {/* The children grid's weighting column: a property of the CATEGORY, so it is muted like the limit
          column rather than presented as one of this employee's own figures. */}
      {triple && (
        <span className="w-32 shrink-0 text-end tabular-nums text-muted-foreground">{third}</span>
      )}
    </div>
  );
}

/**
 * Formula and its substitution, side by side — requirement 14: never the symbols alone.
 *
 * r351 — FOUR ROWS, NOT THREE: formula → actual values → CALCULATION → result, which is the sequence the
 * reporter asked for. `calculation` is one step further along than `substituted` and it is OPTIONAL,
 * because it may contain nothing that is not itself a figure the engine wrote down. Where no intermediate
 * was stored the row is absent rather than computed here; `formulas.ts` decides that, per step, and says
 * why on the line where it decides it.
 *
 * `legend` is the sentence the agency prints BENEATH a formula when one published formula serves two
 * calculations — "Where (Yt – Kt) = 0" is its own wording. It sits directly under the symbols, because a
 * reader who meets the substitution first has already been told which leg they are reading.
 */
function Formula({
  formulaLabel,
  formula,
  legend,
  substitutedLabel,
  substituted,
  calculationLabel,
  calculation,
  resultLabel,
  result,
}: {
  formulaLabel: string;
  formula: string;
  legend?: string;
  substitutedLabel: string;
  substituted: React.ReactNode;
  calculationLabel?: string;
  calculation?: React.ReactNode;
  resultLabel: string;
  result: React.ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{formulaLabel}</p>
        <p className="break-words font-mono text-sm">{formula}</p>
        {legend && <p className="pt-1 text-xs text-muted-foreground">{legend}</p>}
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{substitutedLabel}</p>
        <p className="break-words font-mono text-sm tabular-nums">{substituted}</p>
      </div>
      {calculation !== undefined && calculationLabel !== undefined && (
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{calculationLabel}</p>
          <p className="break-words font-mono text-sm tabular-nums">{calculation}</p>
        </div>
      )}
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
  worksheet,
  slip,
  closing,
}: {
  ctx: PcbDetailContext;
  explanation: PcbExplanation;
  /** 7f251381 — the same figures in LHDN's worksheet order, assembled in core/. NULL only when the caller
   *  could not build one; the sheet is then simply absent rather than drawn empty. */
  worksheet: PcbWorksheet | null;
  /** ad7bc503 — the reporter's sections 2, 4, 5, 6, 7 and 8, assembled in core/ from reads the page did.
   *  An EMPTY list only when the explanation carries no working to itemise. */
  slip: readonly PcbSlipSection[];
  /** r361 — the official's closing trio: its two numbered steps (page 6) and its CALCULATION RESULTS
   *  band (page 7), in its own order, assembled in core/ and iterated by the downloaded document too.
   *  EMPTY for a flat-rate payee and for a run with no recorded working — neither has a monthly MTD
   *  calculation whose steps could be numbered, and three bands of "not recorded" would claim one does. */
  closing: readonly PcbSlipSection[];
}) {
  const t = await getTranslations('payroll.pcbDetail');
  /**
   * ad7bc503 — THE SEVENTEEN RELIEF LINES ARE ALREADY WRITTEN, IN ALL SIX LOCALES, UNDER `taxRelief`.
   * The TP1 screen and the printed TP1 both resolve the agency's own wording from there, and a second
   * transcription of it under `payroll.pcbDetail` would be a second thing to keep in step with the form —
   * exactly what `localization/my/statutory-tables.ts` refuses for the catalogue itself. So a slip row
   * names its namespace and this picks the resolver; nothing here invents a caption.
   */
  const tr = await getTranslations('taxRelief');
  const cur = ctx.currency;
  const rm = (v: unknown) => formatMoney(v, cur);
  /** Bare 2-decimal number for use INSIDE a formula, where a currency prefix on every term is noise.
   *  The unit is stated once, on the line above each expression. */
  const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (r: number) => `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  /** r351 — the assembled expressions. `formulas.ts` chooses which stored figure goes where; these three
   *  formatters are the only thing this screen contributes to them, which is why they are injected. */
  const fb = pcbFormulaByKey(pcbFormulaBlocks(explanation, { b2, pct, int: (v: number) => `${v}` }));
  const NotRecorded = () => <span className="font-normal text-muted-foreground">{t('notRecordedShort')}</span>;
  /**
   * 7f251381 — ONE WORKSHEET CELL. This switch chooses a FORMATTER; it never chooses or computes a value.
   * Every `money` amount was read out of the payslip's stamp by `pcbWorksheet` in core/, so nothing on the
   * sheet is this file's arithmetic.
   *
   * THE THREE ABSENCES ARE THREE DIFFERENT SENTENCES and must not collapse into one dash:
   *   · notRecorded           — the run predates 45df860a and this leg was never written down.
   *   · notSeparatelyRecorded — the figure is real and was used, but only ever persisted netted into
   *                             another line (LHDN's gross Y lives inside Σ(Y − K)).
   *   · didNotRun             — §D.2 never executed, because the month paid no additional remuneration.
   * Printing "0.00" for any of the three would be a claim about someone's tax that nobody made.
   */
  const wsValue = (v: PcbWorksheetValue): React.ReactNode => {
    switch (v.kind) {
      case 'money':
        return rm(v.amount);
      case 'rate':
        return pct(v.rate);
      case 'count':
        return v.count;
      case 'text':
        return v.text;
      case 'caption':
        return <span className="font-normal text-muted-foreground">{t(v.caption)}</span>;
      case 'notSeparatelyRecorded':
        return <span className="font-normal text-muted-foreground">{t('worksheetNotSeparate')}</span>;
      case 'didNotRun':
        return <span className="font-normal text-muted-foreground">{t('worksheetDidNotRun')}</span>;
      case 'notRecorded':
        return <NotRecorded />;
    }
  };

  /**
   * r361 — ONE PAINTER FOR EVERY SLIP-SHAPED SECTION, AND THERE ARE NOW TWO LISTS OF THEM.
   *
   * `slip` is the reporter's detail behind the totals (ad7bc503); `closing` is the official's two
   * numbered steps and its CALCULATION RESULTS band (bf3c9712), which land at the FOOT of the page
   * because that is where the agency prints them. Both are `PcbSlipSection[]` built by
   * `core/pcb-explain.ts`, and both must render identically — a second copy of this JSX is how one list
   * quietly acquires a column, an absence wording or a caption resolver the other does not have, on a
   * document about somebody's tax.
   *
   * ⚠️ IT PAINTS AND DECIDES NOTHING. Every value goes through `wsValue`, which is a formatter chooser
   * with no arithmetic in it; every caption is resolved through the catalogue the ROW names; the line
   * marker is passed through untranslated. `test/ad7bc503-pcb-slip.test.ts` reads this function's own
   * source and refuses `explanation.`, `trace.`, `'0.00'` and `Number(` anywhere inside it.
   */
  const slipSections = (sections: readonly PcbSlipSection[]) =>
    sections.map((sec) => (
      <Block key={sec.heading} title={t(sec.heading)}>
        <div className="flex items-baseline gap-3 border-b border-border pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="inline-block w-10 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1" />
          {sec.limitColumn && <span className="w-24 shrink-0 text-end">{t(sec.limitColumn)}</span>}
          <span className="w-32 shrink-0 text-end">{t(sec.firstColumn)}</span>
          {sec.secondColumn && <span className="w-32 shrink-0 text-end">{t(sec.secondColumn)}</span>}
          {sec.thirdColumn && <span className="w-32 shrink-0 text-end">{t(sec.thirdColumn)}</span>}
        </div>
        {sec.rows.map((r) => (
          <SlipRow
            key={`${r.line}-${r.caption}`}
            line={r.line}
            label={r.ns === 'taxRelief' ? tr(r.caption) : t(r.caption)}
            limit={
              sec.limitColumn === undefined
                ? undefined
                : r.limit === undefined || r.limit === null
                  ? t('slipNoLimit')
                  : rm(r.limit)
            }
            first={wsValue(r.first)}
            second={r.second ? wsValue(r.second) : t('slipNoColumn')}
            third={r.third ? wsValue(r.third) : t('slipNoColumn')}
            sub={r.sub}
            dual={sec.secondColumn !== undefined}
            triple={sec.thirdColumn !== undefined}
          />
        ))}
        {sec.note && <p className="pt-2 text-xs text-muted-foreground">{t(sec.note)}</p>}
      </Block>
    ));

  const cycleKey = CYCLE_LABEL[ctx.runType];
  const taxYear = /^\d{4}/.exec(ctx.payPeriod)?.[0] ?? ctx.payPeriod;

  const trace = explanation.kind === 'mtd' ? explanation.trace : null;
  /** WHY the working and the deduction are different numbers, and the figure the working explains. With
   *  no basis `sys` IS `explanation.pcb` and every line below reads exactly as it always did. */
  const basis = explanation.basis;
  const sys = explanation.pcbSystem;
  // ad7bc503 — THE CAPTION SET NOW LIVES IN core/. It is read by the banner below AND by the downloaded
  // document (`pcbBasisSection`), which used to omit the banner altogether; one decision, two surfaces,
  // no second copy of an eight-branch ternary. Nothing about what this screen renders changed.
  const L = pcbBasisLabels(basis);
  /** An additional run's working describes the WHOLE MONTH, so a line that lands on `sys` has to be
   *  captioned as the month rather than as "what the system calculated". `pcbBasisLabels` applies this to
   *  the caption set; this screen has one further row of its own that turns on it. */
  const wholeMonth = basis != null && basis.prior != null;

  return (
    <div className="space-y-6">
      {/* ── Who and when. Requirement 1: the working must be tied to an employee, a company, a payroll
          month and a cycle, or it is a worksheet about nobody. ── */}
      <Block title={t('identificationHeading')}>
        <Row
          label={t('fieldEmployee')}
          value={ctx.employeeCode ? `${ctx.employeeCode} · ${ctx.employeeName}` : ctx.employeeName}
        />
        {/* ad7bc503 — the reporter's section 1 in full. The identity document is LABELLED for what it is:
            `payslipForReview` resolves IC first and falls back to the passport a non-Malaysian employee
            carries, and printing a passport number under "Identification No. (NRIC)" would be a false
            statement about a named person on a tax document. */}
        <Row
          label={ctx.identityIsPassport ? t('fieldPassport') : t('fieldIdentityNo')}
          value={ctx.identityNumber ?? <Muted>{t('notRecordedShort')}</Muted>}
        />
        <Row label={t('fieldTaxNumber')} value={ctx.taxNumber ?? <Muted>{t('notRecordedShort')}</Muted>} />
        <Row label={t('fieldCompany')} value={ctx.company} />
        <Row label={t('fieldPeriod')} value={ctx.periodLabel} />
        {/* ONE STORED FACT, PRINTED UNDER THE TWO HEADINGS THE AGENCY'S SLIP USES. `tax_category` IS the
            marital tax status — 1 single, 2 married with a spouse not working, 3 married with a spouse
            working — so the two rows cannot disagree, which two independently stored fields could. */}
        <Row
          label={t('fieldTaxCategory')}
          value={ctx.taxCategory == null ? <Muted>{t('notRecordedShort')}</Muted> : `${ctx.taxCategory}`}
        />
        <Row
          label={t('fieldMaritalStatus')}
          value={
            ctx.taxCategory != null && CATEGORY_LABEL[ctx.taxCategory] ? (
              t(CATEGORY_LABEL[ctx.taxCategory])
            ) : (
              <Muted>{t('notRecordedShort')}</Muted>
            )
          }
        />
        <Row
          label={t('fieldCycle')}
          value={`${cycleKey ? t(cycleKey) : ctx.runType}${ctx.runSeq > 1 ? ` #${ctx.runSeq}` : ''}`}
        />
      </Block>

      {/* ── WHICH FIGURE THIS SCREEN IS ABOUT, SAID FIRST. Above every working and outside every `kind`
          branch, because the sentence a reader needs before reading a single figure is that the working
          below lands on a number their payslip may not contain — because it was replaced by hand, or
          because this run deducted only the month's increase. Rendering the working without this makes
          the screen a competent-looking derivation of an amount nobody deducted. ── */}
      {basis && (
        <Card className="border-amber-500/40 bg-amber-500/10 p-4">
          <h2 className="mb-2 text-sm font-semibold">{t(L.bannerHeading)}</h2>
          <p className="mb-3 text-sm">{t(L.banner)}</p>
          <Row label={t(L.bannerSystem)} value={rm(basis.system)} />
          {basis.prior != null && <Row label={t('deltaPrior')} value={rm(basis.prior)} />}
          {/* The engine's own increment is worth a line only when it is NOT what was deducted — i.e. when
              an increment run was then also set by hand, and there are three figures to keep apart. */}
          {basis.kind === 'additionalRunManual' && basis.engineRun != null && (
            <Row label={t('deltaEngineRun')} value={rm(basis.engineRun)} />
          )}
          <Row label={t(L.bannerApplied)} value={rm(basis.applied)} />
          {basis.kind !== 'additionalRun' && (
            <Row label={t('overrideReason')} value={basis.reason || t('notRecordedShort')} />
          )}
        </Card>
      )}

      {/* ── 7f251381: THE SAME FIGURES, IN LHDN'S WORKSHEET ORDER, UNDER LHDN'S SYMBOLS ──
          FIRST on the screen, above our own arrangement, because its entire job is to be laid beside the
          reporter's copy of LHDN's sheet and read down. The rows come from `pcbWorksheet` in core/; this
          loop paints them. The previous-employment rows are marked because they are the four the
          reporter's case turns on and the four LHDN's own sheet gives no line of their own. ── */}
      {worksheet && worksheet.shape !== 'unavailable' && (
        <Block title={t('worksheetHeading')}>
          <p className="mb-4 text-sm text-muted-foreground">{t(worksheet.note)}</p>
          {worksheet.sections.map((sec) => (
            <div key={sec.heading} className="mt-5 first:mt-0">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t(sec.heading)}
              </h3>
              {sec.rows.map((r) => (
                <WorksheetRow
                  key={r.caption}
                  symbol={r.symbol}
                  label={t(r.caption)}
                  value={wsValue(r.value)}
                  previous={r.previousEmployment}
                />
              ))}
              {sec.note && <p className="pt-2 text-xs text-muted-foreground">{t(sec.note)}</p>}
            </div>
          ))}
        </Block>
      )}

      {/* ── ad7bc503: THE DETAIL BEHIND THE TOTALS — the reporter's sections 2, 4, 5, 6, 7 and 8 ──
          Sections 3, 9 and 10 are the block above; these are the itemisations that sat behind Q, ΣLP,
          LP1, Y1, Yt and Z1 and had nowhere to be shown. The rows come from `core/pcb-explain.ts`; this
          loop paints them and resolves each caption in the catalogue the row names.

          ⚠️ NOT ONE OF THESE CELLS IS A ZERO STANDING IN FOR A MISSING BOX. `wsValue` renders the three
          absences as three different sentences, and the reference's own 0.00 columns are the one place
          this page deliberately reads differently from it — see core/pcb-explain.ts and the plan. ── */}
      {slipSections(slip)}

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
          <Row label={basis ? t(L.netSystem) : t('netMtd')} value={rm(sys)} />
          {basis && <Row label={t(L.netDeducted)} value={rm(explanation.pcb)} />}
          {/* r351 — the SAME assembly the document paints. `result` is still the figure the multiplication
              ACTUALLY produced (the whole month's `pcbSystem`), never the deduction: the stored
              remuneration above is the cumulative month on an additional run, and a hand-set PCB is not
              what any multiplication produced. There is no `calculation` row here on purpose — the only
              intermediate is (remuneration + additional) and the engine never stored the sum. */}
          {fb.flat && (
            <div className="mt-3">
              <Formula
                formulaLabel={t('formulaLabel')}
                formula={t(fb.flat.formula)}
                substitutedLabel={t('substitutedLabel')}
                substituted={fb.flat.substituted ?? <NotRecorded />}
                resultLabel={t(fb.flat.resultLabel)}
                result={rm(sys)}
              />
            </div>
          )}
          {/* The flat leg is truncated, rounded up to 5 sen and RM10-floored exactly as the MTD leg is, so
              the product above lands within 5 sen of the figure rather than on it. Said, not hidden. */}
          {(fb.flat?.notes ?? []).map((k) => (
            <p key={k} className="pt-2 text-xs text-muted-foreground">
              {t(k)}
            </p>
          ))}
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
              <span>{basis ? t(L.netSystem) : t('netMtd')}</span>
              <span className="tabular-nums">{rm(sys)}</span>
            </div>
            {basis && (
              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
                <span>{t(L.netDeducted)}</span>
                <span className="tabular-nums">{rm(explanation.pcb)}</span>
              </div>
            )}
            <p className="pt-2 text-xs text-muted-foreground">{t('netMtdNote')}</p>
          </Block>

          {/* ══ r351: FROM HERE DOWN THE PAGE IS THE SPECIFICATION'S OWN MONTHLY STEPS, [A] TO [E] ══
              The document letters them — Step 1 [A] determine the category, [B] the chargeable income for
              a year, [C] the monthly tax deduction for net normal remuneration, [D] the NET deduction
              after zakat, [E] the total deduction for a year — and this screen had five differently-named
              blocks and a thirteen-line trace of its own invention. Two orderings of one calculation is
              exactly the drift this screen exists to remove, so ours is gone: the block titles ARE the
              agency's step letters, and `step1…step13` are retired in the catalogue rather than deleted. ══ */}

          {/* ── Step 1 [A] — the category. FIRST, because every later step depends on it: the B column of
              Table 1 is chosen by it and so is whether a spouse deduction exists at all. `trace.category`
              is the category the RUN applied, which is not necessarily the one stored on the employee
              today — the identification block above prints that one, and a disagreement between the two is
              exactly what this screen exists to surface. ── */}
          <Block title={t('stepAHeading')}>
            <Row
              label={t('bracketCategory')}
              value={trace && CATEGORY_LABEL[trace.category] ? t(CATEGORY_LABEL[trace.category]) : <NotRecorded />}
            />
            {/* `trace.childCount` is `number | null`; React renders null as NOTHING, so testing the
                trace instead of the field drew a silently empty cell on a tax explanation. Same defect
                as the PDF's, opposite symptom. See shared.ts's note at the equivalent row. */}
            <Row
              label={t('reliefChildCount')}
              value={trace?.childCount != null ? trace.childCount : <NotRecorded />}
            />
          </Block>

          {/* ── Step 1 [B] — P, and P₂ when a bonus was paid ──
              ONE PUBLISHED FORMULA, TWO CALCULATIONS. The specification prints a single P formula whose
              (Yₜ − Kₜ) limb its own worked examples annotate "Where (Yt – Kt ) = 0" in a month with no
              additional pay, so the limb is now ALWAYS printed — as that zero. It is not `trace.Yt`:
              §D.1 excludes additional remuneration entirely, in a bonus month too, and substituting the
              bonus here would overshoot the P beside it by the whole bonus. The bonus enters through the
              second calculation below, which ALSO re-estimates the projected EPF leg as K₂ₜ because the
              EPF on the bonus has consumed part of the same annual relief cap. Two expressions, two
              stored results, one formula — and `formulas.ts` assembles both for this screen and the PDF. ── */}
          <Block title={t('pHeading')}>
            {fb.p1 && (
              <Formula
                formulaLabel={t('formulaLabel')}
                formula={t(fb.p1.formula)}
                legend={fb.p1.legend ? t(fb.p1.legend) : undefined}
                substitutedLabel={t('substitutedLabel')}
                substituted={fb.p1.substituted ?? <NotRecorded />}
                calculationLabel={fb.p1.calculation === undefined ? undefined : t('calculationLabel')}
                calculation={fb.p1.calculation}
                resultLabel={t(fb.p1.resultLabel)}
                result={fb.p1.result === null ? <NotRecorded /> : rm(fb.p1.result)}
              />
            )}
            {fb.p2 && (
              <div className="mt-3">
                <Formula
                  formulaLabel={t('formulaLabel')}
                  formula={t(fb.p2.formula)}
                  legend={fb.p2.legend ? t(fb.p2.legend) : undefined}
                  substitutedLabel={t('substitutedLabel')}
                  substituted={fb.p2.substituted ?? <NotRecorded />}
                  calculationLabel={fb.p2.calculation === undefined ? undefined : t('calculationLabel')}
                  calculation={fb.p2.calculation}
                  resultLabel={t(fb.p2.resultLabel)}
                  result={fb.p2.result === null ? <NotRecorded /> : rm(fb.p2.result)}
                />
                {fb.p2.notes.map((k) => (
                  <p key={k} className="pt-2 text-xs text-muted-foreground">
                    {t(k)}
                  </p>
                ))}
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
            {(fb.p1?.notes ?? []).map((k) => (
              <p key={k} className="pt-2 text-xs text-muted-foreground">
                {t(k)}
              </p>
            ))}
          </Block>

          {/* ── Step 1 [C] — the monthly tax deduction on net normal remuneration ──
              THE FORMULA ROW IS THE AGENCY'S, FLOOR-FREE; THE SUBSTITUTION IS THE ARITHMETIC THAT RAN.
              The two are not the same shape and that is deliberate: the specification's headline formula
              prints no clamp, while its own rules treat a negative deduction as 0.00. B carries the
              RM400 / RM800 rebate as a NEGATIVE amount, so for a small P the bracket line falls below
              zero, and a month whose accumulated Z + X already exceeds the year's tax falls below zero
              again. Printing the bare bracket would show a low earner a negative expression beside a
              RM 0.00 answer — so the clamps stay in the substitution and the flooring is a VISIBLE step
              of its own immediately below, rather than a difference a reader has to notice unaided. ── */}
          {fb.mtd && (
            <Block title={t('formulaHeading')}>
              <Formula
                formulaLabel={t('formulaLabel')}
                formula={t(fb.mtd.formula)}
                substitutedLabel={t('substitutedLabel')}
                substituted={fb.mtd.substituted ?? <NotRecorded />}
                calculationLabel={fb.mtd.calculation === undefined ? undefined : t('calculationLabel')}
                calculation={fb.mtd.calculation}
                resultLabel={t(fb.mtd.resultLabel)}
                result={fb.mtd.result === null ? <NotRecorded /> : rm(fb.mtd.result)}
              />
              {fb.mtd.notes.map((k) => (
                <p key={k} className="pt-2 text-xs text-muted-foreground">
                  {t(k)}
                </p>
              ))}
            </Block>
          )}

          {/* ── §E — rounding, the zero floors and the RM10 rule, as a step a reader can see ──
              These four rows are the whole distance between "what the formula produced" and A and E, and
              until r351 they were a sentence in a footnote. Both calculated amounts are stored and so are
              both post-rule amounts, so the rule is shown as two before/after pairs and nothing is
              derived here. ── */}
          <Block title={t('floorHeading')}>
            <Row label={t('mtdNormal')} value={trace ? rm(trace.mtdNormalCalc) : <NotRecorded />} />
            <Row label={t('netA')} value={trace ? rm(trace.mtdNormalFloored) : <NotRecorded />} />
            <Row label={t('mtdAdditional')} value={trace ? rm(trace.mtdAdditionalCalc) : <NotRecorded />} />
            <Row label={t('netE')} value={trace ? rm(trace.mtdAdditionalFloored) : <NotRecorded />} />
            <p className="pt-2 text-xs text-muted-foreground">{t('floorNote')}</p>
          </Block>

          {/* ── Step 1 [D] — the NET monthly tax deduction for the current month ──
              The agency's own [D] is "Step [C] − zakat for the current month, if any", and the arithmetic
              that runs is that sentence plus §E.5's cascade: zakat takes the normal amount first and only
              its remainder reaches the additional one, each clamped at zero. Every figure in it is stored
              (`zakatOffsetWorking`), so the expression lands on the figure the payslip carries. ── */}
          {fb.net && (
            <Block title={t('netHeading')}>
              <Row label={t('netA')} value={trace ? rm(trace.mtdNormalFloored) : <NotRecorded />} />
              <Row label={t('netE')} value={trace ? rm(trace.mtdAdditionalFloored) : <NotRecorded />} />
              <Row label={t('netZ1')} value={trace ? rm(trace.zakatCurrent) : rm(explanation.zakat)} muted />
              <Row label={t('netLeftover')} value={trace ? rm(trace.zakatLeftover) : <NotRecorded />} muted />
              <div className="mt-3">
                <Formula
                  formulaLabel={t('formulaLabel')}
                  formula={t(fb.net.formula)}
                  substitutedLabel={t('substitutedLabel')}
                  substituted={fb.net.substituted ?? <NotRecorded />}
                  calculationLabel={fb.net.calculation === undefined ? undefined : t('calculationLabel')}
                  calculation={fb.net.calculation}
                  resultLabel={t(fb.net.resultLabel)}
                  result={fb.net.result === null ? <NotRecorded /> : rm(fb.net.result)}
                />
              </div>
              {fb.net.notes.map((k) => (
                <p key={k} className="pt-2 text-xs text-muted-foreground">
                  {t(k)}
                </p>
              ))}
              <p className="pt-2 text-xs text-muted-foreground">{t('currencyNote', { currency: cur ?? '—' })}</p>
            </Block>
          )}

          {/* ── Step 1 [E] — the total monthly tax deduction for the year ──
              ⚠️ THE SUBSTITUTION IS ABSENT IN A MONTH WITH NO ADDITIONAL PAY, AND IS NOT DERIVED. `pcbMonth`
              stamps `totalMtdYear` only inside its `Yt > 0` branch, because Step 1[E] exists to feed §D.2
              Step 4 and nothing else reads it. Every term of X + [ [C] × (n + 1) ] is on this page, so
              multiplying them here would be easy — and it is the one thing this screen must never do, since
              a figure it computed could disagree with the payslip. The formula is shown either way; the
              answer is shown only when the engine recorded one. ── */}
          {fb.year && (
            <Block title={t(fb.year.heading)}>
              <Row label={t('yearTotalTax')} value={trace && trace.totalTaxYear != null ? rm(trace.totalTaxYear) : <NotRecorded />} />
              <div className="mt-3">
                <Formula
                  formulaLabel={t('formulaLabel')}
                  formula={t(fb.year.formula)}
                  substitutedLabel={t('substitutedLabel')}
                  substituted={fb.year.substituted ?? <NotRecorded />}
                  resultLabel={t(fb.year.resultLabel)}
                  result={fb.year.result === null ? <NotRecorded /> : rm(fb.year.result)}
                />
              </div>
              {fb.year.notes.map((k) => (
                <p key={k} className="pt-2 text-xs text-muted-foreground">
                  {t(k)}
                </p>
              ))}
            </Block>
          )}

          {/* ── Tax relief (requirement 6) — the terms of [B]'s second bracket ── */}
          <Block title={t('reliefsHeading')}>
            <Row label={t('reliefIndividual')} value={rm(explanation.reliefs.individual)} />
            <Row label={t('reliefSpouse')} value={rm(explanation.reliefs.spouse)} />
            <Row label={t('reliefDisabledIndividual')} value={rm(explanation.reliefs.disabledIndividual)} />
            <Row label={t('reliefDisabledSpouse')} value={rm(explanation.reliefs.disabledSpouse)} />
            <Row label={t('reliefChildren')} value={rm(explanation.reliefs.children)} />
            <Row
              label={t('reliefChildCount')}
              // Field, not trace — see the Step 1 [A] row above.
              value={trace?.childCount != null ? trace.childCount : <NotRecorded />}
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

          {/* ── Tax bracket (requirement 7) — M, R and B, the terms of [C]. The category that CHOSE the B
              column is step [A] above and is not repeated here. ── */}
          <Block title={t('bracketHeading')}>
            <Row label={t('bracketM')} value={trace ? rm(trace.M) : <NotRecorded />} />
            <Row label={t('bracketR')} value={trace ? pct(trace.R) : <NotRecorded />} />
            <Row label={t('bracketB')} value={trace ? rm(trace.B) : <NotRecorded />} />
            <Row label={t('bracketTaxOnP')} value={trace ? rm(trace.taxOnP1) : <NotRecorded />} />
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
              explicit zero rather than an absent section, because absence reads as "not handled". The
              year totals that used to hang off the foot of this block are step [E] above, where the
              specification puts them. ── */}
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
            {/* The split belongs to the CALCULATION, so on an additional run this leg is the whole
                month's too — captioned as such, because "deducted" would be a false claim about a slip
                that only carried the increase. */}
            <Row
              label={wholeMonth ? t('additionalMtdMonth') : t('additionalMtdDeducted')}
              value={rm(explanation.pcbAdditional)}
            />
          </Block>

          {/* ── The five steps of the specification's own monthly calculation, and the figure each lands on ──
              THIRTEEN STEPS OF OUR OWN BECAME THE AGENCY'S FIVE. The old chain was numbered 1–13 and
              grouped the way this file happened to be written; the specification letters the same
              calculation [A]–[E] and a reader holding its worked example could not follow ours down the
              page. The thirteen captions are RETIRED in all six catalogues rather than deleted — a key
              deleted and later re-added is the MISSING_MESSAGE trap this repo has hit before. ── */}
          <Block title={t('stepsHeading')}>
            <ol className="space-y-0">
              {(
                [
                  ['A', 'stepA', trace && CATEGORY_LABEL[trace.category] ? t(CATEGORY_LABEL[trace.category]) : null],
                  ['B', 'stepB', rm(explanation.chargeableIncome)],
                  ['C', 'stepC', trace ? rm(trace.mtdNormalCalc) : null],
                  ['D', 'stepD', trace ? rm(sys) : null],
                  ['E', 'stepE', trace && trace.totalMtdYear != null ? rm(trace.totalMtdYear) : null],
                ] as [string, 'stepA' | 'stepB' | 'stepC' | 'stepD' | 'stepE', React.ReactNode][]
              ).map(([letter, key, value]) => (
                <li
                  key={key}
                  className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0"
                >
                  <span>
                    <span className="me-2 font-mono text-xs font-semibold text-primary">{letter}</span>
                    {t(key)}
                  </span>
                  <span className="tabular-nums">{value ?? <NotRecorded />}</span>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3 text-base font-semibold">
              <span>{basis ? t(L.finalSystem) : t('finalPcb')}</span>
              <span className="tabular-nums">{rm(sys)}</span>
            </div>
            {/* The chain above ends where the CALCULATION ends. When the PCB was set by hand, or when this
                run deducted only the month's increase, the deduction is a separate line with its own
                label — never the quiet answer to a working that did not produce it. */}
            {basis && (
              <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-base font-semibold">
                <span>{t(L.finalDeducted)}</span>
                <span className="tabular-nums">{rm(explanation.pcb)}</span>
              </div>
            )}
            {basis && <p className="pt-2 text-xs text-muted-foreground">{t(L.note)}</p>}
          </Block>
        </>
      )}

      {/* ── r361 / bf3c9712: THE OFFICIAL'S CLOSING TRIO, WHERE THE OFFICIAL PUTS IT ──
          The agency's slip ends "1. MTD excess of annual year net remuneration excluding additional
          remuneration" → "2. MTD must be deducted" → CALCULATION RESULTS, and our page ended one band
          early: a reader holding their copy ran out of ours before reaching the line the two documents
          are supposed to meet on. The three bands come from `pcbClosingSections` in core/ and are painted
          by the SAME function the detail sections above use, so the downloaded document cannot carry a
          different set or a different order.

          ⚠️ THE LAST FIGURE IS THE PAYSLIP'S OWN STAMP, never a rounding performed here — see the block
          comment above `pcbMtdStep1Section`. Where the working does not explain the deduction, the two
          figures keep the two separately captioned rows the rest of this screen gives them. ── */}
      {slipSections(closing)}

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
