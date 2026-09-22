/**
 * df35d60d — stream ONE employee's completed LHDN TP3 for ONE assessment year as a PDF.
 *
 * ROUTE SHAPE COPIED FROM THE TP1's (app/payroll/transactions/tp1/[year]/[month]/pdf/route.ts): Node
 * runtime because pdf-lib needs it, every parameter validated before any query, an RLS-gated read whose
 * null is a 404, `attachment` + `private, no-store`, and NO domain event — rendering a form is a read,
 * and downloading it is not filing.
 *
 * `scopedAdmin` RATHER THAN `isAdmin`, for the reason that route documents: an hr_admin grant on ANY
 * company makes `isAdmin` true, and this document carries a named person's IC or passport, their tax
 * number, their previous employers and every relief they claimed through them. It fails closed twice —
 * the session must be an admin AND the employment must be one they are scoped to — and a foreign id, an
 * out-of-scope company and a year with no record are ALL the same 404, so the URL cannot be used to
 * enumerate any of them.
 *
 * A route.ts IS NOT A PAGE and is deliberately NOT listed in the function-access matrix in
 * lib/permissions.ts — that matrix is an exact set over page.tsx files, and adding a handler to it would
 * fail the reverse-completeness case rather than satisfy it.
 *
 * WHAT IS PRINTED IS WHAT IS STORED. Every figure comes from the `employee_tp3` row; the structure, the
 * wording and the annual limits come from the country pack catalogue, whose Section D IS the TP1's item
 * list. Nothing is computed here — the derived accumulator seed the SCREEN shows is deliberately NOT on
 * the document, because it is our arithmetic and not a box the agency's form has.
 *
 * THE LANGUAGE OF THE DOCUMENT, NOT OF THE VIEWER — the same guard the TP1 and EA routes carry, and for
 * the same hard reason. `lib/tp3-pdf.ts` embeds Helvetica, which is WinAnsi, and folds every unmappable
 * codepoint to '?'. Every word of this form's body comes from the `taxRelief` namespace and
 * messages/{ta,zh,th,vi}.json translate all of it — so resolving that namespace against the viewer's UI
 * locale would print a statutory form whose entire Section D reads as rows of '?' for four of our six
 * locales. LHDN issues the TP3 in Bahasa Malaysia and English; those are the two this renders, `lang`
 * chooses between them, and a viewer in any other locale gets the English form rather than a broken one.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import {
  getTp3ForPersonYear,
  getTp3Identity,
  tp3LineNumber,
  TP3_FORM_CODE,
  TP3_MAX_EMPLOYERS,
  TP3_SECTION_C,
  TP3_SECTION_D,
} from '@/packs/payroll/service';
import type { Tp1ItemAmounts } from '@/db/schema';
import { renderTp3Pdf, type Tp3PdfItem } from '@/lib/tp3-pdf';

export const runtime = 'nodejs'; // pdf-lib needs the Node runtime

// Allowlisted, never trusted: an unrecognised `lang` falls back rather than reaching next-intl, which
// would throw on an unknown locale and 500 a download.
const TP3_LANGS = ['en', 'ms'] as const;
type Tp3Lang = (typeof TP3_LANGS)[number];
const isTp3Lang = (v: string | null): v is Tp3Lang => TP3_LANGS.includes(v as Tp3Lang);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawYear = url.searchParams.get('year') ?? '';
  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return notFound();

  const employmentId = url.searchParams.get('employmentId');
  if (!employmentId) return notFound();

  const { s, scopeIds } = await scopedAdmin();
  const employees = await listEmployees(s, scopeIds);
  const emp = employees.find((e) => e.employmentId === employmentId);
  if (!emp) return notFound();

  // The requested form language, then the viewer's locale IF the form exists in it, then English.
  const viewer = await getLocale();
  const langParam = url.searchParams.get('lang');
  const locale: Tp3Lang = isTp3Lang(langParam) ? langParam : isTp3Lang(viewer) ? viewer : 'en';

  const [record, identity, t] = await Promise.all([
    getTp3ForPersonYear(s, { personId: emp.personId, assessmentYear: year }),
    getTp3Identity(s, { personId: emp.personId }),
    getTranslations({ locale, namespace: 'taxRelief' }),
  ]);
  if (!record) return notFound();

  const payload = record.payload?.form === 'tp3-2026' ? record.payload : null;
  // Null, not zero: an unfilled box prints EMPTY. A printed 0.00 asserts "this money does not exist",
  // which on a PREVIOUS employer's figures is a statement nobody here is in a position to make.
  const figure = (v: unknown): number | null => (v == null || v === 0 ? null : Number(v));
  const entry = (group: 'sectionC' | 'sectionD', code: string): Tp1ItemAmounts | undefined =>
    payload ? payload[group][code] : undefined;

  const sectionC: Tp3PdfItem[] = TP3_SECTION_C.map((line, i) => {
    const stored = entry('sectionC', line.code);
    return {
      label: `C${i + 1}`,
      description: t(`tp3.money.${line.code}.label`),
      // Section C has NO annual-limit column on the paper form. Null here and `withLimit: false` in the
      // renderer are the same fact said twice, and the renderer draws neither a figure nor a dash.
      limit: null,
      // ⚠️ A LINE WITH SUB-BOXES HAS NO BOX OF ITS OWN ON THE PAPER FORM. C2 and C4 print their numeral
      // lines with an amount box each and NOTHING against the C2 / C4 line itself — unlike Section D,
      // where the brace joins the lettered boxes to ONE group figure. Printing a group total here would
      // put a figure in a place the agency's form has no box for, which is the same overstatement as
      // printing a limit we cannot cite. The server still SUMS them (core/tp3.ts) and the sum is still
      // stored and still used by the reconciliation strip; it is simply not drawn where there is no box.
      amount: line.subItems.length === 0 ? figure(stored?.amount) : null,
      subItems: line.subItems.map((sub) => ({
        code: sub.code,
        description: t(`tp3.money.${line.code}.sub.${sub.code}`),
        limit: null,
        amount: figure(stored?.subItems?.[sub.code]),
        frequency: sub.frequency ? t(`frequency.${sub.frequency}`) : null,
      })),
    };
  });

  const sectionD: Tp3PdfItem[] = TP3_SECTION_D.map((item) => {
    const stored = entry('sectionD', item.code);
    return {
      // THE FORM'S OWN NUMBERING, derived from the shared schedule's order — the TP1 prints these items
      // as C1–C17 and the TP3 as D1–D17, and `tp3LineNumber` is the whole of the difference.
      label: `D${tp3LineNumber(item.code) ?? '?'}`,
      description: t(`items.${item.code}.label`),
      limit: item.limit,
      amount: figure(stored?.amount),
      frequency: item.frequency ? t(`frequency.${item.frequency}`) : null,
      perSubLimit: item.perSubLimit,
      subItems: item.subItems.map((sub) => ({
        code: sub.code,
        description: t(`items.${item.code}.sub.${sub.code}`),
        limit: sub.limit,
        amount: figure(stored?.subItems?.[sub.code]),
        frequency: sub.frequency ? t(`frequency.${sub.frequency}`) : null,
      })),
    };
  });

  const bytes = await renderTp3Pdf({
    formCode: TP3_FORM_CODE,
    deductionMonth: record.deductionMonth,
    deductionYear: record.assessmentYear,
    employerSlots: TP3_MAX_EMPLOYERS,
    employers: record.previousEmployers,
    employerFootnote: t('tp3.sectionAFootnote'),
    employee: identity.employee,
    sectionC,
    sectionD,
    labels: {
      sectionA: 'SECTION A: EMPLOYER INFORMATION',
      sectionB: 'SECTION B: EMPLOYEE INFORMATION',
      sectionC: 'SECTION C: REMUNERATION INFORMATION / EPF / ZAKAT / PCB',
      sectionCHelp: t('tp3.sectionCHelp'),
      sectionD: 'SECTION D: REMUNERATION DEDUCTION',
      sectionDHelp: t('tp3.sectionDHelp'),
      sectionE: 'SECTION E: EMPLOYEE DECLARATION',
      deductionMonth: 'DEDUCTION MONTH:',
      deductionYear: 'DEDUCTION YEAR:',
      employerName: (i: number) => t('tp3.employerNameSlot', { n: i }),
      employerTin: () => t('tp3.employerTinSlot'),
      employeeName: 'Name',
      employeeIdNumber: 'Identity Card/Passport Number',
      employeeTin: 'Tax Identification Number (TIN)',
      colAnnualLimit: 'ANNUAL LIMIT (RM)',
      colAccumulated: 'ACCUMULATED DEDUCTION (RM)',
      date: t('tp3.dateLabel'),
      signature: t('tp3.signatureLabel'),
      note: t('tp3.note'),
      noteLines: [t('tp3.noteRequest'), t('tp3.noteKeep'), t('tp3.noteExplanatory')],
    },
    declaration: {
      text: t('declarationText'),
      declaredOn: record.declaredAt ? record.declaredAt.toISOString().slice(0, 10) : null,
    },
    // The provenance band. Stated in the reader's own language and in English, because this claim — that
    // the page is OUR rendering and not the agency's own — is the one a reader must not take on trust.
    provenance: [t('tp3.pdfProvenanceMs'), t('tp3.pdfProvenanceEn')],
  });

  const fname = `tp3-${year}-${emp.name}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return new Response(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

const notFound = () => new Response('Not found', { status: 404 });
