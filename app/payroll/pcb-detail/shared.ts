import { pcbExemptionDetail, type PcbExemptionDetail } from '@/core/pcb-exemptions';
import { pcbExemptionTable } from './exemption-table';
/**
 * ad7bc503 — THE PCB / MTD CALCULATION DETAIL AS A DOCUMENT: THE GATE, THE READ AND THE RENDER, ONCE.
 *
 * ⚠️ THE BODY LIVES HERE AND NOT IN `download/route.ts`, FOR THE REASON `../statutory-forms/pcb2ii/
 * shared.ts` records at length. That surface shipped a download in r323 and a preview in r328, and the
 * only difference between the two routes is ONE header value — `attachment` or `inline`. A second route
 * that re-implemented `scopedAdmin`, the id shape test, the scope check and the lang allowlist would be
 * two copies of one access decision, and the copy that drifts is the one nobody looks at again. So this
 * file holds the decision and the route is four lines long: there is nothing in it that COULD drift, and
 * if a preview is ever asked for it is one more four-line file, not a second door.
 *
 * GATED LIKE THE SCREEN, AND NO WIDER. `scopedAdmin` rather than `isAdmin` (an hr_admin grant on ANY
 * company makes `isAdmin` true, and this document carries a named person's identity-card number, their
 * tax reference, their children and every relief they declared), then `payslipForReview` fenced on the
 * caller's own `companyIds`, which fails CLOSED on an empty scope. A malformed id, a foreign company, an
 * out-of-scope company and a payslip that does not exist are ALL the same bare 404, so the URL cannot be
 * used to enumerate any of them — the identical posture to the screen this document reproduces.
 *
 * ⚠️ AND IT IS NOT A LIGHTER SURFACE THAN THE SCREEN. It carries the same figures about the same named
 * person. The ESS release gate (`payslipDetail`) is neither used nor widened here, exactly as on the
 * screen: a reviewer's whole job is to check a run BEFORE anyone in the company sees it.
 *
 * NO DOMAIN EVENT: rendering a statement of how a deduction was calculated is a READ, and this is not a
 * filing. Same decision, same words, as the PCB 2(II) and TP1 downloads.
 *
 * ── WHAT IS DELIBERATELY DUPLICATED, AND WHY IT IS THE LESSER EVIL ──────────────────────────────────
 * The six read calls below are also made by `./page.tsx`. That is not tidiness lost by accident: the
 * source guards in test/pcb-detail.test.ts and test/7f251381-pcb-lhdn-worksheet.test.ts assert the fence
 * by MATCHING THE TEXT of `payslipForReview(s, { companyIds: scopeIds` and `previousEmploymentForPayslip(s,
 * {` IN page.tsx, so moving the orchestration out of that file would delete the guard that proves this
 * screen is scoped. What is NOT duplicated is everything that can be WRONG: `explainPcb`, `pcbWorksheet`,
 * `pcbSlipData` and `pcbSlipSections` are the same four functions the screen calls, in the same order,
 * with the same arguments — so the document and the screen cannot disagree about a figure, a mapping or
 * an absence. Only the plumbing is written twice, and `test/ad7bc503-pcb-slip.test.ts` drives BOTH paths
 * over one generated payslip and requires the model to be identical.
 *
 * ── r372: AND THE FIFTH FUNCTION, WHICH IS THE ONE THAT WAS MISSING ────────────────────────────────
 * Those four gave the two surfaces one set of FIGURES. Nothing gave them one LAYOUT: the screen's order
 * was hand-placed JSX and this file's was a run of `sections.push` calls, and they had drifted — five
 * whole sections the screen carried were absent here, `netHeading` and `yearHeading` were each emitted
 * TWICE and `pHeading` twice in a bonus month, the currency note was missing, and the payroll month
 * printed as the stored "2026-06" where the screen printed "June 2026". The reporter's criteria 19, 20
 * and 21 were false and no test could see it, because each surface was asserted against its own
 * expectations. `pcbDetailLayout` is now the single ordered list of what this document contains, in what
 * order, under which number; both surfaces iterate it and switch EXHAUSTIVELY over its closed slot union,
 * so a section added, moved or renumbered moves on both or compiles on neither.
 */
