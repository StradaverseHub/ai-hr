/**
 * r302 fix pass (board 6c9802c9) · MY LEAVE — THE SEVEN VERIFIER DEFECTS, EACH AGAINST THE DECISION THAT FIXES IT.
 *
 * The plan's promise these broke: "You can apply for … is the same figure the Apply Leave form checks against, so
 * the page and the form never disagree." Every arm below failed on build/r302-myleave@2b5d5ef7.
 *
 *   D1 · Balance / You can apply for vs the Apply form when ledger rows are dated AFTER this leave year (leave
 *        booked for next January; next year's entitlement generated early). Balance is the Apply form's balance,
 *        You can apply for its available, Balance − Pending = You can apply for = the popup in every scenario, and
 *        one itemised line — read from the rows dated after this leave year — says what the Balance includes.
 *   D2 · the card's Details side-sheet receives the card's own Pending and available figure.
 *   D3 · a row split off by a partial cancellation shows the ROOT request's approval chain; a split whose lineage
 *        was never recorded shows only "Approved by <name>", with no level numbering.
 *   D4 · every row of one application shows the application's per-date outcome, read from the root's approval event.
 *   D6 · anniversary cycles: selection Y is (currentYear − Y) cycles before the one containing today.
 *   D7 · a per-date rejection's reasons are dates + reasons, never a pre-joined string of ISO dates.
 * (D5, the ring, and the rendering halves of D2/D7 are in test/r302fp-my-leave-fixpass.dom.test.tsx.)
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  availableLeaveBalance,
  decideLeave,
  decideLeaveCancellation,
  decideLeaveDates,
  leaveTypeApplySummary,
  requestLeave,
  requestLeaveCancellation,
} from '../core/leave';
import { leaveEntitlementBreakdown, listLeaveRequestsPage } from '../core/read';
import { myLeaveDashboard, ownLeaveApprovalTrails, ownLeaveCancellations, ownLeaveRejectionReasons, ownLeaveRejections } from '../core/my-leave';
import { applicationDateOutcomeRows, approvalProgress, approverLine, isPartiallyApproved, type HistoryLineDeps } from '../lib/my-leave-history';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nextMonday = (from: string) => {
  let d = from;
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
};

async function person(name: string, role: 'employee' | 'manager' | 'hr_admin', hiredOn = '2019-01-01') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r302fp_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  const ctx: SessionContext = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, e.personId, role), personId: e.personId, roles: [role] };
  return { ...e, ctx };
}
const ledger = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment',
  days: number,
  effectiveOn: string,
  sourceRequestId?: string,
) =>
  owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId, leaveTypeId, entryType, days: days.toFixed(2), effectiveOn, sourceRequestId: sourceRequestId ?? null });

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

// A deterministic translator: key + values, so assertions read the structure, not a catalogue.
const deps: HistoryLineDeps = {
  t: (key, values) => (values ? `${key}${JSON.stringify(values)}` : key),
  kindLabel: (kind) => (kind ? `KIND:${kind}` : null),
  fmtInstant: (d) => (d ? 'T' : null),
  listNames: (n) => n.join('|'),
};

/** The card, the Apply popup and the submit guard for one type — the three figures the plan says never disagree. */
async function figures(emp: Awaited<ReturnType<typeof person>>, T: string) {
  const card = (await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY })).cards.find((c) => c.leaveTypeId === T)!;
  const popup = await leaveTypeApplySummary(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: T });
  const guard = await withTenant(emp.ctx, (tx) => availableLeaveBalance(tx, emp.employmentId, T));
  return { card, popup, guard };
}

function expectInvariant({ card, popup, guard }: Awaited<ReturnType<typeof figures>>) {
  expect(card.balance! - card.pending!, 'Balance − Pending = You can apply for, on the same card').toBe(card.canApplyFor);
  expect(card.canApplyFor, 'You can apply for = the Apply popup’s available').toBe(popup.available);
  expect(card.canApplyFor, '= the submit guard').toBe(guard);
  expect(card.balance, 'Balance = the Apply popup’s balance').toBe(popup.balance);
  expect(card.pending, 'Pending = the Apply popup’s pending').toBe(popup.pending);
}

