/**
 * Import Payroll History (4157a498) — integration.
 *
 * Asserts the load-bearing behaviours of the LONG (seven-column) contract:
 *
 *  · THE DOUBLE-COUNT GUARD — Override=1 on a period that already has payroll imports NOTHING and comes
 *    back as "Existing record". This is the single most important assertion in the file: the monthly and
 *    year-end readers sum every batch for a (company, period) with no run-type and no status filter, so a
 *    second load into an occupied month would submit someone paid 5,000 as 10,000, and migration 0011
 *    makes it un-deletable afterwards. Deleting this test deletes the whole of the safety.
 *  · folding — many lines become one employee-month and one payslip, with the scalars split by DOE code;
 *  · an unknown code stops its line rather than being dropped in silence;
 *  · completeness — earnings with no statutory line at all is an error; an explicit 0.00 satisfies it;
 *  · duplicate detection on the reporter's five-part key;
 *  · YYYYMM conversion, and rejection rather than coercion of anything else;
 *  · Company Code resolution against company_label, including the ambiguous-label hard error;
 *  · employee_code resolution within the company, and rejection when the employment didn't cover the month;
 *  · the GROSS / NETPAY cross-check;
 *  · the EA Part-B split warning surviving the fold;
 *
 * plus the structural guarantees carried over from the wide contract: the imported batch is
 * run_type='adjustment'/status='closed' with populated counters and a closed parent pay_period, a
 * completion domain event is appended, year-end (EA) and the monthly contributions report pick the
 * imported payslip up WITHOUT double-counting, and a non-admin commit is refused at the DB layer (RLS).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createBatch } from '../core/payroll';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { eaStatement, MY_REPORTS } from '../localization/my/reports';
import {
  validatePayrollHistoryImport,
  commitPayrollHistoryImport,
  toIsoPeriod,
} from '../core/payroll-history-import';
import { PAYROLL_HISTORY_HEADERS } from '../lib/payroll-history-import-schema';
import { parseCsvRecords } from '../lib/csv';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
  harnessSnapshot,
} from './harness';
import type { SessionContext } from '../db/client';

let b: Base;

const contributions = MY_REPORTS.find((r) => r.id === 'my.contributions')!;

/** The reporter's headings, verbatim — so every fixture also exercises the header round-trip. */
const HEADER = PAYROLL_HISTORY_HEADERS.join(',');
const parse = (csv: string) => parseCsvRecords(csv).records;
const file = (...lines: string[]) => parse([HEADER, ...lines].join('\n'));

/** One line of the long format. */
const line = (
  employeeNo: string,
  period: string,
  code: string,
  amount: string,
  opts: { cycle?: string; company?: string; override?: string } = {},
) =>
  [
    employeeNo,
    period,
    opts.cycle ?? 'ME',
    code,
    opts.company ?? 'ACME',
    amount,
    opts.override ?? '1',
  ].join(',');

/**
 * A complete employee-month: basic + allowance, every employee statutory figure, every employer one.
 *   gross = 5000 + 300               = 5300
 *   cash deductions = 583 + 24.75 + 9.90 + 150 = 767.65
 *   net = 5300 − 767.65              = 4532.35
 */
const completeMonth = (
  employeeNo: string,
  period: string,
  opts: { cycle?: string; company?: string; override?: string } = {},
) => [
  line(employeeNo, period, 'BASIC', '5000.00', opts),
  line(employeeNo, period, 'ALLOWANCE', '300.00', opts),
  line(employeeNo, period, 'EEEPF', '583.00', opts),
  line(employeeNo, period, 'EESOCSO', '24.75', opts),
  line(employeeNo, period, 'EEEIS', '9.90', opts),
  line(employeeNo, period, 'PCB', '150.00', opts),
  line(employeeNo, period, 'EREPF', '689.00', opts),
  line(employeeNo, period, 'ERSOCSO', '86.65', opts),
  line(employeeNo, period, 'EREIS', '9.90', opts),
];

