import fs from 'node:fs';
/**
 * ADR-0036 (#22) — payslip PDF renderer. A pure function over the payslipDetail read + localized labels;
 * here we assert it produces a real (%PDF) document of non-trivial size and degrades gracefully on null
 * fields + non-Latin names (the WinAnsi safe-encode guard, until a Unicode font is embedded).
 *
 * 5c198931 REBUILT THE DOCUMENT onto A4 and these tests grew with it. The defect they pin is narrow and
 * specific: the DOWNLOADED payslip was a half page — no logo, no payment date, no identity or statutory
 * numbers, no year-to-date, no bank details, no HRD Corp levy, and "RM" hardcoded onto every amount
 * regardless of the company's currency — while the screen beside it had all of that. So the assertions
 * below are about what the FILE now carries, and about the one thing the redesign could have broken:
 * printing named pay items instead of a lumped Allowances row must never put rows on the page that fail
 * to add up to the total beside them. That guard has its own test, and it is the important one.
 */
import zlib from 'node:zlib';
import { PDFDocument,PDFName,PDFDict } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildPayslipPdfData, renderPayslipPdf, type PayslipPdfData } from '../lib/payslip-pdf';
// a96d320c — the payment date is resolved to words SERVER-side, in the same module that already resolves
// the pay period to a month name. Imported directly so the formatter is pinned as a function rather than
// through a label fixture the test writes itself.
import { englishLongDate, payslipPaymentDate } from '../lib/payslip-pdf-strings';

import { data, labels } from './fixtures/payslip-pdf-fixture';
const head = (b: Uint8Array) => Buffer.from(b.slice(0, 5)).toString('latin1');
/** How many sheets the renderer actually produced. Read back through pdf-lib rather than grepped: `save()`
 *  packs the page dictionaries into compressed object streams, so `/Type /Page` is not in the raw bytes. */
const pageCount = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

/**
 * The text pdf-lib actually DREW, recovered from the page content streams.
 *
 * A size-delta assertion (the technique the pre-5c198931 tests used) proves a document grew; it cannot
 * prove WHAT it grew by, and this redesign is entirely about which words and figures reach the page. So
 * the content streams are inflated and the Tj/TJ string operands are pulled out. Nothing here parses PDF
 * in general — it reads back what this one renderer wrote, which is exactly the scope needed.
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
    // skip the EOL that follows the `stream` keyword
    let b = s + 6;
    if (buf[b] === 0x0d) b += 1;
    if (buf[b] === 0x0a) b += 1;
    const raw = buf.subarray(b, e);
    let body: Buffer;
    try {
      body = zlib.inflateSync(raw);
    } catch {
      body = raw; // uncompressed content stream — read it as-is
    }
    out.push(body.toString('latin1'));
    i = e + 9;
  }
  const all = out.join('\n');
  // pdf-lib writes show-text operands as HEX strings (`<44656D6F> Tj`) whose bytes are the font's WinAnsi
  // encoding — which is exactly what `safe()` has already narrowed the text to, so latin1 round-trips it.
  // The literal `(text) Tj` form is handled too, in case a future pdf-lib emits it.
  return [...all.matchAll(/(?:<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\))\s*Tj/g)]
    .map((m) =>
      m[1] != null
        ? Buffer.from(m[1].replace(/\s+/g, ''), 'hex').toString('latin1')
        : m[2].replace(/\\([()\\])/g, '$1'),
    )
    .join('\n');
}

/**
 * The text AND WHERE IT WAS PUT, per page — for assertions about the LAYOUT rather than the contents.
 *
 * f35f758a rev 2 pairs Earnings with Deductions and gives NET PAY the full width, and "side by side" is a
 * claim about coordinates that no amount of string matching can check: a stacked document and a paired one
 * contain exactly the same words in exactly the same order. pdf-lib writes every run as
 * `1 0 0 1 X Y Tm` followed by `<hex> Tj`, so the placement is recoverable from the same content streams
 * `drawnText` already reads. Verified against the real artefact with `pdftotext -bbox` (r185-a).
 */
function drawnPlacements(bytes: Uint8Array): { page: number; x: number; y: number; text: string }[] {
  const buf = Buffer.from(bytes);
  const out: { page: number; x: number; y: number; text: string }[] = [];
  let i = 0;
  let page = 0;
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
    const src = body.toString('latin1');
    // Content streams carrying show-text operators ARE the page streams, in page order.
    if (/\bTj\b/.test(src)) {
      page += 1;
      for (const m of src.matchAll(
        /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm[\s\S]{0,80}?(?:<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\))\s*Tj/g,
      )) {
        const text =
          m[3] != null
            ? Buffer.from(m[3].replace(/\s+/g, ''), 'hex').toString('latin1')
            : (m[4] ?? '').replace(/\\([()\\])/g, '$1');
        out.push({ page, x: Number(m[1]), y: Number(m[2]), text });
      }
    }
    i = e + 9;
  }
  return out;
}

/** Where a piece of drawn text landed, or undefined. First match wins — headings are drawn once. */
const placed = (p: ReturnType<typeof drawnPlacements>, text: string) => p.find((r) => r.text === text);

/**
 * a96d320c — THE RECTANGLES, per page, so "bordered" is checkable rather than asserted.
 *
 * The reporter asked for full borders. "The YTD table is in a box" is a claim about geometry, and a
 * document that draws the same words with no rules around them contains exactly the same text — which is
 * the trap `drawnPlacements` was written for one item ago. pdf-lib emits a rectangle as a translate
 * (`1 0 0 1 X Y cm`) followed by the four-segment path and a paint operator: `S` when it was given a
 * `borderColor` (a ruled box) and `f` when it was given a `color` (a filled band). Both are captured;
 * the tests below ask for `S`, because a filled band is not a border.
 */
function drawnRects(bytes: Uint8Array): { page: number; x: number; y: number; w: number; h: number; op: string }[] {
  const buf = Buffer.from(bytes);
  const out: { page: number; x: number; y: number; w: number; h: number; op: string }[] = [];
  let i = 0;
  let page = 0;
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
    const src = body.toString('latin1');
    if (/\bTj\b/.test(src)) {
      page += 1;
      for (const m of src.matchAll(
        /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm[\s\S]{0,60}?0 0 m\s+0 (-?[\d.]+) l\s+(-?[\d.]+) -?[\d.]+ l\s+-?[\d.]+ 0 l\s+h\s+([SfB])/g,
      )) {
        out.push({ page, x: Number(m[1]), y: Number(m[2]), w: Number(m[4]), h: Number(m[3]), op: m[5] });
      }
    }
    i = e + 9;
  }
  return out;
}

/**
 * a96d320c rev 2 — THE LINES, per page, with their colour and width.
 *
 * `drawnRects` reads rectangles; the row hairlines inside a box are `drawLine` calls, and one of them was
 * being drawn ON TOP of the box's own bottom border — a 0.5pt HAIR over a 0.8pt RULE, which washes the
 * border out to near-white for its whole length and leaves 0.15pt of colour either side. That is a claim
 * about two overlapping strokes; no amount of text or rectangle matching can see it. pdf-lib emits a line
 * as `R G B RG`, `W w`, `[] 0 d`, a doubled `m`, an `l` and `S`.
 */
function drawnLines(
  bytes: Uint8Array,
): { page: number; x1: number; y1: number; x2: number; y2: number; w: number; color: string }[] {
  const buf = Buffer.from(bytes);
  const out: { page: number; x1: number; y1: number; x2: number; y2: number; w: number; color: string }[] = [];
  let i = 0;
  let page = 0;
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
    const src = body.toString('latin1');
    if (/\bTj\b/.test(src)) {
      page += 1;
      for (const m of src.matchAll(
        /([\d.]+) ([\d.]+) ([\d.]+) RG\s+([\d.]+) w\s+\[\] 0 d\s+(-?[\d.]+) (-?[\d.]+) m\s+-?[\d.]+ -?[\d.]+ m\s+(-?[\d.]+) (-?[\d.]+) l\s+S/g,
      )) {
        out.push({
          page,
          x1: Number(m[5]),
          y1: Number(m[6]),
          x2: Number(m[7]),
          y2: Number(m[8]),
          w: Number(m[4]),
          color: `${m[1]},${m[2]},${m[3]}`,
        });
      }
    }
    i = e + 9;
  }
  return out;
}

/**
 * a96d320c rev 2 — EVERY FILLED BAND THAT WAS PAINTED OVER A BORDER ALREADY ON THE PAGE.
 *
 * THE DEFECT THE REPORTER CIRCLED, FOUR TIMES. A band is a filled rectangle with no border of its own, at
 * the box's own x and the box's own width. Drawn AFTER the box outline it covers that outline's left and
 * right edges for its own height — a notch out of the border at the top-left and top-right of every box.
 * `drawnRects` returns rectangles in the order the renderer emitted them, which is the whole content of
 * the claim: an `f` that comes after an `S` whose edge it covers is a notch, and one that comes before it
 * is not. Nothing here measures pixels; it reads the paint order, which is what decides the picture.
 */
const bandsPaintedOverABorder = (rects: ReturnType<typeof drawnRects>) =>
  rects.filter(
    (f, i) =>
      f.op === 'f' &&
      rects.some((box, j) => {
        if (box.op !== 'S' || j >= i || box.page !== f.page) return false;
        // Do the two overlap vertically at all? If not, the fill is somewhere else on the sheet.
        const yOverlap = Math.min(f.y + f.h, box.y + box.h) - Math.max(f.y, box.y);
        if (yOverlap <= 0) return false;
        // ...and does the fill reach either of the box's two vertical edges?
        const covers = (edgeX: number) => f.x <= edgeX + 0.01 && f.x + f.w >= edgeX - 0.01;
        return covers(box.x) || covers(box.x + box.w);
      }),
  );

/** The RULED box that encloses a piece of drawn text, or undefined. A filled band (`f`) is not a border. */
const enclosingRule = (
  rects: ReturnType<typeof drawnRects>,
  pt: { page: number; x: number; y: number } | undefined,
) =>
  pt == null
    ? undefined
    : rects.find(
        (r) => r.op === 'S' && r.page === pt.page && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h,
      );

