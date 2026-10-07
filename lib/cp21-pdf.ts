/**
 * r415 (item 79f3f64d, step 3) — CP21 [Pin.1/2025]: overlay LHDN's own two-page form with a fillable
 * AcroForm and pre-fill what we hold.
 *
 * THE CP22A RENDERER'S CONTRACT, KEPT (lib/cp22a-pdf.ts): the template bytes are loaded, never modified,
 * and a copy is saved; appearance streams are written with an embedded font AND NeedAppearances is set AND
 * /DR names the font; the form is NEVER flattened; nothing is invented; every line of a multi-row block is
 * drawn whole; every widget lands on the page the map says.
 *
 * IT REUSES, IT DOES NOT TOUCH. The identifier helpers (`cp22aIdCells`, `cp22aTinCells`,
 * `cp22aEmployerNoCells`, `cp22aDateCells`, `cp22aDmy`) are imported from lib/cp22a-pdf.ts and the lossless
 * fitting (`fitBlock`) from lib/cp22-pdf.ts, as they stand — so neither the CP22's nor the CP22A's bytes can
 * move because of this file (test/r415-cp21.test.ts holds both files byte-identical to the round's base).
 * The widget writer below is the CP22A's, copied rather than exported, for the same reason.
 *
 * A COMB NEVER TRUNCATES; AN ABSENT AMOUNT IS AN EMPTY BOX, NEVER 0.00 — both as CP22A.
 */
import { PDFBool, PDFDocument, PDFName, StandardFonts, TextAlignment, type PDFFont, type PDFPage } from 'pdf-lib';
import { cp22Amount, fitBlock } from './cp22-pdf';
import type { Cp22Field } from './cp22-fields';
import { CP22A_COMB_FONT_SIZE, CP22A_MARK_FONT_SIZE } from './cp22a-fields';
import { cp22aDateCells, cp22aDmy, cp22aEmployerNoCells, cp22aIdCells, cp22aTinCells } from './cp22a-pdf';
import { CP21_FIELDS, cp21WidgetName, type Cp21Field } from './cp21-fields';

/** The section-B lines a figure can reach. Lines 2 and 10 have no source at all (see the field map). */
export type Cp21PayLine = 1 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 11;

/** What the operator types on the preview screen. Never stored; see lib/cp21-review.ts. */
export type Cp21Typed = {
  /** A3, ISO yyyy-mm-dd. */
  departureDate: string | null;
  /** A14 — free text, one string; the renderer folds it over the two rows. */
  reason: string | null;
  /** A15 — one entry per printed row; extra lines fold into the last row. */
  overseasAddress: string[];
  /** A16, ISO yyyy-mm-dd; printed dd/mm/yyyy in a plain box. */
  returnDate: string | null;
  /** A18. */
  scheme: 'yes' | 'no' | null;
};

export const CP21_NO_TYPED: Cp21Typed = {
  departureDate: null,
  reason: null,
  overseasAddress: [],
  returnDate: null,
  scheme: null,
};

export type Cp21PdfData = {
  employer: {
    name: string;
    addressLines: string[];
    /** As stored; the leading E is stripped for the form (the form prints it). */
    eNumber: string | null;
    phone: string | null;
  };
  employee: {
    fullName: string;
    icNo: string | null;
    passportNo: string | null;
    taxNo: string | null;
    /** A2. */
    commencementDate: string | null;
    /**
     * A4 — "Mastautin dalam tahun meninggalkan Malaysia". true → Ya, false → Tidak, null (nothing recorded)
     * → both boxes blank. core/reporting.ts `cp21Particulars` says where it comes from.
     */
    resident: boolean | null;
    /** A7 — person.nationality, as stored. */
    citizen: string | null;
    dateOfBirth: string | null;
    /** A10 — the current position title. */
    natureOfEmployment: string | null;
    phone: string | null;
    email: string | null;
    /** A13. */
    correspondenceAddress: string[];
    /** A17 — employee_statutory_my.employer_bears_tax; null (no statutory row) → both boxes blank. */
    taxBorneByEmployer: boolean | null;
  };
  pay: {
    /** "Tempoh dari / hingga", ISO. Null when no processed payroll falls in the period. */
    from: string | null;
    to: string | null;
    /** Only the lines with a source. Absent ⇒ blank amount AND blank period. */
    lines: Partial<Record<Cp21PayLine, number>>;
    /** B11's "nyatakan" — what went into line 11, in the form's language. */
    line11Items: string[];
  };
  deductions: { pcb: number | null; zakat: number | null; epf: number | null };
  officer: { name: string | null; designation: string | null; email: string | null };
  /** E5, ISO. */
  today: string;
  typed: Cp21Typed;
};

