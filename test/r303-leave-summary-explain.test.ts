/**
 * r303 (31492f74) — LEAVE SUMMARY, DYNAMIC EXPLANATION STATEMENTS: the working behind each of the nine figures,
 * on ledgers the REAL engines posted.
 *
 * THE PROPERTY UNDER TEST IS THE MATCH GUARANTEE. HR's sentences list, under each figure, the records that make
 * it up. `leaveEntitlementBreakdown` pushes each record in the same branch that adds it to the figure, so the
 * list and the figure cannot describe different rows — and `expectSumGuard` below asserts, for EVERY fixture,
 * that the itemised amounts add up EXACTLY to the figure shown (the reconciledBalance shape of
 * test/leave-balance-reconciliation.test.ts). A change that lists a row the figure does not count, or counts a
 * row the list does not show, fails here.
 *
 * Fixtures, per the approved plan: earned monthly and daily, up front with a mid-year joiner, a2c first year
 * (with its accrual claw-down and its reversal), carry cap forfeit, carry expiry, HR + system adjustments
 * (policy, profile and a2c recalc), pending requests (bounded by the As-at date), a shared pool, Replacement
 * Leave with Leave Credit (credits, an expiry and a reversal), no table, no matching table, a stranded earned
 * method, and a scheme that won a tie-break.
 *
 * Read-only feature: no schema, no migration, no DomainEvent. // substrate: read-only, no event
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { setLeaveTypeRules, updateLeaveType } from '../core/admin';
import {
  POLICY_RECALC_REASON_PREFIX,
  PROFILE_RECALC_REASON_PREFIX,
  accrueEarnedLeave,
  expireCarriedLeave,
  openLeaveYear,
} from '../core/leave';
import { leaveEntitlementBreakdown, type LeaveEntitlementBreakdown } from '../core/read';
import { applyLeaveAdjustmentBatch } from '../core/leave-adjustment';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { grantLeaveCredit, reverseLeaveCredit, runToilExpiry, setToilPolicy } from '../core/toil';
import { employeeBalanceRows } from '../app/leave/employee-balances/rows';
import {
  LEAVE_SUMMARY_EXPLAIN_KEYS,
  LEAVE_SUMMARY_LINE_KEYS,
  explainLeaveSummary,
  type ExplainStep,
  type LeaveSummaryLineKey,
} from '../lib/leave-summary-explain';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  setModule,
  type Base,
} from './harness';

let b: Base;

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

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: { days: number }[]) => r2(xs.reduce((s, x) => s + x.days, 0));

const hire = (hiredOn: string, grantAnnual = false) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'R303 Explain', primaryEmail: `r303_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: grantAnnual ? [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }] : [],
  });

const post = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment' | 'in_lieu_accrual',
  days: number,
  effectiveOn: string,
  extra: { reason?: string | null; sourceRequestId?: string | null } = {},
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
    reason: extra.reason ?? null,
    sourceRequestId: extra.sourceRequestId ?? null,
  });

const request = async (
  employmentId: string,
  leaveTypeId: string,
  status: 'pending' | 'approved',
  startDate: string,
  endDate: string,
  days: number,
) => {
  const [row] = await owner.db
    .insert(schema.leaveRequest)
    .values({ tenantId: b.tenantId, employmentId, leaveTypeId, status, startDate, endDate, days: days.toFixed(2) })
    .returning({ id: schema.leaveRequest.id });
  return row.id;
};

const mkType = async (code: string, name: string, extra: Partial<typeof schema.leaveType.$inferInsert> = {}) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, paid: true, allowNegativeBalance: true, ...extra })
    .returning({ id: schema.leaveType.id });
  return lt.id;
};

const setMethod = (leaveTypeId: string, method: string) =>
  owner.db.update(schema.leaveType).set({ accrualMethod: method as never }).where(eq(schema.leaveType.id, leaveTypeId));

/** HR's read: the breakdown WITH its derivation, exactly as the two HR mounts ask for it. */
const hrRead = async (employmentId: string, leaveTypeId: string, asOf: string, ctx: SessionContext = adminCtx(b)) => {
  const bd = await leaveEntitlementBreakdown(ctx, employmentId, leaveTypeId, asOf, 'en', { derivation: true });
  expect(bd).not.toBeNull();
  expect(bd!.derivation, 'the HR read carries the derivation').toBeTruthy();
  return bd!;
};

