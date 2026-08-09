/**
 * d3a9383c — the CP22 renderer, and the three properties of the downloaded file that FAIL SILENTLY.
 *
 * Everything about this document can be broken while tsc, `next build` and the whole suite stay green, and
 * the only symptom is what an operator sees when they open the file. So these are the assertions:
 *
 *   1. THE APPEARANCE TRAP. pdf-lib writes appearance streams only when asked. Drop the embedded font, the
 *      explicit `updateFieldAppearances(font)` or `NeedAppearances`, and the boxes come back BLANK or
 *      unstyled in real viewers — with nothing in any log. `drawnText` below inflates every stream in the
 *      produced file and reads back the show-text operands, so "the value reached the page" is a fact here
 *      rather than an inference from "the field exists".
 *   2. IT MUST NOT BE FLATTENED. Every box, including the 26 filled ones, stays typeable: the operator
 *      completes the remaining seven and corrects anything wrong before signing. A flattened form has zero
 *      fields and looks perfect in a screenshot.
 *   3. AN ABSENT RECORD IS AN EMPTY BOX, NEVER A GUESS AND NEVER A CRASH. No spouse, no Malaysian tax
 *      identity row, no signatory — each yields a blank editable box.
 *
 * The template itself is checked too: it must still parse, still be one A4-ish page, and still carry ZERO
 * pre-existing form fields, because every rect in lib/cp22-fields.ts was measured against that exact file.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import { CP22_DEFAULT_FONT_SIZE, CP22_FIELDS, type Cp22Field } from '../lib/cp22-fields';
import {
  cp22BatchPrefix,
  cp22FieldValues,
  cp22FittingLineCount,
  ddmmyyyy,
  dmy,
  fitMultilineValue,
  renderCp22Batch,
  renderCp22Pdf,
  splitMyPhone,
  taxNoComb,
  type Cp22PdfData,
} from '../lib/cp22-pdf';

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'public', 'forms', 'cp22-pin-1-2020.pdf');
const template = () => new Uint8Array(fs.readFileSync(TEMPLATE_PATH));

/** Source with its PROSE removed, for the assertions that say "this file must not contain X". */
const code = (p: string) =>
  fs
    .readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * The text actually DRAWN into the file, recovered from every stream in it — the technique
 * test/payslip-pdf.test.ts uses, and the only way to tell "the field carries a value" from "a viewer will
 * show that value". A field can hold /V and draw nothing.
 */
function drawnText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    const e = buf.indexOf('endstream', s);
    if (e < 0) break;
    let b = s + 6;
    if (buf[b] === 0x0d) b += 1;
    if (buf[b] === 0x0a) b += 1;
    const raw = buf.subarray(b, e);
    let body: Buffer;
    try {
      body = zlib.inflateSync(raw);
    } catch {
      body = raw;
    }
    out.push(body.toString('latin1'));
    i = e + 9;
  }
  return [...out.join('\n').matchAll(/(?:<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\))\s*Tj/g)]
    .map((m) =>
      m[1] != null
        ? Buffer.from(m[1].replace(/\s+/g, ''), 'hex').toString('latin1')
        : m[2].replace(/\\([()\\])/g, '$1'),
    )
    .join('\n');
}

/**
 * The lines pdf-lib actually DREW into ONE field's appearance, and the baseline it drew each of them at.
 *
 * `drawnText` above answers "is this string on the page anywhere". That was not enough: a line can be on
 * the page and still be sliced in half by the widget's own clip, and a line can be missing while every
 * OTHER line of the same address is present, so a page full of correct-looking text hides it. This reads
 * the widget's /AP /N stream — `… x y Tm <hex> Tj` per line, in widget-local coordinates, which is exactly
 * the space pdf-lib's clip (`padding` 1pt in from the rect) is expressed in.
 */
function appearanceLines(doc: PDFDocument, name: string) {
  const [widget] = doc.getForm().getTextField(name).acroField.getWidgets();
  const ap = widget.getNormalAppearance();
  const stream = ap instanceof PDFRef ? doc.context.lookup(ap) : ap;
  const body = Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString('latin1');
  const size = Number(/\/[^\s/]+\s+([\d.]+)\s+Tf/.exec(body)?.[1] ?? 0);
  const lines = [...body.matchAll(/([\d.-]+)\s+([\d.-]+)\s+Tm\s*<([0-9A-Fa-f\s]*)>\s*Tj/g)].map((m) => ({
    y: Number(m[2]),
    text: Buffer.from(m[3].replace(/\s+/g, ''), 'hex').toString('latin1'),
  }));
  return { size, lines };
}

/**
 * Assert a block's drawn lines are all whole. pdf-lib's appearance is a Form XObject whose /BBox is the
 * widget rect, with a clip path 1pt further in; a baseline less than one descender above that inner floor
 * is a row with its descenders cut off (which is exactly what "the box looks full and correct" looked
 * like), and a baseline below the floor is a row that was never drawn. The inner floor is the strictest of
 * the floors the real renderers apply, so clearing it clears all of them.
 */
