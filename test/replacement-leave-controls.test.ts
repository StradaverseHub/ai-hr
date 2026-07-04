/**
 * RL Control & Validation Engine (0113). Builds on the TOIL engine (ADR-0033):
 *  - consumption → register: approving a REPLACEMENT leave request decrements toil_accrual FIFO-by-expiry
 *    (partial via days_taken; full via status='taken' + takenByRequestId);
 *  - eligibility hardening: only rest_day/holiday OT is bankable; a plain workday is refused;
 *  - auto-accrual on attendance approval: opt-in, fired ONLY by decideAttendanceCorrection, no self-grant throw;
 *  - active-vs-expired ledger read reconciles to the netted leaveBalances figure;
 *  - year-end rollover: expire-unless-configured, frozen carry-forward, idempotent close marker, ORP owed event;
 *  - payroll interaction: a converted day is not also paid as cash OT.
 * Gated by TOIL_ENABLED. today/asOf are injected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { createBatch, prefillOvertimeFromAttendance } from '../core/payroll';
import { requestLeave, decideLeave } from '../core/leave';
import { replacementLeaveLedger } from '../core/read';
import {
  accrueToil,
  closeReplacementLeaveYear,
  runToilExpiry,
  setToilPolicy,
  ToilDisabledError,
  ToilNotEligibleError,
  type ToilPolicyInput,
} from '../core/toil';

let b: Base;
const REST_DAY = '2026-07-04'; // Saturday; setRestDay makes it a rostered rest day regardless
const WORKDAY = '2026-07-06'; // a Monday workday
const uniqEmail = () => `rlc_${Math.random().toString(36).slice(2)}@t.local`;

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

async function hire(basic: number, hiredOn = '2024-01-01') {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'RL Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: hiredOn });
  return { a, employmentId: e.employmentId };
}

/** Hire, work a rostered rest day (480 OT), and bank the TOIL. Returns the accrual id (1.0 day for ≥1 over). */
async function accrueRestDay(basic: number, over: Partial<ToilPolicyInput> = {}) {
  const { a, employmentId } = await hire(basic);
  await setToilPolicy(a, policy(b.companyId, over));
  await setRestDay(a, { employmentId, shiftDate: REST_DAY });
  await checkIn(a, { employmentId, date: REST_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId, date: REST_DAY, time: '17:00:00' }); // 540 − 60 break = 480 OT
  const r = await accrueToil(a, { employmentId, workedDate: REST_DAY });
  return { a, employmentId, accrualId: r.accrualId };
}

async function replacementTypeId(): Promise<string> {
  const [row] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.code, 'REPLACEMENT'));
  return row.id;
}
async function replacementBalance(employmentId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
}
const accrualRow = async (accrualId: string) =>
  (await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id, accrualId)))[0];

/** Approve a REPLACEMENT leave request consuming `days` working-days starting at `start`. */
async function takeReplacement(employmentId: string, start: string, end: string) {
  const a = adminCtx(b);
  const typeId = await replacementTypeId();
  const req = await requestLeave(a, { employmentId, leaveTypeId: typeId, startDate: start, endDate: end });
  await decideLeave(a, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
  return req.leaveRequestId;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  process.env.TOIL_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.TOIL_ENABLED;
});

