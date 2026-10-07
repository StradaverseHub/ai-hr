/**
 * r413 (item 79f3f64d, step 2) — CP22A [Pin.1/2023] on LHDN's own page: the field map as DATA, and the
 * properties of the rendered file that fail silently.
 *
 *   1. THE ARTWORK. The bundled file is LHDN's, byte for byte (sha256), two pages of US Letter, and the map
 *      was measured from THAT file — a replaced PDF fails here before any rect is trusted.
 *   2. THE MAP. Every widget inside the page, no two overlapping, every comb's cells as printed, every
 *      `source: 'none'` box named in the UNFILLABLE list with a reason.
 *   3. NOTHING INVENTED. Every `source: 'none'` box is EMPTY in the output even when every other input is
 *      as full as it can be; every typed box is empty until typed.
 *   4. BLANK, NOT 0.00. A section-B line with no source prints nothing in its amount OR its period.
 *   5. A2. retired → Bersara, death → Meninggal dunia, anything else → Berhenti kerja; exactly one X.
 *   6. A COMB NEVER TRUNCATES. A value with more characters than the printed cells leaves the comb empty
 *      and is named by `cp22aOverflowCodes`.
 *   7. IT IS STILL A FORM: two pages, unflattened, NeedAppearances set, appearance text on the page.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFBool, PDFDocument, PDFName } from 'pdf-lib';
import {
  CP22A_FIELDS,
  CP22A_MEDIA_BOX,
  CP22A_PAGE_COUNT,
  CP22A_TYPED,
  CP22A_UNFILLABLE,
  CP22A_UNFILLABLE_REASONS,
  cp22aCombCapacity,
  cp22aWidgetName,
  cp22aWidgets,
} from '../lib/cp22a-fields';
import {
  CP22A_NO_TYPED,
  cp22aDateCells,
  cp22aFieldValues,
  cp22aOverflowCodes,
  cp22aTinCells,
  renderCp22aPdf,
  type Cp22aPdfData,
} from '../lib/cp22a-pdf';
import { cp22aTypedQuery, readCp22aTyped } from '../lib/cp22a-review';
import { cp22aCessationFor } from '../core/reporting';

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'public', 'forms', 'cp22a-pin-1-2023.pdf');
const template = () => new Uint8Array(fs.readFileSync(TEMPLATE));

const FULL_TYPED = {
  deathNotifiedDate: '2026-04-02',
  retirement: 'optional' as const,
  scheme: 'yes' as const,
  rep: { name: 'Ahmad bin Ali', icNo: '700101015555', relationship: 'Anak', address: ['No. 1, Jalan Satu', '43000 Kajang'], phone: '012-1112222' },
};

/** As full as the inputs can be: every record value present, every typed box typed, every pay line set. */
const full = (over: Partial<Cp22aPdfData> = {}): Cp22aPdfData => ({
  employer: { name: 'Acme Sdn Bhd', addressLines: ['No. 12, Jalan Damai 3', 'Taman Damai', '43000 Kajang, Selangor'], eNumber: 'E 9089151-10', phone: '03-87381234' },
  employee: {
    fullName: 'Nur Aisyah binti Rahman',
    icNo: '900101-10-1234',
    passportNo: null,
    taxNo: 'IG 12345678090',
    commencementDate: '2025-01-01',
    cessationDate: '2026-04-20',
    cessation: 'resigned',
    dateOfBirth: '1990-01-01',
    maritalStatus: 'married',
    childrenCount: 2,
    phone: '012-3456789',
    email: 'aisyah@example.test',
    correspondenceAddress: ['PO Box 100', '50450 Kuala Lumpur, Wilayah Persekutuan'],
  },
  spouse: { fullName: 'Rahman bin Osman', icOrPassport: '880202-14-5678' },
  pay: {
    from: '2026-01-01',
    to: '2026-03-31',
    lines: { 1: 15000, 3: 1000, 4: 2000, 5: 3000, 6: 450, 7: 0, 8: 120, 9: 600, 12: 75 },
    line12Items: ['Tunggakan gaji'],
    esos: 500,
  },
  deductions: { pcb: 600, zakat: 30, epf: 1650 },
  officer: { name: 'Siti Officer', designation: 'HR Manager', email: 'siti@acme.test' },
  today: '2026-03-25',
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

/** Every show-text operand in every stream of the file — test/cp22-pdf.test.ts's reader, copied. */
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

/** Every value a field's widgets carry, joined. */
const valueOf = (m: Map<string, string>, name: string, widgets: number): string =>
  Array.from({ length: widgets }, (_, i) => m.get(cp22aWidgetName(name, i)) ?? '').join('|');

describe('r413 · the artwork is LHDN’s CP22A [Pin.1/2023], unaltered', () => {
  it('is the file the map was measured from — sha256, two pages, US Letter on both', async () => {
    const bytes = fs.readFileSync(TEMPLATE);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '01a42b91313ddb584117e776c90c71618073044e6a0f286e06c416ec2f5c756f',
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(CP22A_PAGE_COUNT);
    for (const p of doc.getPages()) expect(p.getMediaBox()).toEqual({ x: 0, y: 0, ...CP22A_MEDIA_BOX });
  });
});

describe('r413 · the field map is data, and it holds', () => {
  it('puts every widget inside its page, and no two widgets on a page overlap', () => {
    const rects = CP22A_FIELDS.flatMap((f) => cp22aWidgets(f).map((r) => ({ code: f.code, page: f.page, ...r })));
    expect(rects.length).toBeGreaterThan(150);
    for (const r of rects) {
      expect(r.x, r.code).toBeGreaterThanOrEqual(0);
      expect(r.y, r.code).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, r.code).toBeLessThanOrEqual(CP22A_MEDIA_BOX.width);
      expect(r.y + r.height, r.code).toBeLessThanOrEqual(CP22A_MEDIA_BOX.height);
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

  it('gives every comb the printed cells — 10 for the E number, 12 per IC, 2+11 per TIN, 2+2+2 per date', () => {
    const cells = (code: string) => CP22A_FIELDS.find((f) => f.code === code)!.groups!.map((g) => g.cells);
    expect(cells('H2')).toEqual([10]);
    for (const c of ['A9', 'A14b', 'A17b']) expect(cells(c), c).toEqual([12]);
    for (const c of ['A10', 'A14c']) expect(cells(c), c).toEqual([2, 11]);
    for (const c of ['A3', 'A4', 'A5', 'A11', 'E5', 'B13diberi']) expect(cells(c), c).toEqual([2, 2, 2]);
    // The group's rect is its first group, and every cell is pitched evenly across the group.
    for (const f of CP22A_FIELDS.filter((x) => x.type === 'comb')) {
      expect(f.rect, f.code).toEqual(f.groups![0].rect);
      for (const g of f.groups!) expect(g.rect.width / g.cells, f.code).toBeGreaterThan(12);
    }
  });

  it('declares every multirow block’s row count against its rows (a row added without its ceiling is r175a)', () => {
    for (const f of CP22A_FIELDS.filter((x) => x.type === 'multirow')) {
      expect(f.rows, f.code).toBe(1 + (f.moreRows?.length ?? 0));
    }
  });

  it('names every unfillable box with a reason, and the list is exactly the `none` boxes', () => {
    expect(Object.keys(CP22A_UNFILLABLE_REASONS).sort()).toEqual([...CP22A_UNFILLABLE].sort());
    for (const [code, reason] of Object.entries(CP22A_UNFILLABLE_REASONS)) expect(reason.length, code).toBeGreaterThan(5);
    // The plan's named blanks are among them: retirement type and scheme are TYPED (not records), and the
    // children's relief amount, the spouse's TIN, leave pay, in-kind allowances, car and section C are none.
    for (const c of ['A13b', 'A14c', 'B2', 'B10', 'B11', 'D1', 'E4', 'C1amount']) expect(CP22A_UNFILLABLE, c).toContain(c);
    expect(CP22A_TYPED.sort()).toEqual(['A17a', 'A17b', 'A17c', 'A17d', 'A17e', 'A5', 'A6a', 'A6b', 'A8a', 'A8b'].sort());
  });

  it('codes are unique and AcroForm names are unique', () => {
    expect(new Set(CP22A_FIELDS.map((f) => f.code)).size).toBe(CP22A_FIELDS.length);
    expect(new Set(CP22A_FIELDS.map((f) => f.name)).size).toBe(CP22A_FIELDS.length);
  });
});

describe('r413 · the rendered CP22A', () => {
  it('is two pages, unflattened, with NeedAppearances, and every widget the map declares', async () => {
    const bytes = await renderCp22aPdf(template(), full());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    for (const p of doc.getPages()) expect(p.getMediaBox()).toEqual({ x: 0, y: 0, ...CP22A_MEDIA_BOX });
    const widgets = CP22A_FIELDS.reduce((n, f) => n + cp22aWidgets(f).length, 0);
    expect(doc.getForm().getFields().length).toBe(widgets);
    expect(doc.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))).toBe(PDFBool.True);
  });

  it('draws the values on the page — appearance streams carry the text, not just /V', async () => {
    const shown = drawnText(await renderCp22aPdf(template(), full())).split('\n');
    for (const text of ['Nur Aisyah binti Rahman', '15,000.00', '600.00', 'X', 'Siti Officer']) {
      expect(shown, text).toContain(text);
    }
  });

  /**
   * NON-VACUITY: delete the "Belt and braces" loop in `cp22aFieldValues` AND add `v.d1Withheld = '1.00'`
   * above it — this case fails naming D1. (Checked by mutation in r413.)
   */
  it('leaves EVERY `source: none` box empty, however full the inputs are', async () => {
    const bytes = await renderCp22aPdf(template(), full());
    const m = await fieldValuesOf(bytes);
    const leaked: string[] = [];
    for (const f of CP22A_FIELDS.filter((x) => x.source === 'none')) {
      const v = valueOf(m, f.name, cp22aWidgets(f).length).replace(/\|/g, '');
      if (v !== '') leaked.push(`${f.code}=${v}`);
    }
    expect(leaked).toEqual([]);
    expect(CP22A_UNFILLABLE.length).toBeGreaterThan(30);
  });

  it('leaves every TYPED box empty until the operator types it, and fills it when they do', async () => {
    const bare = await fieldValuesOf(await renderCp22aPdf(template(), full({ typed: CP22A_NO_TYPED })));
    const typed = await fieldValuesOf(await renderCp22aPdf(template(), full()));
    for (const f of CP22A_FIELDS.filter((x) => x.source === 'typed')) {
      const n = cp22aWidgets(f).length;
      expect(valueOf(bare, f.name, n).replace(/\|/g, ''), f.code).toBe('');
    }
    expect(valueOf(typed, 'deathNotifiedDate', 3)).toBe('02|04|26');
    expect(typed.get('retirementOptional')).toBe('X');
    expect(typed.get('retirementCompulsory')).toBe('');
    expect(typed.get('schemeYes')).toBe('X');
    expect(typed.get('repName')).toBe('Ahmad bin Ali');
    expect(typed.get('repIcNo')).toBe('700101015555');
  });

  /**
   * THE BLANK-NOT-ZERO RULE. Lines 2, 10 and 11 have no source at all; any other line absent from
   * `pay.lines` had nothing that could reach it. Each prints NOTHING — not 0.00, and not a period either.
   * NON-VACUITY: make the B loop in `cp22aFieldValues` write `cp22Amount(amount ?? 0)` for every line
   * 1–12 and this fails naming B4.
   */
  it('prints a line with no source BLANK — amount and period — never 0.00', async () => {
    const d = full({ pay: { from: '2026-01-01', to: '2026-03-31', lines: { 1: 15000, 3: 0, 6: 0 }, line12Items: [], esos: null } });
    const m = await fieldValuesOf(await renderCp22aPdf(template(), d));
    for (const line of [2, 4, 5, 7, 8, 9, 10, 11, 12]) {
      expect(m.get(`b${line}Amount`), `B${line}`).toBe('');
      expect(m.get(`b${line}From`), `B${line} dari`).toBe('');
      expect(m.get(`b${line}To`), `B${line} hingga`).toBe('');
    }
    expect(m.get('b13Amount')).toBe('');
    // …while a line WITH a source and nothing paid says 0.00 — that zero is a fact from the payslips.
    expect(m.get('b3Amount')).toBe('0.00');
    expect(m.get('b1Amount')).toBe('15,000.00');
    expect(m.get('b1From')).toBe('01/01/2026');
    expect(m.get('b1To')).toBe('31/03/2026');
    expect(m.get('bTotal')).toBe('15,000.00');
  });

  it('prints JUMLAH as the sum of exactly the lines it filled', () => {
    const v = cp22aFieldValues(full());
    // 15000 + 1000 + 2000 + 3000 + 450 + 0 + 120 + 600 + 75 + ESOS 500
    expect(v.bTotal).toBe('22,745.00');
    expect(v.b12Specify).toBe('Tunggakan gaji');
  });

  it('leaves B and D entirely blank when no processed payroll falls in the period', () => {
    const v = cp22aFieldValues(full({ pay: { from: null, to: null, lines: {}, line12Items: [], esos: null }, deductions: { pcb: null, zakat: null, epf: null } }));
    for (const k of Object.keys(v)) if (/^b\d/.test(k)) expect(v[k], k).toBe('');
    expect(v.bTotal).toBeUndefined();
    expect([v.d2Pcb, v.d3Zakat, v.d4Epf]).toEqual(['', '', '']);
  });

  it('puts D2 / D3 / D4 on their own leaders', () => {
    const v = cp22aFieldValues(full());
    expect([v.d2Pcb, v.d3Zakat, v.d4Epf]).toEqual(['600.00', '30.00', '1,650.00']);
  });
});

describe('r413 · A2 — the kind of cessation, and exactly one X', () => {
  /** NON-VACUITY: swap the 'retired' and 'death' branches in `cp22aCessationFor` — the first case fails. */
  it('maps retired → Bersara, death → Meninggal dunia, and everything else → Berhenti kerja', () => {
    expect(cp22aCessationFor('retired')).toBe('retired');
    expect(cp22aCessationFor('death')).toBe('death');
    for (const other of ['voluntary', 'involuntary', 'contract_end', 'other', null, undefined]) {
      expect(cp22aCessationFor(other), String(other)).toBe('resigned');
    }
  });

  it('marks exactly one of the three boxes, the right one, in the saved file', async () => {
    const box = { resigned: 'cessationResigned', retired: 'cessationRetired', death: 'cessationDeath' } as const;
    for (const kind of ['resigned', 'retired', 'death'] as const) {
      const d = full();
      const m = await fieldValuesOf(await renderCp22aPdf(template(), { ...d, employee: { ...d.employee, cessation: kind } }));
      const marked = Object.values(box).filter((n) => m.get(n) === 'X');
      expect(marked, kind).toEqual([box[kind]]);
    }
  });
});

describe('r413 · identifiers on LHDN’s character cells', () => {
  it('strips the E the form prints, writes the IC as digits, splits the TIN prefix from its digits', () => {
    const v = cp22aFieldValues(full());
    expect(v.employerNo).toEqual(['9089151-10']);
    expect(v.icNo).toEqual(['900101101234']);
    expect(v.taxNo).toEqual(['IG', '12345678090']);
    expect(v.spouseIcNo).toEqual(['880202145678']);
    expect(v.commencementDate).toEqual(['01', '01', '25']);
    expect(cp22aDateCells('2026-04-20')).toEqual(['20', '04', '26']);
  });

  /** NON-VACUITY: make `cp22aIdCells` slice to 12 instead of returning null and this fails (A9 is filled). */
  it('NEVER truncates: an identifier longer than its cells leaves the comb empty and is named', async () => {
    const d = full();
    const long = { ...d, employee: { ...d.employee, icNo: null, passportNo: 'AB1234567890123' }, typed: CP22A_NO_TYPED };
    expect(cp22aOverflowCodes(long)).toContain('A9');
    const m = await fieldValuesOf(await renderCp22aPdf(template(), long));
    expect(m.get('icNo')).toBe('');
    expect(cp22aTinCells('SG 123456789012')).toBeNull();
    expect(cp22aOverflowCodes(full())).toEqual([]);
  });

  it('every comb value fits its cells', () => {
    const v = cp22aFieldValues(full());
    for (const f of CP22A_FIELDS.filter((x) => x.type === 'comb' && x.source !== 'none')) {
      const parts = (v[f.name] as string[] | undefined) ?? [];
      parts.forEach((p, i) => expect(p.length, `${f.code}[${i}]`).toBeLessThanOrEqual(f.groups![i].cells));
      expect(parts.join('').length, f.code).toBeLessThanOrEqual(cp22aCombCapacity(f));
    }
  });
});

describe('r413 · the typed boxes travel in the query string and are allowlisted', () => {
  it('round-trips, and drops what is not a real answer', () => {
    const q = cp22aTypedQuery(FULL_TYPED);
    expect(readCp22aTyped(q)).toEqual(FULL_TYPED);
    const bad = readCp22aTyped(new URLSearchParams({ a5: '2026-02-30', a6: 'early', a8: 'maybe' }));
    expect(bad.deathNotifiedDate).toBeNull();
    expect(bad.retirement).toBeNull();
    expect(bad.scheme).toBeNull();
  });
});