function expectInsideTheClip(f: Cp22Field, drawn: { size: number; lines: { y: number; text: string }[] }) {
  const ascender = drawn.size * 0.718; // Helvetica AFM, /1000
  const descender = drawn.size * 0.207;
  for (const line of drawn.lines) {
    expect(line.y - descender, `${f.name}: "${line.text}" is sliced at the baseline by the widget clip`)
      .toBeGreaterThanOrEqual(1);
    expect(line.y + ascender, `${f.name}: "${line.text}" is cut off at the top of the widget`)
      .toBeLessThanOrEqual(f.rect.height - 1);
  }
}

const data: Cp22PdfData = {
  employer: {
    name: 'Acme Sdn Bhd',
    addressLines: ['No. 12, Jalan Damai 3', 'Taman Damai', '43000 Kajang, Selangor'],
    eNumber: 'E 1234567890',
    phone: '03-87381234',
  },
  employee: {
    fullName: 'Nur Aisyah binti Rahman',
    natureOfEmployment: 'Site Supervisor',
    commencementDate: '2026-07-02',
    expectedDuration: 'Permanent',
    residentialAddressLines: ['No. 8, Jalan Melur 2/3', 'Taman Melur', '68000 Ampang, Selangor'],
    correspondenceAddressLines: ['No. 8, Jalan Melur 2/3', 'Taman Melur', '68000 Ampang, Selangor'],
    phone: '012-3456789',
    email: 'aisyah@example.test',
    incomeTaxNo: 'SG12345678901',
    icNo: '900101-10-1234',
    passportNo: 'A12345678',
    gender: 'female',
    citizen: 'Malaysian',
    dateOfBirth: '1990-01-01',
    maritalStatus: 'married',
  },
  spouse: { fullName: 'Ahmad bin Ismail', icOrPassport: '880202-10-5678' },
  pay: { monthlyFixedRemuneration: 6500, allowances: [{ label: 'Transport allowance', amount: 300 }] },
  signatory: { name: 'Tan Wei Ming', designation: 'HR Manager' },
  today: '2026-08-09',
};

/** Same joiner, with every optional record missing — the "nothing on file" shape. */
const bare: Cp22PdfData = {
  employer: { name: 'Acme Sdn Bhd', addressLines: [], eNumber: null, phone: null },
  employee: {
    fullName: 'Nur Aisyah binti Rahman',
    natureOfEmployment: null,
    commencementDate: null,
    expectedDuration: 'Permanent',
    residentialAddressLines: [],
    correspondenceAddressLines: [],
    phone: null,
    email: null,
    incomeTaxNo: null,
    icNo: null,
    passportNo: null,
    gender: null,
    citizen: null,
    dateOfBirth: null,
    maritalStatus: null,
  },
  spouse: null,
  pay: { monthlyFixedRemuneration: null, allowances: [] },
  signatory: { name: null, designation: null },
  today: '2026-08-09',
};

const reload = (bytes: Uint8Array) => PDFDocument.load(bytes);

describe('CP22 — the bundled LHDN template', () => {
  it('still parses, is one page, and carries ZERO pre-existing form fields', async () => {
    const doc = await PDFDocument.load(template());
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPages()[0].getSize();
    expect(width).toBeCloseTo(595.44, 2);
    expect(height).toBeCloseTo(841.68, 2);
    // Every rect in lib/cp22-fields.ts was measured against THIS file. If the template ever gains its own
    // AcroForm, the overlay would be added on top of somebody else's widgets.
    expect(doc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
  });

  it('is read through the one helper, not by a path inlined at each call site', () => {
    const helper = fs.readFileSync(path.join(ROOT, 'lib', 'cp22-template.ts'), 'utf8');
    expect(helper).toContain("'forms', 'cp22-pin-1-2020.pdf'");
    for (const f of [
      'app/payroll/cp22/[employmentId]/pdf/route.ts',
      'app/payroll/cp22/blank/route.ts',
      // db46d9a2 — the batch renders the SAME artwork through the SAME helper. A third route with its own
      // path would be the second place to edit when the asset moves.
      'app/payroll/cp22/batch/route.ts',
    ]) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, `${f} must go through readCp22Template`).toContain('readCp22Template');
      expect(src, `${f} must not inline the asset path`).not.toContain('cp22-pin-1-2020.pdf');
    }
  });
});