// A 1×1 PNG. Real bytes, because embedPng is what we are exercising — a fake buffer would only prove the
// catch block works.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('ADR-0036 — payslip PDF', () => {
  it('renders a real PDF document of non-trivial size', async () => {
    const bytes = await renderPayslipPdf(data, labels);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(head(bytes)).toBe('%PDF-');
  });

  it('renders a distinct CP38 deduction line when cp38 > 0 (web/PDF parity)', async () => {
    // 970e4143 — the fixture now encodes the kernel's model (the instalment is INSIDE other_deductions and
    // is carved back out of the residual), so this case cannot pass on a document that double-counts it.
    const withCp38 = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          cp38: 200, otherDeductions: 200, totalDeductions: 1299.65, net: 5820.35,
          absence: { unpaidLeave: null, absent: null, cp38: { amount: 200, show: true }, residual: 0, showResidual: false, any: false },
        },
        labels,
      ),
    );
    expect(withCp38).toContain('CP38');
    expect(withCp38).toContain('MYR 200.00');
    // And a zero CP38 omits the row entirely rather than printing a 0.00 line nobody asked about.
    expect(drawnText(await renderPayslipPdf({ ...data, cp38: 0 }, labels))).not.toContain('CP38');
  });

  /**
   * 3a092cf0 — THE DOCUMENT HAD NO ZAKAT ROW AT ALL, and until the kernel was fixed that was invisibly
   * consistent: `total_deductions` excluded the zakat, so a box printing EPF/SOCSO/EIS/PCB and nothing
   * else added up exactly. The kernel charges zakat now, so a document without the row would print a
   * TOTAL DEDUCTIONS larger than the rows above it by the zakat — a payslip that does not add up, which
   * is the complaint the item was raised about, reproduced in the one artefact an employee keeps.
   *
   * The figures are SIG01's own, measured on production 2026-09-08: gross 4,308.00, EPF 410.00,
   * SOCSO 18.75, EIS 7.50, PCB 0.00 (7.90 zeroed by the RM10 remittance floor), zakat 30.00 —
   * total 466.25, net 3,841.75.
   *
   * The assertion is ARITHMETIC OVER THE DRAWN PAGE, not a substring: the amounts on the deduction
   * rows are read back beside their labels and summed, and the sum must equal the total the box
   * prints. Asserting only that 'Zakat' appears somewhere would pass on a document that printed the
   * row and left it out of the total — which is precisely the defect.
   */
  it('prints a Zakat row, and the deduction rows then SUM to the TOTAL DEDUCTIONS it prints', async () => {
    const sig01: PayslipPdfData = {
      ...data,
      basic: 3708, allowance: 600, overtime: 0, bonus: 0, gross: 4308,
      epfEmployee: 410, socsoEmployee: 18.75, socsoSkbbk: 0, eisEmployee: 7.5, pcb: 0, cp38: 0,
      zakat: 30, otherDeductions: 0,
      totalDeductions: 466.25, net: 3841.75,
    };
    const pl = drawnPlacements(await renderPayslipPdf(sig01, labels));
    /** The amount drawn on the SAME baseline as `label` — how a reader reads a row off the page. */
    const amountBeside = (label: string) => {
      const row = placed(pl, label);
      if (!row) throw new Error(`no row labelled ${label} on the page`);
      const amt = pl.find((r) => r.page === row.page && Math.abs(r.y - row.y) < 1.5 && r.x > row.x && r.text.startsWith('MYR'));
      if (!amt) throw new Error(`row ${label} drew no amount`);
      return Number(amt.text.replace(/^MYR\s*/, '').replace(/,/g, ''));
    };

    expect(amountBeside('Zakat')).toBe(30);
    // Every employee-side deduction line the box prints, added up the way the reporter added them up.
    //
    // ⚠️ 970e4143 — CP38 AND "OTHER DEDUCTIONS" JOIN THIS LIST, and their absence is why the only drawn-page
    // arithmetic assertion in the repo was blind to a double count present on every affected payslip. The
    // list was hard-coded to EPF/SOCSO/EIS/PCB/Zakat over a fixture pinning `cp38: 0, otherDeductions: 0`,
    // so the two rows that failed to reconcile were neither drawn nor summed. A label with no row on the
    // page is skipped, so listing them costs the zakat case nothing.
    const DEDUCTION_LABELS = ['EPF', 'SOCSO', 'EIS', 'PCB', 'CP38', 'Zakat', 'Other deductions'] as const;
    const sumOfRows = (pls: ReturnType<typeof drawnPlacements>) => {
      const beside = (label: string) => {
        const row = placed(pls, label);
        if (!row) return null;
        const amt = pls.find(
          (r) => r.page === row.page && Math.abs(r.y - row.y) < 1.5 && r.x > row.x && r.text.startsWith('MYR'),
        );
        if (!amt) throw new Error(`row ${label} drew no amount`);
        return Number(amt.text.replace(/^MYR\s*/, '').replace(/,/g, ''));
      };
      const drawn = DEDUCTION_LABELS.map((l) => [l, beside(l)] as const).filter(([, v]) => v != null);
      return { drawn, sum: Math.round(drawn.reduce((a, [, v]) => a + v!, 0) * 100) / 100 };
    };
    expect(sumOfRows(pl).sum).toBe(466.25);
    // …and that is the total the box itself prints, so the column reconciles on the page.
    expect(amountBeside('TOTAL DEDUCTIONS')).toBe(466.25);

    // ── 970e4143's OWN CASE, on the same assertion: a CP38 inside "Other deductions" ──────────────────
    //
    // THE TRAP THIS CASE EXISTS TO AVOID: with `cp38: 0` or `otherDeductions: 0` the sum reconciles however
    // the renderer behaves, so both are asserted NON-ZERO and MUTUALLY DISTINCT before the sum is asserted
    // at all. Distinct matters on its own — the reproduction had `cp38 === otherDeductions === 450`, and a
    // renderer that printed the instalment twice and a renderer that printed it once plus a residual of the
    // same size are indistinguishable on those figures.
    //
    // Figures: the 466.25 slip above plus a CP38 of 120 and a further 80 of other deductions ⇒ the column
    // holds 200, the residual after carving the instalment out is 80, and the total rises by the whole 200.
    const withCp38: PayslipPdfData = {
      ...sig01,
      cp38: 120,
      otherDeductions: 200,
      absence: { unpaidLeave: null, absent: null, cp38: { amount: 120, show: true }, residual: 80, showResidual: true, any: false },
      totalDeductions: 666.25,
      net: 3641.75,
    };
    expect(withCp38.cp38, 'NON-VACUITY: a zero CP38 makes this case reconcile whatever the code does').toBeGreaterThan(0);
    expect(withCp38.otherDeductions, 'NON-VACUITY: and so does a zero Other deductions').toBeGreaterThan(0);
    expect(withCp38.cp38, 'NON-VACUITY: the two must differ, or one printed twice looks like one plus a residual')
      .not.toBe(withCp38.absence.residual);
    const cp38Pl = drawnPlacements(await renderPayslipPdf(withCp38, labels));
    const cp38Rows = sumOfRows(cp38Pl);
    expect(cp38Rows.drawn.map(([l]) => l), 'both rows really are on the page').toEqual(
      expect.arrayContaining(['CP38', 'Other deductions']),
    );
    expect(cp38Rows.sum, 'the drawn deduction rows sum to the total drawn beneath them').toBe(666.25);
    expect(
      cp38Pl.find((r) => r.page === placed(cp38Pl, 'TOTAL DEDUCTIONS')!.page && r.text === 'MYR 666.25'),
      'and that IS the printed total',
    ).toBeDefined();

    // No election ⇒ no row, so every payslip for an employee without zakat prints exactly the document
    // it printed before this line existed.
    expect(drawnText(await renderPayslipPdf({ ...sig01, zakat: 0, totalDeductions: 436.25, net: 3871.75 }, labels)))
      .not.toContain('Zakat');
  });

  /**
   * 3a092cf0 — AND A PAYSLIP WRITTEN BEFORE THIS ITEM MUST RENDER EXACTLY AS IT ALWAYS DID.
   *
   * This is the half that protects history, and it is not hypothetical: nine stored payslips carry a
   * zakat (4 employees, 7 runs, 2,569.23), and their `total_deductions` is the OLD figure that excludes
   * it. Printing the counted row on those documents would make the drawn rows sum ABOVE the printed
   * TOTAL DEDUCTIONS — the exact defect this item exists to remove, inflicted on documents that cannot
   * be re-issued. Two of the nine are on CLOSED runs, frozen at trigger level by migration 0011, so for
   * those it would be permanent.
   *
   * The discriminator is the payslip's OWN stamp, exactly as payslipEmployerBorne does it: no
   * `zakatInTotal` on the blob ⇒ a pre-fix slip ⇒ no counted row.
   */
  it('a PRE-fix payslip prints no counted Zakat row, and still adds up to its own stored total', async () => {
    // SIG01's ACTUAL stored row: zakat 30 on the blob, but total_deductions 436.25 excludes it.
    const legacy = {
      ...data,
      epfEmployee: 410, socsoEmployee: 18.75, eisEmployee: 7.5, pcb: 0,
      zakat: 30, zakatCountedInTotal: false, otherDeductions: 0,
      gross: 4308, totalDeductions: 436.25, net: 3871.75,
    };
    const pl = drawnPlacements(await renderPayslipPdf(legacy, labels));
    const amountBeside = (label: string) => {
      const row = placed(pl, label);
      if (!row) throw new Error(`no row labelled ${label} on the page`);
      const amt = pl.find((r) => r.page === row.page && Math.abs(r.y - row.y) < 1.5 && r.x > row.x && r.text.startsWith('MYR'));
      if (!amt) throw new Error(`row ${label} drew no amount`);
      return Number(amt.text.replace(/^MYR\s*/, '').replace(/,/g, ''));
    };

    // No counted zakat row — the document keeps the shape it has always had.
    expect(placed(pl, 'Zakat'), 'a pre-fix payslip must not print a counted Zakat row').toBeUndefined();

    // And it reconciles against its OWN stored total, read off the drawn page rather than asserted
    // from the fixture — the same technique as the post-fix case above.
    const lines = ['EPF', 'SOCSO', 'EIS', 'PCB'].map(amountBeside);
    expect(Math.round(lines.reduce((a, b) => a + b, 0) * 100) / 100).toBe(436.25);
    expect(amountBeside('TOTAL DEDUCTIONS')).toBe(436.25);
  });

  // 3c473773 — the employer-borne disclosure block. Printed only when the payslip carries one; absent on
  // every payslip issued before the employer-bears settings existed.
  it('prints the employer-borne block only when the payslip carries one', async () => {
    const withBorne = drawnText(
      await renderPayslipPdf(
        { ...data, employerBorne: [{ label: 'EPF', amount: 629 }], employerBorneTotal: 629 },
        labels,
      ),
    );
    expect(withBorne).toContain('TOTAL BORNE BY EMPLOYER'); // box totals print uppercase
    expect(drawnText(await renderPayslipPdf(data, labels))).not.toContain('TOTAL BORNE BY EMPLOYER');
  });

  /**
   * 5b2a7f0f — THIS TEST PINNED A DECISION THAT HAS BEEN REVERSED, so it is updated rather than deleted.
   *
   * It used to assert `drawnText(bytes)` contained '???': the CJK name degrading to one question mark per
   * glyph was the DESIGNED behaviour of the WinAnsi fold, and asserting it was right at the time. The
   * document now embeds a Unicode face for the scripts on it (lib/payslip-pdf-fonts.ts), so 陈大文 prints,
   * and the question marks are the defect. What this test still owns is the REST of the sentence — null
   * code, null registration number, no SKBBK row, no other-deductions row, no proration — none of which
   * may crash the render. That the name itself now appears is asserted on the extracted text, through a
   * `/ToUnicode` reader, in test/payslip-pdf-unicode.test.ts; `drawnText` here cannot read a subset font's
   * glyph ids and must not be asked to.
   */
  it('degrades gracefully: null code/reg, no skbbk/other rows, no proration, non-Latin name', async () => {
    const bytes = await renderPayslipPdf(
      { ...data, employee: '陈大文', employeeCode: null, companyReg: null, socsoSkbbk: 0, otherDeductions: 0, daysWorked: null },
      labels,
    );
    expect(head(bytes)).toBe('%PDF-'); // no crash on the CJK name
    expect(bytes.length).toBeGreaterThan(1000);
    expect(drawnText(bytes)).not.toContain('???');
    // The English half of the document is untouched beside the embedded name.
    expect(drawnText(bytes)).toContain('NET PAY');
  });
});