const hire = (a: SessionContext, code: string, hiredOn = '2024-01-01') =>
  hireEmployee(a, {
    person: { fullName: code, primaryEmail: `${code.toLowerCase()}@hist.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    employeeCode: code,
    hiredOn,
  });

/**
 * Master data the long contract needs and seedBase does not create: the company's importable Company
 * Code (company_label), the payroll-cycle catalog (which is where "ME" comes from), and the two earning
 * pay components the fixtures code against. The statutory codes need no seeding — they are built into
 * lib/payroll-history-import-schema.ts precisely so a tenant with an empty catalog can still import.
 */
async function seedImportMasters() {
  await owner.db
    .update(schema.company)
    .set({ companyLabel: 'ACME' })
    .where(eq(schema.company.id, b.companyId));
  await seedPayrollCycleCatalog(adminCtx(b), b.companyId);
  await owner.db.insert(schema.payComponent).values([
    { tenantId: b.tenantId, code: 'BASIC', name: 'Basic salary', kind: 'allowance', displayCategory: 'basic' },
    { tenantId: b.tenantId, code: 'ALLOWANCE', name: 'Fixed allowance', kind: 'allowance', displayCategory: 'allowance' },
    { tenantId: b.tenantId, code: 'OVERTIME', name: 'Overtime', kind: 'allowance', displayCategory: 'overtime' },
    { tenantId: b.tenantId, code: 'DEDUCTION', name: 'Deduction', kind: 'deduction', displayCategory: 'deduction' },
  ]);
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await seedImportMasters();
});
afterAll(async () => {
  await closeAll();
});

describe('import payroll history — the long (seven-column) contract', () => {
  it('folds many lines into ONE employee-month and one payslip, split by DOE code', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(...completeMonth('A1001', '202401'));

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.total).toBe(9);
    expect(dry.months).toHaveLength(1);
    expect(dry.months[0].ok).toBe(true);
    expect(dry.months[0].period).toBe('2024-01');
    expect(dry.months[0].lineCount).toBe(9);
    expect(dry.months[0].gross).toBeCloseTo(5300, 2);
    expect(dry.months[0].net).toBeCloseTo(4532.35, 2);
    expect(dry.valid).toBe(9);
    // Dry run wrote nothing.
    expect(await owner.db.select().from(schema.payrollBatch)).toHaveLength(0);

    const r = await commitPayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(r.imported).toBe(9);
    expect(r.importedMonths).toBe(1);
    expect(r.updated).toBe(0);

    const slips = await owner.db.select().from(schema.payslip);
    expect(slips).toHaveLength(1);
    const [slip] = slips;
    expect(Number(slip.basicSalary)).toBeCloseTo(5000, 2);
    expect(Number(slip.allowance)).toBeCloseTo(300, 2);
    expect(Number(slip.grossPay)).toBeCloseTo(5300, 2);
    expect(Number(slip.netPay)).toBeCloseTo(4532.35, 2);
    expect(Number(slip.employerCost)).toBeCloseTo(5300 + 689 + 86.65 + 9.9, 2);
    const st = slip.statutory as Record<string, number>;
    expect(st.epfEmployee).toBeCloseTo(583, 2);
    expect(st.epfEmployer).toBeCloseTo(689, 2);
    expect(st.socsoEmployee).toBeCloseTo(24.75, 2);
    expect(st.eisEmployer).toBeCloseTo(9.9, 2);
    expect(st.pcb).toBeCloseTo(150, 2);
  });

  it('Override=1 on an occupied period imports NOTHING and reports Existing record', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    await hire(a, 'A1002');
    // A real (regular) batch already occupies 2024-01 — the double-count trap.
    await createBatch(a, { companyId: b.companyId, payPeriod: '2024-01' });

    const records = file(
      ...completeMonth('A1001', '202401', { override: '1' }), // occupied → held
      ...completeMonth('A1002', '202402', { override: '1' }), // empty → imported
    );

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.existingMonths).toBe(1);
    const occupied = dry.months.find((m) => m.period === '2024-01')!;
    expect(occupied.ok).toBe(false);
    expect(occupied.existing).toBe(true);
    // Every contributing row is flagged, with the reporter's own Error Type and status.
    const existingIssues = dry.issues.filter((i) => i.type === 'Existing record');
    expect(existingIssues).toHaveLength(9);
    expect(existingIssues.every((i) => i.status === 'Needs action')).toBe(true);

    const r = await commitPayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(r.existing).toBe(1);
    expect(r.updated).toBe(0); // never, whatever Override says
    expect(r.importedMonths).toBe(1);

    // NOTHING landed in the occupied period: it still has exactly the one pre-existing batch, and that
    // batch still has no payslips. The empty period got its own imported batch.
    const jan = await owner.db
      .select()
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.payPeriod, '2024-01'));
    expect(jan).toHaveLength(1);
    expect(jan[0].runType).toBe('regular');
    expect(
      await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, jan[0].id)),
    ).toHaveLength(0);

    const feb = await owner.db
      .select()
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.payPeriod, '2024-02'));
    expect(feb).toHaveLength(1);
    expect(
      await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, feb[0].id)),
    ).toHaveLength(1);
  });

  it('an unknown DOE code stops its line (and holds its month) rather than being dropped', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(...completeMonth('A1001', '202401'), line('A1001', '202401', 'NOSUCHCODE', '99.00'));

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    const bad = dry.issues.filter((i) => i.type === 'Invalid DOE Code');
    expect(bad).toHaveLength(1);
    expect(bad[0].doeCode).toBe('NOSUCHCODE');
    expect(bad[0].status).toBe('Failed');
    // The whole month is held — half a month would understate the year-end statement.
    expect(dry.months[0].ok).toBe(false);
    expect(dry.valid).toBe(0);

    const r = await commitPayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(r.imported).toBe(0);
    expect(await owner.db.select().from(schema.payslip)).toHaveLength(0);
  });

  it('earnings with no statutory line at all is an Incomplete month error', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(
      line('A1001', '202401', 'BASIC', '5000.00'),
      line('A1001', '202401', 'ALLOWANCE', '300.00'),
    );

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    const incomplete = dry.issues.filter((i) => i.type === 'Incomplete month');
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].status).toBe('Failed');
    expect(dry.months[0].ok).toBe(false);
    expect(dry.valid).toBe(0);
  });

  it('an explicit 0.00 statutory line satisfies completeness', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(
      line('A1001', '202401', 'BASIC', '1200.00'),
      // Below every MY threshold, so all four really were zero — and saying so is what makes it loadable.
      line('A1001', '202401', 'EEEPF', '0.00'),
      line('A1001', '202401', 'EESOCSO', '0.00'),
      line('A1001', '202401', 'EEEIS', '0.00'),
      line('A1001', '202401', 'PCB', '0.00'),
    );

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.issues.filter((i) => i.type === 'Incomplete month')).toHaveLength(0);
    expect(dry.months[0].ok).toBe(true);
    expect(dry.months[0].gross).toBeCloseTo(1200, 2);
    expect(dry.months[0].net).toBeCloseTo(1200, 2);
  });

  it('detects a duplicate on the five-part key (employee, period, cycle, DOE code, company)', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(
      ...completeMonth('A1001', '202401'),
      line('A1001', '202401', 'BASIC', '5000.00'), // exact repeat of the five-part key
    );

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.duplicates).toBe(1);
    const dup = dry.issues.filter((i) => i.type === 'Duplicate record');
    expect(dup).toHaveLength(1);
    expect(dup[0].rowNum).toBe(11); // header is row 1, so the tenth data line is row 11
    expect(dry.months[0].ok).toBe(false);
  });

  it('a differing DOE code at the same employee/period/cycle/company is NOT a duplicate', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(...completeMonth('A1001', '202401'), line('A1001', '202401', 'OVERTIME', '120.00'));
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.duplicates).toBe(0);
    expect(dry.months[0].ok).toBe(true);
    expect(dry.months[0].gross).toBeCloseTo(5420, 2);
  });

  it('converts YYYYMM, and rejects anything else rather than coercing it', async () => {
    // The pure converter, first — the one place a coerced period could be born.
    expect(toIsoPeriod('202501')).toBe('2025-01');
    expect(toIsoPeriod('202512')).toBe('2025-12');
    expect(toIsoPeriod('2025-01')).toBe('2025-01'); // the stored form is accepted too
    expect(toIsoPeriod('202513')).toBeNull(); // month 13
    expect(toIsoPeriod('202500')).toBeNull(); // month 0
    expect(toIsoPeriod('20251')).toBeNull(); // five digits
    expect(toIsoPeriod('2025011')).toBeNull(); // seven digits
    expect(toIsoPeriod('Jan-2025')).toBeNull();
    expect(toIsoPeriod('')).toBeNull();

    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(...completeMonth('A1001', '202401'), line('A1001', '202413', 'BASIC', '5000.00'));
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    const badPeriod = dry.issues.filter((i) => i.type === 'Invalid Payroll Period');
    expect(badPeriod).toHaveLength(1);
    expect(badPeriod[0].period).toBe('202413'); // reported as supplied, so it is findable in their file
    // The good month is untouched by the bad line — it is a different month.
    expect(dry.months.find((m) => m.period === '2024-01')!.ok).toBe(true);
  });

  it('resolves Company Code against company_label, and hard-errors on unknown or ambiguous', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');

    // Unknown.
    const unknown = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401', { company: 'NOPE' })),
    });
    const unknownIssues = unknown.issues.filter((i) => i.type === 'Invalid Company Code');
    expect(unknownIssues.length).toBeGreaterThan(0);
    expect(unknownIssues[0].description).toMatch(/No company matches/);
    expect(unknown.months[0].ok).toBe(false);

    // Known and correct.
    const known = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401', { company: 'acme' })), // case-insensitive
    });
    expect(known.issues.filter((i) => i.type === 'Invalid Company Code')).toHaveLength(0);
    expect(known.months[0].ok).toBe(true);

    // Ambiguous: a second live company carries the same label. The leave importer's first-writer-wins
    // would silently pick one; here a mis-targeted payroll month cannot be taken back, so it must fail.
    await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Acme Two Sdn Bhd', companyLabel: 'ACME' });
    const ambiguous = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401')),
    });
    const ambiguousIssues = ambiguous.issues.filter((i) => i.type === 'Invalid Company Code');
    expect(ambiguousIssues.length).toBeGreaterThan(0);
    expect(ambiguousIssues[0].description).toMatch(/matches 2 companies/);
    expect(ambiguous.months[0].ok).toBe(false);
  });

  it('resolves the employee by employee_code, and refuses a month the employment did not cover', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001', '2024-01-01');
    // Joined AFTER the imported month — the employment did not cover 2024-01.
    await hire(a, 'A1002', '2024-09-01');

    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(
        ...completeMonth('A1001', '202401'),
        ...completeMonth('A1002', '202401'),
        ...completeMonth('A9999', '202401'), // not in Employee Master at all
      ),
    });
    const bad = dry.issues.filter((i) => i.type === 'Invalid Employee No');
    expect(bad.some((i) => i.employeeNo === 'A1002' && /was not employed during 2024-01/.test(i.description))).toBe(true);
    expect(bad.some((i) => i.employeeNo === 'A9999' && /does not exist in Employee Master/.test(i.description))).toBe(true);
    expect(dry.months.find((m) => m.employeeNo === 'A1001')!.ok).toBe(true);
    expect(dry.months.find((m) => m.employeeNo === 'A1002')!.ok).toBe(false);

    // A termination before the month is refused on the same rule.
    const [emp] = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(eq(schema.employment.employeeCode, 'A1001'));
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2023-12-31' })
      .where(eq(schema.employment.id, emp.id));
    const after = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401')),
    });
    expect(after.months[0].ok).toBe(false);
    expect(after.issues.some((i) => i.type === 'Invalid Employee No' && /left 2023-12-31/.test(i.description))).toBe(true);
  });

  it('a GROSS or NETPAY line that disagrees with the file’s own lines is an error', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');

    // Agreeing figures pass and are NOT double-counted into gross.
    const agreeing = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(
        ...completeMonth('A1001', '202401'),
        line('A1001', '202401', 'GROSS', '5300.00'),
        line('A1001', '202401', 'NETPAY', '4532.35'),
      ),
    });
    expect(agreeing.issues.filter((i) => i.type === 'Inconsistent totals')).toHaveLength(0);
    expect(agreeing.months[0].ok).toBe(true);
    expect(agreeing.months[0].gross).toBeCloseTo(5300, 2);

    const disagreeing = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401'), line('A1001', '202401', 'GROSS', '9999.00')),
    });
    const bad = disagreeing.issues.filter((i) => i.type === 'Inconsistent totals');
    expect(bad).toHaveLength(1);
    expect(bad[0].description).toMatch(/9999\.00/);
    expect(disagreeing.months[0].ok).toBe(false);

    const badNet = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401'), line('A1001', '202401', 'NETPAY', '1.00')),
    });
    expect(badNet.issues.filter((i) => i.type === 'Inconsistent totals')).toHaveLength(1);
    expect(badNet.months[0].ok).toBe(false);
  });

  it('the EA Part-B split check survives folding, as a warning that never blocks', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    // Every earning line coded BASIC — the case the wide contract's `gross > basic` warning existed for.
    const allBasic = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(
        line('A1001', '202401', 'BASIC', '5300.00'),
        line('A1001', '202401', 'EEEPF', '583.00'),
        line('A1001', '202401', 'PCB', '150.00'),
      ),
    });
    const warn = allBasic.issues.filter((i) => i.type === 'EA breakdown');
    expect(warn).toHaveLength(1);
    expect(warn[0].status).toBe('Warning');
    // A warning NEVER blocks — the month is still importable, which is the whole point.
    expect(allBasic.months[0].ok).toBe(true);
    // Two warnings, both non-blocking: the EA breakdown above and CP39 readiness (this fixture has no
    // tax number on file). Counting them proves warnings are counted separately from errors.
    expect(allBasic.months[0].warningCount).toBe(2);
    expect(allBasic.months[0].errorCount).toBe(0);

    // With a genuine allowance line the warning is absent. That is what the long format buys.
    const withSplit = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401')),
    });
    expect(withSplit.issues.filter((i) => i.type === 'EA breakdown')).toHaveLength(0);
    expect(withSplit.months[0].ok).toBe(true);
  });

  it('a non-numeric Amount, a bad Override and a blank mandatory field each stop their line', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const records = file(
      // Thousands separators are tolerated in the cell — quoted here because a bare comma would
      // otherwise split the CSV row, which is a property of CSV and not of this importer.
      ['A1001', '202401', 'ME', 'BASIC', 'ACME', '"5,000.00"', '1'].join(','),
      line('A1001', '202401', 'ALLOWANCE', '3O0.00'), // letter O, not a zero
      line('A1001', '202401', 'EEEPF', '583.00', { override: '2' }),
      ',202401,ME,PCB,ACME,150.00,1', // blank Employee No
      ',,,,,,', // wholly blank — ignored in silence, not an error
    );
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.total).toBe(4); // the blank line is not counted as uploaded
    expect(dry.issues.filter((i) => i.type === 'Invalid Amount')).toHaveLength(1);
    expect(dry.issues.filter((i) => i.type === 'Invalid Override')).toHaveLength(1);
    expect(dry.issues.filter((i) => i.type === 'Missing mandatory field')).toHaveLength(1);
  });

  it('an unknown Payroll Cycle stops its line', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401', { cycle: 'ZZ' })),
    });
    const bad = dry.issues.filter((i) => i.type === 'Invalid Payroll Cycle');
    expect(bad.length).toBeGreaterThan(0);
    expect(dry.months[0].ok).toBe(false);

    // The friendly NAME resolves too, for a customer who has not filled the codes in yet.
    const byName = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401', { cycle: 'Monthly' })),
    });
    expect(byName.issues.filter((i) => i.type === 'Invalid Payroll Cycle')).toHaveLength(0);
    expect(byName.months[0].ok).toBe(true);
  });

  it('imported batch is run_type=adjustment, status=closed, counters populated; parent period closed', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    await hire(a, 'A1002');
    await commitPayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401'), ...completeMonth('A1002', '202401')),
    });

    const [batch] = await owner.db
      .select()
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.payPeriod, '2024-01'));
    expect(batch.runType).toBe('adjustment');
    expect(batch.runSeq).toBe(1);
    expect(batch.status).toBe('closed');
    expect(batch.employeeCount).toBe(2);
    expect(batch.remarks).toBe('Imported payroll history');
    const totals = batch.totals as { gross: number; net: number };
    expect(totals.gross).toBeCloseTo(10600, 2);
    expect(totals.net).toBeCloseTo(9064.7, 2);

    const [period] = await owner.db
      .select()
      .from(schema.payPeriod)
      .where(eq(schema.payPeriod.id, batch.payPeriodId));
    expect(period.status).toBe('closed');
  });

  it('appends a payroll-history-import.completed domain event', async () => {
    const a = adminCtx(b);
    await hire(a, 'A1001');
    await commitPayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401')),
    });
    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, b.companyId));
    const completed = events.filter((e) => e.eventType === 'payroll-history-import.completed');
    expect(completed).toHaveLength(1);
    const payload = completed[0].payload as { imported: number; importedMonths: number; periods: string[] };
    expect(payload.imported).toBe(9);
    expect(payload.importedMonths).toBe(1);
    expect(payload.periods).toContain('2024-01');
  });

  it('EA + monthly aggregation pick up the imported payslip without double-counting, with the breakdown', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'A1001');
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900101015523' });
    // basic 5000, allowance 300, overtime 100 → gross 5400; deductions 583+24.75+9.90+150 = 767.65.
    await commitPayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401'), line('A1001', '202401', 'OVERTIME', '100.00')),
    });

    const ea = await eaStatement(a, { employmentId, year: '2024' });
    expect(ea).not.toBeNull();
    expect(ea!.partB.gross).toBeCloseTo(5400, 2);
    expect(ea!.partB.grossSalary).toBeCloseTo(5100, 2); // basic 5000 + overtime 100
    expect(ea!.partB.allowances).toBeCloseTo(300, 2);
    expect(ea!.partD.mtd).toBeCloseTo(150, 2);
    expect(ea!.partE.epf).toBeCloseTo(583, 2);

    const monthly = await contributions.generate(a, { companyId: b.companyId, periodKey: '2024-01' });
    const mine = monthly.rows[0];
    expect(Number(mine.gross)).toBeCloseTo(5400, 2);
    expect(Number(mine.epf)).toBeCloseTo(583 + 689, 2);
    expect(Number(mine.pcb)).toBeCloseTo(150, 2);
  });

  it('a non-admin commit is blocked at the DB layer (payroll_batch/payslip WITH CHECK = is_admin)', async () => {
    const a = adminCtx(b);
    const { personId } = await hire(a, 'A1001');
    const uid = await createAppUser(b.tenantId, personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };

    // The per-period write is isolated in its own transaction, so RLS denial surfaces as a failed
    // period (not a thrown call) — but the crucial guarantee is the same: NOTHING is written.
    const r = await commitPayrollHistoryImport(empCtx, {
      companyId: b.companyId,
      records: file(...completeMonth('A1001', '202401')),
    });
    expect(r.imported).toBe(0);
    expect(r.issues.some((i) => i.status === 'Failed')).toBe(true);

    expect(await owner.db.select().from(schema.payrollBatch)).toHaveLength(0);
    expect(await owner.db.select().from(schema.payslip)).toHaveLength(0);
    expect(await owner.db.select().from(schema.payPeriod)).toHaveLength(0);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function empPersonId(employmentId: string): Promise<string> {
  const [e] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return e.personId;
}
