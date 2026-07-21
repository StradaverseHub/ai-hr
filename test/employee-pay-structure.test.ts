/**
 * ADR-0078 (feedback 642ecc55, migration 0290) — Employee-specific Pay Mode + Payment Term + Rate on the
 * Basic Salary record. The five recorded decisions, pinned:
 *   a. Migration equivalence: the 0290 backfill (re-executed from the migration file) maps the old
 *      policy-driven structure onto compensation so the first payroll after the change matches the last
 *      one before it — for a monthly AND a daily employee (the daily case is where the rate source moved).
 *   b. The feature itself: two (three) employees on ONE policy with different pay modes compute
 *      differently — monthly proration, daily rate × eligible days, hourly rate × attendance hours.
 *   c. Statutory non-regression: basicSalary KEEPS its monthly-equivalent semantics — the TOIL
 *      First-Schedule wage gate reads it, never rate_amount (pinned in both directions).
 *   d. D4 period boundary: a mid-period pay-mode change is rejected; a boundary one is accepted; a
 *      mid-period AMOUNT change still day-weight-blends exactly as today (salaryIncrementProration).
 *   e. A dated daily→monthly conversion leaves the historical row's own settings untouched.
 *   f. D2 (NOT NULL, no policy fallback): reprocessing a run after the policy was edited yields the same
 *      figures — the engine reads compensation, not the mutable policy.
 *   g. The TYPED pay-component path pays a daily employee identically to the legacy join.
 *   h. CSV import round-trip carrying pay_mode / payment_term / rate_amount (+ dry-run rejection).
 *   i. Pre-flight blocks a custom_period employee BY NAME (readiness + advisory + fail-closed generate)
 *      and does not block an hourly one.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  compensationHistoryDetailed,
  effectivePayStructure,
  PayModePeriodBoundaryError,
  setCompensation,
  updateCompensation,
} from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, preProcessAdvisory, PreProcessBlockedError } from '../core/payroll';
import { assignPolicy, createPolicy, updatePolicy } from '../core/payroll-policy';
import { payrollReadiness } from '../core/payroll-readiness';
import { commitEmployeeImport, validateEmployeeImport } from '../core/import';
import { backfillEmploymentComponentsFromCompensation, seedPayComponentCatalog } from '../core/pay-components';
import { accrueToil, setToilPolicy, ToilNotEligibleError } from '../core/toil';
import { setRestDay } from '../core/roster';
import { checkIn, checkOut } from '../core/attendance';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let icSeq = 0;
const nextIc = () => `900101${String(140000 + icSeq++).padStart(6, '0')}`;
// May 2026: 31 calendar days, 21 Mon–Fri working days; the harness seeds NO holidays.
const PERIOD = '2026-05';
const ELIGIBLE_MAY_2026 = 21;

const hire = async (name: string, hiredOn = '2024-01-01') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `ps_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });

/** Hire + salary (+ optional structure) + statutory profile, ready for payroll generation. */
async function seedPayable(
  name: string,
  basicSalary: number,
  structure?: { payMode: string; rateAmount?: number },
  hiredOn = '2024-01-01',
) {
  const a = adminCtx(b);
  const e = await hire(name, hiredOn);
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary,
    monthlyAllowance: 0,
    effectiveFrom: hiredOn,
    ...(structure ?? {}),
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  return e;
}

const payslipOf = async (batchId: string, employmentId: string) => {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows.find((r) => r.employmentId === employmentId)!;
};

const openCompRow = async (employmentId: string) => {
  const rows = await owner.db
    .select()
    .from(schema.compensation)
    .where(and(eq(schema.compensation.employmentId, employmentId)));
  return rows.find((r) => r.validTo === null && r.supersededAt === null)!;
};

/** Seed one attendance row (worked minutes are what the hourly branch reads). */
async function att(employmentId: string, date: string, workedMinutes: number) {
  await owner.db.insert(schema.attendance).values({
    tenantId: b.tenantId,
    employmentId,
    attendanceDate: date,
    checkInAt: '09:00:00',
    checkOutAt: '17:00:00',
    status: 'present',
    dayType: 'workday',
    workedMinutes,
    otMinutes: 0,
  });
}

