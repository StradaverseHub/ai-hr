/**
 * 72b100cd — PCB 2(II), "Statement of Payment by Employer" / "Penyata Bayaran Cukai Oleh Majikan".
 *
 * r321 built the SOURCE (the `pcb_payment` table: what was paid to LHDN, per month, per stream, with the
 * receipt they issued). This is the form that prints it, and the item stayed `building` until it landed.
 *
 * WHAT THIS FILE PROTECTS — four claims, each a way the form could ship wrong on a TAX DOCUMENT:
 *
 *   1. AN EMPTY BOX IS NOT A ZERO. A month with no payroll prints nothing; a month whose payroll ran and
 *      deducted nothing prints 0.00. Those are different statements to LHDN and the model keeps them
 *      apart all the way from the read to the page (CLAUDE.md §8).
 *   2. THE DATING RULE IS CP39's, IMPORTED. Both forms report the same deductions to the same body; a
 *      second dating rule would let two of our own documents disagree about which month a month's tax
 *      belongs to. `cp39DeductionPeriodFor`'s own header warns about exactly this.
 *   3. THE TWO LANGUAGES DIFFER BY MORE THAN TRANSLATION. The English sheet heads a column MTD; the Malay
 *      sheet heads the same column PCB. Same figure, two official names.
 *   4. SECTION 3 IS EMPTY BY REFUSAL, NOT BY OVERSIGHT.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { pcb2iiStatement } from '../localization/my/pcb2ii';
import { recordPcbPayment } from '../core/pcb-payment';
import {
  emptyPcb2iiMonths,
  pcb2iiAmount,
  pcb2iiDate,
  pcb2iiTotals,
  type Pcb2iiMonth,
} from '../lib/pcb2ii-form';
import { pcb2iiLabels } from '../lib/pcb2ii-labels';
import { renderPcb2iiPdf } from '../lib/pcb2ii-pdf';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = join(__dirname, '..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const READ = src('localization/my/pcb2ii.ts');
const PDF = src('lib/pcb2ii-pdf.ts');

let b: Base;
const YEAR = '2026';

async function hire() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'PCB Subject', primaryEmail: `pcb_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
}

/** A closed payroll month carrying a PCB (and optionally a CP38) figure for one employment. */
async function payslipFor(employmentId: string, period: string, pcb: number, cp38?: number) {
  // A batch needs its pay period; both NOT NULL columns are derived from `period` so no fixture pins a
  // hardcoded date. Same shape as test/cross-run-exceptions.ts's `makeBatch`.
  // REUSED, not re-created: (company, period) is unique, and TWO RUNS IN ONE MONTH is a case under test
  // — a second run is a second BATCH inside the same pay period, which is what production looks like.
  const [existing] = await owner.db
    .select({ id: schema.payPeriod.id })
    .from(schema.payPeriod)
    .where(and(eq(schema.payPeriod.companyId, b.companyId), eq(schema.payPeriod.period, period)));
  const pp =
    existing ??
    (
      await owner.db
        .insert(schema.payPeriod)
        .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'open' })
        .returning({ id: schema.payPeriod.id })
    )[0];
  // A batch is unique on (period, run_seq): a SECOND run in the same month is run 2, which is exactly
  // what the two-runs case below exercises. Counted rather than hardcoded so the fixture stays honest
  // however many runs a case asks for.
  const priorRuns = await owner.db
    .select({ id: schema.payrollBatch.id })
    .from(schema.payrollBatch)
    .where(and(eq(schema.payrollBatch.companyId, b.companyId), eq(schema.payrollBatch.payPeriod, period)));
  const [batch] = await owner.db
    .insert(schema.payrollBatch)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      payPeriodId: pp.id,
      payPeriod: period,
      runSeq: priorRuns.length + 1,
      // ⚠️ EXACTLY ONE 'regular' RUN PER PERIOD (ADR-0024 §6, payroll_batch_one_regular_uq). A second run
      // in the same month is an OFF-CYCLE one — which is precisely what the two-runs case below models: a
      // supplementary payment made mid-month deducts its own PCB, and the form's row must carry both.
      runType: priorRuns.length === 0 ? 'regular' : 'off_cycle',
      batchDate: `${period}-28`,
      status: 'closed',
    })
    .returning({ id: schema.payrollBatch.id });
  await owner.db.insert(schema.payslip).values({
    tenantId: b.tenantId,
    batchId: batch.id,
    employmentId,
    // Every NOT NULL money column, with the figures under test in `statutory` where the form reads them.
    basicSalary: '5000.00',
    grossPay: '5000.00',
    totalDeductions: '1000.00',
    netPay: '4000.00',
    employerCost: '5600.00',
    statutory: { pcb, ...(cp38 == null ? {} : { cp38 }) },
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('72b100cd · an empty box and a zero are different statements', () => {
  it('a month with no payroll is NULL, and a month that deducted nothing is 0', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-03', 412.35);
    await payslipFor(employmentId, '2026-04', 0);

    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form).toBeTruthy();
    expect(form.months).toHaveLength(12);
    expect(form.months[2].mtd, 'March ran and deducted 412.35').toBe(412.35);
    expect(form.months[3].mtd, 'April ran and deducted nothing — an honest zero').toBe(0);
    expect(form.months[0].mtd, 'January never ran — nothing is asserted').toBeNull();
    expect(form.months[11].mtd).toBeNull();
  });

  it('prints an absent month as an empty box, never as 0.00', () => {
    expect(pcb2iiAmount(null), 'the whole point').toBe('');
    expect(pcb2iiAmount(0), 'a real zero still prints').toBe('0.00');
    expect(pcb2iiAmount(412.3)).toBe('412.30');
  });

  /**
   * THE TOTAL OF NOTHING IS NOTHING. Summing twelve absent months to 0.00 would turn twelve statements
   * about nothing into one positive claim that no tax was deducted all year.
   */
  it('totals only the months that have a figure, and totals nothing to null', () => {
    const empty = emptyPcb2iiMonths();
    expect(pcb2iiTotals(empty)).toEqual({ mtd: null, cp38: null });

    const some = emptyPcb2iiMonths();
    some[0].mtd = 100.5;
    some[1].mtd = 200.25;
    some[4].cp38 = 150;
    expect(pcb2iiTotals(some)).toEqual({ mtd: 300.75, cp38: 150 });
  });

  it('a month that deducted zero still counts toward the total, because it happened', () => {
    const m = emptyPcb2iiMonths();
    m[0].mtd = 0;
    expect(pcb2iiTotals(m).mtd, 'zero is a figure; absent is not').toBe(0);
  });

  it('sums the runs within one month rather than taking the last', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-05', 100);
    await payslipFor(employmentId, '2026-05', 25.5);
    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form.months[4].mtd, 'two runs in May').toBe(125.5);
  });
});

