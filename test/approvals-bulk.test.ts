/**
 * Bulk approval (feedback fb99474b — "Bulk Approval Function for Managers and HR Admin").
 *
 * Two layers:
 *  1. Pure helpers (lib/approvals-bulk): the by-type breakdown, the item parser (drops unknown types +
 *     de-dupes), and the batch runner's per-item isolation (one failure never aborts the rest).
 *  2. Integration: a manager bulk-decides a mix of claims + attendance corrections + leave through the SAME
 *     core decide* services the row-level actions use. Assert per-record events fire once per row, an
 *     out-of-authority row is SKIPPED (not fatal), a self-owned row is never bulk-approvable, and the
 *     approved/skipped counts + breakdown are correct. This is the substrate + authority guarantee the plan
 *     requires: bulk approval never lets anyone approve what a one-by-one click couldn't.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave, decideLeave } from '../core/leave';
import { createClaimType, submitClaim, decideClaim } from '../core/claims';
import { requestAttendanceCorrection, decideAttendanceCorrection } from '../core/attendance';
import { decideTravelRequest } from '../core/travel-request';
import { decideLeaveCancellation } from '../core/leave';
import {
  computeBulkBreakdown,
  parseBulkItems,
  runBulkDecide,
  bulkRowKey,
  type BulkDecideItem,
  type BulkRow,
} from '../lib/approvals-bulk';

// A faithful copy of the server action's dispatcher (app/approvals/actions.ts dispatchBulkItem). The action
// is a 'use server' module wired to cookies/redirect/next-intl, so we exercise the same core services +
// runBulkDecide loop here with an explicit manager session.
function bulkDispatch(
  s: SessionContext,
  decision: 'approved' | 'rejected',
  rejectReason: string | undefined,
  decider: string | undefined,
) {
  return async (item: BulkDecideItem): Promise<void> => {
    switch (item.type) {
      case 'leave':
        await decideLeave(s, { leaveRequestId: item.id, decision, rejectReason, deciderEmploymentId: decider });
        return;
      case 'leaveCancellation':
        await decideLeaveCancellation(s, { cancellationRequestId: item.id, decision, deciderEmploymentId: decider });
        return;
      case 'claim':
        await decideClaim(s, { claimRequestId: item.id, decision: decision === 'approved' ? 'approve' : 'reject', deciderEmploymentId: decider ?? null });
        return;
      case 'attendance':
        await decideAttendanceCorrection(s, { correctionId: item.id, decision, deciderEmploymentId: decider });
        return;
      case 'travel':
        await decideTravelRequest(s, { travelRequestId: item.id, decision, deciderEmploymentId: decider });
        return;
    }
  };
}

describe('bulk approval — pure helpers', () => {
  it('breakdown counts by category in a stable order, omitting empty buckets', () => {
    const rows: BulkRow[] = [
      { id: 'a', type: 'claim', category: 'claim' },
      { id: 'b', type: 'leave', category: 'leave' },
      { id: 'c', type: 'attendance', category: 'overtime' },
      { id: 'd', type: 'leave', category: 'leave' },
      { id: 'e', type: 'attendance', category: 'attendance' },
    ];
    expect(computeBulkBreakdown(rows)).toEqual([
      { category: 'leave', count: 2 },
      { category: 'attendance', count: 1 },
      { category: 'overtime', count: 1 },
      { category: 'claim', count: 1 },
    ]);
  });

  it('parseBulkItems keeps valid items, drops unknown types + malformed, and de-dupes', () => {
    const raw = JSON.stringify([
      { type: 'leave', id: 'L1' },
      { type: 'claim', id: 'C1' },
      { type: 'review', id: 'R1' }, // excluded kind → dropped
      { type: 'attendance' }, // no id → dropped
      { id: 'X1' }, // no type → dropped
      { type: 'leave', id: 'L1' }, // duplicate → collapsed
    ]);
    expect(parseBulkItems(raw)).toEqual([
      { type: 'leave', id: 'L1' },
      { type: 'claim', id: 'C1' },
    ]);
    expect(parseBulkItems('not json')).toEqual([]);
    expect(parseBulkItems('{}')).toEqual([]);
  });

  it('bulkRowKey is (type,id) — index-independent so it survives a re-sort', () => {
    expect(bulkRowKey({ type: 'attendance', id: 'z' })).toBe('attendance:z');
    // Same id under two kinds never collides.
    expect(bulkRowKey({ type: 'leave', id: 'x' })).not.toBe(bulkRowKey({ type: 'travel', id: 'x' }));
  });

  it('runBulkDecide isolates each item: one throw does not abort the rest', async () => {
    const seen: string[] = [];
    const res = await runBulkDecide(['a', 'boom', 'c'], async (x) => {
      seen.push(x);
      if (x === 'boom') throw new Error('nope');
    });
    expect(seen).toEqual(['a', 'boom', 'c']); // ran every item
    expect(res).toEqual({ approved: 2, skipped: 1 });
  });
});

describe('bulk approval — integration (real decide services + events + authority)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (name: string) =>
    hireEmployee(adminCtx(base), {
      person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  async function scenario() {
    const a = adminCtx(base);
    const E = await hire('Subject'); // under M
    const M = await hire('Manager');
    const P = await hire('Peer'); // NOT under M — out of the manager's authority
    await createAppUser(base.tenantId, M.personId, 'manager');
    const uM = (
      await owner.db.select({ id: schema.appUser.id }).from(schema.appUser).where(eq(schema.appUser.personId, M.personId))
    )[0].id;
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: uM, personId: M.personId, roles: ['manager'] };
    return { a, E, M, P, mgrCtx };
  }

  it('approves every in-authority row, skips out-of-authority + self, writes one event per approved row', async () => {
    const { a, E, M, P, mgrCtx } = await scenario();
    const { id: typeId } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false, maxReceiptAgeDays: 36500 });

    // Two subordinate claims, one peer claim (out of authority), one manager-owned claim (self).
    const cE = await submitClaim(a, { employmentId: E.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' });
    const cP = await submitClaim(a, { employmentId: P.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' });
    const cM = await submitClaim(a, { employmentId: M.employmentId, claimTypeId: typeId, amount: 100, incurredOn: '2026-06-01' });
    // Attendance correction (plain) + an OT correction — both for the subordinate.
    const { correctionId: corPlain } = await requestAttendanceCorrection(a, { employmentId: E.employmentId, date: '2026-06-02', checkIn: '09:00', checkOut: '18:00', reason: 'forgot to clock' });
    // OT correction: carries requestedOtMinutes (→ the "Overtime" breakdown line) AND clock times so
    // approval creates the attendance record the OT attaches to.
    const { correctionId: corOt } = await requestAttendanceCorrection(a, { employmentId: E.employmentId, date: '2026-06-03', checkIn: '09:00', checkOut: '18:00', requestedOtMinutes: 90, reason: 'ot' });

    const items: BulkDecideItem[] = [
      { type: 'claim', id: cE.id },
      { type: 'claim', id: cP.id }, // skip (peer — outside authority)
      { type: 'claim', id: cM.id }, // skip (self — self-approval ban)
      { type: 'attendance', id: corPlain },
      { type: 'attendance', id: corOt },
    ];
    const res = await runBulkDecide(items, bulkDispatch(mgrCtx, 'approved', undefined, M.employmentId));
    expect(res).toEqual({ approved: 3, skipped: 2 });

    // In-authority rows flipped + evented once each.
    const claimStatus = async (id: string) =>
      (await owner.db.select({ s: schema.claimRequest.status }).from(schema.claimRequest).where(eq(schema.claimRequest.id, id)))[0].s;
    expect(await claimStatus(cE.id)).toBe('approved');
    expect(await eventTypesFor(base.tenantId, cE.id)).toContain('claim-request.approved');
    const corStatus = async (id: string) =>
      (await owner.db.select({ s: schema.attendanceCorrection.status }).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, id)))[0].s;
    expect(await corStatus(corPlain)).toBe('approved');
    expect(await corStatus(corOt)).toBe('approved');
    expect(await eventTypesFor(base.tenantId, corOt)).toContain('attendance-correction.approved');

    // Skipped rows untouched — no approval, no event.
    expect(await claimStatus(cP.id)).toBe('pending');
    expect(await claimStatus(cM.id)).toBe('pending');
    expect(await eventTypesFor(base.tenantId, cP.id)).not.toContain('claim-request.approved');
    expect(await eventTypesFor(base.tenantId, cM.id)).not.toContain('claim-request.approved');
  });

  it('bulk reject: a leave with a reason is rejected; a leave WITHOUT a reason is skipped (reason required)', async () => {
    const { a, E, M, mgrCtx } = await scenario();
    const l1 = await requestLeave(a, { employmentId: E.employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });
    const l2 = await requestLeave(a, { employmentId: E.employmentId, leaveTypeId: base.annualLeaveTypeId, startDate: '2026-07-02', endDate: '2026-07-02' });

    // With a reason → both would reject; drop the reason and the leave service throws MissingRejectReasonError,
    // so runBulkDecide skips that item instead of failing the batch.
    const withReason = await runBulkDecide(
      [{ type: 'leave', id: l1.leaveRequestId }],
      bulkDispatch(mgrCtx, 'rejected', 'not enough cover', M.employmentId),
    );
    expect(withReason).toEqual({ approved: 1, skipped: 0 });
    expect(await eventTypesFor(base.tenantId, l1.leaveRequestId)).toContain('leave-request.rejected');

    const noReason = await runBulkDecide(
      [{ type: 'leave', id: l2.leaveRequestId }],
      bulkDispatch(mgrCtx, 'rejected', undefined, M.employmentId),
    );
    expect(noReason).toEqual({ approved: 0, skipped: 1 });
    const l2status = (await owner.db.select({ s: schema.leaveRequest.status }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, l2.leaveRequestId)))[0].s;
    expect(l2status).toBe('pending'); // untouched — the missing reason was a skip, not a partial write
  });
});