/** The value of every box, keyed by field name. A comb's value is one string per printed group. */
export type Cp21Values = Record<string, string | string[]>;

/**
 * Comb values that could not be placed, keyed by field code. Pure: the preview calls it to warn, and the
 * renderer calls `cp21FieldValues`, which leaves exactly these empty.
 */
export function cp21OverflowCodes(d: Cp21PdfData): string[] {
  const out: string[] = [];
  if (cp22aEmployerNoCells(d.employer.eNumber) === null) out.push('H2');
  if (cp22aIdCells(d.employee.icNo, d.employee.passportNo) === null) out.push('A5');
  if (cp22aTinCells(d.employee.taxNo) === null) out.push('A6');
  return out;
}

/**
 * The value for every field. Pure and exported so the mapping is testable without producing a PDF.
 * Every `source: 'none'` field is ABSENT from this map, which is how it stays empty.
 */
export function cp21FieldValues(d: Cp21PdfData): Cp21Values {
  const v: Cp21Values = {};
  const blankComb = (n: number) => Array.from({ length: n }, () => '');

  // ── header
  v.employerNameAddress = [d.employer.name, ...d.employer.addressLines].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
  v.employerNo = cp22aEmployerNoCells(d.employer.eNumber) ?? [''];
  v.employerPhone = d.employer.phone ?? '';

  // ── A, left column
  v.employeeName = d.employee.fullName ?? '';
  v.commencementDate = cp22aDateCells(d.employee.commencementDate);
  v.departureDate = cp22aDateCells(d.typed.departureDate);
  v.residentYes = d.employee.resident === true ? 'X' : '';
  v.residentNo = d.employee.resident === false ? 'X' : '';
  v.icNo = cp22aIdCells(d.employee.icNo, d.employee.passportNo) ?? [''];
  v.taxNo = cp22aTinCells(d.employee.taxNo) ?? blankComb(2);
  v.citizen = d.employee.citizen ?? '';
  v.dateOfBirth = cp22aDateCells(d.employee.dateOfBirth);
  v.natureOfEmployment = d.employee.natureOfEmployment ?? '';
  v.employeePhone = d.employee.phone ?? '';
  v.employeeEmail = d.employee.email ?? '';

  // ── A, right column
  v.correspondenceAddress = d.employee.correspondenceAddress.filter(Boolean).join('\n');
  v.departureReason = d.typed.reason ?? '';
  v.overseasAddress = d.typed.overseasAddress.filter(Boolean).join('\n');
  v.returnDate = cp22aDmy(d.typed.returnDate);
  v.taxBorneYes = d.employee.taxBorneByEmployer === true ? 'X' : '';
  v.taxBorneNo = d.employee.taxBorneByEmployer === false ? 'X' : '';
  v.schemeYes = d.typed.scheme === 'yes' ? 'X' : '';
  v.schemeNo = d.typed.scheme === 'no' ? 'X' : '';

  // ── B. A line prints its period AND its amount only when it has a source; otherwise all three are blank.
  const from = cp22aDmy(d.pay.from);
  const to = cp22aDmy(d.pay.to);
  let total = 0;
  let anyLine = false;
  for (const [key, amount] of Object.entries(d.pay.lines) as [string, number | undefined][]) {
    if (amount == null) continue;
    v[`b${key}From`] = from;
    v[`b${key}To`] = to;
    v[`b${key}Amount`] = cp22Amount(amount);
    total += Number(amount) || 0;
    anyLine = true;
  }
  if (d.pay.lines[11] != null && d.pay.line11Items.length) v.b11Specify = d.pay.line11Items.join('; ');
  // JUMLAH is the sum of the boxes THIS renderer filled, so it equals what is printed above it.
  if (anyLine) v.bTotal = cp22Amount(Math.round(total * 100) / 100);

  // ── D. D1 has no source (see the map).
  const amt = (n: number | null | undefined): string => (n == null ? '' : cp22Amount(n));
  v.d2Pcb = amt(d.deductions.pcb);
  v.d3Zakat = amt(d.deductions.zakat);
  v.d4Epf = amt(d.deductions.epf);

  // ── E
  v.officerName = d.officer.name ?? '';
  v.officerDesignation = d.officer.designation ?? '';
  v.officerEmail = d.officer.email ?? '';
  v.declarationDate = cp22aDateCells(d.today);

  // Belt and braces: whatever the code above did, a `source: 'none'` box carries nothing.
  for (const f of CP21_FIELDS) if (f.source === 'none') delete v[f.name];
  return v;
}

