/**
 * CP22 (Pin. 1/2020) — overlay LHDN's official page with a fillable AcroForm and pre-fill what we hold.
 *
 * THIS IS NOT A DRAWN DOCUMENT. lib/ea-pdf.ts, lib/payslip-pdf.ts and lib/review-letter-pdf.ts all draw an
 * A4 from scratch; this is the tree's FIRST `PDFDocument.load`, first `getForm` and first `createTextField`.
 * What downloads is LHDN's own artwork — same layout, same wording, same Malay and English — with 33 typing
 * boxes added ON TOP of it at the coordinates in lib/cp22-fields.ts. The template bytes are never modified;
 * they are loaded, widgets are added, and a COPY is saved.
 *
 * FOUR THINGS THIS FILE MUST KEEP DOING, EACH OF WHICH FAILS SILENTLY IF DROPPED:
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
 *
 * 4. EVERY LINE OF A MULTI-ROW BLOCK IS DRAWN. pdf-lib lays a multiline field out downwards from the top
 *    of the widget rect and the appearance is clipped to it, so a line past the bottom is not drawn at all
 *    and the line sitting on the floor loses everything below its baseline — in both cases with nothing in
 *    any log. A four-entry address and a four-allowance payroll are both ordinary here, and both lost a
 *    line: an address short of its state, and box (b) short of an allowance, understating the remuneration
 *    declared to LHDN. `fitMultilineValue` below folds and, only if it must, shrinks the value so it
 *    cannot be laid out past the block's last row. It is checked by RENDERING: a green suite, a 200 and
 *    even one of the two PDF renderers all reported this page as correct while it was wrong.
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// FITTING A VALUE TO A MULTI-ROW BLOCK — the guard against silent loss on a statutory form.
//
// pdf-lib lays a multiline field out from the TOP of the widget rect downwards and clips to the rect, and
// it does BOTH WITHOUT COMPLAINT: a line whose baseline falls under the rect is simply never drawn, and a
// line sitting on the rect's floor loses everything below its baseline. Two ordinary Malaysian shapes hit
// it — a four-entry address (line1/line2/line3/"postcode city, state"), and a payroll with four recurring
// allowances against a three-row box — and the page looks complete in both cases.
//
// THE TWO RENDERERS DISAGREE, WHICH IS HOW IT WAS FOUND AND WHY THE FIX GOES WHERE IT DOES. Probed with a
// marker stream: MuPDF draws the EMBEDDED appearance (so it showed the damage), while Poppler regenerates
// from /V and /DA because NeedAppearances is set, lays the lines out slightly higher, and drew the same
// four-line address whole. "It looks fine in one renderer" is therefore not evidence. So the fit is
// computed HERE, up front, from the same font metrics pdf-lib uses, and it is carried by the /DA size and
// the /V text — the two things BOTH kinds of renderer read — rather than by the stream alone.
//
// The ceiling is `rows`, not "whatever the height allows": the block is a set of PRINTED ruled rows and a
// line laid between two rules is struck through by one. The order is FOLD, then SHRINK, because shrinking
// alone cannot help — the overflow is explicit newlines, and no font size turns five lines into four.
// NOTHING IS EVER DROPPED OR TRUNCATED: an address that will not fit comes out smaller, or with its last
// two lines joined, and is still complete. That is the right trade on a legal declaration.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** pdf-lib's own text-field inset (appearances.ts: `padding = 1` for a non-combed field), and its clip floor. */
const WIDGET_PADDING = 1;
/** pdf-lib's own line pitch: `heightAtSize(size) * 1.2` (layout.ts). */
const LINE_HEIGHT_FACTOR = 1.2;
/** pdf-lib's own floor for auto-sizing. Below it we also start breaking over-wide runs. */
const PDFLIB_MIN_FONT_SIZE = 4;
/** Small enough that the chosen size is never visibly below the largest that fits. */
const FONT_SIZE_STEP = 0.05;
/** How an address folds. A LIST folds with a semicolon — see `Cp22Field.foldWith`. */
const DEFAULT_FOLD = ', ';

/** pdf-lib's `lineSplit(cleanText(...))` (utils/strings.ts), so the line count here is the one it will use. */
const layoutLines = (text: string): string[] =>
  text
    .replace(/[\t\u0085\u2028\u2029]/g, '    ')
    .replace(/[\b\u000b]/g, '')
    .split(/[\n\f\r\u000b]/);