describe('CP22 renderer — the produced file', () => {
  it('renders a real PDF carrying all 33 fields, by the map’s own names and kinds', async () => {
    const bytes = await renderCp22Pdf(template(), data);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const form = (await reload(bytes)).getForm();
    expect(form.getFields()).toHaveLength(33);
    for (const f of CP22_FIELDS) {
      const found = form.getFieldMaybe(f.name);
      expect(found, `${f.name} (box ${f.box}) must exist on the page`).toBeDefined();
      expect(found!.constructor.name).toBe(f.type === 'checkbox' ? 'PDFCheckBox' : 'PDFTextField');
    }
  });

  /** 1 — THE APPEARANCE TRAP. Not "the field holds a value": the value is DRAWN. */
  it('draws every pre-filled value into an appearance stream, not just into /V', async () => {
    const drawn = drawnText(await renderCp22Pdf(template(), data));
    expect(drawn).toContain('Nur Aisyah binti Rahman');
    expect(drawn).toContain('Site Supervisor');
    expect(drawn).toContain('Acme Sdn Bhd');
    expect(drawn).toContain('E 1234567890');
    expect(drawn).toContain('aisyah@example.test');
    expect(drawn).toContain('Ahmad bin Ismail');
    expect(drawn).toContain('6,500.00');
    expect(drawn).toContain('Tan Wei Ming');
    expect(drawn).toContain('HR Manager');
    expect(drawn).toContain('09/08/2026');
  });

  it('sets NeedAppearances, so a viewer regenerates the boxes after the operator edits one', async () => {
    const doc = await reload(await renderCp22Pdf(template(), data));
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
    // …and /DR names a font for that regeneration to use. pdf-lib does not maintain it.
    expect(acro.lookupMaybe(PDFName.of('DR'), PDFDict)?.lookupMaybe(PDFName.of('Font'), PDFDict)).toBeDefined();
  });

  /** 2 — UNFLATTENED. A flattened form renders identically and is completely uneditable. */
  it('leaves the form editable — 33 live fields, including the 26 that arrive filled', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    expect(form.getFields()).toHaveLength(33);
    expect(form.getTextField('employeeFullName').getText()).toBe('Nur Aisyah binti Rahman');
    // The renderer must never gain a flatten() call: it would satisfy every other assertion here.
    // Read as CODE — the file documents the ban in prose, and scanning the prose would fail the test that
    // the explanation exists to reinforce (the house convention in test/statutory-forms-page.test.ts).
    expect(code(path.join(ROOT, 'lib', 'cp22-pdf.ts'))).not.toContain('.flatten(');
  });

  it('combs the character-cell rows, with the printed cell count as MaxLen', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    for (const f of CP22_FIELDS.filter((x) => x.type === 'comb')) {
      const field = form.getTextField(f.name);
      expect(field.getMaxLength(), `${f.name} MaxLen`).toBe(f.maxLen);
      expect(field.isCombed(), `${f.name} must be combed onto its printed cells`).toBe(true);
    }
    // The gap cell of the income-tax row holds a space, so the digits land on printed cells.
    expect(form.getTextField('incomeTaxNo').getText()).toBe('SG 12345678901');
  });

  it('gives the address blocks a wrapping field and the tick box no tick', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    expect(form.getTextField('residentialAddress').isMultiline()).toBe(true);
    expect(form.getTextField('correspondenceAddress').isMultiline()).toBe(true);
    // Only the operator knows whether the correspondence address belongs to a tax agent.
    expect(form.getCheckBox('correspondenceIsTaxAgent').isChecked()).toBe(false);
  });

  /** 3 — the seven, plus every optional record, as EMPTY editable boxes. */
  it('leaves the seven unanswerable boxes empty while keeping them typeable', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    for (const name of [
      'lhdnBranchAddress',
      'previousPassportNo',
      'spouseIncomeTaxNo',
      'fluctuatingEmoluments',
      'previousEmployerInMalaysia',
      'employerSignature',
    ]) {
      expect(form.getTextField(name).getText(), `${name} must never be invented`).toBeUndefined();
      expect(form.getTextField(name).isReadOnly(), `${name} must stay typeable`).toBe(false);
    }
  });

  it('renders a joiner with nothing on file as empty boxes rather than throwing', async () => {
    const bytes = await renderCp22Pdf(template(), bare);
    const form = (await reload(bytes)).getForm();
    expect(form.getFields()).toHaveLength(33);
    expect(form.getTextField('employeeFullName').getText()).toBe('Nur Aisyah binti Rahman');
    for (const name of [
      'spouseFullName', // no spouse on the family register
      'spouseIcOrPassport',
      'incomeTaxNo', // no employee_statutory_my row
      'icNo',
      'currentPassportNo',
      'signatoryName', // a session with no person, or a person with no assignment
      'signatoryDesignation',
      'monthlyFixedRemuneration', // no compensation row
    ]) {
      expect(form.getTextField(name).getText(), `${name} must be empty, not guessed`).toBeUndefined();
    }
    // Never the company name in the signatory's place.
    expect(drawnText(bytes)).not.toContain('Acme Sdn Bhd\nAcme Sdn Bhd');
  });

  it('produces the blank fillable copy from the same renderer, with all 33 boxes and no values', async () => {
    const form = (await reload(await renderCp22Pdf(template(), null))).getForm();
    expect(form.getFields()).toHaveLength(33);
    for (const f of CP22_FIELDS.filter((x) => x.type !== 'checkbox')) {
      expect(form.getTextField(f.name).getText(), `${f.name} must be blank`).toBeUndefined();
    }
  });

  /**
   * Helvetica is WinAnsi. `updateFieldAppearances` THROWS on anything outside it, so a Tamil or Chinese
   * legal name must degrade — the documented ADR-0036 limitation — rather than 500 the download.
   */
  it('degrades a non-Latin name instead of failing the whole render', async () => {
    const bytes = await renderCp22Pdf(template(), {
      ...data,
      employee: { ...data.employee, fullName: '陳大文' },
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const form = (await reload(bytes)).getForm();
    expect(form.getTextField('employeeFullName').getText()).toBe('???');
  });

  /** A newline must survive the WinAnsi guard, or a four-row address block prints as one line of '?'. */
  it('keeps the line breaks in an address block', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    expect(form.getTextField('residentialAddress').getText()).toBe(
      'No. 8, Jalan Melur 2/3\nTaman Melur\n68000 Ampang, Selangor',
    );
    expect(form.getTextField('employerNameAddress').getText()).toContain('\n');
  });

  it('gives each widget a printable, non-hidden annotation', async () => {
    const doc = await reload(await renderCp22Pdf(template(), data));
    const annots = doc.getPages()[0].node.Annots()!;
    expect(annots.size()).toBe(33);
    for (let i = 0; i < annots.size(); i++) {
      const w = annots.lookup(i, PDFDict);
      const flags = (w.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0) as number;
      expect(flags & 0b100, 'the Print flag must be set or the box vanishes on paper').toBe(4);
      expect(flags & 0b10, 'no widget may be Hidden').toBe(0);
      expect(w.lookupMaybe(PDFName.of('AP'), PDFDict), 'every widget needs an appearance').toBeDefined();
    }
  });
});

