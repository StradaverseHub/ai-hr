/**
 * CP22 (Pin. 1/2020) — overlay LHDN's official page with a fillable AcroForm and pre-fill what we hold.
 *
 * THIS IS NOT A DRAWN DOCUMENT. lib/ea-pdf.ts, lib/payslip-pdf.ts and lib/review-letter-pdf.ts all draw an
 * A4 from scratch; this is the tree's FIRST `PDFDocument.load`, first `getForm` and first `createTextField`.
 * What downloads is LHDN's own artwork — same layout, same wording, same Malay and English — with 33 typing
 * boxes added ON TOP of it at the coordinates in lib/cp22-fields.ts. The template bytes are never modified;
 * they are loaded, widgets are added, and a COPY is saved.
 *
 * THREE THINGS THIS FILE MUST KEEP DOING, EACH OF WHICH FAILS SILENTLY IF DROPPED:
 *
 * 1. APPEARANCE STREAMS. pdf-lib writes them only when asked. Without an embedded font, an explicit
 *    `updateFieldAppearances(font)` and `NeedAppearances = true` on the AcroForm dictionary, the added boxes
 *    render BLANK or unstyled in real viewers (Preview, Acrobat, Chrome's built-in reader) while tsc, the
 *    suite and `next build` all stay green — there is nothing to fail. test/cp22-pdf.test.ts asserts all
 *    three, because "it compiled" is not evidence for this class of bug.
 *
 * 2. THE FORM STAYS UNFLATTENED. Every box — including the 26 that arrive filled — must remain editable in
 *    the downloaded file, because the operator finishes the remaining boxes and corrects anything wrong
 *    before signing. `form.flatten()` must never appear here.
 *
 * 3. NOTHING IS EVER INVENTED. Seven of the 33 boxes have no answer anywhere in the schema, and they render
 *    as EMPTY, still-typeable boxes rather than a plausible guess:
 *      1  LHDN branch address     — which branch you file with is your choice, not a record we hold.
 *      11 tax-agent tick          — only the operator knows whether the correspondence address is an agent's.
 *      18 passport previously registered with LHDNM — never collected (employeeStatutoryMy.passportRemark is
 *         a free remark, not this field, and must not be used for it).
 *      25 spouse's income tax no. — employeeDependent has no tax column and employeeStatutoryMy is per-EMPLOYEE.
 *      28 fluctuating emoluments and when they will be known — not held anywhere.
 *      29 previous employer in Malaysia — no employment_history / work_experience / previous_employer table
 *         exists. employeeDependent.companyName / employerAddress are the SPOUSE'S employer and are NOT this.
 *      30 the signature itself.
 *    Boxes 23/24 (spouse) and 31/32 (the signatory) fill only when the record is there, and are blank
 *    otherwise — never the company name, never a stand-in.
 */
import { PDFBool, PDFDocument, PDFName, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { CP22_DEFAULT_FONT_SIZE, CP22_FIELDS, type Cp22Field } from './cp22-fields';

/** One recurring earning in force on the commencement date — box (b) of the terms of employment. */
export type Cp22Allowance = { label: string; amount: number };

/**
 * Everything the form can be filled from. Every field is nullable: an absent record produces an empty
 * editable box, which is the whole contract of this document.
 */
export type Cp22PdfData = {
  employer: {
    name: string;
    /** Address lines, already ordered and free of blanks. */
    addressLines: string[];
    /** LHDN "E" number (company_statutory_my.lhdn_employer_no). */
    eNumber: string | null;
    phone: string | null;
  };
  employee: {
    fullName: string;
    /** Job title from the current assignment's position — the form's "Nature of employment". */
    natureOfEmployment: string | null;
    /** ISO yyyy-mm-dd. */
    commencementDate: string | null;
    /** "Permanent", or the contract dates for a contract/intern assignment. Editable in the file. */
    expectedDuration: string | null;
    residentialAddressLines: string[];
    correspondenceAddressLines: string[];
    phone: string | null;
    email: string | null;
    incomeTaxNo: string | null;
    icNo: string | null;
    passportNo: string | null;
    /** person.gender — 'male' | 'female' | anything else (which yields an empty box). */
    gender: string | null;
    /** person.nationality, free text. */
    citizen: string | null;
    /** ISO yyyy-mm-dd. */
    dateOfBirth: string | null;
    /** person.maritalStatus — 'single' | 'married' | 'other'. */
    maritalStatus: string | null;
  };
  /** The employee's spouse, when one is on the family register. Null ⇒ boxes 23 and 24 stay empty. */
  spouse: { fullName: string | null; icOrPassport: string | null } | null;
  pay: {
    /** Monthly basic — box (a). Printed after the form's own preprinted "RM". */
    monthlyFixedRemuneration: number | null;
    /** Fixed monthly allowances — box (b), one line each. */
    allowances: Cp22Allowance[];
  };
  /**
   * The person signing. Filled ONLY when the session resolves to a person with a current assignment —
   * SessionContext.personId is documented null for an admin not tied to an employee. Blank otherwise.
   */
  signatory: { name: string | null; designation: string | null };
  /** ISO yyyy-mm-dd — the date printed in the signature block (box 33). */
  today: string;
};

/**
 * Helvetica is WinAnsi (Latin-1), and `updateFieldAppearances` THROWS on a character outside it — so a
 * Tamil or Chinese legal name would fail the whole render rather than degrade. Narrowed the same way
 * lib/ea-pdf.ts narrows the EA: a documented, tracked limitation (embedding a Unicode font is the deferred
 * follow-up per ADR-0036), not an accidental silent drop.
 *
 * TWO DIFFERENCES FROM THE EA'S GUARD, BOTH LOAD-BEARING HERE. The newline SURVIVES — an address block on
 * this form is four ruled rows and the EA has no multi-line field, so the EA's guard turning \n into '?'
 * would put a whole address on one line with question marks between its lines (observed, first render).
 * And the punctuation a picker or an import routinely produces (en/em dashes, curly quotes) is folded to
 * its ASCII twin rather than lost to '?', because a legal name with a typographic apostrophe is common.
 */
const safe = (s: string): string =>
  (s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\n\x20-\x7E\xA0-\xFF]/g, '?');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** ISO yyyy-mm-dd → the 8 comb cells the form prints as hh/bb/tttt (dd/mm/yyyy). */