/** pdf-lib's `lastIndexOfWhitespace` — note it never inspects index 0, which is why a leading space stays. */
function lastWhitespaceIndex(line: string): number | undefined {
  for (let idx = line.length; idx > 0; idx--) if (/\s/.test(line[idx])) return idx;
  return undefined;
}

/**
 * pdf-lib's `splitOutLines`, replicated exactly — including the STRICT `width < maxWidth` and the fact
 * that an unbreakable run comes back whole and over-wide rather than being cut.
 *
 * `hardBreak` is ours and is off until the size ladder is under pdf-lib's own minimum: it breaks such a
 * run on a character boundary so the value still cannot run out of the box sideways.
 */
function splitOutLine(input: string, maxWidth: number, font: PDFFont, size: number, hardBreak: boolean) {
  let idx = input.length;
  while (idx > 0) {
    const line = input.substring(0, idx);
    if (font.widthOfTextAtSize(line, size) < maxWidth) {
      return { line, remainder: input.substring(idx) || undefined };
    }
    idx = lastWhitespaceIndex(line) ?? 0;
  }
  if (!hardBreak) return { line: input, remainder: undefined };
  let cut = 1;
  while (cut < input.length && font.widthOfTextAtSize(input.substring(0, cut + 1), size) < maxWidth) cut++;
  return { line: input.substring(0, cut), remainder: input.substring(cut) || undefined };
}

/** The lines pdf-lib will actually draw for `text` in a box `maxWidth` wide at `size`. */
function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number, hardBreak = false): string[] {
  const out: string[] = [];
  for (const logical of layoutLines(text)) {
    let rest: string | undefined = logical;
    while (rest !== undefined) {
      const { line, remainder } = splitOutLine(rest, maxWidth, font, size, hardBreak);
      out.push(line);
      // pdf-lib trims only what IT split off, and a remainder that trims to '' still costs a line.
      rest = remainder === undefined ? undefined : remainder.trim();
    }
  }
  return out;
}

/**
 * How many lines of `size` fit inside `rect` with their DESCENDERS clear of pdf-lib's clip floor.
 *
 * baseline_n = padding + inner − n × pitch, and the clip starts at `padding`; a line is only whole when
 * baseline_n − descender is still at or above it. Exported because test/cp22-fields.test.ts asserts this
 * against every block's declared `rows` — that assertion IS the headroom, and it is what stops a future
 * block being added one line short.
 */
export function cp22FittingLineCount(
  rect: { height: number },
  size: number,
  font: PDFFont,
): number {
  const inner = rect.height - WIDGET_PADDING * 2;
  const pitch = font.heightAtSize(size) * LINE_HEIGHT_FACTOR;
  const descender = font.heightAtSize(size) - font.heightAtSize(size, { descender: false });
  return Math.floor((inner - descender) / pitch);
}

/** Join everything past the last row back INTO the last row. The tail is folded, never dropped. */
function foldToRows(lines: string[], rows: number, separator: string): string[] {
  if (lines.length <= rows) return lines;
  return [...lines.slice(0, rows - 1), lines.slice(rows - 1).join(separator)];
}

export type Cp22MultilineFit = {
  /** What goes in /V — folded if the value had more lines than the block has rows. */
  text: string;
  /** What goes in /DA, and therefore what both the embedded appearance and a regenerating viewer use. */
  fontSize: number;
  /** The lines that will be drawn. Never longer than `rows`, and never missing any of the input. */
  lines: string[];
};

/**
 * Fit `value` to a multiline block: fold its overflow into the last row, then take the largest size at or
 * below the block's own that lays it out in no more lines than the block has rows, all of them whole.
 *
 * The ladder terminates. Below pdf-lib's minimum size the wrap also breaks over-wide runs, so the drawn
 * line count converges on the folded line count (≤ rows) while the number of lines the box can hold grows
 * without bound as the size falls — there is always a size that fits, and the loop returns at the first
 * (largest) one. The 1pt floor is a formality, not a fallback anything real reaches.
 */
