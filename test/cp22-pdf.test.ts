/**
 * 88076362 — the CP22 [Pin.1/2021] renderer, and the properties of the downloaded file that FAIL SILENTLY.
 *
 * Everything about this document can be broken while tsc, `next build` and the whole suite stay green, and
 * the only symptom is what an operator sees when they open the file. So these are the assertions:
 *
 *   1. THE APPEARANCE TRAP. pdf-lib writes appearance streams only when asked. Drop the embedded font, the
 *      explicit `updateFieldAppearances(font)` or `NeedAppearances`, and the boxes come back BLANK or
 *      unstyled in real viewers — with nothing in any log. `drawnText` below inflates every stream in the
 *      produced file and reads back the show-text operands, so "the value reached the page" is a fact here
 *      rather than an inference from "the field exists".
 *   2. IT MUST NOT BE FLATTENED. Every box, including the filled ones, stays typeable: the operator
 *      completes the rest and corrects anything wrong before signing. A flattened form has zero fields and
 *      looks perfect in a screenshot.
 *   3. AN ABSENT RECORD IS AN EMPTY BOX, NEVER A GUESS AND NEVER A CRASH.
 *   4. NOTHING IS EVER CUT. Two different silent losses on this form, both guarded here — a line past the
 *      block's last printed row, and a line too wide for the box it is in.
 *   5. THE RIGHT PAGE. The form is two pages; a widget on the wrong one opens, prints and passes.
 *
 * WHAT THIS FILE NO LONGER TESTS, AND WHY THAT IS NOT A GAP. The 2020 edition printed CHARACTER CELLS, so
 * this file used to pin comb flags, MaxLen, a tax number laid out around a printed one-cell gap, and a
 * telephone split across a printed dash. CP22 [Pin.1/2021] prints none of those. Those cases are DELETED
 * rather than adapted — there is nothing left for them to be true about — and replaced by an assertion
 * that the produced file contains no combed field at all, so a later edit cannot reintroduce one against a
 * page with no cells to align it to.
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
import {
  CP22_DEFAULT_FONT_SIZE,
  CP22_FIELDS,
  cp22RowName,
  cp22Widgets,
  type Cp22Field,
} from '../lib/cp22-fields';
import {
  cp22Amount,
  cp22BatchPrefix,
  cp22FieldValues,
  dmy,
  fitBlock,
  fitSingleLine,
  foldToRows,
  renderCp22Batch,
  renderCp22Pdf,
  taxNo,
  type Cp22PdfData,
} from '../lib/cp22-pdf';

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'public', 'forms', 'cp22-pin-1-2021.pdf');
const template = () => new Uint8Array(fs.readFileSync(TEMPLATE_PATH));

/** Every widget the map produces — a `multirow` block contributes one per printed row. */
const WIDGET_COUNT = CP22_FIELDS.reduce((n, f) => n + cp22Widgets(f).length, 0);
const MULTIROW = CP22_FIELDS.filter((f) => f.type === 'multirow');

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
 * What pdf-lib actually DREW into ONE widget's appearance, and at what baseline and size.
 *
 * `drawnText` above answers "is this string on the page anywhere". That is not enough: a line can be on
 * the page and still be sliced by the widget's own clip, and a line can be missing while every OTHER line
 * of the same address is present, so a page full of correct-looking text hides it. This reads the widget's
 * /AP /N stream — `… x y Tm <hex> Tj` — in widget-local coordinates, which is exactly the space pdf-lib's
 * clip (`padding` 1pt in from the rect) is expressed in.
 */
function appearanceLines(doc: PDFDocument, name: string) {
  const [widget] = doc.getForm().getTextField(name).acroField.getWidgets();
  const ap = widget.getNormalAppearance();
  const stream = ap instanceof PDFRef ? doc.context.lookup(ap) : ap;
  const body = Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString('latin1');
  const size = Number(/\/[^\s/]+\s+([\d.]+)\s+Tf/.exec(body)?.[1] ?? 0);
  const lines = [...body.matchAll(/([\d.-]+)\s+([\d.-]+)\s+Tm\s*<([0-9A-Fa-f\s]*)>\s*Tj/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    text: Buffer.from(m[3].replace(/\s+/g, ''), 'hex').toString('latin1'),
  }));
  return { size, lines };
}

/**
 * Every line a multi-row BLOCK printed, read row by row out of the finished document.
 *
 * THIS IS THE ROW COUNT THE ARTEFACT PRINTS, not the one that happens to fit. r175a was green across 81
 * tests because every fixture used three address lines against a box ruled for four; the only honest way
 * to catch that class is to ask the produced file what it drew.
 */
function blockLines(doc: PDFDocument, f: Cp22Field, prefix = ''): string[] {
  return cp22Widgets(f)
    .map((_, i) => appearanceLines(doc, prefix + cp22RowName(f.name, i)).lines.map((l) => l.text).join(''))
    .filter((s) => s !== '');
}

/**
 * Assert a drawn line is whole. pdf-lib's appearance is a Form XObject whose /BBox is the widget rect,
 * with a clip path 1pt further in: a baseline less than one descender above that floor is a row with its
 * descenders cut off, a baseline below it is a row never drawn, and a line wider than the clip is a line
 * cut off MID-WORD at the right edge — which is the loss the 2020 renderer never guarded.
 */
