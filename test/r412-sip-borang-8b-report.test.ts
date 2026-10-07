/**
 * r412 (item e74af58c, step 2) — THE EIS (SIP) SCHEDULE AND BORANG 8B, against a real database.
 *
 * The money rule is pinned here, on the kernel's own payslips: the schedule's total is the sum of the 8A
 * read's EIS legs for the same selection, and that is the payslips' own EIS. Select All renders the same
 * bytes as no selection; a bonus-only selection is refused by NAME, as the 8A's is. The 8B header comes off
 * the company's own rows, including the PERKESO signatory, and the 8B reads no payslip at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { reportPreview } from '../core/reporting';
import { SIP_HEADER_KEYS, sipFrom } from '../lib/sip-contribution';
import { renderSipContributionPdf } from '../lib/sip-contribution-pdf';
import { BORANG_8B_HEADER_KEYS, borang8BFrom } from '../lib/borang-8b';
import { SOCSO_NOT_IN_SELECTION_REASON } from '../localization/my/statutory-month-wage';
import { sipHasContributions } from '../app/payroll/sip-contribution/query';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setCompanyStatutoryMY(adminCtx(b), {
    companyId: b.companyId,
    socsoEmployerCode: 'B3201005082P',
    ssmRegistrationNo: '202301012345',
  });
  await owner.db
    .update(schema.company)
    .set({ addressLine1: 'Level 8, Menara Satu', city: 'Kuala Lumpur', state: 'Wilayah Persekutuan', postcode: '50000' })
    .where(eq(schema.company.id, b.companyId));
});

let seq = 0;
async function hire(p: { name: string; hiredOn: string; salary: number; ic: string | null }) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: p.name, primaryEmail: `r412_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: p.hiredOn,
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: p.salary, effectiveFrom: p.hiredOn });
  await setStatutoryProfileMY(a, { personId: E.personId, icNumber: p.ic ?? '', taxCategory: 1, numChildren: 0 });
  return E;
}

const PERIOD = '2026-07';
const view = (reportId: string, ctx: Parameters<typeof reportPreview>[0], runSeqs?: number[]) =>
  reportPreview(ctx, { companyId: b.companyId, reportId, periodKey: PERIOD, runSeqs });
const toSen = (n: unknown) => Math.round(Number(n) * 100);

describe('the EIS (SIP) schedule is the 8A read’s EIS, and nothing else', () => {
  it('totals exactly the 8A read’s EIS legs — and the payslips’ own EIS — for the whole month', async () => {
    await hire({ name: 'AAA ONE', hiredOn: '2024-03-01', salary: 4000, ic: '900101015555' });
    await hire({ name: 'BBB TWO', hiredOn: '2024-03-01', salary: 2750, ic: '880808085555' });
    await hire({ name: 'CCC THREE', hiredOn: '2024-03-01', salary: 5600, ic: '870707075555' });
    const a = adminCtx(b);
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: batch.batchId });

    const sip = await view('my.sip-contribution', a);
    const r8a = await view('my.borang-8a', a);
    expect(sip.meta.hasBatch).toBe(true);
    // Every header key the renderer reads is on the read.
    for (const k of SIP_HEADER_KEYS) expect(sip.meta.formHeader![k], k).toBeTruthy();
    expect(sip.meta.formHeader!.employerCode).toBe('B3201005082P');
    expect(sip.meta.formHeader!.contributionMonth).toBe('072026');

    const legs8a = r8a.rows.reduce((acc, r) => acc + toSen(r.eisEmployer) + toSen(r.eisEmployee), 0);
    expect(legs8a, 'the fixture must actually produce EIS').toBeGreaterThan(0);
    const sipSum = sip.rows.reduce((acc, r) => acc + toSen(r.contribution), 0);
    expect(sipSum).toBe(legs8a);
    expect(toSen(sip.totals.contribution)).toBe(legs8a);
    // …and the drawn form's total is the same sen.
    expect(toSen(sipFrom({ header: sip.meta.formHeader, rows: sip.rows }).total)).toBe(legs8a);

    // Independently, straight off the payslips: the schedule calculates nothing.
    const slips = await owner.db.select({ statutory: schema.payslip.statutory }).from(schema.payslip);
    const fromSlips = slips.reduce((acc, s) => {
      const st = s.statutory as Record<string, number>;
      return acc + toSen(st.eisEmployer) + toSen(st.eisEmployee);
    }, 0);
    expect(sipSum).toBe(fromSlips);
    // Not the 8A's SOCSO column under another name.
    expect(sipSum).not.toBe(r8a.rows.reduce((acc, r) => acc + toSen(r.contribution), 0));

    // One line per person, the employer code and the month on each, the 8A read's order (by name).
    expect(sip.rows.map((r) => r.name)).toEqual(['AAA ONE', 'BBB TWO', 'CCC THREE']);
    for (const r of sip.rows) {
      expect(r.employerCode).toBe('B3201005082P');
      expect(r.contributionMonth).toBe('072026');
    }
  });

  it('names whoever has no identity card number — the 8A’s readiness list, unchanged', async () => {
    await hire({ name: 'AAA ONE', hiredOn: '2024-03-01', salary: 4000, ic: '900101015555' });
    await hire({ name: 'NO IC PERSON', hiredOn: '2024-03-01', salary: 3000, ic: null });
    const a = adminCtx(b);
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: batch.batchId });
    const sip = await view('my.sip-contribution', a);
    const r8a = await view('my.borang-8a', a);
    expect(sip.readiness).toEqual(r8a.readiness);
    expect(sip.readiness.map((x) => x.name)).toEqual(['NO IC PERSON']);
  });

  it('reports no batch for a month that was never run', async () => {
    await hire({ name: 'AAA ONE', hiredOn: '2024-03-01', salary: 4000, ic: '900101015555' });
    const sip = await view('my.sip-contribution', adminCtx(b));
    expect(sip.meta.hasBatch).toBe(false);
    expect(sip.rows).toEqual([]);
  });
});

describe('the payroll-cycle selection, through the drawn EIS (SIP) schedule', () => {
  async function julyWithBonus() {
    await setModule(b.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(b);
    const e = await hire({ name: 'AAA CYCLE', hiredOn: '2024-03-01', salary: 4000, ic: '900101015555' });
    await hire({ name: 'ZZZ REGULAR ONLY', hiredOn: '2024-03-01', salary: 4000, ic: '880808085555' });
    const reg = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId: reg.batchId });
    const bonus = await createAdditionalRun(a, { companyId: b.companyId, payPeriod: PERIOD, runType: 'bonus' });
    await setPayrollInput(a, { batchId: bonus.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 1200 });
    await generatePayslips(a, { batchId: bonus.batchId });
    // The run numbers are READ BACK, never assumed to be 1 and 2.
    const rows = await owner.db
      .select({ runSeq: schema.payrollBatch.runSeq, runType: schema.payrollBatch.runType })
      .from(schema.payrollBatch)
      .where(and(eq(schema.payrollBatch.companyId, b.companyId), eq(schema.payrollBatch.payPeriod, PERIOD)));
    return {
      a,
      regularSeq: rows.find((x) => x.runType === 'regular')!.runSeq,
      bonusSeq: rows.find((x) => x.runType === 'bonus')!.runSeq,
    };
  }

  it('ticking every cycle renders the very same PDF bytes as no selection', async () => {
    const { a, regularSeq, bonusSeq } = await julyWithBonus();
    const draw = async (r: Awaited<ReturnType<typeof view>>) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-12T02:00:00Z'));
      try {
        return Buffer.from(await renderSipContributionPdf(sipFrom({ header: r.meta.formHeader, rows: r.rows })));
      } finally {
        vi.useRealTimers();
      }
    };
    const omitted = await view('my.sip-contribution', a);
    const everyRun = await view('my.sip-contribution', a, [regularSeq, bonusSeq]);
    expect(omitted.rows.length).toBe(2);
    const [x, y] = [await draw(omitted), await draw(everyRun)];
    expect(x.byteLength).toBeGreaterThan(1000);
    expect(x.equals(y), 'Select All drew a different EIS (SIP) schedule from no selection').toBe(true);
    // The same selection on the 8A read carries the same EIS, leg for leg.
    const r8a = await view('my.borang-8a', a, [regularSeq, bonusSeq]);
    expect(everyRun.rows.reduce((s, r) => s + toSen(r.contribution), 0)).toBe(
      r8a.rows.reduce((s, r) => s + toSen(r.eisEmployer) + toSen(r.eisEmployee), 0),
    );
    // EIS is charged on the regular run: a regular-only selection is the same money.
    const regularOnly = await view('my.sip-contribution', a, [regularSeq]);
    expect(toSen(regularOnly.totals.contribution)).toBe(toSen(omitted.totals.contribution));
    expect(sipHasContributions(omitted.rows)).toBe(true);
  });

  it('a bonus-only selection names everyone on it with the not-in-selection reason, and carries no EIS', async () => {
    const { a, bonusSeq } = await julyWithBonus();
    const r = await view('my.sip-contribution', a, [bonusSeq]);
    // Nobody on the bonus run was charged EIS, so nobody is a line; everybody on it is NAMED.
    expect(r.rows).toEqual([]);
    expect(r.readiness.map((x) => x.name)).toEqual(['AAA CYCLE']);
    expect(r.readiness[0].missing).toContain(SOCSO_NOT_IN_SELECTION_REASON);
    expect(SOCSO_NOT_IN_SELECTION_REASON).toMatch(/EIS/);
    expect(sipHasContributions(r.rows)).toBe(false);
  });
});

describe('Borang 8B — the employer header, no payslip', () => {
  it('fills the header from the company’s own rows and the PERKESO signatory, and reads no payroll', async () => {
    const rep = await hire({ name: 'TAN MEI LING', hiredOn: '2024-03-01', salary: 4000, ic: '900101015555' });
    await owner.db.insert(schema.companyStatutoryAuthority).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      authority: 'socso',
      phone: '03-2770 1234',
      signatoryPersonId: rep.personId,
    });
    // A KWSP signatory must NOT be read for a PERKESO form.
    const other = await hire({ name: 'WRONG AUTHORITY', hiredOn: '2024-03-01', salary: 4000, ic: '880808085555' });
    await owner.db.insert(schema.companyStatutoryAuthority).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      authority: 'epf',
      phone: '09-999 9999',
      signatoryPersonId: other.personId,
    });

    // No payroll run exists for March: an 8B for it is still an 8B.
    const r = await reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-8b', periodKey: '2026-03' });
    const h = r.meta.formHeader!;
    for (const k of BORANG_8B_HEADER_KEYS) expect(h[k], k).toBeDefined();
    expect(h.employerCode).toBe('B3201005082P');
    expect(h.mycoid).toBe('202301012345');
    expect(h.employerName).toBe('Acme Sdn Bhd');
    expect(h.employerAddress).toContain('50000 Kuala Lumpur, Wilayah Persekutuan');
    expect(h.contributionMonth).toBe('03 / 2026');
    expect(h.contributionPeriodKey).toBe('2026-03');
    expect(h.signatoryName).toBe('TAN MEI LING');
    expect(h.signatoryPhone).toBe('03-2770 1234');
    expect(h).not.toHaveProperty('paymentDueDate');
    expect(r.rows).toEqual([]);
    expect(r.readiness).toEqual([]);
    expect(borang8BFrom(h).signatoryName).toBe('TAN MEI LING');
  });

  it('leaves the signatory blank rather than borrowing one when the company has no PERKESO record', async () => {
    const r = await reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-8b', periodKey: '2026-03' });
    expect(r.meta.formHeader!.signatoryName).toBe('');
    expect(r.meta.formHeader!.signatoryPhone).toBe('');
  });

  it('refuses a month that is not YYYY-MM', async () => {
    await expect(
      reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-8b', periodKey: '2026-13' }),
    ).rejects.toThrow();
  });
});