describe('72b100cd · MTD and CP38 stay apart, and so do the receipts', () => {
  it('keeps the two streams in their own columns', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-05', 440.35, 150);
    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form.months[4].mtd).toBe(440.35);
    expect(form.months[4].cp38).toBe(150);
    expect(form.months[3].cp38, 'a month with no CP38 asserts nothing about one').toBeNull();
  });

  it('carries each stream’s own receipt and date from the payment record', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-03', 412.35, 150);
    const ctx = adminCtx(b);
    await recordPcbPayment(ctx, {
      companyId: b.companyId, periodKey: '2026-03', kind: 'mtd', receiptRef: 'LHDN-0093771', paidOn: '2026-04-14',
    });
    await recordPcbPayment(ctx, {
      companyId: b.companyId, periodKey: '2026-03', kind: 'cp38', receiptRef: 'CP38-778812', paidOn: '2026-04-15',
    });

    const form = (await pcb2iiStatement(ctx, { employmentId, year: YEAR }))!;
    expect(form.months[2].mtdReceiptRef).toBe('LHDN-0093771');
    expect(form.months[2].mtdPaidOn).toBe('2026-04-14');
    expect(form.months[2].cp38ReceiptRef).toBe('CP38-778812');
    expect(form.months[2].cp38PaidOn).toBe('2026-04-15');
  });

  /** Tax deducted but not yet paid is the ordinary mid-month state: a real amount beside an empty box. */
  it('prints an amount with no receipt when the payment has not been keyed', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-06', 447.35);
    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form.months[5].mtd).toBe(447.35);
    expect(form.months[5].mtdReceiptRef, 'not paid yet — and the box says nothing').toBeNull();
  });
});

describe('72b100cd · the dating rule is CP39’s, not a second one', () => {
  it('imports it rather than restating it', () => {
    expect(READ).toContain("import { cp39DeductionPeriodFor } from '../../lib/cp39-form'");
    expect(READ).toContain('cp39DeductionPeriodFor(s.payPeriod)');
    // The EPF form's +1 is the rule this must never acquire — cp39-form.ts's own header names it.
    expect(READ, 'no EPF dating here').not.toContain('epfContributionPeriodFor');
  });

  it('files a month’s tax against that month, matching CP39 exactly', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-01', 11);
    await payslipFor(employmentId, '2026-12', 22);
    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form.months[0].mtd, 'January payroll → January row').toBe(11);
    expect(form.months[11].mtd, 'December payroll → December row').toBe(22);
  });

  it('reads only the year asked for', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2025-12', 999);
    await payslipFor(employmentId, '2026-02', 50);
    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form.months.filter((m) => m.mtd != null).map((m) => m.month)).toEqual([2]);
  });
});

