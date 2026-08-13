/**
 * 9c8dad7a / 3aae0789 — BORANG A, against a real database.
 *
 * test/borang-a.test.ts pins the RULES with no database at all, which is what makes them cheap to assert
 * and impossible to get wrong by accident. This file pins the READ: that the query joins what it claims to
 * join, that the header comes off the company's own statutory row and its EPF authority row, that Upah is
 * the wage the run CHARGED EPF ON rather than gross pay, and that a person with no EPF member number is
 * NAMED rather than silently dropped from a statutory filing.
 *
 * Every one of those is a defect a pure test cannot see and that produces a plausible-looking document in
 * production: a missing join yields an empty form, a wrong join yields somebody else's figure, a dropped
 * employee yields a Borang A that reconciles perfectly to a payroll it does not match, and a wage quietly
 * taken from gross pay over-reports a statutory contribution for everybody with overtime.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { upsertCompanyStatutoryAuthority } from '../core/statutory-authority';
import { createBatch, generatePayslips } from '../core/payroll';
import { reportPreview } from '../core/reporting';
import { BORANG_A_HEADER_KEYS, borangAFrom } from '../lib/borang-a';
import { borangAFileReadiness, buildBorangAFile, parseBorangAFileTotals } from '../lib/kwsp-borang-a-file';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // The employer header: the EPF employer reference, which already existed under this name and is why
  // this round needed no migration.
  await setCompanyStatutoryMY(adminCtx(b), { companyId: b.companyId, epfEmployerNo: '019632261' });
  await owner.db
    .update(schema.company)
    .set({ addressLine1: 'Level 12, Menara Satu', city: 'Kuala Lumpur', state: 'Wilayah Persekutuan', postcode: '50450' })
    .where(eq(schema.company.id, b.companyId));
});

let seq = 0;
async function hire(p: { name: string; hiredOn: string; salary: number; ic: string | null; epfNumber?: string | null }) {
  seq += 1;
  const a = adminCtx(b);
  const E = await hireEmployee(a, {
    person: { fullName: p.name, primaryEmail: `ba_${seq}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: p.hiredOn,
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: p.salary, effectiveFrom: p.hiredOn });
  await setStatutoryProfileMY(a, {
    personId: E.personId,
    icNumber: p.ic ?? '',
    epfNumber: p.epfNumber ?? '',
    taxCategory: 1,
    numChildren: 0,
  });
  return E;
}

async function run(period: string) {
  const a = adminCtx(b);
  const batch = await createBatch(a, { companyId: b.companyId, payPeriod: period });
  await generatePayslips(a, { batchId: batch.batchId });
  return reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-a', periodKey: period });
}

describe('the Borang A read', () => {
  it('fills the header from the company’s own rows, and stamps the payroll month PLUS ONE', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-07');

    const h = r.meta.formHeader!;
    for (const k of BORANG_A_HEADER_KEYS) expect(h[k], k).toBeDefined();
    expect(h.employerRef).toBe('019632261');
    expect(h.employerName).toBe('Acme Sdn Bhd');
    expect(h.employerAddress).toContain('Level 12, Menara Satu');
    expect(h.employerAddress).toContain('50450 Kuala Lumpur, Wilayah Persekutuan');
    // THE +1 RULE, END TO END rather than only in the pure test. A July payroll files an 08/2026 form.
    expect(h.payrollPeriodKey).toBe('2026-07');
    expect(h.contributionPeriodKey).toBe('2026-08');
    expect(h.contributionMonth).toBe('08 / 2026');
    expect(h.contributionMonthCode).toBe('0826');
    // Tarikh DiCetak is the generation date, so it moves with the day rather than with the period.
    expect(h.printedOn).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('rolls the YEAR for a December payroll, which is where a wrong rule is worst', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-12');
    expect(r.meta.formHeader!.contributionPeriodKey).toBe('2027-01');
    expect(r.meta.formHeader!.contributionMonthCode).toBe('0127');
  });

  /**
   * THE ONE THIS FORM IS MOST LIKELY TO LOSE QUIETLY. Gross pay is always available and always looks
   * plausible; it also includes overtime, which EPF excludes.
   */
  it('takes Upah from the run’s own EPF wage basis, never from gross pay', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-07');

    const [slip] = await owner.db
      .select({ statutory: schema.payslip.statutory, gross: schema.payslip.grossPay })
      .from(schema.payslip)
      .limit(1);
    const st = slip.statutory as Record<string, number> & { bases?: Record<string, number> };
    expect(st.bases, 'the fixture must produce a run that stamps its wage bases').toBeTruthy();

    const expectedWage = Math.round((Number(st.bases!.epf) + Number(st.bases!.epfAdditional)) * 100) / 100;
    expect(r.rows[0].wage).toBe(expectedWage);
    expect(r.rows[0].employer).toBe(Math.round(Number(st.epfEmployer) * 100) / 100);
    expect(r.rows[0].employee).toBe(Math.round(Number(st.epfEmployee) * 100) / 100);
    expect(r.rows[0].wageRecorded).toBe('yes');

    // …and the strip SHOWS gross beside it, so the difference is visible rather than arguable.
    const labels = (r.meta.summary ?? []).map((s) => s.label);
    expect(labels).toContain('Upah — the EPF-liable wage');
    expect(labels).toContain('Gross pay — NOT what the form uses');
    const tile = (label: string) => Number((r.meta.summary ?? []).find((s) => s.label === label)!.value);
    expect(tile('Gross pay — NOT what the form uses')).toBe(Math.round(Number(slip.gross) * 100) / 100);
  });

  /**
   * 61 OF 121 PRODUCTION PAYSLIPS PREDATE r187's WAGE-BASIS STAMP. This is the case that must NOT fall
   * back to gross pay — "we do not know what this was charged on" is a different statement from "it was
   * charged on nothing", and only one of them may be printed.
   */
  it('marks a payslip with no wage basis as NOT recorded, and blocks on it instead of guessing', async () => {
    const E = await hire({ name: 'OLD RUN', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    await run('2026-07');
    // Strip the stamp, exactly as a pre-r187 payslip has it: the blob is there, the `bases` object is not.
    const [slip] = await owner.db
      .select({ id: schema.payslip.id, statutory: schema.payslip.statutory })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, E.employmentId))
      .limit(1);
    const st = { ...(slip.statutory as Record<string, unknown>) };
    delete st.bases;
    await owner.db.update(schema.payslip).set({ statutory: st }).where(eq(schema.payslip.id, slip.id));

    const r = await reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-a', periodKey: '2026-07' });
    expect(r.rows[0].wageRecorded).toBe('');
    // NOT gross pay, and not a plausible-looking number of any kind.
    expect(r.rows[0].wage).toBe(0);
    expect(r.readiness.map((x) => x.name)).toEqual(['OLD RUN']);
    expect(r.readiness[0].missing.join(' ')).toMatch(/EPF wage basis/);
  });

  it('reconciles: the row total, the reported total and the run’s own EPF all agree', async () => {
    await hire({ name: 'ZAINAB BINTI ALI', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555', epfNumber: '18690645' });
    await hire({ name: 'ABU BIN BAKAR', hiredOn: '2024-03-01', salary: 5000, ic: '880808085555', epfNumber: '19807671' });
    const r = await run('2026-07');

    const summedEmployer = r.rows.reduce((a, row) => a + Number(row.employer), 0);
    const summedEmployee = r.rows.reduce((a, row) => a + Number(row.employee), 0);
    expect(Math.round(summedEmployer * 100)).toBe(Math.round(r.totals.employer * 100));
    expect(Math.round(summedEmployee * 100)).toBe(Math.round(r.totals.employee * 100));
    const tile = (label: string) => Number((r.meta.summary ?? []).find((s) => s.label === label)!.value);
    // Summed by an INDEPENDENT path (straight off the payslips, not through the per-employee grouping), so
    // a divergence would mean the grouping dropped or double-counted somebody.
    expect(tile('EPF in this run (EE+ER)')).toBe(Math.round((r.totals.employer + r.totals.employee) * 100) / 100);
    expect(tile('Amaun Caruman (form)')).toBe(Math.round((r.totals.employer + r.totals.employee) * 100) / 100);
  });

  it('sorts by name, so the form is reproducible month to month', async () => {
    await hire({ name: 'ZAINAB BINTI ALI', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555', epfNumber: '18690645' });
    await hire({ name: 'ABU BIN BAKAR', hiredOn: '2024-03-01', salary: 3000, ic: '880808085555', epfNumber: '19807671' });
    const r = await run('2026-07');
    expect(r.rows.map((row) => row.name)).toEqual(['ABU BIN BAKAR', 'ZAINAB BINTI ALI']);
  });

  /**
   * THE READINESS GATE'S OWN HALF. MEASURED on production 2026-08-13: 9 of 33 employees have an EPF
   * member number. Dropping the other 24 would produce a form that reconciles to nothing and understates
   * the filing by two thirds — which is exactly why they are NAMED and kept.
   */
  it('names whoever has no EPF member number, without dropping them from the form', async () => {
    await hire({ name: 'AAA WITH NUMBER', hiredOn: '2024-03-01', salary: 3000, ic: '900101015555', epfNumber: '18690645' });
    await hire({ name: 'BBB NO NUMBER', hiredOn: '2024-03-01', salary: 3000, ic: '880808085555', epfNumber: null });
    const r = await run('2026-07');

    expect(r.readiness.map((x) => x.name)).toEqual(['BBB NO NUMBER']);
    expect(r.readiness[0].missing).toEqual(['EPF member no.']);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((row) => row.memberNo)).toContain('');
  });

  it('names an absent identity card number too, and both at once when both are absent', async () => {
    await hire({ name: 'CCC NEITHER', hiredOn: '2024-03-01', salary: 3000, ic: null, epfNumber: null });
    const r = await run('2026-07');
    expect(r.readiness[0].missing).toEqual(['EPF member no.', 'IC']);
  });

  /**
   * The authorised-representative block. It is ADVISORY: production carries one row across nine
   * companies, and blocking on it would make the feature unusable on day one for eight of them.
   */
  it('fills the representative block from the company’s EPF authority row when there is one', async () => {
    const E = await hire({ name: 'CHONG PEI YUH', hiredOn: '2024-03-01', salary: 4000, ic: '910416145530', epfNumber: '17955667' });
    await upsertCompanyStatutoryAuthority(adminCtx(b), {
      companyId: b.companyId,
      authority: 'epf',
      phone: '0123081733',
      email: 'rep@example.com',
      signatoryPersonId: E.personId,
    });
    const r = await run('2026-07');
    const h = r.meta.formHeader!;
    expect(h.repName).toBe('CHONG PEI YUH');
    // The signatory's identity card number comes off their own statutory record, not off the authority row.
    expect(h.repIc).toBe('910416145530');
    expect(h.repPhone).toBe('0123081733');
    expect(h.repEmail).toBe('rep@example.com');
    // …and it does NOT block: readiness is about the employees and the employer reference.
    expect(r.readiness).toEqual([]);
  });

  it('leaves the representative block blank rather than inventing one, and still produces the form', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await run('2026-07');
    const h = r.meta.formHeader!;
    expect([h.repName, h.repIc, h.repPosition, h.repPhone, h.repEmail]).toEqual(['', '', '', '', '']);
    expect(r.readiness).toEqual([]);
  });

  /** A month with no run is not an empty form: the screen says so, and the header is still there. */
  it('reports no batch rather than an empty form for a month that was never run', async () => {
    await hire({ name: 'ANG PEI YEE', hiredOn: '2024-03-01', salary: 4000, ic: '860208105128', epfNumber: '17955667' });
    const r = await reportPreview(adminCtx(b), {
      companyId: b.companyId,
      reportId: 'my.borang-a',
      periodKey: '2099-12',
    });
    expect(r.meta.hasBatch).toBe(false);
    expect(r.rows).toEqual([]);
    // The header survives, +1 rule included, so the screen can name the month it found nothing for.
    expect(r.meta.formHeader!.contributionMonth).toBe('01 / 2100');
  });

  /** A malformed period is refused rather than read as a literal batch key that finds nothing. */
  it('refuses a period that is not YYYY-MM', async () => {
    await expect(
      reportPreview(adminCtx(b), { companyId: b.companyId, reportId: 'my.borang-a', periodKey: '2026-13' }),
    ).rejects.toThrow(/YYYY-MM/);
  });
});

