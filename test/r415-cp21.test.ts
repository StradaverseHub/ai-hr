/**
 * r415 (item 79f3f64d, step 3) — CP21 [Pin.1/2025] on LHDN's own page: the field map as DATA, the typed
 * boxes' allowlist, and the properties of the rendered file that fail silently.
 *
 *   1. THE ARTWORK. The bundled file is LHDN's, byte for byte (sha256), two A4 pages, and the map was
 *      measured from THAT file.
 *   2. THE MAP. Every widget inside the page, no two overlapping, every comb's cells as printed, every
 *      `source: 'none'` box named in the UNFILLABLE list with a reason, both ways.
 *   3. NOTHING INVENTED. Every `none` box is EMPTY with the fullest inputs; every typed box is empty until typed.
 *   4. BLANK, NOT 0.00. A section-B line with no source prints nothing in its amount OR its period.
 *   5. THE TYPED BOXES are checked against what they may be, and what fails is dropped and named.
 *   6. CP22 AND CP22A DID NOT MOVE: their renderers, maps, templates and routes are byte-identical to the
 *      commit this round was cut from, so their bytes cannot have changed because of CP21.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFBool, PDFDocument, PDFName } from 'pdf-lib';
import {
  CP21_FIELDS,
  CP21_MEDIA_BOX,
  CP21_PAGE_COUNT,
  CP21_TYPED,
  CP21_UNFILLABLE,
  CP21_UNFILLABLE_REASONS,
  cp21CombCapacity,
  cp21WidgetName,
  cp21Widgets,
} from '../lib/cp21-fields';
import { CP21_NO_TYPED, cp21FieldValues, cp21OverflowCodes, renderCp21Pdf, type Cp21PdfData } from '../lib/cp21-pdf';
import { cp21TypedQuery, cp21TypedRejections, readCp21Typed } from '../lib/cp21-review';

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'public', 'forms', 'cp21-pin-1-2025.pdf');
const template = () => new Uint8Array(fs.readFileSync(TEMPLATE));
/** The commit this round was cut from. The no-change claims below are made AGAINST it, by name. */
const BASELINE = 'f6a540b0';

const FULL_TYPED = {
  departureDate: '2026-11-30',
  reason: 'Transfer to the Singapore office',
  overseasAddress: ['10 Anson Road', '#20-01 International Plaza', 'Singapore 079903'],
  returnDate: '2027-06-01',
  scheme: 'no' as const,
};

/** As full as the inputs can be: every record value present, every typed box typed, every pay line set. */
const full = (over: Partial<Cp21PdfData> = {}): Cp21PdfData => ({
  employer: { name: 'Acme Sdn Bhd', addressLines: ['No. 12, Jalan Damai 3', 'Taman Damai', '43000 Kajang, Selangor'], eNumber: 'E 9089151-10', phone: '03-87381234' },
  employee: {
    fullName: 'Lim Wei Ming',
    icNo: '900101-10-1234',
    passportNo: null,
    taxNo: 'IG 12345678090',
    commencementDate: '2025-01-01',
    resident: true,
    citizen: 'Malaysian',
    dateOfBirth: '1990-01-01',
    natureOfEmployment: 'Senior Engineer',
    phone: '012-3456789',
    email: 'weiming@example.test',
    correspondenceAddress: ['PO Box 100', '50450 Kuala Lumpur, Wilayah Persekutuan'],
    taxBorneByEmployer: false,
  },
  pay: {
    from: '2026-01-01',
    to: '2026-09-30',
    lines: { 1: 45000, 3: 1000, 4: 2000, 5: 3000, 6: 450, 7: 0, 8: 120, 9: 600, 11: 575 },
    line11Items: ['Tunggakan gaji', 'Manfaat Skim Pemberian Saham (ESOS)'],
  },
  deductions: { pcb: 2700, zakat: 90, epf: 4950 },
  officer: { name: 'Siti Officer', designation: 'HR Manager', email: 'siti@acme.test' },
  today: '2026-10-08',
  typed: FULL_TYPED,
  ...over,
});