/** The 0290 backfill UPDATE, re-executed from the ACTUAL migration file (equivalence-tested, not copied). */
async function runMigrationBackfill() {
  const migrationSql = readFileSync(new URL('../db/migrations/0290_compensation_pay_mode_term.sql', import.meta.url), 'utf8');
  const stmt = migrationSql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .find((s) => s.includes('UPDATE compensation c SET'));
  if (!stmt) throw new Error('0290 backfill statement not found');
  await owner.db.execute(sql.raw(stmt));
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  icSeq = 0;
  delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  delete process.env.TOIL_ENABLED;
});
afterEach(() => {
  delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  delete process.env.TOIL_ENABLED;
});
afterAll(async () => {
  await closeAll();
});

describe('a/f — migration 0290 equivalence + no policy fallback', () => {
  it('(a) the backfill maps the resolved policy structure onto every row, and the first run after matches the pre-change formulas', async () => {
    const a = adminCtx(b);
    const rate = 300;
    // Pre-change world: a monthly employee, and a "daily" employee whose ONLY daily-ness was the assigned
    // daily policy (the old rate source). Their compensation rows carry the service defaults (monthly).
    const eMonthly = await seedPayable('MigMonthly', 5000);
    const eDaily = await seedPayable('MigDaily', 9999);
    const { id: dailyPol } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'MigDaily300',
      policyType: 'daily',
      payRule: { kind: 'per_day', rate },
    });
    await assignPolicy(a, { employmentId: eDaily.employmentId, policyId: dailyPol });
    // A company DEFAULT policy carrying a weekly frequency — the engine's runFrequency source, which is
    // where payment_term must backfill from (NOT the assigned policy).
    const { id: defPol } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'MigCompanyDefault',
      policyType: 'monthly',
      config: { frequency: 'weekly' },
    });
    await owner.db.insert(schema.companyPayrollConfig).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      defaultPayrollPolicyId: defPol,
    });

    await runMigrationBackfill();

    // The daily employee's row now carries the structure the OLD engine resolved from the policy…
    const dRow = await openCompRow(eDaily.employmentId);
    expect(dRow.payMode).toBe('daily');
    expect(Number(dRow.rateAmount)).toBe(rate);
    expect(dRow.paymentTerm).toBe('weekly'); // company default config frequency — what runFrequency read
    // …and the monthly employee (no assignment → company default MONTHLY policy) stays monthly, no rate.
    const mRow = await openCompRow(eMonthly.employmentId);
    expect(mRow.payMode).toBe('monthly');
    expect(mRow.rateAmount).toBeNull();
    expect(mRow.paymentTerm).toBe('weekly');

    // First payroll AFTER the change matches the pre-change formulas: daily = rate × eligible days
    // (byte-identical to the old policy branch, proven arithmetic: 300 × 21), monthly = full basic.
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [eMonthly.employmentId, eDaily.employmentId] },
    });
    await generatePayslips(a, { batchId });
    const dSlip = await payslipOf(batchId, eDaily.employmentId);
    expect(Number(dSlip.basicSalary)).toBeCloseTo(rate * ELIGIBLE_MAY_2026, 2); // 6300 — NOT 9999
    expect(Number(dSlip.daysWorked)).toBe(ELIGIBLE_MAY_2026);
    const mSlip = await payslipOf(batchId, eMonthly.employmentId);
    expect(Number(mSlip.basicSalary)).toBeCloseTo(5000, 2);
  });

  it('(f) reprocessing after the policy was edited yields the same figures — the engine reads compensation, not the policy', async () => {
    const a = adminCtx(b);
    const eDaily = await seedPayable('ReproDaily', 4000, { payMode: 'daily', rateAmount: 300 });
    const { id: pol } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'ReproPolicy',
      policyType: 'daily',
      payRule: { kind: 'per_day', rate: 300 },
    });
    await assignPolicy(a, { employmentId: eDaily.employmentId, policyId: pol });
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [eDaily.employmentId] },
    });
    await generatePayslips(a, { batchId });
    const before = await payslipOf(batchId, eDaily.employmentId);
    expect(Number(before.basicSalary)).toBeCloseTo(300 * ELIGIBLE_MAY_2026, 2);

    // Mutate the policy AFTER processing — the D2 hazard a nullable fallback would have resolved through.
    await updatePolicy(a, { id: pol, payRule: { kind: 'per_day', rate: 999 } });

    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [eDaily.employmentId] } });
    const after = await payslipOf(batchId, eDaily.employmentId);
    expect(after.basicSalary).toBe(before.basicSalary);
    expect(after.netPay).toBe(before.netPay);
    expect(after.statutory).toEqual(before.statutory);
  });
});