/**
 * THE MULTI-ROW BLOCKS — a line of a legal declaration going missing with nothing to show for it.
 *
 * Two shapes, both ordinary in Malaysia, both silently wrong before this:
 *   - a FOUR-entry address (line1 / line2 / line3 / "postcode city, state"), which is the shape LHDN rules
 *     the box for: drawn, but with everything below the last row's baseline cut away. Measured at 900dpi,
 *     the "Selangor" band was 8.56pt deep — the same as the rows that have no descenders at all — against
 *     10.80pt once the rect had room for it;
 *   - a FIVE-entry address, and a payroll with four recurring allowances against a three-row box: the last
 *     line laid out under the widget rect and NEVER DRAWN. "Selangor Darul Ehsan" absent from an address;
 *     "Meal - RM 75.00" absent from the remuneration declared to LHDN, understating it by RM 900 a year.
 * Nothing failed. Every fixture in this file used three address lines and one or two allowances — the
 * shapes that happen to fit — so the suite was green, `next build` was green and the download was a 200.
 * AND THE TWO PDF RENDERERS DISAGREED: probed with a marker stream, MuPDF draws the EMBEDDED appearance
 * and showed the damage, while Poppler regenerates from /V and /DA (NeedAppearances is set), lays the
 * lines out a little higher and drew the same address whole. "It looks fine in one renderer" is not
 * evidence. So these assertions read the EMBEDDED stream's own geometry, which is the stricter of the two,
 * while the fix itself lands in /DA and /V, which is what a regenerating viewer reads.
 *
 * Everything below is parameterised on the block's own `rows`, so a block cannot be added without its full
 * height being covered. The two blocks nothing pre-fills (1 and 29) have no fixture that can reach them;
 * they are covered by the rect-vs-`rows` assertion in test/cp22-fields.test.ts and by the fit tests here.
 */
