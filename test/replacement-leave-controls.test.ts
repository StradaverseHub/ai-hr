/**
 * RL Control & Validation Engine (0113). Builds on the TOIL engine (ADR-0033):
 *  - consumption → register: approving a REPLACEMENT leave request decrements toil_accrual FIFO-by-expiry
 *    (partial via days_taken; full via status='taken' + takenByRequestId);
 *  - eligibility hardening: only rest_day/holiday OT is bankable; a plain workday is refused;
 *  - auto-accrual on attendance approval: opt-in, fired ONLY by decideAttendanceCorrection, no self-grant throw;
 *  - active-vs-expired ledger read reconciles to the netted leaveBalances figure;
 *  - year-end rollover: expire-unless-configured, frozen carry-forward, idempotent close marker, ORP owed event;
 *  - payroll interaction: a converted day is not also paid as cash OT.
 * Gated by the `toil` MODULE ENTITLEMENT (ADR-0077 slice 3 — no longer the TOIL_ENABLED env flag).
 * today/asOf are injected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayInKualaLumpur } from '../lib/hr-date';
import { and, eq, sql } from 'drizzle-orm';

// ── 20e759a0: the three Next primitives setToilPolicyAction needs, and nothing else ─────────────────
// The action itself runs FOR REAL against this file's database; only `redirect`, `revalidatePath` and
// `getSession` are stubbed, so the URL asserted below is the one the action actually builds.
//
// `redirect` THROWS, the way Next's does. A stub that merely records and returns would let the action
// fall out of its own `catch` and issue a SECOND redirect — the error-path assertion would then be
// reading the success URL and would pass no matter what the catch did. That is the exact
// "passes for the wrong reason" shape, so the throw is load-bearing rather than cosmetic.
const { redirectMock, revalidateMock, sessionHolder } = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string): never => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url}` });
  }),
  revalidateMock: vi.fn((_path: string) => undefined),
  sessionHolder: { s: null as unknown },
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock, notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: revalidateMock, revalidateTag: vi.fn(() => undefined) }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => sessionHolder.s) }));

import * as schema from '../db/schema';
import {
  closeAll,
  entitledCtx,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { createBatch, prefillOvertimeFromAttendance } from '../core/payroll';
import { requestLeave, decideLeave } from '../core/leave';
import { replacementLeaveLedger } from '../core/read';
import {
  accrueToil,
  addMonths,
  closeReplacementLeaveYear,
  listToilPolicies,
  runToilExpiry,
  setToilPolicy,
  ToilNotEligibleError,
  ToilSweepForbiddenError,
  type ToilPolicyInput,
} from '../core/toil';
// 296fc027 — the as-of eligibility resolver. The pure matcher is exercised directly (it is a rule, not a
// query) and the dated resolver against a real assignment history.
import {
  matchesReplacementEligibility,
  resolveEligibilityFactsTx,
  type ReplacementEligibilityFacts,
} from '../core/replacement-eligibility';
import { isModuleEnabled } from '../core/entitlements';
// 20e759a0 — the page-level company filter: the resolver the page reads `?company=` with, and the save
// action whose redirects have to carry that selection back.
import { ALL_COMPANIES, resolveCompanyFilter } from '../lib/company-filter';
import { setToilPolicyAction } from '../app/admin/actions';

let b: Base;
/**
 * THE ADMIN CONTEXT THIS FILE RUNS ON — a REAL resolved snapshot, not `adminCtx`.
 *
 * `adminCtx` is no longer entitlements-exempt: it carries `harnessSnapshot`, whose `enabledModules` is
 * `legacyEnabledModulesIn(process.env)`. `toil` is NOT in `LEGACY_ENABLED_MODULE_CODES` (it was an env
 * flag, TOIL_ENABLED, and is now a sellable module), so an `adminCtx` snapshot reports toil DISABLED no
 * matter what rows the tenant has — every gated entry point in core/toil.ts (`accrueToil`,
 * `runToilExpiry`, `closeReplacementLeaveYear`, and the `maybeAutoAccrueOnApprovalTx` hook, which
 * returns false rather than throwing) would refuse. Writing the row and then driving the call through a
 * context that cannot see it is exactly the "passes for the wrong reason" shape in reverse.
 *
 * `entitledCtx` resolves this tenant's actual rows, so it agrees with the `setModule` below. It is
 * otherwise identical to `adminCtx` for this file: same userId, same `hr_admin` role, and the same
 * module/setting set, because `seedBase` inserts precisely `legacyEnabledModulesIn(process.env)` /
 * `legacyEnabledSettingsIn(process.env)` — the two halves harnessSnapshot is derived from. The only
 * difference is the `toil` row, which is the point.
 */
let ctx: SessionContext;
const REST_DAY = '2026-07-04'; // Saturday; setRestDay makes it a rostered rest day regardless
const WORKDAY = '2026-07-06'; // a Monday workday
// 00307068: the expiry period is counted from the line manager's APPROVAL rather than the day worked, so
// the approval instant is now an input to every accrual and is injected like every other date here. Two
// days after the rest day — a manager approving on the following Monday.
const APPROVED_ON = new Date('2026-07-06T02:00:00.000Z');
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
  const a = ctx; // the entitled admin snapshot resolved in beforeEach — see the note on `ctx`
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
  const r = await accrueToil(a, { employmentId, workedDate: REST_DAY, approvedOn: APPROVED_ON });
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
  const a = ctx;
  const typeId = await replacementTypeId();
  // consumeReplacementLeaveTx (the approval-side register decrement) is deliberately NOT module-gated —
  // you cannot un-bank what was banked — so this path does not depend on `ctx` carrying `toil`.
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
  // TOIL is a per-tenant entitlement now. seedBase seeds NO `toil` row (it is not in the parity set), so
  // this file has to grant it explicitly — the row, not an env var, is what a real session resolves.
  // toil's `dependsOn` closure is satisfied: `leave` is CORE (always on) and `attendance` is seeded
  // active by seedBase (no env gate), so an ACTIVE row genuinely resolves ON for a non-exempt context
  // rather than recording a paid-but-inert entitlement; the `Gate (step 9)` block proves it both ways.
  await setModule(b.tenantId, 'toil', 'active');
  // Resolved AFTER the grant — the snapshot is point-in-time, exactly as it is for a real session.
  ctx = await entitledCtx(b);
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

    const led = await replacementLeaveLedger(ctx, employmentId);
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

    const led = await replacementLeaveLedger(ctx, employmentId);
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
    const a = ctx;
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
    let led = await replacementLeaveLedger(ctx, employmentId);
    expect(led.active).toBe(1);
    expect(led.soonestExpiry).toBe('2026-10-04'); // 00307068: APPROVED_ON + 90d (was REST_DAY + 90d)

    await runToilExpiry(ctx, { today: '2026-10-15' });
    led = await replacementLeaveLedger(ctx, employmentId);
    expect(led.active).toBe(0);
    expect(led.convertedToPay).toBe(1);
    expect(await replacementBalance(employmentId)).toBe(0);
    expect((await accrualRow(accrualId)).status).toBe('converted_to_pay');
  });
});

