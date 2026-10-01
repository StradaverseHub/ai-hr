/**
 * Approval activity history (feedback 44a89810) — the SECURITY-DEFINER read model behind the bell's
 * History tab (app.approval_history, migration 0288) via listApprovalHistory. Covers, against the real
 * DB + RLS:
 *   (a) multi-step leave: a delegate's step clearance is labelled "on behalf of" the delegator (derived
 *       read-side — no payload marker), with the delegate's NAME resolved for a non-admin viewer; the HR
 *       finalization row carries no on-behalf; decider filter pins to the stand-in;
 *   (b) per-date path: a delegate's leave-request.date.decided row carries the on-behalf label;
 *   (c) a normal manager decision carries no on-behalf label;
 *   (d) historical labelling is derived purely from reporting_line (payload has no marker);
 *   (e) filters narrow correctly: module, action, dates, decider;
 *   (f) resignation.accepted surfaces with the Approved action;
 *   (g) an encashment auto-rejection surfaces as System (automatic), not the approving admin;
 *   (h) visibility: unrelated manager sees nothing; admin sees all; the viewer's OWN requests are excluded;
 *   (i) timezone boundary: 23:30 MYT on the window's last day is on-behalf; the next MYT day is not.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { resolveEntitlementsTx } from '../core/entitlements';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { decideLeave, decideLeaveDate, requestLeave } from '../core/leave';
import { createClaimType, decideClaim, submitClaim } from '../core/claims';
import { decideAttendanceCorrection, requestAttendanceCorrection } from '../core/attendance';
import { decideResignation, submitResignation } from '../core/offboarding';
import { setEncashmentPolicy } from '../core/leave-encashment';
import { approvalHistoryCount, listApprovalHistory } from '../core/read';
import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVAL_HISTORY_MODULES,
  actionKeyOf,
  aggregateTypesOfModule,
  moduleOfAggregate,
  shapeApprovalHistoryItems,
} from '../lib/approval-history';
import en from '../messages/en.json';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const A = (base: Base) => adminCtx(base);
const uniq = () => `${randomUUID().slice(0, 8)}@t.local`;

async function hire(name: string) {
  return hireEmployee(A(b), {
    person: { fullName: name, primaryEmail: uniq() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}
async function adminLine(sub: string, mgr: string, validFrom = '2024-01-01') {
  return setReportingLine(A(b), { subordinateEmploymentId: sub, managerEmploymentId: mgr, lineType: 'administrative', validFrom });
}
async function delegate(delegatorEmp: string, delegateEmp: string, validFrom = '2024-01-01', validTo: string | null = null) {
  return setReportingLine(A(b), { subordinateEmploymentId: delegatorEmp, managerEmploymentId: delegateEmp, lineType: 'delegate', validFrom, validTo });
}
async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
  const uid = await createAppUser(b.tenantId, personId, role);
  // r292: resolve a REAL entitlement snapshot. The pack services are now bound to withModuleTenant(),
  // so a context with no snapshot throws EntitlementsUnresolvedError. Do NOT swap this for
  // `entitlementsExempt`: every gated pack (attendance, payroll, claims, performance) is billable: true,
  // and an exempt context asked about a billable module throws EntitlementsExemptForBillableError by
  // design — an exemption asserts "entitlements do not apply to me", true only of a core module.
  const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, b.tenantId));
  return { tenantId: b.tenantId, userId: uid, roles: [role], personId, entitlements };
}
/** Seed an ANNUAL balance so terminal approval passes the approval-time balance guard. */
async function grantAnnual(employmentId: string, days = '20') {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
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
  // r79 0322 — the company's default chain decides single- vs multi-step now (there is no
  // company.leave_multi_approval switch). Most cases here are single-approver manager decisions, so the
  // company starts on a ONE-step chain — the shape the old opted-out default produced. Case (a+d)
  // overrides it with an explicit two-step chain where it needs one.
  await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, levels: ['direct_manager'] });
});