describe('CP22 multi-row blocks — every line reaches the page', () => {
  const MULTILINE = CP22_FIELDS.filter((f) => f.type === 'multiline');
  const helvetica = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);

  /** Drives each PRE-FILLED block from the data, so the render checks can be parameterised over the map. */
  const INPUT: Record<string, (lines: string[]) => Cp22PdfData> = {
    employerNameAddress: (l) => ({ ...data, employer: { ...data.employer, name: l[0], addressLines: l.slice(1) } }),
    residentialAddress: (l) => ({ ...data, employee: { ...data.employee, residentialAddressLines: l } }),
    correspondenceAddress: (l) => ({ ...data, employee: { ...data.employee, correspondenceAddressLines: l } }),
    monthlyAllowances: (l) => ({
      ...data,
      pay: { ...data.pay, allowances: l.map((label, i) => ({ label, amount: 100 + i })) },
    }),
  };

  it('drives every pre-fillable multi-row block from a fixture — a new one must be added here', () => {
    expect(Object.keys(INPUT).sort()).toEqual(
      MULTILINE.filter((f) => f.prefilled).map((f) => f.name).sort(),
    );
  });

  for (const f of MULTILINE.filter((x) => x.prefilled)) {
    const rows = f.rows!;
    // A block that is FULL, and a block given one and two lines more than it has rows. All three must come
    // out complete: the value is folded into the last row or set smaller, never trimmed to what fits.
    for (const extra of [0, 1, 2]) {
      it(`${f.name} (box ${f.box}) draws all ${rows + extra} lines of a ${rows}-row block`, async () => {
        const input = Array.from({ length: rows + extra }, (_, i) => `Baris ${i + 1} Taman Cempaka`);
        const bytes = await renderCp22Pdf(template(), INPUT[f.name](input));
        const drawn = appearanceLines(await reload(bytes), f.name);

        expect(drawn.lines.length, `${f.name} must not spill past its ${rows} printed rows`)
          .toBeLessThanOrEqual(rows);
        expectInsideTheClip(f, drawn);
        // …and NOTHING was dropped to achieve that. Every line of the input is still on the page.
        const onThePage = drawn.lines.map((l) => l.text).join('\n');
        for (const line of input) {
          expect(onThePage, `${f.name}: "${line}" never reached the page`).toContain(line);
        }
      });
    }
  }

  /** The verifier's own reproduction, in the words that went missing. */
  it('keeps "Selangor" whole on the fourth row of a four-line address — it was sliced at the baseline', async () => {
    const lines = ['No 8, Jalan Setia 3/4', 'Bandar Setia Alam', '40170 Shah Alam', 'Selangor'];
    const doc = await reload(await renderCp22Pdf(template(), INPUT.residentialAddress(lines)));
    const drawn = appearanceLines(doc, 'residentialAddress');
    expect(drawn.lines.map((l) => l.text)).toEqual(lines);
    expectInsideTheClip(CP22_FIELDS.find((f) => f.name === 'residentialAddress')!, drawn);
    // Unchanged from the shape that always worked: still the block's own size, still one line per row.
    expect(drawn.size).toBe(11.35);
  });

  it('keeps "Selangor Darul Ehsan" on a five-line address — it was absent from the page', async () => {
    const lines = [
      'No 12A, Jalan Bukit Bintang Utama Seksyen 14',
      'Petaling Jaya',
      'Taman Sri Muda',
      '40170 Shah Alam',
      'Selangor Darul Ehsan',
    ];
    const bytes = await renderCp22Pdf(template(), INPUT.residentialAddress(lines));
    for (const line of lines) expect(drawnText(bytes)).toContain(line);
    // Folded into the last ruled row rather than shrunk: the block still reads one address line per row.
    const drawn = appearanceLines(await reload(bytes), 'residentialAddress');
    expect(drawn.lines.map((l) => l.text)).toEqual([
      'No 12A, Jalan Bukit Bintang Utama Seksyen 14',
      'Petaling Jaya',
      'Taman Sri Muda',
      '40170 Shah Alam, Selangor Darul Ehsan',
    ]);
  });

  it('declares the fourth allowance to LHDN — "Meal - RM 75.00" was absent, understating box (b)', async () => {
    const bytes = await renderCp22Pdf(template(), {
      ...data,
      pay: {
        monthlyFixedRemuneration: 6500,
        allowances: [
          { label: 'Fixed monthly allowance', amount: 100 },
          { label: 'Travel', amount: 200 },
          { label: 'Phone', amount: 50 },
          { label: 'Meal', amount: 75 },
        ],
      },
    });
    const drawn = appearanceLines(await reload(bytes), 'monthlyAllowances');
    expect(drawn.lines.map((l) => l.text)).toEqual([
      'Fixed monthly allowance - RM 100.00',
      'Travel - RM 200.00',
      'Phone - RM 50.00; Meal - RM 75.00',
    ]);
    expectInsideTheClip(CP22_FIELDS.find((f) => f.name === 'monthlyAllowances')!, drawn);
    expect(drawnText(bytes)).toContain('Meal - RM 75.00');
  });

  /** A wrapping first line is the other way to exceed the rows without exceeding the LINES. */
  it('shrinks rather than drops when a single address line is wider than the box', async () => {
    const lines = [
      'No 12A, Jalan Bukit Bintang Utama Seksyen 14 Blok C',
      'Taman Sri Muda',
      '40170 Shah Alam',
      'Selangor Darul Ehsan',
    ];
    const bytes = await renderCp22Pdf(template(), INPUT.residentialAddress(lines));
    const drawn = appearanceLines(await reload(bytes), 'residentialAddress');
    expect(drawn.lines.map((l) => l.text)).toEqual(lines);
    expect(drawn.size, 'the block had to come down a size to fit line 1 on one row').toBeLessThan(11.35);
    expectInsideTheClip(CP22_FIELDS.find((f) => f.name === 'residentialAddress')!, drawn);
  });

  /**
   * The fit itself, over EVERY block — including boxes 1 and 29, which only the operator types into and
   * which therefore no rendered fixture reaches. A viewer regenerating the appearance from /DA and /V does
   * its own layout, so the size and the folded text are what has to be right, not the stream we wrote.
   */
  for (const f of MULTILINE) {
    it(`${f.name} (box ${f.box}) fits any value to its ${f.rows} rows without losing a line`, async () => {
      const font = await helvetica();
      const nominal = f.fontSize ?? CP22_DEFAULT_FONT_SIZE;
      for (const extra of [0, 1, 2, 5]) {
        const input = Array.from({ length: f.rows! + extra }, (_, i) => `Baris ${i + 1} Taman Cempaka`);
        const fit = fitMultilineValue(input.join('\n'), f, font);
        expect(fit.lines.length, `${f.name} +${extra}: more lines than rows`).toBeLessThanOrEqual(f.rows!);
        expect(
          fit.lines.length,
          `${f.name} +${extra}: more lines than the rect holds at ${fit.fontSize}pt`,
        ).toBeLessThanOrEqual(cp22FittingLineCount(f.rect, fit.fontSize, font));
        expect(fit.fontSize).toBeLessThanOrEqual(nominal);
        // The layout is the value: what /V says is what gets drawn, so a viewer that re-lays it out agrees.
        expect(fit.lines.join('\n')).toBe(fit.text);
        for (const line of input) expect(fit.text, `${f.name} +${extra}: lost "${line}"`).toContain(line);
      }
      // A value that already fits is left completely alone — this is the everyday case.
      const short = Array.from({ length: f.rows! }, () => 'Ampang').join('\n');
      expect(fitMultilineValue(short, f, font)).toMatchObject({ text: short, fontSize: nominal });
    });
  }

  it('leaves an empty block empty, at its own size', async () => {
    const font = await helvetica();
    const f = CP22_FIELDS.find((x) => x.name === 'residentialAddress')!;
    expect(fitMultilineValue('', f, font)).toMatchObject({ text: '', fontSize: 11.35 });
  });
});

