/**
 * Fix-8 / audit #30 — imported CP38 + TIN-readiness warning.
 *
 * #30 split into two behaviours:
 *   (a) a `cp38` import column is stamped into the payslip statutory blob (+ `cp38_ref` when supplied),
 *       so a migrated month carrying a CP38 instalment is CP39-complete (the e-Data file sums it).
 *   (b) analyze() warns (not blocks) when a resolved employee has pcb>0 but no TIN (`taxNumber`) — the
 *       month is un-fileable to CP39 until the TIN is backfilled (mirrors the CP39 readiness gate).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  validatePayrollHistoryImport,
  commitPayrollHistoryImport,
} from '../core/payroll-history-import';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { parseCsvRecords } from '../lib/csv';

let b: Base;
const parse = (csv: string) => parseCsvRecords(csv).records;

const hire = (a: SessionContext, email: string) =>
  hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function empPersonId(employmentId: string): Promise<string> {
  const [e] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return e.personId;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('Fix-8 #30 — imported CP38 + TIN-readiness warning', () => {
  it('stamps statutory.cp38 (+ cp38Ref) from the cp38 / cp38_ref columns', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'e1@hist.test');
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900101015523', taxNumber: 'IG12345678' });
    // basic 5000 + allowance 300 = gross 5300; ee ded = 583+24.75+9.90+150 = 767.65; net 4532.35
    // cp38 is a CASH instalment distinct from MTD — NOT added to the net-reconciliation deductions.
    const csv =
      'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus,cp38,cp38_ref\n' +
      'e1@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0,75.50,CP38-2024-001';

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    expect(dry.rows[0].ok).toBe(true);

    await commitPayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
    const st = slip.statutory as { cp38?: number; cp38Ref?: string; pcb: number };
    expect(st.cp38).toBeCloseTo(75.5, 2);
    expect(st.cp38Ref).toBe('CP38-2024-001');
    expect(st.pcb).toBeCloseTo(150, 2); // MTD unchanged — cp38 is a distinct figure
  });

  it('omitting cp38 leaves no cp38 key on the blob (mirrors the kernel conditional stamp)', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'e2@hist.test');
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900202025524', taxNumber: 'IG99' });
    const csv =
      'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus\n' +
      'e2@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0';
    await commitPayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
    const st = slip.statutory as Record<string, unknown>;
    expect('cp38' in st).toBe(false);
    expect('cp38Ref' in st).toBe(false);
  });

  it('warns (does not block) when a resolved employee has pcb>0 but no TIN', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'notin@hist.test');
    // Statutory profile WITHOUT a taxNumber (TIN).
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900303035525' });
    const csv =
      'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus\n' +
      'notin@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0';

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    const r = dry.rows[0];
    expect(r.ok).toBe(true); // a warning, NOT an error
    expect(r.warnings.join(' ')).toMatch(/TIN/i);
  });

  it('does NOT warn about a missing TIN when pcb is 0', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'zeropcb@hist.test');
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900404045526' });
    const csv =
      'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus\n' +
      'zeropcb@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,0,4682.35,300,0,0';
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    expect(dry.rows[0].warnings.join(' ')).not.toMatch(/TIN/i);
  });

  it('does NOT warn about a missing TIN when the employee has a taxNumber', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'hastin@hist.test');
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900505055527', taxNumber: 'IG55' });
    const csv =
      'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus\n' +
      'hastin@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0';
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    expect(dry.rows[0].warnings.join(' ')).not.toMatch(/TIN/i);
  });
});