/**
 * 00307068 — the two dates a credit has never recorded, and the expiry anchor that now depends on one of
 * them. These are the columns the employee's Replacement Leave table shows; before this item they could not
 * be built from anything stored, which is why this needed a migration and not a screen change.
 */
describe('Request / approval dates on a banked credit (00307068)', () => {
  it('a ROSTER election records the approval instant and, having no employee request, the worked day', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000);
    const acc = await accrualRow(accrualId);
    expect(acc.approvedOn?.toISOString()).toBe(APPROVED_ON.toISOString());
    // There is no employee request on this path at all — a manager picks the worked day off the roster —
    // so the worked day is the only date in evidence. Inventing a "requested on" nobody typed would be a
    // fabrication on a screen the employee reads.
    expect(acc.requestedOn).toBe(REST_DAY);
    // The expiry now runs from the approval, which is why it is 2026-10-04 and not 2026-10-02.
    expect(acc.expiresOn).toBe('2026-10-04');

    // …and all three reach the read the employee panel is built on.
    const led = await replacementLeaveLedger(ctx, employmentId);
    expect(led.rows).toHaveLength(1);
    expect(led.rows[0]).toMatchObject({
      requestedOn: REST_DAY,
      expiresOn: '2026-10-04',
      otMinutes: 480,
      daysCredited: 1,
      status: 'active',
    });
    expect(led.rows[0].approvedOn).toBe(APPROVED_ON.toISOString());
    // The type's labelling unit rides along so the Number column can read in the unit HR named.
    expect(led.leaveUnit).toBe('day');
  });

  it('the AUTO path records the employee’s own request date — the attendance correction they filed', async () => {
    const { a, employmentId } = await hire(5000);
    await setToilPolicy(a, policy(b.companyId, { autoAccrueOnApproval: true }));
    await setRestDay(a, { employmentId, shiftDate: REST_DAY });
    const cor = await requestAttendanceCorrection(a, {
      employmentId,
      date: REST_DAY,
      checkIn: '08:00:00',
      checkOut: '17:00:00',
      reason: 'Correction',
    });
    await decideAttendanceCorrection(a, { correctionId: cor.correctionId, decision: 'approved' });

    const [acc] = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, employmentId));
    // On THIS path the employee really did ask, and the correction IS the request — so its own creation
    // date is the request date, not the worked-day fallback the roster path has to use.
    //
    // THE ORDERING TRAP THIS PINS. decideAttendanceCorrection calls the accrual hook BEFORE it flips the
    // correction's status to 'approved', so an implementation that looked the correction up by
    // status='approved' would find nothing and silently fall back to the worked date. The correction here
    // is deliberately created on a DIFFERENT day from the worked date, so that fallback would fail this
    // assertion instead of passing by coincidence.
    const [corrRow] = await owner.db
      .select({ createdAt: schema.attendanceCorrection.createdAt })
      .from(schema.attendanceCorrection)
      .where(eq(schema.attendanceCorrection.id, cor.correctionId));
    // ⚠️ THE KUALA LUMPUR DATE ON BOTH SIDES (r324). This derived the expected day with
    // `.toISOString()` — a UTC date from an instant, which CLAUDE.md §8 forbids "fixtures included" —
    // while the code resolves it in KL. The two agree for sixteen hours a day and disagree between
    // midnight and 08:00 MYT, so this file passed every run that did not start in that window.
    const requestDay = todayInKualaLumpur(corrRow.createdAt);
    expect(acc.requestedOn).toBe(requestDay);
    expect(acc.requestedOn).not.toBe(REST_DAY); // …and it is NOT the worked-day fallback
    expect(acc.approvedOn).not.toBeNull();
    // Approval is the anchor here too: the credit expires 90 days from the decision, never from the work.
    // Same correction here: the ANCHOR is the KL date of the approval, because that is what
    // `resolveExpiry` is given (core/toil.ts, `approvedOnDate`). Ninety days from it is then plain
    // calendar arithmetic on a date string, which carries no timezone at all.
    const approvedDay = todayInKualaLumpur(acc.approvedOn!);
    expect(acc.expiresOn).toBe(
      new Date(Date.parse(`${approvedDay}T00:00:00Z`) + 90 * 86_400_000).toISOString().slice(0, 10),
    );
  });

  it('the anchor move can only LENGTHEN a credit’s life, never shorten it', async () => {
    // The property the whole change rests on, asserted rather than argued: approval is always on or after
    // the day worked, so approval + period is always on or after worked + period.
    const { accrualId } = await accrueRestDay(5000);
    const acc = await accrualRow(accrualId);
    const underOldRule = new Date(Date.parse(`${REST_DAY}T00:00:00Z`) + 90 * 86_400_000).toISOString().slice(0, 10);
    expect(acc.expiresOn >= underOldRule).toBe(true);
  });
});

/**
 * 296fc027 · THE EXPIRY PERIOD BECOMES A NUMBER PLUS A UNIT.
 *
 * Three columns now carry the period (`expiryUnit` + `expiryDays` + `expiryMonths`) and exactly one
 * function reads all three (`resolveExpiry`). The risk this block exists for is not the happy path — it is
 * that somebody later writes `addDays(grant, policy.expiryDays)` again and turns a 3-MONTH policy into a
 * 3-DAY one, which looks plausible in a diff and is catastrophic in production.
 */
