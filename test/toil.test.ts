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
// 1cf5b37c — ModuleNotEnabledError left this import with setToilPolicy's entitlement gate; the accrual
// paths throw ToilDisabledError, which is what the inverted test asserts.
import { isModuleEnabled } from '../core/entitlements';
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
// 00307068: the expiry period is counted from the APPROVAL, not the worked day, so the approval instant is
// now an input to every accrual assertion and is injected like every other date in this suite. Two days
// after the rest day — a manager approving on the following Monday, which is the ordinary case.
const APPROVED_ON = new Date('2026-07-06T02:00:00.000Z');
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

  // ⚠️ 1cf5b37c INVERTED THIS TEST. It used to assert that setToilPolicy REFUSES without the `toil`
  // entitlement — a gate ADR-0077 slice 3 review r2 added on the argument that a customer should not
  // configure a module they had not bought. That gate is what made Leave Config → Replacement Leave
  // render every control disabled with no Save, which the reporter read as an unfinished placeholder.
  // The owner approved letting the screen be configured ahead of purchase.
  //
  // The SAFETY half of the original test is kept verbatim and is the reason this is not a regression:
  // configuring still cannot bank a single day, because both accrual paths carry their own gate. If
  // someone ever removes THOSE, this test fails and says why.
  it('setToilPolicy is allowed without the entitlement, and configuring still accrues nothing', async () => {
    const { employmentId } = await hireWithWorkedRestDay(5000); // a real worked rest day to try to bank
    const unentitled = await entitledCtx(b); // seedBase seeds NO toil row — not in the parity set
    expect(isModuleEnabled(unentitled, 'toil')).toBe(false);

    // The write is ALLOWED now, and it really writes.
    await setToilPolicy(unentitled, policy(b.companyId));
    const rows = await owner.db
      .select({ id: schema.toilPolicy.id, enabled: schema.toilPolicy.enabled })
      .from(schema.toilPolicy)
      .where(eq(schema.toilPolicy.companyId, b.companyId));
    expect(rows.length, 'the policy is stored so it is ready the day the add-on is bought').toBe(1);
    expect(rows[0].enabled, 'including the enabled flag — it is configuration, not a capability').toBe(true);

    // …and it is INERT. This is the assertion that makes the relaxation safe: an enabled company policy
    // plus no entitlement must still refuse to bank anything.
    await expect(accrueToil(unentitled, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(
      ToilDisabledError,
    );

    // The wind-down surfaces stay open, exactly as before — settling banked days was never gated.
    await expect(runToilExpiry(unentitled, { today: '2026-12-31' })).resolves.toBeDefined();
  });

  it('banks 1.0 day (hours_worked) for a non-First-Schedule employee (> ceiling) — no warning', async () => {
    const ctx = await toilOnCtx();
    const { a, employmentId } = await hireWithWorkedRestDay(5000); // > RM4,000 ⇒ not eligible ⇒ TOIL free
    await setToilPolicy(a, policy(b.companyId));
    const r = await accrueToil(ctx, { employmentId, workedDate: REST_DAY, approvedOn: APPROVED_ON });
    expect(r.daysCredited).toBe(1); // 480 / 480
    expect(r.forcedConvertOnExpiry).toBe(false);
    expect(r.complianceWarning).toBeUndefined();
    expect(await replacementBalance(employmentId)).toBe(1);
    const acc = await accrualRow(employmentId);
    expect(acc.status).toBe('active');
    expect(acc.dayType).toBe('rest_day');
    // 00307068 MOVED THIS ANCHOR, and this assertion is where the move is visible.
    //
    // It used to read `expect(acc.expiresOn).toBe('2026-10-02')` — REST_DAY + 90d, i.e. counted from the day
    // WORKED. The reporter's rule is that a credit's life starts when the line manager APPROVES it, and
    // reaching accrueToilTx is that approval on both paths. The election above ran on 2026-07-06 (injected,
    // like every other date in this suite), so the credit now runs to 2026-10-04 rather than 2026-10-02.
    expect(acc.expiresOn).toBe('2026-10-04');
    // The direction of the change is the guarantee that makes it safe: approval never precedes the work, so
    // a credit's life can only ever get LONGER. Nobody loses a day.
    expect(acc.expiresOn > '2026-10-02').toBe(true);
    // Both new dates are recorded. A roster election has NO employee request — a manager picks the worked
    // day directly — so the worked day is the only date in evidence for `requestedOn`.
    expect(acc.requestedOn).toBe(REST_DAY);
    expect(acc.approvedOn?.toISOString().slice(0, 10)).toBe('2026-07-06');
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

  it('KNOWN GAP: OT-then-TOIL pays the same day twice — the invariant is one-directional', async () => {
    // A CHARACTERIZATION TEST, NOT AN APPROVAL. It asserts what the code does today so the gap is a
    // fixture rather than a paragraph, and so closing it is a visible, deliberate edit to a named
    // assertion instead of a silent behaviour change nobody attributes.
    //
    // The two tests around this one cover TOIL-then-cash, which `EXCLUDE_TOIL_BANKED_DAYS` closes
    // unconditionally. The REVERSE ordering has no guard at all: prefill a rest day's OT into
    // `payroll_input`, then bank the same day as TOIL, and the employee is compensated twice for one
    // worked day — cash on the payslip AND a replacement-leave credit. `accrueTx` reads neither
    // `payroll_input` nor `payslip`, and `maybeAutoAccrueOnApprovalTx` (core/attendance.ts) fires on
    // approval of an attendance correction, which routinely lands after a draft batch is prefilled.
    //
    // WHY IT IS SLICE 3'S PROBLEM even though the code is older: both accrual entry points used to open
    // with `if (!toilEnabled()) throw`, and TOIL_ENABLED is set in no tracked env file — so no accrual
    // could exist and this sequence was unreachable on every deployment. A per-tenant entitlement makes
    // it reachable for the first customer who buys the module. Migration 0314's header makes exactly
    // this argument about the payroll-partner read gap.
    //
    // WHY THE MIRROR GUARD IS NOT ONE LINE: `payroll_input.overtime_amount` is a single per-(batch,
    // employment) aggregate with no per-day attribution, so "does an OT row exist for this employment?"
    // cannot distinguish this rest day from any other overtime in the cycle and would refuse almost
    // every legitimate accrual. Payroll's exclusion works only because `toil_accrual` IS per-day.
    // Closing this is an ADR-0033 question about draft-batch state — see core/toil.ts's duplicate check.
    const ctx = await toilOnCtx();
    const { a, employmentId } = await hireWithWorkedRestDay(3000);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true }));

    // 1 · CASH FIRST. Nothing is banked yet, so the rest day is monetised into the draft batch.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    expect((await prefillOvertimeFromAttendance(a, { batchId })).applied).toBe(1);
    const [paid] = await owner.db
      .select({ overtime: schema.payrollInput.overtimeAmount })
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
    expect(Number(paid.overtime), 'the rest day must actually be in the batch as cash').toBeGreaterThan(0);

    // 2 · THEN BANK THE SAME DAY. This SHOULD refuse and does not.
    const r = await accrueToil(ctx, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(r.daysCredited).toBe(1);

    // 3 · THE DOUBLE COMPENSATION, stated as the fact it is: the cash is still in the batch AND the
    //     leave credit exists. When this gap is closed, step 2 will throw and THIS is the assertion to
    //     rewrite — deliberately, with the ADR-0033 decision recorded.
    const [stillPaid] = await owner.db
      .select({ overtime: schema.payrollInput.overtimeAmount })
      .from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
    expect(
      Number(stillPaid.overtime),
      'KNOWN GAP: banking TOIL does not retract the cash already prefilled for the same worked day',
    ).toBe(Number(paid.overtime));
    expect(
      await replacementBalance(employmentId),
      'KNOWN GAP: …and the leave credit is held on top of that cash, for one worked day',
    ).toBe(1);
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
    //
    // RM3,000 — BELOW the RM4,000 statutory OT wage ceiling, and this test CANNOT WORK above it.
    //
    // The first version hired at 5,000 with the note "> RM4,000 ⇒ TOIL free", choosing that figure to
    // skip the First-Schedule consent machinery. But `overtimePay` returns `eligible: false` above the
    // ceiling, so nothing was monetised at all: `prefillOvertimeFromAttendance` reported
    // `applied: 0, ineligible: 1` and the `toBe(1)` below failed outright. The oracle underneath needs
    // real OT cash for a second reason — it feeds `overtime: Number(slip.overtimePay)` into
    // `disburseNetAcrossCycles`, and with that at zero the "with exclusion" and "without exclusion"
    // vectors produce the SAME split, so the assertion that they differ could never hold either.
    //
    // Under the ceiling the employee IS First-Schedule eligible, so banking in lieu needs the policy
    // opt-in and recorded per-election consent (ADR-0033 / Phase-B #14). That is the more honest
    // fixture anyway: a day banked as leave and then also weighted as cash hurts precisely the employee
    // whose overtime pay is statutory.
    const { a, employmentId } = await hireWithWorkedRestDays(3000, [BANKED, CASH]);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true, onExpiry: 'convert_to_pay' }));
    await accrueToil(ctx, { employmentId, workedDate: BANKED, firstScheduleConsent: true });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    // `ineligible: 0` as well, so this cannot pass again by the employee simply being out of scope.
    expect(
      await prefillOvertimeFromAttendance(a, { batchId }),
      'only the cash day is monetised — the banked one is excluded, not merely ineligible',
    ).toMatchObject({ applied: 1, ineligible: 0 });
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