export function fitMultilineValue(value: string, field: Cp22Field, font: PDFFont): Cp22MultilineFit {
  const rows = field.rows ?? cp22FittingLineCount(field.rect, field.fontSize ?? CP22_DEFAULT_FONT_SIZE, font);
  const maxWidth = field.rect.width - WIDGET_PADDING * 2;
  const maxSize = field.fontSize ?? CP22_DEFAULT_FONT_SIZE;
  const folded = foldToRows(layoutLines(value), Math.max(rows, 1), field.foldWith ?? DEFAULT_FOLD);
  const text = folded.join('\n');

  let last: Cp22MultilineFit = { text, fontSize: maxSize, lines: folded };
  for (let size = maxSize; size >= 1; size = Math.round((size - FONT_SIZE_STEP) * 100) / 100) {
    const hardBreak = size < PDFLIB_MIN_FONT_SIZE;
    const lines = wrapLines(text, font, size, maxWidth, hardBreak);
    // Hard-broken lines are only real if the reader sees them broken there, so they become the value.
    last = { text: hardBreak ? lines.join('\n') : text, fontSize: size, lines };
    if (lines.length <= rows && lines.length <= cp22FittingLineCount(field.rect, size, font)) return last;
  }
  return last;
}

function addField(
  form: ReturnType<PDFDocument['getForm']>,
  page: PDFPage,
  f: Cp22Field,
  value: string,
  font: PDFFont,
  namePrefix: string,
) {
  const opts = { ...f.rect, ...TRANSPARENT, font };
  if (f.type === 'checkbox') {
    // Created but never ticked: only the operator knows whether the correspondence address is a tax agent's.
    form.createCheckBox(namePrefix + f.name).addToPage(page, opts);
    return;
  }
  const field = form.createTextField(namePrefix + f.name);
  // A multi-row block is measured BEFORE its /DA is written, because the fit is what decides the size: a
  // value with more lines than the block has rows, or a line too wide for the box, comes back folded and
  // (only if it must) smaller. Both halves have to reach the file — the size through /DA and the folded
  // text through /V — or a viewer regenerating the appearance would lay out something we never checked.
  const sized = f.type === 'multiline' ? fitMultilineValue(safe(value), f, font) : null;
  // The point size goes in via the /DA string rather than `setFontSize`, which THROWS on a field that has
  // no /DA yet — and a field pdf-lib has only just created has none. `updateFieldAppearances` reads the size
  // back out of this /DA (a missing one means "auto-size to the box", which on an 11.5pt statutory cell is
  // not what anyone wants) and rewrites it with the embedded font's real name.
  field.acroField.setDefaultAppearance(
    `/${font.name} ${sized?.fontSize ?? f.fontSize ?? CP22_DEFAULT_FONT_SIZE} Tf 0 g`,
  );
  if (f.type === 'multiline') field.enableMultiline();
  if (f.type === 'comb' && f.maxLen) {
    // Order matters: pdf-lib refuses to comb a field with no maxLength, and combing is what puts one glyph
    // per PRINTED cell instead of a run of text lying across the cell borders.
    field.setMaxLength(f.maxLen);
    field.enableCombing();
  }
  const text = sized ? sized.text : safe(value);
  if (text) field.setText(f.maxLen ? text.slice(0, f.maxLen) : text);
  field.addToPage(page, opts);
}

/**
 * Lay the 33 widgets over ONE already-drawn CP22 page.
 *
 * `namePrefix` is empty for the single-person document — its field names are part of that file's contract
 * (test/cp22-pdf.test.ts and test/cp22-fields.test.ts address them by name, and so does an operator's PDF
 * viewer) — and is a per-record prefix in a batch. See `renderCp22Batch` for why the prefix is not optional
 * there.
 */
function buildCp22Page(
  page: PDFPage,
  form: ReturnType<PDFDocument['getForm']>,
  font: PDFFont,
  values: Record<string, string>,
  namePrefix: string,
) {
  for (const f of CP22_FIELDS) addField(form, page, f, values[f.name] ?? '', font, namePrefix);
}

/**
 * The three things that must be true of the FINISHED document, whatever produced it — set once, after every
 * page and every widget exists. Doing any of them per page would either be wasted work or (for /DR and
 * NeedAppearances, which live on the one AcroForm dictionary) simply be overwritten.
 */