describe('CP22 value formatting', () => {
  it('writes the two dates as the eight cells the form prints', () => {
    expect(ddmmyyyy('2026-07-02')).toBe('02072026');
    expect(ddmmyyyy(null)).toBe('');
    expect(ddmmyyyy('not a date')).toBe('');
    expect(dmy('2026-08-09')).toBe('09/08/2026');
  });

  /** The row is 2 cells, a GAP, then 11 — so the prefix is padded to three and the digits start at cell 4. */
  it('lays a tax number around the printed gap', () => {
    expect(taxNoComb('SG12345678901')).toBe('SG 12345678901');
    expect(taxNoComb('sg 1234567890')).toBe('SG 1234567890');
    expect(taxNoComb('OG-1234567890')).toBe('OG 1234567890');
    // A single-letter file type still leaves the gap cell blank.
    expect(taxNoComb('C1234567890')).toBe('C  1234567890');
    // Unparseable input is passed through rather than reshaped into something it is not.
    expect(taxNoComb('12345')).toBe('12345');
    expect(taxNoComb(null)).toBe('');
  });

  it('splits a telephone across the printed dash the way it is stored', () => {
    expect(splitMyPhone('012-3456789')).toEqual({ prefix: '012', rest: '3456789' });
    expect(splitMyPhone('03-87381234')).toEqual({ prefix: '03', rest: '87381234' });
    // No separator: 01x mobiles group three, landlines two.
    expect(splitMyPhone('0123456789')).toEqual({ prefix: '012', rest: '3456789' });
    expect(splitMyPhone('0387381234')).toEqual({ prefix: '03', rest: '87381234' });
    // International form normalises back to the national leading zero.
    expect(splitMyPhone('+60123456789')).toEqual({ prefix: '012', rest: '3456789' });
    expect(splitMyPhone(null)).toEqual({ prefix: '', rest: '' });
  });

  it('maps gender to the cell the form prints, and nothing else', () => {
    const v = (g: string | null) => cp22FieldValues({ ...data, employee: { ...data.employee, gender: g } }).gender;
    expect(v('male')).toBe('1');
    expect(v('female')).toBe('2');
    // 'undisclosed' is a real stored value and there is no third cell — blank, never a guessed 1 or 2.
    expect(v('undisclosed')).toBe('');
    expect(v(null)).toBe('');
  });

  it('lists the fixed monthly allowances one to a ruled row', () => {
    const v = cp22FieldValues({
      ...data,
      pay: {
        monthlyFixedRemuneration: 6500,
        allowances: [
          { label: 'Elaun tetap bulanan / Fixed monthly allowance', amount: 250 },
          { label: 'Transport allowance', amount: 300.5 },
        ],
      },
    });
    expect(v.monthlyAllowances).toBe(
      'Elaun tetap bulanan / Fixed monthly allowance - RM 250.00\nTransport allowance - RM 300.50',
    );
    expect(v.monthlyFixedRemuneration).toBe('6,500.00');
  });
});

