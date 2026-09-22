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
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  buildPayslipPdfData,
  renderPayslipPdf,
  type PayslipPdfData,
  type PayslipPdfLabels,
} from '../lib/payslip-pdf';
// a96d320c — the payment date is resolved to words SERVER-side, in the same module that already resolves
// the pay period to a month name. Imported directly so the formatter is pinned as a function rather than
// through a label fixture the test writes itself.
import { englishLongDate } from '../lib/payslip-pdf-strings';

const labels: PayslipPdfLabels = {
  title: 'Payslip',
  payPeriod: 'Pay period',
  employeeCode: 'Employee code',
  earnings: 'Earnings',
  basicSalary: 'Basic salary',
  allowances: 'Allowances',
  overtime: 'Overtime',
  bonus: 'Bonus',
  grossPay: 'Gross pay',
  deductions: 'Deductions',
  epf: 'EPF',
  socso: 'SOCSO',
  skbbk: 'SKBBK',
  eis: 'EIS',
  pcb: 'PCB',
  cp38: 'CP38',
  // 3a092cf0 — the zakat deduction row's label. Required, so tsc is what stops the document
  // dropping a line the screens print.
  zakat: 'Zakat',
  otherDeductions: 'Other deductions',
  // e2632276 — the two named absence lines that come OUT of "Other deductions".
  unpaidLeaveLine: 'Unpaid leave',
  absentLine: 'Absent',
  dayUnit: 'day',
  daysUnit: 'days',
  totalDeductions: 'Total deductions',
  netPay: 'Net pay',
  employerContributions: 'Employer contributions',
  totalEmployerCost: 'Total employer cost',
  generatedNote: 'This is a system-generated payslip.',
  claim: 'Claim',
  employerBorne: 'Paid by your employer on your behalf',
  employerBorneTotal: 'Total borne by employer',
  employerBorneNote: 'Reported in full to the authorities; not deducted from your pay.',
  documentSubtitle: 'Payroll payslip',
  // a96d320c — the shape the REAL caller now passes. `payslipPdfStrings` interpolates the localized
  // `payDateLine` with `englishLongDate(payDate)`, so the fixture says what the document says.
  paymentDate: 'Payment date: 30 June 2026',
  employmentInfo: 'Employment info',
  department: 'Department',
  position: 'Position',
  grade: 'Grade',
  employmentType: 'Employee type',
  daysWorked: 'Days worked',
  currency: 'Currency',
  ic: 'NRIC',
  passport: 'Passport',
  epfNumber: 'EPF number',
  socsoNumber: 'SOCSO / EIS number',
  taxNumber: 'Income tax number',
  totalEarnings: 'Total earnings',
  hrdf: 'HRDF',
  employerContributionsNote: 'For reference. Paid by the company.',
  paymentInformation: 'Payment information',
  paymentMethod: 'Payment method',
  bankName: 'Bank name',
  bankAccount: 'Bank account',
  ytdHeading: 'Year to date · 2026',
  ytdItem: 'Item',
  ytdCurrent: 'This run',
  ytdToDate: 'Year to date',
  detailNotRecorded: 'This payroll run recorded only the totals.',
  earningsContinued: 'Earnings (continued)',
  periodLabel: 'June 2026',
  // f35f758a — the Non-payable box's three REQUIRED labels. tsc is what stops one PDF route printing a
  // block the other one does not, and it caught this fixture the moment they were added.
  nonPayable: 'Non-payable items',
  nonPayableTotal: 'Total non-payable',
  nonPayableNote: 'Recorded for your reference only - these do not affect your gross or net pay.',
  // a96d320c — the rate-and-input vocabulary. REQUIRED on the type, and tsc caught this fixture the
  // moment the keys were added, which is the mechanism that stops one PDF route printing a block the
  // other one does not.
  hourUnit: 'hour',
  hoursUnit: 'hours',
  otLegs: {
    workday: 'Overtime - normal working day',
    rest_day: 'Overtime - rest day',
    rest_day_excess: 'Overtime - rest day, beyond normal hours',
    holiday: 'Overtime - public holiday',
    holiday_excess: 'Overtime - public holiday, beyond normal hours',
  },
};
const data: PayslipPdfData = {
  employee: 'Aisyah Rahman',
  employeeCode: 'EMP-001',
  company: 'Demo Sdn Bhd',
  companyReg: '202301000001 (1400001-A)',
  payPeriod: '2026-06',
  basic: 6500,
  allowance: 500,
  overtime: 120,
  bonus: 0,
  claim: 0,
  gross: 7120,
  epfEmployee: 715,
  socsoEmployee: 24.75,
  socsoSkbbk: 0,
  eisEmployee: 9.9,
  pcb: 350,
  cp38: 0,
  // 3a092cf0 — no election on this fixture, so no zakat row: the document it renders is
  // byte-for-byte the one it rendered before the line existed.
  zakat: 0,
  // 3a092cf0 — this base fixture is a POST-fix slip (its total counts zakat). The legacy case is
  // exercised explicitly below, because that is the one that regressed history.
  zakatCountedInTotal: true,
  otherDeductions: 0,
  // e2632276 — no stamp on this fixture ⇒ the pre-feature path: no named lines, residual === otherDeductions.
  absence: { unpaidLeave: null, absent: null, residual: 0, showResidual: false, any: false },
  totalDeductions: 1099.65,
  net: 6020.35,
  epfEmployer: 925,
  socsoEmployer: 86.65,
  eisEmployer: 9.9,
  employerCost: 8141.55,
  daysWorked: 21,
  employerBorne: [],
  employerBorneTotal: 0,
  currency: 'MYR',
};
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
    const withCp38 = drawnText(await renderPayslipPdf({ ...data, cp38: 200 }, labels));
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
    const lines = ['EPF', 'SOCSO', 'EIS', 'PCB', 'Zakat'].map(amountBeside);
    expect(Math.round(lines.reduce((a, b) => a + b, 0) * 100) / 100).toBe(466.25);
    // …and that is the total the box itself prints, so the column reconciles on the page.
    expect(amountBeside('TOTAL DEDUCTIONS')).toBe(466.25);

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

  it('degrades gracefully: null code/reg, no skbbk/other rows, no proration, non-Latin name', async () => {
    const bytes = await renderPayslipPdf(
      { ...data, employee: '陈大文', employeeCode: null, companyReg: null, socsoSkbbk: 0, otherDeductions: 0, daysWorked: null },
      labels,
    );
    expect(head(bytes)).toBe('%PDF-'); // safe-encode guard → no crash on the CJK name
    expect(bytes.length).toBeGreaterThan(1000);
    // The name degrades to '?' per glyph rather than being dropped or crashing the route.
    expect(drawnText(bytes)).toContain('???');
  });
});