function finishCp22Form(doc: PDFDocument, form: ReturnType<PDFDocument['getForm']>, font: PDFFont) {
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

  // UNPREFIXED, and that is part of this file's contract: one person, one page, the names in
  // lib/cp22-fields.ts exactly as an operator's viewer shows them.
  buildCp22Page(page, form, font, values, '');
  finishCp22Form(doc, form, font);

  // NEVER form.flatten(): every box, including the 26 filled ones, stays typeable in the downloaded file.
  // `updateFieldAppearances: false` because the call above already did it WITH our embedded font; letting
  // save() redo it would fall back to its own default.
  return doc.save({ updateFieldAppearances: false });
}

/** What the operator typed on the screen, stamped onto every page of a batch. */
export type Cp22BatchOptions = {
  /**
   * The LHDN branch they file with — box 1, which has no answer in the schema and is therefore normally an
   * empty editable box. This is OPERATOR INPUT travelling with the request, not a value this code invented,
   * which is why stamping it does not breach the never-invent rule. Null/blank leaves box 1 empty, exactly
   * as the single-person document does.
   */
  lhdnBranch?: string | null;
};

/** The AcroForm name prefix for the n-th page of a batch (0-based). See `renderCp22Batch`. */
export const cp22BatchPrefix = (index: number): string => `p${index + 1}_`;

/**
 * One document, one page per joiner, in the order given — every box on every page still editable.
 *
 * NOT A LOOP AROUND `renderCp22Pdf`. Three things break if it is written the obvious way, and each of them
 * produces a file that opens, prints and passes every green check while being wrong:
 *
 * 1. ACROFORM FIELD NAMES ARE DOCUMENT-GLOBAL, NOT PER PAGE. Two widgets called `employeeFullName` are ONE
 *    field with two appearances: type into page 3's name box and page 1's changes too, and pdf-lib's own
 *    `createTextField` throws on the second. So every page's widgets carry `p<n>_` (`cp22BatchPrefix`) and
 *    the pages are genuinely independent. The prefix is a NAME change only — the comb, multiline and maxLen
 *    handling all key off `Cp22Field`, which is untouched.
 * 2. THE ARTWORK IS EMBEDDED ONCE. `embedPage` turns LHDN's page into a single Form XObject that each page
 *    draws; `copyPages` per joiner would duplicate all 153 KB of it per person (a 38-page file ≈ 5.8 MB for
 *    nothing). The page size comes from the embedded page itself rather than any constant, so the batch
 *    cannot drift from the artwork on disk.
 * 3. NeedAppearances, /DR and `updateFieldAppearances` HAPPEN ONCE, AFTER ALL PAGES EXIST — see
 *    `finishCp22Form`. Per page, the AcroForm-level entries would just be rewritten, and the appearance
 *    pass would run N times over a growing form for no benefit.
 *
 * And, as everywhere in this file: NEVER `form.flatten()`.
 *
 * @param records one per page, already ordered by the caller (the screen's list order)
 */
export async function renderCp22Batch(
  template: Uint8Array,
  records: Cp22PdfData[],
  opts: Cp22BatchOptions = {},
): Promise<Uint8Array> {
  // A zero-page PDF is not a valid document and is not a useful answer. The route answers 404 for a month
  // with no joiners; this throw is what stops any other caller quietly producing a broken file.
  if (records.length === 0) throw new Error('renderCp22Batch: no records — a month with no joiners has no document');

  const source = await PDFDocument.load(template);
  const doc = await PDFDocument.create();
  const templatePage = source.getPages()[0];
  const { width, height } = templatePage.getSize();
  const artwork = await doc.embedPage(templatePage);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const branch = (opts.lhdnBranch ?? '').trim();

  records.forEach((record, i) => {
    const page = doc.addPage([width, height]);
    page.drawPage(artwork, { x: 0, y: 0, width, height });
    const values = cp22FieldValues(record);
    // Box 1 is `prefilled: false` — it stays empty unless the operator typed a branch, and then it is
    // THEIR text on every page rather than an empty box on every page.
    if (branch) values.lhdnBranchAddress = branch;
    buildCp22Page(page, form, font, values, cp22BatchPrefix(i));
  });

  finishCp22Form(doc, form, font);
  return doc.save({ updateFieldAppearances: false });
}