describe('5c198931 — the downloaded payslip is a full official document', () => {
  it('uses one Employment Info card and retains statutory and YTD sections', async () => { const text=drawnText(await renderPayslipPdf({...data,bankName:'Maybank',bankAccount:'157123456789'},labels)); expect(text).toContain('EMPLOYEE PROFILE'); expect(text).toContain('EMPLOYER CONTRIBUTIONS'); expect(text).toContain('157123456789'); expect(text).not.toContain('PAYMENT INFORMATION'); expect(text).not.toContain('TOTAL EMPLOYER COST'); });;

  it('labels amounts with the COMPANY’s currency, not a hardcoded RM', async () => {
    const sgd = drawnText(await renderPayslipPdf({ ...data, currency: 'SGD' }, labels));
    expect(sgd).toContain('SGD 6,500.00');
    expect(sgd).not.toContain('RM ');
    // No currency on the row ⇒ the number prints unlabelled. An unlabelled figure is honest about being
    // unlabelled; defaulting to "RM" would be a claim about a company that never told us.
    const none = drawnText(await renderPayslipPdf({ ...data, currency: null }, labels));
    expect(none).toContain('6,500.00');
    expect(none).not.toContain('MYR');
  });

  it('prints each recorded pay item by NAME instead of one lumped Allowances row', async () => {
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          allowance: 500,
          earningLines: [
            { code: 'A0027', name: 'Handphone allowance', amount: 300 },
            { code: 'A0031', name: 'Travel allowance', amount: 200 },
          ],
          detailNotRecorded: false,
        },
        labels,
      ),
    );
    // a96d320c — BY NAME, AND ONLY BY NAME. This assertion read `'Handphone allowance · A0027'` until
    // the reporter pointed out that the second half is an internal reconciliation key with nothing on an
    // employee's side to reconcile against. 6b134681's guard is untouched in substance — the lumped
    // category word still gives way to the pay item — and what changed is that the item is now named
    // without its code. The admin surfaces still print the code through `payItemLabel`.
    expect(text).toContain('Handphone allowance');
    expect(text).toContain('Travel allowance');
    expect(text, 'the internal pay code is off the employee’s document').not.toContain('A0027');
    expect(text, 'the internal pay code is off the employee’s document').not.toContain('A0031');
    expect(text).toContain('MYR 300.00');
    expect(text).toContain('MYR 200.00');
    expect(text).not.toContain('Allowances'); // the lump is gone, replaced by its parts
    expect(text).toContain('MYR 7,120.00'); // …and the total is still the stored gross
  });

  it('REFUSES to itemise when the named lines do not add up to the stored allowance figure', async () => {
    // THE MONEY-SAFETY GUARD. A payslip whose display categories moved money between boxes (3c473773
    // `displayEarnings`) has an allowance figure that no longer equals the sum of its wage/reimburse
    // lines. Printing the lines there would put rows on a payslip that do not sum to the total beside
    // them. The lumped row must stand instead — silently correct beats itemised and wrong.
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          allowance: 500,
          earningLines: [{ code: 'A0027', name: 'Handphone allowance', amount: 300 }], // 300 ≠ 500
          detailNotRecorded: false,
        },
        labels,
      ),
    );
    expect(text).not.toContain('Handphone allowance');
    expect(text).toContain('Allowances');
    expect(text).toContain('MYR 500.00');
  });

  it('retains saved allowance totals without the retired employee-facing per-item explanation', async () => {
    const older = drawnText(await renderPayslipPdf({ ...data, earningLines: [], detailNotRecorded: true }, labels));
    expect(older).toContain('Allowances');
    expect(older).not.toContain('This payroll run recorded only the totals.');
    // A run that DID record its items carries no such note.
    const newer = drawnText(
      await renderPayslipPdf(
        { ...data, earningLines: [{ code: 'A1', name: 'Meal', amount: 500 }], detailNotRecorded: false },
        labels,
      ),
    );
    expect(newer).not.toContain('This payroll run recorded only the totals.');
  });

  it('embeds the company logo when there is one, and prints the name alone when there is not', async () => {
    const withLogo = await renderPayslipPdf({ ...data, logo: { bytes: PNG_1x1, mimeType: 'image/png' } }, labels);
    const without = await renderPayslipPdf({ ...data, logo: null }, labels);
    expect(head(withLogo)).toBe('%PDF-');
    expect(withLogo.length).toBeGreaterThan(without.length); // the image object is genuinely embedded
    // Both still carry the legal name: the logo is added to the letterhead, never a replacement for it.
    expect(drawnText(withLogo)).toContain('Demo Sdn Bhd');
    expect(drawnText(without)).toContain('Demo Sdn Bhd');
  });

  it('a corrupt logo costs the letterhead its mark, never the employee their payslip', async () => {
    const bytes = await renderPayslipPdf(
      { ...data, logo: { bytes: Buffer.from('not a png at all'), mimeType: 'image/png' } },
      labels,
    );
    expect(head(bytes)).toBe('%PDF-');
    expect(drawnText(bytes)).toContain('Demo Sdn Bhd');
  });

  it('RETURNS on a PNG with an intact signature and a corrupt body — pdf-lib spins forever on one', async () => {
    // THE HANG THIS DOCUMENT'S OWN CHANGE WOULD OTHERWISE HAVE INTRODUCED. `core/admin.ts assertValidLogo`
    // accepts an upload on its magic bytes and its size, so a truncated PNG is stored happily; on the
    // Organization screen that costs a broken-image icon, but `embedPng` neither returns nor throws on it,
    // so every payslip download for that company would hang its request. Measured before the guard: this
    // input never came back. The test is therefore the ABSENCE of a hang — if the chunk/CRC check ever
    // stops firing, this file stops finishing rather than reporting a failure.
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // valid PNG signature
      Buffer.from('AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    ]);
    const bytes = await renderPayslipPdf({ ...data, logo: { bytes: corrupt, mimeType: 'image/png' } }, labels);
    expect(head(bytes)).toBe('%PDF-');
    // …and it degraded to the text letterhead rather than embedding rubbish.
    expect(drawnText(bytes)).toContain('Demo Sdn Bhd');
    expect(bytes.length).toBe(
      (await renderPayslipPdf({ ...data, logo: null }, labels)).length,
    );
  });

  it('prints every one of a long earnings list, and repeats the heading only on a REAL break', async () => {
    // REWRITTEN FOR f35f758a. This used to assert BOTH that all 30 rows printed AND that
    // "EARNINGS (CONTINUED)" appeared — which was only true because the box was capped at 14 rows
    // regardless of how much page was left under it. Earnings now takes the full width and the flow is
    // measured, so 30 rows fit where they fall and the continuation heading is what a genuine page break
    // looks like, not a fixed-cap artefact. Both halves are still asserted; they are just no longer the
    // same case.
    const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `A${i}`, name: `Item ${i}`, amount: 10 }));

    const thirty = drawnText(
      await renderPayslipPdf({ ...data, allowance: 300, earningLines: rowsOf(30), detailNotRecorded: false }, labels),
    );
    for (const i of [0, 15, 29]) expect(thirty, `Item ${i} must print`).toContain(`Item ${i}`);
    expect(thirty).toContain('MYR 7,120.00'); // the total still reads the stored gross
    for(let i=0;i<30;i++) expect(thirty,`complete measured row ${i}`).toContain(`Item ${i}`);
    const short=drawnText(await renderPayslipPdf({...data,allowance:30,earningLines:rowsOf(3),detailNotRecorded:false},labels));
    expect(short).not.toContain('EARNINGS (CONTINUED)');

    // A list long enough to genuinely run off the sheet DOES continue, with the heading repeated and the
    // last row intact. This is the case the old cap could never distinguish from the one above.
    const many = rowsOf(70);
    const bytes = await renderPayslipPdf({ ...data, allowance: 700, earningLines: many, detailNotRecorded: false }, labels);
    const text = drawnText(bytes);
    expect(text).toContain('EARNINGS (CONTINUED)');
    expect(text).toContain('Item 69'); // the last line survived rather than being dropped
    expect(text).toContain('MYR 7,120.00');
    // Every single row is on the document — the failure mode this file exists to catch is a renderer that
    // silently drops what does not fit.
    for (let i = 0; i < 70; i += 1) expect(text, `Item ${i} must print`).toContain(`Item ${i}`);
    const onePage = await renderPayslipPdf({ ...data, earningLines: [], detailNotRecorded: true }, labels);
    expect(bytes.length).toBeGreaterThan(onePage.length);
  });

  it('a typical payslip is still ONE page once Earnings takes the full width', async () => {
    // The layout promise the plan made to the reporter: Earnings full width, the short blocks paired,
    // one sheet. `/Type /Page` (not /Pages) counts leaves in the page tree.
    const bytes = await renderPayslipPdf(
      {
        ...data,
        payDate: '2026-06-30',
        cycleLabel: 'Regular',
        identityNumber: '900101011234',
        department: 'Finance',
        position: 'Analyst',
        jobGrade: 'G5',
        employmentType: 'Full-time',
        epfNumber: '12345678',
        socsoNumber: '900101011234',
        taxNumber: 'SG1234567890',
        paymentMethod: 'Bank transfer',
        bankName: 'Maybank',
        bankAccount: '157123456789',
        hrdf: 71.2,
        allowance: 1430,
        earningLines: [
          { code: 'A0027', name: 'HANDPHONE AND COMMUNICATION ALLOWANCE', amount: 300 },
          { code: 'A0031', name: 'TRAVELLING ALLOWANCE (SITE VISITS)', amount: 450 },
          { code: 'A0044', name: 'SITE SUPERVISION RESPONSIBILITY ALLOWANCE', amount: 500 },
          { code: 'A0051', name: 'Meal', amount: 180 },
        ],
        detailNotRecorded: false,
        ytd: { gross: 21360, epf: 2145, socso: 74.25, eis: 29.7, pcb: 1050, net: 18061.05 },
        ytdYear: '2026',
      },
      labels,
    );
    expect(await pageCount(bytes), 'a typical payslip must still fit one A4').toBe(1);
  });

  it('NOTHING on the document ends in dots — long names wrap instead of being clipped', async () => {
    // THE DEFECT f35f758a WAS RAISED FOR, stated as the assertion. The renderer used to hard-clip with a
    // `fit()` helper, so a pay item, a job title, a department or an employee name that did not fit was
    // printed halfway and finished with an ellipsis. `safe()` folds a real '…' to '...', so both forms
    // are checked.
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          employee: 'Muhammad Nur Firdaus Bin Abdul Rahman Al-Hafiz',
          company: 'ISEDECOR BINA CONSTRUCTION AND ENGINEERING SERVICES SDN BHD',
          department: 'Construction Project Management and Site Delivery',
          position: 'Construction Project Management Specialist',
          allowance: 1250,
          earningLines: [
            { code: 'A0027', name: 'HANDPHONE AND COMMUNICATION ALLOWANCE', amount: 300 },
            { code: 'A0031', name: 'TRAVELLING ALLOWANCE (SITE VISITS)', amount: 450 },
            { code: 'A0044', name: 'SITE SUPERVISION RESPONSIBILITY ALLOWANCE', amount: 500 },
          ],
          detailNotRecorded: false,
        },
        labels,
      ),
    );
    expect(text, 'the clipped-with-an-ellipsis form must be gone').not.toMatch(/\.\.\.|…/);
    // …and every word of the three measured examples reaches the page, across whatever line it lands on.
    for (const word of [
      'HANDPHONE', 'COMMUNICATION', 'ALLOWANCE', 'TRAVELLING', 'SUPERVISION', 'RESPONSIBILITY',
      'Construction', 'Management', 'Firdaus', 'Al-Hafiz', 'ISEDECOR', 'ENGINEERING',
    ]) {
      expect(text, `"${word}" must reach the page in full`).toContain(word);
    }
  });

  it('prints the month as a NAME, and keeps the sortable period for the title', async () => {
    const text = drawnText(await renderPayslipPdf(data, labels));
    expect(text, 'the letterhead reads August 2026, never 2026-08').toContain('June 2026');
    expect(text).not.toContain('2026-06');
  });
});