/**
 * END TO END: what the read produces feeds BOTH outputs, and the two agree — which is the whole reason
 * they are built from one row set rather than two queries.
 */
describe('the read feeds both outputs', () => {
  it('produces a form whose page totals add up and whose upload file balances', async () => {
    for (let i = 0; i < 25; i += 1) {
      await hire({
        name: `EMP ${String(i).padStart(2, '0')}`,
        hiredOn: '2024-03-01',
        salary: 3000 + i,
        ic: `9001010${String(100000 + i).slice(1)}`,
        epfNumber: String(20000000 + i),
      });
    }
    const r = await run('2026-07');
    const form = borangAFrom({ header: r.meta.formHeader, rows: r.rows });
    expect(form.employees).toBe(25);
    expect(form.pages.length).toBe(2); // 22 rows per sheet

    // The paper: page sums == the form total, and the last carry-out IS the total.
    const summed = form.pages.reduce((a, p) => a + p.pageEmployer, 0);
    expect(Math.round(summed * 100)).toBe(Math.round(form.totalEmployer * 100));
    expect(form.pages[form.pages.length - 1].carryOutEmployer).toBe(form.totalEmployer);
    expect(Math.round(form.totalEmployer * 100)).toBe(Math.round(r.totals.employer * 100));

    // The file: same rows, and the invariant holds on the emitted bytes.
    const rows = form.pages.flatMap((p) => p.rows);
    expect(borangAFileReadiness({ employerRef: form.employerRef, rows }).ok).toBe(true);
    const text = buildBorangAFile({
      employer: { epfRefNo: form.employerRef, code: 'DSK', periodMonth: 8, periodYear: 2026 },
      employees: rows.map((row) => ({
        epfMemberNo: row.memberNo,
        icNumber: row.ic,
        name: row.name,
        staffNo: row.staffNo,
        wages: row.wage,
        contribution: Math.round((row.employer + row.employee) * 100) / 100,
      })),
    });
    const t = parseBorangAFileTotals(text);
    expect(t.detailCount).toBe(25);
    // THE TWO OUTPUTS AGREE, which is the property that makes "check the paper, upload the file" safe.
    expect(t.detailContribCents).toBe(Math.round(form.totalContribution * 100));
    expect(t.detailWageCents).toBe(Math.round(form.totalWage * 100));
    expect(t.headerWageCents).toBe(t.trailerWageCents);
  });
});
