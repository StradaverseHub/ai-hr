/**
 * Audit H#5 — the imported month's net must stay zakat-aware, now on the LONG (seven-column) contract.
 *
 * Zakat-via-salary has two encodings in the wild and nothing in a file says which one it is:
 *   (a) separate-cash (the dominant MY encoding) — zakat really is deducted and the remitted `pcb` is
 *       already net of it, so net = gross − (epf + socso + eis + pcb + zakat);
 *   (b) reduce-pcb — zakat folded into the pcb figure and NOT separately deducted from net.
 *
 * Under the wide contract the file stated its own net and the importer had to accept either reading of
 * it. Under the long contract net is DERIVED, so (a) is what we compute — but a file may still state a
 * NETPAY cross-check line, and if that line matches (b) then (b) is the file's own arithmetic and its
 * figure is what gets stored. Getting this wrong forces a migrator to bury zakat in a generic deduction
 * and lose the EA Part-D Z line, which is exactly what H#5 was raised about.
 *
 * Statutory: ITA 1967 s.6A(3); EA Form C.P.8A Part D.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { eaStatement } from '../localization/my/reports';
import {
  validatePayrollHistoryImport,
  commitPayrollHistoryImport,
} from '../core/payroll-history-import';
import { PAYROLL_HISTORY_HEADERS } from '../lib/payroll-history-import-schema';
import { parseCsvRecords } from '../lib/csv';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

let b: Base;

const HEADER = PAYROLL_HISTORY_HEADERS.join(',');
const file = (...lines: string[]) => parseCsvRecords([HEADER, ...lines].join('\n')).records;
const line = (code: string, amount: string) => ['EZ001', '202406', 'ME', code, 'ACME', amount, '1'].join(',');

// gross 5000 + 300 = 5300. epf 583 + socso 24.75 + eis 9.90 = 617.65; pcb 150 (already net-of-zakat);
// zakat 80 as cash ⇒ net = 5300 − 617.65 − 150 − 80 = 4452.35.
const ZAKAT_MONTH = [
  line('BASIC', '5000.00'),
  line('ALLOWANCE', '300.00'),
  line('EEEPF', '583.00'),
  line('EESOCSO', '24.75'),
  line('EEEIS', '9.90'),
  line('PCB', '150.00'),
  line('ZAKAT', '80.00'),
];

const hire = (a: SessionContext) =>
  hireEmployee(a, {
    person: { fullName: 'EZ001', primaryEmail: 'ez@hist.test' },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    employeeCode: 'EZ001',
    hiredOn: '2024-01-01',
  });

async function empPersonId(employmentId: string): Promise<string> {
  const [row] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row.personId;
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

describe('H#5 — zakat-aware net on the imported month', () => {
  it('with no NETPAY line, zakat is deducted as cash (the dominant MY encoding)', async () => {
    const a = adminCtx(b);
    await hire(a);
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records: file(...ZAKAT_MONTH) });
    expect(dry.months[0].ok).toBe(true);
    expect(dry.months[0].net).toBeCloseTo(4452.35, 2);
    expect(dry.issues.filter((i) => i.status === 'Failed')).toHaveLength(0);
  });

  it('a NETPAY line on the separate-cash convention agrees and passes', async () => {
    const a = adminCtx(b);
    await hire(a);
    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...ZAKAT_MONTH, line('NETPAY', '4452.35')),
    });
    expect(dry.issues.filter((i) => i.type === 'Inconsistent totals')).toHaveLength(0);
    expect(dry.months[0].ok).toBe(true);
  });

  it('a NETPAY line on the reduce-pcb convention is accepted, and its own figure is what is stored', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a);
    // Same figures, but the file's net excludes the zakat term — zakat was folded into pcb, not deducted.
    const records = file(...ZAKAT_MONTH, line('NETPAY', '4532.35'));
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.issues.filter((i) => i.type === 'Inconsistent totals')).toHaveLength(0);
    expect(dry.months[0].ok).toBe(true);
    expect(dry.months[0].net).toBeCloseTo(4532.35, 2);

    await commitPayrollHistoryImport(a, { companyId: b.companyId, records });
    const [slip] = await owner.db
      .select()
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, employmentId));
    expect(Number(slip.netPay)).toBeCloseTo(4532.35, 2);
    expect(Number(slip.totalDeductions)).toBeCloseTo(5300 - 4532.35, 2);
  });

  it('a NETPAY line matching NEITHER convention errors rather than being quietly preferred', async () => {
    const a = adminCtx(b);
    await hire(a);
    const dry = await validatePayrollHistoryImport(a, {
      companyId: b.companyId,
      records: file(...ZAKAT_MONTH, line('NETPAY', '4000.00')),
    });
    const bad = dry.issues.filter((i) => i.type === 'Inconsistent totals');
    expect(bad).toHaveLength(1);
    expect(bad[0].status).toBe('Failed');
    expect(dry.months[0].ok).toBe(false);
  });

  it('the committed payslip preserves zakat so EA Part-D Z carries it, without burying it in deductions', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a);
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900303035525' });
    await commitPayrollHistoryImport(a, { companyId: b.companyId, records: file(...ZAKAT_MONTH) });

    const [slip] = await owner.db
      .select()
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, employmentId));
    expect((slip.statutory as { zakat: number }).zakat).toBeCloseTo(80, 2);
    // Zakat must NOT have been buried in other_deductions to make an arithmetic check pass.
    expect(Number(slip.otherDeductions)).toBeCloseTo(0, 2);

    const ea = await eaStatement(a, { employmentId, year: '2024' });
    expect(ea!.partD.zakat).toBeCloseTo(80, 2);
  });

  it('an LP (TP1 relief) line is stored but is NOT deducted from net — it is a relief, not cash', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a);
    const records = file(...ZAKAT_MONTH, line('LP', '120.00'));
    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records });
    expect(dry.months[0].net).toBeCloseTo(4452.35, 2); // unchanged by the LP line

    await commitPayrollHistoryImport(a, { companyId: b.companyId, records });
    const [slip] = await owner.db
      .select()
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, employmentId));
    expect((slip.statutory as { lp: number }).lp).toBeCloseTo(120, 2);
  });
});