describe('Expiry period: number + unit (296fc027)', () => {
  it('addMonths adds CALENDAR months, not 30-day blocks', () => {
    expect(addMonths('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonths('2026-01-15', 3)).toBe('2026-04-15');
    // 30-day arithmetic would give 2026-04-15 + drift here; calendar addition lands on the same day.
    expect(addMonths('2026-07-04', 6)).toBe('2027-01-04');
  });

  it('crosses a YEAR boundary correctly', () => {
    expect(addMonths('2026-11-30', 2)).toBe('2027-01-30');
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31');
  });

  it('CLAMPS into a short target month instead of rolling forward into the next one', () => {
    // The case every naive implementation gets wrong. JavaScript's own Date.setUTCMonth rolls 31 Jan + 1
    // month FORWARD to 2/3 March, which would silently LENGTHEN the expiry period for anybody approved on
    // the 29th–31st. Clamping to the last day of the target month is the only convention that keeps a
    // "1 month" period inside one month.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-30', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
    // …and the clamp is leap-year aware, because the month length is computed rather than tabulated.
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('a MONTHS policy expires a real credit by calendar months from the APPROVAL date', async () => {
    // The integration half: not just that addMonths is right, but that the policy columns reach it. The
    // approval lands 2026-07-06, so a 3-month period must resolve to 2026-10-06 — and NOT 2026-07-09,
    // which is what re-reading `expiryDays` (90) as days would produce.
    const { accrualId } = await accrueRestDay(5000, { expiryUnit: 'months', expiryMonths: 3 });
    const acc = await accrualRow(accrualId);
    expect(acc.expiresOn).toBe('2026-10-06');
  });

  it('a MONTHS policy crossing into a SHORT month clamps the stored expiry', async () => {
    // Approval on 31 December, one month: the frozen expiry must be 31 January, and a January approval
    // plus one month must clamp to the end of February rather than spilling into March.
    const { a, employmentId } = await hire(5000);
    await setToilPolicy(a, policy(b.companyId, { expiryUnit: 'months', expiryMonths: 1 }));
    await setRestDay(a, { employmentId, shiftDate: '2026-01-31' });
    await checkIn(a, { employmentId, date: '2026-01-31', time: '08:00:00' });
    await checkOut(a, { employmentId, date: '2026-01-31', time: '17:00:00' });
    const r = await accrueToil(a, {
      employmentId,
      workedDate: '2026-01-31',
      approvedOn: new Date('2026-01-31T02:00:00.000Z'),
    });
    expect(r.expiresOn).toBe('2026-02-28');
    expect((await accrualRow(r.accrualId)).expiresOn).toBe('2026-02-28');
  });

  it('the DAYS unit is byte-identical to the pre-296fc027 behaviour', async () => {
    // Every existing policy row lands on expiryUnit='days' via the column default, so this is the
    // regression that matters most: the new columns must change nothing for anyone who never touches them.
    const { accrualId } = await accrueRestDay(5000); // policy() sets no unit ⇒ the default
    expect((await accrualRow(accrualId)).expiresOn).toBe('2026-10-04'); // approval 2026-07-06 + 90 days
  });

  it('BOTH counts survive a unit flip, so switching back does not lose the other one', async () => {
    const { a } = await hire(5000);
    await setToilPolicy(a, policy(b.companyId, { expiryUnit: 'months', expiryMonths: 6, expiryDays: 45 }));
    const [saved] = await listToilPolicies(a, [b.companyId]);
    expect(saved.expiryUnit).toBe('months');
    expect(saved.expiryMonths).toBe(6);
    expect(saved.expiryDays).toBe(45); // still there, untouched, ready if the unit flips back
  });

  it('rejects an out-of-range months count with its OWN bound, not the days one', async () => {
    const { a } = await hire(5000);
    // 500 would pass a 1..730 check. Months get 1..24 — the same horizon 730 days expresses.
    await expect(setToilPolicy(a, policy(b.companyId, { expiryUnit: 'months', expiryMonths: 500 }))).rejects.toThrow(
      /between 1 and 24/i,
    );
  });
});

/**
 * 296fc027 · WHO MAY SUBMIT — the AS-OF eligibility resolver.
 *
 * The four criteria core/leave-org-criteria.ts documents as DEFERRED (department, position, employment
 * type, grade) are the whole reason this resolver exists: they are not plain text columns on `employment`,
 * they come off the effective-dated `assignment` row. The tests that matter are therefore the DATED ones —
 * an employee judged against the assignment they held on the day asked about, not today's row.
 */
describe('Replacement-leave request eligibility (296fc027)', () => {
  const facts = (over: Partial<ReplacementEligibilityFacts> = {}): ReplacementEligibilityFacts => ({
    employmentId: 'emp-1',
    companyId: 'co-1',
    employmentType: 'full_time',
    departmentId: 'dept-a',
    positionId: 'pos-1',
    gradeId: 'grade-1',
    division: 'North',
    employmentCategory: 'Executive',
    ...over,
  });

  it('nothing selected anywhere ⇒ EVERYONE may submit', () => {
    expect(matchesReplacementEligibility(null, facts())).toBe(true);
    expect(matchesReplacementEligibility({}, facts())).toBe(true);
    // An all-empty-lists object is the same statement as an absent one — the form posts this shape.
    expect(matchesReplacementEligibility({ departmentIds: [], gradeIds: [] }, facts())).toBe(true);
  });

  it('AND across criteria, OR within one', () => {
    const elig = { departmentIds: ['dept-a', 'dept-b'], employmentTypes: ['full_time'] };
    expect(matchesReplacementEligibility(elig, facts())).toBe(true);
    expect(matchesReplacementEligibility(elig, facts({ departmentId: 'dept-b' }))).toBe(true);
    expect(matchesReplacementEligibility(elig, facts({ departmentId: 'dept-z' }))).toBe(false);
    // …and one criterion failing is enough, even when the other matches.
    expect(matchesReplacementEligibility(elig, facts({ employmentType: 'intern' }))).toBe(false);
  });

  it('a NULL fact is refused by a criterion that names a value, never admitted by accident', () => {
    // An employee with no assignment as of the date has departmentId null. That must FAIL a department
    // criterion rather than slipping through a loose comparison.
    expect(matchesReplacementEligibility({ departmentIds: ['dept-a'] }, facts({ departmentId: null }))).toBe(false);
    expect(matchesReplacementEligibility({ gradeIds: ['grade-1'] }, facts({ gradeId: null }))).toBe(false);
  });

  it('named individuals WIDEN the set rather than narrowing it', () => {
    // The rule the plan did not settle. "Engineering, and also Aisha" must admit Aisha even though she is
    // in Sales — AND-ing the two would silently exclude the person the admin went out of their way to name.
    const elig = { departmentIds: ['dept-a'], employmentIds: ['emp-9'] };
    expect(matchesReplacementEligibility(elig, facts({ employmentId: 'emp-9', departmentId: 'sales' }))).toBe(true);
    expect(matchesReplacementEligibility(elig, facts({ employmentId: 'emp-1', departmentId: 'dept-a' }))).toBe(true);
    expect(matchesReplacementEligibility(elig, facts({ employmentId: 'emp-1', departmentId: 'sales' }))).toBe(false);
  });

  it('an INDIVIDUALS-ONLY configuration does not collapse into "everyone"', () => {
    // The trap in the union rule: with all seven org lists empty, "matches every set criterion" is
    // vacuously TRUE, so a naive union would admit the whole company the moment anybody is named.
    const elig = { employmentIds: ['emp-9'] };
    expect(matchesReplacementEligibility(elig, facts({ employmentId: 'emp-9' }))).toBe(true);
    expect(matchesReplacementEligibility(elig, facts({ employmentId: 'emp-1' }))).toBe(false);
  });

  it('resolves the assignment row valid AS OF the date, not the latest one', async () => {
    // The reason this resolver exists at all. The employee starts in deptA and transfers to deptB; a
    // question asked about a date BEFORE the transfer must see deptA.
    const { a, employmentId } = await hire(5000, '2024-01-01');
    // Close the original assignment and open a new one — the CLOSE+INSERT shape the table is built for.
    await owner.db
      .update(schema.assignment)
      .set({ validTo: '2026-06-30' })
      .where(and(eq(schema.assignment.employmentId, employmentId), sql`${schema.assignment.validTo} is null`));
    await owner.db.insert(schema.assignment).values({
      tenantId: b.tenantId,
      employmentId,
      departmentId: b.deptB,
      employmentType: 'contract',
      validFrom: '2026-07-01',
    });

    const before = await withTenant(a, (tx) => resolveEligibilityFactsTx(tx, employmentId, '2026-06-15'));
    expect(before?.departmentId).toBe(b.deptA);
    expect(before?.employmentType).toBe('full_time');

    const after = await withTenant(a, (tx) => resolveEligibilityFactsTx(tx, employmentId, '2026-07-15'));
    expect(after?.departmentId).toBe(b.deptB);
    expect(after?.employmentType).toBe('contract');
  });

  it('an employee with no assignment covering the date resolves to NULL facts, not to nothing', async () => {
    // A gap in the history must produce a row with null org facts (so a criterion refuses them), never an
    // absent row — which at the call site is indistinguishable from "no such employee".
    const { a, employmentId } = await hire(5000, '2024-01-01');
    const facts = await withTenant(a, (tx) => resolveEligibilityFactsTx(tx, employmentId, '2020-01-01'));
    expect(facts).not.toBeNull();
    expect(facts!.departmentId).toBeNull();
    expect(facts!.companyId).toBe(b.companyId); // the employment-level fact is still there
  });

  it('the criteria round-trip through the policy column, normalised', async () => {
    const { a } = await hire(5000);
    await setToilPolicy(
      a,
      policy(b.companyId, {
        // Blanks and duplicates are what the form actually posts when a picker is cleared.
        requestEligibility: { departmentIds: [b.deptA, b.deptA, ''], gradeIds: [], employmentTypes: ['full_time'] },
      }),
    );
    const [saved] = await listToilPolicies(a, [b.companyId]);
    expect(saved.requestEligibility).toEqual({ departmentIds: [b.deptA], employmentTypes: ['full_time'] });
  });

  it('an all-empty criteria object stores as NULL, so "no restriction" has ONE representation', async () => {
    const { a } = await hire(5000);
    await setToilPolicy(a, policy(b.companyId, { requestEligibility: { departmentIds: [], employmentIds: [''] } }));
    const [saved] = await listToilPolicies(a, [b.companyId]);
    expect(saved.requestEligibility).toBeNull();
  });
});

describe('Year-end rollover (step 4)', () => {
  it('expires the active remainder at the calendar boundary, follows frozen expiryAction, surfaces one ORP-owed event', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { onExpiry: 'convert_to_pay' });
    const r = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
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
    const r = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(r).toMatchObject({ converted: 0, lapsed: 1 });
    expect((await accrualRow(accrualId)).status).toBe('lapsed');
    expect(await replacementBalance(employmentId)).toBe(0);
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.lapsed');
  });

  it('carry-forward-true accruals survive the close', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { carryForwardAtYearEnd: true });
    const r = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(r).toMatchObject({ processed: 0, carriedForward: 1 });
    expect((await accrualRow(accrualId)).status).toBe('active');
    expect(await replacementBalance(employmentId)).toBe(1); // untouched
  });

  it('only sweeps the still-active remainder of a partially-taken accrual', async () => {
    const { employmentId, accrualId } = await accrueRestDay(5000, { accrualBasis: 'premium_equivalent', onExpiry: 'convert_to_pay' }); // 2.0 days
    await takeReplacement(employmentId, WORKDAY, WORKDAY); // consume 1.0 ⇒ days_taken 1, active 1
    const r = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(r).toMatchObject({ processed: 1, converted: 1 });
    expect(await replacementBalance(employmentId)).toBe(0); // 2 credited − 1 taken − 1 converted = 0 (no double-debit)
    const conv = await latestEventPayload(b.tenantId, accrualId, 'toil.converted');
    expect(conv?.daysCredited).toBe(1); // only the remainder was forfeited
  });

  it('re-run is a true no-op via the closed-marker guard, not just absence of active rows', async () => {
    const { employmentId } = await accrueRestDay(5000, { carryForwardAtYearEnd: true }); // survives, so an active row remains
    const first = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(first.alreadyClosed).toBe(false);
    const second = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(second.alreadyClosed).toBe(true); // marker guard fires even though an active (carried) row exists
    expect(second.processed).toBe(0);
    expect(await replacementBalance(employmentId)).toBe(1); // carried row still intact
  });

  it('anniversary tenant: closes at the employee cycle boundary', async () => {
    await owner.db.update(schema.company).set({ leaveCycle: 'anniversary' }).where(eq(schema.company.id, b.companyId));
    const { employmentId, accrualId } = await accrueRestDay(5000, { onExpiry: 'lapse' });
    const r = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
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
    const r = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
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
    await runToilExpiry(ctx, { today: '2026-10-15' }); // natural expiry sweeps it
    expect(await replacementBalance(employmentId)).toBe(0);
    const close = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(close.processed).toBe(0); // nothing active left ⇒ no second debit
    expect(await replacementBalance(employmentId)).toBe(0);
  });
});