/**
 * db46d9a2 — THE BATCH: one document, one page per joiner, every box on every page still editable.
 *
 * Everything that can go wrong here produces a file that OPENS, PRINTS and passes every green check while
 * being wrong, which is why each of these is an assertion rather than a code review note:
 *
 *   1. ACROFORM FIELD NAMES ARE DOCUMENT-GLOBAL. Two widgets called `employeeFullName` are ONE field with
 *      two appearances — type into page 3's name box and page 1's changes too. The operator's whole job
 *      with this file is typing into it, so this is not a corner case, it is the main path.
 *   2. THE ARTWORK MUST BE EMBEDDED ONCE. `copyPages` per joiner duplicates 153 KB of LHDN's page per
 *      person; the reporter's own reference is 38 pages, which would be ~5.8 MB for nothing. Nothing about
 *      the file LOOKS wrong when this regresses, so the proof is in the byte count.
 *   3. THE FORM MUST NOT BE FLATTENED and NeedAppearances / /DR must reach the finished document — the same
 *      three silent failures the single-page renderer has always guarded, now across N pages.
 */
describe('CP22 batch — one file, one page per joiner', () => {
  const NAMES = ['Amir bin Hassan', 'Bala a/l Suppiah', 'Chen Wei Ling', 'Devi a/p Krishnan', 'Elena Gomez'];
  const records = (n = NAMES.length): Cp22PdfData[] =>
    NAMES.slice(0, n).map((fullName, i) => ({
      ...data,
      employee: { ...data.employee, fullName, commencementDate: `2026-07-0${i + 1}` },
    }));

  /** Which PAGE a field's widget actually sits on — "the field exists" is not "it is on page 3". */
  function pageOf(doc: PDFDocument, name: string): number {
    const dicts = new Set(doc.getForm().getField(name).acroField.getWidgets().map((w) => w.dict));
    return doc.getPages().findIndex((p) => {
      const annots = p.node.Annots();
      if (!annots) return false;
      for (let i = 0; i < annots.size(); i++) {
        const d = doc.context.lookup(annots.get(i));
        if (d instanceof PDFDict && dicts.has(d)) return true;
      }
      return false;
    });
  }

  it('has exactly one page per record, at the template’s own page size', async () => {
    const doc = await reload(await renderCp22Batch(template(), records()));
    expect(doc.getPageCount()).toBe(NAMES.length);
    for (const p of doc.getPages()) {
      expect(p.getWidth()).toBeCloseTo(595.44, 2);
      expect(p.getHeight()).toBeCloseTo(841.68, 2);
    }
  });

  /** 1 — the document-global name trap. 33 boxes × N pages, and no two of them share a name. */
  it('gives every page its own field names, so typing on one page cannot change another', async () => {
    const doc = await reload(await renderCp22Batch(template(), records()));
    const names = doc.getForm().getFields().map((f) => f.getName());
    expect(names).toHaveLength(33 * NAMES.length);
    expect(new Set(names).size).toBe(names.length);
    // Every page's set is the full 33, prefixed with that page's own index.
    for (let i = 0; i < NAMES.length; i++) {
      const mine = names.filter((n) => n.startsWith(cp22BatchPrefix(i)));
      expect(mine, `page ${i + 1}`).toHaveLength(33);
      expect(mine.map((n) => n.slice(cp22BatchPrefix(i).length)).sort()).toEqual(
        CP22_FIELDS.map((f) => f.name).sort(),
      );
    }
    // The single-person document is UNCHANGED: its names are still unprefixed, which is what an operator's
    // viewer shows and what every other assertion in this file addresses.
    const single = (await reload(await renderCp22Pdf(template(), data))).getForm().getFields().map((f) => f.getName());
    expect(single).toContain('employeeFullName');
    expect(single.some((n) => /^p\d+_/.test(n))).toBe(false);
  });

  it('puts record 3’s name in page 3’s name box, and draws it there', async () => {
    const bytes = await renderCp22Batch(template(), records());
    const doc = await reload(bytes);
    for (let i = 0; i < NAMES.length; i++) {
      const name = `${cp22BatchPrefix(i)}employeeFullName`;
      expect(doc.getForm().getTextField(name).getText()).toBe(NAMES[i]);
      expect(pageOf(doc, name), `${name} must sit on page ${i + 1}`).toBe(i);
      // …and the value is DRAWN into that widget's own appearance, not merely held in /V.
      expect(appearanceLines(doc, name).lines.map((l) => l.text).join('')).toBe(NAMES[i]);
    }
    // Each joiner's own commencement date travels with them, so the pages are not N copies of record 1.
    expect(doc.getForm().getTextField('p3_commencementDate').getText()).toBe('03072026');
    const drawn = drawnText(bytes);
    for (const n of NAMES) expect(drawn).toContain(n);
  });

  /** 2 — the artwork is embedded ONCE and drawn N times. */
  it('costs far less than one copy of the artwork per extra joiner', async () => {
    const one = await renderCp22Batch(template(), records(1));
    const five = await renderCp22Batch(template(), records(5));
    const artwork = template().length;
    // Four more joiners must not cost even ONE more copy of LHDN's page.
    expect(five.length - one.length).toBeLessThan(artwork);
    // And the whole five-page file stays well under five separate single-person documents.
    const single = await renderCp22Pdf(template(), data);
    expect(five.length).toBeLessThan(single.length * 2);
  });

  /** 3 — the three silent failures, on the finished multi-page document. */
  it('stays editable, sets NeedAppearances once, and carries the /DR font dictionary', async () => {
    const doc = await reload(await renderCp22Batch(template(), records()));
    expect(doc.getForm().getFields().length).toBe(33 * NAMES.length); // a flattened form has ZERO
    // ONE AcroForm dictionary governs the whole document — these entries live on it, so they are set once
    // after every page exists rather than per page.
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
    expect(acro.lookupMaybe(PDFName.of('DR'), PDFDict)?.lookupMaybe(PDFName.of('Font'), PDFDict)).toBeDefined();
    const src = code(path.join(ROOT, 'lib', 'cp22-pdf.ts'));
    expect(src).not.toContain('.flatten(');
    // `copyPages` per joiner is the tempting way to write this and duplicates the artwork per person.
    expect(src).not.toContain('copyPages');
  });

  it('keeps every page’s combs, multilines and maxLen despite the name prefix', async () => {
    const doc = await reload(await renderCp22Batch(template(), records(2)));
    const form = doc.getForm();
    for (const i of [0, 1]) {
      for (const f of CP22_FIELDS) {
        const found = form.getFieldMaybe(cp22BatchPrefix(i) + f.name);
        expect(found, `${cp22BatchPrefix(i)}${f.name}`).toBeDefined();
        expect(found!.constructor.name).toBe(f.type === 'checkbox' ? 'PDFCheckBox' : 'PDFTextField');
        if (f.type === 'comb' && f.maxLen) {
          const tf = form.getTextField(cp22BatchPrefix(i) + f.name);
          expect(tf.getMaxLength()).toBe(f.maxLen);
          expect(tf.isCombed()).toBe(true);
        }
        if (f.type === 'multiline') expect(form.getTextField(cp22BatchPrefix(i) + f.name).isMultiline()).toBe(true);
      }
    }
  });

  // Box 1 has no answer anywhere in the schema, so it is normally an empty editable box. The branch the
  // OPERATOR typed is not an invented value — and typing it once must beat typing it on every page.
  it('stamps the typed LHDN branch onto every page, and leaves box 1 empty when nothing was typed', async () => {
    const branch = 'LHDN Cawangan Kajang\nTingkat 3, Wisma LHDN';
    const withBranch = await reload(await renderCp22Batch(template(), records(3), { lhdnBranch: branch }));
    for (let i = 0; i < 3; i++) {
      expect(withBranch.getForm().getTextField(`${cp22BatchPrefix(i)}lhdnBranchAddress`).getText()).toBe(branch);
    }
    for (const empty of [undefined, null, '', '   ']) {
      const doc = await reload(await renderCp22Batch(template(), records(2), { lhdnBranch: empty }));
      expect(doc.getForm().getTextField('p1_lhdnBranchAddress').getText()).toBeUndefined();
    }
    // The rest of the seven unanswerable boxes stay empty and typeable on every page — the branch is the
    // ONLY one an operator can answer from the screen.
    const doc = await reload(await renderCp22Batch(template(), records(2), { lhdnBranch: branch }));
    for (const f of CP22_FIELDS.filter((x) => !x.prefilled && x.name !== 'lhdnBranchAddress')) {
      for (const i of [0, 1]) {
        const name = cp22BatchPrefix(i) + f.name;
        if (f.type === 'checkbox') expect(doc.getForm().getCheckBox(name).isChecked(), name).toBe(false);
        else expect(doc.getForm().getTextField(name).getText(), name).toBeUndefined();
      }
    }
  });

  // A month with no joiners is a 404 at the route. A zero-page PDF is not a document, and producing one
  // silently would be the failure mode this throw exists to make loud.
  it('refuses to produce a document for no records at all', async () => {
    await expect(renderCp22Batch(template(), [])).rejects.toThrow(/no records/);
  });
});
