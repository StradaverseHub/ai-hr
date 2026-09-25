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
import { CATEGORY_LABEL, CYCLE_LABEL, explainPcb, pcbBasisSection, pcbSlipSections, pcbWorksheet } from '@/core/pcb-explain';
import type { PcbExplanation, PcbSlipSection, PcbWorksheet, PcbWorksheetValue } from '@/core/pcb-explain';
import { payslipProvenance } from '@/core/payslip-recompute';
import { formatMoney } from '@/lib/money';
import { SLIP_ITEMS, SLIP_REBATES, pcbSlipData } from './slip-data';
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