/**
 * THE SUM-GUARD. Every itemised line reaches its figure EXACTLY, and the rendered sentences therefore never fall
 * back to "could not be listed". Asserted on every fixture in this file.
 */
function expectSumGuard(bd: LeaveEntitlementBreakdown, available = bd.totalAvailable) {
  const d = bd.derivation!;
  expect(d.entitlement.days, 'Full Entitlement').toBe(bd.eligibleDays);
  expect(sum(d.earned.credits), 'Earned to Date = Σ credits').toBe(bd.currentYearEntitlement);
  expect(sum(d.adjustments.manual), 'manual adjustments = configAdjustments').toBe(bd.configAdjustments);
  expect(sum(d.adjustments.system), 'system corrections = systemAdjustments').toBe(bd.systemAdjustments);
  expect(r2(sum(d.adjustments.manual) + sum(d.adjustments.system)), 'Adjustments line').toBe(bd.adjustments);
  expect(r2(d.taken.leaveDays + sum(d.taken.other)), 'Taken = approved leave + other deductions').toBe(bd.takenThisCycle);
  expect(sum(d.pending), 'Pending Approval = Σ listed requests').toBe(bd.pendingApproval);
  expect(sum(d.forfeited), 'Brought Forward Forfeited = Σ forfeit rows').toBe(bd.forfeitedThisCycle);
  // Total and Available: the formula the sentence prints is an identity over the figures shown.
  expect(r2(bd.broughtForward + bd.currentYearEntitlement + bd.adjustments)).toBe(bd.totalEntitlement);
  expect(r2(bd.totalEntitlement - bd.takenThisCycle - bd.pendingApproval - bd.forfeitedThisCycle)).toBe(bd.totalAvailable);

  const lines = explainLeaveSummary(bd, { available });
  for (const line of LEAVE_SUMMARY_LINE_KEYS) {
    const keys = lines[line].map((s) => s.key);
    expect(keys.length, `${line} has a sentence`).toBeGreaterThan(0);
    expect(keys, `${line} never falls back`).not.toContain('itemsDoNotAddUp');
    expect(keys, `${line} never falls back`).not.toContain('unavailable');
    for (const k of keys) expect(LEAVE_SUMMARY_EXPLAIN_KEYS as readonly string[]).toContain(k);
  }
  return lines;
}

const keysOf = (lines: Record<LeaveSummaryLineKey, ExplainStep[]>, line: LeaveSummaryLineKey) => lines[line].map((s) => s.key);
const argsOf = (lines: Record<LeaveSummaryLineKey, ExplainStep[]>, line: LeaveSummaryLineKey, key: string) =>
  lines[line].filter((s) => s.key === key).map((s) => s.args);

/** Independent read of the ledger window, to prove a list names EVERY row of its class — not just some. */
const ledgerWindow = (employmentId: string, leaveTypeId: string, from: string, to: string) =>
  owner.db
    .select({ entryType: schema.leaveLedger.entryType, days: schema.leaveLedger.days, reason: schema.leaveLedger.reason })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId),
        gte(schema.leaveLedger.effectiveOn, from),
        lte(schema.leaveLedger.effectiveOn, to),
      ),
    );

describe('r303 — only HR asks, so the employee read is unchanged', () => {
  it('without { derivation: true } the breakdown has no derivation key and every other field is identical', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    const emp = await hire('2025-01-01', true);
    await request(emp.employmentId, b.annualLeaveTypeId, 'pending', '2026-03-02', '2026-03-03', 2);
    const plain = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-06-30', 'en');
    const hr = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(plain).not.toBeNull();
    expect(Object.keys(plain!)).not.toContain('derivation');
    const { derivation: _d, ...rest } = hr;
    expect(rest).toEqual(plain);
    expectSumGuard(hr);
  });
});

