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
 */
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { currentPcbReliefs, payslipForReview, previousEmploymentForPayslip } from '@/core/payroll-view';
import { CATEGORY_LABEL, CYCLE_LABEL, explainPcb, pcbBasisLabels, pcbBasisSection, pcbSlipSections, pcbWorksheet } from '@/core/pcb-explain';
import type { PcbExplanation, PcbSlipSection, PcbWorksheet, PcbWorksheetValue } from '@/core/pcb-explain';
import { payslipProvenance } from '@/core/payslip-recompute';
import { formatMoney } from '@/lib/money';
import { SLIP_ITEMS, SLIP_REBATES, pcbSlipData } from './slip-data';
// r351 — the SAME assembly the screen paints. See the block comment where it is used.
import { pcbFormulaBlocks } from './formulas';
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
};

/**
 * THE FOUR SHAPING CALLS, IN THE ORDER THE SCREEN MAKES THEM, over rows the caller has already read.
 *
 * Pure: it issues no query and decides no scope. That is what lets the test drive it beside the screen's
 * own chain and require the two to be identical, which is the anti-drift guard the header promises.
 */
export function pcbDetailModel(p: {
  statutory: unknown;
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
          catalogue: SLIP_ITEMS,
          rebateCatalogue: SLIP_REBATES,
          currentDeduction: p.slipData.currentDeduction,
          accumulatedDeduction: p.slipData.accumulatedDeduction,
          previousDeduction: p.slipData.previousDeduction,
          currentRebate: p.slipData.currentRebate,
          accumulatedRebate: p.slipData.accumulatedRebate,
        })
      : [],
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
  const model = pcbDetailModel({ statutory: row.statutory, fallbackReliefs, previousEmployment, slipData });

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
        return String(v.count);
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

  // ── Reporter section 1 — employee information ──────────────────────────────────────────────────────
  const kv = (label: string, value: string | null): PcbSlipPdfRow => ({
    line: '',
    label,
    cells: [value && value.trim() !== '' ? value : t('notRecordedShort')],
  });
  const category = model.explanation.kind === 'mtd' ? (slipData?.profile?.taxCategory ?? null) : null;
  // ⚠️ THE SAME EIGHT ROWS THE SCREEN RENDERS. Requirement 11 is "the same calculation details displayed
  // on screen", and this block used to carry seven of them: the MARITAL TAX STATUS, which the reporter's
  // section 1 lists by name, and the payroll CYCLE were on the screen and not in the document. Both are
  // resolved through the same two maps the view uses (`core/pcb-explain.ts`), not through a second copy.
  const cycleKey = CYCLE_LABEL[row.runType];
  sections.push({
    heading: t('identificationHeading'),
    columns: [],
    rows: [
      kv(t('fieldEmployee'), row.employeeCode ? `${row.employeeCode} · ${row.employeeName}` : row.employeeName),
      kv(row.identityIsPassport ? t('fieldPassport') : t('fieldIdentityNo'), row.identityNumber),
      kv(t('fieldTaxNumber'), row.taxNumber),
      kv(t('fieldCompany'), row.company),
      kv(t('fieldPeriod'), row.payPeriod),
      kv(t('fieldTaxCategory'), category == null ? null : String(category)),
      kv(
        t('fieldMaritalStatus'),
        category != null && CATEGORY_LABEL[category] ? t(CATEGORY_LABEL[category]) : null,
      ),
      kv(t('fieldCycle'), `${cycleKey ? t(cycleKey) : row.runType}${row.runSeq > 1 ? ` #${row.runSeq}` : ''}`),
      kv(t('sourceTaxTable'), prov?.rulesetVersion ?? null),
    ],
  });

  // ── WHICH FIGURE THIS DOCUMENT IS ABOUT, SAID BEFORE ANY WORKING ──────────────────────────────────
  // The screen has carried this banner since 45df860a and the document did not, which is the one omission
  // on it that changes what a reader concludes: `pcb-detail-view.tsx` says in its own comment that
  // "rendering the working without this makes the screen a competent-looking derivation of an amount nobody
  // deducted", and that is exactly what a PDF handed to an auditor would have been. `pcbBasisSection`
  // returns null when the working explains precisely what was deducted, which is the ordinary case.
  const basisSection = pcbBasisSection(model.explanation);
  if (basisSection) {
    sections.push({
      heading: t(basisSection.heading),
      columns: [t(basisSection.firstColumn)],
      rows: basisSection.rows.map((r) => ({ line: r.line, label: t(r.caption), cells: [cell(r.first)] })),
      note: basisSection.note ? t(basisSection.note) : undefined,
    });
  }

  // ── Reporter sections 3, 9 and 10 — LHDN's own worksheet, exactly as the screen shows it ──────────
  if (model.worksheet.shape !== 'unavailable') {
    for (const sec of model.worksheet.sections) {
      sections.push({
        heading: `${t(model.worksheet.shape === 'flat' ? 'worksheetFlatHeading' : 'worksheetHeading')} — ${t(sec.heading)}`,
        columns: [t('slipColAmount')],
        rows: sec.rows.map((r) => ({ line: r.symbol, label: t(r.caption), cells: [cell(r.value)] })),
        note: sec.note ? t(sec.note) : undefined,
      });
    }
  }

  // ── Reporter sections 2, 4, 5, 6, 7 and 8 — the detail behind the totals ──────────────────────────
  for (const sec of model.slip) {
    const columns = [
      ...(sec.limitColumn ? [t(sec.limitColumn)] : []),
      t(sec.firstColumn),
      ...(sec.secondColumn ? [t(sec.secondColumn)] : []),
      ...(sec.thirdColumn ? [t(sec.thirdColumn)] : []),
    ];
    sections.push({
      heading: t(sec.heading),
      columns,
      rows: sec.rows.map((r) => ({
        line: r.line,
        label: r.ns === 'taxRelief' ? tr(r.caption) : t(r.caption),
        sub: r.sub,
        cells: [
          ...(sec.limitColumn ? [r.limit == null ? t('slipNoLimit') : formatMoney(r.limit, cur)] : []),
          cell(r.first),
          ...(sec.secondColumn ? [r.second ? cell(r.second) : ''] : []),
          ...(sec.thirdColumn ? [r.third ? cell(r.third) : ''] : []),
        ],
      })),
      note: sec.note ? t(sec.note) : undefined,
    });
  }

  /**
   * ── r351: THE WORKING ITSELF, WHICH THIS DOCUMENT DID NOT CARRY ────────────────────────────────────
   *
   * WHAT WAS MISSING, AND WHY IT MATTERED MORE THAN ANY ROW ABOVE IT. Up to r351 this document pushed the
   * identification rows, the basis banner, LHDN's worksheet and the reporter's slip — every FIGURE, and
   * not one of the four formulas, not the calculation summary, not the step chain, not the deducted total.
   * A reader could see every input and every accumulator and still not see the arithmetic that turned them
   * into a deduction, which is the one thing a person disputing their tax needs. Requirement 11 is "the
   * same calculation details displayed on screen", and this was the gap in it.
   *
   * ⚠️ AND IT IS THE SCREEN'S OWN ASSEMBLY, NOT A SECOND COPY. `pcbFormulaBlocks` is the function
   * `pcb-detail-view.tsx` calls, with the same explanation and equivalent formatters, so an expression
   * cannot differ between the page and the file that leaves the building. Writing these strings again here
   * is exactly the drift this file's header spends forty lines refusing for the read path.
   *
   * THE LONG EXPRESSIONS GO IN THE LABEL, NOT IN A FIGURE COLUMN. A figure column is 96 points wide and
   * right-aligned; a 200-character substituted formula placed in one would be drawn leftwards straight
   * across the label beside it. So a formula row carries no cell at all and wraps across the full text
   * width, and only the RESULT — a single amount — is right-aligned as a figure.
   */
  const b2 = (v: number) => v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctOf = (r: number) => `${(r * 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  const money = (v: number) => formatMoney(v, cur);
  /** A row of prose or of an expression: the whole text width, no figure column, no line marker. */
  const wide = (label: string): PcbSlipPdfRow => ({ line: '', label, cells: [] });
  const figure = (label: string, value: string, strong = false): PcbSlipPdfRow => ({ line: '', label, cells: [value], strong });

  if (model.explanation.kind !== 'unavailable') {
    const x = model.explanation;
    const trace = x.kind === 'mtd' ? x.trace : null;
    const L = pcbBasisLabels(x.basis);
    const na = t('notRecordedShort');
    const wholeMonth = x.basis != null && x.basis.prior != null;

    // ── The calculation summary, which the screen has carried since 45df860a ──────────────────────
    if (x.kind === 'mtd') {
      sections.push({
        heading: t('summaryHeading'),
        columns: [t('slipColAmount')],
        rows: [
          figure(t('mtdNormal'), trace ? money(trace.mtdNormalCalc) : na),
          figure(t('mtdAdditional'), trace ? money(trace.mtdAdditionalCalc) : na),
          figure(t('currentZakat'), money(x.zakat)),
          figure(x.basis ? t(L.netSystem) : t('netMtd'), money(x.pcbSystem), true),
          ...(x.basis ? [figure(t(L.netDeducted), money(x.pcb), true)] : []),
        ],
        note: t('netMtdNote'),
      });

      // ── Step 1 [A] — the category the RUN applied, which is not necessarily the one stored today ──
      sections.push({
        heading: t('stepAHeading'),
        columns: [t('slipColAmount')],
        rows: [
          figure(
            t('bracketCategory'),
            trace && CATEGORY_LABEL[trace.category] ? t(CATEGORY_LABEL[trace.category]) : na,
          ),
          figure(t('reliefChildCount'), trace ? String(trace.childCount) : na),
        ],
      });
    }

    // ── Steps [B] to [E], each as formula → actual values → calculation → result ──────────────────
    for (const fb of pcbFormulaBlocks(x, { b2, pct: pctOf, int: (v: number) => `${v}` })) {
      const rows: PcbSlipPdfRow[] = [wide(`${t('formulaLabel')}:  ${t(fb.formula)}`)];
      if (fb.legend) rows.push(wide(t(fb.legend)));
      rows.push(wide(`${t('substitutedLabel')}:  ${fb.substituted ?? na}`));
      // ABSENT, not zero and not derived: `formulas.ts` omits this row for a step whose intermediate the
      // engine never stored, and the document must omit it for exactly the same reason.
      if (fb.calculation !== undefined) rows.push(wide(`${t('calculationLabel')}:  ${fb.calculation}`));
      rows.push(figure(t(fb.resultLabel), fb.result === null ? na : money(fb.result), true));
      // ONE figure column even though only the result row uses it: `labelW` is computed from the column
      // count, so declaring it is what keeps a wrapped expression from being drawn under the amount.
      sections.push({
        heading: t(fb.heading),
        columns: [t('slipColAmount')],
        rows,
        note: fb.notes.map((k) => t(k)).join(' '),
      });

      // ── §E's flooring, immediately after the step it turns into A and E ──────────────────────────
      // The specification's headline formula prints no floor and its rules apply two, plus the RM10 rule.
      // The screen shows that as its own step; so does this, or the document's substituted expressions
      // carry a clamp the formula above them does not and nothing on the page accounts for it.
      if (fb.key === 'mtd' && x.kind === 'mtd') {
        sections.push({
          heading: t('floorHeading'),
          columns: [t('slipColAmount')],
          rows: [
            figure(t('mtdNormal'), trace ? money(trace.mtdNormalCalc) : na),
            figure(t('netA'), trace ? money(trace.mtdNormalFloored) : na),
            figure(t('mtdAdditional'), trace ? money(trace.mtdAdditionalCalc) : na),
            figure(t('netE'), trace ? money(trace.mtdAdditionalFloored) : na),
          ],
          note: t('floorNote'),
        });
      }
      if (fb.key === 'net' && x.kind === 'mtd') {
        sections.push({
          heading: t('netHeading'),
          columns: [t('slipColAmount')],
          rows: [
            figure(t('netZ1'), trace ? money(trace.zakatCurrent) : money(x.zakat)),
            figure(t('netLeftover'), trace ? money(trace.zakatLeftover) : na),
          ],
        });
      }
      if (fb.key === 'year' && x.kind === 'mtd') {
        sections.push({
          heading: t('yearHeading'),
          columns: [t('slipColAmount')],
          rows: [
            figure(t('yearTotalTax'), trace && trace.totalTaxYear != null ? money(trace.totalTaxYear) : na),
            figure(t('yearTotalMtd'), trace && trace.totalMtdYear != null ? money(trace.totalMtdYear) : na),
          ],
        });
      }
    }

    // ── The five lettered steps, and the figure the whole document is about ───────────────────────
    if (x.kind === 'mtd') {
      sections.push({
        heading: t('stepsHeading'),
        columns: [t('slipColAmount')],
        rows: [
          { line: 'A', label: t('stepA'), cells: [trace && CATEGORY_LABEL[trace.category] ? t(CATEGORY_LABEL[trace.category]) : na] },
          { line: 'B', label: t('stepB'), cells: [money(x.chargeableIncome)] },
          { line: 'C', label: t('stepC'), cells: [trace ? money(trace.mtdNormalCalc) : na] },
          { line: 'D', label: t('stepD'), cells: [trace ? money(x.pcbSystem) : na] },
          { line: 'E', label: t('stepE'), cells: [trace && trace.totalMtdYear != null ? money(trace.totalMtdYear) : na] },
          figure(x.basis ? t(L.finalSystem) : t('finalPcb'), money(x.pcbSystem), true),
          // The deduction gets its OWN labelled line whenever the working does not explain it — never the
          // quiet answer to a chain that produced a different number. Same rule as the screen.
          ...(x.basis ? [figure(t(L.finalDeducted), money(x.pcb), true)] : []),
          ...(wholeMonth ? [figure(t('additionalMtdMonth'), money(x.pcbAdditional))] : []),
        ],
        note: x.basis ? t(L.note) : undefined,
      });
    }
  }

  const bytes = await renderPcbDetailPdf({
    title: t('title'),
    subtitle: `${row.employeeName} · ${row.company} · ${row.payPeriod}`,
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