async function expectInsideTheClip(f: Cp22Field, rectIndex: number, drawn: ReturnType<typeof appearanceLines>) {
  const font = await helvetica();
  const rect = cp22Widgets(f)[rectIndex];
  const ascender = drawn.size * 0.718; // Helvetica AFM, /1000
  const descender = drawn.size * 0.207;
  for (const line of drawn.lines) {
    expect(line.y - descender, `${f.code}#${rectIndex + 1}: "${line.text}" is sliced at the baseline`)
      .toBeGreaterThanOrEqual(1);
    expect(line.y + ascender, `${f.code}#${rectIndex + 1}: "${line.text}" is cut off at the top`)
      .toBeLessThanOrEqual(rect.height - 1);
    expect(
      line.x + font.widthOfTextAtSize(line.text, drawn.size),
      `${f.code}#${rectIndex + 1}: "${line.text}" runs past the right edge and is clipped mid-word`,
    ).toBeLessThanOrEqual(rect.width - 1 + 0.01);
  }
}

const helvetica = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);

const data: Cp22PdfData = {
  employer: {
    name: 'Acme Sdn Bhd',
    addressLines: ['No. 12, Jalan Damai 3', 'Taman Damai', '43000 Kajang, Selangor'],
    eNumber: '1234567890',
    phone: '03-87381234',
  },
  employee: {
    fullName: 'Nur Aisyah binti Rahman',
    designation: 'Site Supervisor',
    natureOfEmployment: 'Permanent',
    commencementDate: '2026-07-02',
    expectedDuration: 'Permanent',
    residentialAddress: {
      lines: ['No. 8, Jalan Melur 2/3', 'Taman Melur'],
      postcode: '68000',
      town: 'Ampang',
      state: 'Selangor',
    },
    correspondenceAddress: {
      lines: ['No. 8, Jalan Melur 2/3', 'Taman Melur'],
      postcode: '68000',
      town: 'Ampang',
      state: 'Selangor',
    },
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
  spouse: { fullName: 'Ahmad bin Ismail', icOrPassport: '880202-10-5678', phone: '019-8765432' },
  pay: { salaryAndOvertime: 6500, cashAllowances: [{ label: 'Transport allowance', amount: 300 }] },
  declarant: { name: 'Tan Wei Ming', designation: 'HR Manager', icOrPassport: '850505-14-5555' },
  today: '2026-08-09',
};

/** Same joiner, with every optional record missing — the "nothing on file" shape. */
const bare: Cp22PdfData = {
  employer: { name: 'Acme Sdn Bhd', addressLines: [], eNumber: null, phone: null },
  employee: {
    fullName: 'Nur Aisyah binti Rahman',
    designation: null,
    natureOfEmployment: null,
    commencementDate: null,
    expectedDuration: 'Permanent',
    residentialAddress: { lines: [], postcode: null, town: null, state: null },
    correspondenceAddress: { lines: [], postcode: null, town: null, state: null },
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
  pay: { salaryAndOvertime: null, cashAllowances: [] },
  declarant: { name: null, designation: null, icOrPassport: null },
  today: '2026-08-09',
};

const reload = (bytes: Uint8Array) => PDFDocument.load(bytes);

describe('CP22 — the bundled LHDN template', () => {
  it('is LHDN’s TWO-page 2021 form, A4, with ZERO pre-existing form fields', async () => {
    const doc = await PDFDocument.load(template());
    expect(doc.getPageCount()).toBe(2);
    for (const p of doc.getPages()) {
      expect(p.getWidth()).toBeCloseTo(595.44, 2);
      expect(p.getHeight()).toBeCloseTo(841.68, 2);
    }
    // Every rect in lib/cp22-fields.ts was derived from THIS file's content streams. If the template ever
    // gains its own AcroForm, the overlay would be added on top of somebody else's widgets.
    expect(doc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
  });

  /**
   * THE 2020 EDITION IS RETIRED, and this is what makes that true rather than intended. The plan's first
   * requirement was that nothing left in the system can still produce the superseded document; a stale
   * `cp22-pin-1-2020.pdf` sitting in public/ would be served by Next as a static asset to anyone who
   * guessed the URL, whatever the code does.
   */
  it('has retired the 2020 artwork — the file is gone and nothing references it', () => {
    expect(fs.existsSync(path.join(ROOT, 'public', 'forms', 'cp22-pin-1-2020.pdf'))).toBe(false);
    for (const dir of ['app', 'lib', 'core', 'localization']) {
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.tsx?$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('cp22-pin-1-2020')) hits.push(p);
        }
      };
      walk(path.join(ROOT, dir));
      expect(hits, `${dir}/ still names the retired 2020 artwork`).toEqual([]);
    }
  });

  it('is read through the one helper, not by a path inlined at each call site', () => {
    const helper = fs.readFileSync(path.join(ROOT, 'lib', 'cp22-template.ts'), 'utf8');
    expect(helper).toContain("'forms', 'cp22-pin-1-2021.pdf'");
    for (const f of [
      'app/payroll/cp22/[employmentId]/pdf/route.ts',
      'app/payroll/cp22/blank/route.ts',
      'app/payroll/cp22/batch/route.ts',
    ]) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, `${f} must go through readCp22Template`).toContain('readCp22Template');
      expect(src, `${f} must not inline the asset path`).not.toContain('cp22-pin-1-2021.pdf');
    }
  });
});

