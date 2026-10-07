/**
 * r413 (item 79f3f64d, step 2) — CP22A [Pin.1/2023]: overlay LHDN's own two-page form with a fillable
 * AcroForm and pre-fill what we hold.
 *
 * THE CP22 RENDERER'S CONTRACT, KEPT WORD FOR WORD (lib/cp22-pdf.ts, "FIVE THINGS"): the template bytes are
 * loaded, never modified, and a copy is saved; appearance streams are written with an embedded font AND
 * NeedAppearances is set AND /DR names the font; the form is NEVER flattened; nothing is invented; every
 * line of a multi-row block is drawn whole; and every widget lands on the page the map says.
 *
 * IT REUSES CP22's FITTING, IT DOES NOT TOUCH IT. `fitBlock` (fold-to-rows, shrink-to-fit, the "see attached"
 * marker) is imported from lib/cp22-pdf.ts as it stands, so the CP22's bytes cannot move because of this
 * file. The two things CP22 [Pin.1/2021] does not have are written here: character-cell COMBS (one combed
 * widget per printed group) and the "Sila tandakan 'X'" MARK boxes.
 *
 * A COMB NEVER TRUNCATES. A value with more characters than the printed cells (a 13-character passport in
 * a 12-cell IC row, a tax number with twelve digits) is NOT cut to fit — a cut identifier is a different
 * identifier. The comb is left empty and editable instead, and `cp22aOverflowCodes` names it so the preview
 * screen says so before anything is downloaded.
 *
 * AN ABSENT AMOUNT IS AN EMPTY BOX, NEVER 0.00. `pay.lines` carries only the section-B lines that HAVE a
 * source (core/reporting.ts `cp22aParticulars` decides which); a line that is absent prints nothing in its
 * amount box OR its period boxes. 0.00 is printed only where the record genuinely says nothing was paid.
 */
import { PDFBool, PDFDocument, PDFName, StandardFonts, TextAlignment, type PDFFont, type PDFPage } from 'pdf-lib';
import { cp22Amount, fitBlock } from './cp22-pdf';
import type { Cp22Field } from './cp22-fields';
import {
  CP22A_COMB_FONT_SIZE,
  CP22A_FIELDS,
  CP22A_MARK_FONT_SIZE,
  cp22aWidgetName,
  type Cp22aField,
} from './cp22a-fields';
import { cp39EmployerNoForForm, cp39IcForForm } from './cp39-form';

/** A2 — LHDN's three kinds of cessation, in the form's own order. */
export type Cp22aCessation = 'resigned' | 'retired' | 'death';

/** The section-B lines a figure can reach. Lines 2, 10 and 11 have no source at all (see the field map). */
export type Cp22aPayLine = 1 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12;

/** What the operator types on the preview screen. Never stored; see lib/cp22a-review.ts. */
export type Cp22aTyped = {
  /** A5, ISO yyyy-mm-dd. */
  deathNotifiedDate: string | null;
  /** A6. */
  retirement: 'compulsory' | 'optional' | null;
  /** A8. */
  scheme: 'yes' | 'no' | null;
  /** A17 a–e. */
  rep: { name: string | null; icNo: string | null; relationship: string | null; address: string[]; phone: string | null };
};

export const CP22A_NO_TYPED: Cp22aTyped = {
  deathNotifiedDate: null,
  retirement: null,
  scheme: null,
  rep: { name: null, icNo: null, relationship: null, address: [], phone: null },
};

export type Cp22aPdfData = {
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
    commencementDate: string | null;
    cessationDate: string | null;
    cessation: Cp22aCessation;
    dateOfBirth: string | null;
    maritalStatus: string | null;
    /**
     * A7 — "Cukai ditanggung majikan": employee_statutory_my.employer_bears_tax, the flag payroll itself
     * runs on (core/payroll.ts funds the PCB from employer cost when it is set). true → Ya, false → Tidak,
     * null (no statutory record for this person) → both boxes blank.
     */
    taxBorneByEmployer: boolean | null;
    /** A13 a) — the qualifying-children COUNT, as the EA prints item 8. Null = unrecorded (blank). */
    childrenCount: number | null;
    phone: string | null;
    email: string | null;
    correspondenceAddress: string[];
  };
  spouse: { fullName: string | null; icOrPassport: string | null } | null;
  pay: {
    /** "Tempoh dari / hingga", ISO. Null when no processed payroll falls in the period. */
    from: string | null;
    to: string | null;
    /** Only the lines with a source. Absent ⇒ blank amount AND blank period. */
    lines: Partial<Record<Cp22aPayLine, number>>;
    /** B12's "nyatakan" — what went into line 12, in the form's language. */
    line12Items: string[];
    /** B13 — ESOS benefit; null ⇒ blank. */
    esos: number | null;
  };
  deductions: { pcb: number | null; zakat: number | null; epf: number | null };
  officer: { name: string | null; designation: string | null; email: string | null };
  /** E5, ISO. */
  today: string;
  typed: Cp22aTyped;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** ISO → the dd mm yy cells. LHDN prints three pairs of cells, so the year is two digits. */