describe('RL consumption → register (step 0)', () => {
  it('flips the FIFO-oldest accrual to taken + sets takenByRequestId, and reconciles the active read', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000); // 1.0 day banked
    expect(await replacementBalance(employmentId)).toBe(1);

    const reqId = await takeReplacement(employmentId, WORKDAY, WORKDAY); // a 1.0 working-day request
    const acc = await accrualRow(accrualId);
    expect(acc.status).toBe('taken');
    expect(acc.takenByRequestId).toBe(reqId);
    expect(Number(acc.daysTaken)).toBe(1);

    const led = await replacementLeaveLedger(adminCtx(b), employmentId);
    expect(led.active).toBe(0); // fully consumed
    expect(led.taken).toBe(1);
    expect(await replacementBalance(employmentId)).toBe(0); // ledger debit + accrual taken net to 0
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.consumed');
  });

  it('partial consumption increments days_taken and leaves the boundary accrual active', async () => {
    // Bank 2.0 days (premium_equivalent rest_day ×2), then take 1.0 day.
    const { employmentId, accrualId } = await accrueRestDay(5000, { accrualBasis: 'premium_equivalent' });
    expect(await replacementBalance(employmentId)).toBe(2);

    await takeReplacement(employmentId, WORKDAY, WORKDAY); // 1.0 working-day
    const acc = await accrualRow(accrualId);
    expect(acc.status).toBe('active'); // boundary accrual stays active
    expect(Number(acc.daysTaken)).toBe(1);

    const led = await replacementLeaveLedger(adminCtx(b), employmentId);
    expect(led.active).toBe(1); // 2 credited − 1 taken
    expect(led.taken).toBe(1);
    expect(await replacementBalance(employmentId)).toBe(1);
  });
});

describe('Eligibility hardening (step 1)', () => {
  it('rejects banking a plain workday OT (only rest_day / holiday allowed)', async () => {
    const { a, employmentId } = await hire(5000);
    await setToilPolicy(a, policy(b.companyId));
    // Work a plain workday with OT (no setRestDay) ⇒ dayType workday.
    await checkIn(a, { employmentId, date: WORKDAY, time: '08:00:00' });
    await checkOut(a, { employmentId, date: WORKDAY, time: '20:00:00' }); // long day ⇒ workday OT
    await expect(accrueToil(a, { employmentId, workedDate: WORKDAY })).rejects.toBeInstanceOf(ToilNotEligibleError);
    expect(await replacementBalance(employmentId)).toBe(0);
  });

  it('accepts a rest day', async () => {
    const { employmentId } = await accrueRestDay(5000);
    expect(await replacementBalance(employmentId)).toBe(1);
  });
});

describe('Auto-accrual on attendance approval (step 2)', () => {
  /** Raise + approve a rest-day correction; returns the employment id. */
  async function approveRestDayCorrection(over: Partial<ToilPolicyInput> = {}) {
    const { a, employmentId } = await hire(5000);
    await setToilPolicy(a, policy(b.companyId, over));
    await setRestDay(a, { employmentId, shiftDate: REST_DAY });
    const cor = await requestAttendanceCorrection(a, {
      employmentId,
      date: REST_DAY,
      checkIn: '08:00:00',
      checkOut: '17:00:00',
      reason: 'Correction',
    });
    await decideAttendanceCorrection(a, { correctionId: cor.correctionId, decision: 'approved' });
    return employmentId;
  }

  it('mints exactly one credit when the toggle is ON, linked to the worked rest day; idempotent re-approve does not double-bank', async () => {
    const employmentId = await approveRestDayCorrection({ autoAccrueOnApproval: true });
    expect(await replacementBalance(employmentId)).toBe(1);
    const accs = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, employmentId));
    expect(accs.length).toBe(1);
    expect(accs[0].dayType).toBe('rest_day');
    expect(accs[0].workedDate).toBe(REST_DAY);
    const payload = await latestEventPayload(b.tenantId, accs[0].id, 'toil.accrued');
    expect(payload?.viaAutoApproval).toBe(true);

    // Re-approve the same day via a fresh correction: the no-double-bank guard is swallowed (no throw, no dup).
    const a = adminCtx(b);
    const cor2 = await requestAttendanceCorrection(a, { employmentId, date: REST_DAY, checkIn: '08:00:00', checkOut: '17:00:00', reason: 'Correction' });
    await expect(decideAttendanceCorrection(a, { correctionId: cor2.correctionId, decision: 'approved' })).resolves.toMatchObject({ status: 'approved' });
    expect(await replacementBalance(employmentId)).toBe(1); // still one credit
  });

  it('mints nothing when the toggle is OFF', async () => {
    const employmentId = await approveRestDayCorrection({ autoAccrueOnApproval: false });
    expect(await replacementBalance(employmentId)).toBe(0);
  });

  it('skips silently (no self-grant throw) for a First-Schedule-ineligible employee without blocking the approval', async () => {
    // ≤ ceiling + toggle off on allowFirstScheduleEligible ⇒ accrueToilTx would throw ToilNotEligibleError;
    // the auto path swallows it, so the approval still succeeds and no credit is minted.
    const { a, employmentId } = await hire(3000);
    await setToilPolicy(a, policy(b.companyId, { autoAccrueOnApproval: true, allowFirstScheduleEligible: false }));
    await setRestDay(a, { employmentId, shiftDate: REST_DAY });
    const cor = await requestAttendanceCorrection(a, { employmentId, date: REST_DAY, checkIn: '08:00:00', checkOut: '17:00:00', reason: 'Correction' });
    await expect(decideAttendanceCorrection(a, { correctionId: cor.correctionId, decision: 'approved' })).resolves.toMatchObject({ status: 'approved' });
    expect(await replacementBalance(employmentId)).toBe(0);
  });

  it('plain check-in/out mints nothing (no correction approval to hook)', async () => {
    const { a, employmentId } = await hire(5000);
    await setToilPolicy(a, policy(b.companyId, { autoAccrueOnApproval: true }));
    await setRestDay(a, { employmentId, shiftDate: REST_DAY });
    await checkIn(a, { employmentId, date: REST_DAY, time: '08:00:00' });
    await checkOut(a, { employmentId, date: REST_DAY, time: '17:00:00' });
    expect(await replacementBalance(employmentId)).toBe(0);
  });
});