describe('D1 · rows dated after this leave year: Balance and You can apply for are the Apply form’s, and a line says why', () => {
  it('approved leave booked for next January: invariant holds; Taken stays this year; "2 days booked" itemised', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const T = b.annualLeaveTypeId;
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR}-01-01`);
    const [appr] = await owner.db
      .insert(schema.leaveRequest)
      .values({ tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: T, startDate: `${YEAR + 1}-01-05`, endDate: `${YEAR + 1}-01-06`, days: '2.00', status: 'approved' })
      .returning({ id: schema.leaveRequest.id });
    await ledger(emp.employmentId, T, 'debit', -2, `${YEAR + 1}-01-05`, appr.id);
    const f = await figures(emp, T);
    expectInvariant(f);
    expect(f.card.balance).toBe(12);
    expect(f.card.taken, 'Taken is THIS leave year’s').toBe(0);
    expect(f.card.balanceIncludesLater).toEqual({ span: 'next', granted: 0, booked: 2, itemised: true });
  });

  it('next year’s entitlement generated early: invariant holds; "14 days granted" itemised', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const T = b.annualLeaveTypeId;
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR}-01-01`);
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR + 1}-01-01`);
    const f = await figures(emp, T);
    expectInvariant(f);
    expect(f.card.balance).toBe(28);
    expect(f.card.balanceIncludesLater).toEqual({ span: 'next', granted: 14, booked: 0, itemised: true });
  });

  it('both, plus a pending request and rows two leave years ahead: invariant holds; the line says "later leave years"', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const T = b.annualLeaveTypeId;
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR}-01-01`);
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR + 1}-01-01`);
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR + 2}-01-01`);
    const [appr] = await owner.db
      .insert(schema.leaveRequest)
      .values({ tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: T, startDate: `${YEAR + 1}-02-02`, endDate: `${YEAR + 1}-02-04`, days: '3.00', status: 'approved' })
      .returning({ id: schema.leaveRequest.id });
    await ledger(emp.employmentId, T, 'debit', -3, `${YEAR + 1}-02-02`, appr.id);
    await owner.db
      .insert(schema.leaveRequest)
      .values({ tenantId: b.tenantId, employmentId: emp.employmentId, leaveTypeId: T, startDate: `${YEAR + 1}-03-02`, endDate: `${YEAR + 1}-03-03`, days: '2.00', status: 'pending' });
    const f = await figures(emp, T);
    expectInvariant(f);
    expect(f.card.pending).toBe(2);
    expect(f.card.balanceIncludesLater).toEqual({ span: 'later', granted: 28, booked: 3, itemised: true });
  });

  it('a row after this leave year that is neither a grant nor booked leave is NOT split into a wrong figure', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const T = b.annualLeaveTypeId;
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR}-01-01`);
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR + 1}-01-01`);
    await ledger(emp.employmentId, T, 'adjustment', -4, `${YEAR + 1}-01-01`);
    const f = await figures(emp, T);
    expectInvariant(f);
    expect(f.card.balanceIncludesLater, 'no split printed: "includes other entries dated after this leave year"').toMatchObject({ itemised: false });
  });

  it('nothing after this leave year: no line; an earlier year: unchanged (its own breakdown, no Apply figure, no line)', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const T = b.annualLeaveTypeId;
    await ledger(emp.employmentId, T, 'accrual', 12, `${YEAR - 1}-01-01`);
    await ledger(emp.employmentId, T, 'debit', -2, `${YEAR - 1}-06-01`);
    await ledger(emp.employmentId, T, 'accrual', 14, `${YEAR}-01-01`);
    const f = await figures(emp, T);
    expectInvariant(f);
    expect(f.card.balanceIncludesLater).toBeNull();
    const past = (await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY, year: String(YEAR - 1) })).cards.find((c) => c.leaveTypeId === T)!;
    const bd = await leaveEntitlementBreakdown(emp.ctx, emp.employmentId, T, `${YEAR - 1}-12-31`);
    expect({ balance: past.balance, pending: past.pending, canApplyFor: past.canApplyFor, later: past.balanceIncludesLater }).toEqual({
      balance: bd!.balance,
      pending: bd!.pendingApproval,
      canApplyFor: null,
      later: null,
    });
    expect(past.balance).toBe(10);
  });
});

