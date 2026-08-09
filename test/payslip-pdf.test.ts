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
import { describe, expect, it } from 'vitest';
import {
  buildPayslipPdfData,
  renderPayslipPdf,
  type PayslipPdfData,
  type PayslipPdfLabels,
} from '../lib/payslip-pdf';

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
  otherDeductions: 'Other deductions',
  // e2632276 — the two named absence lines that come OUT of "Other deductions".
  unpaidLeaveLine: 'Unpaid leave',
  absentLine: 'Absent',
  daysUnit: 'days',
  totalDeductions: 'Total deductions',
  netPay: 'Net pay',
  employerContributions: 'Employer contributions',
  totalEmployerCost: 'Total employer cost',
  proratedNote: 'Prorated for 21 days worked',
  generatedNote: 'This is a system-generated payslip.',
  claim: 'Claim',
  employerBorne: 'Paid by your employer on your behalf',
  employerBorneTotal: 'Total borne by employer',
  employerBorneNote: 'Reported in full to the authorities; not deducted from your pay.',
  documentSubtitle: 'Payroll payslip',
  paymentDate: 'Payment date: 2026-06-30',
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
  provenanceNote: 'Calculated under statutory rules version 2026.6.',
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
          bankAccountMasked: '••••8901',
          hrdf: 71.2,
          ytd: { gross: 21360, epf: 2145, socso: 74.25, eis: 29.7, pcb: 1050, net: 18061.05 },
          ytdYear: '2026',
          rulesetVersion: '2026.6',
        },
        labels,
      ),
    );
    // Every one of these was ABSENT from the file the ticket complained about.
    expect(text).toContain('Payment date: 2026-06-30');
    expect(text).toContain('Payroll payslip · Regular');
    expect(text).toContain('900101011234'); // NRIC
    expect(text).toContain('SG1234567890'); // income tax number
    expect(text).toContain('Finance');
    expect(text).toContain('Maybank');
    expect(text).toContain('HRDF');
    expect(text).toContain('MYR 71.20'); // the HRD Corp levy the download used to leave out
    expect(text).toContain('YEAR TO DATE · 2026');
    expect(text).toContain('MYR 21,360.00'); // the YTD gross
    expect(text).toContain('Calculated under statutory rules version 2026.6.');
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
    expect(text).toContain('Handphone allowance · A0027');
    expect(text).toContain('Travel allowance · A0031');
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

  it('spills a long earnings list onto a second page instead of overprinting the footer', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ code: `A${i}`, name: `Item ${i}`, amount: 10 }));
    const bytes = await renderPayslipPdf(
      { ...data, allowance: 300, earningLines: many, detailNotRecorded: false },
      labels,
    );
    const text = drawnText(bytes);
    expect(text).toContain('EARNINGS (CONTINUED)'); // the box header on page 2
    expect(text).toContain('Item 29'); // the last line survived rather than being dropped
    expect(text).toContain('MYR 7,120.00'); // and the total still reads the stored gross
    // Two pages: a single-page render of the same payslip is materially smaller.
    const onePage = await renderPayslipPdf({ ...data, earningLines: [], detailNotRecorded: true }, labels);
    expect(bytes.length).toBeGreaterThan(onePage.length);
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

  it('reports detailNotRecorded for a run that predates the per-item stamp', () => {
    const { componentLines: _drop, ...st } = row.statutory;
    const d = buildPayslipPdfData({ ...row, statutory: st }, borne);
    expect(d.earningLines).toEqual([]);
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