describe('CP22 renderer — the produced file', () => {
  it(`renders a real PDF carrying all ${WIDGET_COUNT} widgets, by the map’s own names and kinds`, async () => {
    const bytes = await renderCp22Pdf(template(), data);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const form = (await reload(bytes)).getForm();
    expect(form.getFields()).toHaveLength(WIDGET_COUNT);
    for (const f of CP22_FIELDS) {
      cp22Widgets(f).forEach((_, i) => {
        const found = form.getFieldMaybe(cp22RowName(f.name, i));
        expect(found, `${f.code} row ${i + 1} (${cp22RowName(f.name, i)}) must exist`).toBeDefined();
        expect(found!.constructor.name).toBe(f.type === 'checkbox' ? 'PDFCheckBox' : 'PDFTextField');
      });
    }
  });

  /** 5 — the right page. A widget on the wrong page still opens, prints and passes everything else. */
  it('puts section A/B/C widgets on page 1 and D/E/F on page 2', async () => {
    const doc = await reload(await renderCp22Pdf(template(), data));
    const pageOf = (name: string) => {
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
    };
    for (const f of CP22_FIELDS) {
      cp22Widgets(f).forEach((_, i) => {
        expect(pageOf(cp22RowName(f.name, i)), `${f.code} row ${i + 1} is on the wrong page`).toBe(f.page);
      });
    }
  });

  /** 1 — THE APPEARANCE TRAP. Not "the field holds a value": the value is DRAWN. */
  it('draws every pre-filled value into an appearance stream, not just into /V', async () => {
    const drawn = drawnText(await renderCp22Pdf(template(), data));
    for (const expected of [
      'Nur Aisyah binti Rahman',
      'Site Supervisor', // B15 Jawatan
      'Acme Sdn Bhd',
      '1234567890', // A3, the form prints the "E" itself
      'aisyah@example.test',
      'Ahmad bin Ismail',
      '019-8765432', // C4, new on this edition
      '6,500.00', // D1
      '300.00', // D4
      '6,800.00', // JUMLAH
      'Tan Wei Ming',
      'HR Manager',
      '850505-14-5555', // F2, the declarant's own identification number
      '09/08/2026',
      'Selangor', // B12S — its OWN printed box, not the tail of an address row
    ]) {
      expect(drawn, `"${expected}" never reached the page`).toContain(expected);
    }
  });

  it('sets NeedAppearances, so a viewer regenerates the boxes after the operator edits one', async () => {
    const doc = await reload(await renderCp22Pdf(template(), data));
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
    // …and /DR names a font for that regeneration to use. pdf-lib does not maintain it.
    expect(acro.lookupMaybe(PDFName.of('DR'), PDFDict)?.lookupMaybe(PDFName.of('Font'), PDFDict)).toBeDefined();
  });

  /** 2 — UNFLATTENED. A flattened form renders identically and is completely uneditable. */
  it('leaves the form editable — every widget live, including the ones that arrive filled', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    expect(form.getFields()).toHaveLength(WIDGET_COUNT);
    expect(form.getTextField('employeeName').getText()).toBe('Nur Aisyah binti Rahman');
    // The renderer must never gain a flatten() call: it would satisfy every other assertion here. Read as
    // CODE — the file documents the ban in prose, and scanning the prose would pass on the explanation.
    expect(code(path.join(ROOT, 'lib', 'cp22-pdf.ts'))).not.toContain('.flatten(');
  });

  /**
   * NO COMBS. The 2021 page prints no character cells, so a combed field would space one glyph per
   * notional cell across a plain box — a rendering fault that looks deliberate.
   */
  it('combs nothing, because the 2021 page prints no character cells', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    for (const f of form.getFields()) {
      if (f.constructor.name !== 'PDFTextField') continue;
      const tf = form.getTextField(f.getName());
      expect(tf.isCombed(), `${f.getName()} must not be combed`).toBe(false);
      expect(tf.getMaxLength(), `${f.getName()} must carry no MaxLength`).toBeUndefined();
    }
    // The tax number is one plain box: no padding into a gap that no longer exists.
    expect(form.getTextField('incomeTaxNo').getText()).toBe('SG 12345678901');
  });

  /**
   * THE ADDRESS IS SPLIT, NOT FOLDED — r175a relocated, and the single most important assertion here.
   *
   * core/reporting.ts used to fold postcode + town + state into a tail LINE, because the 2020 page had one
   * four-row block and nowhere else to put them. The 2021 page prints Poskod, Bandar and Negeri as three
   * separate boxes. Reuse the fold and all three values land in a free STREET row while LHDN's three boxes
   * stay empty — the page looks complete, and a Malaysian address goes to LHDN with its state in the wrong
   * box. Nothing errors, nothing logs, and every other test in this file still passes.
   */
  it('puts postcode, town and state in their OWN printed boxes, never on a street row', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    expect(form.getTextField('residentialPostcode').getText()).toBe('68000');
    expect(form.getTextField('residentialTown').getText()).toBe('Ampang');
    expect(form.getTextField('residentialState').getText()).toBe('Selangor');
    expect(form.getTextField('correspondencePostcode').getText()).toBe('68000');
    expect(form.getTextField('correspondenceTown').getText()).toBe('Ampang');
    expect(form.getTextField('correspondenceState').getText()).toBe('Selangor');
    // …and the street rows carry ONLY the street. A row containing "68000 Ampang, Selangor" would mean the
    // fold survived and the three boxes above are being filled from somewhere else, or twice.
    for (const row of ['residentialAddress', 'residentialAddress_2', 'residentialAddress_3']) {
      const v = form.getTextField(row).getText() ?? '';
      expect(v, `${row} must not carry the folded postcode/town/state tail`).not.toMatch(/68000|Selangor/);
    }
    // Only the operator knows whether the correspondence address belongs to a tax agent.
    expect(form.getCheckBox('correspondenceIsTaxAgent').isChecked()).toBe(false);
  });

  /** 3 — the fifteen, plus every optional record, as EMPTY editable boxes. */
  it('leaves the fifteen unanswerable areas empty while keeping them typeable', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    for (const f of CP22_FIELDS.filter((x) => !x.prefilled)) {
      cp22Widgets(f).forEach((_, i) => {
        const name = cp22RowName(f.name, i);
        if (f.type === 'checkbox') {
          expect(form.getCheckBox(name).isChecked(), name).toBe(false);
          return;
        }
        expect(form.getTextField(name).getText(), `${f.code} must never be invented`).toBeUndefined();
        expect(form.getTextField(name).isReadOnly(), `${f.code} must stay typeable`).toBe(false);
      });
    }
  });

  /**
   * THE SIX BLANK D-LINES ARE BLANK, NOT ZERO. Writing "0.00" into leave pay or bonus DECLARES that there
   * is none, on a form signed under section 83(2). We do not know that; nothing in payroll holds it at the
   * point of hire. A blank box asks the question, a zero answers it wrongly.
   */
  it('never writes 0.00 into a D-line it holds no figure for', async () => {
    const form = (await reload(await renderCp22Pdf(template(), data))).getForm();
    for (const name of [
      'd2LeavePay',
      'd3CommissionBonus',
      'd5BenefitsInKind',
      'd6LivingAccommodation',
      'd7AllowancesInKind',
      'd8OtherPayments',
    ]) {
      expect(form.getTextField(name).getText(), `${name} must be blank, not a declared zero`).toBeUndefined();
    }
  });

  it('renders a joiner with nothing on file as empty boxes rather than throwing', async () => {
    const bytes = await renderCp22Pdf(template(), bare);
    const form = (await reload(bytes)).getForm();
    expect(form.getFields()).toHaveLength(WIDGET_COUNT);
    expect(form.getTextField('employeeName').getText()).toBe('Nur Aisyah binti Rahman');
    for (const name of [
      'spouseName', // no spouse on the family register
      'spouseIcOrPassport',
      'spousePhone',
      'incomeTaxNo', // no employee_statutory_my row
      'icNo',
      'currentPassportNo',
      'declarantName', // a session with no person, or a person with no assignment
      'declarantDesignation',
      'declarantIcOrPassport',
      'd1SalaryOvertime', // no compensation row
      'dTotal', // …so no total either — never a bare 0.00
      'residentialPostcode',
      'residentialState',
    ]) {
      expect(form.getTextField(name).getText(), `${name} must be empty, not guessed`).toBeUndefined();
    }
    // Never the company name in the declarant's place.
    expect(drawnText(bytes)).not.toContain('Acme Sdn Bhd\nAcme Sdn Bhd');
  });

  it('produces the blank fillable copy from the same renderer, with every box and no values', async () => {
    const form = (await reload(await renderCp22Pdf(template(), null))).getForm();
    expect(form.getFields()).toHaveLength(WIDGET_COUNT);
    for (const f of CP22_FIELDS.filter((x) => x.type !== 'checkbox')) {
      cp22Widgets(f).forEach((_, i) => {
        expect(form.getTextField(cp22RowName(f.name, i)).getText(), `${f.code} must be blank`).toBeUndefined();
      });
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
    expect((await reload(bytes)).getForm().getTextField('employeeName').getText()).toBe('???');
  });

  it('gives every widget a printable, non-hidden annotation, on both pages', async () => {
    const doc = await reload(await renderCp22Pdf(template(), data));
    let seen = 0;
    for (const page of doc.getPages()) {
      const annots = page.node.Annots()!;
      for (let i = 0; i < annots.size(); i++) {
        seen++;
        const w = annots.lookup(i, PDFDict);
        const flags = (w.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0) as number;
        expect(flags & 0b100, 'the Print flag must be set or the box vanishes on paper').toBe(4);
        expect(flags & 0b10, 'no widget may be Hidden').toBe(0);
        expect(w.lookupMaybe(PDFName.of('AP'), PDFDict), 'every widget needs an appearance').toBeDefined();
      }
    }
    expect(seen).toBe(WIDGET_COUNT);
  });
});