export function ddmmyyyy(iso: string | null): string {
  if (!iso || !ISO.test(iso)) return '';
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
}

/** ISO yyyy-mm-dd → dd/mm/yyyy, for the plain date box in the signature block. */
export function dmy(iso: string | null): string {
  if (!iso || !ISO.test(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/**
 * An LHDN income tax number into the row's 14 comb positions.
 *
 * The row prints TWO cells, a one-cell GAP, then eleven — so the file-type prefix (SG, OG) belongs in cells
 * 1–2 and the digits start at cell 4. Padding the prefix to three characters puts a space in the gap and
 * lands every digit on a printed cell. A value that does not parse is written through as-is rather than
 * reshaped: better slightly misaligned than silently altered, and it is editable either way.
 */
export function taxNoComb(v: string | null): string {
  const raw = (v ?? '').replace(/[\s-]+/g, '').toUpperCase();
  if (!raw) return '';
  const m = /^([A-Z]{1,2})(\d+)$/.exec(raw);
  const out = m ? `${m[1]}${' '.repeat(3 - m[1].length)}${m[2]}` : raw;
  return out.slice(0, 14);
}

/** Strip a value down to what fits a row of printed character cells. */
export function combValue(v: string | null, maxLen: number): string {
  return (v ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, maxLen);
}

/**
 * A Malaysian telephone number split across the form's PRINTED DASH: area/network prefix in the three
 * cells to its left, the rest in the eight to its right.
 *
 * Split on the stored separator when there is one — that is the operator's own grouping and it beats any
 * rule we could invent. With no separator, `01x` mobiles take three digits and everything else two, which
 * is the standard Malaysian grouping. Leading +60 / 60 is normalised back to a national 0 first.
 */
export function splitMyPhone(v: string | null): { prefix: string; rest: string } {
  const raw = (v ?? '').trim();
  if (!raw) return { prefix: '', rest: '' };
  const sep = /^[+()\d\s]*?(\d[\d\s]*?)\s*[-/]\s*([\d\s-]+)$/.exec(raw);
  if (sep) return { prefix: digits(sep[1]).slice(-3), rest: digits(sep[2]).slice(0, 8) };
  let d = digits(raw);
  if (d.startsWith('60')) d = `0${d.slice(2)}`;
  const cut = d.startsWith('01') ? 3 : 2;
  return { prefix: d.slice(0, cut), rest: d.slice(cut, cut + 8) };
}
const digits = (s: string) => s.replace(/\D/g, '');

/** 6500 → "6,500.00". The form prints its own "RM", so this carries no currency prefix. */
const amount = (n: number) =>
  (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 'married' → 'Married'. The stored vocabulary written back plainly, never reworded into LHDN's. */
const titleCase = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

const GENDER_CELL: Record<string, string> = { male: '1', female: '2' };

/**
 * The value for every field, keyed by `Cp22Field.name`. Pure and exported so the mapping can be tested
 * without producing a PDF. A missing key (or an empty string) means an empty, still-editable box.
 */
export function cp22FieldValues(d: Cp22PdfData): Record<string, string> {
  const phone = splitMyPhone(d.employee.phone);
  const v: Record<string, string> = {
    employerNameAddress: [d.employer.name, ...d.employer.addressLines].filter(Boolean).join('\n'),
    employerNo: d.employer.eNumber ?? '',
    employerPhone: d.employer.phone ?? '',
    employeeFullName: d.employee.fullName ?? '',
    natureOfEmployment: d.employee.natureOfEmployment ?? '',
    commencementDate: ddmmyyyy(d.employee.commencementDate),
    expectedDuration: d.employee.expectedDuration ?? '',
    residentialAddress: d.employee.residentialAddressLines.filter(Boolean).join('\n'),
    correspondenceAddress: d.employee.correspondenceAddressLines.filter(Boolean).join('\n'),
    telephonePrefix: phone.prefix,
    telephoneNumber: phone.rest,
    email: d.employee.email ?? '',
    incomeTaxNo: taxNoComb(d.employee.incomeTaxNo),
    icNo: combValue(d.employee.icNo, 12),
    currentPassportNo: combValue(d.employee.passportNo, 12),
    gender: GENDER_CELL[(d.employee.gender ?? '').toLowerCase()] ?? '',
    citizen: d.employee.citizen ?? '',
    dateOfBirth: ddmmyyyy(d.employee.dateOfBirth),
    maritalStatus: titleCase(d.employee.maritalStatus),
    spouseFullName: d.spouse?.fullName ?? '',
    spouseIcOrPassport: combValue(d.spouse?.icOrPassport ?? null, 12),
    monthlyFixedRemuneration: d.pay.monthlyFixedRemuneration == null ? '' : amount(d.pay.monthlyFixedRemuneration),
    monthlyAllowances: d.pay.allowances.map((a) => `${a.label} - RM ${amount(a.amount)}`).join('\n'),
    signatoryName: d.signatory.name ?? '',
    signatoryDesignation: d.signatory.designation ?? '',
    signatureDate: dmy(d.today),
  };
  return v;
}

/** pdf-lib defaults a widget to a white background and a 1pt black border; the artwork already draws the
 *  cell, so both are switched off. Passing the keys explicitly matters — pdf-lib defaults on key ABSENCE. */
const TRANSPARENT = { backgroundColor: undefined, borderColor: undefined, borderWidth: 0 } as const;

function addField(form: ReturnType<PDFDocument['getForm']>, page: PDFPage, f: Cp22Field, value: string, font: PDFFont) {
  const opts = { ...f.rect, ...TRANSPARENT, font };
  if (f.type === 'checkbox') {
    // Created but never ticked: only the operator knows whether the correspondence address is a tax agent's.
    form.createCheckBox(f.name).addToPage(page, opts);
    return;
  }
  const field = form.createTextField(f.name);
  // The point size goes in via the /DA string rather than `setFontSize`, which THROWS on a field that has
  // no /DA yet — and a field pdf-lib has only just created has none. `updateFieldAppearances` reads the size
  // back out of this /DA (a missing one means "auto-size to the box", which on an 11.5pt statutory cell is
  // not what anyone wants) and rewrites it with the embedded font's real name.
  field.acroField.setDefaultAppearance(`/${font.name} ${f.fontSize ?? CP22_DEFAULT_FONT_SIZE} Tf 0 g`);
  if (f.type === 'multiline') field.enableMultiline();
  if (f.type === 'comb' && f.maxLen) {
    // Order matters: pdf-lib refuses to comb a field with no maxLength, and combing is what puts one glyph
    // per PRINTED cell instead of a run of text lying across the cell borders.
    field.setMaxLength(f.maxLen);
    field.enableCombing();
  }
  const text = safe(value);
  if (text) field.setText(f.maxLen ? text.slice(0, f.maxLen) : text);
  field.addToPage(page, opts);
}

/**
 * Render a fillable CP22 over the bundled template.
 *
 * @param template the bytes of public/forms/cp22-pin-1-2020.pdf (the caller reads the file; this stays pure)
 * @param data     the particulars to pre-fill, or `null` for the completely blank fillable copy
 */
export async function renderCp22Pdf(template: Uint8Array, data: Cp22PdfData | null): Promise<Uint8Array> {
  const doc = await PDFDocument.load(template);
  const page = doc.getPages()[0];
  // The template ships with NO /AcroForm; getForm creates one. Every widget below is added to it.
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const values = data ? cp22FieldValues(data) : {};

  for (const f of CP22_FIELDS) addField(form, page, f, values[f.name] ?? '', font);

  // (1) of the three — see the file header. Both halves are needed: the appearance streams are what most
  // viewers draw, and NeedAppearances is what makes the ones that regenerate (and every viewer, after the
  // operator edits a box) lay the text out themselves instead of showing nothing.
  form.updateFieldAppearances(font);
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  // pdf-lib does not maintain /DR. Without it a viewer honouring NeedAppearances has to guess which font
  // the /DA names, so the operator's own typing can come back in a substituted face. One dictionary fixes it.
  form.acroForm.dict.set(
    PDFName.of('DR'),
    doc.context.obj({ Font: doc.context.obj({ [font.name]: font.ref }) }),
  );

  // NEVER form.flatten(): every box, including the 26 filled ones, stays typeable in the downloaded file.
  // `updateFieldAppearances: false` because the call above already did it WITH our embedded font; letting
  // save() redo it would fall back to its own default.
  return doc.save({ updateFieldAppearances: false });
}