export const cp22aDateCells = (iso: string | null): string[] =>
  iso && ISO.test(iso) ? [iso.slice(8, 10), iso.slice(5, 7), iso.slice(2, 4)] : ['', '', ''];
/** ISO → dd/mm/yyyy, for the plain "Tempoh" boxes of section B, which are not combed. */
export const cp22aDmy = (iso: string | null): string =>
  iso && ISO.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';

/**
 * A TIN for the two printed groups: the letter prefix (2 cells) and the digits (11 cells). `null` when the
 * stored value is not that shape or will not fit — the comb is then left empty (never reshaped, never cut).
 */
export function cp22aTinCells(v: string | null): string[] | null {
  const raw = (v ?? '').replace(/\s+/g, '').toUpperCase();
  if (!raw) return ['', ''];
  const m = /^([A-Z]{1,2})(\d{1,11})$/.exec(raw);
  return m ? [m[1], m[2]] : null;
}

/** The ID cells: twelve MyKad digits, or a passport as stored, if it fits. `null` = will not fit. */
export function cp22aIdCells(ic: string | null, passport: string | null, cells = 12): string[] | null {
  const pick = (ic ?? '').trim() ? cp39IcForForm(ic) : (passport ?? '').trim();
  const v = pick.replace(/\s+/g, '');
  if (v.length > cells) return null;
  return [v];
}

/** The employer-number cells: the stored value less its leading E (the form prints that E). */
export function cp22aEmployerNoCells(stored: string | null): string[] | null {
  const v = cp39EmployerNoForForm(stored ?? '').replace(/\s+/g, '');
  return v.length > 10 ? null : [v];
}

/** The value of every box, keyed by field name. A comb's value is one string per printed group. */
export type Cp22aValues = Record<string, string | string[]>;

/** A2 — the box this cessation marks. retired → Bersara, death → Meninggal dunia, everything else → Berhenti kerja. */
const CESSATION_BOX: Record<Cp22aCessation, string> = {
  resigned: 'cessationResigned',
  retired: 'cessationRetired',
  death: 'cessationDeath',
};

const titleCase = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');
const amt = (n: number | null | undefined): string => (n == null ? '' : cp22Amount(n));

/**
 * Comb values that could not be placed, keyed by field code. Pure: the preview calls it to warn, and the
 * renderer calls `cp22aFieldValues`, which leaves exactly these empty.
 */
export function cp22aOverflowCodes(d: Cp22aPdfData): string[] {
  const out: string[] = [];
  if (cp22aEmployerNoCells(d.employer.eNumber) === null) out.push('H2');
  if (cp22aIdCells(d.employee.icNo, d.employee.passportNo) === null) out.push('A9');
  if (cp22aTinCells(d.employee.taxNo) === null) out.push('A10');
  if (d.spouse && cp22aIdCells(d.spouse.icOrPassport, null) === null) out.push('A14b');
  if (cp22aIdCells(d.typed.rep.icNo, null) === null) out.push('A17b');
  if (d.employee.childrenCount != null && String(d.employee.childrenCount).length > 2) out.push('A13a');
  return out;
}

/**
 * The value for every field. Pure and exported so the mapping is testable without producing a PDF.
 * Every `source: 'none'` field is ABSENT from this map, which is how it stays empty.
 */