describe('Gate (step 9)', () => {
  // Both directions are asserted, on the SAME call with the SAME fixture, so the refusal cannot be
  // passing for some unrelated reason: the only difference between the two tests is whether the
  // `tenant_module` row exists. Each re-resolves its own snapshot rather than reusing the file-level
  // `ctx`, because a snapshot is point-in-time — a revoke written after it was resolved is not in it.
  it('closeReplacementLeaveYear still settles banked days when the `toil` entitlement is gone', async () => {
    // INVERTED IN SLICE 3, and this is the second copy of the same wrong requirement (the first was in
    // test/toil-expiry.test.ts). Both asserted that revoking the module makes the year-end close REFUSE.
    // Both were built carefully — note the original setup deliberately banked a row first "so there IS
    // an active row an open gate would sweep", which is exactly the right instinct — and both passed
    // honestly. They just pinned the wrong behaviour.
    //
    // The year-end close discharges an EA First Schedule obligation: an eligible employee's unused TOIL
    // converts to pay and may never lapse. The entitlement governs whether a tenant may BANK new days,
    // not whether days already banked ever get paid. Refusing here meant a lapsed trial or a downgrade
    // froze a debt the employee had already earned — and app/admin/toil/page.tsx hides the button that
    // calls this, so there was no surface left to settle it through.
    const { employmentId, accrualId } = await accrueRestDay(5000); // banked while entitled
    expect(await replacementBalance(employmentId)).toBe(1);
    await setModule(b.tenantId, 'toil', null); // delete the row — a missing row IS disabled (C7)
    const revoked = await entitledCtx(b); // snapshot resolved AFTER the revoke
    expect(isModuleEnabled(revoked, 'toil'), 'the fixture must really be disabled, or this proves nothing').toBe(false);

    // ASSERTED ON THE SETTLED AMOUNT, not on `processed`. `processed` is `converted + lapsed`, so a run
    // that took the LAPSE arm — forfeiting the day, which is the exact statutory harm this test exists
    // to forbid — increments it and satisfies a count-only assertion. The file's default policy is
    // `onExpiry: 'convert_to_pay'` (see `policy` above), so every figure here is deterministic.
    const r = await closeReplacementLeaveYear(revoked, { asOf: '2026-12-31' });
    expect(r.alreadyClosed).toBe(false);
    expect(r, 'the banked day must be CONVERTED, not merely swept').toMatchObject({
      processed: 1,
      converted: 1,
      lapsed: 0,
      convertedDays: 1,
      carriedForward: 0,
    });
    expect(r.convertedAmount, '1 day × (5000 / 26) — the ORP owed').toBe(192.31);
    expect((await accrualRow(accrualId)).status).toBe('converted_to_pay');
    expect(await replacementBalance(employmentId), 'the leave credit is discharged, not left dangling').toBe(0);
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.converted');
  });

  it('and admits the same call when the tenant IS entitled', async () => {
    // ASSERTED ON THE SETTLED AMOUNT here too, for the reason its twin above states: `processed` is
    // `converted + lapsed`, so a run that FORFEITED the day would satisfy a count-only check. This is
    // the control half of the pair — the two tests differ only in whether the `tenant_module` row
    // exists, so if the entitled case is not pinned to the same figures the comparison proves nothing
    // about the entitlement and only that the sweep ran.
    const { employmentId, accrualId } = await accrueRestDay(5000);
    const granted = await entitledCtx(b); // `toil` active (beforeEach) + `attendance` active (seedBase)
    const r = await closeReplacementLeaveYear(granted, { asOf: '2026-12-31' });
    expect(r.alreadyClosed).toBe(false);
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0, convertedDays: 1, carriedForward: 0 });
    expect(r.convertedAmount, '1 day × (5000 / 26) — identical to the unentitled case, which is the point').toBe(192.31);
    expect((await accrualRow(accrualId)).status).toBe('converted_to_pay');
    expect(await replacementBalance(employmentId)).toBe(0);
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.converted');
  });
});