describe('5c198931 — the downloaded payslip is a full official document', () => {
  it('carries the blocks the old half-page had no room for', async () => {
    const text = drawnText(
      await renderPayslipPdf(
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
          ytd: { gross: 21360, epf: 2145, socso: 74.25, eis: 29.7, pcb: 1050, net: 18061.05 },
          ytdYear: '2026',
        },
        labels,
      ),
    );
    // Every one of these was ABSENT from the file the ticket complained about.
    expect(text).toContain('Payment date: 30 June 2026'); // a96d320c — in words; was the raw ISO
    expect(text).toContain('Payroll payslip · Regular');
    expect(text).toContain('900101011234'); // NRIC
    expect(text).toContain('SG1234567890'); // income tax number
    expect(text).toContain('Finance');
    expect(text).toContain('Maybank');
    expect(text).toContain('HRDF');
    expect(text).toContain('MYR 71.20'); // the HRD Corp levy the download used to leave out
    expect(text).toContain('YEAR TO DATE · 2026');
    expect(text).toContain('MYR 21,360.00'); // the YTD gross
    // f35f758a — and the two INTERNAL sentences are off it. "Calculated under statutory rules version …"
    // was put on the document on purpose (97a9b0ab) so "why did my tax change when my pay did not?" had an
    // answer on the page; the reporter asked for it off the employee's copy, and it now lives on the
    // HR-facing Individual Payslip screen instead (pinned by test/individual-payslip.test.ts).
    expect(text).not.toContain('Calculated under statutory rules version');
    expect(text).not.toContain('Prorated');
    // The day count itself SURVIVES — as a field in the employment panel, where it reads as information
    // rather than as a note about the arithmetic. Losing it was never what was asked for.
    expect(text).toContain('DAYS WORKED');
    expect(text).toContain('21.00');
  });

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

  it('says so plainly when the run never recorded the per-item detail', async () => {
    const older = drawnText(await renderPayslipPdf({ ...data, earningLines: [], detailNotRecorded: true }, labels));
    expect(older).toContain('Allowances');
    expect(older).toContain('This payroll run recorded only the totals.');
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
    expect(thirty, 'thirty rows fit under a full-width box — nothing was continued').not.toContain(
      'EARNINGS (CONTINUED)',
    );

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

    // Their TOTALS line up too, which is the half a reader actually compares.
    const te = placed(p, 'TOTAL EARNINGS');
    const td = placed(p, 'TOTAL DEDUCTIONS');
    expect(td!.y).toBeCloseTo(te!.y, 1);
    expect(td!.x).toBeGreaterThan(te!.x);
  });

  it('pairs Employer contributions with Payment information, BELOW the first pair', async () => {
    const p = drawnPlacements(
      await renderPayslipPdf(
        { ...data, paymentMethod: 'Bank transfer', bankName: 'Maybank', bankAccount: '157123456789' },
        labels,
      ),
    );
    const emp = placed(p, 'EMPLOYER CONTRIBUTIONS');
    const pay = placed(p, 'PAYMENT INFORMATION');
    expect(emp!.y).toBeCloseTo(pay!.y, 1);
    expect(emp!.x).toBeLessThan(297);
    expect(pay!.x).toBeGreaterThan(297);
    // Below Earnings/Deductions — PDF y grows UPWARD, so "below" is a smaller y on the same page.
    const earn = placed(p, 'EARNINGS')!;
    expect(emp!.page).toBe(earn.page);
    expect(emp!.y).toBeLessThan(earn.y);
  });

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
    expect(text).not.toContain('NON-PAYABLE ITEMS');
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
    expect(text).toContain('NON-PAYABLE ITEMS');
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
    expect(drawnText(await renderPayslipPdf(d, labels))).not.toContain('NON-PAYABLE ITEMS');
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
      expect(text, `row ${i} must be on the document`).toContain(`Long pay item description ${i}`);
    }
    // The pair partner finished on sheet one and was NOT redrawn beside the continuation.
    const p = drawnPlacements(bytes);
    expect(p.filter((r) => r.text === 'DEDUCTIONS')).toHaveLength(1);
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

  it('puts the employee identity fields inside a RULED box, not loose under a heading', async () => {
    const bytes = await renderPayslipPdf(
      { ...data, identityNumber: '900101011234', taxNumber: 'SG1234567890', department: 'Finance' },
      labels,
    );
    const rects = drawnRects(bytes);
    const places = drawnPlacements(bytes);
    // The NRIC VALUE, not the heading: the heading could sit above a box the value is not in.
    const nric = placed(places, '900101011234');
    expect(nric, 'the identity number reaches the page').toBeDefined();
    expect(enclosingRule(rects, nric), 'the identity grid is enclosed by a ruled box').toBeDefined();
    // …and so is the employment-info half, whose heading used to be a pill floating over unruled rows.
    const dept = placed(places, 'Finance');
    expect(enclosingRule(rects, dept), 'the employment-info grid is enclosed by a ruled box').toBeDefined();
    // NON-VACUITY CONTROL. `enclosingRule` searching a document with any box at all would answer "yes"
    // for every point inside that box, so the two assertions above are only worth something if the
    // helper can still say no. The footer line is deliberately NOT in a box — it is one sentence under a
    // rule at the foot of every sheet — so it is the honest negative.
    expect(
      enclosingRule(rects, placed(places, labels.generatedNote)),
      'the footer sentence is not in a box, and the helper says so',
    ).toBeUndefined();
  });

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
            residual: 0,
            showResidual: false,
            any: true,
          },
        },
        labels,
      ),
    );
    expect(text).toContain('Unpaid leave · 2 days');
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
    expect(flat(bytes)).toContain('Overtime - normal working day · 2 hours × MYR 18.75');
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
    expect(text).toContain('10 hours × MYR 36.045');
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
    expect(text).toContain('Overtime - rest day · 1 day × MYR 100.00');
    expect(text).toContain('Overtime - public holiday · 1.5 days × MYR 100.00');
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
    expect(text).toContain('Site allowance · 18 days × MYR 25.00');
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
