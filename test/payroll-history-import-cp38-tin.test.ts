/**
 * Imported CP38 + the CP39 TIN-readiness warning, on the LONG (seven-column) contract.
 *
 * Two behaviours, both carried over from the wide contract because both are still load-bearing:
 *
 *  (a) a CP38 line is stamped into the payslip's statutory blob, so a migrated month carrying an
 *      LHDN/court instalment is CP39-complete — cp39FileForBatch sums it into the e-Data file's CP38
 *      column. CP38 is DISTINCT from MTD: it must not be folded into `pcb`.
 *  (b) a month with tax deducted for an employee with no TIN (tax number) warns rather than blocking.
 *      This one is deliberately not an error: 21 of the 33 live employee_statutory_my rows have no
 *      tax_number, so hard-erroring it would stop most of a real migration for something the customer
 *      fixes afterwards.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  validatePayrollHistoryImport,
  commitPayrollHistoryImport,
} from '../core/payroll-history-import';
import { PAYROLL_HISTORY_HEADERS } from '../lib/payroll-history-import-schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { parseCsvRecords } from '../lib/csv';

let b: Base;

const HEADER = PAYROLL_HISTORY_HEADERS.join(',');
const file = (...lines: string[]) => parseCsvRecords([HEADER, ...lines].join('\n')).records;
const line = (employeeNo: string, code: string, amount: string) =>
  [employeeNo, '202406', 'ME', code, 'ACME', amount, '1'].join(',');

/** basic 5000 + allowance 300 = gross 5300; deductions 583 + 24.75 + 9.90 + pcb. */
const month = (employeeNo: string, pcb: string, extra: string[] = []) => [
  line(employeeNo, 'BASIC', '5000.00'),
  line(employeeNo, 'ALLOWANCE', '300.00'),
  line(employeeNo, 'EEEPF', '583.00'),
  line(employeeNo, 'EESOCSO', '24.75'),
  line(employeeNo, 'EEEIS', '9.90'),
  line(employeeNo, 'PCB', pcb),
  ...extra,
];

const hire = (a: SessionContext, code: string) =>
  hireEmployee(a, {
    person: { fullName: code, primaryEmail: `${code.toLowerCase()}@hist.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    employeeCode: code,
    hiredOn: '2024-01-01',
  });

async function empPersonId(employmentId: string): Promise<string> {
  const [e] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return e.personId;
}

async function seedImportMasters() {
  await owner.db
    .update(schema.company)
    .set({ companyLabel: 'ACME' })
    .where(eq(schema.company.id, b.companyId));
  await seedPayrollCycleCatalog(adminCtx(b), b.companyId);
  await owner.db.insert(schema.payComponent).values([
    { tenantId: b.tenantId, code: 'BASIC', name: 'Basic salary', kind: 'allowance', displayCategory: 'basic' },
    { tenantId: b.tenantId, code: 'ALLOWANCE', name: 'Fixed allowance', kind: 'allowance', displayCategory: 'allowance' },
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

describe('imported CP38 + TIN-readiness warning', () => {
  it('stamps statutory.cp38 from a CP38 line, leaving MTD untouched', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'A1001');
    await setStatutoryProfileMY(a, {
      personId: await empPersonId(employmentId),
      icNumber: '900101015523',
      taxNumber: 'IG12345678',
    });
    const records = file(...month('A1001', '150.00', [line('A1001', 'CP38', '75.50')]));

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.months[0].ok).toBe(true);
    // CP38 is a real cash deduction: gross 5300 − (583 + 24.75 + 9.90 + 150 + 75.50) = 4456.85.
    expect(dry.months[0].net).toBeCloseTo(4456.85, 2);

    await commitPayrollHistoryImport(a, { companyId: b.companyId, records });
    const [slip] = await owner.db
      .select()
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, employmentId));
    const st = slip.statutory as { cp38?: number; pcb: number };
    expect(st.cp38).toBeCloseTo(75.5, 2);
    expect(st.pcb).toBeCloseTo(150, 2); // MTD unchanged — CP38 is a distinct figure
  });

  it('omitting CP38 leaves no cp38 key on the blob (mirrors the kernel conditional stamp)', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'A1002');
    await setStatutoryProfileMY(a, {
      personId: await empPersonId(employmentId),
      icNumber: '900202025524',
      taxNumber: 'IG99',
    });
    await commitPayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...month('A1002', '150.00')),
    });
    const [slip] = await owner.db
      .select()
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, employmentId));
    expect('cp38' in (slip.statutory as Record<string, unknown>)).toBe(false);
  });

  it('warns — never blocks — when tax was deducted and the employee has no TIN', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'A1003');
    // Statutory profile WITHOUT a tax number.
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900303035525' });

    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...month('A1003', '150.00')),
    });
    const warn = dry.issues.filter((i) => i.type === 'CP39 readiness');
    expect(warn).toHaveLength(1);
    expect(warn[0].status).toBe('Warning');
    expect(dry.months[0].ok).toBe(true); // a warning, NOT an error
    expect(dry.valid).toBe(6);

    // And it really does load.
    const r = await commitPayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...month('A1003', '150.00')),
    });
    expect(r.importedMonths).toBe(1);
  });

  it('does NOT warn when tax is zero, or when the employee has a TIN', async () => {
    const a = adminCtx(b);
    const zero = await hire(a, 'A1004');
    await setStatutoryProfileMY(a, { personId: await empPersonId(zero.employmentId), icNumber: '900404045526' });
    const withTin = await hire(a, 'A1005');
    await setStatutoryProfileMY(a, {
      personId: await empPersonId(withTin.employmentId),
      icNumber: '900505055527',
      taxNumber: 'IG55',
    });

    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...month('A1004', '0.00'), ...month('A1005', '150.00')),
    });
    expect(dry.issues.filter((i) => i.type === 'CP39 readiness')).toHaveLength(0);
    expect(dry.months.every((m) => m.ok)).toBe(true);
  });
});