describe('b — one policy, mixed pay modes (the feature itself)', () => {
  it('monthly, daily and hourly employees on the SAME policy compute per their own structure', async () => {
    const a = adminCtx(b);
    const { id: shared } = await createPolicy(a, { companyId: b.companyId, name: 'SharedRules', policyType: 'monthly' });
    const eMonthly = await seedPayable('MixMonthly', 5000);
    const eDaily = await seedPayable('MixDaily', 4400, { payMode: 'daily', rateAmount: 200 });
    const eHourly = await seedPayable('MixHourly', 4000, { payMode: 'hourly', rateAmount: 20 });
    for (const e of [eMonthly, eDaily, eHourly]) {
      await assignPolicy(a, { employmentId: e.employmentId, policyId: shared });
    }
    // 16 worked hours for the hourly employee (2 × 8h days in the period).
    await att(eHourly.employmentId, '2026-05-05', 480);
    await att(eHourly.employmentId, '2026-05-06', 480);

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [eMonthly.employmentId, eDaily.employmentId, eHourly.employmentId] },
    });
    await generatePayslips(a, { batchId });

    expect(Number((await payslipOf(batchId, eMonthly.employmentId)).basicSalary)).toBeCloseTo(5000, 2);
    expect(Number((await payslipOf(batchId, eDaily.employmentId)).basicSalary)).toBeCloseTo(200 * ELIGIBLE_MAY_2026, 2); // 4200
    expect(Number((await payslipOf(batchId, eHourly.employmentId)).basicSalary)).toBeCloseTo(20 * 16, 2); // 320
  });
});

describe('c — statutory reads keep the MONTHLY basicSalary semantics', () => {
  it('the TOIL First-Schedule wage gate reads basicSalary, never rate_amount (pinned in both directions)', async () => {
    process.env.TOIL_ENABLED = 'true';
    const a = adminCtx(b);
    await setToilPolicy(a, {
      companyId: b.companyId,
      enabled: true,
      accrualBasis: 'hours_worked',
      expiryDays: 90,
      onExpiry: 'convert_to_pay',
      allowFirstScheduleEligible: false,
      autoAccrueOnApproval: false,
      carryForwardAtYearEnd: false,
    });
    const REST_DAY = '2026-07-04'; // a Saturday
    const workedRestDay = async (name: string, basic: number, rate: number) => {
      const e = await hire(name);
      await setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: basic,
        monthlyAllowance: 0,
        effectiveFrom: '2024-01-01',
        payMode: 'daily',
        rateAmount: rate,
      });
      await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
      await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
      await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' });
      return e.employmentId;
    };
    // Monthly-equivalent wage 4500 > RM4000 ceiling ⇒ NOT First-Schedule ⇒ accrual permitted. If the gate
    // wrongly read the DAILY rate (180 ≤ 4000 ⇒ eligible), the disabled toggle would reject this accrual.
    const above = await workedRestDay('ToilAbove', 4500, 180);
    await expect(accrueToil(a, { employmentId: above, workedDate: REST_DAY })).resolves.toMatchObject({
      accrualId: expect.any(String),
    });
    // And the mirror: wage 3500 ≤ ceiling ⇒ First-Schedule ⇒ blocked, even though the rate (4500) is above.
    const below = await workedRestDay('ToilBelow', 3500, 4500);
    await expect(accrueToil(a, { employmentId: below, workedDate: REST_DAY })).rejects.toBeInstanceOf(
      ToilNotEligibleError,
    );
  });
});