describe('Approval activity history (44a89810)', () => {
  it('(a+d) multi-step leave: delegate step row is on-behalf (derived, no payload marker); HR finalization is not; decider filter pins to the stand-in', async () => {
    const mgr = await hire('LMgr');
    const sub = await hire('LSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('Stand');
    // baf56348 same-level guard: a delegation now requires the stand-in to hold the delegator's approval
    // level. Give the stand-in one administrative report so both sides are line managers as of validFrom.
    const standSub = await hire('StandSub');
    await adminLine(standSub.employmentId, stand.employmentId);
    await grantAnnual(sub.employmentId);
    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    await delegate(mgr.employmentId, stand.employmentId);

    // The stand-in clears the direct_manager step; HR (admin) finalizes.
    const standCtx = await userCtx(stand.personId, 'manager');
    const res = await decideLeave(standCtx, { leaveRequestId, decision: 'approved' });
    expect((res as { advancedTo?: string }).advancedTo).toBe('hr_admin');
    await decideLeave(A(b), { leaveRequestId, decision: 'approved' });

    // Viewer = the ORIGINAL manager (non-admin). The definer boundary must resolve the stand-in's name
    // even though person RLS would hide a peer from a plain join.
    const mgrCtx = await userCtx(mgr.personId, 'manager');
    const rows = await listApprovalHistory(mgrCtx);
    const step = rows.find((r) => r.aggregateId === leaveRequestId && r.eventType === 'leave-request.step.approved');
    const final = rows.find((r) => r.aggregateId === leaveRequestId && r.eventType === 'leave-request.approved');
    expect(step).toBeTruthy();
    expect(step!.deciderName).toBe('Stand');
    expect(step!.onBehalfOfName).toBe('LMgr');
    expect(step!.subjectName).toBe('LSub');
    // (d) derived purely from reporting_line — the payload carries NO on-behalf/decidedVia marker.
    expect(Object.keys((step!.payload ?? {}) as Record<string, unknown>).sort()).toEqual(['kind', 'nextKind', 'step']);
    // The HR finalization is a separate row with no on-behalf.
    expect(final).toBeTruthy();
    expect(final!.onBehalfOfName).toBeNull();
    expect(actionKeyOf(step!.eventType, step!.payload)).toBe('stepApproved');

    // Decider filter accepts the stand-in's EMPLOYMENT id (mapped to their app_user server-side).
    const byStand = await listApprovalHistory(mgrCtx, { deciderEmploymentId: stand.employmentId });
    expect(byStand.map((r) => r.eventType)).toEqual(['leave-request.step.approved']);
  });

  it('(b) per-date path: a delegate leave-request.date.decided row carries the on-behalf label', async () => {
    const mgr = await hire('PMgr');
    const sub = await hire('PSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('PStand');
    // baf56348 same-level guard — see test (a+d).
    const standSub = await hire('PStandSub');
    await adminLine(standSub.employmentId, stand.employmentId);
    await delegate(mgr.employmentId, stand.employmentId);
    // A per-date-eligible type: working-days counting + perDateApproval, single-step company (seedBase
    // default), multi-working-day span (Mon 2026-07-06 → Wed 2026-07-08).
    const [flex] = await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: 'FLEXI',
        name: 'Flexi Leave',
        paid: true,
        allowNegativeBalance: true,
        counting: 'working_days',
        perDateApproval: true,
      })
      .returning({ id: schema.leaveType.id });
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: flex.id,
      startDate: '2026-07-06',
      endDate: '2026-07-08',
    });
    // The stand-in decides ONE date (others stay pending, so no finalization under the delegate ctx).
    const standCtx = await userCtx(stand.personId, 'manager');
    await decideLeaveDate(standCtx, { leaveRequestId, leaveDate: '2026-07-06', decision: 'approved' });

    const mgrCtx = await userCtx(mgr.personId, 'manager');
    const rows = await listApprovalHistory(mgrCtx);
    const dateRow = rows.find((r) => r.aggregateId === leaveRequestId && r.eventType === 'leave-request.date.decided');
    expect(dateRow).toBeTruthy();
    expect(dateRow!.deciderName).toBe('PStand');
    expect(dateRow!.onBehalfOfName).toBe('PMgr');
    expect(actionKeyOf(dateRow!.eventType, dateRow!.payload)).toBe('perDayDecision');
  });

  it('(c) a normal manager decision carries no on-behalf label', async () => {
    const mgr = await hire('CMgr');
    const sub = await hire('CSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    await grantAnnual(sub.employmentId);
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-02',
      endDate: '2026-07-02',
    });
    const mgrCtx = await userCtx(mgr.personId, 'manager');
    await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' });

    const rows = await listApprovalHistory(mgrCtx);
    const row = rows.find((r) => r.aggregateId === leaveRequestId && r.eventType === 'leave-request.approved');
    expect(row).toBeTruthy();
    expect(row!.deciderName).toBe('CMgr');
    expect(row!.onBehalfOfName).toBeNull();
    expect(row!.isAuto).toBe(false);
  });

  it('(e) filters narrow correctly: module, action, dates, decider', async () => {
    const mgr = await hire('FMgr');
    const sub = await hire('FSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const mgrCtx = await userCtx(mgr.personId, 'manager');
    // A claim APPROVED and an attendance correction REJECTED — both decided by the NORMAL manager
    // (delegation is non-functional for those modules today, so no delegate decisions are seeded here).
    const { id: typeId } = await createClaimType(A(b), { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false, maxReceiptAgeDays: 36500 });
    const { id: claimId } = await submitClaim(A(b), { employmentId: sub.employmentId, claimTypeId: typeId, amount: 120, incurredOn: '2026-07-01' });
    await decideClaim(mgrCtx, { claimRequestId: claimId, decision: 'approve' });
    const { correctionId } = await requestAttendanceCorrection(A(b), {
      employmentId: sub.employmentId,
      date: '2026-07-01',
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Forgot to clock in',
    });
    await decideAttendanceCorrection(mgrCtx, { correctionId, decision: 'rejected', rejectReason: 'Fixture rejection explanation' });

    const all = await listApprovalHistory(mgrCtx);
    expect(all.map((r) => r.eventType).sort()).toEqual(['attendance-correction.rejected', 'claim-request.approved']);

    // Module (area) filter.
    const claims = await listApprovalHistory(mgrCtx, { module: 'claims' });
    expect(claims.map((r) => r.eventType)).toEqual(['claim-request.approved']);
    const att = await listApprovalHistory(mgrCtx, { module: 'attendance' });
    expect(att.map((r) => r.eventType)).toEqual(['attendance-correction.rejected']);

    // Action filter.
    const approved = await listApprovalHistory(mgrCtx, { action: 'approved' });
    expect(approved.map((r) => r.eventType)).toEqual(['claim-request.approved']);
    const rejected = await listApprovalHistory(mgrCtx, { action: 'rejected' });
    expect(rejected.map((r) => r.eventType)).toEqual(['attendance-correction.rejected']);

    // Date bounds (occurred_at is "now": a window around now matches, a future-only window does not).
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(await listApprovalHistory(mgrCtx, { from: past, to: future })).toHaveLength(2);
    expect(await listApprovalHistory(mgrCtx, { from: future })).toHaveLength(0);
    expect(await listApprovalHistory(mgrCtx, { to: past })).toHaveLength(0);

    // Decider filter (employment id → actor mapping).
    expect(await listApprovalHistory(mgrCtx, { deciderEmploymentId: mgr.employmentId })).toHaveLength(2);
    expect(await listApprovalHistory(mgrCtx, { deciderEmploymentId: sub.employmentId })).toHaveLength(0);
  });

  it('(f) resignation.accepted appears with the Approved action', async () => {
    const emp = await hire('Resigner');
    const empCtx = await userCtx(emp.personId, 'employee');
    const { requestId } = await submitResignation(empCtx, { employmentId: emp.employmentId, lastWorkingDay: '2026-12-31' });
    await decideResignation(A(b), { requestId, decision: 'accepted' });

    const rows = await listApprovalHistory(A(b));
    const row = rows.find((r) => r.eventType === 'resignation.accepted');
    expect(row).toBeTruthy();
    expect(row!.subjectName).toBe('Resigner');
    expect(actionKeyOf(row!.eventType, row!.payload)).toBe('approved');
    // The coarse action filter groups resignation.accepted under Approved.
    const approved = await listApprovalHistory(A(b), { action: 'approved' });
    expect(approved.some((r) => r.eventType === 'resignation.accepted')).toBe(true);
  });

  it('(g) an encashment auto-rejection surfaces as System (automatic), not the approving admin', async () => {
    const emp = await hire('Leaver');
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'accrual',
      days: '10',
      effectiveOn: '2026-01-01',
    });
    await setEncashmentPolicy(A(b), { companyId: b.companyId, enabled: true, autoFreeze: true });
    // A pending AL request BEFORE the resignation is approved → auto-rejected at freeze time.
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-10',
      endDate: '2026-07-10',
    });
    const empCtx = await userCtx(emp.personId, 'employee');
    const { requestId } = await submitResignation(empCtx, { employmentId: emp.employmentId, lastWorkingDay: '2026-12-31' });
    await decideResignation(A(b), { requestId, decision: 'accepted' });

    const rows = await listApprovalHistory(A(b));
    const autoRow = rows.find((r) => r.aggregateId === leaveRequestId && r.eventType === 'leave-request.rejected');
    expect(autoRow).toBeTruthy();
    expect(autoRow!.isAuto).toBe(true);
    expect(autoRow!.onBehalfOfName).toBeNull();
  });

  it('(h) visibility: unrelated manager sees none; admin sees all; the viewer\'s OWN requests are excluded', async () => {
    const mgrA = await hire('VMgrA');
    const subA = await hire('VSubA');
    await adminLine(subA.employmentId, mgrA.employmentId);
    const mgrB = await hire('VMgrB');
    const subB = await hire('VSubB');
    await adminLine(subB.employmentId, mgrB.employmentId);
    const mgrACtx = await userCtx(mgrA.personId, 'manager');
    await grantAnnual(subA.employmentId);
    await grantAnnual(mgrA.employmentId);

    // mgrA decides subA's leave; admin decides mgrA's OWN leave.
    const { leaveRequestId: lrSub } = await requestLeave(A(b), {
      employmentId: subA.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    await decideLeave(mgrACtx, { leaveRequestId: lrSub, decision: 'approved' });
    const { leaveRequestId: lrOwn } = await requestLeave(A(b), {
      employmentId: mgrA.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-02',
      endDate: '2026-07-02',
    });
    await decideLeave(A(b), { leaveRequestId: lrOwn, decision: 'approved' });

    // Unrelated manager: sees NONE of these rows.
    const mgrBCtx = await userCtx(mgrB.personId, 'manager');
    expect(await listApprovalHistory(mgrBCtx)).toHaveLength(0);

    // Admin: sees both decisions.
    const adminRows = await listApprovalHistory(A(b));
    expect(adminRows.some((r) => r.aggregateId === lrSub)).toBe(true);
    expect(adminRows.some((r) => r.aggregateId === lrOwn)).toBe(true);

    // The viewer's OWN request is excluded from their team history (subA's is visible).
    const mine = await listApprovalHistory(mgrACtx);
    expect(mine.some((r) => r.aggregateId === lrSub)).toBe(true);
    expect(mine.some((r) => r.aggregateId === lrOwn)).toBe(false);

    // fc776376 — the pager's total runs the SAME definer function, so it counts exactly the rows this
    // viewer can reach: the unrelated manager's total is 0, and a paged read never promises more.
    expect(await approvalHistoryCount(mgrBCtx)).toBe(0);
    expect(await approvalHistoryCount(mgrACtx)).toBe(mine.length);
    expect(await approvalHistoryCount(A(b))).toBe(adminRows.length);
    const firstPage = await listApprovalHistory(A(b), { limit: 1, offset: 0 });
    expect(firstPage).toHaveLength(1);
    expect(await approvalHistoryCount(A(b))).toBe(adminRows.length);
  });

  it('(i) timezone boundary: 23:30 MYT on the window\'s last day is on-behalf; the next MYT day is not', async () => {
    const mgr = await hire('TMgr');
    const sub1 = await hire('TSub1');
    const sub2 = await hire('TSub2');
    await adminLine(sub1.employmentId, mgr.employmentId);
    await adminLine(sub2.employmentId, mgr.employmentId);
    const stand = await hire('TStand');
    // baf56348 same-level guard — see test (a+d).
    const standSub = await hire('TStandSub');
    await adminLine(standSub.employmentId, stand.employmentId);
    const { reportingLineId } = await delegate(mgr.employmentId, stand.employmentId);
    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const { leaveRequestId: lr1 } = await requestLeave(A(b), {
      employmentId: sub1.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    const { leaveRequestId: lr2 } = await requestLeave(A(b), {
      employmentId: sub2.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-02',
      endDate: '2026-07-02',
    });
    const standCtx = await userCtx(stand.personId, 'manager');
    await decideLeave(standCtx, { leaveRequestId: lr1, decision: 'approved' });
    await decideLeave(standCtx, { leaveRequestId: lr2, decision: 'approved' });

    // Rewrite history (owner bypasses RLS/append-only): the delegation window becomes 2026-07-01 →
    // 2026-07-03 EXCLUSIVE (active days: 07-01 and 07-02 MYT), and the two step decisions land at
    // 2026-07-02T15:30Z = 23:30 MYT on the LAST active day, and 2026-07-02T16:30Z = 00:30 MYT 07-03
    // (already outside the window in MYT even though still 07-02 in UTC).
    await owner.db
      .update(schema.reportingLine)
      .set({ validFrom: '2026-07-01', validTo: '2026-07-03' })
      .where(eq(schema.reportingLine.id, reportingLineId));
    await owner.db
      .update(schema.domainEvent)
      .set({ occurredAt: new Date('2026-07-02T15:30:00Z') })
      .where(and(eq(schema.domainEvent.aggregateId, lr1), eq(schema.domainEvent.eventType, 'leave-request.step.approved')));
    await owner.db
      .update(schema.domainEvent)
      .set({ occurredAt: new Date('2026-07-02T16:30:00Z') })
      .where(and(eq(schema.domainEvent.aggregateId, lr2), eq(schema.domainEvent.eventType, 'leave-request.step.approved')));

    const mgrCtx = await userCtx(mgr.personId, 'manager');
    const rows = await listApprovalHistory(mgrCtx);
    const inWindow = rows.find((r) => r.aggregateId === lr1 && r.eventType === 'leave-request.step.approved');
    const outOfWindow = rows.find((r) => r.aggregateId === lr2 && r.eventType === 'leave-request.step.approved');
    expect(inWindow).toBeTruthy();
    expect(inWindow!.onBehalfOfName).toBe('TMgr');
    expect(outOfWindow).toBeTruthy();
    expect(outOfWindow!.onBehalfOfName).toBeNull();
  });
});

/**
 * b833a077 (r362) — THE TRAVEL MAPPING IS KEPT ALTHOUGH THE FEATURE IS REMOVED, AND NOTHING PINNED IT.
 *
 * My Travel was removed completely this round: the menu row, the screen, the form, the approvals section,
 * the bell task and core/travel-request.ts are gone. `lib/approval-history.ts` KEEPS its travel mapping,
 * and that is a deliberate decision, not leftover dead code — but it was a decision held only by a
 * comment. Measured before writing this: deleting `'travel'` from APPROVAL_HISTORY_MODULES and both maps
 * passes `tsc --noEmit` and leaves every test in this file green.
 *
 * WHAT THE DELETION WOULD ACTUALLY DO. `shapeApprovalHistoryItems` resolves the label with
 * `moduleOfAggregate[r.aggregateType] ?? 'leave'`. So a historic travel decision would not render blank —
 * it would render as **Leave**, in the bell's History tab and on /approvals/history, for every tenant.
 * A silent mislabel of an audit record is worse than a gap, and the fallback is why no type and no test
 * noticed.
 *
 * WHY THE ROWS ARE STILL THERE TO MISLABEL. The read model's event allowlist is hard-coded inside
 * IMMUTABLE migrations — `0288_approval_history.sql` and `0320_approval_history_count.sql` both name
 * `travel-request.approved` and `travel-request.rejected`. A migration cannot be edited, so those rows
 * keep arriving whatever the application does. This guard reads the migrations rather than restating
 * them, so it stays true by derivation: if a LATER migration ever drops travel from the allowlist, the
 * first case here fails and says the mapping may be retired.
 *
 * Source-static, no DB.
 */
describe('b833a077: approval history keeps its travel mapping because the migrations still emit travel rows', () => {
  const MIGRATIONS = ['0288_approval_history.sql', '0320_approval_history_count.sql'];
  const allowlistOf = (file: string): string[] => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../db/migrations', file), 'utf8');
    const m = sql.match(/de\.event_type IN \(([\s\S]*?)\)/);
    expect(m, `${file} must still carry a de.event_type IN (...) allowlist`).toBeTruthy();
    return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  it('both immutable migrations still name the two travel decision events', () => {
    for (const file of MIGRATIONS) {
      const types = allowlistOf(file);
      expect(types, `${file} allowlist`).toContain('travel-request.approved');
      expect(types, `${file} allowlist`).toContain('travel-request.rejected');
    }
  });

  it('so the client-side mapping for travel-request MUST stay, or historic rows render as "Leave"', () => {
    expect(
      moduleOfAggregate['travel-request'],
      'dropping this entry makes shapeApprovalHistoryItems fall back to `leave` and MISLABEL every ' +
        'historic travel decision — the fallback is `?? \'leave\'`, not undefined, so nothing would throw',
    ).toBe('travel');
    expect(
      (APPROVAL_HISTORY_MODULES as readonly string[]).includes('travel'),
      'the travel module must stay in the filter vocabulary, or the History tab offers no way to see ' +
        'the kept records',
    ).toBe(true);
    expect(aggregateTypesOfModule.travel, 'the module filter must still resolve to its aggregate').toEqual([
      'travel-request',
    ]);
    expect(typeof en.approvalHistory.module.travel, 'approvalHistory.module.travel is LIVE, not retired').toBe(
      'string',
    );
    expect(en.approvalHistory.module.travel, 'and must not carry a retirement marker').not.toMatch(
      /^\[retired/,
    );
  });

  it('the end-to-end consequence: a travel-request row shapes to the travel module, never to leave', () => {
    const [item] = shapeApprovalHistoryItems([
      {
        id: 'row-1',
        aggregateType: 'travel-request',
        eventType: 'travel-request.approved',
        occurredAt: new Date('2026-06-01T02:00:00Z'),
        subjectName: 'Someone',
        deciderName: 'Approver',
        isAuto: false,
        onBehalfOfName: null,
        payload: null,
      },
    ]);
    expect(item.moduleKey, 'a kept travel record must still say "Travel" in the History tab').toBe('travel');
  });

  /**
   * The general form, so the next removal cannot repeat this. Every aggregate the client maps must land
   * on a module that exists, carries at least one aggregate back, and has a LIVE label.
   */
  it('every mapped aggregate resolves to a real, labelled, non-empty module', () => {
    for (const [aggregate, moduleKey] of Object.entries(moduleOfAggregate)) {
      expect(
        (APPROVAL_HISTORY_MODULES as readonly string[]).includes(moduleKey),
        `${aggregate} maps to the unknown module ${moduleKey}`,
      ).toBe(true);
      expect(aggregateTypesOfModule[moduleKey], `${moduleKey} has no aggregate list`).toContain(aggregate);
      const label = (en.approvalHistory.module as Record<string, string>)[moduleKey];
      expect(typeof label, `approvalHistory.module.${moduleKey}`).toBe('string');
      expect(label, `approvalHistory.module.${moduleKey} must not be retired while rows still map to it`).not.toMatch(
        /^\[retired/,
      );
    }
  });
});