/**
 * ══ THE r175a ACCEPTANCE TEST ═══════════════════════════════════════════════════════════════════════
 *
 * r175a: a four-line Malaysian address went to LHDN WITHOUT ITS STATE, and box (b) went short an
 * allowance, understating the remuneration declared. No warning, no ellipsis — the box looked full.
 * 81 tests were green, because EVERY FIXTURE USED THREE ADDRESS LINES WHILE THE FORM IS RULED FOR FOUR.
 *
 * So the fixture below deliberately gives EVERY multi-row block ONE LINE MORE than the block has rows,
 * and the assertions read what the ARTEFACT PRINTED — row by row, out of the finished document — rather
 * than what a helper says would fit. On the 2021 form each row is its own widget, so the failure has moved
 * but not gone: a line past the last row has no widget to be written to and would simply not exist.
 */
describe('CP22 multi-row blocks — every line reaches the page', () => {
  /** Drives each PRE-FILLED block from the data, so the render checks are parameterised over the map. */
  const INPUT: Record<string, (lines: string[]) => Cp22PdfData> = {
    employerName: (l) => ({ ...data, employer: { ...data.employer, name: l.join('\n') } }),
    employerAddress: (l) => ({ ...data, employer: { ...data.employer, addressLines: l } }),
    employeeName: (l) => ({ ...data, employee: { ...data.employee, fullName: l.join('\n') } }),
    residentialAddress: (l) => ({
      ...data,
      employee: { ...data.employee, residentialAddress: { ...data.employee.residentialAddress, lines: l } },
    }),
    correspondenceAddress: (l) => ({
      ...data,
      employee: {
        ...data.employee,
        correspondenceAddress: { ...data.employee.correspondenceAddress, lines: l },
      },
    }),
    spouseName: (l) => ({ ...data, spouse: { ...data.spouse!, fullName: l.join('\n') } }),
    declarantName: (l) => ({ ...data, declarant: { ...data.declarant, name: l.join('\n') } }),
  };

  it('drives every pre-fillable multi-row block from a fixture — a new one must be added here', () => {
    expect(Object.keys(INPUT).sort()).toEqual(
      MULTIROW.filter((f) => f.prefilled).map((f) => f.name).sort(),
    );
  });

  for (const f of MULTIROW.filter((x) => x.prefilled)) {
    const rows = f.rows!;
    // A block that is FULL, and a block given one and two lines MORE than it has rows. All three must come
    // out complete: the surplus is folded into the last row, never trimmed to what fits.
    for (const extra of [0, 1, 2]) {
      it(`${f.code} prints all ${rows + extra} lines given to its ${rows}-row block`, async () => {
        const input = Array.from({ length: rows + extra }, (_, i) => `Baris ${i + 1} Taman Cempaka`);
        const doc = await reload(await renderCp22Pdf(template(), INPUT[f.name](input)));
        const printed = blockLines(doc, f);

        expect(printed.length, `${f.code} printed more rows than the ${rows} the form rules`)
          .toBeLessThanOrEqual(rows);
        // …and NOTHING was dropped to achieve that. Every line of the input is still on the page.
        const onThePage = printed.join('\n');
        for (const line of input) {
          expect(onThePage, `${f.code}: "${line}" never reached the page`).toContain(line);
        }
        for (let i = 0; i < printed.length; i++) {
          await expectInsideTheClip(f, i, appearanceLines(doc, cp22RowName(f.name, i)));
        }
      });
    }
  }

  /** The verifier's own reproduction, in the words that went missing — now in their own printed box. */
  it('keeps "Selangor" — it used to be sliced at the baseline of a folded fourth row', async () => {
    const doc = await reload(
      await renderCp22Pdf(template(), {
        ...data,
        employee: {
          ...data.employee,
          residentialAddress: {
            lines: ['No 8, Jalan Setia 3/4', 'Bandar Setia Alam'],
            postcode: '40170',
            town: 'Shah Alam',
            state: 'Selangor',
          },
        },
      }),
    );
    expect(blockLines(doc, CP22_FIELDS.find((f) => f.code === 'B12')!)).toEqual([
      'No 8, Jalan Setia 3/4',
      'Bandar Setia Alam',
    ]);
    // The state is not on a street row at all any more — it is in the box LHDN prints for it.
    expect(doc.getForm().getTextField('residentialState').getText()).toBe('Selangor');
  });

  it('keeps a fourth street line — it would have had no widget to be written to', async () => {
    const lines = [
      'No 12A, Jalan Bukit Bintang Utama',
      'Taman Sri Muda',
      'Seksyen 14',
      'Blok C Tingkat 2',
    ];
    const bytes = await renderCp22Pdf(template(), {
      ...data,
      employee: { ...data.employee, residentialAddress: { ...data.employee.residentialAddress, lines } },
    });
    for (const line of lines) expect(drawnText(bytes)).toContain(line);
    // Folded into the last ruled row rather than shrunk away: three printed rows, all four lines present.
    expect(blockLines(await reload(bytes), CP22_FIELDS.find((f) => f.code === 'B12')!)).toEqual([
      'No 12A, Jalan Bukit Bintang Utama',
      'Taman Sri Muda',
      'Seksyen 14, Blok C Tingkat 2',
    ]);
  });

  /**
   * THE LOSS THE 2020 RENDERER NEVER GUARDED. A single-line field is drawn at its natural width and CLIPPED
   * — pdf-lib neither wraps nor truncates — so a long legal name in a narrow box was cut off mid-word with
   * nothing in any log. Every box on this form is single-line, so this applies to all of them.
   */
  it('shrinks a too-wide value instead of clipping it mid-word', async () => {
    const LONG = 'Nurul Aisyah Amanda binti Mohd Zulkifli Abdul Rahman Al-Hafiz';
    const doc = await reload(
      await renderCp22Pdf(template(), { ...data, employee: { ...data.employee, fullName: LONG } }),
    );
    const drawn = appearanceLines(doc, 'employeeName');
    expect(drawn.lines.map((l) => l.text).join('')).toBe(LONG);
    await expectInsideTheClip(CP22_FIELDS.find((f) => f.code === 'B1')!, 0, drawn);
  });

  it('shrinks a too-wide value in a NARROW box too — B14 is 62pt wide', async () => {
    const f = CP22_FIELDS.find((x) => x.code === 'B14')!;
    const font = await helvetica();
    const size = fitSingleLine('02/07/2026', f.rect, f.fontSize ?? CP22_DEFAULT_FONT_SIZE, font);
    expect(font.widthOfTextAtSize('02/07/2026', size)).toBeLessThanOrEqual(f.rect.width - 2);
  });

  /**
   * The fit itself over EVERY block — including E1 and E2, which only the operator types into and which
   * therefore no rendered fixture can reach. A viewer regenerating the appearance from /DA and /V does its
   * own layout, so the folded text and the chosen size are what has to be right, not only the stream.
   */
  for (const f of MULTIROW) {
    it(`${f.code} folds any value into its ${f.rows} rows without losing a line`, async () => {
      const font = await helvetica();
      const nominal = f.fontSize ?? CP22_DEFAULT_FONT_SIZE;
      for (const extra of [0, 1, 2, 5]) {
        const input = Array.from({ length: f.rows! + extra }, (_, i) => `Baris ${i + 1} Taman Cempaka`);
        const fit = fitBlock(input.join('\n'), f, font);
        expect(fit.rows.length, `${f.code} +${extra}: more rows than the block has`).toBe(f.rows);
        expect(fit.rows[0].fontSize).toBeLessThanOrEqual(nominal);
        // ONE size for the whole block — a second line two points smaller reads as a rendering fault.
        expect(new Set(fit.rows.map((r) => r.fontSize)).size).toBe(1);
        const all = fit.rows.map((r) => r.text).join('\n');
        for (const line of input) expect(all, `${f.code} +${extra}: lost "${line}"`).toContain(line);
      }
      // A value that already fits is left completely alone — this is the everyday case.
      const short = Array.from({ length: f.rows! }, () => 'Ampang');
      const fit = fitBlock(short.join('\n'), f, font);
      expect(fit.rows.map((r) => r.text)).toEqual(short);
      expect(fit.rows[0].fontSize).toBe(nominal);
    });
  }

  it('folds with the separator the block declares, and never drops the tail', () => {
    expect(foldToRows(['a', 'b', 'c', 'd'], 3, ', ')).toEqual(['a', 'b', 'c, d']);
    expect(foldToRows(['a', 'b', 'c', 'd', 'e'], 2, '; ')).toEqual(['a', 'b; c; d; e']);
    expect(foldToRows(['a'], 3, ', ')).toEqual(['a']);
  });

  it('leaves an empty block empty, at its own size', async () => {
    const font = await helvetica();
    const f = CP22_FIELDS.find((x) => x.code === 'B12')!;
    const fit = fitBlock('', f, font);
    expect(fit.rows.map((r) => r.text)).toEqual(['', '', '']);
    expect(fit.rows[0].fontSize).toBe(CP22_DEFAULT_FONT_SIZE);
  });
});

