/**
 * 1.2.5 Import Payroll History — integration.
 *
 * Asserts the load-bearing behaviours: dry-run flags bad rows + writes nothing; commit imports only
 * valid rows with correct imported/failed/skipped counts; a period that already has a batch is skipped
 * (the double-count guard); the imported batch is run_type='adjustment'/status='closed' with populated
 * counters and a closed parent pay_period; a completion domain event is appended; year-end (EA) and the
 * monthly contributions report pick up the imported payslip WITHOUT double-counting; lp/zakat reach the
 * EA accumulator; and a non-admin commit is rejected at the DB layer (RLS).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createBatch } from '../core/payroll';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { eaStatement, MY_REPORTS } from '../localization/my/reports';
import {
  validatePayrollHistoryImport,
  commitPayrollHistoryImport,
} from '../core/payroll-history-import';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
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

const contributions = MY_REPORTS.find((r) => r.id === 'my.contributions')!;

/** A header + one valid row for (email, period) with internally-consistent figures. */
const validRow = (email: string, period: string, extra = '') =>
  // basic 5000 + allowance 300 = gross 5300; ee deductions = 583+24.75+9.90+150 = 767.65; net 4532.35
  `${email},${period},5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0${extra}`;

const HEADER =
  'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus';

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

describe('1.2.5 — import payroll history', () => {
  it('dry-run flags bad rows (unknown email, bad period, arithmetic + employer-cost) and writes nothing', async () => {
    const a = adminCtx(b);
    await hire(a, 'e1@hist.test');
    const csv = [
      `${HEADER},employer_cost`,
      validRow('e1@hist.test', '2024-06') + ',6085.55', // valid
      validRow('nobody@hist.test', '2024-06') + ',6085.55', // unknown email
      validRow('e1@hist.test', '2024-13') + ',6085.55', // bad period month
      // arithmetic mismatch: net wrong
      'e1@hist.test,2024-07,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,9999.99,300,0,0,6085.55',
      // employer-cost mismatch (warning, still ok): net correct, cost wildly off
      'e1@hist.test,2024-08,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0,99999',
    ].join('\n');

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    expect(dry.rows).toHaveLength(5);
    expect(dry.validCount).toBe(2); // row 1 + row 5 (warning only)
    expect(dry.rows[1].errors.join(' ')).toMatch(/Unknown employee/);
    expect(dry.rows[2].errors.join(' ')).toMatch(/period/);
    expect(dry.rows[3].errors.join(' ')).toMatch(/net_pay/);
    expect(dry.rows[4].ok).toBe(true);
    expect(dry.rows[4].warnings.join(' ')).toMatch(/employer_cost/);

    // Dry-run wrote nothing.
    const batches = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.companyId, b.companyId));
    expect(batches).toHaveLength(0);
  });

  it('commit imports only valid rows; counts imported/failed/skipped are correct', async () => {
    const a = adminCtx(b);
    await hire(a, 'e1@hist.test');
    await hire(a, 'e2@hist.test');
    const csv = [
      HEADER,
      validRow('e1@hist.test', '2024-06'),
      validRow('e2@hist.test', '2024-06'),
      validRow('nobody@hist.test', '2024-06'), // invalid → not imported, not counted as skipped
    ].join('\n');

    const r = await commitPayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    expect(r.imported).toBe(2);
    expect(r.failed).toHaveLength(0);
    expect(r.skipped).toBe(0);

    const slips = await owner.db.select().from(schema.payslip);
    expect(slips).toHaveLength(2);
  });

  it('period already has a batch ⇒ all its rows are skipped (the double-count guard)', async () => {
    const a = adminCtx(b);
    await hire(a, 'e1@hist.test');
    await hire(a, 'e2@hist.test');
    // A real (regular) batch already occupies 2024-06.
    await createBatch(a, { companyId: b.companyId, payPeriod: '2024-06' });

    const csv = [
      HEADER,
      validRow('e1@hist.test', '2024-06'), // occupied period → skip
      validRow('e2@hist.test', '2024-07'), // empty period → import
    ].join('\n');

    const dry = await validatePayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    expect(dry.skippedCount).toBe(1);
    expect(dry.rows[0].skipped).toBe(true);
    expect(dry.rows[0].warnings.join(' ')).toMatch(/already has payroll/);
    expect(dry.rows[1].ok).toBe(true);

    const r = await commitPayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });
    expect(r.imported).toBe(1);
    expect(r.skipped).toBe(1);

    // No payslip landed in the occupied (real) batch; the empty period got an imported batch.
    const importedBatch = (await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.payPeriod, '2024-07')))[0];
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, importedBatch.id));
    expect(slips).toHaveLength(1);
  });

  it('imported batch is run_type=adjustment, status=closed, counters populated; parent period closed', async () => {
    const a = adminCtx(b);
    await hire(a, 'e1@hist.test');
    await hire(a, 'e2@hist.test');
    const csv = [HEADER, validRow('e1@hist.test', '2024-06'), validRow('e2@hist.test', '2024-06')].join('\n');
    await commitPayrollHistoryImport(a, { companyId: b.companyId, records: parse(csv) });

    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.payPeriod, '2024-06'));
    expect(batch.runType).toBe('adjustment');
    expect(batch.runSeq).toBe(1);
    expect(batch.status).toBe('closed');
    expect(batch.employeeCount).toBe(2);
    expect(batch.remarks).toBe('Imported payroll history');
    const totals = batch.totals as { gross: number; net: number };
    expect(totals.gross).toBeCloseTo(10600, 2);
    expect(totals.net).toBeCloseTo(9064.7, 2);

    const [period] = await owner.db.select().from(schema.payPeriod).where(eq(schema.payPeriod.id, batch.payPeriodId));
    expect(period.status).toBe('closed');
  });

  it('appends a payroll-history-import.completed domain event', async () => {
    const a = adminCtx(b);
    await hire(a, 'e1@hist.test');
    await commitPayrollHistoryImport(a, {
      companyId: b.companyId,
      records: parse([HEADER, validRow('e1@hist.test', '2024-06')].join('\n')),
    });
    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, b.companyId));
    const completed = events.filter((e) => e.eventType === 'payroll-history-import.completed');
    expect(completed).toHaveLength(1);
    const payload = completed[0].payload as { imported: number; periods: string[] };
    expect(payload.imported).toBe(1);
    expect(payload.periods).toContain('2024-06');
  });

  it('EA + monthly aggregation pick up the imported payslip without double-counting, with the EA breakdown', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'e1@hist.test');
    await setStatutoryProfileMY(a, { personId: (await empPersonId(employmentId)), icNumber: '900101015523' });
    // basic 5000, allowance 300, overtime 100, bonus 200 → gross 5600; ee ded = 616+24.75+9.90+200 = 850.65; net 4749.35
    const row =
      'e1@hist.test,2024-06,5000,5600,616.00,728.00,24.75,86.65,9.90,9.90,200.00,4749.35,300,100,200';
    await commitPayrollHistoryImport(a, { companyId: b.companyId, records: parse([HEADER, row].join('\n')) });

    // EA: gross/EPF/PCB + the per-component breakdown match the file.
    const ea = await eaStatement(a, { employmentId, year: '2024' });
    expect(ea).not.toBeNull();
    expect(ea!.partB.gross).toBeCloseTo(5600, 2);
    expect(ea!.partB.grossSalary).toBeCloseTo(5100, 2); // basic 5000 + overtime 100
    expect(ea!.partB.allowances).toBeCloseTo(300, 2);
    expect(ea!.partB.bonus).toBeCloseTo(200, 2);
    expect(ea!.partD.mtd).toBeCloseTo(200, 2);
    expect(ea!.partE.epf).toBeCloseTo(616, 2);

    // Monthly contributions for the imported month equal the file totals EXACTLY (no real batch coexists).
    const monthly = await contributions.generate(a, { companyId: b.companyId, periodKey: '2024-06' });
    const mine = monthly.rows[0];
    expect(Number(mine.gross)).toBeCloseTo(5600, 2);
    expect(Number(mine.epf)).toBeCloseTo(616 + 728, 2); // EE + ER
    expect(Number(mine.pcb)).toBeCloseTo(200, 2);
  });

  it('lp + zakat reach the EA accumulator (stored on the payslip + surfaced in EA Part D)', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire(a, 'e1@hist.test');
    await setStatutoryProfileMY(a, { personId: await empPersonId(employmentId), icNumber: '900202025524' });
    // gross 5300, net 4532.35 (same ee deductions), with lp=120 and zakat=80 in the optional columns.
    const explicit =
      'email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus,socso_skbbk,lp,zakat\n' +
      'e1@hist.test,2024-06,5000,5300,583.00,689.00,24.75,86.65,9.90,9.90,150.00,4532.35,300,0,0,0,120,80';
    await commitPayrollHistoryImport(a, { companyId: b.companyId, records: parse(explicit) });

    // Stored on the payslip statutory blob (the source coordinatedPcbForPerson reads for ∑LP).
    const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
    const st = slip.statutory as { lp: number; zakat: number };
    expect(st.lp).toBe(120);
    expect(st.zakat).toBe(80);

    // Zakat surfaces in EA Part D (the year's zakat-via-salary).
    const ea = await eaStatement(a, { employmentId, year: '2024' });
    expect(ea!.partD.zakat).toBeCloseTo(80, 2);
  });

  it('a non-admin commit is blocked at the DB layer (payroll_batch/payslip WITH CHECK = is_admin)', async () => {
    const a = adminCtx(b);
    const { personId } = await hire(a, 'e1@hist.test');
    const uid = await createAppUser(b.tenantId, personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId, roles: ['employee'] };

    // The per-period write is isolated in its own transaction, so RLS denial surfaces as a failed
    // period (not a thrown call) — but the crucial guarantee is the same: NOTHING is written.
    const r = await commitPayrollHistoryImport(empCtx, {
      companyId: b.companyId,
      records: parse([HEADER, validRow('e1@hist.test', '2024-06')].join('\n')),
    });
    expect(r.imported).toBe(0);
    expect(r.failed.length).toBeGreaterThan(0);

    // RLS denied every write: no pay_period, batch, or payslip persisted.
    expect(await owner.db.select().from(schema.payrollBatch)).toHaveLength(0);
    expect(await owner.db.select().from(schema.payslip)).toHaveLength(0);
    expect(await owner.db.select().from(schema.payPeriod)).toHaveLength(0);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

import { parseCsvRecords } from '../lib/csv';
function parse(csv: string) {
  return parseCsvRecords(csv).records;
}

async function empPersonId(employmentId: string): Promise<string> {
  const [e] = await owner.db
    .select({ personId: schema.employment.personId })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return e.personId;
}
