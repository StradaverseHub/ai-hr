/**
 * Audit H#5 — Imported-history net reconciliation must be zakat-aware.
 *
 * The dominant MY encoding treats zakat as a REAL cash deduction (the remitted `pcb` is already
 * net-of-zakat), so the true identity is `net = gross − epf − socso − eis − pcb − zakat`. The old check
 * only allowed `net = gross − (… + pcb)` (no `−zakat`), so a correct zakat-payer row was rejected — forcing
 * the migrator to bury zakat in `other_deductions` and lose the EA Part-D Z line.
 *
 * Statutory: ITA 1967 s.6A(3); EA Form C.P.8A Part D.
 *
 * Fix: accept the row if `net` matches EITHER convention (with OR without `−zakat`) within MONEY_TOL, and
 * preserve zakat on the payslip so EA Part-D Z carries it.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { eaStatement } from '../localization/my/reports';
import {
  validatePayrollHistoryImport,
  commitPayrollHistoryImport,
} from '../core/payroll-history-import';
import { parseCsvRecords } from '../lib/csv';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

let b: Base;

const hire = (a: SessionContext, email: string) =>
  hireEmployee(a, {
    person: { fullName: email.split('@')[0], primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

function parse(csv: string) {
  return parseCsvRecords(csv).records;
}

async function empPersonId(employmentId: string): Promise<string> {
  const [row] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row.personId;
}

// Zakat-as-cash row: basic 5000 + allowance 300 = gross 5300. Statutory EE = epf 583 + socso 24.75 +
// eis 9.90 = 617.65; pcb 150 (already net-of-zakat); zakat 80 deducted as cash ⇒
//   net = 5300 − 617.65 − 150 − 80 = 4452.35.
const HEADER_Z =
  'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus,socso_skbbk,lp,zakat';
const ZAKAT_CASH_ROW =
  'ez@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4452.35,300,0,0,0,0,80';

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

describe('H#5 — zakat-aware net reconciliation on history import', () => {
  it('a zakat-as-cash row (net = gross − statutory − pcb − zakat) imports cleanly', async () => {
    const a = adminCtx(b);
    await hire(a, 'ez@hist.test');
    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: parse([HEADER_Z, ZAKAT_CASH_ROW].join('\n')),
    });
    expect(dry.rows[0].ok).toBe(true);
    expect(dry.rows[0].errors).toEqual([]);
    expect(dry.validCount).toBe(1);
  });

  it('the committed payslip preserves zakat so EA Part-D Z carries it', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'ez@hist.test');
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900303035525' });
    await commitPayrollHistoryImport(a, {
      companyId: b.companyId,
      records: parse([HEADER_Z, ZAKAT_CASH_ROW].join('\n')),
    });

    const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
    const st = slip.statutory as { zakat: number };
    expect(st.zakat).toBe(80);
    // zakat must NOT have been buried in other_deductions to make the (wrong) net check pass.
    expect(Number(slip.otherDeductions)).toBeCloseTo(0, 2);

    const ea = await eaStatement(a, { employmentId, year: '2024' });
    expect(ea!.partD.zakat).toBeCloseTo(80, 2);
  });

  it('the engine-convention row (net = gross − statutory − pcb, zakat NOT cash) still imports cleanly', async () => {
    // Regression guard: the reduce-pcb convention (zakat folded into pcb, not separately deducted from net)
    // must remain accepted. Same figures but net excludes the zakat term.
    const a = adminCtx(b);
    await hire(a, 'ez@hist.test');
    const engineRow =
      'ez@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0,0,0,80';
    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: parse([HEADER_Z, engineRow].join('\n')),
    });
    expect(dry.rows[0].ok).toBe(true);
    expect(dry.rows[0].errors).toEqual([]);
  });
});