describe('5c198931 — buildPayslipPdfData reads the payslip’s OWN stamp', () => {
  const row = {
    employee: 'Ismail',
    employeeCode: '100180',
    company: 'Isedecor Bina Sdn Bhd',
    companyReg: null,
    payPeriod: '2026-08',
    basic: '5500.00',
    allowance: '100.00',
    overtime: '0',
    bonus: '0',
    gross: '5600.00',
    otherDeductions: '0',
    totalDeductions: '2334.85',
    net: '3265.15',
    employerCost: '6436.25',
    daysWorked: '31',
    statutory: {
      epfEmployee: 616, socsoEmployee: 27.75, eisEmployee: 11.1, pcb: 1680,
      epfEmployer: 672, socsoEmployer: 97.15, eisEmployer: 11.1, hrdf: 56,
      componentLines: [
        { code: 'A0027', name: 'HANDPHONE ALLOWANCE', buckets: [{ bucket: 'wage', amount: 100 }] },
        // An OT component: it explains the OVERTIME figure, not the allowance, so it must not appear
        // among the allowance lines (its amount would make them overshoot the total they explain).
        { code: 'OT15', name: 'OVERTIME 1.5', buckets: [{ bucket: 'ot', amount: 40 }] },
      ],
    },
  };
  const borne = { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' } as const;

  it('derives the allowance lines from wage + reimburse buckets only, and picks up the HRD Corp levy', () => {
    const d = buildPayslipPdfData(row, borne);
    expect(d.earningLines).toEqual([{ code: 'A0027', name: 'HANDPHONE ALLOWANCE', amount: 100 }]);
    expect(d.detailNotRecorded).toBe(false);
    // efece4ce stored the levy on every payslip; the download printed it nowhere until now.
    expect(d.hrdf).toBe(56);
    // The lines reconcile to the stored allowance column, which is what licenses the itemised rows.
    expect(d.earningLines!.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(d.allowance, 2);
  });

  /**
   * 6b134681 — THE SIBLING ASSERT for the two figures that were never itemised.
   *
   * The case above pins that an OT line must NOT be counted among the allowance lines. That guard is
   * necessary and stays exactly as it is; on its own it also described a document on which OT and Bonus
   * had no named lines AT ALL. This says where those lines go instead: their own fields, each reconciling
   * against its own stored total, so nothing can leak between the three earnings figures.
   */
  it('routes ot / bonus component lines to their OWN fields, never into the allowance lines', () => {
    const d = buildPayslipPdfData(row, borne);
    expect(d.overtimeLines).toEqual([{ code: 'OT15', name: 'OVERTIME 1.5', amount: 40 }]);
    expect(d.bonusLines).toEqual([]); // this fixture has no bonus-bucket item
    // The OT line is real, but this payslip's stored overtime column is 0 (the fixture's OT was folded
    // elsewhere), so the named row must NOT replace the grouped one — the rows on a money document may
    // never fail to add up to the total beside them.
    expect(d.overtime).toBe(0);
    expect(d.earningLines).toEqual([{ code: 'A0027', name: 'HANDPHONE ALLOWANCE', amount: 100 }]);
  });

  it('reports detailNotRecorded for a run that predates the per-item stamp', () => {
    const { componentLines: _drop, ...st } = row.statutory;
    const d = buildPayslipPdfData({ ...row, statutory: st }, borne);
    expect(d.earningLines).toEqual([]);
    expect(d.bonusLines).toEqual([]);
    expect(d.overtimeLines).toEqual([]);
    expect(d.detailNotRecorded).toBe(true);
  });

  it('folds a converted OT excess into the allowance lines, because that is the figure it is paid through', () => {
    // f3148da1 Step 4 — the OT excess redirected to a pay item rides the allowance column
    // (`allowance = allowanceApplied + reimburse + otConvert`). Omitting it would make the named rows
    // fall short of the total and silently lose the itemisation.
    const d = buildPayslipPdfData(
      {
        ...row,
        allowance: '250.00',
        statutory: { ...row.statutory, otConvert: { code: 'OTX', name: 'OT excess', amount: 150 } },
      },
      borne,
    );
    expect(d.earningLines).toEqual([
      { code: 'A0027', name: 'HANDPHONE ALLOWANCE', amount: 100 },
      { code: 'OTX', name: 'OT excess', amount: 150 },
    ]);
    expect(d.earningLines!.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(d.allowance, 2);
  });

  it('passthrough fields do not disturb the figures the builder already computed', () => {
    const d = buildPayslipPdfData(row, borne, { currency: 'MYR', department: 'Ops', ytdYear: '2026' });
    expect(d.currency).toBe('MYR');
    expect(d.department).toBe('Ops');
    expect(d.gross).toBe(5600);
    expect(d.net).toBe(3265.15);
    expect(d.totalDeductions).toBe(2334.85);
  });
});

/**
 * f35f758a rev 2 — THE RELAYOUT, THE NON-PAYABLE BOX AND THE UNMASKED ACCOUNT.
 *
 * The reporter read r179's document live and made three points: Earnings running the full width with
 * Deductions underneath means the two halves of one sum cannot be read against each other; there is no
 * Non-Payable section; and the bank account prints as four dots and the last four digits.
 *
 * EVERY ASSERTION HERE IS READ BACK OFF THE ARTEFACT, coordinates included. A stacked document and a
 * paired one contain the same words in the same order, so "side by side" can only be checked as a claim
 * about x and y. These positions were cross-checked against `pdftotext -bbox` and `mutool draw` on the
 * real files during the build (r185-a): both renderers agreed, and that agreement is the instrument.
 */
describe('f35f758a rev 2 — Earnings beside Deductions, NET PAY full width, and a Non-payable box', () => {
  it('draws Earnings and Deductions at the SAME height in DIFFERENT columns', async () => {
    const p = drawnPlacements(await renderPayslipPdf(data, labels));
    const earn = placed(p, 'EARNINGS');
    const ded = placed(p, 'DEDUCTIONS');
    expect(earn, 'the Earnings box must be drawn').toBeDefined();
    expect(ded, 'the Deductions box must be drawn').toBeDefined();
    expect(earn!.page).toBe(ded!.page);
    // Same baseline, or the two are stacked and the whole point of the change is lost.
    expect(ded!.y).toBeCloseTo(earn!.y, 1);
    // …and genuinely in the right-hand column: past the halfway line of a 595.28pt A4.
    expect(earn!.x).toBeLessThan(297);
    expect(ded!.x).toBeGreaterThan(297);

    // Their TOTALS line up too, which is the half a reader actually compares. This used to be qualified
    // "WHEN THE TWO BOXES HOLD THE SAME NUMBER OF ROWS", and the qualification was the defect.
    const even = drawnPlacements(await renderPayslipPdf({ ...data, bonus: 800, gross: 7920 }, labels));
    const te = placed(even, 'TOTAL EARNINGS');
    const td = placed(even, 'TOTAL DEDUCTIONS');
    expect(td!.y).toBeCloseTo(te!.y, 1);
    expect(td!.x).toBeGreaterThan(te!.x);

    // ─── a96d320c rev 3 — THIS GUARD IS REVERSED, DELIBERATELY, AND THE OLD ONE IS QUOTED SO NOBODY
    // RESTORES IT BY ACCIDENT. It read:
    //
    //     // THE REVERSAL, PINNED. A month with no bonus prints no Bonus row (a96d320c rev 2), so the
    //     // Earnings box ends one row higher than the Deductions box beside it. … the two BOTTOMS no
    //     // longer do, and that is the deliverable, not a layout regression.
    //     expect(placed(p, 'TOTAL EARNINGS')!.y).toBeGreaterThan(placed(p, 'TOTAL DEDUCTIONS')!.y);
    //
    // It was an honest description of what the code did and a wrong reading of what the document is for.
    // The two totals were NEVER aligned: `flowPair` starts both boxes at the same y and advances past the
    // taller, but each total is painted at the foot of its OWN rows, so they were level only when the two
    // columns happened to hold the same number of rows. The reporter read a payslip where they did not —
    // three earnings rows beside four deduction rows — and asked for them aligned. `padBodyTo` holds the
    // shorter side's body open to the taller side's so the total bands land on one baseline. No row
    // moves, nothing is inserted, no figure changes.
    //
    // `data` is exactly the uneven case: no bonus ⇒ 3 earnings rows against 4 deduction rows. The line
    // below would have read `toBeGreaterThan` before this item and it is the measurement that matters —
    // the `even` fixture above cannot fail if the padding is removed, this one can. ───
    expect(
      placed(p, 'TOTAL EARNINGS')!.y,
      'an UNEVEN pair still puts the two totals on one baseline',
    ).toBeCloseTo(placed(p, 'TOTAL DEDUCTIONS')!.y, 1);
    // …and the fixture really is uneven, or the assertion above is a coincidence again. Count the rows
    // each box actually drew, from the page, not from the fixture.
    const earnRowYs = p.filter((r) => r.text === 'Basic salary' || r.text === 'Allowances' || r.text === 'Overtime');
    const dedRowYs = p.filter((r) => ['EPF', 'SOCSO', 'EIS', 'PCB'].includes(r.text) && r.x > 297);
    expect(earnRowYs.length, 'three earnings rows').toBe(3);
    expect(dedRowYs.length, 'four deduction rows — one MORE than the earnings side').toBe(4);
  });

  it('places payment values in Employment Info above earnings, with no separate payment heading', async()=>{ const p=drawnPlacements(await renderPayslipPdf({...data,paymentMethod:'Bank transfer',bankName:'Maybank',bankAccount:'157123456789'},labels)); expect(placed(p,'Maybank')!.y).toBeGreaterThan(placed(p,'EARNINGS')!.y); expect(placed(p,'PAYMENT INFORMATION')).toBeUndefined(); });;

  it('gives NET PAY the FULL width — its amount reaches the right margin', async () => {
    const p = drawnPlacements(await renderPayslipPdf(data, labels));
    const net = placed(p, 'NET PAY')!;
    expect(net.x).toBeLessThan(297);
    // The amount is right-aligned to `A4_W - M - 14`; drawn at its own left edge, so what is asserted is
    // that it starts well past the mid-line — impossible while the band was only COL_W wide.
    const amount = p.filter((r) => r.text === 'MYR 6,020.35' && Math.abs(r.y - (net.y - 2)) < 6);
    expect(amount.length, 'the net figure must be drawn on the band').toBeGreaterThan(0);
    expect(amount[0].x, 'a COL_W band could never place it here').toBeGreaterThan(400);
  });

  it('prints NO Non-payable box on a payslip whose record lines were all PAID', async () => {
    // THE HAZARD THIS ITEM WAS MOST AT RISK OF. `statutory.recordLines` is a mixed population: production
    // payslip 945d16e9 carries COMMISSION 300, HANDPHONE ALLOWANCE 400 and SHORT NOTICE −500, and every
    // one of them was paid. Filling the new box from that list would tell an employee their commission
    // never reached them.
    const d = buildPayslipPdfData(
      {
        employee: 'Ismail', employeeCode: 'TEST0005', company: 'Isedecor Bina Sdn Bhd', companyReg: null,
        payPeriod: '2026-07', basic: '4500.00', allowance: '700.00', overtime: '0', bonus: '0',
        gross: '5200.00', otherDeductions: '500.00', totalDeductions: '1149.65', net: '4050.35',
        employerCost: '5881.55', daysWorked: '31',
        statutory: {
          epfEmployee: 495, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 120,
          recordLines: [
            { code: 'C0011', name: 'COMMISSION', amount: 300, nonPayable: false },
            { code: 'A0027', name: 'HANDPHONE ALLOWANCE', amount: 400, nonPayable: false },
            { code: 'DB018', name: 'SHORT NOTICE', amount: -500, nonPayable: false },
          ],
        },
      },
      { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' },
    );
    expect(d.nonPayableLines, 'not one of those three was non-payable').toEqual([]);
    const text = drawnText(await renderPayslipPdf(d, labels));
    expect(text).not.toContain('OTHER');
    expect(text).not.toContain('TOTAL NON-PAYABLE');
  });

  it('prints ONLY the lines the run stamped non-payable, with their own total', async () => {
    const d = buildPayslipPdfData(
      {
        employee: 'Ismail', employeeCode: 'TEST0005', company: 'Isedecor Bina Sdn Bhd', companyReg: null,
        payPeriod: '2026-07', basic: '4500.00', allowance: '700.00', overtime: '0', bonus: '0',
        gross: '5200.00', otherDeductions: '500.00', totalDeductions: '1149.65', net: '4050.35',
        employerCost: '5881.55', daysWorked: '31',
        statutory: {
          epfEmployee: 495, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 120,
          recordLines: [
            { code: 'C0011', name: 'COMMISSION', amount: 300, nonPayable: false },
            { code: 'BIK01', name: 'COMPANY CAR BENEFIT IN KIND', amount: 850, nonPayable: true },
            { code: 'BIK02', name: 'ACCOMMODATION BENEFIT IN KIND', amount: 1200, nonPayable: true },
            { code: 'DB018', name: 'SHORT NOTICE', amount: -500, nonPayable: false },
          ],
        },
      },
      { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' },
    );
    expect(d.nonPayableLines).toEqual([
      { code: 'BIK01', name: 'COMPANY CAR BENEFIT IN KIND', amount: 850 },
      { code: 'BIK02', name: 'ACCOMMODATION BENEFIT IN KIND', amount: 1200 },
    ]);
    const text = drawnText(await renderPayslipPdf(d, labels));
    expect(text).toContain('OTHER');
    // a96d320c — the BIK lines are named, not coded. The builder still CARRIES `code` (asserted above,
    // and Transaction View prints it), so what is pinned here is the DOCUMENT's choice, not a loss of data.
    expect(text).toContain('COMPANY CAR BENEFIT IN KIND');
    expect(text).toContain('ACCOMMODATION BENEFIT IN KIND');
    expect(text, 'the internal pay code is off the employee’s document').not.toContain('BIK01');
    expect(text, 'the internal pay code is off the employee’s document').not.toContain('BIK02');
    expect(text).toContain('TOTAL NON-PAYABLE');
    // No currency was supplied to the builder, so amounts print unlabelled — which is the honest
    // behaviour this file already pins elsewhere. The FIGURE is what matters here: 850 + 1200.
    expect(text).toContain('2,050.00');
    // …and the PAID lines are not dragged in with them.
    expect(text).not.toContain('SHORT NOTICE');
  });

  it('treats an UNSTAMPED record line as unknown, never as non-payable', async () => {
    // Every payslip written before this shipped carries no flag at all. They cannot be split after the
    // fact — matching the code back to today's pay_component would answer with today's configuration
    // about a month that has already been paid — so they keep the single list the screens already show
    // and this document prints no box for them.
    const d = buildPayslipPdfData(
      {
        employee: 'Ismail', employeeCode: 'OLD001', company: 'Isedecor Bina Sdn Bhd', companyReg: null,
        payPeriod: '2025-11', basic: '4500.00', allowance: '0', overtime: '0', bonus: '0',
        gross: '4500.00', otherDeductions: '0', totalDeductions: '649.65', net: '3850.35',
        employerCost: '5085.00', daysWorked: '30',
        statutory: {
          recordLines: [
            { code: 'BIK01', name: 'COMPANY CAR', amount: 850 }, // legacy: no `nonPayable` key at all
            { code: 'C0011', name: 'COMMISSION', amount: 300 },
          ],
        },
      },
      { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' },
    );
    expect(d.nonPayableLines).toEqual([]);
    expect(drawnText(await renderPayslipPdf(d, labels))).not.toContain('OTHER');
  });

  it('prints the WHOLE bank account number, not the last four digits', async () => {
    // The masking now happens in the READ and only for the SCREENS (core/payroll-view.ts
    // `payslipForReview`, core/payroll.ts `payslipDetail` return both forms). This document takes the
    // full one, on both routes, the employee's own copy included: it is their account.
    const text = drawnText(
      await renderPayslipPdf(
        { ...data, paymentMethod: 'Bank transfer', bankName: 'Maybank', bankAccount: '157123456789' },
        labels,
      ),
    );
    expect(text).toContain('157123456789');
    expect(text, 'the mask must not survive anywhere on the document').not.toContain('····');
    expect(text).not.toContain('••••');
  });

  it('a REAL production-shape payslip still fits one A4 after the relayout', async () => {
    // Re-measured against the module itself rather than against the plan's arithmetic, which came from a
    // standalone re-implementation of the wrap/layout maths. Cross-checked at build time by rasterising
    // in BOTH mutool and pdftoppm: one sheet in each.
    const bytes = await renderPayslipPdf(
      {
        ...data,
        company: 'ISEDECOR BINA CONSTRUCTION AND ENGINEERING SERVICES SDN BHD',
        payDate: '2026-06-30',
        cycleLabel: 'Regular',
        identityNumber: '900101011234',
        department: 'Construction Project Management and Site Delivery',
        position: 'Construction Project Management Specialist',
        jobGrade: 'G7',
        employmentType: 'Full-time',
        epfNumber: '12345678',
        socsoNumber: '900101011234',
        taxNumber: 'SG1234567890',
        paymentMethod: 'Bank transfer',
        bankName: 'Maybank Berhad',
        bankAccount: '157123456789',
        hrdf: 71.2,
        allowance: 700,
        earningLines: [
          { code: 'A0027', name: 'HANDPHONE ALLOWANCE', amount: 400 },
          { code: 'C0011', name: 'COMMISSION', amount: 300 },
        ],
        detailNotRecorded: false,
        ytd: { gross: 21360, epf: 2145, socso: 74.25, eis: 29.7, pcb: 1050, net: 18061.05 },
        ytdYear: '2026',
      },
      labels,
    );
    expect(await pageCount(bytes)).toBe(1);
  });

  it('overflow degrades to a SECOND SHEET with the heading repeated — it never clips', async () => {
    // The plan's own space budget was measured off a re-implementation, so the honest promise is not
    // "always one page" but "a miss is cosmetic". This is that promise, asserted: a payslip long enough
    // to overflow prints every row it was given, across as many sheets as it needs.
    const rowsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ code: `A${i}`, name: `Long pay item description ${i}`, amount: 10 }));
    const bytes = await renderPayslipPdf(
      { ...data, allowance: 450, gross: 7120, earningLines: rowsOf(45), detailNotRecorded: false },
      labels,
    );
    expect(await pageCount(bytes)).toBeGreaterThan(1);
    const text = drawnText(bytes);
    expect(text).toContain('EARNINGS (CONTINUED)');
    for (let i = 0; i < 45; i += 1) {
      expect(text.replace(/\n/g,' '), `row ${i} must be complete across wrapped runs`).toContain(`Long pay item description ${i}`);
    }
    // r381 repeats the partner heading so both totals finish together, without repeating its money.
    const p = drawnPlacements(bytes);
    const earningsPages = p.filter(r => r.text === 'EARNINGS' || r.text === 'EARNINGS (CONTINUED)').map(r => r.page);
    expect(p.filter(r => r.text === 'DEDUCTIONS').map(r => r.page)).toEqual(earningsPages);
    const earned = p.filter(r => r.text === labels.totalEarnings.toUpperCase());
    const deducted = p.filter(r => r.text === labels.totalDeductions.toUpperCase());
    expect(earned).toHaveLength(1);
    expect(deducted).toHaveLength(1);
    expect(deducted[0].page).toBe(earned[0].page);
    expect(deducted[0].y).toBeCloseTo(earned[0].y, 2);
  });
});

/**
 * 6b134681 — THE DOCUMENT NAMES THE PAY ITEM, READ BACK OFF THE ARTEFACT.
 *
 * A0002's January one-off was keyed as "B0001 — ANGPOW RM500.00" and the downloaded payslip printed
 * "Bonus RM500.00". The code and the description were stamped on the payslip the whole time; the bonus
 * bucket was simply the one earnings figure the document never itemised, so the statutory classification
 * (additional remuneration ⇒ the Bonus box) was all the employee ever saw.
 */
describe('6b134681 — bonus and overtime print by pay item, not by category', () => {
  it('prints ANGPOW in place of the lumped Bonus row — a96d320c took the code off', async () => {
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          bonus: 500,
          gross: 7620,
          bonusLines: [{ code: 'B0001', name: 'ANGPOW', amount: 500 }],
          detailNotRecorded: false,
        },
        labels,
      ),
    );
    expect(text, 'the pay item description reaches the page').toContain('ANGPOW');
    // a96d320c — this read `toContain('B0001')`. 6b134681's point was that the CATEGORY must give way to
    // the ITEM, and it still does; the reporter's point is that the item's internal code means nothing to
    // the person reading their own payslip. Both are now pinned, in the same test.
    expect(text, 'the internal pay code is off the employee’s document').not.toContain('B0001');
    // The grouped word is GONE from the earnings box: it was never the item's name.
    expect(text, 'a bare "Bonus" row must not stand where a named item exists').not.toContain('Bonus');
  });

  it('keeps the grouped Bonus row when the named lines do NOT add up to the stored figure', async () => {
    // 3c473773 `displayEarnings` can move money between boxes after the fact. Printing rows that fall
    // short of the total beside them is the one failure this document may never commit.
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          bonus: 500,
          gross: 7620,
          bonusLines: [{ code: 'B0001', name: 'ANGPOW', amount: 450 }],
          detailNotRecorded: false,
        },
        labels,
      ),
    );
    expect(text).toContain('Bonus');
    expect(text, 'a row that does not reconcile is not printed at all').not.toContain('ANGPOW');
  });

  it('itemises overtime the same way, against its OWN total', async () => {
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          overtime: 120,
          overtimeLines: [{ code: 'OT15', name: 'OVERTIME 1.5', amount: 120 }],
          detailNotRecorded: false,
        },
        labels,
      ),
    );
    expect(text).toContain('OVERTIME 1.5');
    // a96d320c — was `toContain('OT15')`. See the ANGPOW test above for why it inverted.
    expect(text, 'the internal pay code is off the employee’s document').not.toContain('OT15');
    expect(text, 'the category word gives way to the item').not.toContain('Overtime');
  });
});