describe('D2 · the card’s Details side-sheet gets the card’s own Pending and available figure', () => {
  it('part-unpaid pending request: side-sheet Pending Approval = card Pending; side-sheet Available = card You can apply for', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const [T] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: `AU_${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Annual (unpaid ok)', role: 'annual', paid: true, counting: 'calendar_days', visibleToEmployee: true, allowUnpaidLeave: true, allowNegativeBalance: false } as never)
      .returning({ id: schema.leaveType.id });
    await ledger(emp.employmentId, T.id, 'accrual', 5, `${YEAR}-01-01`);
    const start = addDays(TODAY, 3);
    await requestLeave(adminCtx(b), { employmentId: emp.employmentId, leaveTypeId: T.id, startDate: start, endDate: addDays(start, 7), today: TODAY });
    const [pr] = await owner.db.select({ unpaid: schema.leaveRequest.unpaidDays }).from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, emp.employmentId));
    expect(Number(pr.unpaid)).toBeGreaterThan(0);
    const f = await figures(emp, T.id);
    expectInvariant(f);
    expect(f.card.breakdown!.pendingApproval, 'side-sheet Pending Approval = card Pending').toBe(f.card.pending);
    expect(f.card.breakdown!.totalAvailable, 'side-sheet Available Balance = card You can apply for').toBe(f.card.canApplyFor);
    expect([f.card.pending, f.card.canApplyFor]).toEqual([5, 0]);
  });
});

/** A two-level Manager → HR world with an approved five-day leave from next-but-one Monday. */
async function twoLevelApproved() {
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
  const emp = await person('Nadia Employee', 'employee');
  const mgr = await person('Marcus Manager', 'manager');
  const hr = await person('Hana HR', 'hr_admin');
  await setReportingLine(adminCtx(b), { subordinateEmploymentId: emp.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2019-01-01' });
  await ledger(emp.employmentId, b.annualLeaveTypeId, 'accrual', 30, TODAY);
  const MON = nextMonday(addDays(TODAY, 14));
  const { leaveRequestId: id } = await requestLeave(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: addDays(MON, 4), today: TODAY });
  await decideLeave(mgr.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: mgr.employmentId });
  await decideLeave(hr.ctx, { leaveRequestId: id, decision: 'approved', deciderEmploymentId: hr.employmentId });
  return { emp, mgr, hr, id, MON };
}

describe('D3 · a split row’s approval progress is the ROOT request’s chain', () => {
  it('first date given back: the survivor shows BOTH levels (Manager, then HR), not "Level 1 · Hana HR"', async () => {
    const { emp, mgr, hr, id, MON } = await twoLevelApproved();
    const { cancellationRequestId } = await requestLeaveCancellation(emp.ctx, { leaveRequestId: id, cancelDates: [MON], reason: 'Trip moved', today: TODAY });
    await decideLeaveCancellation(mgr.ctx, { cancellationRequestId, decision: 'approved', deciderEmploymentId: mgr.employmentId });
    await decideLeaveCancellation(hr.ctx, { cancellationRequestId, decision: 'approved', deciderEmploymentId: hr.employmentId });

    const rows = (await listLeaveRequestsPage(emp.ctx, { employmentIds: [emp.employmentId], sort: 'start', dir: 'asc', limit: 10, offset: 0 })).rows;
    const survivor = rows.find((r) => r.status === 'approved')!;
    expect(survivor.id, 'the survivor is a NEW row').not.toBe(id);
    const trails = await ownLeaveApprovalTrails(emp.ctx, rows.map((r) => r.id));
    const progress = approvalProgress(survivor, trails.get(survivor.id), undefined, deps).map((s) => `${s.state}:${s.label}`);
    const levels = progress.filter((p) => p.includes('progressLevel'));
    expect(levels, 'the chain had two levels, in order').toEqual([
      'done:myLeave.progressLevelNamed{"level":1,"role":"KIND:direct_manager","name":"Marcus Manager"}',
      'done:myLeave.progressLevelNamed{"level":2,"role":"KIND:hr_admin","name":"Hana HR"}',
    ]);
    expect(approverLine(survivor, trails.get(survivor.id), undefined, deps)).toBe('myLeave.approvedBy{"name":"Hana HR"}');
    expect(trails.get(survivor.id)).toMatchObject({ lineage: 'root', status: 'approved' });
    // Submitted is the APPLICATION's submission, not the moment the cancellation split the row off.
    const [root] = await owner.db.select({ createdAt: schema.leaveRequest.createdAt }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id));
    expect(trails.get(survivor.id)!.submittedAt?.toISOString()).toBe(root.createdAt.toISOString());
    // …and the cancelled original is still its own row, read as before.
    const cancelled = rows.find((r) => r.status === 'cancelled')!;
    expect(cancelled.id).toBe(id);
    const cancels = await ownLeaveCancellations(emp.ctx, [id]);
    expect(approverLine(cancelled, trails.get(id), cancels.get(id), deps)).toBe('myLeave.cancelledBy{"name":"Hana HR"}');
    // The lineage never widens the read: the manager asking about their report's survivor still gets nothing.
    expect((await ownLeaveApprovalTrails(mgr.ctx, [survivor.id])).size).toBe(0);
  });

  it('a split whose lineage was never recorded (before r299): "Approved by <name>" only, no level numbering', async () => {
    const { emp, hr, id, MON } = await twoLevelApproved();
    // A survivor row as a pre-r299 split wrote it: a new approved row carrying the original's decision, and a
    // leave-request.split event WITHOUT splitFromRequestId.
    const [orig] = await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id));
    const [old] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: addDays(MON, 7),
        endDate: addDays(MON, 7),
        days: '1.00',
        status: 'approved',
        parentGroupId: randomUUID(),
        decidedByEmploymentId: orig.decidedByEmploymentId,
        decidedAt: orig.decidedAt,
      })
      .returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.domainEvent).values({
      tenantId: b.tenantId,
      aggregateType: 'leave-request',
      aggregateId: old.id,
      eventType: 'leave-request.split',
      actorType: 'system',
      subjectEmploymentId: emp.employmentId,
      payload: { parentGroupId: randomUUID(), from: addDays(MON, 7), to: addDays(MON, 7), days: 1 } as never,
    });
    expect(orig.decidedByEmploymentId).toBe(hr.employmentId);
    const [row] = (await listLeaveRequestsPage(emp.ctx, { employmentIds: [emp.employmentId], statuses: ['approved'], sort: 'start', dir: 'desc', limit: 1, offset: 0 })).rows;
    expect(row.id).toBe(old.id);
    const trail = (await ownLeaveApprovalTrails(emp.ctx, [old.id])).get(old.id);
    expect(trail).toMatchObject({ lineage: 'unrecorded' });
    const progress = approvalProgress(row, trail, undefined, deps);
    expect(progress.map((s) => s.label), 'never a partial chain presented as the chain').toEqual(['myLeave.approvedBy{"name":"Hana HR"}']);
    expect(approverLine(row, trail, undefined, deps)).toBe('myLeave.approvedBy{"name":"Hana HR"}');
  });
});

describe('D4 · rows of one application all show the application’s per-date outcome', () => {
  it('per-date leave, WED rejected, MON given back: the survivor AND the cancelled original read the same outcome', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const mgr = await person('Marcus Manager', 'manager');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: emp.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2019-01-01' });
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
    await owner.db.update(schema.leaveType).set({ counting: 'working_days', perDateApproval: true, employeeCancelApproved: true } as never).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await ledger(emp.employmentId, b.annualLeaveTypeId, 'accrual', 30, TODAY);
    const MON = nextMonday(addDays(TODAY, 14));
    const TUE = addDays(MON, 1);
    const WED = addDays(MON, 2);
    const { leaveRequestId: id } = await requestLeave(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: WED, today: TODAY });
    await decideLeaveDates(mgr.ctx, {
      leaveRequestId: id,
      deciderEmploymentId: mgr.employmentId,
      decisions: [
        { leaveDate: MON, decision: 'approved' },
        { leaveDate: TUE, decision: 'approved' },
        { leaveDate: WED, decision: 'rejected', rejectReason: 'Audit week' },
      ],
    });
    const { cancellationRequestId } = await requestLeaveCancellation(emp.ctx, { leaveRequestId: id, cancelDates: [MON], reason: 'Plans changed', today: TODAY });
    await decideLeaveCancellation(mgr.ctx, { cancellationRequestId, decision: 'approved', deciderEmploymentId: mgr.employmentId });

    const rows = (await listLeaveRequestsPage(emp.ctx, { employmentIds: [emp.employmentId], sort: 'start', dir: 'asc', limit: 10, offset: 0 })).rows;
    expect(rows.map((r) => r.status).sort()).toEqual(['approved', 'cancelled']);
    const survivor = rows.find((r) => r.status === 'approved')!;
    expect(survivor.hasRejectedDates, 'the precondition: the rejected date’s own row stayed on the original').toBe(false);
    const trails = await ownLeaveApprovalTrails(emp.ctx, rows.map((r) => r.id));
    // UPDATED by the r302 hand-fix after the second verification: the outcome is the application's AS IT STANDS —
    // MON, given back, reads cancelled on both rows (test/r302-my-leave-handfix2.test.ts §1 carries the defect).
    const outcome = { approved: [TUE], rejected: [{ date: WED, reason: 'Audit week' }], cancelled: [MON] };
    for (const r of rows) expect(trails.get(r.id)?.perDateOutcome, `${r.status} row: the application’s outcome`).toEqual(outcome);
    expect(isPartiallyApproved(survivor, trails.get(survivor.id)), 'the survivor reads "Partially approved"').toBe(true);
    expect(applicationDateOutcomeRows(outcome).map((d) => `${d.leaveDate}:${d.status}:${d.rejectReason ?? ''}`)).toEqual([
      `${MON}:cancelled:`,
      `${TUE}:approved:`,
      `${WED}:rejected:Audit week`,
    ]);
    // A plain (never split, never mixed) approval has no per-date outcome to show.
    const plain = await person('Plain Employee', 'employee');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: plain.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2019-01-01' });
    await ledger(plain.employmentId, b.annualLeaveTypeId, 'accrual', 30, TODAY);
    const { leaveRequestId: p } = await requestLeave(plain.ctx, { employmentId: plain.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: TUE, today: TODAY });
    await decideLeaveDates(mgr.ctx, {
      leaveRequestId: p,
      deciderEmploymentId: mgr.employmentId,
      decisions: [
        { leaveDate: MON, decision: 'approved' },
        { leaveDate: TUE, decision: 'approved' },
      ],
    });
    expect((await ownLeaveApprovalTrails(plain.ctx, [p])).get(p)).toMatchObject({ lineage: 'own', perDateOutcome: null });
  });
});

describe('D6 · anniversary cycles: each selection is its own cycle, none repeated, none skipped', () => {
  const dayBefore = (iso: string) => addDays(iso, -1);
  async function threeSelections(hireMonth: string) {
    const emp = await person('Anni Versary', 'employee', `${YEAR - 5}-${hireMonth}-01`);
    const [lt] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: `A2A_${randomUUID().slice(0, 6).toUpperCase()}`, name: 'Anniv type', paid: true, counting: 'calendar_days', visibleToEmployee: true, yearCycleOverride: 'a2a' })
      .returning({ id: schema.leaveType.id });
    await ledger(emp.employmentId, lt.id, 'accrual', 10, `${YEAR - 1}-01-15`);
    await ledger(emp.employmentId, lt.id, 'accrual', 10, `${YEAR - 2}-01-15`);
    const pick = async (year?: string) => {
      const d = await myLeaveDashboard(emp.ctx, emp.employmentId, { today: TODAY, year });
      return d.cards.find((c) => c.leaveTypeId === lt.id)!;
    };
    return [await pick(), await pick(String(YEAR - 1)), await pick(String(YEAR - 2))];
  }
  function expectConsecutive([c0, c1, c2]: Awaited<ReturnType<typeof threeSelections>>, hireMonth: string) {
    expect(c0.cycleStart <= TODAY && TODAY <= c0.cycleEnd, 'the current year shows the cycle containing today').toBe(true);
    expect(c0.isCurrentCycle).toBe(true);
    expect(c1.cycleEnd, `${YEAR - 1} is the cycle immediately before`).toBe(dayBefore(c0.cycleStart));
    expect(c2.cycleEnd, `${YEAR - 2} is the cycle before that`).toBe(dayBefore(c1.cycleStart));
    expect(new Set([c0.cycleStart, c1.cycleStart, c2.cycleStart]).size).toBe(3);
    for (const c of [c0, c1, c2]) expect(c.cycleStart.slice(5)).toBe(`${hireMonth}-01`);
    expect([c1.isCurrentCycle, c2.isCurrentCycle, c1.canApplyFor, c2.canApplyFor]).toEqual([false, false, null, null]);
  }

  it('an October–September type across the current year and the two before', async () => {
    expectConsecutive(await threeSelections('10'), '10');
  });

  it('a cycle that opened LAST calendar year (hire month = next month) — the case that repeated on any date', async () => {
    const month = Number(TODAY.slice(5, 7));
    if (month === 12) return; // no cycle can have opened last calendar year in December
    const hireMonth = String(month + 1).padStart(2, '0');
    expectConsecutive(await threeSelections(hireMonth), hireMonth);
  });
});

describe('D7 · per-date rejection reasons are dates + reasons, never a joined string of ISO dates', () => {
  it('every date rejected with a reason: the whole-request reason is not the joined audit string; each date has its reason', async () => {
    const emp = await person('Nadia Employee', 'employee');
    const mgr = await person('Marcus Manager', 'manager');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: emp.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2019-01-01' });
    await ledger(emp.employmentId, b.annualLeaveTypeId, 'accrual', 30, TODAY);
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
    await owner.db.update(schema.leaveType).set({ counting: 'working_days', perDateApproval: true } as never).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const MON = nextMonday(addDays(TODAY, 14));
    const TUE = addDays(MON, 1);
    const { leaveRequestId: id } = await requestLeave(emp.ctx, { employmentId: emp.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: TUE, today: TODAY });
    await decideLeaveDates(mgr.ctx, {
      leaveRequestId: id,
      deciderEmploymentId: mgr.employmentId,
      decisions: [
        { leaveDate: MON, decision: 'rejected', rejectReason: 'Short staffed' },
        { leaveDate: TUE, decision: 'rejected', rejectReason: 'Audit week' },
      ],
    });
    const whole = (await ownLeaveRejectionReasons(emp.ctx, [id])).get(id);
    expect(whole ?? '', 'no raw ISO date reaches the screen as a reason').not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect((await ownLeaveRejections(emp.ctx, [id])).get(id)).toEqual({
      reason: null,
      dates: [
        { date: MON, reason: 'Short staffed' },
        { date: TUE, reason: 'Audit week' },
      ],
    });
    // A whole-request rejection is unchanged, and nobody else reads either.
    const other = await person('Other Employee', 'employee');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: other.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2019-01-01' });
    await owner.db.update(schema.leaveType).set({ perDateApproval: false } as never).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await ledger(other.employmentId, b.annualLeaveTypeId, 'accrual', 30, TODAY);
    const { leaveRequestId: w } = await requestLeave(other.ctx, { employmentId: other.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: MON, today: TODAY });
    await decideLeave(mgr.ctx, { leaveRequestId: w, decision: 'rejected', deciderEmploymentId: mgr.employmentId, rejectReason: 'Year-end close' });
    expect((await ownLeaveRejections(other.ctx, [w])).get(w)).toEqual({ reason: 'Year-end close', dates: [] });
    expect((await ownLeaveRejectionReasons(other.ctx, [w])).get(w)).toBe('Year-end close');
    expect((await ownLeaveRejections(other.ctx, [id])).size).toBe(0);
  });
});