describe('d — D4 period-boundary rule (mode changes only; amounts keep mid-period behaviour)', () => {
  it('rejects a mid-period pay-mode change, accepts a boundary one, and leaves amount-only mid-period revisions blending as today', async () => {
    const a = adminCtx(b);
    const e = await seedPayable('BoundaryEmp', 3100);
    // Mid-month pay-mode change → rejected with the typed error.
    await expect(
      setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 3100,
        payMode: 'daily',
        rateAmount: 150,
        effectiveFrom: '2026-05-15',
      }),
    ).rejects.toBeInstanceOf(PayModePeriodBoundaryError);
    // Same change on a boundary → accepted.
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 3100,
      payMode: 'daily',
      rateAmount: 150,
      effectiveFrom: '2026-06-01',
    });
    expect((await effectivePayStructure(a, e.employmentId))?.payMode).toBe('daily');

    // Amount-only mid-period revision still day-weight-blends (1c salaryIncrementProration) exactly as
    // today: (3100 × 15 + 6200 × 16) / 31 = 4700 for an increment effective 2026-05-16.
    const e2 = await seedPayable('BlendEmp', 3100);
    const { id: blendPol } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'BlendPolicy',
      policyType: 'monthly',
      config: { salaryIncrementProration: true },
    });
    await assignPolicy(a, { employmentId: e2.employmentId, policyId: blendPol });
    await setCompensation(a, { employmentId: e2.employmentId, basicSalary: 6200, effectiveFrom: '2026-05-16' });
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [e2.employmentId] },
    });
    await generatePayslips(a, { batchId });
    expect(Number((await payslipOf(batchId, e2.employmentId)).basicSalary)).toBeCloseTo(4700, 2);
  });

  it('rejects an in-place pay-mode edit on a row whose period a processed run relied on', async () => {
    const a = adminCtx(b);
    const e = await seedPayable('EditGuard', 4000);
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [e.employmentId] },
    });
    await generatePayslips(a, { batchId }); // processed — the run relied on the open row
    const row = await openCompRow(e.employmentId);
    await expect(
      updateCompensation(a, {
        compensationId: row.id,
        employmentId: e.employmentId,
        payMode: 'daily',
        rateAmount: 100,
      }),
    ).rejects.toBeInstanceOf(PayModePeriodBoundaryError);
    // A structure-preserving edit (amount only) on the same row still works.
    await expect(
      updateCompensation(a, { compensationId: row.id, employmentId: e.employmentId, basicSalary: 4100 }),
    ).resolves.toMatchObject({ compensationId: row.id });
  });
});

describe('e — dated conversion keeps history intact', () => {
  it('daily → monthly on a boundary leaves the historical row with its own daily settings', async () => {
    const a = adminCtx(b);
    const e = await seedPayable('ConvertEmp', 4000, { payMode: 'daily', rateAmount: 180 });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 4200,
      payMode: 'monthly',
      rateAmount: null,
      effectiveFrom: '2026-06-01',
    });
    const rows = await compensationHistoryDetailed(a, e.employmentId);
    expect(rows).toHaveLength(2);
    // Open (newest-first row 0): monthly, no rate.
    expect(rows[0]).toMatchObject({ payMode: 'monthly', rateAmount: null, validFrom: '2026-06-01' });
    // Historical row keeps the settings in force at the time — the audit/history guarantee.
    expect(rows[1].payMode).toBe('daily');
    expect(Number(rows[1].rateAmount)).toBe(180);
    expect(rows[1].validTo).toBe('2026-06-01');
    // The effective helper reads the SAME open row the engine reads.
    expect(await effectivePayStructure(a, e.employmentId)).toEqual({
      payMode: 'monthly',
      paymentTerm: 'monthly',
      rateAmount: null,
    });
  });
});

describe('g — typed pay-component path pays a daily employee identically to the legacy join', () => {
  it('flag on (with BASIC backfilled) reproduces the legacy daily payslip byte-for-byte', async () => {
    const a = adminCtx(b);
    const e = await seedPayable('TypedDaily', 4600, { payMode: 'daily', rateAmount: 250 });
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [e.employmentId] },
    });
    await generatePayslips(a, { batchId });
    const legacy = await payslipOf(batchId, e.employmentId);
    expect(Number(legacy.basicSalary)).toBeCloseTo(250 * ELIGIBLE_MAY_2026, 2);

    // Reset to draft, back-fill typed components (BASIC mirrors the MONTHLY-equivalent 4600), flag on.
    await owner.db.delete(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    await owner.db.update(schema.payrollBatch).set({ status: 'draft' }).where(eq(schema.payrollBatch.id, batchId));
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await generatePayslips(a, { batchId });
    const typed = await payslipOf(batchId, e.employmentId);
    expect(typed.basicSalary).toBe(legacy.basicSalary);
    expect(typed.grossPay).toBe(legacy.grossPay);
    expect(typed.netPay).toBe(legacy.netPay);
    expect(typed.statutory).toEqual(legacy.statutory);
  });
});