describe('CP22 value formatting and the D-section', () => {
  it('writes dates as dd/mm/yyyy — the 2021 page has plain date boxes, not cells', () => {
    expect(dmy('2026-07-02')).toBe('02/07/2026');
    expect(dmy('2026-08-09')).toBe('09/08/2026');
    expect(dmy(null)).toBe('');
    expect(dmy('not a date')).toBe('');
  });

  /** One plain box: no padding into a printed gap, because there is no printed gap. */
  it('normalises a tax number without laying it out around a gap', () => {
    expect(taxNo('SG12345678901')).toBe('SG 12345678901');
    expect(taxNo('sg 1234567890')).toBe('SG 1234567890');
    expect(taxNo('C1234567890')).toBe('C 1234567890');
    // Unparseable input is passed through rather than reshaped into something it is not.
    expect(taxNo('12345')).toBe('12345');
    expect(taxNo(null)).toBe('');
  });

  it('writes gender and marital status as recorded, never reworded into a code', () => {
    const v = (g: string | null) => cp22FieldValues({ ...data, employee: { ...data.employee, gender: g } }).gender;
    // The 2020 page printed "1 = Lelaki / 2 = Perempuan" beside a single cell; 2021 prints a plain box, so
    // a numeric code would be meaningless there.
    expect(v('male')).toBe('Male');
    expect(v('female')).toBe('Female');
    expect(v('undisclosed')).toBe('Undisclosed');
    expect(v(null)).toBe('');
  });

  /**
   * THE D-SECTION. D1 takes the salary; D4 takes the cash allowances TOTALLED, with their names on both of
   * the form's own specify rules; the total is D1 + D4. The six lines nothing is held for stay empty.
   */
  it('splits monthly pay across D1 and D4, names the allowances, and totals them', () => {
    const v = cp22FieldValues({
      ...data,
      pay: {
        salaryAndOvertime: 6500,
        cashAllowances: [
          { label: 'Elaun tetap bulanan / Fixed monthly allowance', amount: 250 },
          { label: 'Transport allowance', amount: 300.5 },
        ],
      },
    });
    expect(v.d1SalaryOvertime).toBe('6,500.00');
    expect(v.d4CashAllowances).toBe('550.50');
    expect(v.d4SpecifyMs).toBe(
      'Elaun tetap bulanan / Fixed monthly allowance - RM 250.00; Transport allowance - RM 300.50',
    );
    // Both printed rules carry the same answer — the form asks the question twice, in two languages.
    expect(v.d4SpecifyEn).toBe(v.d4SpecifyMs);
    expect(v.dTotal).toBe('7,050.50');
    // The six we hold nothing for are absent from the map entirely, not present as ''.
    for (const k of ['d2LeavePay', 'd3CommissionBonus', 'd5BenefitsInKind', 'd8OtherPayments']) {
      expect(v[k] ?? '', `${k} must not be written`).toBe('');
    }
  });

  it('leaves the total blank when there is no pay on file at all', () => {
    const v = cp22FieldValues(bare);
    expect(v.d1SalaryOvertime).toBe('');
    expect(v.d4CashAllowances).toBe('');
    expect(v.dTotal).toBe('');
  });

  it('formats money the way the column head asks — no currency prefix, two decimals', () => {
    expect(cp22Amount(6500)).toBe('6,500.00');
    expect(cp22Amount(0)).toBe('0.00');
    expect(cp22Amount(1234567.5)).toBe('1,234,567.50');
  });

  it('fills B15 Jawatan and B17 Jenis pekerjaan as the two different questions they are', () => {
    const v = cp22FieldValues(data);
    expect(v.designation).toBe('Site Supervisor');
    expect(v.natureOfEmployment).toBe('Permanent');
  });
});

