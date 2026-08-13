/**
 * CP22 [Pin.1/2021] — overlay LHDN's official two-page form with a fillable AcroForm and pre-fill what we
 * hold.
 *
 * THIS IS NOT A DRAWN DOCUMENT. lib/ea-pdf.ts, lib/payslip-pdf.ts and lib/review-letter-pdf.ts all draw an
 * A4 from scratch; this loads LHDN's own artwork and adds typing boxes ON TOP of it at the coordinates in
 * lib/cp22-fields.ts. The template bytes are never modified; they are loaded, widgets are added, and a
 * COPY is saved — watermark and all.
 *
 * FIVE THINGS THIS FILE MUST KEEP DOING, EACH OF WHICH FAILS SILENTLY IF DROPPED:
 *
 * 1. APPEARANCE STREAMS. pdf-lib writes them only when asked. Without an embedded font, an explicit
 *    `updateFieldAppearances(font)` and `NeedAppearances = true` on the AcroForm dictionary, the added
 *    boxes render BLANK or unstyled in real viewers (Preview, Acrobat, Chrome's built-in reader) while
 *    tsc, the suite and `next build` all stay green — there is nothing to fail. test/cp22-pdf.test.ts
 *    asserts all three, because "it compiled" is not evidence for this class of bug.
 *
 * 2. THE FORM STAYS UNFLATTENED. Every box — including the filled ones — must remain editable in the
 *    downloaded file, because the operator finishes the rest and corrects anything wrong before signing.
 *    `form.flatten()` must never appear here.
 *
 * 3. NOTHING IS EVER INVENTED. Fifteen areas have no answer anywhere in the schema and render as EMPTY,
 *    still-typeable boxes rather than a plausible guess. lib/cp22-fields.ts → `CP22_UNFILLABLE` names
 *    every one and why. In particular the six blank D-lines are NOT written as "0.00": a zero asserts
 *    "there is no leave pay / no bonus", which we do not know, and this is a legal declaration.
 *
 * 4. EVERY LINE OF A MULTI-ROW BLOCK IS DRAWN, AND WHOLE. r175a: a four-line Malaysian address went to
 *    LHDN without its state, because the renderer dropped everything past row three and the box still
 *    looked full. On the 2021 form each row is its OWN drawn box and its own single-line widget, which
 *    removes pdf-lib's multiline clip floor — and replaces it with two other silent drops, both guarded
 *    below:
 *      a. MORE LINES THAN ROWS. Line 4 of a 3-row block has no field to go in. `foldToRows` joins the
 *         tail INTO the last row; nothing is ever dropped or truncated.
 *      b. A LINE TOO WIDE FOR ITS BOX. pdf-lib's `layoutSinglelineText` neither wraps nor truncates: it
 *         draws the whole line and `drawTextField`'s own clip path cuts it off mid-word, with nothing in
 *         any log. THE 2020 RENDERER NEVER GUARDED THIS AT ALL — a long legal name in a 195pt box was
 *         already being clipped in production. `fitSingleLine` shrinks until it fits.
 *    Both are checked by RENDERING at 900dpi under BOTH Poppler and MuPDF, because a green suite, a 200
 *    and even one of the two renderers all reported this page as correct while it was wrong: Poppler
 *    regenerates appearances when NeedAppearances is set, MuPDF draws the embedded stream, and the
 *    disagreement between them IS the instrument.
 *
 * 5. THE RIGHT PAGE. The form is two pages and `Cp22Field.page` says which. A widget added to the wrong
 *    page still opens, still prints and still passes every green check.
 */
import { PDFBool, PDFDocument, PDFName, StandardFonts, TextAlignment, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  CP22_DEFAULT_FONT_SIZE,
  CP22_FIELDS,
  cp22RowName,
  cp22Widgets,
  type Cp22Field,
  type Cp22Rect,
} from './cp22-fields';

/** One recurring cash earning in force on the commencement date — part of D4. */
export type Cp22Allowance = { label: string; amount: number };

/** An address as the 2021 form asks for it: free street rows, then postcode / town / state in their own boxes. */
export type Cp22Address = {
  /** Street lines only. The renderer folds any past the block's row count into the last row. */
  lines: string[];
  postcode: string | null;
  town: string | null;
  state: string | null;
};