describe('r303 — Full Entitlement: the table, why it applies, the service length at the leave year start, the band', () => {
  it('a scheme that won on specificity is named with its win reason, the band and the cycle-start service length', async () => {
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      serviceBands: [
        { fromYears: 0, toYears: 2, days: 14 },
        { fromYears: 2, toYears: null, days: 18 },
      ],
      companyId: b.companyId,
      validFrom: '2020-01-01',
      name: 'Annual — company staff',
    });
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 10, validFrom: '2020-01-01', name: 'Annual — everyone' });
    // Joined 2024-03-10: 1 completed year on 2026-01-01 (the leave year start), 2 by the As-at date. The band is
    // read at the START of the leave year, so it is 0–2 years / 14 days — not the 18 an As-at reading would give.
    const emp = await hire('2024-03-10');
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.eligibleDays).toBe(14);
    expect(bd.derivation!.entitlement).toEqual({
      tableName: 'Annual — company staff',
      via: 'scheme',
      schemeName: 'Annual — company staff — eligibility',
      winReason: 'more_specific',
      hiredOn: '2024-03-10',
      serviceYears: 1,
      band: { fromYears: 0, toYears: 2 },
      days: 14,
    });
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'eligible')).toEqual(['eligibleViaScheme', 'eligibleWin', 'eligibleService', 'eligibleBand', 'eligibleFullYear']);
    expect(argsOf(lines, 'eligible', 'eligibleWin')).toEqual([{ reason: { choice: 'more_specific' } }]);
    expect(argsOf(lines, 'eligible', 'eligibleBand')).toEqual([{ from: { count: 0 }, to: { count: 2 }, days: { days: 14 } }]);
  });

  it('the only table for a leave type, with no rule, is named as the only table', async () => {
    await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Annual — sole',
      serviceBands: [{ fromYears: 0, toYears: null, days: 16 }],
      validFrom: '2020-01-01',
    });
    const emp = await hire('2020-01-01');
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.derivation!.entitlement.via).toBe('sole_table');
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'eligible')).toEqual(['eligibleViaSole', 'eligibleService', 'eligibleBandOpen', 'eligibleFullYear']);
  });

  it('no table at all: the sentence comes from the no_entitlement_table status, and nothing is guessed', async () => {
    const emp = await hire('2025-01-01');
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.entitlementStatus).toBe('no_entitlement_table');
    expect(bd.derivation!.entitlement.via).toBeNull();
    expect(bd.derivation!.earned.method).toBeNull();
    expect(bd.derivation!.carry.rule).toBe('not_recorded');
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'eligible')).toEqual(['eligibleNoTable']);
    expect(keysOf(lines, 'ytdEntitled')).toEqual(['earnedLeaveYear', 'earnedNoTable']);
    expect(keysOf(lines, 'broughtForward')).toEqual(['bfNone', 'carryNotRecorded', 'bfForfeitNote']);
    expect(keysOf(lines, 'adjustment')).toEqual(['adjNone']);
    expect(keysOf(lines, 'taken')).toEqual(['takenNone']);
    expect(keysOf(lines, 'pendingApproval')).toEqual(['pendingNone']);
    expect(keysOf(lines, 'forfeited')).toEqual(['forfeitNone']);
    expect(keysOf(lines, 'available')).toEqual(['availableFormula']);
  });

  it('tables exist and none reaches this employee: the no_eligibility_match sentence', async () => {
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Annual — Operations',
      serviceBands: [{ fromYears: 0, toYears: null, days: 12 }],
      validFrom: '2020-01-01',
    });
    await createEligibilityRule(adminCtx(b), {
      name: 'Operations only',
      templateLineageId: tpl.lineageId,
      criteria: { departmentIds: [b.deptB] },
      validFrom: '2020-01-01',
    });
    const emp = await hire('2025-01-01'); // deptA
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.entitlementStatus).toBe('no_eligibility_match');
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'eligible')).toEqual(['eligibleNoMatch']);
  });
});