/**
 * a96d320c — THE FIVE THINGS THE REPORTER READ OFF THEIR OWN PAYSLIP.
 *
 * Three of them are this document's business: the payment date printed as a raw ISO string, the sections
 * drawn as blocks rather than ruled boxes, and every line carrying an internal pay code the employee has
 * nothing to reconcile against. The other two (the overtime rate and hours, and the rate and input behind
 * a quantity-priced deduction) are figures the payroll RUN never wrote down — they are stamped by the
 * kernel and read back here, and their tests live beside the kernel that stamps them.
 */
describe('a96d320c — payment date in words, ruled boxes, no internal pay codes', () => {
  it('prints the payment date as words, resolved from the ISO the batch stored', () => {
    // The same idiom `englishMonthYear` uses for the period line: Intl, timeZone UTC, no month table.
    expect(englishLongDate('2026-09-30')).toBe('30 September 2026');
    expect(englishLongDate('2026-01-01')).toBe('1 January 2026');
    // Day-first, because that is how Malaysia writes a date and it is the form the approved plan shows.
    expect(englishLongDate('2026-06-30')).not.toContain(',');
  });

  it('never invents a date it was not given', () => {
    // Not a date we recognise ⇒ print what was stored. A payslip may not guess when someone was paid.
    expect(englishLongDate('2026-09')).toBe('2026-09');
    expect(englishLongDate('')).toBe('');
    expect(englishLongDate('not a date')).toBe('not a date');
    // `Date.UTC` rolls an impossible day FORWARD — 2026-02-31 would otherwise print as "3 March 2026",
    // a payment date the payroll never used. The round-trip check refuses it.
    expect(englishLongDate('2026-02-31')).toBe('2026-02-31');
  });

  /**
   * ─── a96d320c rev 3 — THIS TEST IS INVERTED, AND THE INVERSION IS THE DELIVERABLE (board item
   * 048f1e9d, folded into a96d320c). It used to be titled "puts the employee identity fields inside a
   * RULED box, not loose under a heading" and it asserted `enclosingRule(...)` toBeDefined for the NRIC
   * and for the department.
   *
   * That box was OURS — r328 put it there, nobody asked for it — and the reporter contested it twice
   * before approving its removal: "remove the unnecessary bordered-line design", "maintain clear
   * alignment between the field labels and values", "avoid excessive borders and visual separation".
   * The fields are loose label-over-value pairs again, on a shared column grid.
   *
   * The assertions are kept, not deleted, with their sense flipped: the OLD guard would now pass on a
   * document that had quietly re-grown the box, and this one fails on exactly that. ───
   */
  it('the approved information card has a border rather than the retired loose-pair design',async()=>{const text=drawnText(await renderPayslipPdf(data,labels));expect(text).toContain('EMPLOYEE PROFILE');expect(text).toContain(data.employee);expect(text).toContain(data.employeeCode!);});;

  /**
   * a96d320c rev 3 — THE EMPTY BOX, AND WHY IT CANNOT COME BACK AT ANY CELL COUNT.
   *
   * The reporter circled a blank bordered cell in the employee panel. It was not a missing field:
   * `idCells` already spreads to nothing for an absent number. It was `drawGrid`'s ODD-CELL case. That
   * function stroked its outer rectangle at FULL WIDTH and its column rule from `top` to `top - used` at
   * FULL HEIGHT before drawing any text — it had to, to keep rules off glyphs — and then filled cells
   * left to right. An odd `cells.length` therefore enclosed a cell that was never written into.
   *
   * Production, 84 employments by identity-cell count: 0→9, 1→29, 2→2, 3→17, 4→27. The 29 one-number and
   * 17 three-number employments are 46 of 84 printing a void; 17 of the 48 that have ever had a payslip.
   *
   * This sweeps EVERY count from 0 to 6 rather than the one the reporter happened to hit. A fix that
   * only special-cased the last row would pass at 3 and fail at 5.
   */
  it('omits absent identity labels while retaining the shared information card',async()=>{const text=drawnText(await renderPayslipPdf({...data,identityNumber:null,epfNumber:null,socsoNumber:null,taxNumber:null},labels));expect(text).not.toContain(labels.ic);expect(text).not.toContain(labels.epfNumber);expect(text).toContain('EMPLOYEE PROFILE');});;

  it('puts the YEAR TO DATE table inside a ruled box, and does not move the page flow doing it', async () => {
    const full = {
      ...data,
      ytd: { gross: 21360, epf: 2145, socso: 74.25, eis: 29.7, pcb: 1050, net: 18061.05 },
      ytdYear: '2026',
    };
    const bytes = await renderPayslipPdf(full, labels);
    const rects = drawnRects(bytes);
    const places = drawnPlacements(bytes);
    const ytdGross = placed(places, 'MYR 21,360.00');
    expect(ytdGross, 'the YTD gross reaches the page').toBeDefined();
    expect(enclosingRule(rects, ytdGross), 'the YTD table is enclosed by a ruled box').toBeDefined();
    // The block is the SAME height it always was (BOX_HEAD_H + 14 + 6 × 15 = YTD_H = 124), which is what
    // keeps a payslip that fitted one sheet still fitting one sheet.
    expect(await pageCount(bytes)).toBe(1);
  });

  /**
   * a96d320c rev 2 — THE NOTCH. The reporter drew four red rectangles on their payslip, one on the left
   * edge of each of Earnings, Deductions, Employer contributions and Payment information, and wrote "not
   * fixed". They were right: r328 ruled the two blocks that had NO rules (the employee panel and the YTD
   * table) and never touched `paintBox`, whose header band is a full-width FILLED rectangle drawn after
   * the outline — so it painted over the outline's left and right edges for its own height, four boxes,
   * one notch each. The total row's band did the same again lower down, and on a box with no total it
   * covered the bottom edge too.
   *
   * THE ASSERTION IS THE PAINT ORDER, READ OUT OF THE RENDERED FILE, not a source grep: `drawnRects`
   * returns the rectangles in the order pdf-lib emitted them.
   */
  it('closes every box: no filled band is ever painted over a border already on the page', async () => {
    const full = {
      ...data,
      // The most boxes one sheet can carry: Earnings + Deductions (a pair, each with a total band),
      // Employer contributions (total + note), Payment information (NO total — the box whose bottom
      // border the row hairline was washing out), NET PAY, and the YTD table.
      ytd: { gross: 21360, epf: 2145, socso: 74.25, eis: 29.7, pcb: 1050, net: 18061.05 },
      ytdYear: '2026',
      paymentMethod: 'Bank transfer',
      bankName: 'Maybank',
      bankAccount: '514012345678',
      identityNumber: '900101011234',
      department: 'Finance',
    };
    const bytes = await renderPayslipPdf(full, labels);
    const rects = drawnRects(bytes);

    // NON-VACUITY, FIRST: the document really is made of ruled boxes and filled bands, so the emptiness
    // asserted below is the absence of a defect rather than the absence of anything to inspect.
    // a96d320c rev 3 — 6 became 5, and the two that went are the employee panel's. r328 ruled the
    // identity grid and the employment-info grid; both are de-boxed now (item 048f1e9d, folded in), so
    // the ruled boxes on this sheet are Earnings, Deductions, Employer contributions, Payment
    // information and Year to date. The floor is LOWERED, not removed — it is a non-vacuity control for
    // the emptiness asserted below, and it still refuses a document that stopped drawing boxes at all.
    expect(rects.filter((r) => r.op === 'S').length, 'the document draws ruled boxes').toBeGreaterThanOrEqual(5);
    expect(rects.filter((r) => r.op === 'f').length, 'the document draws filled bands').toBeGreaterThanOrEqual(5);

    expect(
      bandsPaintedOverABorder(rects).map((r) => `${r.op} x=${r.x} y=${r.y} w=${r.w} h=${r.h}`),
      'every band is painted BEFORE the border it sits inside',
    ).toEqual([]);

    // …AND ON A CONTINUATION SHEET. `earningsContinued` exists because the Earnings box can spill, and a
    // box drawn per page is bordered per page — so a band painted over a border would be painted over
    // again on every sheet the box runs onto. Seventy rows is the fixture the continuation test uses.
    const spilled = await renderPayslipPdf(
      {
        ...full,
        allowance: 700,
        earningLines: Array.from({ length: 70 }, (_, i) => ({ code: `A${i}`, name: `Item ${i}`, amount: 10 })),
        detailNotRecorded: false,
      },
      labels,
    );
    expect(drawnText(spilled), 'the fixture really does continue onto another sheet').toContain('EARNINGS (CONTINUED)');
    expect(await pageCount(spilled)).toBeGreaterThan(1);
    // NON-VACUITY for the sheet that is the whole point: page 2 carries a ruled box AND a filled band, so
    // the emptiness asserted below is a defect that is absent rather than a page with nothing on it.
    const sheet2 = drawnRects(spilled).filter((r) => r.page === 2);
    expect(sheet2.filter((r) => r.op === 'S').length, 'the continuation sheet is ruled').toBeGreaterThan(0);
    expect(sheet2.filter((r) => r.op === 'f').length, 'the continuation sheet has a band').toBeGreaterThan(0);
    expect(
      bandsPaintedOverABorder(drawnRects(spilled)).map((r) => `p${r.page} ${r.op} x=${r.x} y=${r.y}`),
      'a continued box is closed on every sheet it runs onto',
    ).toEqual([]);
  });

  /**
   * a96d320c rev 2 — AND THE OTHER HALF OF THE SAME BOX, which nobody circled because it is invisible
   * rather than notched: the rule under the LAST row of a box with no total row and no note sits on
   * exactly the y of the box's own bottom border, and it is drawn afterwards in HAIR at 0.5pt over a
   * RULE at 0.8pt. The border survives as 0.15pt of colour either side of a near-white stripe. Payment
   * information is such a box, and it is one of the four the reporter marked.
   */
  it('the Employment Info card retains bank information without an obsolete payment box',async()=>{const text=drawnText(await renderPayslipPdf({...data,bankAccount:'157123456789'},labels));expect(text).toContain('157123456789');expect(text).not.toContain('PAYMENT INFORMATION');});;

  /**
   * a96d320c rev 2 — "A PAYSLIP AS SHORT AS THE MONTH IT DESCRIBES", and the one exception the reporter
   * wrote into their own request and then approved in writing.
   *
   * Earnings with nothing on them come off; the four statutory deduction lines stay at 0.00. CLAUDE.md
   * §8 is the whole argument and it cuts both ways: an absent box asserts nothing, `0.00` asserts the
   * money does not exist. "PCB 0.00" tells the employee no tax was taken this month; a payslip that never
   * mentions tax tells them nothing, and that is the line they read when they file their own return.
   */
  it('stops printing empty earning lines, and KEEPS the four statutory deduction zeros', async () => {
    const bare = {
      ...data,
      allowance: 0,
      overtime: 0,
      bonus: 0,
      claim: 0,
      earningLines: [],
      bonusLines: [],
      overtimeLines: [],
      gross: 6500,
      epfEmployee: 715,
      socsoEmployee: 24.75,
      socsoSkbbk: 0,
      eisEmployee: 9.9,
      pcb: 0,
    };
    const text = drawnText(await renderPayslipPdf(bare, labels));

    expect(text).toContain(labels.basicSalary); // the wage is NOT subject to the rule — it is the anchor
    expect(text).not.toContain(labels.allowances);
    expect(text).not.toContain(labels.overtime);
    expect(text).not.toContain(labels.bonus);
    expect(text).not.toContain(labels.claim);

    // …and the four statutory lines are all still there, two of them printing a zero.
    for (const label of [labels.epf, labels.socso, labels.eis, labels.pcb]) expect(text).toContain(label);
    expect(text).toContain('MYR 0.00');

    // CONTROL: the same document with money in those figures prints all three rows. Without this the
    // assertions above would pass on a renderer that had simply stopped drawing an Earnings box.
    const paid = drawnText(await renderPayslipPdf({ ...bare, allowance: 500, overtime: 120, bonus: 800 }, labels));
    expect(paid).toContain(labels.allowances);
    expect(paid).toContain(labels.overtime);
    expect(paid).toContain(labels.bonus);
    expect(paid).toContain('MYR 500.00');
  });

  /**
   * a96d320c rev 2 — A FIGURE THAT WENT NEGATIVE IS STILL PRINTED.
   *
   * docs/audits/0085-delta-keys-sign-inventory.md Class B: "a negative makes a line VANISH from a money
   * document … worse than printing a negative, because there is nothing for the reader to question." The
   * new rule is `!== 0`, not `> 0`, precisely so it cannot become that defect.
   */
  it('hides an earning line at zero, but never one that carries a negative figure', async () => {
    const text = drawnText(
      await renderPayslipPdf({ ...data, allowance: -250, overtime: 0, bonus: 0, earningLines: [], overtimeLines: [], bonusLines: [] }, labels),
    );
    expect(text).toContain(labels.allowances);
    expect(text).toContain('MYR -250.00');
    expect(text).not.toContain(labels.overtime);
  });

  /**
   * a96d320c rev 2 — SKBBK IS AN ELECTION, AND `> 0` COULD NOT SEE IT.
   *
   * `subject_to_skbbk` is a real per-employee boolean and the engine returns 0 when it is off, so the old
   * predicate conflated "this employee has no SKBBK" with "has SKBBK, contributed 0.00 this run". On the
   * second of those the zero is the assertion — the same argument that keeps EPF/SOCSO/EIS/PCB at 0.00.
   * The run now stamps the election (core/payroll.ts `skbbkSubject`); the amount clause stays beside it
   * because every payslip written before the stamp answers `null` and must render exactly as it does now.
   */
  it('prints the SKBBK line on the ELECTION, not on the amount', async () => {
    const zero = { ...data, socsoSkbbk: 0 };
    // 1. Stamped subject, contributed nothing this run ⇒ the line prints, at 0.00. THE FIX.
    expect(drawnText(await renderPayslipPdf({ ...zero, socsoSkbbkSubject: true }, labels))).toContain(labels.skbbk);
    // 2. Stamped NOT subject ⇒ no line. An absent box asserts nothing, which is the truth here.
    expect(drawnText(await renderPayslipPdf({ ...zero, socsoSkbbkSubject: false }, labels))).not.toContain(labels.skbbk);
    // 3. NO STAMP — every payslip that exists today. Unchanged: the amount decides, so a historical
    //    document neither grows a line nor loses one, and its deduction box still adds up to its total.
    expect(drawnText(await renderPayslipPdf(zero, labels))).not.toContain(labels.skbbk);
    expect(drawnText(await renderPayslipPdf({ ...zero, socsoSkbbk: 12.5 }, labels))).toContain(labels.skbbk);
    // 4. …and a figure that went negative is never hidden by the election (Class B again).
    expect(
      drawnText(await renderPayslipPdf({ ...zero, socsoSkbbk: -12.5, socsoSkbbkSubject: false }, labels)),
    ).toContain(labels.skbbk);
  });

  /**
   * a96d320c rev 2 — the ROUTE half of the same fix: both PDF routes read the stamp through
   * `buildPayslipPdfData`, so neither can decide the question for itself.
   */
  it('reads the SKBBK election off the payslip snapshot, never off anything else', async () => {
    const row = {
      employee: 'Aisyah Rahman', employeeCode: 'EMP-001', company: 'Demo Sdn Bhd', companyReg: null,
      payPeriod: '2026-06', basic: 6500, allowance: 0, overtime: 0, bonus: 0, gross: 6500,
      otherDeductions: 0, totalDeductions: 749.65, net: 5750.35, employerCost: 7441.55, daysWorked: 22,
    };
    const borne = { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' } as const;
    expect(
      buildPayslipPdfData({ ...row, statutory: { socsoSkbbk: 0, skbbkSubject: true } }, borne).socsoSkbbkSubject,
    ).toBe(true);
    expect(
      buildPayslipPdfData({ ...row, statutory: { socsoSkbbk: 0, skbbkSubject: false } }, borne).socsoSkbbkSubject,
    ).toBe(false);
    // A slip written before the stamp cannot answer, and `null` is not `false`: it is what sends the
    // renderer back to the amount clause.
    expect(buildPayslipPdfData({ ...row, statutory: { socsoSkbbk: 0 } }, borne).socsoSkbbkSubject).toBeNull();
    // A jsonb blob is not a type: a value this version does not understand is not guessed at.
    expect(
      buildPayslipPdfData({ ...row, statutory: { socsoSkbbk: 0, skbbkSubject: 'yes' } }, borne).socsoSkbbkSubject,
    ).toBeNull();
  });

  it('keeps the `sub` slot: the day count still rides beside an unpaid-leave line', async () => {
    // THE CARE IN THE CODE REMOVAL. The two sites that pushed `sub: l.code` are gone; the slot itself is
    // not, because the deduction box uses it for `absenceDaysLabel` — which is the OPPOSITE of what the
    // reporter objected to. Deleting the mechanism would have taken "2 days" off the payslip with it.
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          otherDeductions: 420,
          totalDeductions: 1519.65,
          net: 5600.35,
          absence: {
            unpaidLeave: { days: 2, amount: 420 },
            absent: null,
            cp38: { amount: 0, show: false },
            residual: 0,
            showResidual: false,
            any: true,
          },
        },
        labels,
      ),
    );
    expect(text).toContain('Unpaid leave');
    expect(text).toContain('2 days');
  });

  it('prints no internal pay code anywhere on a document made entirely of coded items', async () => {
    // The blanket version of the two per-site assertions above: every itemised box at once.
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          allowance: 500,
          bonus: 300,
          overtime: 120,
          gross: 7420,
          earningLines: [{ code: 'A0027', name: 'Handphone allowance', amount: 500 }],
          bonusLines: [{ code: 'B0001', name: 'ANGPOW', amount: 300 }],
          overtimeLines: [{ code: 'OT15', name: 'OVERTIME 1.5', amount: 120 }],
          nonPayableLines: [{ code: 'BIK01', name: 'COMPANY CAR', amount: 850 }],
          detailNotRecorded: false,
        },
        labels,
      ),
    );
    for (const name of ['Handphone allowance', 'ANGPOW', 'OVERTIME 1.5', 'COMPANY CAR']) {
      expect(text, `${name} is still named`).toContain(name);
    }
    for (const code of ['A0027', 'B0001', 'OT15', 'BIK01']) {
      expect(text, `${code} is an internal key, not something an employee can use`).not.toContain(code);
    }
  });
});