/**
 * Everything the form can be filled from. Every field is nullable: an absent record produces an empty
 * editable box, which is the whole contract of this document.
 */
export type Cp22PdfData = {
  employer: {
    /** A1. */
    name: string;
    /** A2 — address lines, already ordered and free of blanks. */
    addressLines: string[];
    /** A3 — the LHDN "E" number (company_statutory_my.lhdn_employer_no). The form prints the "E" itself. */
    eNumber: string | null;
    /** A5. */
    phone: string | null;
  };
  employee: {
    /** B1. */
    fullName: string;
    /** B15 Jawatan — the job title from the current assignment's position. */
    designation: string | null;
    /** B17 Jenis pekerjaan — the KIND of employment, not the title. */
    natureOfEmployment: string | null;
    /** B14 — ISO yyyy-mm-dd. */
    commencementDate: string | null;
    /** B16 — "Permanent", or the contract dates. Editable in the file. */
    expectedDuration: string | null;
    /** B12. */
    residentialAddress: Cp22Address;
    /** B13. */
    correspondenceAddress: Cp22Address;
    /** B10. */
    phone: string | null;
    /** B11. */
    email: string | null;
    /** B2. */
    incomeTaxNo: string | null;
    /** B3. */
    icNo: string | null;
    /** B4. */
    passportNo: string | null;
    /** B7 — person.gender, written through as recorded. */
    gender: string | null;
    /** B6 — person.nationality, free text. */
    citizen: string | null;
    /** B8 — ISO yyyy-mm-dd. */
    dateOfBirth: string | null;
    /** B9 — person.maritalStatus. */
    maritalStatus: string | null;
  };
  /** C — the spouse, when one is on the family register. Null ⇒ C1/C2/C4 stay empty. */
  spouse: { fullName: string | null; icOrPassport: string | null; phone: string | null } | null;
  pay: {
    /** D1 — salary, fees, wages and overtime. */
    salaryAndOvertime: number | null;
    /** D4 — the cash allowances, one entry each; their total goes in D4 and their names on its rules. */
    cashAllowances: Cp22Allowance[];
  };
  /**
   * F — the person declaring. Filled ONLY when the session resolves to a person with a current
   * assignment; SessionContext.personId is documented null for an admin not tied to an employee.
   */
  declarant: { name: string | null; designation: string | null; icOrPassport: string | null };
  /** F5 — ISO yyyy-mm-dd, the date printed in the declaration block. */
  today: string;
};

/**
 * Helvetica is WinAnsi (Latin-1), and `updateFieldAppearances` THROWS on a character outside it — so a
 * Tamil or Chinese legal name would fail the whole render rather than degrade. Narrowed the same way
 * lib/ea-pdf.ts narrows the EA: a documented, tracked limitation (embedding a Unicode font is the deferred
 * follow-up per ADR-0036), not an accidental silent drop.
 *
 * The punctuation a picker or an import routinely produces (en/em dashes, curly quotes) is folded to its
 * ASCII twin rather than lost to '?', because a legal name with a typographic apostrophe is common.
 *
 * THE NEWLINE SURVIVES, and it has to: a multi-row block arrives here as one value with one '\n' per
 * printed row, and `fitBlock` splits it back out immediately afterwards. Sanitising '\n' to '?' would put
 * a whole address on one line with question marks between its parts — which is exactly what the EA's
 * version of this guard does, and why this one is not it.
 */
const safe = (s: string): string =>
  (s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^\n\x20-\x7E\xA0-\xFF]/g, '?');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** ISO yyyy-mm-dd → dd/mm/yyyy. The 2021 form prints plain date boxes, not the 2020 page's comb cells. */