describe('Authorization on the two statutory sweeps (ADR-0077 slice 3 review)', () => {
  /**
   * WHY THESE EXIST. Slice 3 deleted `if (!toilEnabled()) throw new ToilDisabledError()` from
   * `runToilExpiry` and `closeReplacementLeaveYear` — correctly, because a lapsed entitlement must not
   * strand a settlement the employer already owes. But that line was ALSO the only check on the path:
   * `app/admin/actions.ts` exports both as server actions that called plain `getSession()`, and since
   * TOIL_ENABLED is set in no tracked env file the gate had been refusing everyone on every deployment,
   * so nothing else was ever needed. Ungating it without replacing it left two mutating statutory
   * sweeps behind a bare authenticated session, one of which writes a marker that `domain_event`
   * REVOKEs UPDATE/DELETE on.
   */
  const memberCtx = async (): Promise<SessionContext> => ({
    ...(await entitledCtx(b, ['employee'])),
  });

  it('an ordinary member cannot run runToilExpiry', async () => {
    await accrueRestDay(5000, { expiryDays: 1 });
    await expect(runToilExpiry(await memberCtx(), { today: '2027-01-01' })).rejects.toBeInstanceOf(
      ToilSweepForbiddenError,
    );
  });

  it('an ordinary member cannot close the replacement-leave year, and writes no marker doing so', async () => {
    const { employmentId } = await accrueRestDay(5000);
    await expect(closeReplacementLeaveYear(await memberCtx(), { asOf: '2026-12-31' })).rejects.toBeInstanceOf(
      ToilSweepForbiddenError,
    );
    // The refusal has to leave NOTHING behind. A marker written by a caller whose RLS view swept zero
    // accruals is the whole harm: the boundary would read as closed for everyone afterwards.
    const markers = await owner.db
      .select({ id: schema.domainEvent.id })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.eventType, 'replacement-leave-year.closed'),
        ),
      );
    expect(markers.length, 'a refused close must not record the boundary as closed').toBe(0);
    // …and the admin can still settle afterwards, which is the obligation this protects.
    const r = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(r).toMatchObject({ processed: 1, converted: 1 });
    expect(await replacementBalance(employmentId)).toBe(0);
  });

  it('a company-scoped close does not claim the whole tenant — the other company still settles', async () => {
    /**
     * THE GRAIN MISMATCH THIS FIXES. The accrual SELECT runs under `toil_accrual_rls` →
     * `can_see_employment` → `is_admin_for(company)`, which is COMPANY-scoped. The close marker used to
     * be keyed on `(tenant_id, event_type, payload->>'asOf')` with no company dimension at all. So an
     * hr_admin delegated to one company of a group swept only their own accruals and wrote a marker
     * claiming the entire tenant; every later close for that boundary — including a group admin's —
     * returned `alreadyClosed: true` and settled nothing, permanently, because `domain_event` has
     * UPDATE/DELETE REVOKEd from ai_hr_app. The marker is per company now.
     */
    const { employmentId: empA } = await accrueRestDay(5000);
    // A second company with its own banked day.
    const [cB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd', leaveCycle: 'calendar' })
      .returning({ id: schema.company.id });
    const [dB] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: cB.id, name: 'Ops B' })
      .returning({ id: schema.department.id });
    await setToilPolicy(ctx, policy(cB.id));
    const eB = await hireEmployee(ctx, {
      person: { fullName: 'Beta Worker', primaryEmail: uniqEmail() },
      companyId: cB.id,
      departmentId: dB.id,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(ctx, {
      employmentId: eB.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });
    await setRestDay(ctx, { employmentId: eB.employmentId, shiftDate: REST_DAY });
    await checkIn(ctx, { employmentId: eB.employmentId, date: REST_DAY, time: '08:00:00' });
    await checkOut(ctx, { employmentId: eB.employmentId, date: REST_DAY, time: '17:00:00' });
    await accrueToil(ctx, { employmentId: eB.employmentId, workedDate: REST_DAY });
    expect(await replacementBalance(eB.employmentId)).toBe(1);

    // An admin scoped to company A ONLY. `grants` (not `roles`) is what makes the scope real: withTenant
    // feeds it to app.grants, which is what is_admin_for reads.
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `user_${Math.random().toString(36).slice(2)}` })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: b.tenantId, appUserId: u.id, companyId: b.companyId, role: 'hr_admin' });
    const scopedA: SessionContext = {
      tenantId: b.tenantId,
      userId: u.id,
      grants: [{ role: 'hr_admin', companyId: b.companyId }],
      entitlements: (await entitledCtx(b)).entitlements,
    };

    const first = await closeReplacementLeaveYear(scopedA, { asOf: '2026-12-31' });
    expect(first.alreadyClosed).toBe(false);
    expect(first.processed, 'company A only — B is outside this admin’s RLS view').toBe(1);
    expect(await replacementBalance(empA)).toBe(0);
    expect(await replacementBalance(eB.employmentId), 'B is untouched so far').toBe(1);

    // THE ASSERTION. The group admin's close must still settle company B.
    const second = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(second.alreadyClosed, 'B was never closed, so this is not an idempotent re-fire').toBe(false);
    expect(second.processed, 'exactly B — A already has its marker and is skipped').toBe(1);
    expect(await replacementBalance(eB.employmentId), 'the statutory settlement reaches company B').toBe(0);

    // …and a third run is now a true no-op for both — reported AS a no-op, not merely behaving like one.
    // `alreadyClosed` is the field app/admin/toil/page.tsx branches on ("already closed" vs. "closed 0
    // accruals"), and asserting only `processed === 0` is satisfied by a close that swept nothing for a
    // completely different reason. It also caught a real regression: the guard used to require
    // `active.length > 0`, and after a successful close every row has left 'active', so the ordinary
    // re-fire skipped the marker check entirely and answered false.
    const third = await closeReplacementLeaveYear(ctx, { asOf: '2026-12-31' });
    expect(third.processed).toBe(0);
    expect(third.alreadyClosed, 'a re-fire over a fully settled boundary is an idempotent no-op').toBe(true);
  });

  it('a sweep by an admin who ALSO holds a partner grant elsewhere settles its own scope instead of aborting', async () => {
    /**
     * SELECT WHAT YOU MAY WRITE. Both sweeps read `status='active'` accruals and then UPDATE every row
     * they got back, i.e. they assume visibility implies writability. On toil_accrual those are two
     * different predicates: the read side is `can_see_employment` (admin OR self OR the recursive
     * manager chain, 0109) plus 0314's `can_admin_payroll_employment`, while the write side is
     * `can_admin_employment` (admin only, 0016).
     *
     * So a caller who clears `isAdminCtx` in company A while holding payroll_partner in company B used
     * to SELECT B's rows and then fail the UPDATE's WITH CHECK — which is an ERROR, not a skipped row,
     * so the whole transaction rolled back and company A's settlement went with it. G5 says the TOIL
     * statutory floor is reachable when the module is revoked; for this operator it was reachable for
     * nobody, and the failure surfaced as an unhandled 500.
     */
    const { employmentId: empA } = await accrueRestDay(5000, { expiryDays: 1 });

    const [cB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Gamma Sdn Bhd', leaveCycle: 'calendar' })
      .returning({ id: schema.company.id });
    const [dB] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: cB.id, name: 'Ops G' })
      .returning({ id: schema.department.id });
    await setToilPolicy(ctx, policy(cB.id, { expiryDays: 1 }));
    const eB = await hireEmployee(ctx, {
      person: { fullName: 'Gamma Worker', primaryEmail: uniqEmail() },
      companyId: cB.id,
      departmentId: dB.id,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(ctx, {
      employmentId: eB.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });
    await setRestDay(ctx, { employmentId: eB.employmentId, shiftDate: REST_DAY });
    await checkIn(ctx, { employmentId: eB.employmentId, date: REST_DAY, time: '08:00:00' });
    await checkOut(ctx, { employmentId: eB.employmentId, date: REST_DAY, time: '17:00:00' });
    await accrueToil(ctx, { employmentId: eB.employmentId, workedDate: REST_DAY });
    expect(await replacementBalance(eB.employmentId)).toBe(1);

    // hr_admin in A, payroll_partner in B — a perfectly ordinary shape for a group that outsources one
    // subsidiary's payroll.
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `user_${Math.random().toString(36).slice(2)}` })
      .returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values([
      { tenantId: b.tenantId, appUserId: u.id, companyId: b.companyId, role: 'hr_admin' },
      { tenantId: b.tenantId, appUserId: u.id, companyId: cB.id, role: 'payroll_partner' },
    ]);
    const dual: SessionContext = {
      tenantId: b.tenantId,
      userId: u.id,
      grants: [
        { role: 'hr_admin', companyId: b.companyId },
        { role: 'payroll_partner', companyId: cB.id },
      ],
      entitlements: (await entitledCtx(b)).entitlements,
    };

    const r = await runToilExpiry(dual, { today: '2027-01-01' });
    expect(r.processed, 'company A settles — B is visible but not writable, so it is never picked up').toBe(1);
    expect(await replacementBalance(empA), 'the statutory settlement reached company A').toBe(0);
    expect(await replacementBalance(eB.employmentId), 'company B is untouched, not half-swept').toBe(1);

    // …AND THE OPERATOR IS TOLD (review r3). Narrowing the read to the write set is what stops the
    // rollback, but on its own it converts a loud 500 into a SILENT partial sweep: B's accrual stays
    // `status='active'` past its expiry date and this admin sees the same success they would see if
    // nothing had been due. `closeReplacementLeaveYear` never needed this — it writes a per-company
    // `replacement-leave-year.closed` marker naming exactly what it swept — so the count exists only on
    // the sweep that has no marker.
    //
    // THIS IS THE ONLY SHAPE THAT CAN PRODUCE A NON-ZERO, and that is the point: the counting query
    // runs inside the same `withTenant` transaction, so it is bounded by the same base read policy.
    // It therefore reports exactly the rows `SETTLEABLE_BY_CALLER` removed on top of what the caller
    // could already see — which is the predicate slice 3 added. Rows the base policy hides (an
    // hr_admin scoped to one company simply cannot see another's accruals) were never visible to this
    // sweep, before slice 3 or after, and counting them would need a privilege this session does not
    // have. Claiming otherwise would be the reassuring-figure failure this whole slice keeps finding.
    expect(
      r.skippedOutOfScope,
      "B's accrual was due and this caller could SEE it but not settle it — that must be reported, " +
        'not left indistinguishable from "nothing was due"',
    ).toBe(1);

    // …and the group admin can still settle B afterwards, which is the obligation this protects.
    const group = await runToilExpiry(ctx, { today: '2027-01-01' });
    expect(group.processed).toBe(1);
    expect(group.skippedOutOfScope, 'a tenant-wide admin hides nothing from themselves').toBe(0);
    expect(await replacementBalance(eB.employmentId)).toBe(0);
    // A sweep with nothing due reports zero on BOTH axes, so "done" and "blocked" stay distinguishable.
    expect(await runToilExpiry(ctx, { today: '2027-01-01' })).toMatchObject({
      processed: 0,
      skippedOutOfScope: 0,
    });
  });
});

