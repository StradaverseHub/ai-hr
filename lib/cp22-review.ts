/**
 * 88076362 — the five values the review screen lets an operator correct before a CP22 is produced, and the
 * plain-text export of everything the form will say.
 *
 * ONE MODULE, THREE CONSUMERS: the preview screen renders the boxes, the PDF route applies the same
 * overrides to the same record, and the text route writes the same values out. Splitting the reading of
 * `?taxNo=` from the applying of it is exactly the shape trap 17 describes — a defect that lives in the
 * CONTRACT between two files, where a unit test of either half passes throughout. They are one file so
 * there is one contract.
 *
 * WHY THESE FIVE. They are what the reporter asked to be able to correct: the tax reference (21 of 33
 * employees on production have none on file), where you are filing, the start date, the expected duration,
 * and the company name. Everything else on the form is corrected in the downloaded PDF, which stays fully
 * editable — the review screen is not a second editor for fifty boxes.
 *
 * `submitTo` IS DELIBERATELY NOT A PDF FIELD. CP22 [Pin.1/2021] has no "Kepada / To" block — LHDN removed
 * the one the 2020 page had, because the form goes through e-CP22 on MyTax where the branch is not written
 * on the document. It is kept here and in the text export so the operator's own record says where it went,
 * and the screen says plainly that it does not print. Quietly dropping it would be worse; quietly printing
 * it somewhere it does not belong would be worse still.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { Cp22PdfData } from './cp22-pdf';
import { cp22Amount, cp22FieldValues, dmy, fitBlock } from './cp22-pdf';
import { CP22_FIELDS, CP22_SECTIONS, cp22Section } from './cp22-fields';

/** The query-string names. Short, stable, and part of the URL contract the three routes share. */
export const CP22_REVIEW_PARAMS = {
  incomeTaxNo: 'taxNo',
  submitTo: 'submitTo',
  commencementDate: 'from',
  expectedDuration: 'duration',
  employerName: 'employer',
} as const;

export type Cp22Review = {
  /** B2. */
  incomeTaxNo: string | null;
  /** Not on the form at all — the operator's own record of where it went. */
  submitTo: string | null;
  /** B14, ISO yyyy-mm-dd (the screen uses <input type="date">, which submits ISO). */
  commencementDate: string | null;
  /** B16. */
  expectedDuration: string | null;
  /** A1. */
  employerName: string | null;
};

/** Nothing overridden — what the worklist's plain link produces. */
export const CP22_NO_REVIEW: Cp22Review = {
  incomeTaxNo: null,
  submitTo: null,
  commencementDate: null,
  expectedDuration: null,
  employerName: null,
};

/** A request-size guard, not a formatting one: the renderer shrinks anything longer so no value is lost. */
const MAX_LEN = 240;

/**
 * Read the five overrides out of a query string.
 *
 * ABSENT AND EMPTY ARE DIFFERENT ANSWERS, and getting that backwards is trap 17 in this repo's standing
 * orders. Every box on the review form is submitted on every press, whatever the operator left in it — so
 * a key that is PRESENT AND EMPTY means "I cleared this box, leave it blank", and honouring it is the only
 * way the box can be cleared at all. A key that is ABSENT means the request never came from the review
 * screen (the worklist's direct link, or an old bookmark), and the record's own value stands.
 *
 * `has()` rather than a truthiness test is what distinguishes them, and it is why this cannot be written
 * as `q.get(k) || record.value`.
 */
export function readCp22Review(q: URLSearchParams): Cp22Review {
  const read = (key: string): string | null | undefined =>
    q.has(key) ? q.get(key)!.slice(0, MAX_LEN).trim() : undefined;
  const out = { ...CP22_NO_REVIEW } as Record<string, string | null>;
  for (const [field, key] of Object.entries(CP22_REVIEW_PARAMS)) {
    const v = read(key);
    if (v !== undefined) out[field] = v === '' ? null : v;
  }
  return out as Cp22Review;
}

/** True when the request carried ANY review box — i.e. it came from the review screen, not a bare link. */
export const isCp22Reviewed = (q: URLSearchParams): boolean =>
  Object.values(CP22_REVIEW_PARAMS).some((k) => q.has(k));

/** The review boxes' starting values, from the record. What the screen pre-fills. */
export function cp22ReviewDefaults(d: Cp22PdfData): Cp22Review {
  return {
    incomeTaxNo: d.employee.incomeTaxNo,
    // We hold no list of LHDN branches and no record of which one a company files with, so this box
    // starts empty on every joiner. Inventing a branch would be inventing a fact about a tax filing.
    submitTo: null,
    commencementDate: d.employee.commencementDate,
    expectedDuration: d.employee.expectedDuration,
    employerName: d.employer.name,
  };
}

/**
 * Apply the operator's corrections on top of the record.
 *
 * A null override does NOT mean "keep the record" — see `readCp22Review`. The caller has already decided,
 * per box, between "unchanged" (absent from the query, so the default was carried through) and "cleared"
 * (present and empty, so null). By the time a `Cp22Review` reaches here every field is the FINAL value.
 */
export function applyCp22Review<T extends Cp22PdfData>(d: T, r: Cp22Review): T {
  return {
    ...d,
    employer: { ...d.employer, name: r.employerName ?? '' },
    employee: {
      ...d.employee,
      incomeTaxNo: r.incomeTaxNo,
      commencementDate: r.commencementDate,
      expectedDuration: r.expectedDuration,
    },
  };
}