export function dmy(iso: string | null): string {
  if (!iso || !ISO.test(iso)) return '';
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

/**
 * An LHDN income tax number, normalised to the prefix-plus-digits shape LHDN prints (SG 12345678901).
 *
 * NO COMB PADDING. The 2020 page printed the number into fourteen character cells with a one-cell gap
 * after the file-type prefix, and `taxNoComb` existed only to put a space in that gap; the 2021 page
 * prints one plain box, so the gap logic is gone. A value that does not parse is written through as-is
 * rather than reshaped: better slightly unusual than silently altered, and it is editable either way.
 */
export function taxNo(v: string | null): string {
  const raw = (v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  const m = /^([A-Z]{1,2})\s*(\d+)$/.exec(raw.replace(/\s+/g, ''));
  return m ? `${m[1]} ${m[2]}` : raw;
}

/** 6500 → "6,500.00". The column head prints "(RM)", so this carries no currency prefix. */
export const cp22Amount = (n: number): string =>
  (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 'married' → 'Married'. The stored vocabulary written back plainly, never reworded into LHDN's. */
const titleCase = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

/**
 * The value for every field, keyed by `Cp22Field.name`. Pure and exported so the mapping can be tested
 * without producing a PDF.
 *
 * A multi-row block's value carries EMBEDDED NEWLINES — one per printed row — and `fitBlock` splits them
 * back out. A missing key (or an empty string) means an empty, still-editable box.
 *
 * THE D-SECTION MAPPING, AND WHAT IT DELIBERATELY LEAVES BLANK. D1 takes the basic salary in force on the
 * commencement date. D4 takes every recurring cash allowance, totalled, with the names written onto both
 * of its "nyatakan / specify" rules. D2, D3, D5, D6, D7 and D8 are LEFT EMPTY: nothing in payroll holds a
 * leave-pay, bonus, benefit-in-kind, accommodation, in-kind-allowance or other-payment figure at the point
 * of hire, and writing 0.00 would declare their absence rather than ask the question.
 *
 * ALL RECURRING ALLOWANCES GO TO D4 (cash) RATHER THAN D7 (in kind). `payComponent.kind` has a single
 * 'allowance' value covering both, so the two are not distinguishable here; cash is the overwhelmingly
 * common case, D4's specify rules name every component that went in, and D7 stays empty and editable, so
 * an operator with an in-kind item can see exactly what to move and where.
 */
export function cp22FieldValues(d: Cp22PdfData): Record<string, string> {
  const allowanceTotal = d.pay.cashAllowances.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const allowanceNames = d.pay.cashAllowances.map((a) => `${a.label} - RM ${cp22Amount(a.amount)}`).join('; ');
  // The printed total is the sum of the boxes THIS renderer filled. The blank D-lines contribute nothing
  // because we hold nothing for them — an operator who fills one must update the total, and the preview
  // screen says so. A PDF cannot recompute after it is saved.
  const total = (d.pay.salaryAndOvertime ?? 0) + allowanceTotal;
  const anyPay = d.pay.salaryAndOvertime != null || d.pay.cashAllowances.length > 0;

  return {
    employerName: d.employer.name ?? '',
    employerAddress: d.employer.addressLines.filter(Boolean).join('\n'),
    employerNo: d.employer.eNumber ?? '',
    employerPhone: d.employer.phone ?? '',

    employeeName: d.employee.fullName ?? '',
    incomeTaxNo: taxNo(d.employee.incomeTaxNo),
    icNo: d.employee.icNo ?? '',
    currentPassportNo: d.employee.passportNo ?? '',
    citizen: d.employee.citizen ?? '',
    gender: titleCase(d.employee.gender),
    dateOfBirth: dmy(d.employee.dateOfBirth),
    maritalStatus: titleCase(d.employee.maritalStatus),
    employeePhone: d.employee.phone ?? '',
    employeeEmail: d.employee.email ?? '',

    residentialAddress: d.employee.residentialAddress.lines.filter(Boolean).join('\n'),
    residentialPostcode: d.employee.residentialAddress.postcode ?? '',
    residentialTown: d.employee.residentialAddress.town ?? '',
    residentialState: d.employee.residentialAddress.state ?? '',
    correspondenceAddress: d.employee.correspondenceAddress.lines.filter(Boolean).join('\n'),
    correspondencePostcode: d.employee.correspondenceAddress.postcode ?? '',
    correspondenceTown: d.employee.correspondenceAddress.town ?? '',
    correspondenceState: d.employee.correspondenceAddress.state ?? '',

    commencementDate: dmy(d.employee.commencementDate),
    designation: d.employee.designation ?? '',
    expectedDuration: d.employee.expectedDuration ?? '',
    natureOfEmployment: d.employee.natureOfEmployment ?? '',

    spouseName: d.spouse?.fullName ?? '',
    spouseIcOrPassport: d.spouse?.icOrPassport ?? '',
    spousePhone: d.spouse?.phone ?? '',

    d1SalaryOvertime: d.pay.salaryAndOvertime == null ? '' : cp22Amount(d.pay.salaryAndOvertime),
    d4CashAllowances: d.pay.cashAllowances.length === 0 ? '' : cp22Amount(allowanceTotal),
    d4SpecifyMs: allowanceNames,
    d4SpecifyEn: allowanceNames,
    dTotal: anyPay ? cp22Amount(total) : '',

    declarantName: d.declarant.name ?? '',
    declarantIcOrPassport: d.declarant.icOrPassport ?? '',
    declarantDesignation: d.declarant.designation ?? '',
    declarationDate: dmy(d.today),
  };
}

/** pdf-lib defaults a widget to a white background and a 1pt black border; the artwork already draws the
 *  cell, so both are switched off. Passing the keys explicitly matters — pdf-lib defaults on key ABSENCE. */
const TRANSPARENT = { backgroundColor: undefined, borderColor: undefined, borderWidth: 0 } as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// FITTING A VALUE TO ITS PRINTED BOXES — the guard against silent loss on a statutory form.
//
// Everything below is derived from pdf-lib's OWN layout code (api/text/layout.ts, api/form/appearances.ts,
// api/operations.ts), not from measurement, so the line count computed here is the one it will draw:
//
//   bounds        = the widget rect inset by `padding` = 1 on every side (borderWidth is 0 here).
//   single line   = drawn whole at its natural width, and CLIPPED to bounds. No wrap, no ellipsis.
//   clip          = exactly `bounds`, so anything past the right edge is simply not there.
//
// So a single-line value is safe only when it is NARROWER than its bounds, and the only lossless way to
// make it so is to shrink the face. Width is linear in size, so a size that fits always exists.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** pdf-lib's own text-field inset (`appearances.ts`: `padding = 1` for a non-combed field). */
const WIDGET_PADDING = 1;
/** Below this the text is unreadable; a value that will not fit even here is drawn at it and clipped,
 *  which cannot happen for any real value in a 60pt-wide box and is a formality rather than a fallback. */
const MIN_FONT_SIZE = 4;
/** Small enough that the chosen size is never visibly below the largest that fits. */
const FONT_SIZE_STEP = 0.05;
/** How an address folds. A LIST folds with a semicolon — see `Cp22Field.foldWith`. */
const DEFAULT_FOLD = ', ';

/** pdf-lib's `lineSplit(cleanText(...))` (utils/strings.ts), so a block splits into the rows it will use. */
const layoutLines = (text: string): string[] =>
  text
    .replace(/[\t\u0085\u2028\u2029]/g, '    ')
    .replace(/[\b\u000b]/g, '')
    .split(/[\n\f\r\u000b]/);

/**
 * Join everything past the last printed row back INTO the last row. The tail is folded, NEVER dropped.
 *
 * THIS IS THE r175a GUARD. A four-line Malaysian address against a three-row block, or five recurring
 * allowances against a rule that holds fewer, both arrive here; without this the surplus lines have no
 * widget to be written to and vanish with nothing in any log, and the block still looks full.
 */
export function foldToRows(lines: string[], rows: number, separator: string): string[] {
  if (lines.length <= rows) return lines;
  return [...lines.slice(0, rows - 1), lines.slice(rows - 1).join(separator)];
}

/**
 * The largest size at or below `maxSize` at which `value` fits inside `rect` on ONE line.
 *
 * Exported because test/cp22-fields.test.ts and test/cp22-pdf.test.ts both assert against it: the whole
 * point is that no value is ever cut, so "what size did it choose" is the observable that proves it.
 */
export function fitSingleLine(value: string, rect: Cp22Rect, maxSize: number, font: PDFFont): number {
  const maxWidth = rect.width - WIDGET_PADDING * 2;
  if (!value) return maxSize;
  for (let size = maxSize; size >= MIN_FONT_SIZE; size = Math.round((size - FONT_SIZE_STEP) * 100) / 100) {
    if (font.widthOfTextAtSize(value, size) <= maxWidth) return size;
  }
  return MIN_FONT_SIZE;
}

export type Cp22RowFit = {
  /** One entry per printed row, in order. Never longer than the block's `rows`, never missing input. */
  rows: { text: string; rect: Cp22Rect; fontSize: number }[];
};

/**
 * Lay a field's value out over its printed row(s): fold the overflow into the last row, then choose a size
 * per row that fits it whole.
 *
 * ONE SIZE FOR THE WHOLE BLOCK, not per row — an address whose second line came out two points smaller
 * than its first reads as a rendering fault. The block takes the smallest size any of its rows needs.
 */
export function fitBlock(value: string, field: Cp22Field, font: PDFFont): Cp22RowFit {
  const rects = cp22Widgets(field);
  const maxSize = field.fontSize ?? CP22_DEFAULT_FONT_SIZE;
  const folded = foldToRows(layoutLines(safe(value)), rects.length, field.foldWith ?? DEFAULT_FOLD);
  const size = Math.min(
    ...rects.map((rect, i) => fitSingleLine(folded[i] ?? '', rect, maxSize, font)),
  );
  return { rows: rects.map((rect, i) => ({ text: folded[i] ?? '', rect, fontSize: size })) };
}

function addField(
  form: ReturnType<PDFDocument['getForm']>,
  page: PDFPage,
  f: Cp22Field,
  value: string,
  font: PDFFont,
  namePrefix: string,
) {
  if (f.type === 'checkbox') {
    // Created but never ticked: only the operator knows whether the correspondence address is an agent's.
    form.createCheckBox(namePrefix + f.name).addToPage(page, { ...f.rect, ...TRANSPARENT });
    return;
  }
  // Measured BEFORE the /DA is written, because the fit is what decides the size. Both halves have to
  // reach the file — the size through /DA and the text through /V — or a viewer regenerating the
  // appearance (which is every viewer, once NeedAppearances is set) would lay out something we never
  // checked. This is the half the 2020 renderer got right for multiline blocks and never did for
  // single-line boxes, which is why a long name was being clipped in production.
  const fit = fitBlock(value, f, font);
  fit.rows.forEach((row, i) => {
    const field = form.createTextField(namePrefix + cp22RowName(f.name, i));
    // The point size goes in via the /DA string rather than `setFontSize`, which THROWS on a field that
    // has no /DA yet — and a field pdf-lib has only just created has none. `updateFieldAppearances` reads
    // the size back out of this /DA (a missing one means "auto-size to the box", which on a 20pt statutory
    // cell is not what anyone wants) and rewrites it with the embedded font's real name.
    field.acroField.setDefaultAppearance(`/${font.name} ${row.fontSize} Tf 0 g`);
    if (f.alignRight) field.setAlignment(TextAlignment.Right);
    if (row.text) field.setText(row.text);
    field.addToPage(page, { ...row.rect, ...TRANSPARENT, font });
  });
}

/**
 * Lay every widget over ONE already-drawn CP22 — both its pages.
 *
 * `namePrefix` is empty for the single-person document (its field names are part of that file's contract:
 * the tests address them by name, and so does an operator's PDF viewer) and is a per-record prefix in a
 * batch. See `renderCp22Batch` for why the prefix is not optional there.
 */
function buildCp22Pages(
  pages: PDFPage[],
  form: ReturnType<PDFDocument['getForm']>,
  font: PDFFont,
  values: Record<string, string>,
  namePrefix: string,
) {
  for (const f of CP22_FIELDS) {
    const page = pages[f.page];
    // A field whose page does not exist means the artwork and the map have drifted, which is a broken
    // document, not a field to skip quietly.
    if (!page) throw new Error(`CP22 template has no page ${f.page} for field ${f.code}`);
    addField(form, page, f, values[f.name] ?? '', font, namePrefix);
  }
}

/**
 * The three things that must be true of the FINISHED document, whatever produced it — set once, after
 * every page and every widget exists. Doing any of them per page would either be wasted work or (for /DR
 * and NeedAppearances, which live on the one AcroForm dictionary) simply be overwritten.
 */
function finishCp22Form(doc: PDFDocument, form: ReturnType<PDFDocument['getForm']>, font: PDFFont) {
  // (1) of the five — see the file header. Both halves are needed: the appearance streams are what most
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
}

/**
 * Render a fillable CP22 over the bundled two-page template.
 *
 * @param template the bytes of public/forms/cp22-pin-1-2021.pdf (the caller reads the file; this stays pure)
 * @param data     the particulars to pre-fill, or `null` for the completely blank fillable copy
 */
export async function renderCp22Pdf(template: Uint8Array, data: Cp22PdfData | null): Promise<Uint8Array> {
  const doc = await PDFDocument.load(template);
  const pages = doc.getPages();
  // The template ships with NO /AcroForm; getForm creates one. Every widget below is added to it.
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const values = data ? cp22FieldValues(data) : {};

  // UNPREFIXED, and that is part of this file's contract: one person, two pages, the names in
  // lib/cp22-fields.ts exactly as an operator's viewer shows them.
  buildCp22Pages(pages, form, font, values, '');
  finishCp22Form(doc, form, font);

  // NEVER form.flatten(): every box, including the filled ones, stays typeable in the downloaded file.
  // `updateFieldAppearances: false` because the call above already did it WITH our embedded font; letting
  // save() redo it would fall back to its own default.
  return doc.save({ updateFieldAppearances: false });
}

/** The AcroForm name prefix for the n-th record of a batch (0-based). See `renderCp22Batch`. */
export const cp22BatchPrefix = (index: number): string => `p${index + 1}_`;

/**
 * One document, TWO PAGES PER JOINER, in the order given — every box on every page still editable.
 *
 * NOT A LOOP AROUND `renderCp22Pdf`. Three things break if it is written the obvious way, and each of them
 * produces a file that opens, prints and passes every green check while being wrong:
 *
 * 1. ACROFORM FIELD NAMES ARE DOCUMENT-GLOBAL, NOT PER PAGE. Two widgets called `employeeName` are ONE
 *    field with two appearances: type into joiner 3's name box and joiner 1's changes too, and pdf-lib's
 *    own `createTextField` throws on the second. So every record's widgets carry `p<n>_`
 *    (`cp22BatchPrefix`) and the records are genuinely independent. The prefix is a NAME change only —
 *    the geometry, row folding and fitting all key off `Cp22Field`, which is untouched.
 * 2. THE ARTWORK IS EMBEDDED ONCE PER PAGE. `embedPage` turns each of LHDN's two pages into a Form XObject
 *    that every copy draws; `copyPages` per joiner would duplicate all 172 KB of it per person. The page
 *    size comes from the embedded pages themselves rather than any constant, so the batch cannot drift
 *    from the artwork on disk.
 * 3. NeedAppearances, /DR and `updateFieldAppearances` HAPPEN ONCE, AFTER ALL PAGES EXIST — see
 *    `finishCp22Form`. Per record, the AcroForm-level entries would just be rewritten, and the appearance
 *    pass would run N times over a growing form for no benefit.
 *
 * And, as everywhere in this file: NEVER `form.flatten()`.
 *
 * @param records one per joiner, already ordered by the caller (the screen's list order)
 */
export async function renderCp22Batch(template: Uint8Array, records: Cp22PdfData[]): Promise<Uint8Array> {
  // A zero-page PDF is not a valid document and is not a useful answer. The route answers 404 for a month
  // with no joiners; this throw is what stops any other caller quietly producing a broken file.
  if (records.length === 0) throw new Error('renderCp22Batch: no records — a month with no joiners has no document');

  const source = await PDFDocument.load(template);
  const doc = await PDFDocument.create();
  const sourcePages = source.getPages();
  const sizes = sourcePages.map((p) => p.getSize());
  const artwork = await doc.embedPages(sourcePages);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const [i, record] of records.entries()) {
    const pages = artwork.map((art, pageIndex) => {
      const { width, height } = sizes[pageIndex];
      const page = doc.addPage([width, height]);
      page.drawPage(art, { x: 0, y: 0, width, height });
      return page;
    });
    buildCp22Pages(pages, form, font, cp22FieldValues(record), cp22BatchPrefix(i));
  }

  finishCp22Form(doc, form, font);
  return doc.save({ updateFieldAppearances: false });
}