describe('Payroll interaction under a PAYROLL PARTNER’s row-level security (ADR-0077 slice 3 review)', () => {
  /**
   * THE DEFECT THIS PINS. `EXCLUDE_TOIL_BANKED_DAYS` (core/payroll.ts) is a
   * `not exists (select 1 from toil_accrual …)` correlated subquery, and a subquery runs under the
   * CALLER's RLS. 0076 gave `toil_accrual` `USING (… app.can_see_employment(employment_id))`, and
   * 0099:66-67 records in terms that `is_admin_for` inside `can_see_employment` does NOT include
   * partners. 0099 then widened attendance / payslip / payroll_input / compensation / employment to the
   * payroll capability and left `toil_accrual` alone, because nothing in the payroll path read it yet.
   *
   * Slice 3 is what made that live: the exclusion clause used to sit inside
   * `process.env.TOIL_ENABLED === 'true'`, which is set in no tracked env file, so it never ran. Now it
   * is unconditional — and for a payroll_partner the attendance row was visible while the accrual was
   * not, so `not exists` was trivially TRUE and the banked rest day got prefilled as overtime CASH while
   * the leave credit stayed on the ledger. The employee is paid twice for one day, and G3's claim that
   * the cash-XOR-TOIL invariant "is no longer switchable" would have been false — switchable by which
   * role presses the button. Migration 0314 widens the READ; the write side is unchanged.
   */
  async function payrollPartnerCtx(companyId: string): Promise<SessionContext> {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `user_${Math.random().toString(36).slice(2)}` })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'payroll_partner' });
    return {
      tenantId: b.tenantId,
      userId: u.id,
      grants: [{ role: 'payroll_partner', companyId }],
      entitlements: (await entitledCtx(b)).entitlements,
    };
  }

  /**
   * RM3,000 — BELOW the RM4,000 statutory OT wage ceiling, and that is load-bearing rather than
   * arbitrary. `overtimePay` returns `eligible: false` above the ceiling, so an employee on the 5,000
   * the rest of this file uses yields `applied: 0` whatever the exclusion clause does — the assertion
   * would pass for the wrong reason, which is precisely the failure this slice keeps producing. Under
   * the ceiling, `applied: 0, ineligible: 0` can only mean the OT row was never fetched at all.
   *
   * Being under the ceiling also makes the employee FIRST-SCHEDULE eligible, so banking in lieu needs
   * the policy opt-in AND recorded per-election consent (ADR-0033 / Phase-B #14). That is the honest
   * fixture for this defect anyway: the double-compensation it guards against is worst for exactly the
   * employee whose overtime cash is statutory.
   */
  const UNDER_CEILING = 3000;

  /** hire under the ceiling → rostered rest day → 480 OT → banked in lieu, with consent recorded. */
  async function bankUnderCeiling() {
    const { a, employmentId } = await hire(UNDER_CEILING);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true, onExpiry: 'convert_to_pay' }));
    await setRestDay(a, { employmentId, shiftDate: REST_DAY });
    await checkIn(a, { employmentId, date: REST_DAY, time: '08:00:00' });
    await checkOut(a, { employmentId, date: REST_DAY, time: '17:00:00' });
    await accrueToil(a, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    return employmentId;
  }

  it('a banked rest day is NOT prefilled as OT cash when a payroll partner runs the batch', async () => {
    const employmentId = await bankUnderCeiling();
    expect(await replacementBalance(employmentId), 'the day is banked as leave').toBe(1);

    const partner = await payrollPartnerCtx(b.companyId);
    // The partner really can see the attendance row — otherwise this would pass for the wrong reason
    // (nothing to prefill rather than correctly excluded).
    const visibleOt = await withTenant(partner, (tx) =>
      tx
        .select({ id: schema.attendance.id })
        .from(schema.attendance)
        .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, REST_DAY))),
    );
    expect(visibleOt.length, 'the partner must be able to see the OT day, or this proves nothing').toBe(1);
    // THE MECHANISM, pinned directly. The exclusion is a `not exists` subquery evaluated under the
    // CALLER's RLS, so it is only meaningful if the caller can see the accrual. Before migration 0314
    // this returned 0 rows for a payroll_partner — `not exists` was trivially true and the banked day
    // was paid as cash. Asserting the visibility separately is what stops the prefill assertion below
    // from silently degrading into "nothing happened" if the policy is ever narrowed again.
    const visibleAccruals = await withTenant(partner, (tx) =>
      tx
        .select({ id: schema.toilAccrual.id })
        .from(schema.toilAccrual)
        .where(eq(schema.toilAccrual.employmentId, employmentId)),
    );
    expect(visibleAccruals.length, 'the payroll function must be able to READ toil_accrual (0314)').toBe(1);

    const { batchId } = await createBatch(partner, { companyId: b.companyId, payPeriod: '2026-07' });
    const r = await prefillOvertimeFromAttendance(partner, { batchId });
    // `ineligible: 0` as well as `applied: 0`: the day must be EXCLUDED from the fetch, not merely
    // fail the wage-ceiling test afterwards. Those are different mechanisms with the same figure.
    expect(r, 'the banked day must not also be paid as cash OT').toMatchObject({ applied: 0, ineligible: 0 });
    // …and the leave credit is still there — the day was compensated exactly once, as leave.
    expect(await replacementBalance(employmentId)).toBe(1);
  });

  it('…while an UNBANKED rest day is still prefilled for the same partner', async () => {
    // The control. Without it the assertion above is satisfied by any prefill that does nothing at all.
    const { a, employmentId } = await hire(UNDER_CEILING);
    const OTHER_REST_DAY = '2026-07-11';
    await setRestDay(a, { employmentId, shiftDate: OTHER_REST_DAY });
    await checkIn(a, { employmentId, date: OTHER_REST_DAY, time: '08:00:00' });
    await checkOut(a, { employmentId, date: OTHER_REST_DAY, time: '17:00:00' });

    const partner = await payrollPartnerCtx(b.companyId);
    const { batchId } = await createBatch(partner, { companyId: b.companyId, payPeriod: '2026-07' });
    expect((await prefillOvertimeFromAttendance(partner, { batchId })).applied).toBe(1);
  });

  it('…and the read widening is READ ONLY — the partner cannot DELETE the accrual it can now see', async () => {
    /**
     * THE HALF THE FIRST VERSION OF 0314 GOT WRONG. It widened `toil_accrual_rls`'s USING clause in
     * place and asserted in its own header that this was read-only "because WITH CHECK is unchanged".
     * PostgreSQL authorises a DELETE from the USING expression ALONE — WITH CHECK produces no new row
     * to check and is never consulted — and 0076 grants `ai_hr_app` full DML on the table, so that
     * USING clause was the only thing between a payroll_partner session and destroying an employee's
     * banked-leave ledger. The read is a separate FOR SELECT policy now, and DELETE carries a
     * RESTRICTIVE `can_admin_employment` policy on top.
     *
     * Asserting the SELECT works without asserting the DELETE does not is how the suite would have
     * stayed green over a live privilege escalation.
     */
    const employmentId = await bankUnderCeiling();
    const partner = await payrollPartnerCtx(b.companyId);

    const deleted = await withTenant(partner, (tx) =>
      tx
        .delete(schema.toilAccrual)
        .where(eq(schema.toilAccrual.employmentId, employmentId))
        .returning({ id: schema.toilAccrual.id }),
    );
    expect(deleted.length, 'a payroll partner must not be able to destroy a banked-leave accrual').toBe(0);
    const survivors = await owner.db
      .select({ id: schema.toilAccrual.id })
      .from(schema.toilAccrual)
      .where(eq(schema.toilAccrual.employmentId, employmentId));
    expect(survivors.length, 'the ledger row is still there').toBe(1);
    // The control: an HR admin still can, so the assertion above is a permission boundary and not a
    // broken statement.
    const byAdmin = await withTenant(ctx, (tx) =>
      tx
        .delete(schema.toilAccrual)
        .where(eq(schema.toilAccrual.employmentId, employmentId))
        .returning({ id: schema.toilAccrual.id }),
    );
    expect(byAdmin.length, 'an hr_admin for the company is still authorised to delete').toBe(1);
  });
});