describe('h — CSV import round-trip', () => {
  it('imports pay_mode / payment_term / rate_amount, and the dry run rejects daily-without-rate', async () => {
    const a = adminCtx(b);
    const record = {
      full_name: 'Import Daily',
      email: 'import.daily@t.local',
      department: 'Finance',
      hired_on: '2026-01-05',
      ic_number: nextIc(),
      basic_salary: '4200',
      pay_mode: 'daily',
      payment_term: 'weekly',
      rate_amount: '180',
    };
    const res = await commitEmployeeImport(a, { companyId: b.companyId, records: [record] });
    expect(res.imported).toBe(1);
    const [emp] = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .where(eq(schema.person.primaryEmail, 'import.daily@t.local'));
    const row = await openCompRow(emp.id);
    expect(row.payMode).toBe('daily');
    expect(row.paymentTerm).toBe('weekly');
    expect(Number(row.rateAmount)).toBe(180);
    expect(Number(row.basicSalary)).toBe(4200); // the monthly-equivalent stays its own figure

    // Dry run: a daily row with no rate fails validation (never reaches the service).
    const preview = await validateEmployeeImport(a, {
      companyId: b.companyId,
      records: [{ ...record, email: 'import.bad@t.local', ic_number: nextIc(), rate_amount: '' }],
    });
    expect(preview.validCount).toBe(0);
    expect(preview.rows[0].errors.join(' ')).toMatch(/rate_amount/);
  });
});

describe('i — pre-flight blocks custom_period (named), not hourly', () => {
  it('readiness names the employee, the advisory lists them, generation fails closed; an hourly employee passes', async () => {
    const a = adminCtx(b);
    const eCustom = await seedPayable('Custom Careem', 3000, { payMode: 'custom_period' });
    const eHourly = await seedPayable('Hourly Hana', 3000, { payMode: 'hourly', rateAmount: 20 });

    // Company-level readiness: the payModes check is a BLOCKER naming the custom_period employee.
    const readiness = await payrollReadiness(a, { companyId: b.companyId, payPeriod: PERIOD });
    const payModes = readiness.checks.find((c) => c.key === 'payModes')!;
    expect(payModes.status).toBe('blocker');
    expect(payModes.detail.unpayable).toBe(1);
    expect(payModes.names).toEqual(['Custom Careem']);
    expect(readiness.ready).toBe(false);

    // Per-batch advisory names them too, and generation fails closed BEFORE any write.
    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: PERIOD,
      scope: { employmentIds: [eCustom.employmentId, eHourly.employmentId] },
    });
    const advisory = await preProcessAdvisory(a, batchId);
    expect(advisory.unpayablePayMode?.map((r) => r.name)).toEqual(['Custom Careem']);
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);

    // Hourly alone is NOT blocked — per_hour is a real calculation now that the rate is per-employee.
    // (A different period: the blocked draft above still occupies PERIOD for this company.)
    const { batchId: okBatch } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-06',
      scope: { employmentIds: [eHourly.employmentId] },
    });
    const okAdvisory = await preProcessAdvisory(a, okBatch);
    expect(okAdvisory.unpayablePayMode ?? []).toHaveLength(0);
    await generatePayslips(a, { batchId: okBatch });
    // No attendance rows ⇒ 0 worked hours ⇒ basic 0 — a real outcome, not an error.
    expect(Number((await payslipOf(okBatch, eHourly.employmentId)).basicSalary)).toBeCloseTo(0, 2);
  });
});

describe('service validation + events', () => {
  it('requires a positive rate for daily/hourly, carries the structure forward on amount-only revisions, and records fieldsChanged', async () => {
    const a = adminCtx(b);
    const e = await hire('CarryEmp');
    await expect(
      setCompensation(a, {
        employmentId: e.employmentId,
        basicSalary: 4000,
        payMode: 'daily',
        effectiveFrom: '2024-01-01',
      }),
    ).rejects.toThrow(/rate greater than zero/);
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 4000,
      payMode: 'daily',
      rateAmount: 180,
      paymentTerm: 'weekly',
      effectiveFrom: '2024-01-01',
    });
    // Amount-only revision (a merit-style raise) CARRIES the structure forward untouched — the
    // performance enact path relies on exactly this to never silently re-rate a daily employee.
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4400, effectiveFrom: '2026-06-01' });
    expect(await effectivePayStructure(a, e.employmentId)).toEqual({
      payMode: 'daily',
      paymentTerm: 'weekly',
      rateAmount: '180.00',
    });
    // PDPA redact-to-reference: the event payload carries field NAMES only — never the rate itself.
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'compensation.set')))
      .orderBy(schema.domainEvent.sequence);
    const payload = ev.payload as Record<string, unknown> & { fieldsChanged: string[] };
    expect(payload.fieldsChanged).toEqual(expect.arrayContaining(['payMode', 'paymentTerm', 'rateAmount']));
    expect(Object.keys(payload).sort()).toEqual(['effectiveFrom', 'employmentId', 'fieldsChanged']); // no values
  });
});