/** Every field's value as it lands in the SAVED file, read back through pdf-lib's AcroForm. */
async function fieldValuesOf(bytes: Uint8Array): Promise<Map<string, string>> {
  const doc = await PDFDocument.load(bytes);
  const out = new Map<string, string>();
  for (const f of doc.getForm().getFields()) {
    const tf = f as unknown as { getText?: () => string | undefined };
    out.set(f.getName(), tf.getText?.() ?? '');
  }
  return out;
}

/** Every show-text operand in every stream of the file — test/r413-cp22a.test.ts's reader. */
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

const valueOf = (m: Map<string, string>, name: string, widgets: number): string =>
  Array.from({ length: widgets }, (_, i) => m.get(cp21WidgetName(name, i)) ?? '').join('|');

describe('r415 · the artwork is LHDN’s CP21 [Pin.1/2025], unaltered', () => {
  it('is the file the map was measured from — sha256, two pages, A4 on both', async () => {
    const bytes = fs.readFileSync(TEMPLATE);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '5d6cfc9608dd6c3c1f2adbc37efd8fe785609c0a2eb9e7c299c77a8b74b4ea1c',
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(CP21_PAGE_COUNT);
    expect(CP21_PAGE_COUNT).toBe(2);
    for (const p of doc.getPages()) {
      const box = p.getMediaBox();
      expect(box.x).toBe(0);
      expect(box.y).toBe(0);
      expect(box.width).toBeCloseTo(CP21_MEDIA_BOX.width, 2);
      expect(box.height).toBeCloseTo(CP21_MEDIA_BOX.height, 2);
    }
  });
});

describe('r415 · the field map is data, and it holds', () => {
  it('puts every widget inside its page, and no two widgets on a page overlap', () => {
    const rects = CP21_FIELDS.flatMap((f) => cp21Widgets(f).map((r) => ({ code: f.code, page: f.page, ...r })));
    expect(rects.length).toBeGreaterThan(110);
    for (const r of rects) {
      expect(r.x, r.code).toBeGreaterThanOrEqual(0);
      expect(r.y, r.code).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, r.code).toBeLessThanOrEqual(CP21_MEDIA_BOX.width);
      expect(r.y + r.height, r.code).toBeLessThanOrEqual(CP21_MEDIA_BOX.height);
      expect(r.width, r.code).toBeGreaterThan(5);
      expect(r.height, r.code).toBeGreaterThan(5);
    }
    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a.page !== b.page) continue;
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (ox > 0.01 && oy > 0.01) overlaps.push(`${a.code}×${b.code}`);
      }
    expect(overlaps).toEqual([]);
  });

  it('gives every comb the printed cells — 10 for the E number, 12 for the IC, 2+11 for the TIN, 2+2+2 per date', () => {
    const cells = (code: string) => CP21_FIELDS.find((f) => f.code === code)!.groups!.map((g) => g.cells);
    expect(cells('H2')).toEqual([10]);
    expect(cells('A5')).toEqual([12]);
    expect(cells('A6')).toEqual([2, 11]);
    for (const c of ['A2', 'A3', 'A8', 'E5']) expect(cells(c), c).toEqual([2, 2, 2]);
    for (const f of CP21_FIELDS.filter((x) => x.type === 'comb')) {
      expect(f.rect, f.code).toEqual(f.groups![0].rect);
      for (const g of f.groups!) expect(g.rect.width / g.cells, f.code).toBeGreaterThan(15);
    }
  });

  it('declares every multirow block’s row count against its rows', () => {
    for (const f of CP21_FIELDS.filter((x) => x.type === 'multirow')) expect(f.rows, f.code).toBe(1 + (f.moreRows?.length ?? 0));
  });

  /** NON-VACUITY: give A9 `source: 'record'` and this fails (the list loses A9, the reasons keep it). */
  it('names every unfillable box with a reason, and the list is exactly the `none` boxes', () => {
    expect(Object.keys(CP21_UNFILLABLE_REASONS).sort()).toEqual([...CP21_UNFILLABLE].sort());
    for (const [code, reason] of Object.entries(CP21_UNFILLABLE_REASONS)) expect(reason.length, code).toBeGreaterThan(5);
    // Place of birth has no column; the brief and the plan both name it.
    expect(CP21_UNFILLABLE).toContain('A9');
    expect(CP21_UNFILLABLE_REASONS.A9).toMatch(/no column/i);
    for (const c of ['B2', 'B10', 'D1', 'E4', 'C1amount', 'H4a', 'A13x']) expect(CP21_UNFILLABLE, c).toContain(c);
    expect([...CP21_TYPED].sort()).toEqual(['A14', 'A15', 'A16', 'A18a', 'A18b', 'A3'].sort());
  });

  it('codes are unique and AcroForm names are unique', () => {
    expect(new Set(CP21_FIELDS.map((f) => f.code)).size).toBe(CP21_FIELDS.length);
    expect(new Set(CP21_FIELDS.map((f) => f.name)).size).toBe(CP21_FIELDS.length);
  });

  it('has CP21’s eleven section-B lines and no share-scheme line (that is CP22A’s 13th)', () => {
    const lines = CP21_FIELDS.filter((f) => /^B\d+$/.test(f.code)).map((f) => f.code);
    expect(lines).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11']);
  });
});

