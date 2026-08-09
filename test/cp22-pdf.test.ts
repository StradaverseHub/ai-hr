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
import { PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { CP22_FIELDS } from '../lib/cp22-fields';
import {
  cp22FieldValues,
  ddmmyyyy,
  dmy,
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
    for (const f of ['app/payroll/cp22/[employmentId]/pdf/route.ts', 'app/payroll/cp22/blank/route.ts']) {
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