/**
 * a96d320c — THE RATE AND THE INPUT REACH THE PAGE, AND ONLY WHEN THEY EXPLAIN THE FIGURE BESIDE THEM.
 *
 * This is the half of the item that needed something the payslip did not record. The hours behind an
 * overtime figure live in attendance, and attendance is correctable after a run — so a document that
 * fetched them when it was opened would answer with a later month's attendance about money already paid.
 * The kernel stamps them instead (migration 0479, `statutory.otDetail`), and this file's job is to prove
 * the renderer PRINTS what it was given and DERIVES nothing.
 *
 * Every assertion below is about a document, not about a database: `buildPayslipPdfData` is handed a
 * statutory blob of exactly the shape the kernel writes, and the drawn text is read back.
 */
describe('a96d320c — the overtime rate and the hours behind it', () => {
  /** A payslip whose whole overtime figure is one attendance-derived leg: 2h at 1.5 × MYR 12.50. */
  const otSlip = (otDetail: unknown, overtime = 37.5) =>
    buildPayslipPdfData(
      {
        employee: 'Aisyah Rahman', employeeCode: 'EMP-001', company: 'Demo Sdn Bhd', companyReg: null,
        payPeriod: '2026-05', basic: '2600.00', allowance: '0', overtime: String(overtime), bonus: '0',
        gross: String(2600 + overtime), otherDeductions: '0', totalDeductions: '0',
        net: String(2600 + overtime), employerCost: String(2600 + overtime), daysWorked: '31',
        statutory: { otDetail },
      },
      { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' },
      { currency: 'MYR' },
    );

  const WORKDAY_2H = {
    version: 1,
    orp: 100,
    hourly: 12.5,
    total: 37.5,
    lines: [{ kind: 'workday', qty: 2, unit: 'hours', rate: 18.75, amount: 37.5 }],
  };

  /**
   * The drawn text with its LINE BREAKS FLATTENED to spaces.
   *
   * A row label wraps inside a half-width column — that is the whole reason `wrap()` exists — so
   * "Overtime - normal working day · 2 hours × MYR 18.75" legitimately reaches the page as two drawn
   * runs. Asserting on the raw join would be asserting on the column width. `wrap` splits on whitespace
   * and the reader reads it back the same way, so joining with a space reconstructs the label.
   */
  const flat = (bytes: Uint8Array) => drawnText(bytes).replace(/\n/g, ' ');

  it('prints the leg, its hours and its rate in place of the bare "Overtime" row', async () => {
    const bytes = await renderPayslipPdf(otSlip(WORKDAY_2H), labels);
    expect(flat(bytes)).toContain('Overtime - normal working day · MYR 18.75 2 hours');
    expect(flat(bytes)).toContain('MYR 37.50');
    // The category word gave way to the rule that paid it, exactly as a named pay item replaces it.
    // Checked on the PLACEMENTS, because 'Overtime' is a substring of every leg label above.
    expect(
      placed(drawnPlacements(bytes), labels.overtime),
      'no bare grouped Overtime row survives beside the legs',
    ).toBeUndefined();
  });

  it('prints a RATE at the precision it actually has, so the multiplication works out', async () => {
    // A rate of MYR 36.045 is what 1.5 × an hourly rate of MYR 24.03 IS. Rounded to the sen for display
    // it would read "10 hours × MYR 36.05 = MYR 360.45" — a payslip that does not multiply out, on the
    // one document whose whole purpose is that its arithmetic can be checked.
    const detail = {
      version: 1, orp: 192.24, hourly: 24.03, total: 360.45,
      lines: [{ kind: 'workday', qty: 10, unit: 'hours', rate: 36.045, amount: 360.45 }],
    };
    const text = flat(await renderPayslipPdf(otSlip(detail, 360.45), labels));
    expect(text).toContain('MYR 36.045 10 hours');
    expect(text).toContain('MYR 360.45');
  });

  it('names the day-rate legs in DAYS, and the singular in the singular', async () => {
    const detail = {
      version: 1, orp: 100, hourly: 12.5, total: 250,
      lines: [
        { kind: 'rest_day', qty: 1, unit: 'days', rate: 100, amount: 100 },
        { kind: 'holiday', qty: 1.5, unit: 'days', rate: 100, amount: 150 },
      ],
    };
    const text = flat(await renderPayslipPdf(otSlip(detail, 250), labels));
    expect(text).toContain('Overtime - rest day · MYR 100.00 1 day');
    expect(text).toContain('Overtime - public holiday · MYR 100.00 1.5 days');
  });

  it('REFUSES the whole itemisation when the legs do not add up to the stored overtime figure', async () => {
    // The same money-safety guard the allowance and bonus itemisations live under. Rows on a payslip that
    // fall short of the total beside them is the one failure this document may never commit.
    const text = flat(await renderPayslipPdf(otSlip(WORKDAY_2H, 50), labels));
    expect(text).toContain('Overtime');
    expect(text, 'a leg that does not reconcile is not printed at all').not.toContain('2 hours ×');
  });

  it('DROPS a leg it does not understand — which costs the itemisation its reconciliation', async () => {
    // A payslip stamped by a later version that added a sixth leg. Printing the legs this version knows
    // would print a breakdown that silently omits part of the money; dropping the unknown one makes the
    // remainder fall short, and the grouped row stands. Three independent failures, one safe answer.
    const detail = {
      version: 1, orp: 100, hourly: 12.5, total: 87.5,
      lines: [
        { kind: 'workday', qty: 2, unit: 'hours', rate: 18.75, amount: 37.5 },
        { kind: 'night_shift_from_the_future', qty: 4, unit: 'hours', rate: 12.5, amount: 50 },
      ],
    };
    const text = flat(await renderPayslipPdf(otSlip(detail, 87.5), labels));
    expect(text).toContain('Overtime');
    expect(text).not.toContain('2 hours ×');
  });

  it('REFUSES a leg whose own quantity and rate do not produce its own amount', async () => {
    // The check the kernel made at write time, made again on read, because a jsonb blob is not a type.
    const detail = {
      version: 1, orp: 100, hourly: 12.5, total: 37.5,
      lines: [{ kind: 'workday', qty: 2, unit: 'hours', rate: 18.75, amount: 99 }],
    };
    const d = otSlip(detail, 37.5);
    expect(d.overtimeLines, 'a leg that does not multiply out is not a leg').toEqual([]);
  });

  it('a payslip whose run recorded nothing prints the overtime line exactly as it does today', async () => {
    const d = otSlip(undefined, 37.5);
    expect(d.overtimeLines).toEqual([]);
    const text = flat(await renderPayslipPdf(d, labels));
    expect(text).toContain('Overtime');
    expect(text).not.toContain('×');
  });

  it('prints the quantity and rate a PAY ITEM rule multiplied, straight off the component stamp', async () => {
    // The generic half of the same mechanism, and the one that answers for a quantity-priced deduction or
    // allowance rather than for statutory overtime: `earningsOf` stamps `detail` onto the component line
    // when `round2(qty × rate)` is the amount, and it rides through to the page from there.
    const d = buildPayslipPdfData(
      {
        employee: 'Aisyah Rahman', employeeCode: 'EMP-001', company: 'Demo Sdn Bhd', companyReg: null,
        payPeriod: '2026-05', basic: '2600.00', allowance: '450.00', overtime: '0', bonus: '0',
        gross: '3050.00', otherDeductions: '0', totalDeductions: '0', net: '3050.00',
        employerCost: '3050.00', daysWorked: '31',
        statutory: {
          componentLines: [
            {
              code: 'A0044', name: 'Site allowance', amount: 450,
              buckets: [{ bucket: 'wage', amount: 450 }],
              detail: { qty: 18, rate: 25, unit: 'days' },
            },
          ],
        },
      },
      { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' },
      { currency: 'MYR' },
    );
    const text = flat(await renderPayslipPdf(d, labels));
    expect(text).toContain('Site allowance · MYR 25.00 18 days');
    expect(text, 'the internal pay code is still off the document').not.toContain('A0044');
  });

  it('drops the caption when the row prints only PART of what the factors explain', async () => {
    // A pay item whose money split across buckets (09b554e9: an exempt portion paid untaxed plus a
    // taxable remainder) contributes part of itself to the allowance line. The factors describe the WHOLE
    // item, so captioning the partial row with them would print a multiplication that does not produce
    // the figure beside it. Name and amount survive; only the caption is dropped.
    const d = buildPayslipPdfData(
      {
        employee: 'Aisyah Rahman', employeeCode: 'EMP-001', company: 'Demo Sdn Bhd', companyReg: null,
        payPeriod: '2026-05', basic: '2600.00', allowance: '300.00', overtime: '0', bonus: '0',
        gross: '2900.00', otherDeductions: '0', totalDeductions: '0', net: '2900.00',
        employerCost: '2900.00', daysWorked: '31',
        statutory: {
          componentLines: [
            {
              code: 'A0044', name: 'Site allowance', amount: 450,
              buckets: [{ bucket: 'wage', amount: 300 }, { bucket: 'bonus', amount: 150 }],
              detail: { qty: 18, rate: 25, unit: 'days' },
            },
          ],
        },
      },
      { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' },
      { currency: 'MYR' },
    );
    expect(d.earningLines).toEqual([{ code: 'A0044', name: 'Site allowance', amount: 300 }]);
    const text = flat(await renderPayslipPdf(d, labels));
    expect(text).toContain('Site allowance');
    expect(text).not.toContain('18 days ×');
  });
});

/**
 * ─── a96d320c rev 3 — THE FOUR THINGS THE REPORTER CONTESTED, AND THEN APPROVED ───
 *
 * Four separate complaints about one document, all read off the RENDERED FILE rather than off a 200 or a
 * source grep: an unidentified number in the header, a bordered employee-information grid with an empty
 * cell in it, two totals that do not line up, and non-payable amounts stranded under NET PAY. Board item
 * 048f1e9d (the employee details block) is folded in here — it is the second of the four.
 *
 * NOTHING IN THIS ROUND MAY MOVE A FIGURE. The last assertion in this block is the one that says so.
 */
describe('a96d320c rev 3 — the header number, the de-boxed panel, aligned totals, the Other column', () => {
  /** The letterhead rule: the one 1.6pt line on the sheet, under the company name. */
  const letterheadRuleY = (bytes: Uint8Array) => {
    const rules = drawnLines(bytes).filter((l) => l.w === 1.6 && l.page === 1);
    expect(rules.length, 'exactly one letterhead rule').toBe(1);
    return rules[0].y1;
  };

  /**
   * ─── REWRITTEN BY r360 (feedback 1fe55a23), NOT RELAXED — READ THIS BEFORE CHANGING IT BACK ───
   *
   * This case used to assert that the registration number was OFF the document entirely, and that the
   * letterhead was the same height either way. Both halves were right on a96d320c's own terms and neither
   * survives r360, because what the reporter objected to then was an UNIDENTIFIED number: `201901024512`
   * drawn under the company name with no caption, on 2 of 5 production companies, so the same document
   * printed a bare figure for some employees and not for others. a96d320c's own note ended "do not re-add
   * it to the letterhead without a label beside it" — and the reporter has now asked for exactly that,
   * labelled "Reg. no." and directly below the company name.
   *
   * So the assertion becomes the LABEL, and the height rule inverts in the one direction that is honest:
   * the band is 12pt taller only when something is drawn in it. The no-registration document is still
   * byte-identical in height to today's, which is the fallback the plan promised.
   */
  it('retains a labelled full registration below the header company without duplicating the profile', async () => {
    const p=drawnPlacements(await renderPayslipPdf(data,labels));
    const registration=placed(p,`${labels.companyReg}: ${data.companyReg}`)!;
    expect(registration).toBeDefined();
    expect(registration.y).toBeLessThan(placed(p,data.company)!.y);
    expect(registration.y).toBeGreaterThan(placed(p,'EMPLOYEE PROFILE')!.y);
    expect(p.filter(r=>r.text.includes(data.companyReg!))).toHaveLength(1);
    const bare=drawnText(await renderPayslipPdf({...data,companyReg:null},labels));
    expect(bare).not.toContain(labels.companyReg);
    expect(bare).not.toContain(data.companyReg!);
    const built=buildPayslipPdfData({...data,companyReg:'201901024512',statutory:{}},{epf:'EPF',socso:'SOCSO',skbbk:'SKBBK',eis:'EIS',tax:'PCB'});
    expect(built.companyReg).toBe('201901024512');
    expect(drawnText(await renderPayslipPdf(built,labels))).toContain('201901024512');
  });

  it('prints whatever cycle name it is handed beside the subtitle, and drops the segment when handed none', async () => {
    const named = drawnText(await renderPayslipPdf({ ...data, cycleLabel: 'Monthly' }, labels));
    expect(named, 'the reporter’s own example').toContain('Monthly');
    expect(named, 'and the run-type word it replaces is nowhere on the document').not.toContain('Regular');

    // A batch that named no cycle AND no recognised run type: the subtitle is the document name alone,
    // never "Payroll payslip · " with nothing after the separator.
    const none = drawnText(await renderPayslipPdf({ ...data, cycleLabel: null }, labels));
    expect(none).not.toContain(labels.documentSubtitle);
    expect(none, 'no orphaned separator').not.toContain(`${labels.documentSubtitle} ·`);
  });

  it('lands the two totals on ONE baseline whatever the row counts are', async () => {
    // Sweep the reversal in both directions. `data` is 3 earnings rows against 4 deduction rows; adding a
    // bonus makes it 4 against 4; a CP38 line and an absence line make it 3 against 6. Every one of them
    // must print TOTAL EARNINGS and TOTAL DEDUCTIONS on the same baseline.
    const cases: [string, Partial<PayslipPdfData>][] = [
      ['3 earnings / 4 deductions', {}],
      ['4 earnings / 4 deductions', { bonus: 800, gross: 7920 }],
      // 970e4143 — ⚠️ THESE TWO FIXTURES USED TO ENCODE THE OPPOSITE OF WHAT THE KERNEL DOES: `cp38: 50`
      // with `otherDeductions: 0` and the total bumped by 50, i.e. CP38 sitting OUTSIDE other_deductions.
      // The kernel folds the APPLIED CP38 INTO that column (core/payroll.ts `slipExtraDeduct`), so a
      // correct fixture raises `otherDeductions` by the instalment and takes it back out of `residual`.
      // Corrected because a misleading fixture is what a reader copies the next time.
      [
        '3 earnings / 5 deductions',
        {
          cp38: 50, otherDeductions: 50, totalDeductions: 1149.65, net: 5970.35,
          absence: { unpaidLeave: null, absent: null, cp38: { amount: 50, show: true }, residual: 0, showResidual: false, any: false },
        },
      ],
      [
        '3 earnings / 6 deductions',
        {
          cp38: 50, otherDeductions: 250, totalDeductions: 1349.65, net: 5770.35,
          absence: {
            unpaidLeave: { days: 2, amount: 200 }, absent: null,
            cp38: { amount: 50, show: true }, residual: 0, showResidual: false, any: true,
          },
        },
      ],
      ['5 earnings / 4 deductions', { bonus: 800, claim: 120, gross: 8040 }],
    ];
    for (const [name, patch] of cases) {
      const p = drawnPlacements(await renderPayslipPdf({ ...data, ...patch }, labels));
      const te = placed(p, 'TOTAL EARNINGS');
      const td = placed(p, 'TOTAL DEDUCTIONS');
      expect(te, `${name}: TOTAL EARNINGS is drawn`).toBeDefined();
      expect(td, `${name}: TOTAL DEDUCTIONS is drawn`).toBeDefined();
      expect(te!.page, `${name}: on one sheet`).toBe(td!.page);
      expect(td!.y, `${name}: the two totals share a baseline`).toBeCloseTo(te!.y, 1);
    }
  });

  it('the padding is a FLOOR: it never crops a row, and the shorter box still shows every line it has', async () => {
    // The mechanism holds the shorter body open. It must not do anything else — in particular it must not
    // be able to swallow a row by capping a body instead of extending it.
    const text = drawnText(
      await renderPayslipPdf(
        {
          ...data,
          // 970e4143 — the kernel's model: the instalment is INSIDE other_deductions and comes back out of
          // the residual. See the corrected case table above.
          cp38: 50, otherDeductions: 50, totalDeductions: 1149.65, net: 5970.35,
          absence: { unpaidLeave: null, absent: null, cp38: { amount: 50, show: true }, residual: 0, showResidual: false, any: false },
        },
        labels,
      ),
    );
    for (const row of ['Basic salary', 'Allowances', 'Overtime', 'EPF', 'SOCSO', 'EIS', 'PCB', 'CP38']) {
      expect(text, `the padded pair still prints ${row}`).toContain(row);
    }
  });

  /**
   * ⚠️ THE CONTINUATION PATH — where a naive per-side fix breaks.
   *
   * `total` is handed to `paintBox` only on `c.final`. A fix that padded whenever ITS OWN side was final
   * would, on a sheet where Earnings is mid-flow and Deductions has finished, hold the Deductions body
   * open to the height of the Earnings CHUNK — thirty-odd rows — and drive that box and its total
   * straight through the footer and off the sheet. The transaction pair now retains an empty shorter
   * body without its total until BOTH sides can finish, with every continuation bounded by the footer.
   */
  it('carries both transaction totals to the same final page without losing rows or crossing the footer', async () => {
    const spilled = await renderPayslipPdf(
      {
        ...data,
        allowance: 700,
        earningLines: Array.from({ length: 70 }, (_, i) => ({ code: `A${i}`, name: `Item ${i}`, amount: 10 })),
      },
      labels,
    );
    expect(await pageCount(spilled), 'the fixture really does continue onto another sheet').toBeGreaterThan(1);
    const p = drawnPlacements(spilled);
    expect(drawnText(spilled)).toContain('EARNINGS (CONTINUED)');

    const td = placed(p, 'TOTAL DEDUCTIONS')!;
    const te = placed(p, 'TOTAL EARNINGS')!;
    expect(te.page, 'Earnings really continues').toBeGreaterThan(1);
    expect(td.page, 'the shorter deductions total follows the final earnings chunk').toBe(te.page);
    expect(td.y,'the final totals share one baseline').toBeCloseTo(te.y,3);
    expect(p.filter(r=>r.text==='TOTAL DEDUCTIONS')).toHaveLength(1);
    expect(p.filter(r=>r.text==='TOTAL EARNINGS')).toHaveLength(1);
    const itemTokens=drawnText(spilled).match(/Item \d+/g);
    expect(itemTokens).toEqual(Array.from({length:70},(_,i)=>`Item ${i}`));
    // …and nothing on any sheet is drawn below the page margin. The footer sentence itself sits at y=48,
    // between the margin (40) and its own rule (62), and is excluded by name rather than by geometry so
    // this cannot quietly stop measuring if that line moves.
    const offSheet = p.filter((r) => r.y < 40 && r.text !== labels.generatedNote);
    expect(offSheet.map((r) => `p${r.page} y=${r.y} ${r.text}`), 'nothing runs off the sheet').toEqual([]);
    // NON-VACUITY for that sweep: it really did look at three sheets' worth of text.
    expect(p.length, 'there is plenty on the page to have caught').toBeGreaterThan(100);
  });

  it('retains employer contributions and Other on a continuation sheet without an employer cost total',async()=>{const bytes=await renderPayslipPdf({...data,allowance:700,earningLines:Array.from({length:70},(_,i)=>({code:'A'+i,name:'Item '+i,amount:10})),nonPayableLines:[{code:'BIK',name:'Company car',amount:850}]},labels);const p=drawnPlacements(bytes);expect(placed(p,'EMPLOYER CONTRIBUTIONS')!.page).toBeGreaterThan(1);expect(placed(p,'TOTAL NON-PAYABLE')).toBeTruthy();expect(placed(p,'TOTAL EMPLOYER COST')).toBeUndefined();});;

  it('places full-width Other before contributions while retaining profile payment values',async()=>{const p=drawnPlacements(await renderPayslipPdf({...data,bankName:'Maybank',nonPayableLines:[{code:'BIK',name:'Company car',amount:850}]},labels));expect(placed(p,'Maybank')!.y).toBeGreaterThan(placed(p,'EARNINGS')!.y);expect(placed(p,labels.nonPayable.toUpperCase())!.y).toBeGreaterThan(placed(p,'EMPLOYER CONTRIBUTIONS')!.y);expect(placed(p,'PAYMENT INFORMATION')).toBeUndefined();});;

  /**
   * ⚠️ NON-PAYABLE MONEY MAY NOT REACH A TOTAL, AND THIS IS THE ASSERTION THAT SAYS SO.
   *
   * `core/pay-rule.ts` records what happens when it does: the clause that keeps a record-only row out of
   * a daily-rate base was once MISSING, and a ticked non-payable 500 with 2 unpaid days wrote
   * otherDeductions 419.35 instead of 387.10 — and because the unpaid deduction is pre-statutory, EPF,
   * SOCSO, EIS, PCB and HRDF all moved with it. This document only LAYS OUT figures, but moving the box
   * into the same band as Employer contributions is exactly the kind of change that invites someone to
   * "tidy" the amount into a total beside it.
   */
  it('a non-payable line changes NO figure on the document', async () => {
    const base: PayslipPdfData = { ...data, paymentMethod: 'Bank transfer', bankName: 'Maybank' };
    const withOther: PayslipPdfData = {
      ...base,
      nonPayableLines: [
        { code: 'BIK01', name: 'Company car benefit in kind', amount: 850 },
        { code: 'BIK02', name: 'Accommodation benefit in kind', amount: 1200 },
      ],
    };
    const before = drawnText(await renderPayslipPdf(base, labels));
    const after = drawnText(await renderPayslipPdf(withOther, labels));

    // THE FOUR THE EMPLOYEE ACTUALLY READS, named first so a failure says which one moved.
    for (const [what, value] of [
      ['gross / total earnings', 'MYR 7,120.00'],
      ['total deductions', 'MYR 1,099.65'],
      ['net pay', 'MYR 6,020.35'],
    ] as const) {
      expect(before, `${what} before`).toContain(value);
      expect(after, `${what} MOVED when a non-payable line was added — it must be byte-identical`).toContain(value);
    }

    // …and then every money string the document prints, compared as a SET, because a named list only
    // catches the figures this test thought of. `added` names the offender when one appears.
    const figures = (t: string) => t.split('\n').filter((l) => /^MYR [\d,]+\.\d\d$/.test(l)).sort();
    const added = figures(after).filter((f) => !figures(before).includes(f));
    const lost = figures(before).filter((f) => !figures(after).includes(f));
    // 850, 1200 and their own total 2,050 are the ONLY new figures, and all three are in the Other box.
    expect(
      added.sort(),
      'the only new figures are the two non-payable lines and their own total',
    ).toEqual(['MYR 1,200.00', 'MYR 2,050.00', 'MYR 850.00']);
    expect(lost, 'no figure was removed or rewritten').toEqual([]);
    // NON-VACUITY: the comparison really did have a population to compare.
    expect(figures(before).length, 'the document prints plenty of figures').toBeGreaterThan(8);
    // The non-payable amounts are NOT folded into any of them.
    expect(after).not.toContain('MYR 9,170.00'); // gross + 2050, had it been folded into earnings
    expect(after).not.toContain('MYR 8,070.35'); // net + 2050, had it been folded into net pay
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * r367 (item e0b6e3b8) — ONE `EMPLOYMENT INFO` HEADING OVER THE WHOLE BAND, AND THE PAYSLIP DID NOT
 * GET LONGER.
 *
 * THE DEFECT. `EMPLOYMENT INFO` headed only the RIGHT half of the employee band. The employee's name and
 * their four statutory reference numbers — the left half — sat under no heading at all, and the two halves
 * began at different heights, so nothing lined up across the middle. The reporter named both.
 *
 * WHY THE HEIGHT IS THE HARD PART, AND WHY IT IS ASSERTED RATHER THAN CLAIMED. A heading above both halves
 * costs 15pt. It is paid for twice over: the right half loses the 17pt caption slot it used to carry, and
 * the employee's name and code move onto ONE line, 20pt where the two stacked were 34. The band is 90pt
 * where it was 92, so every block below it moves UP two points. "The payslip did not get longer" is the
 * whole constraint of this request, and a constraint nobody measured is a constraint nobody kept — so the
 * numbers below are read back out of the PRODUCED DOCUMENT and were derived from it, not from arithmetic.
 *
 * 525.89 is where TOTAL EARNINGS sat before this round, measured the same way on the same fixtures. Every
 * case asserts the new y AND that it is not below that figure, which is the claim in its own terms.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('r378 — one configurable Employment Info card',()=>{it('honours supplied fields and hides name/code when disabled',async()=>{const text=drawnText(await renderPayslipPdf({...data,employee:'Hidden employee',employeeCode:'Hidden code',informationRows:[{label:'Branch',value:'North branch'}]},labels));expect(text).toContain('North branch');expect(text).not.toContain('Hidden employee');expect(text).not.toContain('Hidden code');expect(text.match(/EMPLOYEE PROFILE/g)).toHaveLength(1);});});;

describe('r379 — reporter reference columns without losing saved evidence',()=>{
  it('places quantity in its own cell while preserving the exact saved rate in the description',async()=>{
    const bytes=await renderPayslipPdf({...data,allowance:0,overtime:111.11,overtimeLines:[{code:'OT',name:'Recorded overtime',amount:111.11,detail:{qty:2,unit:'hours',rate:55.555}}]},labels);
    const runs=drawnPlacements(bytes);
    const quantity=placed(runs,'2 hours')!;
    const amount=placed(runs,'MYR 111.11')!;
    const rate=runs.find(r=>r.text.includes('55.555'))!;
    expect(quantity).toBeDefined();expect(rate).toBeDefined();expect(amount).toBeDefined();
    expect(quantity.page).toBe(amount.page);expect(quantity.y).toBeCloseTo(amount.y,3);
    expect(quantity.x).toBeGreaterThan(rate.x);
    expect(amount.x).toBeGreaterThan(quantity.x);
    expect(drawnText(bytes)).toContain('Day/Hrs');
    expect(drawnText(bytes)).not.toContain('\nRate\n');
    expect(drawnText(bytes).replace(/\n/g,' ')).not.toContain(labels.periodScopeNote!);
  });
  it('continues an exceptionally long single description completely and prints its saved amount once',async()=>{
    const name=Array.from({length:300},(_,i)=>`Evidence${i}`).join(' ');
    const bytes=await renderPayslipPdf({...data,allowance:111.11,overtime:0,earningLines:[{code:'LONG',name,amount:111.11}],detailNotRecorded:false},labels);
    const text=drawnText(bytes),flat=text.replace(/\n/g,' ');
    expect(await pageCount(bytes)).toBeGreaterThan(1);
    expect(flat.match(/\bEvidence\d+\b/g),'every exact saved description token appears once in order').toEqual(Array.from({length:300},(_,i)=>`Evidence${i}`));
    expect(text.match(/MYR 111\.11/g)).toHaveLength(1);
    expect(text).toContain('EARNINGS (CONTINUED)');
    const runs=drawnPlacements(bytes);
    expect(runs.filter(r=>r.y<24).map(r=>r.text),'all actual text baselines clear the page margin').toEqual([]);
    expect(runs.length).toBeGreaterThan(150);
  });
  it('retains the whole employer name when the name itself needs continuation pages',async()=>{
    const tokens=Array.from({length:200},(_,i)=>`EmployerWord${i}`);
    const bytes=await renderPayslipPdf({...data,company:tokens.join(' ')},labels);
    expect(await pageCount(bytes)).toBeGreaterThan(1);
    expect(drawnText(bytes).replace(/\n/g,' ').match(/\bEmployerWord\d+\b/g),'complete letterhead without a duplicate profile value').toEqual(tokens);
    expect(drawnPlacements(bytes).filter(r=>r.y<24)).toEqual([]);
  });
  it('shows unknown employer snapshots as Not recorded and retains explicit zero separately',async()=>{
    const p={mtd:{epf:null,socso:0,eis:null,hrdf:null},ytd:{epf:100,socso:null,eis:0,hrdf:null}};
    const text=drawnText(await renderPayslipPdf({...data,hrdf:0,employerPeriodTotals:p,ytd:{gross:7120,net:6020.35,epf:715,socso:24.75,eis:9.9,pcb:350}},labels));
    expect(text.replace(/\n/g,' ').match(/Not recorded/g)!.length).toBe(5);
    expect(text).toContain('MYR 0.00');expect(text).toContain('MYR 100.00');
    expect(text.replace(/\n/g,' ')).not.toContain(labels.normalEmployerNote!);
    expect(text).not.toContain('credited into your bank account');
  });
  it('places the full-width Other section below Net Pay and above the employer period tables',async()=>{
    const bytes=await renderPayslipPdf({...data,nonPayableLines:[{code:'BIK',name:'Recorded benefit',amount:850}]},labels);
    const runs=drawnPlacements(bytes),net=placed(runs,'NET PAY')!,other=placed(runs,labels.nonPayable.toUpperCase())!,employer=placed(runs,'EMPLOYER CONTRIBUTIONS')!;
    expect(other.page).toBe(net.page);expect(other.y).toBeLessThan(net.y);
    expect(employer.page).toBe(other.page);expect(employer.y).toBeLessThan(other.y);
    expect(drawnText(bytes)).toContain('TOTAL NON-PAYABLE');expect(drawnText(bytes)).toContain('MYR 850.00');
  });
});


describe('r381 — newest reporter payslip layout',()=>{
  it('keeps company at left and Month Year at right on the same first header line without the old document title',async()=>{
    const bytes=await renderPayslipPdf({...data,logo:null},labels);
    const runs=drawnPlacements(bytes);
    const company=placed(runs,data.company)!,period=placed(runs,labels.periodLabel)!;
    expect(company).toBeDefined();expect(period).toBeDefined();
    expect(company.page).toBe(period.page);
    expect(company.y).toBeCloseTo(period.y,3);
    expect(period.x).toBeGreaterThan(company.x+200);
    expect(drawnText(bytes)).not.toContain(labels.documentSubtitle);
  });
  it('prints the actual saved payment date under Payment Date, with no Payment Information caption',async()=>{
    expect(payslipPaymentDate('2026-09-30')).toBe('30 Sep 2026');
    expect(payslipPaymentDate('2026-02-31')).toBe('2026-02-31');
    expect(payslipPaymentDate('')).toBe('');
    const bytes=await renderPayslipPdf({...data,payDate:'2026-09-30'}, {...labels,paymentDate:payslipPaymentDate('2026-09-30')});
    const text=drawnText(bytes),runs=drawnPlacements(bytes);
    expect(text).toContain('Payment Date');expect(text).toContain('30 Sep 2026');
    expect(text).not.toContain(labels.paymentInformation);
    const payment=placed(runs,'Payment Date: 30 Sep 2026')!;
    expect(payment).toBeDefined();
    expect(payment.y).toBeGreaterThan(placed(runs,'EMPLOYEE PROFILE')!.y);
    expect(runs.filter(r=>r.text.includes('30 Sep 2026'))).toHaveLength(1);

  });
  it('places saved gross and net YTD inside the same Year to Date box as saved statutory YTD',async()=>{
    const bytes=await renderPayslipPdf({...data,ytd:{gross:21360,net:18061.05,epf:2145,socso:74.25,eis:29.7,pcb:1050}},labels);
    const runs=drawnPlacements(bytes),rules=drawnRects(bytes),text=drawnText(bytes);
    const gross=placed(runs,'MYR 21,360.00')!,net=placed(runs,'MYR 18,061.05')!,epf=placed(runs,'MYR 2,145.00')!;
    expect(gross).toBeDefined();expect(net).toBeDefined();expect(epf).toBeDefined();
    expect(enclosingRule(rules,gross)).toEqual(enclosingRule(rules,net));
    expect(enclosingRule(rules,gross)).toEqual(enclosingRule(rules,epf));
    expect(text.match(/YEAR TO DATE.*2026/g)).toHaveLength(1);
    expect(text.toLowerCase()).not.toContain('gross and net pay summary');
    expect(text.replace(/\n/g,' ')).not.toContain(labels.normalEmployerNote!);
    expect(text.replace(/\n/g,' ')).not.toContain(labels.periodScopeNote!);
  });
});


describe('r382 retained result on the admin review document', () => {
  it('prints the recorded skip as a separate notice while preserving financial data', async () => {
    const original=structuredClone(data);
    const notice={heading:'Skipped',text:'Nothing payable in this pay period. Previous payroll result retained.'};
    const document=await renderPayslipPdf({...original,reviewNotice:notice},labels);
    const text=drawnText(document);
    expect(text).toContain('SKIPPED');
    expect(text.replace(/\s+/g,' ')).toContain(notice.text);
    expect(original).toEqual(data);
    const issued=drawnText(await renderPayslipPdf(original,labels));
    expect(issued).not.toContain('SKIPPED');
    expect(issued).not.toContain('Previous payroll result retained');
  });
});


describe('r383 restored compact payslip profile',()=>{
 it('keeps only configured employee facts in their saved order followed by payment and cycle',async()=>{
  const subset=[{label:'Position',value:'Configured position'},{label:'Department',value:'Configured department'}];
  const bytes=await renderPayslipPdf({...data,informationRows:subset,bankName:'Saved bank',bankAccount:'FULLACCOUNT',paymentMethod:'Bank transfer',cycleLabel:'Company cycle'},labels);
  const runs=drawnPlacements(bytes),heading=placed(runs,'EMPLOYEE PROFILE')!,earnings=placed(runs,'EARNINGS')!;
  const body=runs.filter(r=>r.page===heading.page&&r.y<heading.y&&r.y>earnings.y).map(r=>r.text);
  expect(body).toEqual(['Position','Configured position','Department','Configured department',labels.paymentMethod,'Bank transfer',labels.bankName,'Saved bank',labels.bankAccount,'FULLACCOUNT',labels.payrollCycleLabel??'Payroll cycle','Company cycle']);
  expect(placed(runs,'Department')!.x-placed(runs,'Position')!.x).toBeCloseTo((595.28-48-24)/2+24,2);
  expect(body).not.toContain(data.company);expect(body).not.toContain(labels.periodLabel);expect(body).not.toContain(data.employee);
  const borders=drawnRects(bytes).filter(r=>r.op==='S'&&r.y<heading.y&&r.y>earnings.y);
  expect(borders,'one outer profile border, without individually boxed fields').toHaveLength(1);
 });
 it('wraps complete configured profile values across pages without losing payment details',async()=>{
  const tokens=Array.from({length:700},(_,i)=>`ProfileToken${i}`);
  const bytes=await renderPayslipPdf({...data,informationRows:[{label:'Department',value:tokens.join(' ')}],bankAccount:'FULLACCOUNT'},labels);
  expect(await pageCount(bytes)).toBeGreaterThan(1);
  expect(drawnText(bytes).replace(/\n/g,' ').match(/ProfileToken\d+/g)).toEqual(tokens);
  expect(drawnText(bytes)).toContain('FULLACCOUNT');
  expect(drawnPlacements(bytes).filter(r=>r.y<24)).toEqual([]);
 });
 it('keeps uploaded logo branding adjacent and period in the header; no-logo and corrupt controls retain text',async()=>{
  for(const logo of [{bytes:fs.readFileSync(new URL('./fixtures/r383-payslip-logo/company.png',import.meta.url)),mimeType:'image/png'},{bytes:fs.readFileSync(new URL('./fixtures/r383-payslip-logo/company.jpg',import.meta.url)),mimeType:'image/jpeg'},null,{bytes:Buffer.from('broken'),mimeType:'image/png'}]){
   const bytes=await renderPayslipPdf({...data,logo},labels),runs=drawnPlacements(bytes);
   const company=placed(runs,data.company)!,period=placed(runs,labels.periodLabel)!,profile=placed(runs,'EMPLOYEE PROFILE')!;
   expect(company).toBeDefined();expect(period).toBeDefined();expect(company.y).toBeCloseTo(period.y,3);
   expect(company.y).toBeGreaterThan(profile.y);expect(period.x).toBeGreaterThan(company.x);
   expect(runs.filter(r=>r.text===data.company)).toHaveLength(1);
   const uploaded=logo&&logo.bytes.length>20;
   expect(company.x).toBe(uploaded?134:24);
   const pdf=await PDFDocument.load(bytes);
   const imageKeys=pdf.getPages()[0].node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict)?.keys()??[];
   expect(imageKeys.length).toBe(uploaded?1:0);
  }
 });
});