/**
 * THE ONE PLACE a request becomes a final set of five values: the record's defaults, with each box the
 * request actually carried replacing its default.
 *
 * Both the PDF route and the text route go through here, and that is the point. The merge has three cases
 * per box — absent (keep the default), present-and-empty (clear it), present-and-filled (take it) — and a
 * second copy of that three-way rule anywhere would be a contract split across two files, which is the
 * shape trap 17 describes: each half passes its own unit test while the pair disagrees.
 */
export function cp22ReviewFrom(d: Cp22PdfData, q: URLSearchParams): Cp22Review {
  const defaults = cp22ReviewDefaults(d);
  if (!isCp22Reviewed(q)) return defaults;
  const sent = readCp22Review(q);
  const merged = { ...defaults } as Record<string, string | null>;
  for (const [field, key] of Object.entries(CP22_REVIEW_PARAMS)) {
    if (q.has(key)) merged[field] = sent[field as keyof Cp22Review];
  }
  return merged as unknown as Cp22Review;
}

/**
 * The record as the PDF route should render it.
 *
 * A request with no review boxes at all takes the defaults unchanged, which is byte-for-byte the document
 * the worklist link produced before this screen existed.
 */
export function cp22WithReview<T extends Cp22PdfData>(d: T, q: URLSearchParams): T {
  if (!isCp22Reviewed(q)) return d;
  return applyCp22Review(d, cp22ReviewFrom(d, q));
}

// ── The plain-text export ───────────────────────────────────────────────────────────────────────────

/**
 * Every field and its value, one per line, grouped by the form's own sections A–F.
 *
 * THIS IS WHAT THE OPERATOR ACTUALLY KEYS INTO MyTax, and what they keep. It is generated from
 * `cp22FieldValues` — the SAME function the PDF fills from — so the two cannot disagree about what the
 * form says. A field the PDF leaves blank appears here too, with an empty value and, where we know why,
 * the reason; a blank line in a list of fifty is otherwise indistinguishable from an omission.
 *
 * THE ENGLISH-RULE TWINS ARE COLLAPSED. D4 and D8 each print their "nyatakan / specify" question twice,
 * once in Malay and once in English, and the PDF fills both rules with the same answer. Writing that
 * answer out twice here would read as two different facts.
 */
export function cp22TextExport(d: Cp22PdfData, r: Cp22Review): string {
  const values = cp22FieldValues(applyCp22Review(d, r));
  const out: string[] = [];
  out.push('CP22 [Pin.1/2021] — BORANG PEMBERITAHUAN OLEH MAJIKAN BAGI PEKERJA BAHARU');
  out.push('NOTIFICATION FORM BY EMPLOYER FOR NEW EMPLOYEE');
  out.push('');
  // Not a box on the form, so it is stated up front rather than mixed in among the ones that are.
  out.push(`Submit to / LHDN branch: ${r.submitTo ?? ''}`);
  out.push('  (no box for this on CP22 [Pin.1/2021] — it does not print on the form)');
  out.push('');

  for (const section of CP22_SECTIONS) {
    out.push(`${section.letter}. ${section.label}`);
    for (const f of CP22_FIELDS) {
      if (cp22Section(f) !== section.letter) continue;
      if (f.code === 'D4en' || f.code === 'D8en') continue; // the same answer as its Malay twin
      const value = f.type === 'checkbox' ? '' : (values[f.name] ?? '');
      // A multi-row value carries one '\n' per printed row; on one line they read as one address.
      out.push(`  ${f.code}. ${f.label}: ${value.split('\n').join(', ')}`);
    }
    out.push('');
  }

  const blanks = CP22_FIELDS.filter((f) => !f.prefilled).map((f) => f.code);
  out.push(`Left blank on purpose (nothing in the system holds these): ${blanks.join(', ')}`);
  out.push('');
  out.push('Since 1 September 2024 a CP22 is filed through the e-CP22 service on MyTax. This file is what');
  out.push('you key in there, and your own record — it is not the filing.');
  return `${out.join('\n')}\n`;
}

/** The D-section total the PDF prints, for the screen to show beside the boxes. */
export const cp22Total = (d: Cp22PdfData): string =>
  cp22Amount((d.pay.salaryAndOvertime ?? 0) + d.pay.cashAllowances.reduce((s, a) => s + (Number(a.amount) || 0), 0));

/** ISO → dd/mm/yyyy for the screen, using the renderer's own formatter so the two never diverge. */
export const cp22DisplayDate = dmy;

/**
 * Which boxes will NOT hold their whole value on the printed form, so the review screen can say so.
 *
 * A CP22 with more recurring allowances than D4's one printed rule can hold ends with LHDN's own
 * continuation wording on that rule (`CP22_CONTINUED`) — which is what the form itself instructs, and is
 * honest on paper. It would NOT be honest on this screen to show the complete list with no hint that the
 * PDF does not carry all of it, so the screen asks the renderer the same question the renderer answers
 * when it draws, using the same font and the same geometry. Nothing is estimated here.
 *
 * Returns the affected field CODES (e.g. `['D4ms', 'D4en']`), empty when everything fits.
 */
export async function cp22ContinuedCodes(d: Cp22PdfData): Promise<string[]> {
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const values = cp22FieldValues(d);
  return CP22_FIELDS.filter(
    (f) => f.type !== 'checkbox' && fitBlock(values[f.name] ?? '', f, font).rows.some((r) => r.continued),
  ).map((f) => f.code);
}