describe('r303 — Earned to Date: method, leave year, rounding, the join-year rule, and every credit', () => {
  it('earned monthly: every accrual run is listed with its date and the list reaches the figure', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    await setMethod(b.annualLeaveTypeId, 'earned_monthly');
    const emp = await hire('2025-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15', leaveTypeIds: [b.annualLeaveTypeId] });
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-15', leaveTypeIds: [b.annualLeaveTypeId] });
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.currentYearEntitlement).toBe(6);
    const d = bd.derivation!;
    expect(d.earned.method).toBe('earned_monthly');
    expect(d.earned.leaveYear).toBe('calendar');
    expect(d.earned.cycleEnd).toBe('2026-12-31');
    expect(d.earned.rounding).toBe('none');
    expect(d.earned.joinYear).toBeNull(); // joined before this leave year
    expect(d.earned.credits).toEqual([
      { effectiveOn: '2026-03-15', days: 3, kind: 'grant' },
      { effectiveOn: '2026-06-15', days: 3, kind: 'grant' },
    ]);
    // Every accrual-class row in the window, read independently, is on the list.
    const raw = (await ledgerWindow(emp.employmentId, b.annualLeaveTypeId, bd.cycleStart, bd.asOf)).filter(
      (r) => r.entryType === 'accrual' || r.entryType === 'in_lieu_accrual',
    );
    expect(raw.length).toBe(d.earned.credits.length);
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'ytdEntitled')).toEqual([
      'earnedMethod',
      'earnedLeaveYear',
      'earnedRounding',
      'earnedCreditsIntro',
      'creditItem',
      'creditItem',
      'addsUpTo',
      'earnedActualOnly',
    ]);
  });

  it('earned daily, joined mid-year: earning counts from the join date (the engine’s own anchor)', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 20, validFrom: '2025-01-01' });
    await setMethod(b.annualLeaveTypeId, 'earned_daily');
    const emp = await hire('2026-03-10');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-31', leaveTypeIds: [b.annualLeaveTypeId] });
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.derivation!.earned.joinYear).toEqual({ hiredOn: '2026-03-10', rule: 'earned_from', earnedFrom: '2026-03-10' });
    expect(bd.derivation!.earned.credits.length).toBeGreaterThan(0);
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'ytdEntitled')).toContain('joinEarnedFrom');
  });

  it('earned monthly, joined mid-year: earning counts from the first of the join month', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    await setMethod(b.annualLeaveTypeId, 'earned_monthly');
    const emp = await hire('2026-03-10');
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.derivation!.earned.joinYear).toEqual({ hiredOn: '2026-03-10', rule: 'earned_from', earnedFrom: '2026-03-01' });
    // Nothing accrued yet: the earned_accrual status says so, and "nothing credited" is not said twice.
    expect(bd.entitlementStatus).toBe('earned_accrual');
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'ytdEntitled')).toEqual(['earnedMethod', 'earnedLeaveYear', 'earnedRounding', 'joinEarnedFrom', 'earnedNothingYet']);
  });

  it('granted up front, joined mid-year: Annual Leave counts the months left, and the hire grant is the one credit', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    const emp = await hire('2026-04-15', true);
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.currentYearEntitlement).toBe(9); // 12 × 9/12
    expect(bd.eligibleDays).toBe(12); // Full Entitlement stays the full-year figure
    expect(bd.derivation!.earned.method).toBe('up_front');
    expect(bd.derivation!.earned.joinYear).toEqual({ hiredOn: '2026-04-15', rule: 'months_remaining', earnedFrom: null });
    expect(bd.derivation!.earned.credits).toEqual([{ effectiveOn: '2026-04-15', days: 9, kind: 'grant' }]);
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'ytdEntitled')).toContain('joinMonthsRemaining');
  });

  it('a non-Annual type is granted in full in the join year', async () => {
    const sick = await mkType('SICKX', 'Sick X');
    await seedEntitlement(adminCtx(b), { leaveTypeId: sick, annualDays: 14, validFrom: '2025-01-01' });
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'R303 Sick', primaryEmail: `r303s_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-04-15',
      grantLeaveTypes: [{ id: sick, code: 'SICKX' }],
    });
    const bd = await hrRead(emp.employmentId, sick, '2026-06-30');
    expect(bd.derivation!.earned.joinYear?.rule).toBe('full');
    expectSumGuard(bd);
  });

  it('a stranded earned method (r299): the status sentence, from the status, not inferred', async () => {
    const study = await mkType('STUDYX', 'Study X');
    await seedEntitlement(adminCtx(b), { leaveTypeId: study, annualDays: 5, validFrom: '2025-01-01' });
    await setMethod(study, 'earned_monthly');
    const emp = await hire('2025-01-01');
    await post(emp.employmentId, study, 'accrual', 1.5, '2026-02-01'); // posted before the sweep narrowed
    const bd = await hrRead(emp.employmentId, study, '2026-06-30');
    expect(bd.entitlementStatus).toBe('earned_method_not_annual_leave');
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'ytdEntitled')).toContain('earnedStranded');
    expect(keysOf(lines, 'ytdEntitled')).toContain('creditItem'); // the row that exists is still listed
  });
});

describe('r303 — Brought Forward and Brought Forward Forfeited: the carry rule and every forfeit, with why', () => {
  it('cap forfeit at year open + carry expiry + a debit after the carry window', async () => {
    await setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      carryForwardMax: 5,
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
      maxBalanceDays: null,
    });
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    const emp = await hire('2025-01-01', true);
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-06-01');
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    const d = bd.derivation!;
    expect(bd.broughtForward).toBe(12);
    expect(d.carry).toEqual({ rule: 'on', maxDays: 5, percent: null });
    expect(bd.carryForwardExpiryDate).toBe('2026-03-31');
    expect(d.forfeited.map((x) => x.kind).sort()).toEqual(['carry_cap', 'carry_expiry']);
    expect(d.forfeited.find((x) => x.kind === 'carry_cap')!.days).toBe(7);
    expect(d.forfeited.find((x) => x.kind === 'carry_expiry')!.days).toBe(5);
    // An unlinked debit (no leave application) is an OTHER deduction, not approved leave.
    expect(d.taken).toEqual({ leaveDays: 0, other: [{ effectiveOn: '2026-06-01', days: 3, kind: null, reason: null }] });
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'broughtForward')).toEqual(['bfAmount', 'carryMax', 'carryExpires', 'bfForfeitNote']);
    expect(keysOf(lines, 'forfeited')).toEqual(['forfeitItem', 'forfeitItem', 'addsUpTo', 'forfeitCarryExpiry']);
    expect(keysOf(lines, 'taken')).toEqual(['takenLeave', 'takenOtherIntro', 'takenOtherItemUnrecorded', 'addsUpTo']);
  });
});

describe('r303 — Adjustments: HR’s own rows by date, days and reason; system corrections separately', () => {
  it('festive grants + policy, profile and a2c recalc corrections, each in its own list', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 20, validFrom: '2026-01-01' });
    const emp = await hire('2026-01-06', true);
    await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      days: 2,
      effectiveOn: '2026-02-01',
      reason: 'CNY 2026',
      targetMode: 'criteria',
      criteria: { companyIds: [b.companyId] },
    });
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -9.5, '2026-05-01', { reason: `${POLICY_RECALC_REASON_PREFIX}:${randomUUID()}` });
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', 1, '2026-05-02', { reason: `${PROFILE_RECALC_REASON_PREFIX}:${emp.employmentId}` });
    // HR saves Anniversary to Calendar: the engine claws the hire grant down to 19.73 (an ACCRUAL-class a2c row)
    // and reverses the superseded system rows (an ADJUSTMENT-class a2c row).
    await updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', yearCycleOverride: 'a2c', asOf: '2026-07-23' });
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-07-23');
    const d = bd.derivation!;
    expect(d.adjustments.manual).toEqual([{ effectiveOn: '2026-02-01', days: 2, reason: 'CNY 2026' }]);
    expect(d.adjustments.system.map((s) => s.kind)).toEqual(['policy_recalc', 'profile_recalc', 'a2c_recalc']);
    expect(d.earned.credits.map((c) => c.kind)).toEqual(['grant', 'a2c_correction']);
    expect(bd.currentYearEntitlement).toBe(19.73);
    expect(d.earned.leaveYearOverride).toBe('a2c');
    expect(d.earned.joinYear).toEqual({ hiredOn: '2026-01-06', rule: 'a2c_up_front', earnedFrom: null });
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'adjustment')).toEqual([
      'adjManualIntro',
      'adjManualItem',
      'adjSystemIntro',
      'adjSystemItem',
      'adjSystemItem',
      'adjSystemItem',
      'addsUpTo',
    ]);
    expect(keysOf(lines, 'ytdEntitled')).toContain('joinA2cUpFront');
    expect(argsOf(lines, 'ytdEntitled', 'earnedLeaveYear')[0]!.kind).toEqual({ choice: 'a2c' });
  });
});

describe('r303 — Pending Approval and Taken: the applications, bounded by the As-at date like the figure', () => {
  it('pending requests starting after the As-at date are neither counted nor listed; approved leave is summed', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    const emp = await hire('2025-01-01', true);
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const approved = await request(emp.employmentId, b.annualLeaveTypeId, 'approved', '2026-03-02', '2026-03-04', 3);
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-03-02', { sourceRequestId: approved });
    await request(emp.employmentId, b.annualLeaveTypeId, 'pending', '2026-08-03', '2026-08-06', 4);
    await request(emp.employmentId, b.annualLeaveTypeId, 'pending', '2026-08-04', '2026-08-04', 1);
    await request(emp.employmentId, b.annualLeaveTypeId, 'pending', '2026-09-04', '2026-09-04', 1); // after As-at
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-08-04');
    expect(bd.pendingApproval).toBe(5);
    expect(bd.derivation!.pending).toEqual([
      { startDate: '2026-08-03', endDate: '2026-08-06', days: 4 },
      { startDate: '2026-08-04', endDate: '2026-08-04', days: 1 },
    ]);
    expect(bd.derivation!.taken).toEqual({ leaveDays: 3, other: [] });
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'pendingApproval')).toEqual(['pendingIntro', 'pendingItem', 'pendingItemOneDay', 'addsUpTo']);
    expect(keysOf(lines, 'taken')).toEqual(['takenLeave']);
  });
});

describe('r303 — a shared pool: the sentences name the pool, and Available says why it differs', () => {
  it('a borrower row explains the pool’s figures; pooled pending makes Available differ, and the sentence says why', async () => {
    const pool = await mkType('SPECIALX', 'Special Leave');
    const borrower = await mkType('MARRIAGEX', 'Marriage Leave', { balanceSourceTypeId: pool });
    const emp = await hire('2025-01-01');
    await post(emp.employmentId, pool, 'accrual', 10, '2026-01-01');
    const used = await request(emp.employmentId, borrower, 'approved', '2026-02-02', '2026-02-04', 3);
    await post(emp.employmentId, pool, 'debit', -3, '2026-02-02', { sourceRequestId: used });
    await request(emp.employmentId, borrower, 'pending', '2026-06-01', '2026-06-02', 2);
    await request(emp.employmentId, pool, 'pending', '2026-06-10', '2026-06-10', 1);

    const rows = await employeeBalanceRows(adminCtx(b), emp.employmentId, '2026-06-30', 'en');
    const row = rows.find((r) => r.leaveTypeId === borrower)!;
    expect(row.breakdown!.leaveTypeId).toBe(pool); // the pool's story (balanceStoryTypeId)
    expect(row.hrExplanation.sharedBalance!.sourceLeaveTypeName).toBe('Special Leave');
    expect(row.available).toBe(4); // 7 − (2 + 1) pooled pending
    expect(row.breakdown!.totalAvailable).toBe(6); // 7 − 1, the pool type's own pending
    const lines = expectSumGuard(row.breakdown!, row.available);
    const explained = explainLeaveSummary(row.breakdown!, { available: row.available, sharedBalance: row.hrExplanation.sharedBalance });
    expect(explained.eligible[0].key).toBe('poolFigures');
    expect(keysOf(explained, 'taken')).toContain('takenPool');
    expect(keysOf(explained, 'pendingApproval')).toContain('pendingOwnOnly');
    expect(keysOf(explained, 'available')).toEqual(['availablePool']);
    // Without the pool descriptor the difference is still stated, never papered over with a formula.
    expect(keysOf(lines, 'available')).toEqual(['availableDiffers']);
  });
});

describe('r303 — Replacement Leave with Leave Credit: credits, an expired credit and a reversal', () => {
  it('Leave Credits are the credits; the expiry and the reversal are other deductions, named from the register', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    const admin = await entitledCtx(b);
    await setToilPolicy(admin, {
      companyId: b.companyId,
      enabled: true,
      accrualBasis: 'hours_worked',
      expiryDays: 90,
      onExpiry: 'lapse',
      allowFirstScheduleEligible: false,
      autoAccrueOnApproval: false,
      carryForwardAtYearEnd: false,
      employeeRequestEnabled: true,
    });
    const emp = await hire('2024-01-01');
    await setCompensation(adminCtx(b), { employmentId: emp.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    // Every Leave Credit service takes an injected `today`, so the fixture is a fixed, past, mid-year date and
    // never straddles a leave-year boundary the clock happens to be near.
    const TODAY = '2026-06-15';
    const back = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    // A Leave Credit can only be earned on a rest day, off day or public holiday.
    for (const n of [1, 2, 3]) await setRestDay(adminCtx(b), { employmentId: emp.employmentId, shiftDate: back(n) });
    const toReverse = await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: back(3), days: 1, reason: 'Entered twice', today: TODAY });
    await grantLeaveCredit(admin, {
      employmentId: emp.employmentId,
      workedDate: back(2),
      days: 0.5,
      reason: 'Half-day cover',
      expiresOn: back(1),
      today: TODAY,
    });
    await grantLeaveCredit(admin, { employmentId: emp.employmentId, workedDate: back(1), days: 2, reason: 'Special approval', today: TODAY });
    await reverseLeaveCredit(admin, { accrualId: toReverse.accrualId, reason: 'Entered twice', today: TODAY });
    await runToilExpiry(admin, { today: TODAY });

    const [rl] = await owner.db
      .select({ id: schema.leaveType.id })
      .from(schema.leaveType)
      .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
    const bd = await hrRead(emp.employmentId, rl.id, TODAY, admin);
    const d = bd.derivation!;
    expect(d.earned.credits.every((c) => c.kind === 'leave_credit')).toBe(true);
    expect(sum(d.earned.credits)).toBe(3.5);
    // The reversal and the expiry are debits with no leave application — listed under Taken, named.
    expect(d.taken.other.map((o) => ({ kind: o.kind, days: o.days })).sort((x, y) => String(x.kind).localeCompare(String(y.kind)))).toEqual([
      { kind: 'credit_expired', days: 0.5 },
      { kind: 'credit_reversed', days: 1 },
    ]);
    expect(d.taken.leaveDays).toBe(0);
    // Independent read: every in_lieu_accrual row of the window is a listed credit.
    const raw = await ledgerWindow(emp.employmentId, rl.id, bd.cycleStart, bd.asOf);
    expect(raw.filter((r) => r.entryType === 'in_lieu_accrual').length).toBe(d.earned.credits.length);
    expect(raw.filter((r) => r.entryType === 'debit').length).toBe(d.taken.other.length);
    const lines = expectSumGuard(bd);
    expect(keysOf(lines, 'taken')).toContain('takenOtherItem');
  });
});

describe('r303 — the sum-guard is load-bearing, not decorative', () => {
  it('a list that stops reaching its figure is replaced by the "could not be listed" sentence, line by line', async () => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 12, validFrom: '2025-01-01' });
    const emp = await hire('2025-01-01', true);
    const approved = await request(emp.employmentId, b.annualLeaveTypeId, 'approved', '2026-03-02', '2026-03-04', 3);
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-03-02', { sourceRequestId: approved });
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', 2, '2026-02-01', { reason: 'CNY 2026' });
    await request(emp.employmentId, b.annualLeaveTypeId, 'pending', '2026-04-01', '2026-04-01', 1);
    const bd = await hrRead(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expectSumGuard(bd);
    const d = bd.derivation!;
    const tampered: LeaveEntitlementBreakdown = {
      ...bd,
      derivation: {
        ...d,
        adjustments: { ...d.adjustments, manual: d.adjustments.manual.map((m) => ({ ...m, days: m.days + 1 })) },
        pending: [],
        taken: { ...d.taken, leaveDays: d.taken.leaveDays - 1 },
      },
    };
    const lines = explainLeaveSummary(tampered, { available: bd.totalAvailable });
    expect(keysOf(lines, 'adjustment')).toEqual(['itemsDoNotAddUp']);
    expect(keysOf(lines, 'taken')).toEqual(['itemsDoNotAddUp']);
    // An EMPTY list against a non-zero figure is guarded too: "no applications waiting" beside 1.00 would be false.
    expect(keysOf(lines, 'pendingApproval')).toEqual(['itemsDoNotAddUp']);
    // The untouched lines still explain themselves.
    expect(keysOf(lines, 'available')).toEqual(['availableFormula']);
    expect(keysOf(lines, 'forfeited')).toEqual(['forfeitNone']);
  });
});