const TRANSPARENT = { backgroundColor: undefined, borderColor: undefined, borderWidth: 0 } as const;

/** lib/cp22a-pdf.ts's widget writer, copied (see the header for why it is not imported). */
function addField(form: ReturnType<PDFDocument['getForm']>, page: PDFPage, f: Cp21Field, value: string | string[] | undefined, font: PDFFont) {
  if (f.type === 'comb') {
    const parts = Array.isArray(value) ? value : [];
    const size = f.fontSize ?? CP22A_COMB_FONT_SIZE;
    (f.groups ?? []).forEach((group, i) => {
      const tf = form.createTextField(cp21WidgetName(f.name, i));
      tf.acroField.setDefaultAppearance(`/${font.name} ${size} Tf 0 g`);
      tf.setMaxLength(group.cells);
      tf.enableCombing();
      const text = (parts[i] ?? '').replace(/[^\x20-\x7E]/g, '');
      // Never cut: a part that does not fit its cells is left out (the caller already blanked overflow).
      if (text && text.length <= group.cells) tf.setText(text);
      tf.addToPage(page, { ...group.rect, ...TRANSPARENT, font });
    });
    return;
  }
  if (f.type === 'mark') {
    const tf = form.createTextField(f.name);
    tf.acroField.setDefaultAppearance(`/${font.name} ${CP22A_MARK_FONT_SIZE} Tf 0 g`);
    tf.setAlignment(TextAlignment.Center);
    if (value === 'X') tf.setText('X');
    tf.addToPage(page, { ...f.rect, ...TRANSPARENT, font });
    return;
  }
  const fit = fitBlock(typeof value === 'string' ? value : '', f as unknown as Cp22Field, font);
  fit.rows.forEach((row, i) => {
    const tf = form.createTextField(cp21WidgetName(f.name, i));
    tf.acroField.setDefaultAppearance(`/${font.name} ${row.fontSize} Tf 0 g`);
    if (f.alignRight) tf.setAlignment(TextAlignment.Right);
    if (row.text) tf.setText(row.text);
    tf.addToPage(page, { ...row.rect, ...TRANSPARENT, font });
  });
}

/**
 * Field codes whose value is wider than its printed box even at the smallest legible face, so the PDF says
 * "lihat lampiran / see attached" on it. The preview names them.
 */
export async function cp21ContinuedCodes(d: Cp21PdfData): Promise<string[]> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const values = cp21FieldValues(d);
  return CP21_FIELDS.filter((f) => f.type === 'text' || f.type === 'multirow' || f.type === 'rule')
    .filter((f) => {
      const value = values[f.name];
      return typeof value === 'string' && fitBlock(value, f as unknown as Cp22Field, font).rows.some((r) => r.continued);
    })
    .map((f) => f.code);
}

/**
 * Render a fillable CP21 over the bundled two-page template.
 *
 * @param template the bytes of public/forms/cp21-pin-1-2025.pdf
 * @param data     the particulars, or `null` for an entirely blank fillable copy
 */
export async function renderCp21Pdf(template: Uint8Array, data: Cp21PdfData | null): Promise<Uint8Array> {
  const doc = await PDFDocument.load(template);
  const pages = doc.getPages();
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const values = data ? cp21FieldValues(data) : {};
  for (const f of CP21_FIELDS) {
    const page = pages[f.page];
    if (!page) throw new Error(`CP21 template has no page ${f.page} for field ${f.code}`);
    addField(form, page, f, values[f.name], font);
  }
  form.updateFieldAppearances(font);
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  form.acroForm.dict.set(PDFName.of('DR'), doc.context.obj({ Font: doc.context.obj({ [font.name]: font.ref }) }));
  // NEVER form.flatten(): every box stays typeable in the downloaded file.
  return doc.save({ updateFieldAppearances: false });
}
