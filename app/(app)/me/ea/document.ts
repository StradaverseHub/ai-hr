import 'server-only';
/**
 * M09 — THE EMPLOYEE'S OWN EA FORM (C.P.8A) AS A FILE, for every surface that hands it over: the web route
 * (app/(app)/me/ea/[employmentId]/pdf/route.ts) and the mobile v2 route (app/api/mobile/v2/ea/pdf/route.ts). Both call
 * this, so the phone's copy is byte-for-byte the web's copy of the same form. Each route keeps only its transport:
 * the session it resolves, how it parses the request, how it says "not found" and its response headers.
 *
 * Moved out of the web route VERBATIM, comments included; the order of the reads is unchanged (the statement, then
 * the document language, then the render), so the web route's behaviour is unchanged too.
 */
import type { SessionContext } from '@/db/client';
import { myEaStatement } from '@/core/reporting';
import { EaLayoutFitError, renderEaPdf, type EaPdfData } from '@/lib/ea-pdf';
import { eaPdfLabels } from '@/lib/ea-pdf-labels';

/** The two editions LHDN publishes and the renderer draws. The routes own their request allowlists. */
export type EaDocumentLang = 'en' | 'ms';

export type MyEaPdfFile =
  | { outcome: 'file'; bytes: Uint8Array; fileName: string }
  /** No statement for this caller: foreign, unavailable, unreleased or unsupported — never told apart. */
  | { outcome: 'not_found' }
  /** The form could not be laid out; no partial PDF exists. `employee` is the statement's own name. */
  | { outcome: 'layout'; error: EaLayoutFitError; locale: EaDocumentLang; employee: string };

/**
 * `edition.lang` is the language the caller ASKED for (null: none); only then does it ride in the file name.
 * `edition.fallback` resolves the document language otherwise, and is called only after the statement exists.
 */
export async function myEaPdfFile(
  s: SessionContext,
  p: { employmentId: string; year: string; companyId?: string },
  edition: { lang: EaDocumentLang | null; fallback: () => Promise<EaDocumentLang> },
): Promise<MyEaPdfFile> {
  const ea = await myEaStatement(s, {
    employmentId: p.employmentId,
    year: p.year,
    ...(p.companyId ? { companyId: p.companyId } : {}),
  }); // RLS-gated: null → 404 (foreign id)
  if (!ea) return { outcome: 'not_found' };

  // Only the supported English/Malay document editions reach the PDF owner. Other UI locales use
  // English unless the reader explicitly selected Malay.
  const lang = edition.lang;
  const locale = lang ?? (await edition.fallback());
  const data: EaPdfData = {
    year: ea.year,
    employer: ea.employer,
    // 6036dab7 — spread, not field-by-field: `EaPdfData.employee`/`partB` are structural subsets of the
    // read's own shapes, and every field either type declares REQUIRED is therefore carried by the spread
    // or refused by tsc. The alternative (a hand-written field list) is how the three Part A particulars
    // and the ten Part B boxes would drop one at a time without a single test noticing.
    employee: ea.employee,
    partB: ea.partB,
    partC: ea.partC,
    partD: ea.partD,
    partE: ea.partE,
    // r367 — the foot's Tarikh. Computed by the MY pack's eaFormDate() so the renderer stays pure; see
    // EaPdfData.formDate in lib/ea-pdf.ts for whose rule it is.
    formDate: ea.formDate,
    statutoryVersion: ea.statutoryVersion,
    // 1.2.6 EA Data Overwrite — pass HR's EA-only amendments through so the PDF can print the "Amended"
    // footnote. Built field-by-field here, so this line is REQUIRED or the marker silently drops.
    overrides: ea.overrides,
  };
  // r220 — the label bundle is built in lib/ea-pdf-labels.ts, because the blank C.P.8A
  // (app/(app)/payroll/ea/blank) needs the identical fifty-odd captions and two hand-maintained copies of one
  // statutory form's wording is how the blank and the filled version stop being the same page.
  //
  // r219 — the label set is the C.P.8A's own boxes, and it is SHORTER than it was: the form's masthead,
  // banner and officer-box captions are the agency's Malay words and are drawn from lib/ea-pdf.ts's own
  // constants in both languages, while `mtdCategory`, the three MTD categories, `employmentPeriod`,
  // `present`, `yearEnded` and the two subtotals have no box on the printed form at all. Every one of
  // them still exists in `payroll.ea` for the HTML statement; see the EaPdfLabels block comment for why
  // each left. test/ea-form-boxes-contract.test.ts fails on a declared label nothing prints.
  let bytes: Uint8Array;
  try { bytes = await renderEaPdf(
    data,
    await eaPdfLabels(locale, { year: ea.year, version: ea.statutoryVersion }),
    // r346 — the form's own furniture follows the DOCUMENT's language, as LHDN's two editions do.
    { locale },
  ); } catch(error) { if(error instanceof EaLayoutFitError) return { outcome: 'layout', error, locale, employee: ea.employee.name }; throw error; }

  // Substrate: this is a read-only render (no state change), so it appends NO domain event — same as the
  // payslip-pdf route. Deliberate skip. (M09: the mobile SHARE of this file is audited separately, by
  // POST /api/mobile/v2/documents/share-events; the render itself still records nothing.)
  // The language rides in the filename ONLY when it was asked for, so every pre-existing link keeps the
  // filename it always produced — and an employer pulling both versions of the same person's statement
  // does not end up with "…(1).pdf" and no way to tell which is which.
  const fname = `ea-${ea.year}-${ea.employer.name}${lang ? `-${lang}` : ''}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return { outcome: 'file', bytes, fileName: `${fname}.pdf` };
}