describe('72b100cd · the two official languages', () => {
  /** ⚠️ NOT A TRANSLATION SLIP. The English specimen says MTD; the Malay one says PCB. */
  it('heads the stream MTD in English and PCB in Bahasa Malaysia', () => {
    expect(pcb2iiLabels('en').streamMtd).toBe('MTD');
    expect(pcb2iiLabels('ms').streamMtd).toBe('PCB');
    expect(pcb2iiLabels('en').streamCp38, 'CP38 is CP38 in both').toBe('CP38');
    expect(pcb2iiLabels('ms').streamCp38).toBe('CP38');
  });

  it('carries each specimen’s own title, addressee and month names', () => {
    expect(pcb2iiLabels('en').title).toBe('STATEMENT OF PAYMENT BY EMPLOYER');
    expect(pcb2iiLabels('ms').title).toBe('PENYATA BAYARAN CUKAI OLEH MAJIKAN');
    expect(pcb2iiLabels('en').toLabel).toBe('To:');
    expect(pcb2iiLabels('ms').toLabel, 'the BM specimen does not say "To:"').toBe('Kepada:');
    expect(pcb2iiLabels('en').months[0]).toBe('January');
    expect(pcb2iiLabels('ms').months[0]).toBe('Januari');
    expect(pcb2iiLabels('ms').months[2], 'Mac, not Mach or March').toBe('Mac');
    for (const lang of ['en', 'ms'] as const) expect(pcb2iiLabels(lang).months).toHaveLength(12);
  });

  it('keeps the form code identical, because it is the form’s own number', () => {
    expect(pcb2iiLabels('en').formCode).toBe('PCB 2(II)-Pin. 2012');
    expect(pcb2iiLabels('ms').formCode).toBe('PCB 2(II)-Pin. 2012');
  });
});

describe('72b100cd · Section 3 is empty by refusal', () => {
  it('the read returns no prior-year rows, and says why', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-03', 412.35);
    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form.priorYearRows).toEqual([]);
    expect(READ, 'the refusal is recorded where the empty is produced').toContain('Section 3');
  });

  it('the renderer prints the ruled rows rather than dropping the section', () => {
    expect(PDF).toContain('THREE EMPTY ROWS');
    expect(PDF).toContain('L.section3');
  });
});

describe('72b100cd · it renders, in both languages', () => {
  it('produces a one-page PDF carrying the figures', async () => {
    const { employmentId } = await hire();
    await payslipFor(employmentId, '2026-03', 412.35, 150);
    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;

    for (const lang of ['en', 'ms'] as const) {
      const bytes = await renderPcb2iiPdf(form, lang);
      const head = Buffer.from(bytes.slice(0, 5)).toString('latin1');
      expect(head, `${lang} must be a PDF`).toBe('%PDF-');
      expect(bytes.byteLength, `${lang} must not be an empty shell`).toBeGreaterThan(2000);
    }
  });

  it('the renderer formats every amount through the shared helper, never inline', () => {
    // A `toFixed(2)` in the renderer is how a null becomes "0.00" on a tax form without anyone noticing.
    expect(PDF, 'no private formatting').not.toMatch(/\.toFixed\(/);
    expect(PDF).toContain('pcb2iiAmount(');
  });

  it('formats a date the way the form does, and an absent one as nothing', () => {
    expect(pcb2iiDate('2026-04-14')).toBe('14/04/2026');
    expect(pcb2iiDate(null)).toBe('');
    expect(pcb2iiDate('nonsense'), 'never `undefined` on a form').toBe('');
  });
});

describe('72b100cd · scope', () => {
  it('returns null for an employment that does not exist', async () => {
    const missing = await pcb2iiStatement(adminCtx(b), {
      employmentId: '00000000-0000-4000-8000-000000000000',
      year: YEAR,
    });
    expect(missing).toBeNull();
  });

  it('refuses a malformed year rather than querying with it', async () => {
    const { employmentId } = await hire();
    for (const year of ['26', 'YYYY', '']) {
      expect(await pcb2iiStatement(adminCtx(b), { employmentId, year }), year).toBeNull();
    }
  });

  it('carries the employee and employer particulars the form has boxes for', async () => {
    const { employmentId } = await hire();
    await owner.db
      .update(schema.employment)
      .set({ employeeCode: 'EMP-0042' })
      .where(eq(schema.employment.id, employmentId));
    await payslipFor(employmentId, '2026-03', 412.35);

    const form = (await pcb2iiStatement(adminCtx(b), { employmentId, year: YEAR }))!;
    expect(form.employeeName).toBe('PCB Subject');
    expect(form.staffNo).toBe('EMP-0042');
    expect(form.year).toBe(2026);
    expect(form.employerNameAddress, 'the employer block names the company').toContain('Acme');
  });
});