describe('r415 · the rendered CP21', () => {
  it('is two A4 pages, unflattened, with NeedAppearances, and every widget the map declares', async () => {
    const bytes = await renderCp21Pdf(template(), full());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    for (const p of doc.getPages()) expect(p.getSize().width).toBeCloseTo(595.32, 2);
    const widgets = CP21_FIELDS.reduce((n, f) => n + cp21Widgets(f).length, 0);
    expect(doc.getForm().getFields().length).toBe(widgets);
    expect(doc.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
  });

  it('draws the values on the page — appearance streams carry the text, not just /V', async () => {
    const shown = drawnText(await renderCp21Pdf(template(), full())).split('\n');
    for (const text of ['Lim Wei Ming', '45,000.00', '2,700.00', 'X', 'Siti Officer', 'Malaysian', 'Senior Engineer']) {
      expect(shown, text).toContain(text);
    }
  });

  /**
   * NON-VACUITY: delete the "Belt and braces" loop in `cp21FieldValues` AND add `v.placeOfBirth = 'Ipoh'`
   * above it — this case fails naming A9.
   */
  it('leaves EVERY `source: none` box empty, however full the inputs are', async () => {
    const m = await fieldValuesOf(await renderCp21Pdf(template(), full()));
    const leaked: string[] = [];
    for (const f of CP21_FIELDS.filter((x) => x.source === 'none')) {
      const v = valueOf(m, f.name, cp21Widgets(f).length).replace(/\|/g, '');
      if (v !== '') leaked.push(`${f.code}=${v}`);
    }
    expect(leaked).toEqual([]);
    expect(CP21_UNFILLABLE.length).toBeGreaterThan(25);
  });

  it('leaves every TYPED box empty until the operator types it, and fills it when they do', async () => {
    const bare = await fieldValuesOf(await renderCp21Pdf(template(), full({ typed: CP21_NO_TYPED })));
    const typed = await fieldValuesOf(await renderCp21Pdf(template(), full()));
    for (const f of CP21_FIELDS.filter((x) => x.source === 'typed')) {
      expect(valueOf(bare, f.name, cp21Widgets(f).length).replace(/\|/g, ''), f.code).toBe('');
    }
    expect(valueOf(typed, 'departureDate', 3)).toBe('30|11|26');
    expect(typed.get('returnDate')).toBe('01/06/2027');
    expect(typed.get('schemeNo')).toBe('X');
    expect(typed.get('schemeYes')).toBe('');
    expect(typed.get('departureReason')).toBe('Transfer to the Singapore office');
    expect(typed.get('overseasAddress')).toBe('10 Anson Road');
  });

  /**
   * THE BLANK-NOT-ZERO RULE. Lines 2 and 10 have no source at all; any other line absent from `pay.lines`
   * had nothing that could reach it. Each prints NOTHING — not 0.00, and not a period either.
   * NON-VACUITY: make the B loop in `cp21FieldValues` iterate lines 1–11 writing `cp22Amount(amount ?? 0)`
   * and this fails naming B4.
   */
  it('prints a line with no source BLANK — amount and period — never 0.00', async () => {
    const d = full({ pay: { from: '2026-01-01', to: '2026-09-30', lines: { 1: 45000, 3: 0, 6: 0 }, line11Items: [] } });
    const m = await fieldValuesOf(await renderCp21Pdf(template(), d));
    for (const line of [2, 4, 5, 7, 8, 9, 10, 11]) {
      expect(m.get(`b${line}Amount`), `B${line}`).toBe('');
      expect(m.get(`b${line}From`), `B${line} dari`).toBe('');
      expect(m.get(`b${line}To`), `B${line} hingga`).toBe('');
    }
    expect(m.get('b11Specify')).toBe('');
    // …while a line WITH a source and nothing paid says 0.00 — that zero is a fact from the payslips.
    expect(m.get('b3Amount')).toBe('0.00');
    expect(m.get('b1Amount')).toBe('45,000.00');
    expect(m.get('b1From')).toBe('01/01/2026');
    expect(m.get('b1To')).toBe('30/09/2026');
    expect(m.get('bTotal')).toBe('45,000.00');
  });

  it('prints JUMLAH as the sum of exactly the lines it filled, and names line 11', () => {
    const v = cp21FieldValues(full());
    // 45000 + 1000 + 2000 + 3000 + 450 + 0 + 120 + 600 + 575
    expect(v.bTotal).toBe('52,745.00');
    expect(v.b11Specify).toBe('Tunggakan gaji; Manfaat Skim Pemberian Saham (ESOS)');
  });

  it('leaves B and D entirely blank when no processed payroll falls in the period', () => {
    const v = cp21FieldValues(full({ pay: { from: null, to: null, lines: {}, line11Items: [] }, deductions: { pcb: null, zakat: null, epf: null } }));
    for (const k of Object.keys(v)) if (/^b\d/.test(k)) expect(v[k], k).toBe('');
    expect(v.bTotal).toBeUndefined();
    expect([v.d2Pcb, v.d3Zakat, v.d4Epf]).toEqual(['', '', '']);
  });

  it('puts D2 / D3 / D4 on their own leaders, and D1 nowhere', () => {
    const v = cp21FieldValues(full());
    expect([v.d2Pcb, v.d3Zakat, v.d4Epf]).toEqual(['2,700.00', '90.00', '4,950.00']);
    expect(v.d1Withheld).toBeUndefined();
  });

  it('A4 and A17: Ya for true, Tidak for false, NEITHER for null — exactly one or no X', () => {
    for (const [val, yes, no] of [
      [true, 'X', ''],
      [false, '', 'X'],
      [null, '', ''],
    ] as const) {
      const d = full();
      const v = cp21FieldValues({ ...d, employee: { ...d.employee, resident: val, taxBorneByEmployer: val } });
      expect([v.residentYes, v.residentNo], `A4 ${val}`).toEqual([yes, no]);
      expect([v.taxBorneYes, v.taxBorneNo], `A17 ${val}`).toEqual([yes, no]);
    }
  });
});

describe('r415 · identifiers on LHDN’s character cells', () => {
  it('strips the E the form prints, writes the IC as digits, splits the TIN prefix from its digits', () => {
    const v = cp21FieldValues(full());
    expect(v.employerNo).toEqual(['9089151-10']);
    expect(v.icNo).toEqual(['900101101234']);
    expect(v.taxNo).toEqual(['IG', '12345678090']);
    expect(v.commencementDate).toEqual(['01', '01', '25']);
    expect(v.dateOfBirth).toEqual(['01', '01', '90']);
    expect(v.declarationDate).toEqual(['08', '10', '26']);
  });

  it('NEVER truncates: an identifier longer than its cells leaves the comb empty and is named', async () => {
    const d = full();
    const long = { ...d, employee: { ...d.employee, icNo: null, passportNo: 'AB1234567890123' } };
    expect(cp21OverflowCodes(long)).toEqual(['A5']);
    const m = await fieldValuesOf(await renderCp21Pdf(template(), long));
    expect(m.get('icNo')).toBe('');
    expect(cp21OverflowCodes(full())).toEqual([]);
  });

  it('every comb value fits its cells', () => {
    const v = cp21FieldValues(full());
    for (const f of CP21_FIELDS.filter((x) => x.type === 'comb' && x.source !== 'none')) {
      const parts = (v[f.name] as string[] | undefined) ?? [];
      parts.forEach((p, i) => expect(p.length, `${f.code}[${i}]`).toBeLessThanOrEqual(f.groups![i].cells));
      expect(parts.join('').length, f.code).toBeLessThanOrEqual(cp21CombCapacity(f));
    }
  });
});

describe('r415 · the typed boxes travel in the query string and are checked', () => {
  it('round-trips a full set of answers', () => {
    expect(readCp21Typed(cp21TypedQuery(FULL_TYPED))).toEqual(FULL_TYPED);
    expect(cp21TypedRejections(cp21TypedQuery(FULL_TYPED))).toEqual([]);
  });

  /**
   * NON-VACUITY: drop the `returnDate <= departureDate` check in lib/cp21-review.ts and the second case
   * fails (A16 is kept); make `isRealIsoDate` a bare regex test and the first fails (2026-02-30 is kept).
   */
  it('drops what is not an allowed answer, and names it', () => {
    const q = new URLSearchParams({ a3: '2026-02-30', a16: 'soon', a18: 'maybe' });
    const t = readCp21Typed(q);
    expect([t.departureDate, t.returnDate, t.scheme]).toEqual([null, null, null]);
    expect(cp21TypedRejections(q).sort()).toEqual(['A16', 'A18', 'A3']);

    const before = new URLSearchParams({ a3: '2026-11-30', a16: '2026-11-01' });
    expect(readCp21Typed(before).returnDate).toBeNull();
    expect(readCp21Typed(before).departureDate).toBe('2026-11-30');
    expect(cp21TypedRejections(before)).toEqual(['A16']);
    // The same day is not a return either.
    expect(readCp21Typed(new URLSearchParams({ a3: '2026-11-30', a16: '2026-11-30' })).returnDate).toBeNull();
  });

  it('strips control characters, caps the length and keeps empty as empty', () => {
    const t = readCp21Typed(new URLSearchParams({ a14: `A\u0000B\u0007C${'x'.repeat(500)}`, a15: 'line 1\n\n line 2 \n' }));
    expect(t.reason!.startsWith('A B C')).toBe(true);
    expect(t.reason!.length).toBeLessThanOrEqual(200);
    expect(t.overseasAddress).toEqual(['line 1', 'line 2']);
    expect(readCp21Typed(new URLSearchParams())).toEqual(CP21_NO_TYPED);
    expect(cp21TypedRejections(new URLSearchParams())).toEqual([]);
  });
});

describe('r415 · CP22 and CP22A did not move', () => {
  /**
   * CP21 reuses CP22A's helpers and CP22's fitting by IMPORT, never by edit. Every file that decides a CP22
   * or CP22A byte — renderer, field map, typed-box reader, template reader, artwork, routes, preview — is
   * byte-identical to the base commit; the one shared read that changed (cp22aParticulars → lhdnYearSoFar)
   * is proven equal on a real payroll in test/r415-cp21-particulars.test.ts.
   * NON-VACUITY: change CP22A_DEFAULT_FONT_SIZE in lib/cp22a-fields.ts and this fails naming that file.
   */
  it('leaves every CP22 and CP22A renderer, map, template and route byte-identical to the base commit', () => {
    const files = [
      'lib/cp22-pdf.ts',
      'lib/cp22-fields.ts',
      'lib/cp22-review.ts',
      'lib/cp22-template.ts',
      'lib/cp22a-pdf.ts',
      'lib/cp22a-fields.ts',
      'lib/cp22a-review.ts',
      'lib/cp22a-template.ts',
      'public/forms/cp22-pin-1-2021.pdf',
      'public/forms/cp22a-pin-1-2023.pdf',
      'app/payroll/cp22/[employmentId]/preview/page.tsx',
      'app/payroll/cp22/[employmentId]/pdf/route.ts',
      'app/payroll/cp22a/[employmentId]/preview/page.tsx',
      'app/payroll/cp22a/[employmentId]/pdf/route.ts',
    ];
    for (const f of files) {
      const now = fs.readFileSync(path.join(ROOT, f), 'latin1');
      const then = execFileSync('git', ['show', `${BASELINE}:${f}`], { cwd: ROOT, encoding: 'latin1', maxBuffer: 1 << 26 });
      expect(now.length, f).toBeGreaterThan(500);
      expect(now === then, f).toBe(true);
    }
  });
});