/**
 * 20e759a0 · THE PAGE-LEVEL COMPANY FILTER.
 *
 * The reporter's screen printed all nine of their companies' policy forms one under the other — 20
 * settings and a Save button each. The configuration screen picks ONE via `?company=` — that screen is
 * `app/admin/leave-config/company-rules/page.tsx` since the a6fe37fc Round 5 cutover.
 * Two halves of that are easy to get wrong and are pinned here:
 *
 *   1. THE FALLBACK. Absent, junk, or an id that has since left the admin's scope must all land on a
 *      usable page — the first visible company — never on an empty one. A bookmark kept after a company
 *      is archived is the realistic case, and "renders nothing" is indistinguishable from "broken".
 *   2. THE SAVE ROUND-TRIP. Every redirect out of `setToilPolicyAction` has to carry the selection back.
 *      All three dropped it before this item, so a save bounced the admin onto the DEFAULT company — and
 *      on the error path onto a company whose form the `?error=` banner does not describe.
 *
 * The resolver is unit-tested (it is a rule, not a query); the action is driven for real against this
 * file's database with only Next's redirect/revalidate/getSession stubbed.
 */
describe('20e759a0 · company filter — resolving ?company=', () => {
  const ids = ['c-first', 'c-second', 'c-third'];

  it('the literal "all" keeps the stacked every-company view', () => {
    expect(resolveCompanyFilter(ALL_COMPANIES, ids)).toBe(ALL_COMPANIES);
  });

  it('an id the admin can see selects exactly that company', () => {
    expect(resolveCompanyFilter('c-second', ids)).toBe('c-second');
  });

  it('an UNRECOGNISED id falls back to the first visible company, not to nothing', () => {
    // The archived-company bookmark. Rendering an empty page here is the defect this pins.
    expect(resolveCompanyFilter('c-archived-last-year', ids)).toBe('c-first');
  });

  it('no parameter at all opens on the first visible company — the page is short from load', () => {
    expect(resolveCompanyFilter(undefined, ids)).toBe('c-first');
    expect(resolveCompanyFilter('', ids)).toBe('c-first');
  });

  it('an id OUTSIDE the global company scope is not honoured — the cookie stays the outer bound', () => {
    // `visible` is already companies ∩ scopeIds, so a URL naming a company the top-bar switcher has
    // excluded must not smuggle it back onto the page.
    expect(resolveCompanyFilter('c-out-of-scope', ['c-first'])).toBe('c-first');
  });

  it('with nothing visible it selects nothing, so the page can say so instead of guessing', () => {
    expect(resolveCompanyFilter(undefined, [])).toBeNull();
    expect(resolveCompanyFilter('c-first', [])).toBeNull();
    // …but "all" is still "all": an empty stacked view is the same empty view.
    expect(resolveCompanyFilter(ALL_COMPANIES, [])).toBe(ALL_COMPANIES);
  });
});

