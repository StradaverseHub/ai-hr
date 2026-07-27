/**
 * ADR-0033 33-3 — Leave-in-lieu (TOIL) core. A worked rest-day's OT is banked as a REPLACEMENT-leave credit
 * instead of cash. The statutory boundary is the spine of these tests: a First-Schedule-eligible (≤ ceiling)
 * employee can only accrue when the company toggle is on, and then with forced convert-on-expiry; the same
 * worked day is cash XOR TOIL (the OT-pay prefill excludes a banked day).
 *
 * ADR-0077 slice 3: the whole-module gate is the per-tenant `toil` ENTITLEMENT, not the TOIL_ENABLED
 * deployment flag. Two consequences shape every test below:
 *   - The gate is exercised through `entitledCtx`, a snapshot resolved from this tenant's ROWS.
 *     `adminCtx` carries a SYNTHETIC snapshot derived from `legacyEnabledModulesIn(process.env)` (the
 *     same helper `seedBase` uses); no tracked env file sets TOIL_ENABLED, so it reads `toil` OFF and a
 *     `setModule` grant reaches it only through the harness's in-memory mirror. `entitledCtx` needs no
 *     mirror — it re-reads the database, which is what makes it the right context for a gate test.
 *   - A missing `tenant_module` row IS disabled (C7). `toil` is not in the parity set, so `seedBase`
 *     seeds no row for it; the OFF test still says so explicitly rather than relying on that.
 * The cash-XOR-TOIL exclusion in the OT prefill is deliberately NOT gated (see core/payroll.ts F15).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { createBatch, generatePayslips, prefillOvertimeFromAttendance } from '../core/payroll';
import { createPolicy } from '../core/payroll-policy';
import { disburseNetAcrossCycles } from '../core/payroll-policy-config';
import { ModuleNotEnabledError, isModuleEnabled } from '../core/entitlements';
import {
  accrueToil,
  runToilExpiry,
  setToilPolicy,
  ToilAlreadyAccruedError,
  ToilDisabledError,
  ToilNotEligibleError,
  type ToilPolicyInput,
} from '../core/toil';

let b: Base;
const REST_DAY = '2026-07-04'; // a Saturday; setRestDay makes it a rostered rest day regardless
/** One cut-off cycle of a weekly/bi-weekly run's disbursement schedule (payslip.statutory.paymentSchedule). */
type Cycle = { seq: number; from: string; to: string; amount: number };
const uniqEmail = () => `toil_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

/** Hire at a given basic wage and work a full rostered rest day ⇒ dayType rest_day, otMinutes 480. */
async function hireWithWorkedRestDay(basic: number) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Lieu Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
  await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' }); // 540 span − 60 break = 480 OT
  return { a, employmentId: e.employmentId };
}

/**
 * The same fixture over SEVERAL rostered rest days, for the cross-cycle test below — a weekly run only
 * shows a per-cycle difference when the OT lands in more than one cycle.
 */
async function hireWithWorkedRestDays(basic: number, dates: readonly string[]) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Lieu Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  for (const d of dates) {
    await setRestDay(a, { employmentId: e.employmentId, shiftDate: d });
    await checkIn(a, { employmentId: e.employmentId, date: d, time: '08:00:00' });
    await checkOut(a, { employmentId: e.employmentId, date: d, time: '17:00:00' }); // 480 OT minutes each
  }
  return { a, employmentId: e.employmentId };
}

async function replacementBalance(employmentId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
}
const accrualRow = async (employmentId: string) =>
  (await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, employmentId)))[0];

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

/** Turn the `toil` module on for this tenant and resolve a REAL (non-exempt) snapshot that sees it. */
async function toilOnCtx() {
  await setModule(b.tenantId, 'toil', 'active');
  return entitledCtx(b);
}

describe('TOIL core (ADR-0033 33-3)', () => {
  it('is gated: accrueToil refuses when the tenant has no `toil` entitlement', async () => {
    const { employmentId } = await hireWithWorkedRestDay(5000);
    // The policy is written WHILE ENTITLED and the module is revoked afterwards — i.e. the tenant that
    // configured TOIL and then lost it (trial end, downgrade), which is the only way this state arises
    // now that `setToilPolicy` is itself module-gated. It used to be written through the ungated path,
    // which is the hole review r2 found: an unentitled tenant could configure a billable module.
    // What the test asserts is unchanged — an ENABLED company policy plus no entitlement must still
    // refuse, so the refusal provably comes from the module gate and not the company toggle.
    const entitled = await toilOnCtx();
    await setToilPolicy(entitled, policy(b.companyId)); // company policy row exists AND is enabled…
    await setModule(b.tenantId, 'toil', null); // …but the entitlement is gone (no row = disabled)
    // Through a REAL snapshot resolved after the revoke — a snapshot is point-in-time.
    const gated = await entitledCtx(b);
    expect(isModuleEnabled(gated, 'toil'), 'the fixture must really be revoked, or this proves nothing').toBe(false);
    await expect(accrueToil(gated, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(
      ToilDisabledError,
    );
  });

  it('setToilPolicy itself refuses without the entitlement — configuring a module you did not buy', async () => {
    // The other half of the same gate, and the one that was missing. `accrueToil` and
    // `maybeAutoAccrueOnApprovalTx` were gated; `setToilPolicy` was the one exported TOIL entry point
    // that was not, so a tenant with no `toil` row could still tick "enabled", pick an accrual basis
    // and allow First-Schedule staff — all written and audited. No capability leaked (both accrual
    // paths still refused), but every field here is FROZEN onto each accrual at accrual time, so the
    // settings would take effect verbatim the day the module was bought.
    const unentitled = await entitledCtx(b); // seedBase seeds NO toil row — not in the parity set
    expect(isModuleEnabled(unentitled, 'toil')).toBe(false);
    await expect(setToilPolicy(unentitled, policy(b.companyId))).rejects.toBeInstanceOf(ModuleNotEnabledError);
    // …and nothing was written: the refusal is before the upsert, not a rollback of a partial one.
    const rows = await owner.db
      .select({ id: schema.toilPolicy.id })
      .from(schema.toilPolicy)
      .where(eq(schema.toilPolicy.companyId, b.companyId));
    expect(rows.length, 'a refused call must leave no policy row behind').toBe(0);
    // The wind-down surfaces stay open — this gate is about NEW accrual, not about settling banked days.
    await expect(runToilExpiry(unentitled, { today: '2026-12-31' })).resolves.toBeDefined();
  });

  it('banks 1.0 day (hours_worked) for a non-First-Schedule employee (> ceiling) — no warning', async () => {
    const ctx = await toilOnCtx();
    const { a, employmentId } = await hireWithWorkedRestDay(5000); // > RM4,000 ⇒ not eligible ⇒ TOIL free
    await setToilPolicy(a, policy(b.companyId));
    const r = await accrueToil(ctx, { employmentId, workedDate: REST_DAY });
    expect(r.daysCredited).toBe(1); // 480 / 480
    expect(r.forcedConvertOnExpiry).toBe(false);
    expect(r.complianceWarning).toBeUndefined();
    expect(await replacementBalance(employmentId)).toBe(1);
    const acc = await accrualRow(employmentId);
    expect(acc.status).toBe('active');
    expect(acc.dayType).toBe('rest_day');
    expect(acc.expiresOn).toBe('2026-10-02'); // REST_DAY + 90d
  });

  it('refuses a First-Schedule employee (≤ ceiling) when the toggle is OFF', async () => {
    const ctx = await toilOnCtx(); // module entitled — the refusal below must come from the COMPANY toggle
    const { a, employmentId } = await hireWithWorkedRestDay(3000); // ≤ RM4,000 ⇒ statutory OT applies
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: false }));
    await expect(accrueToil(ctx, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(
      ToilNotEligibleError,
    );
    expect(await replacementBalance(employmentId)).toBe(0);
  });

  it('allows the First-Schedule employee when the toggle is ON + per-election consent — forced convert + compliance warning', async () => {
    const ctx = await toilOnCtx();
    const { a, employmentId } = await hireWithWorkedRestDay(3000);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true }));
    // Phase-B #14: the toggle ON is no longer enough on its own — explicit per-election consent is required.
    const r = await accrueToil(ctx, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(r.daysCredited).toBe(1);
    expect(r.forcedConvertOnExpiry).toBe(true);
    expect(r.complianceWarning).toMatch(/convert to pay/i);
    expect(await replacementBalance(employmentId)).toBe(1);
  });

  it('premium_equivalent banks the uplifted time (rest_day ×2)', async () => {
    const ctx = await toilOnCtx();
    const { a, employmentId } = await hireWithWorkedRestDay(5000);
    await setToilPolicy(a, policy(b.companyId, { accrualBasis: 'premium_equivalent' }));
    const r = await accrueToil(ctx, { employmentId, workedDate: REST_DAY });
    expect(r.daysCredited).toBe(2); // 480 / 480 × 2.0
    expect(await replacementBalance(employmentId)).toBe(2);
  });

  it('refuses a second accrual for the same day', async () => {
    const ctx = await toilOnCtx();
    const { a, employmentId } = await hireWithWorkedRestDay(5000);
    await setToilPolicy(a, policy(b.companyId));
    await accrueToil(ctx, { employmentId, workedDate: REST_DAY });
    await expect(accrueToil(ctx, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(
      ToilAlreadyAccruedError,
    );
  });

  it('no double-pay: OT-pay prefill monetises an un-banked day but excludes a TOIL-banked one', async () => {
    const ctx = await toilOnCtx();
    // Two eligible employees, same company, both worked the same rest day. One banks it as TOIL.
    const A = await hireWithWorkedRestDay(3000); // not banked ⇒ cash OT
    const B = await hireWithWorkedRestDay(3000); // banked ⇒ excluded from cash OT
    await setToilPolicy(A.a, policy(b.companyId, { allowFirstScheduleEligible: true }));
    await accrueToil(ctx, { employmentId: B.employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    // One company-wide July batch covers both; only A's rest-day OT should be monetised.
    const { batchId } = await createBatch(A.a, { companyId: b.companyId, payPeriod: '2026-07' });
    expect((await prefillOvertimeFromAttendance(A.a, { batchId })).applied).toBe(1);
  });

  it('cash-XOR-TOIL survives REVOKING the module — the exclusion is not switchable', async () => {
    // THE DIRECTION SLICE 3 ACTUALLY CHANGED, and until now the one with no test at all.
    //
    // `excludeToilDays` (core/payroll.ts) used to live INSIDE the TOIL_ENABLED branch, so turning the
    // gate off re-monetised a day that had already been banked as leave — paid as cash AND held as a
    // replacement-leave credit, for the same worked day. Slice 3 made the clause UNCONDITIONAL, which
    // is the slice's headline correctness fix.
    //
    // Every other prefill test in the suite drives a context that HAS the module (the case above calls
    // `toilOnCtx()` first, and the harness mirrors that grant into adminCtx's snapshot), so restoring
    // the gate would not have turned a single test red. This one revokes the entitlement between the
    // banking and the prefill, which is exactly the commercial event — trial end, downgrade — that used
    // to double-pay.
    const ctx = await toilOnCtx();
    const A = await hireWithWorkedRestDay(3000); // never banked ⇒ must still be monetised
    const B = await hireWithWorkedRestDay(3000); // banked ⇒ must stay excluded, module or no module
    await setToilPolicy(A.a, policy(b.companyId, { allowFirstScheduleEligible: true }));
    await accrueToil(ctx, { employmentId: B.employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(await replacementBalance(B.employmentId)).toBe(1); // the credit is real and unspent

    // …now the tenant loses the module. A missing row is disabled (C7).
    await setModule(b.tenantId, 'toil', null);
    const revoked = await entitledCtx(b);
    expect(isModuleEnabled(revoked, 'toil'), 'the fixture must actually be revoked, or this proves nothing').toBe(
      false,
    );

    const { batchId } = await createBatch(revoked, { companyId: b.companyId, payPeriod: '2026-07' });
    expect(
      (await prefillOvertimeFromAttendance(revoked, { batchId })).applied,
      'only the UN-banked employee may be monetised — B was already compensated in leave',
    ).toBe(1);
    // …and name WHICH one, so a future change that swaps the two still fails.
    const inputs = await owner.db
      .select({ employmentId: schema.payrollInput.employmentId, overtime: schema.payrollInput.overtimeAmount })
      .from(schema.payrollInput)
      .where(eq(schema.payrollInput.batchId, batchId));
    expect(inputs.map((i) => i.employmentId)).toEqual([A.employmentId]);
    expect(Number(inputs[0].overtime), 'the un-banked rest day is paid at the statutory rest-day rate').toBeGreaterThan(0);
    // The banked credit is untouched: still leave, never converted to a second cash payment.
    expect(await replacementBalance(B.employmentId)).toBe(1);
  });

  it('the CROSS-CYCLE weighting excludes a banked day too — the two reads of attendance.otMinutes agree', async () => {
    // THE SECOND READ, which had no test and until review r2 had no exclusion either.
    //
    // `core/payroll.ts` reads `attendance.otMinutes` TWICE: the OT prefill (covered by the two tests
    // above) and — for a weekly/bi-weekly run only — the per-cycle bucketing that weights how the
    // month's NET is disbursed across cut-off cycles. Only the first carried EXCLUDE_TOIL_BANKED_DAYS,
    // so the two reads of the same column disagreed about which days count: a TOIL-banked day
    // contributed nothing to the OT total but still pulled the employee's take-home toward the cycle it
    // fell in, on the strength of minutes that were never paid as cash. Monthly runs skip the block
    // entirely, which is why it stayed invisible.
    //
    // Weekly, because `perCycle` requires `runFrequency !== 'monthly'` AND more than one period.
    const ctx = await toilOnCtx();
    const { id: weeklyPolicyId } = await createPolicy(adminCtx(b), {
      companyId: b.companyId,
      name: 'Weekly',
      policyType: 'monthly',
      config: { frequency: 'weekly' },
    });
    await owner.db
      .insert(schema.companyPayrollConfig)
      .values({ tenantId: b.tenantId, companyId: b.companyId, defaultPayrollPolicyId: weeklyPolicyId });

    // Two worked rest days in DIFFERENT weeks of July 2026, one banked and one paid as cash. Both are
    // needed: with the OT in a single cycle the correct and the buggy weight vectors coincide.
    const BANKED = '2026-07-04'; // week 1
    const CASH = '2026-07-25'; //   week 4
    const { a, employmentId } = await hireWithWorkedRestDays(5000, [BANKED, CASH]); // > RM4,000 ⇒ TOIL free
    await setToilPolicy(a, policy(b.companyId));
    await accrueToil(ctx, { employmentId, workedDate: BANKED });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    expect((await prefillOvertimeFromAttendance(a, { batchId })).applied, 'only the cash day is monetised').toBe(1);
    await generatePayslips(a, { batchId });

    const [slip] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const sched = (slip.statutory as { paymentSchedule?: { frequency: string; cycles: Cycle[] } }).paymentSchedule;
    // Pin the MECHANISM: a monthly run emits no schedule at all, and this test would then assert nothing.
    expect(sched?.frequency, 'the run must really be weekly, or the per-cycle block never executed').toBe('weekly');
    const cycles = sched!.cycles;
    expect(cycles.length, 'weekly July ⇒ five cut-off cycles').toBeGreaterThan(1);
    const cycleOf = (d: string) => cycles.findIndex((c) => d >= c.from && d <= c.to);
    const bankedCycle = cycleOf(BANKED);
    const cashCycle = cycleOf(CASH);
    expect(bankedCycle, 'the banked day must fall in its own cycle').toBeGreaterThanOrEqual(0);
    expect(cashCycle, 'the two days must land in DIFFERENT cycles or the vectors coincide').not.toBe(bankedCycle);

    // ORACLE, not a hand-computed figure: replay the pure splitter with the OT vector the fixed query
    // produces and with the one the pre-fix query produced, then pin the actual amounts against the
    // first AND assert the second is a genuinely different answer. Without that second expectation this
    // test would pass identically if `disburseNetAcrossCycles` ignored `otMinutes` altogether.
    const zeros = cycles.map(() => 0);
    const args = {
      net: Number(slip.netPay),
      recurring: Number(slip.basicSalary) + Number(slip.allowance) + Number(slip.bonus),
      overtime: Number(slip.overtimePay),
      unpaid: 0, // no unpaid leave in this fixture
      cycleDays: cycles.map(
        (c) => Math.round((Date.parse(`${c.to}T00:00:00Z`) - Date.parse(`${c.from}T00:00:00Z`)) / 86_400_000) + 1,
      ),
      unpaidDays: zeros,
    };
    const otWithExclusion = zeros.map((_, i) => (i === cashCycle ? 480 : 0));
    const otWithoutExclusion = zeros.map((_, i) => (i === cashCycle || i === bankedCycle ? 480 : 0));
    const actual = cycles.map((c) => c.amount);
    expect(actual, 'the banked day must carry no OT weight').toEqual(
      disburseNetAcrossCycles({ ...args, otMinutes: otWithExclusion }),
    );
    expect(actual, 'and the pre-fix vector must be a DIFFERENT split, or this proves nothing').not.toEqual(
      disburseNetAcrossCycles({ ...args, otMinutes: otWithoutExclusion }),
    );
    // The credit is still leave — the day was compensated once, in lieu.
    expect(await replacementBalance(employmentId)).toBe(1);
  });
});