/**
 * db46d9a2 — THE BATCH: one document, TWO pages per joiner, every box on every page still editable.
 *
 * Everything that can go wrong here produces a file that OPENS, PRINTS and passes every green check while
 * being wrong, which is why each of these is an assertion rather than a code review note:
 *
 *   1. ACROFORM FIELD NAMES ARE DOCUMENT-GLOBAL. Two widgets called `employeeName` are ONE field with two
 *      appearances — type into joiner 3's name box and joiner 1's changes too. The operator's whole job
 *      with this file is typing into it, so this is not a corner case, it is the main path.
 *   2. THE ARTWORK MUST BE EMBEDDED ONCE. `copyPages` per joiner duplicates 172 KB of LHDN's two pages per
 *      person. Nothing about the file LOOKS wrong when this regresses, so the proof is in the byte count.
 *   3. THE FORM MUST NOT BE FLATTENED and NeedAppearances / /DR must reach the finished document.
 */
describe('CP22 batch — one file, two pages per joiner', () => {
  const NAMES = ['Amir bin Hassan', 'Bala a/l Suppiah', 'Chen Wei Ling', 'Devi a/p Krishnan', 'Elena Gomez'];
  const records = (n = NAMES.length): Cp22PdfData[] =>
    NAMES.slice(0, n).map((fullName, i) => ({
      ...data,
      employee: { ...data.employee, fullName, commencementDate: `2026-07-0${i + 1}` },
    }));

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

  it('has TWO pages per record, at the template’s own page size', async () => {
    const doc = await reload(await renderCp22Batch(template(), records()));
    expect(doc.getPageCount()).toBe(NAMES.length * 2);
    for (const p of doc.getPages()) {
      expect(p.getWidth()).toBeCloseTo(595.44, 2);
      expect(p.getHeight()).toBeCloseTo(841.68, 2);
    }
  });

  /** 1 — the document-global name trap. Every widget × N joiners, and no two of them share a name. */
  it('gives every record its own field names, so typing on one cannot change another', async () => {
    const doc = await reload(await renderCp22Batch(template(), records()));
    const names = doc.getForm().getFields().map((f) => f.getName());
    expect(names).toHaveLength(WIDGET_COUNT * NAMES.length);
    expect(new Set(names).size).toBe(names.length);
    const all = CP22_FIELDS.flatMap((f) => cp22Widgets(f).map((_, i) => cp22RowName(f.name, i))).sort();
    for (let i = 0; i < NAMES.length; i++) {
      const mine = names.filter((n) => n.startsWith(cp22BatchPrefix(i)));
      expect(mine, `record ${i + 1}`).toHaveLength(WIDGET_COUNT);
      expect(mine.map((n) => n.slice(cp22BatchPrefix(i).length)).sort()).toEqual(all);
    }
    // The single-person document is UNCHANGED: its names are still unprefixed, which is what an operator's
    // viewer shows and what every other assertion in this file addresses.
    const single = (await reload(await renderCp22Pdf(template(), data))).getForm().getFields().map((f) => f.getName());
    expect(single).toContain('employeeName');
    expect(single.some((n) => /^p\d+_/.test(n))).toBe(false);
  });

  it('puts record 3’s name on record 3’s first page, and its D-section on its second', async () => {
    const bytes = await renderCp22Batch(template(), records());
    const doc = await reload(bytes);
    for (let i = 0; i < NAMES.length; i++) {
      const name = `${cp22BatchPrefix(i)}employeeName`;
      expect(doc.getForm().getTextField(name).getText()).toBe(NAMES[i]);
      expect(pageOf(doc, name), `${name} must sit on record ${i + 1}'s first page`).toBe(i * 2);
      // …and the value is DRAWN into that widget's own appearance, not merely held in /V.
      expect(appearanceLines(doc, name).lines.map((l) => l.text).join('')).toBe(NAMES[i]);
      // Section D belongs to the SECOND page of the same record — the two pages must not interleave.
      expect(pageOf(doc, `${cp22BatchPrefix(i)}d1SalaryOvertime`)).toBe(i * 2 + 1);
    }
    // Each joiner's own commencement date travels with them, so the pages are not N copies of record 1.
    expect(doc.getForm().getTextField('p3_commencementDate').getText()).toBe('03/07/2026');
    const drawn = drawnText(bytes);
    for (const n of NAMES) expect(drawn).toContain(n);
  });

  /**
   * 2 — THE ARTWORK IS EMBEDDED ONCE AND DRAWN N TIMES, proved STRUCTURALLY.
   *
   * The 2020 version of this test compared byte counts: five joiners had to cost less than one extra copy
   * of the artwork. That proxy no longer proves anything, and finding out why was worth the failure — the
   * 2021 form carries 67 widgets across two pages against the 2020 page's 33, so five joiners are 670
   * appearance streams, and the widgets alone now outweigh a 172 KB template. A byte budget that a
   * REGRESSION would still fit inside is not a test.
   *
   * So this asks the document directly: however many joiners there are, every page must draw one of the
   * SAME TWO embedded Form XObjects. `copyPages` per joiner — the tempting way to write the batch —
   * produces 2N distinct ones, and nothing about the file looks wrong when it does.
   */
  it('draws every page from the same two embedded artwork objects, however many joiners', async () => {
    const xobjectRefs = (doc: PDFDocument) => {
      const refs = new Set<string>();
      for (const page of doc.getPages()) {
        const xo = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
        if (!xo) continue;
        for (const [, value] of xo.entries()) refs.add(String(value));
      }
      return refs;
    };
    expect(xobjectRefs(await reload(await renderCp22Batch(template(), records(1)))).size).toBe(2);
    expect(xobjectRefs(await reload(await renderCp22Batch(template(), records(5)))).size).toBe(2);

    // …and the file therefore stays far smaller than N separate single-person documents, each of which
    // carries its own full copy of LHDN's two pages.
    const five = await renderCp22Batch(template(), records(5));
    const single = await renderCp22Pdf(template(), data);
    expect(five.length).toBeLessThan(single.length * 3);
  });

  /** 3 — the three silent failures, on the finished multi-page document. */
  it('stays editable, sets NeedAppearances once, and carries the /DR font dictionary', async () => {
    const doc = await reload(await renderCp22Batch(template(), records()));
    expect(doc.getForm().getFields().length).toBe(WIDGET_COUNT * NAMES.length); // a flattened form has ZERO
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
    expect(acro.lookupMaybe(PDFName.of('DR'), PDFDict)?.lookupMaybe(PDFName.of('Font'), PDFDict)).toBeDefined();
    const src = code(path.join(ROOT, 'lib', 'cp22-pdf.ts'));
    expect(src).not.toContain('.flatten(');
    // `copyPages` per joiner is the tempting way to write this and duplicates the artwork per person.
    expect(src).not.toContain('copyPages');
  });

  /**
   * THE BRANCH STAMP IS GONE, AND ITS ABSENCE IS PINNED. The 2020 batch took an `lhdnBranch` option and
   * stamped it into box 1 of every page. CP22 [Pin.1/2021] has no "Kepada / To" block, so there is nowhere
   * for it to go — and a renderer that still accepted the option would accept it and silently discard it,
   * which is worse than refusing. Both halves of the contract are checked: the renderer takes no such
   * option, and the route that used to send one no longer reads it.
   */
  it('takes no LHDN-branch option, because the 2021 form has no box for one', () => {
    expect(renderCp22Batch.length, 'renderCp22Batch must take (template, records) and nothing else').toBe(2);
    const src = code(path.join(ROOT, 'lib', 'cp22-pdf.ts'));
    expect(src).not.toContain('lhdnBranch');
    const route = code(path.join(ROOT, 'app/payroll/cp22/batch/route.ts'));
    expect(route, 'the batch route must no longer read a branch it cannot print').not.toContain('lhdnBranch');
    const screen = code(path.join(ROOT, 'app/payroll/statutory-forms/page.tsx'));
    expect(screen, 'the screen must not offer an input that goes nowhere').not.toContain('lhdnBranch');
  });

  // A month with no joiners is a 404 at the route. A zero-page PDF is not a document, and producing one
  // silently would be the failure mode this throw exists to make loud.
  it('refuses to produce a document for no records at all', async () => {
    await expect(renderCp22Batch(template(), [])).rejects.toThrow(/no records/);
  });
});