import { formatQualifyingChildCount } from '@/localization/child-qualification';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { currentPcbReliefs, payslipForReview, previousEmploymentForPayslip } from '@/core/payroll-view';
import {
  CATEGORY_LABEL,pcbTaxCategoryIdentity,
  CYCLE_LABEL,
  explainPcb,
  pcbBasisLabels,
  pcbBasisSection,
  pcbClosingSections,
  pcbDetailLayout,
  pcbSlipSections,
  pcbWorksheet,
} from '@/core/pcb-explain';
import type {
  PcbDetailBodySlot,
  PcbExplanation,
  PcbSlipSection,
  PcbWorksheet,
  PcbWorksheetValue,
} from '@/core/pcb-explain';
import { payslipProvenance } from '@/core/payslip-recompute';
import { formatMoney } from '@/lib/money';
// r372 — ONE month formatter for the screen and the document. See lib/month-name.ts on why.
import { monthYearLabel } from '@/lib/month-name';
import { SLIP_ITEMS, SLIP_REBATES, pcbSlipData } from './slip-data';
// r351 — the SAME assembly the screen paints. See the block comment where it is used.
import { pcbFormulaBlocks, pcbFormulaByKey, pcbNormalMtdStep1Blocks, type PcbFormulaBlock } from './formulas';
import { renderPcbDetailPdf, type PcbSlipPdfRow, type PcbSlipPdfSection } from './slip-pdf';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * LHDN publishes in Bahasa Malaysia and English, and `slip-pdf.ts` embeds Helvetica, which is WinAnsi.
 * Resolving this document's captions against the viewer's UI locale would print a calculation slip whose
 * every line reads as rows of '?' for four of our six locales — `messages/{ta,th,vi,zh}.json` translate
 * all of it. So `lang` chooses between the two the agency itself issues, it is ALLOWLISTED rather than
 * handed on, and an unknown value falls back to English rather than reaching next-intl (which throws on an
 * unknown locale and would turn a bad query string into a 500). Same guard, same reason, as
 * app/payroll/transactions/tp1/[year]/[month]/pdf/route.ts.
 */
const LANGS = ['en', 'ms'] as const;
type SlipLang = (typeof LANGS)[number];

const notFound = () => new Response('Not found', { status: 404 });

/** `attachment` saves the file; `inline` would open it in the browser's viewer. Nothing else differs. */
export type PcbDetailDisposition = 'attachment' | 'inline';

/** The model the screen and the document are both built from. See the header on what is shared. */
export type PcbDetailModel = {
  explanation: PcbExplanation;
  worksheet: PcbWorksheet;
  slip: PcbSlipSection[];
  /** r361 — the official's two numbered steps and its CALCULATION RESULTS band, in its own order. It is
   *  part of the MODEL and not of either renderer, so the screen and this document iterate one list.
   *  r372 — and WHERE each of them goes is `pcbDetailLayout`'s answer, over this same model. */
  closing: PcbSlipSection[];
  exemptions: PcbExemptionDetail;
};

/**
 * THE FOUR SHAPING CALLS, IN THE ORDER THE SCREEN MAKES THEM, over rows the caller has already read.
 *
 * Pure: it issues no query and decides no scope. That is what lets the test drive it beside the screen's
 * own chain and require the two to be identical, which is the anti-drift guard the header promises.
 */
export function pcbDetailModel(p: {
  statutory: unknown;
  payPeriod?: string;
  fallbackReliefs: Parameters<typeof explainPcb>[1];
  previousEmployment: Parameters<typeof pcbWorksheet>[1];
  slipData: Awaited<ReturnType<typeof pcbSlipData>> | null;
}): PcbDetailModel {
  const explanation = explainPcb(p.statutory, p.fallbackReliefs);
  return {
    explanation,
    worksheet: pcbWorksheet(explanation, p.previousEmployment),
    slip: p.slipData
      ? pcbSlipSections(explanation, {
          profile: p.slipData.profile,
          // r372 — the head count for sequence 2, read from the same `pcbSlipData` the screen reads.
          childHeadCount: p.slipData.childHeadCount,
          catalogue: SLIP_ITEMS,
          rebateCatalogue: SLIP_REBATES,
          currentDeduction: p.slipData.currentDeduction,
          accumulatedDeduction: p.slipData.accumulatedDeduction,
          previousDeduction: p.slipData.previousDeduction,
          currentRebate: p.slipData.currentRebate,
          accumulatedRebate: p.slipData.accumulatedRebate,
          accumulatedRemuneration: p.slipData.accumulatedRemuneration,
        })
      : [],
    closing: pcbClosingSections(explanation),
    exemptions: pcbExemptionDetail(p.statutory, p.payPeriod),
  };
}

/**
 * The whole document for ONE payslip, gated, read, laid out and returned.
 *
 * @param disposition the ONE thing that differs between this and a preview.
 */