export function cp22aFieldValues(d: Cp22aPdfData): Cp22aValues {
  const v: Cp22aValues = {};
  const blankComb = (n: number) => Array.from({ length: n }, () => '');

  // ── header
  v.employerNameAddress = [d.employer.name, ...d.employer.addressLines].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
  v.employerNo = cp22aEmployerNoCells(d.employer.eNumber) ?? [''];
  v.employerPhone = d.employer.phone ?? '';

  // ── A
  v.employeeName = d.employee.fullName ?? '';
  for (const box of Object.values(CESSATION_BOX)) v[box] = '';
  v[CESSATION_BOX[d.employee.cessation]] = 'X';
  v.commencementDate = cp22aDateCells(d.employee.commencementDate);
  v.cessationDate = cp22aDateCells(d.employee.cessationDate);
  v.deathNotifiedDate = cp22aDateCells(d.typed.deathNotifiedDate);
  v.retirementCompulsory = d.typed.retirement === 'compulsory' ? 'X' : '';
  v.retirementOptional = d.typed.retirement === 'optional' ? 'X' : '';
  v.taxBorneYes = d.employee.taxBorneByEmployer === true ? 'X' : '';
  v.taxBorneNo = d.employee.taxBorneByEmployer === false ? 'X' : '';
  v.schemeYes = d.typed.scheme === 'yes' ? 'X' : '';
  v.schemeNo = d.typed.scheme === 'no' ? 'X' : '';
  v.icNo = cp22aIdCells(d.employee.icNo, d.employee.passportNo) ?? [''];
  v.taxNo = cp22aTinCells(d.employee.taxNo) ?? blankComb(2);
  v.dateOfBirth = cp22aDateCells(d.employee.dateOfBirth);
  v.maritalStatus = titleCase(d.employee.maritalStatus);
  const kids = d.employee.childrenCount;
  v.childrenCount = kids != null && String(kids).length <= 2 ? [String(kids)] : [''];
  v.spouseName = d.spouse?.fullName ?? '';
  v.spouseIcNo = (d.spouse ? cp22aIdCells(d.spouse.icOrPassport, null) : null) ?? [''];
  v.employeePhone = d.employee.phone ?? '';
  v.correspondenceAddress = d.employee.correspondenceAddress.filter(Boolean).join('\n');
  v.employeeEmail = d.employee.email ?? '';
  v.repName = d.typed.rep.name ?? '';
  v.repIcNo = cp22aIdCells(d.typed.rep.icNo, null) ?? [''];
  v.repRelationship = d.typed.rep.relationship ?? '';
  v.repAddress = d.typed.rep.address.filter(Boolean).join('\n');
  v.repPhone = d.typed.rep.phone ?? '';

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
  if (d.pay.lines[12] != null && d.pay.line12Items.length) v.b12Specify = d.pay.line12Items.join('; ');
  if (d.pay.esos != null) {
    v.b13Amount = cp22Amount(d.pay.esos);
    total += Number(d.pay.esos) || 0;
    anyLine = true;
  }
  // JUMLAH is the sum of the boxes THIS renderer filled — so it equals what is printed above it, and an
  // operator who types into a blank line must update it (the preview says so; a PDF cannot recompute).
  if (anyLine) v.bTotal = cp22Amount(Math.round(total * 100) / 100);

  // ── D
  v.d2Pcb = amt(d.deductions.pcb);
  v.d3Zakat = amt(d.deductions.zakat);
  v.d4Epf = amt(d.deductions.epf);

  // ── E
  v.officerName = d.officer.name ?? '';
  v.officerDesignation = d.officer.designation ?? '';
  v.officerEmail = d.officer.email ?? '';
  v.declarationDate = cp22aDateCells(d.today);

  // Belt and braces: whatever the code above did, a `source: 'none'` box carries nothing.
  for (const f of CP22A_FIELDS) if (f.source === 'none') delete v[f.name];
  return v;
}

const TRANSPARENT = { backgroundColor: undefined, borderColor: undefined, borderWidth: 0 } as const;

function addField(form: ReturnType<PDFDocument['getForm']>, page: PDFPage, f: Cp22aField, value: string | string[] | undefined, font: PDFFont) {
  if (f.type === 'comb') {
    const parts = Array.isArray(value) ? value : [];
    const size = f.fontSize ?? CP22A_COMB_FONT_SIZE;
    (f.groups ?? []).forEach((group, i) => {
      const tf = form.createTextField(cp22aWidgetName(f.name, i));
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
  // text / multirow / rule — CP22's own lossless fitting. The shapes are the same (rect, moreRows, rows,
  // foldWith, fontSize), so the CP22 field type is satisfied structurally.
  const fit = fitBlock(typeof value === 'string' ? value : '', f as unknown as Cp22Field, font);
  fit.rows.forEach((row, i) => {
    const tf = form.createTextField(cp22aWidgetName(f.name, i));
    tf.acroField.setDefaultAppearance(`/${font.name} ${row.fontSize} Tf 0 g`);
    if (f.alignRight) tf.setAlignment(TextAlignment.Right);
    if (row.text) tf.setText(row.text);
    tf.addToPage(page, { ...row.rect, ...TRANSPARENT, font });
  });
}

/**
 * Field codes whose value is wider than its printed box even at the smallest legible face, so the PDF says
 * "lihat lampiran / see attached" on it (lib/cp22-pdf.ts `CP22_CONTINUED`). The preview names them.
 */
export async function cp22aContinuedCodes(d: Cp22aPdfData): Promise<string[]> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const values = cp22aFieldValues(d);
  return CP22A_FIELDS.filter((f) => f.type === 'text' || f.type === 'multirow' || f.type === 'rule')
    .filter((f) => {
      const value = values[f.name];
      return typeof value === 'string' && fitBlock(value, f as unknown as Cp22Field, font).rows.some((r) => r.continued);
    })
    .map((f) => f.code);
}

/**
 * Render a fillable CP22A over the bundled two-page template.
 *
 * @param template the bytes of public/forms/cp22a-pin-1-2023.pdf
 * @param data     the particulars, or `null` for an entirely blank fillable copy
 */
export async function renderCp22aPdf(template: Uint8Array, data: Cp22aPdfData | null): Promise<Uint8Array> {
  const doc = await PDFDocument.load(template);
  const pages = doc.getPages();
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const values = data ? cp22aFieldValues(data) : {};
  for (const f of CP22A_FIELDS) {
    const page = pages[f.page];
    if (!page) throw new Error(`CP22A template has no page ${f.page} for field ${f.code}`);
    addField(form, page, f, values[f.name], font);
  }
  form.updateFieldAppearances(font);
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  form.acroForm.dict.set(PDFName.of('DR'), doc.context.obj({ Font: doc.context.obj({ [font.name]: font.ref }) }));
  // NEVER form.flatten(): every box stays typeable in the downloaded file.
  return doc.save({ updateFieldAppearances: false });
}