describe('Active-vs-expired read (step 3)', () => {
  it('after a natural-expiry sweep, active shrinks and converted grows; net balance matches', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { onExpiry: 'convert_to_pay' });
    let led = await replacementLeaveLedger(adminCtx(b), employmentId);
    expect(led.active).toBe(1);
    expect(led.soonestExpiry).toBe('2026-10-02'); // REST_DAY + 90d

    await runToilExpiry(adminCtx(b), { today: '2026-10-15' });
    led = await replacementLeaveLedger(adminCtx(b), employmentId);
    expect(led.active).toBe(0);
    expect(led.convertedToPay).toBe(1);
    expect(await replacementBalance(employmentId)).toBe(0);
    expect((await accrualRow(accrualId)).status).toBe('converted_to_pay');
  });
});

describe('Year-end rollover (step 4)', () => {
  it('expires the active remainder at the calendar boundary, follows frozen expiryAction, surfaces one ORP-owed event', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { onExpiry: 'convert_to_pay' });
    const r = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(r.alreadyClosed).toBe(false);
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0, carriedForward: 0 });
    expect(await replacementBalance(employmentId)).toBe(0); // ledger zeroed
    expect((await accrualRow(accrualId)).status).toBe('converted_to_pay');
    const conv = await latestEventPayload(b.tenantId, accrualId, 'toil.converted');
    expect(conv?.asOf).toBe('2026-12-31');
    expect(conv?.amountOwed).toBe(192.31); // 1 day × (5000 / 26)
  });

  it('lapses when the frozen action is lapse', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { onExpiry: 'lapse' });
    const r = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(r).toMatchObject({ converted: 0, lapsed: 1 });
    expect((await accrualRow(accrualId)).status).toBe('lapsed');
    expect(await replacementBalance(employmentId)).toBe(0);
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.lapsed');
  });

  it('carry-forward-true accruals survive the close', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { carryForwardAtYearEnd: true });
    const r = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(r).toMatchObject({ processed: 0, carriedForward: 1 });
    expect((await accrualRow(accrualId)).status).toBe('active');
    expect(await replacementBalance(employmentId)).toBe(1); // untouched
  });

  it('only sweeps the still-active remainder of a partially-taken accrual', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { accrualBasis: 'premium_equivalent', onExpiry: 'convert_to_pay' }); // 2.0 days
    await takeReplacement(employmentId, WORKDAY, WORKDAY); // consume 1.0 ⇒ days_taken 1, active 1
    const r = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(r).toMatchObject({ processed: 1, converted: 1 });
    expect(await replacementBalance(employmentId)).toBe(0); // 2 credited − 1 taken − 1 converted = 0 (no double-debit)
    const conv = await latestEventPayload(b.tenantId, accrualId, 'toil.converted');
    expect(conv?.daysCredited).toBe(1); // only the remainder was forfeited
  });

  it('re-run is a true no-op via the closed-marker guard, not just absence of active rows', async () => {
    const { employmentId } = await accrueRestDay(5000, { carryForwardAtYearEnd: true }); // survives, so an active row remains
    const first = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(first.alreadyClosed).toBe(false);
    const second = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(second.alreadyClosed).toBe(true); // marker guard fires even though an active (carried) row exists
    expect(second.processed).toBe(0);
    expect(await replacementBalance(employmentId)).toBe(1); // carried row still intact
  });

  it('anniversary tenant: closes at the employee cycle boundary', async () => {
    await owner.db.update(schema.company).set({ leaveCycle: 'anniversary' }).where(eq(schema.company.id, b.companyId));
    const { employmentId, accrualId } = await accrueRestDay(5000, { onExpiry: 'lapse' });
    const r = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(r).toMatchObject({ processed: 1, lapsed: 1 });
    expect((await accrualRow(accrualId)).status).toBe('lapsed');
    expect(await replacementBalance(employmentId)).toBe(0);
  });
});