export async function pcbDetailPdfResponse(req: Request, disposition: PcbDetailDisposition): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const payslipId = q.get('payslipId') ?? '';
  // Shape first, before any query: a mangled id out of a shared link never reaches Postgres, where it
  // would be `invalid input syntax for type uuid` and, with no error boundary over a route handler, a 500
  // instead of the 404 an absent payslip deserves. Same guard the screen carries, same reason.
  if (!UUID.test(payslipId)) return notFound();

  const { s, scopeIds } = await scopedAdmin();
  const row = await payslipForReview(s, { companyIds: scopeIds, payslipId });
  if (!row) return notFound();

  const langParam = q.get('lang');
  const lang: SlipLang = LANGS.includes(langParam as SlipLang) ? (langParam as SlipLang) : 'en';

  const fallbackReliefs = await currentPcbReliefs(s, {
    companyIds: scopeIds,
    employmentId: row.employmentId,
    asOf: `${row.payPeriod}-28`,
  });
  const taxYear = Number(/^\d{4}/.exec(row.payPeriod)?.[0] ?? Number.NaN);
  const previousEmployment = await previousEmploymentForPayslip(s, {
    companyIds: scopeIds,
    employmentId: row.employmentId,
    taxYear,
  });
  const probe = explainPcb(row.statutory, fallbackReliefs);
  const slipData =
    probe.kind === 'mtd'
      ? await pcbSlipData(s, {
          companyIds: scopeIds,
          employmentId: row.employmentId,
          taxYear,
          month: probe.month,
        })
      : null;
  const model = pcbDetailModel({ statutory: row.statutory, payPeriod: row.payPeriod, fallbackReliefs, previousEmployment, slipData });

  const [t, tr] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'payroll.pcbDetail' }),
    getTranslations({ locale: lang, namespace: 'taxRelief' }),
  ]);
  const prov = payslipProvenance(row.statutory);
  const cur = row.currency ?? null;

  /**
   * ⚠️ THE ONE PLACE A FIGURE BECOMES A STRING, AND THE ONLY PLACE AN ABSENCE IS WORDED.
   *
   * The three absences are three different sentences and must not collapse into one dash or — far worse
   * on a tax document — into "0.00". `slip-pdf.ts` never sees a number it could default, because this
   * function has already decided what every cell says. It is the screen's own `wsValue`, in words instead
   * of in spans, resolving the SAME keys from the SAME catalogue.
   */
  const cell = (v: PcbWorksheetValue | undefined): string => {
    if (!v) return '';
    switch (v.kind) {
      case 'money':
        return formatMoney(v.amount, cur);
      case 'rate':
        return `${(v.rate * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
      case 'count':
        return formatQualifyingChildCount(v.count);
      case 'text':
        return v.text;
      case 'caption':
        return t(v.caption);
      case 'notSeparatelyRecorded':
        return t('worksheetNotSeparate');
      case 'didNotRun':
        return t('worksheetDidNotRun');
      case 'notRecorded':
        return t('notRecordedShort');
    }
  };

  const sections: PcbSlipPdfSection[] = [];

  const kv = (label: string, value: string | null): PcbSlipPdfRow => ({
    line: '',
    label,
    cells: [value && value.trim() !== '' ? value : t('notRecordedShort')],
  });
  const categoryIdentity=pcbTaxCategoryIdentity(model.explanation);
  const category=categoryIdentity.category;
  const cycleKey = CYCLE_LABEL[row.runType];

  /**
   * ⚠️ r372 — THE MONTH IS NAMED, NOT PRINTED AS A STORED STRING. This document used to carry the raw
   * `payPeriod` — "2026-06" — in the masthead and in section 1, where the screen says "June 2026". The
   * reporter's criterion 20 is that the two show the same values, and a reader holding both had to work out
   * that two differently-spelled things were one month. It is resolved against the DOCUMENT's own language
   * (`lang`, allowlisted to the two the agency itself issues) rather than the reader's UI locale, because
   * this file's fonts can only print those two — `lib/month-name.ts` is the one formatter both surfaces use.
   */
  const periodLabel = monthYearLabel(row.payPeriod, lang);

  const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctOf = (r: number) => `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  const money = (v: number) => formatMoney(v, cur);
  /** A row of prose or of an expression: the whole text width, no figure column, no line marker. */
  const wide = (label: string): PcbSlipPdfRow => ({ line: '', label, cells: [] });
  const figure = (label: string, value: string, strong = false): PcbSlipPdfRow => ({ line: '', label, cells: [value], strong });

  const x = model.explanation;
  const trace = x.kind === 'mtd' ? x.trace : null;
  const mtd = x.kind === 'mtd' ? x : null;
  const flat = x.kind === 'flat' ? x : null;
  const L = pcbBasisLabels(x.basis);
  const na = t('notRecordedShort');
  const wholeMonth = x.basis != null && x.basis.prior != null;
  const basis = x.basis;
  const fb = pcbFormulaByKey(pcbFormulaBlocks(x, { b2, pct: pctOf, int: (v: number) => `${v}` }));

  /**
   * ⚠️ r372 — THE FOUR ROWS OF A STEP, ASSEMBLED ONCE FOR EVERY STEP THAT HAS THEM.
   *
   * THE LONG EXPRESSIONS GO IN THE LABEL, NOT IN A FIGURE COLUMN. A figure column is 96 points wide and
   * right-aligned; a 200-character substituted formula placed in one would be drawn leftwards straight
   * across the label beside it. So a formula row carries no cell at all and wraps across the full text
   * width, and only the RESULT — a single amount — is right-aligned as a figure.
   *
   * ABSENT, not zero and not derived: `formulas.ts` omits the calculation row for a step whose intermediate
   * the engine never stored, and this must omit it for exactly the same reason.
   */
  const formulaRows = (blk: PcbFormulaBlock): PcbSlipPdfRow[] => {
    const rows: PcbSlipPdfRow[] = [wide(`${t('formulaLabel')}:  ${t(blk.formula)}`)];
    if (blk.legend) rows.push(wide(t(blk.legend)));
    rows.push(wide(`${t('substitutedLabel')}:  ${blk.substituted ?? na}`));
    if (blk.calculation !== undefined) rows.push(wide(`${t('calculationLabel')}:  ${blk.calculation}`));
    rows.push(figure(t(blk.resultLabel), blk.result === null ? na : money(blk.result), true));
    return rows;
  };
  const noteOf = (blk: PcbFormulaBlock | undefined): string | undefined =>
    blk && blk.notes.length > 0 ? blk.notes.map((k) => t(k)).join(' ') : undefined;

  /** ONE figure column even where only the result row uses it: `labelW` is computed from the column count,
   *  so declaring it is what keeps a wrapped expression from being drawn under the amount. */
  const AMOUNT = [t('slipColAmount')];

  /**
   * ══ r372 — ONE BODY PER SLOT, EXHAUSTIVE, AND THE SCREEN'S TWIN ══
   *
   * `pcb-detail-view.tsx` has the identical switch over the identical closed union, and both are driven by
   * `pcbDetailLayout`. That is what makes "five sections reached the screen and not the paper" — which is
   * what this document shipped until r372 — a compile error rather than something only a render check
   * could find. The `never` in the default is load-bearing: without it a missing slot would compile.
   *
   * ⚠️ AND IT IS THE SCREEN'S OWN ASSEMBLY, NOT A SECOND COPY OF IT. `pcbFormulaBlocks` is the function
   * `pcb-detail-view.tsx` calls, with the same explanation and equivalent formatters, so an expression
   * cannot differ between the page and the file that leaves the building.
   */
  const bodyFor = (slot: PcbDetailBodySlot): { rows: PcbSlipPdfRow[]; columns?: string[]; labelColumn?: string; note?: string } => {
    switch (slot) {
      // ⚠️ THE SAME EIGHT ROWS THE SCREEN RENDERS, AND NO MORE. Until r372 this block also carried the
      // statutory table version, which on the screen belongs to the "Calculation source" footer — and that
      // footer was absent from this document altogether, so the row had nowhere else to be. It has one now.
      case 'identification':
        return {
          columns: [],
          rows: [
            kv(t('fieldEmployee'), row.employeeCode ? `${row.employeeCode} · ${row.employeeName}` : row.employeeName),
            kv(row.identityIsPassport ? t('fieldPassport') : t('fieldIdentityNo'), row.identityNumber),
            kv(t('fieldTaxNumber'), row.taxNumber),
            kv(t('fieldCompany'), row.company),
            kv(t('fieldPeriod'), periodLabel),
            kv(t('fieldTaxCategory'), !categoryIdentity.applicable?t('taxCategoryNone'):category==null?null:String(category)),
            kv(t('fieldMaritalStatus'),categoryIdentity.labelKey?t(categoryIdentity.labelKey):null),
            kv(t('fieldCycle'), `${cycleKey ? t(cycleKey) : row.runType}${row.runSeq > 1 ? ` #${row.runSeq}` : ''}`),
          ],
        };

      // WHICH FIGURE THIS DOCUMENT IS ABOUT, SAID BEFORE ANY WORKING. The screen has carried this banner
      // since 45df860a and the document did not, which was the one omission on it that changes what a
      // reader concludes: rendering the working without it makes the document a competent-looking
      // derivation of an amount nobody deducted. Built by `pcbBasisSection` in core/ — one decision, two
      // surfaces, no second copy of an eight-branch ternary.
      case 'basisBanner': {
        const basisSection = pcbBasisSection(model.explanation);
        if (basisSection == null) return { rows: [] };
        return {
          columns: [t(basisSection.firstColumn)],
          rows: basisSection.rows.map((r) => ({ line: r.line, label: t(r.caption), cells: [cell(r.first)] })),
          // The PROSE, which is the part that was missing: the figures alone do not say why two of them
          // differ, and a document that omits the sentence is the "competent-looking derivation of an
          // amount nobody deducted" the screen's own comment warns about.
          note: basisSection.note ? t(basisSection.note) : undefined,
        };
      }

      // r372 — THE HONEST BANNER, WHICH THIS DOCUMENT NEVER CARRIED. A reader holding a PDF of dashes with
      // no sentence explaining them reads the dashes as zeroes; the screen has said so since 45df860a.
      case 'traceBanner':
        return { columns: [], rows: [wide(t('traceNotRecorded'))] };

      case 'unavailableCard':
        return { columns: AMOUNT, rows: [figure(t('netMtd'), money(x.pcb))], note:t(x.kind==='not_subject'?'taxCategoryNoneExplanation':'unavailable') };

      case 'flatCard': {
        if (flat == null) return { rows: [] };
        const rows: PcbSlipPdfRow[] = [
          figure(flat.nonResident ? t('flatNonResident') : t('flatIncentive'), pctOf(flat.rate)),
          figure(t('flatRemuneration'), flat.trace ? money(flat.trace.remuneration) : na),
          figure(t('flatAdditional'), flat.trace ? money(flat.trace.additional) : na),
          figure(basis ? t(L.netSystem) : t('netMtd'), money(x.pcbSystem), true),
          ...(basis ? [figure(t(L.netDeducted), money(x.pcb), true)] : []),
        ];
        if (fb.flat) for (const r of formulaRows(fb.flat)) rows.push(r);
        return { columns: AMOUNT, rows, note: noteOf(fb.flat) };
      }

      // Sequence 9's own heading: the container the reporter asked for, with 9.1 to 9.9 beneath it.
      case 'mtdBand':
        return { columns: [], rows: [] };

      // 9.1 / Step 1 [A] — the category the RUN applied, which is not necessarily the one stored today.
      case 'mtdCategory':
        return {
          columns: AMOUNT,
          rows: [
                ...(mtd?.calculationScheme ? [figure(t('schemeLabel'), t(`scheme_${mtd.calculationScheme}`))] : []),
            figure(t('bracketCategory'), trace && CATEGORY_LABEL[trace.category] ? t(CATEGORY_LABEL[trace.category]) : na),
            // GUARD THE FIELD, NOT THE TRACE. `childCount` is `number | null` (core/pcb-explain.ts, and
            // `readTrace` deliberately refuses to coerce absence to 0 — a payslip predating r359 genuinely
            // never recorded the count). `trace ? String(trace.childCount) : na` therefore printed the
            // literal four characters "null" onto a DOWNLOADED STATUTORY PDF for every such payslip,
            // because the ternary tested the wrong thing. r364 fixed exactly this confusion inside the
            // kernel and left both render sites carrying it — this one printing "null", its twin on the
            // screen drawing an empty cell. CLAUDE.md §8: an absent box asserts nothing, 0.00 asserts the
            // money does not exist, and "null" asserts we do not know what we are printing.
            figure(t('reliefChildCount'), trace?.childCount != null ? formatQualifyingChildCount(trace.childCount) : na),
          ],
        };

      // 9.2 / Step 1 [B] — the deductions the chargeable income is reduced by. Absent from this document
      // entirely until r372, though every term of them appears inside the substituted P expression below.
      case 'mtdReliefs':
        return mtd == null
          ? { rows: [] }
          : {
              columns: AMOUNT,
              rows: [
                figure(t('reliefIndividual'), money(mtd.reliefs.individual)),
                figure(t('reliefSpouse'), money(mtd.reliefs.spouse)),
                figure(t('reliefDisabledIndividual'), money(mtd.reliefs.disabledIndividual)),
                figure(t('reliefDisabledSpouse'), money(mtd.reliefs.disabledSpouse)),
                figure(t('reliefChildren'), money(mtd.reliefs.children)),
                figure(t('reliefChildCount'), trace?.childCount != null ? formatQualifyingChildCount(trace.childCount) : na),
                figure(t('reliefLpAccumulated'), trace ? money(trace.lpAccumulated) : na),
                figure(t('reliefLpCurrent'), trace ? money(trace.lpCurrent) : na),
                figure(t('reliefLpCombined'), money(mtd.reliefs.lp)),
                figure(t('reliefTotal'), money(mtd.reliefs.total), true),
              ],
              note: mtd.reliefSource === 'snapshot' ? t('reliefFromSnapshot') : t('reliefFromCurrent'),
            };

      // 9.3 / Step 1 [B] — K₂ and the remuneration legs, which the specification determines FIRST.
      case 'mtdK2':
        return mtd == null
          ? { rows: [] }
          : {
              columns: AMOUNT,
              rows: [
                figure(t('compAccNet'), money(mtd.ytdNetRemuneration)),
                figure(t('compEpfClaimed'), money(mtd.epfClaimedYtd)),
                figure(t('compY1'), trace ? money(trace.Y1) : na),
                figure(t('compK1'), trace ? money(trace.K1) : money(mtd.epfThisMonth)),
                figure(t('compY2'), trace ? money(trace.Y2) : na),
                figure(t('compK2'), trace ? money(trace.K2) : na),
                ...(trace && trace.Yt > 0 ? [figure(t('compK2t'), money(trace.K2t))] : []),
                figure(t('compN'), `${mtd.remainingMonths}`),
                ...(mtd.chargeableIncomeWithAdditional != null
                  ? [figure(t('pWithAdditional'), money(mtd.chargeableIncomeWithAdditional))]
                  : []),
              ],
            };

      // 9.4 / Step 1 [B] — P, and P₂ when a bonus was paid. ONE section, as on the screen: this document
      // used to push a separate section per formula block, so `pHeading` was printed TWICE in a bonus month.
      case 'mtdP': {
        const rows: PcbSlipPdfRow[] = [];
        if (fb.p1) for (const r of formulaRows(fb.p1)) rows.push(r);
        if (fb.p2) for (const r of formulaRows(fb.p2)) rows.push(r);
        const both = [noteOf(fb.p1), noteOf(fb.p2)].filter((n): n is string => n !== undefined);
        return { columns: AMOUNT, rows, note: both.length > 0 ? both.join(' ') : undefined };
      }

      // 9.5 / Step 1 [C] — the monthly deduction on net normal remuneration.
      case 'mtdFormula':
        return fb.mtd == null
          ? { rows: [] }
          : { columns: AMOUNT, rows: formulaRows(fb.mtd), note: noteOf(fb.mtd) };

      // 9.5 continued — M, R and B, read off Table 1 once P is known. Absent from this document until r372.
      case 'mtdBracket':
        return {
          columns: AMOUNT,
          rows: [
            ...(!mtd?.calculationScheme || mtd.calculationScheme === 'resident' ? [figure(t('bracketM'), trace ? money(trace.M) : na)] : []),
            figure(t('bracketR'), trace ? pctOf(trace.R) : na),
            ...(!mtd?.calculationScheme || mtd.calculationScheme === 'resident' ? [figure(t('bracketB'), trace ? money(trace.B) : na)] : mtd.calculationScheme === 'c_suite' ? [] : [figure(t('schemeRebate'), trace?.T == null ? na : money(trace.T))]),
            figure(t('bracketTaxOnP'), trace ? money(trace.taxOnP1) : na),
          ],
          note: t(mtd?.calculationScheme && mtd.calculationScheme !== 'resident' ? 'schemeWorkingNote' : 'bracketNote'),
        };

      // 9.5 continued — the accumulators [C] subtracts and its divisor. Absent from this document until r372.
      case 'mtdPrior':
        return mtd == null
          ? { rows: [] }
          : {
              columns: AMOUNT,
              rows: [
                figure(t('priorZakat'), trace ? money(trace.Z) : na),
                figure(t('priorPcb'), money(mtd.pcbPaidYtd)),
                figure(t('currentZakat'), money(mtd.zakat)),
                figure(t('monthOfYear'), `${mtd.month} / 12`),
                figure(t('monthsRemaining'), `${mtd.remainingMonths}`),
                figure(t('monthsDivisor'), `${mtd.remainingMonths + 1}`),
              ],
              note: t('monthsNote'),
            };

      // 9.5 continued / §E — the zero floors and the RM10 rule, as a step a reader can see.
      case 'mtdFloor':
        return {
          columns: AMOUNT,
          rows: [
            figure(t('mtdNormal'), trace ? money(trace.mtdNormalCalc) : na),
            figure(t('netA'), trace ? money(trace.mtdNormalFloored) : na),
            figure(t('mtdAdditional'), trace ? money(trace.mtdAdditionalCalc) : na),
            figure(t('netE'), trace ? money(trace.mtdAdditionalFloored) : na),
          ],
          note: t('floorNote'),
        };

      // 9.6 / Step 1 [D] — the net deduction. ONE section: the zakat rows used to be pushed as a SECOND
      // section under the same `netHeading`, so "Step 1 [D]" was printed twice on every document.
      case 'mtdNet': {
        if (mtd == null || fb.net == null) return { rows: [] };
        const rows: PcbSlipPdfRow[] = [
          figure(t('netA'), trace ? money(trace.mtdNormalFloored) : na),
          figure(t('netE'), trace ? money(trace.mtdAdditionalFloored) : na),
          figure(t('netZ1'), trace ? money(trace.zakatCurrent) : money(mtd.zakat)),
          figure(t('netLeftover'), trace ? money(trace.zakatLeftover) : na),
        ];
        for (const r of formulaRows(fb.net)) rows.push(r);
        const note = noteOf(fb.net);
        // The screen states the unit once, under [D]; so does this. Without it every bare figure inside an
        // expression above is a number with no currency anywhere near it.
        const currency = t('currencyNote', { currency: cur ?? '—' });
        return { columns: AMOUNT, rows, note: note === undefined ? currency : `${note} ${currency}` };
      }

      // 9.6 continued — the two legs and the figure [D] lands on.
      case 'mtdSummary':
        return mtd == null
          ? { rows: [] }
          : {
              columns: AMOUNT,
              rows: [
                figure(t('mtdNormal'), trace ? money(trace.mtdNormalCalc) : na),
                figure(t('mtdAdditional'), trace ? money(trace.mtdAdditionalCalc) : na),
                figure(t('currentZakat'), money(mtd.zakat)),
                figure(basis ? t(L.netSystem) : t('netMtd'), money(x.pcbSystem), true),
                ...(basis ? [figure(t(L.netDeducted), money(x.pcb), true)] : []),
              ],
              note: t('netMtdNote'),
            };

      // 9.7 / Step 1 [E] — the year's total. ONE section, for the same reason as [D] above.
      case 'mtdYear': {
        if (fb.year == null) return { rows: [] };
        const rows: PcbSlipPdfRow[] = [
          figure(t('yearTotalTax'), trace && trace.totalTaxYear != null ? money(trace.totalTaxYear) : na),
        ];
        if (fb.schemeAnnual) rows.push(...formulaRows(fb.schemeAnnual));
        for (const r of formulaRows(fb.year)) rows.push(r);
        return { columns: AMOUNT, rows, note: noteOf(fb.year) };
      }

      // 9.8 — additional remuneration. Absent from this document until r372.
      case 'mtdAdditional':
        return mtd == null
          ? { rows: [] }
          : {
              columns: AMOUNT,
              rows: [
                figure(t('additionalAmount'), trace ? money(trace.Yt) : na),
                figure(t('additionalEpf'), trace ? money(trace.Kt) : na),
                figure(
                  t('additionalChargeable'),
                  mtd.chargeableIncomeWithAdditional != null
                    ? money(mtd.chargeableIncomeWithAdditional)
                    : t('additionalNone'),
                ),
                figure(t('additionalMtdCalc'), trace ? money(trace.mtdAdditionalCalc) : na),
                figure(wholeMonth ? t('additionalMtdMonth') : t('additionalMtdDeducted'), money(mtd.pcbAdditional)),
              ],
            };

      // 9.9 — the five lettered steps, and the figure the whole document is about.
      case 'mtdSteps':
        return mtd == null
          ? { rows: [] }
          : {
              columns: AMOUNT,
              rows: [
                { line: 'A', label: t('stepA'), cells: [trace && CATEGORY_LABEL[trace.category] ? t(CATEGORY_LABEL[trace.category]) : na] },
                { line: 'B', label: t('stepB'), cells: [money(mtd.chargeableIncome)] },
                { line: 'C', label: t('stepC'), cells: [trace ? money(trace.mtdNormalCalc) : na] },
                { line: 'D', label: t('stepD'), cells: [trace ? money(x.pcbSystem) : na] },
                { line: 'E', label: t('stepE'), cells: [trace && trace.totalMtdYear != null ? money(trace.totalMtdYear) : na] },
                figure(basis ? t(L.finalSystem) : t('finalPcb'), money(x.pcbSystem), true),
                // The deduction gets its OWN labelled line whenever the working does not explain it —
                // never the quiet answer to a chain that produced a different number. As on the screen.
                ...(basis ? [figure(t(L.finalDeducted), money(x.pcb), true)] : []),
                ...(wholeMonth ? [figure(t('additionalMtdMonth'), money(mtd.pcbAdditional))] : []),
              ],
              note: basis ? t(L.note) : undefined,
            };

      // APPENDIX — LHDN's own worksheet order. Out of the numbered run since r372: every figure on it
      // appears again below, and it used to stand between the reporter's sequences 1 and 2.
      case 'lhdnWorksheet': {
        const w = model.worksheet;
        if (w.shape === 'unavailable') return { rows: [] };
        const rows: PcbSlipPdfRow[] = [];
        for (const sec of w.sections) {
          rows.push({ line: '', label: t(sec.heading), cells: [], strong: true });
          for (const r of sec.rows) rows.push({ line: r.symbol, label: t(r.caption), cells: [cell(r.value)], sub: true });
          if (sec.note) rows.push(wide(t(sec.note)));
        }
        return { columns: AMOUNT, rows, note: t(w.note) };
      }

      // FOOTER — where these figures came from. Absent from this document until r372.
      case 'exemptions': {
        const table = pcbExemptionTable(model.exemptions, key => t(key));
        return {columns: table.columns.slice(1), labelColumn: table.columns[0], rows: table.rows.length
          ? table.rows.map(row => ({line: '', label: row.label, cells: row.cells}))
          : [wide(table.empty)], note: table.note};
      }
      case 'source':
        return {
          columns: [],
          rows: [
            kv(t('sourceTaxYear'), String(Number.isFinite(taxYear) ? taxYear : row.payPeriod)),
            kv(t('sourceTaxMethod'), x.kind==='not_subject'?t('taxCategoryNone'):x.kind === 'flat' ? t('methodFlat') : x.kind === 'mtd' && x.calculationScheme ? t(`scheme_${x.calculationScheme}`) : t('methodMtd')),
            kv(t('sourceTaxTable'), prov?.rulesetVersion ?? null),
            kv(t('sourcePeriod'), periodLabel),
            kv(t('sourceCycle'), cycleKey ? t(cycleKey) : row.runType),
          ],
          note: t('sourceNote'),
        };

      // ⚠️ THE EXHAUSTIVENESS IS THE GUARD. A slot added to `pcbDetailLayout` and not drawn here fails
      // `tsc`, and the same line stands in pcb-detail-view.tsx for the screen.
      default: {
        const unhandled: never = slot;
        return unhandled;
      }
    }
  };

  /**
   * ══ r372 — ONE ORDERED LIST, ITERATED. THIS FILE NO LONGER OWNS AN ORDER ══
   *
   * Until r372 the order of this document was the sequence of `sections.push` calls written here, and the
   * order of the screen was hand-placed JSX in `pcb-detail-view.tsx`. TWO lists, and they had drifted:
   * `reliefsHeading`, `bracketHeading`, `priorHeading`, `additionalHeading` and `sourceHeading` were absent
   * from the paper altogether, `netHeading` and `yearHeading` were each emitted TWICE and `pHeading` twice
   * in a bonus month, the currency note was missing and the payroll month printed as "2026-06" where the
   * screen printed "June 2026". The reporter's criteria 19, 20 and 21 were false and nothing could see it.
   *
   * `pcbDetailLayout` is called with exactly the arguments the screen passes it, so the two cannot differ
   * about which sections there are, what order they come in, or what number each carries.
   */
  const layout = pcbDetailLayout({
    explanation: model.explanation,
    worksheet: model.worksheet,
    slip: model.slip,
    closing: model.closing,
  });

  /** The reporter's number, or the band's own marker — the SAME composition the screen's `entryTitle` is. */
  const entryTitle = (e: (typeof layout)[number]): string => {
    const heading = t(e.heading);
    if (e.label != null) return `${e.label} · ${heading}`;
    if (e.band === 'appendix') return `${t('appendixLabel')} · ${heading}`;
    return heading;
  };

  /**
   * ONE MAPPING FOR EVERY SLIP-SHAPED SECTION. A second copy of it is how one section quietly loses a
   * column or an absence wording that the others keep, on a document about somebody's tax.
   */
  const slipRows = (sec: PcbSlipSection): { rows: PcbSlipPdfRow[]; columns: string[]; note?: string } => ({
    columns: [
      ...(sec.limitColumn ? [t(sec.limitColumn)] : []),
      t(sec.firstColumn),
      ...(sec.secondColumn ? [t(sec.secondColumn)] : []),
      ...(sec.thirdColumn ? [t(sec.thirdColumn)] : []),
    ],
    rows: [
      ...(sec.normalMtdWorking ? [wide(t('slipStep1CombinedHeading')), wide(t('slipStep1CombinedFormula')), wide(t('slipStep1PMeaning')),
        ...pcbNormalMtdStep1Blocks(x, {b2, pct: pctOf, int: value => `${value}`}).flatMap(block => [...formulaRows(block), ...block.notes.map(note => wide(t(note)))])] : []),
      ...sec.rows.map((r) => ({
      line: r.line,
      label: r.ns === 'taxRelief' ? tr(r.caption) : t(r.caption),
      sub: r.sub,
      cells: [
        ...(sec.limitColumn ? [r.limit == null ? t('slipNoLimit') : formatMoney(r.limit, cur)] : []),
        cell(r.first),
        ...(sec.secondColumn ? [r.second ? cell(r.second) : ''] : []),
        ...(sec.thirdColumn ? [r.third ? cell(r.third) : ''] : []),
      ],
    }))],
    note: sec.note ? t(sec.note) : undefined,
  });

  /**
   * ⚠️ ONE PLACE APPENDS A SECTION TO THIS DOCUMENT, AND IT IS THIS LOOP.
   *
   * The defect was eleven `sections.push` calls whose written order WAS the document's layout. A second
   * push anywhere in this file is a second ordering in prospect, so there is exactly one and
   * test/r372-pcb-sequence.test.ts counts them.
   */
  for (const e of layout) {
    const b = e.kind === 'section' ? slipRows(e.section) : bodyFor(e.slot);
    sections.push({ heading: entryTitle(e), columns: b.columns ?? AMOUNT, labelColumn: 'labelColumn' in b ? b.labelColumn : undefined, rows: b.rows, note: b.note });
  }

  const bytes = await renderPcbDetailPdf({
    title: t('title'),
    subtitle: `${row.employeeName} · ${row.company} · ${periodLabel}`,
    sections,
    // Stated in the reader's own language AND in English, because this claim — that what they are holding
    // is our rendering and not the agency's form — is the one thing a reader must not have to take on trust.
    provenance: [t('slipPdfProvenance'), t('slipPdfProvenanceEn')],
  });

  // ASCII-only: Content-Disposition's plain `filename` is Latin-1.
  const slug = `${row.payPeriod}-${row.employeeCode ?? row.employeeName}`
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="pcb-detail-${slug || 'payslip'}-${lang}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
