import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminCtx, createAppUser, eventTypesFor, owner, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  decideResignation,
  listResignationRequests,
  myResignation,
  ResignationError,
  submitResignation,
  withdrawResignation,
} from '../core/offboarding';

let base: Base;
beforeAll(async () => {
  base = await seedBase();
});

const hire = (ctx: SessionContext, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const empCtxFor = async (personId: string): Promise<SessionContext> => {
  const uid = await createAppUser(base.tenantId, personId, 'employee');
  return { tenantId: base.tenantId, userId: uid, personId, roles: ['employee'] };
};

const empRow = async (employmentId: string) => {
  const [row] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
  return row;
};

describe('#29 resignation self-service (ADR-0042)', () => {
  it('submit leaves employment active; accept terminates it (voluntary) on the last working day', async () => {
    const a = adminCtx(base);
    const E = await hire(a, 'Resi One');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-08-31',
      reason: 'New opportunity',
      today: '2026-06-23',
    });

    // Submitting is a request — it must NOT end employment on its own.
    let row = await empRow(E.employmentId);
    expect(row.terminatedOn).toBeNull();
    expect((await myResignation(emp, E.employmentId))?.status).toBe('pending');

    // Admin accepts → terminateEmployment(voluntary, last working day, reason) in the same transaction.
    const res = await decideResignation(a, { requestId, decision: 'accepted' });
    expect(res.status).toBe('accepted');
    row = await empRow(E.employmentId);
    expect(row.terminatedOn).toBe('2026-08-31');
    expect(row.terminationType).toBe('voluntary');
    expect(row.terminationReason).toBe('New opportunity');

    const types = await eventTypesFor(base.tenantId, requestId);
    expect(types).toContain('resignation.submitted');
    expect(types).toContain('resignation.accepted');
  });

  it('reject closes the request without terminating', async () => {
    const a = adminCtx(base);
    const E = await hire(a, 'Resi Two');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-09-30',
      today: '2026-06-23',
    });
    await decideResignation(a, { requestId, decision: 'rejected' });
    expect((await empRow(E.employmentId)).terminatedOn).toBeNull();
    expect((await myResignation(emp, E.employmentId))?.status).toBe('rejected');
  });

  it('the employee can withdraw their own pending resignation, then re-submit', async () => {
    const a = adminCtx(base);
    const E = await hire(a, 'Resi Three');
    const emp = await empCtxFor(E.personId);
    const { requestId } = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-10-31',
      today: '2026-06-23',
    });
    await withdrawResignation(emp, { requestId });
    expect((await myResignation(emp, E.employmentId))?.status).toBe('withdrawn');
    // a withdrawn request frees the one-pending slot
    const again = await submitResignation(emp, {
      employmentId: E.employmentId,
      lastWorkingDay: '2026-11-30',
      today: '2026-06-23',
    });
    expect(again.requestId).toBeTruthy();
  });

  it('rejects a second pending resignation and a past last working day', async () => {
    const a = adminCtx(base);
    const E = await hire(a, 'Resi Four');
    const emp = await empCtxFor(E.personId);
    await submitResignation(emp, { employmentId: E.employmentId, lastWorkingDay: '2026-12-31', today: '2026-06-23' });
    await expect(
      submitResignation(emp, { employmentId: E.employmentId, lastWorkingDay: '2027-01-31', today: '2026-06-23' }),
    ).rejects.toBeInstanceOf(ResignationError);

    const F = await hire(a, 'Resi Five');
    const empF = await empCtxFor(F.personId);
    await expect(
      submitResignation(empF, { employmentId: F.employmentId, lastWorkingDay: '2026-06-01', today: '2026-06-23' }),
    ).rejects.toBeInstanceOf(ResignationError);
  });

  it('a pending resignation shows in the admin inbox', async () => {
    const a = adminCtx(base);
    const E = await hire(a, 'Resi Six');
    const emp = await empCtxFor(E.personId);
    await submitResignation(emp, { employmentId: E.employmentId, lastWorkingDay: '2027-02-28', today: '2026-06-23' });
    const inbox = await listResignationRequests(a, { status: 'pending' });
    expect(inbox.some((r) => r.employmentId === E.employmentId)).toBe(true);
  });
});