describe('Frozen carry-forward (step 8)', () => {
  it('flipping the policy mid-year does not change the fate of an already-banked accrual', async () => {
    const { a, employmentId, accrualId } = await accrueRestDay(5000, { carryForwardAtYearEnd: true });
    // Banked with carry-forward true. Now flip the POLICY to false.
    await setToilPolicy(a, policy(b.companyId, { carryForwardAtYearEnd: false }));
    const r = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    // The accrual's FROZEN flag was true, so it still survives despite the live policy now being false.
    expect(r.carriedForward).toBe(1);
    expect((await accrualRow(accrualId)).status).toBe('active');
    expect(await replacementBalance(employmentId)).toBe(1);
  });
});

describe('Payroll interaction (step 6)', () => {
  it('a year-close converted day is NOT also paid as cash OT, and exactly one ORP-owed event exists', async () => {
    const { a, employmentId, accrualId } = await accrueRestDay(5000, { onExpiry: 'convert_to_pay' });
    await closeReplacementLeaveYear(a, { asOf: '2026-12-31' });
    // The accrual is converted_to_pay (<> 'lapsed'), so the OT-cash prefill must still exclude the worked day.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    expect((await prefillOvertimeFromAttendance(a, { batchId })).applied).toBe(0);
    const converted = (await eventTypesFor(b.tenantId, accrualId)).filter((t) => t === 'toil.converted');
    expect(converted.length).toBe(1);
    expect(employmentId).toBeTruthy();
  });
});

describe('Coordination (step 7)', () => {
  it('runToilExpiry then closeReplacementLeaveYear: no double-debit, ledger still nets to 0', async () => {
    const { employmentId } = await accrueRestDay(5000, { onExpiry: 'lapse' });
    await runToilExpiry(adminCtx(b), { today: '2026-10-15' }); // natural expiry sweeps it
    expect(await replacementBalance(employmentId)).toBe(0);
    const close = await closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' });
    expect(close.processed).toBe(0); // nothing active left ⇒ no second debit
    expect(await replacementBalance(employmentId)).toBe(0);
  });
});

describe('Gate (step 9)', () => {
  it('closeReplacementLeaveYear refuses when TOIL_ENABLED is unset', async () => {
    await accrueRestDay(5000);
    delete process.env.TOIL_ENABLED;
    await expect(closeReplacementLeaveYear(adminCtx(b), { asOf: '2026-12-31' })).rejects.toBeInstanceOf(ToilDisabledError);
  });
});