describe('20e759a0 · company filter — the save redirect carries the selection', () => {
  /** The form the page posts. Only `companyId` is load-bearing here; the rest are the screen's defaults. */
  const saveForm = (companyId: string, over: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set('companyId', companyId);
    fd.set('enabled', 'on');
    fd.set('accrualBasis', 'hours_worked');
    fd.set('expiryUnit', 'days');
    fd.set('expiryDays', '90');
    fd.set('expiryMonths', '3');
    fd.set('onExpiry', 'convert_to_pay');
    fd.set('replacementLeaveFrom', 'overtime');
    for (const [k, v] of Object.entries(over)) fd.set(k, v);
    return fd;
  };

  /** Run the action and return the single URL it redirected to. */
  async function redirectedTo(fd: FormData): Promise<string> {
    redirectMock.mockClear();
    revalidateMock.mockClear();
    sessionHolder.s = ctx;
    let threw: unknown;
    try {
      await setToilPolicyAction(fd);
    } catch (e) {
      threw = e;
    }
    // Asserted rather than `rejects.toThrow`: what matters is that the action left through EXACTLY ONE
    // redirect. Two calls would mean it fell through its own catch, and the first URL would be a lie.
    expect(threw, 'the action must leave through redirect()').toBeDefined();
    expect(redirectMock).toHaveBeenCalledTimes(1);
    return redirectMock.mock.calls[0][0] as string;
  }

  it('a clean save returns to the company that was being edited, not to the default one', async () => {
    // a6fe37fc ROUND 5 (cutover) — the destination is Company rules now: `LEAVE_REPLACEMENT` was
    // repointed there in the commit that emptied `/admin/leave/replacement`. What 20e759a0 promised —
    // the `?company=` selection survives the save — is unchanged and is the half asserted below.
    // 3fb1a611 (r299) — and Leave Config › Leave Credit's Rules tab since the policy left Company rules.
    const url = await redirectedTo(saveForm(b.companyId));
    expect(url).toContain('/admin/leave-config/leave-credit/rules?saved=1');
    expect(url, 'without this the admin lands back on the first company after every save').toContain(
      `company=${encodeURIComponent(b.companyId)}`,
    );
  });

  it('the premium-equivalent WARNING return carries it too', async () => {
    const url = await redirectedTo(
      saveForm(b.companyId, { accrualBasis: 'premium_equivalent', allowFirstScheduleEligible: 'on' }),
    );
    expect(url, 'the Phase-B #14 banking-risk warning still rides in the URL').toContain('warning=');
    expect(url).toContain(`company=${encodeURIComponent(b.companyId)}`);
  });

  it('the ERROR path carries it — the path where losing it hides the form the error is about', async () => {
    // 500 months is refused by setToilPolicy's own 1..24 bound, so this is a genuine failed save and not
    // a fabricated throw.
    const url = await redirectedTo(saveForm(b.companyId, { expiryUnit: 'months', expiryMonths: '500' }));
    expect(url).toContain('error=');
    expect(url).toMatch(/between\+1\+and\+24|between%201%20and%2024/i);
    expect(url).toContain(`company=${encodeURIComponent(b.companyId)}`);
    // And the failed save wrote nothing: the policy is still the synthesized default.
    const [p] = await listToilPolicies(ctx, [b.companyId]);
    expect(p.isDefault, 'a refused save must not have persisted a policy row').toBe(true);
  });

  it('every redirect is a well-formed URL with ONE query string', async () => {
    // The reason `fail()` could not be reused: it appends `?error=` to whatever path it is handed, so a
    // path already carrying `?company=` would produce two `?` and the second parameter would be lost.
    for (const fd of [
      saveForm(b.companyId),
      saveForm(b.companyId, { accrualBasis: 'premium_equivalent', allowFirstScheduleEligible: 'on' }),
      saveForm(b.companyId, { expiryUnit: 'months', expiryMonths: '500' }),
    ]) {
      const url = await redirectedTo(fd);
      expect(url.split('?').length, `two query strings in ${url}`).toBe(2);
      const parsed = new URL(url, 'https://example.test');
      expect(parsed.pathname).toBe('/admin/leave-config/leave-credit/rules');
      expect(parsed.searchParams.get('company')).toBe(b.companyId);
    }
  });

  it('a form posting no companyId still redirects to a usable page rather than a broken URL', async () => {
    // setToilPolicy refuses the empty id, so this is the error path; the point is that the trailing
    // `&company=` is omitted entirely rather than emitted empty.
    const fd = saveForm('');
    const url = await redirectedTo(fd);
    expect(url).toContain('error=');
    expect(url).not.toContain('company=');
    expect(url.split('?').length).toBe(2);
  });
});
