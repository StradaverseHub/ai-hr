/**
 * Approval summary — decided status counts (feedback 2dec6406). DB tests on the shared harness (the
 * test/claims-rls.test.ts pattern): RLS is the row-visibility authority, so an admin counts org-wide while
 * a manager counts only their reporting line; cancellation and travel decided buckets exclude the viewer's
 * OWN rows (same self-exclusion as their pending lists); claim 'paid' folds into approved; resignation
 * accepted→approved and withdrawn→cancelled; the two review queues return NO decided counts (their
 * outcomes are confirm/extend, not approve/reject).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
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
import { hireEmployee, setReportingLine } from '../core/org';
import { decidedStatusCounts } from '../core/approvals-summary';

const hire = (ctx: SessionContext, b: Base, name: string, departmentId?: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('2dec6406 — decidedStatusCounts', () => {
  let base: Base;
  let E: { personId: string; employmentId: string };
  let M: { personId: string; employmentId: string };
  let X: { personId: string; employmentId: string };
  let mgrCtx: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    const a = adminCtx(base);
    E = await hire(a, base, 'Subject'); // reports to M (deptA)
    M = await hire(a, base, 'Manager'); // deptA
    // OUTSIDE M's line AND M's department tree (deptB) — the RLS manager branches are the recursive
    // administrative down-walk AND the HOD department-tree walk (migration 0109), so a same-department
    // peer WOULD be visible to a managing HOD; deptB keeps X genuinely out of scope.
    X = await hire(a, base, 'Peer', base.deptB);
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    mgrCtx = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
  });
  afterAll(async () => {
    await closeAll();
  });

  const leaveRow = (employmentId: string, status: 'pending' | 'approved' | 'rejected' | 'cancelled') => ({
    tenantId: base.tenantId,
    employmentId,
    leaveTypeId: base.annualLeaveTypeId,
    startDate: '2026-06-01',
    endDate: '2026-06-01',
    days: '1.00',
    status,
  });

  it('leave: admin counts org-wide, a manager only their reporting line (RLS)', async () => {
    await owner.db.insert(schema.leaveRequest).values([
      leaveRow(E.employmentId, 'approved'),
      leaveRow(E.employmentId, 'cancelled'),
      leaveRow(X.employmentId, 'approved'),
      leaveRow(X.employmentId, 'rejected'),
      leaveRow(X.employmentId, 'pending'), // pending never counted here
    ]);

    const adminCounts = await decidedStatusCounts(adminCtx(base), [base.companyId], 'leave');
    expect(adminCounts).toEqual({ approved: 2, rejected: 1, cancelled: 1 });

    // The manager's line is E only — X's decided rows are invisible to them.
    const mgrCounts = await decidedStatusCounts(mgrCtx, [base.companyId], 'leave');
    expect(mgrCounts).toEqual({ approved: 1, rejected: 0, cancelled: 1 });
  });

  it("travel: decided buckets exclude the viewer's own rows; cancelled has no bucket (dash)", async () => {
    await owner.db.insert(schema.travelRequest).values([
      { tenantId: base.tenantId, employmentId: M.employmentId, travelFrom: '2026-06-01', travelTo: '2026-06-02', remarks: 'own trip', status: 'approved' as const },
      { tenantId: base.tenantId, employmentId: E.employmentId, travelFrom: '2026-06-03', travelTo: '2026-06-04', remarks: 'report trip', status: 'approved' as const },
      { tenantId: base.tenantId, employmentId: E.employmentId, travelFrom: '2026-06-05', travelTo: '2026-06-06', remarks: 'report trip 2', status: 'rejected' as const },
    ]);

    // Manager: own approved travel is excluded (same rule as the pending list's self-exclusion).
    expect(await decidedStatusCounts(mgrCtx, [base.companyId], 'travel')).toEqual({
      approved: 1,
      rejected: 1,
      cancelled: null,
    });
    // Admin (no linked person): nothing is "own", counts everything in scope.
    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'travel')).toEqual({
      approved: 2,
      rejected: 1,
      cancelled: null,
    });
  });

  it("leave cancellations: decided buckets exclude the viewer's own rows", async () => {
    const [lrM] = await owner.db.insert(schema.leaveRequest).values(leaveRow(M.employmentId, 'approved')).returning({ id: schema.leaveRequest.id });
    const [lrE] = await owner.db.insert(schema.leaveRequest).values(leaveRow(E.employmentId, 'approved')).returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.leaveCancellationRequest).values([
      { tenantId: base.tenantId, leaveRequestId: lrM.id, employmentId: M.employmentId, cancelDates: ['2026-06-01'], requestedDays: '1.00', status: 'approved' },
      { tenantId: base.tenantId, leaveRequestId: lrE.id, employmentId: E.employmentId, cancelDates: ['2026-06-01'], requestedDays: '1.00', status: 'approved' },
    ]);

    expect(await decidedStatusCounts(mgrCtx, [base.companyId], 'leaveCancellation')).toEqual({
      approved: 1, // E's only — the manager's own cancellation is excluded
      rejected: 0,
      cancelled: null,
    });
    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'leaveCancellation')).toEqual({
      approved: 2,
      rejected: 0,
      cancelled: null,
    });
  });

  it('claims: paid folds into approved; cancelled is a real bucket', async () => {
    const [ct] = await owner.db
      .insert(schema.claimType)
      .values({ tenantId: base.tenantId, code: 'MEDICAL', name: 'Medical' })
      .returning({ id: schema.claimType.id });
    const claim = (status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'paid') => ({
      tenantId: base.tenantId,
      employmentId: E.employmentId,
      claimTypeId: ct.id,
      amount: '50.00',
      incurredOn: '2026-06-01',
      status,
    });
    await owner.db.insert(schema.claimRequest).values([
      claim('approved'),
      claim('paid'),
      claim('rejected'),
      claim('cancelled'),
      claim('pending'),
    ]);

    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'claim')).toEqual({
      approved: 2, // approved + paid
      rejected: 1,
      cancelled: 1,
    });
  });

  it('corrections: split Attendance vs Overtime by the shared predicate', async () => {
    // attendance_correction_at_least_one: a row must carry a proposed time OR requested OT minutes.
    const correction = (employmentId: string, status: 'approved' | 'rejected', ot: number | null) => ({
      tenantId: base.tenantId,
      employmentId,
      attendanceDate: '2026-06-01',
      proposedCheckIn: ot == null ? '09:00:00' : null,
      requestedOtMinutes: ot,
      status,
    });
    await owner.db.insert(schema.attendanceCorrection).values([
      correction(E.employmentId, 'approved', null),
      correction(E.employmentId, 'approved', 90),
      correction(X.employmentId, 'rejected', 120),
    ]);

    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'attendance')).toEqual({
      approved: 1,
      rejected: 0,
      cancelled: null,
    });
    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'overtime')).toEqual({
      approved: 1,
      rejected: 1,
      cancelled: null,
    });
  });

  it('resignations: accepted maps to approved, withdrawn to cancelled', async () => {
    const resignation = (status: 'accepted' | 'rejected' | 'withdrawn') => ({
      tenantId: base.tenantId,
      employmentId: E.employmentId,
      personId: E.personId,
      lastWorkingDay: '2026-08-31',
      status,
    });
    await owner.db.insert(schema.resignationRequest).values([
      resignation('accepted'),
      resignation('rejected'),
      resignation('withdrawn'),
    ]);

    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'resignations')).toEqual({
      approved: 1,
      rejected: 1,
      cancelled: 1,
    });
  });

  it('review categories return NO decided counts (confirm/extend outcomes, not approve/reject)', async () => {
    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'managerReviews')).toEqual({
      approved: null,
      rejected: null,
      cancelled: null,
    });
    expect(await decidedStatusCounts(adminCtx(base), [base.companyId], 'hrReviews')).toEqual({
      approved: null,
      rejected: null,
      cancelled: null,
    });
  });
});
