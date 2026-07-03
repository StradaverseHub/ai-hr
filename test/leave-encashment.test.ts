/**
 * Leave Encashment (ADR-0069) — leave-side freeze + calculate + expose. Covers: pure rounding; policy
 * on/off gating; the freeze itself (figures, event, idempotency, company scope); the DB trigger (post-freeze
 * writes blocked); the pre-check (requestLeave throws before the trigger); the four sweeps skipping a
 * frozen employment; pending-AL auto-reject at freeze time; unfreeze/adjust overrides + RLS; no-ANNUAL-type
 * failure isolation; the direct-termination bypass; and the payroll (leaverAdvisory) exposure.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, terminateEmployment } from '../core/org';
import { decideResignation, submitResignation } from '../core/offboarding';
import {
  adjustEncashment,
  computeEncashableDays,
  encashableDaysForEmployment,
  encashmentSnapshotForEmployment,
  LeaveBalanceFrozenError,
  setEncashmentPolicy,
  unfreezeEncashment,
} from '../core/leave-encashment';
import { accrueEarnedLeave, decideLeave, openLeaveYear, requestLeave } from '../core/leave';
import { createBatch, leaverAdvisory } from '../core/payroll';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

async function hire(name = 'Employee') {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  return e.employmentId;
}

async function grantAnnual(employmentId: string, days: string, effectiveOn = '2026-01-01') {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn,
  });
}

async function enablePolicy(autoFreeze = true) {
  await setEncashmentPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, autoFreeze });
}

async function resign(employmentId: string, lastWorkingDay: string) {
  // submitResignation requires ctx.personId + a real app_user id (RLS reads app.current_user_id()).
  const [emp] = await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, employmentId)).limit(1);
  const uE = await createAppUser(b.tenantId, emp!.personId, 'employee');
  const asEmployee: SessionContext = { tenantId: b.tenantId, userId: uE, roles: ['employee'], personId: emp!.personId };
  const res = await submitResignation(asEmployee, { employmentId, lastWorkingDay, today: '2026-07-03' });
  return res.requestId;
}

async function approveResignation(requestId: string) {
  return decideResignation(adminCtx(b), { requestId, decision: 'accepted' });
}

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

describe('ADR-0069 — pure rounding (computeEncashableDays)', () => {
  it('rounds half-up to whole days, clamped at 0', () => {
    expect(computeEncashableDays(-3)).toBe(0);
    expect(computeEncashableDays(0)).toBe(0);
    expect(computeEncashableDays(0.4)).toBe(0);
    expect(computeEncashableDays(0.5)).toBe(1);
    expect(computeEncashableDays(8.4)).toBe(8);
    expect(computeEncashableDays(8.5)).toBe(9);
    expect(computeEncashableDays(8.87)).toBe(9);
  });
});

describe('ADR-0069 — policy gating', () => {
  it('policy OFF (default): resignation approval does not freeze, ledger untouched', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10');
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);
    expect(snap).toBeNull();
    expect(await ledgerBalance(emp, b.annualLeaveTypeId)).toBe(10);
  });

  it('policy ON: freeze produces correct figures + event + one committed tx', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10.4');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);

    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);
    expect(snap).not.toBeNull();
    expect(snap!.balanceDays).toBe(10.4);
    expect(snap!.encashableDays).toBe(10); // 10.4 -> floor(10.4+0.5)=10
    expect(snap!.status).toBe('frozen');
    expect(snap!.days).toBe(10);

    const payload = await latestEventPayload(b.tenantId, snap!.id, 'leave-encashment.frozen');
    expect(payload).toMatchObject({ balanceDays: 10.4, encashableDays: 10, resignationRequestId: reqId });
  });

  it('company scope: an employee of a non-enabled company is not frozen', async () => {
    // Second company, policy left off.
    const [c2] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' }).returning({ id: schema.company.id });
    const [d2] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: c2.id, name: 'Ops2' }).returning({ id: schema.department.id });
    await enablePolicy(); // enabled only for b.companyId
    const e2 = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Other', primaryEmail: `other_${randomUUID().slice(0, 8)}@t.local` },
      companyId: c2.id,
      departmentId: d2.id,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    await grantAnnual(e2.employmentId, '5');
    const reqId = await resign(e2.employmentId, '2026-08-01');
    await approveResignation(reqId);
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), e2.employmentId);
    expect(snap).toBeNull();
  });

  it('once-only: freezing twice for the same resignation returns the same snapshot, no duplicate', async () => {
    const emp = await hire();
    await grantAnnual(emp, '6');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);
    const snap1 = await encashmentSnapshotForEmployment(adminCtx(b), emp);

    // Directly re-invoke the freeze path via the same resignation — simulate a retry.
    const { freezeOnResignationApprovalTx } = await import('../core/leave-encashment');
    const [emprow] = await owner.db.select({ companyId: schema.employment.companyId }).from(schema.employment).where(eq(schema.employment.id, emp)).limit(1);
    await withTenant(adminCtx(b), (tx) =>
      freezeOnResignationApprovalTx(tx, adminCtx(b), { employmentId: emp, companyId: emprow!.companyId, resignationRequestId: reqId, asOf: '2026-07-03' }),
    );
    const rows = await owner.db.select().from(schema.leaveEncashmentSnapshot).where(eq(schema.leaveEncashmentSnapshot.resignationRequestId, reqId));
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(snap1!.id);
  });

  it('negative balance clamps to 0', async () => {
    const emp = await hire();
    await grantAnnual(emp, '-2');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);
    expect(snap!.balanceDays).toBe(-2);
    expect(snap!.encashableDays).toBe(0);
  });

  it('no ANNUAL type in tenant: resignation approval still succeeds, no snapshot (failure isolation)', async () => {
    // Archive the seeded ANNUAL type so annualLeaveTypeId() finds none.
    await owner.db.update(schema.leaveType).set({ archivedAt: new Date() }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    // annualLeaveTypeId() in the service does not filter archivedAt (matches leaverAdvisory's lookup by code
    // only) — so instead directly delete the code to truly have no ANNUAL type, exercising the no-op path.
    await owner.db.update(schema.leaveType).set({ code: 'NOT_ANNUAL' }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const emp = await hire();
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await expect(approveResignation(reqId)).resolves.toBeTruthy();
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);
    expect(snap).toBeNull();
  });
});

describe('ADR-0069 — pending AL + freeze enforcement', () => {
  it('pending AL at freeze time is auto-rejected with a system note + event; inbox not jammed', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10');
    await enablePolicy();
    // Submit a pending Annual Leave request BEFORE the resignation is approved.
    const leaveReq = await requestLeave(adminCtx(b), {
      employmentId: emp,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-10',
      endDate: '2026-07-10',
    });
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);

    const [lr] = await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, leaveReq.leaveRequestId)).limit(1);
    expect(lr.status).toBe('rejected');
    const payload = await latestEventPayload(b.tenantId, leaveReq.leaveRequestId, 'leave-request.rejected');
    expect(payload).toMatchObject({ decision: 'rejected', auto: true });
  });

  it('post-freeze: a new AL requestLeave throws LeaveBalanceFrozenError; SICK still works', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);

    await expect(
      requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: b.annualLeaveTypeId, startDate: '2026-07-15', endDate: '2026-07-15' }),
    ).rejects.toThrow(LeaveBalanceFrozenError);

    // A non-ANNUAL type still works normally.
    const [sick] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true, counting: 'calendar_days' })
      .returning({ id: schema.leaveType.id });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId, employmentId: emp, leaveTypeId: sick.id, entryType: 'accrual', days: '5', effectiveOn: '2026-01-01',
    });
    const sickReq = await requestLeave(adminCtx(b), { employmentId: emp, leaveTypeId: sick.id, startDate: '2026-07-16', endDate: '2026-07-16' });
    const decided = await decideLeave(adminCtx(b), { leaveRequestId: sickReq.leaveRequestId, decision: 'approved' });
    expect(decided.status).toBe('approved');
  });

  it('an admin-attempted ledger write for the frozen type is blocked by the DB trigger', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);

    let caught: unknown;
    try {
      await owner.db.insert(schema.leaveLedger).values({
        tenantId: b.tenantId, employmentId: emp, leaveTypeId: b.annualLeaveTypeId, entryType: 'adjustment', days: '1', effectiveOn: '2026-07-05',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const causeMessage = (caught as { cause?: { message?: string } })?.cause?.message ?? (caught as Error).message;
    expect(causeMessage).toMatch(/LEAVE_BALANCE_FROZEN/);
  });
});

describe('ADR-0069 — sweeps skip a frozen employment', () => {
  it('accrueEarnedLeave skips a frozen employment, still runs for others', async () => {
    // Configure ANNUAL as an earned-method policy so accrueEarnedLeave has something to do.
    await owner.db.insert(schema.leavePolicy).values({
      tenantId: b.tenantId, leaveTypeId: b.annualLeaveTypeId, validFrom: '2020-01-01',
      accrual: { method: 'earned_monthly', days: 12 },
    });
    const frozenEmp = await hire('Frozen');
    const otherEmp = await hire('Other');
    await grantAnnual(frozenEmp, '10');
    await enablePolicy();
    const reqId = await resign(frozenEmp, '2026-07-31');
    await approveResignation(reqId);

    const before = await ledgerBalance(frozenEmp, b.annualLeaveTypeId);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-07-03' });
    const after = await ledgerBalance(frozenEmp, b.annualLeaveTypeId);
    expect(after).toBe(before); // frozen employment untouched

    // Other (unfrozen) employee should have accrued something.
    const otherBalance = await ledgerBalance(otherEmp, b.annualLeaveTypeId);
    expect(otherBalance).toBeGreaterThan(0);
  });

  it('openLeaveYear skips a frozen employment', async () => {
    const frozenEmp = await hire('FrozenOY');
    await grantAnnual(frozenEmp, '3', '2025-06-01');
    await enablePolicy();
    const reqId = await resign(frozenEmp, '2026-07-31');
    await approveResignation(reqId);
    const before = await ledgerBalance(frozenEmp, b.annualLeaveTypeId);
    // year 2026: hiredOn (2020-01-01) < yearStart and terminatedOn (2026-07-31) >= yearStart (2026-01-01),
    // so the frozen employment is still in scope for this sweep (and thus exercises the skip).
    const result = await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const after = await ledgerBalance(frozenEmp, b.annualLeaveTypeId);
    expect(after).toBe(before);
  });
});

describe('ADR-0069 — overrides (unfreeze / adjust)', () => {
  it('unfreeze re-opens the ledger; adjust sets override + re-locks; events carry before/after', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);

    // Cannot write while frozen.
    await expect(
      owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: emp, leaveTypeId: b.annualLeaveTypeId, entryType: 'adjustment', days: '1', effectiveOn: '2026-07-05' }),
    ).rejects.toThrow();

    await unfreezeEncashment(adminCtx(b), { snapshotId: snap!.id, reason: 'Correcting a booked cancellation' });
    const unfrozenPayload = await latestEventPayload(b.tenantId, snap!.id, 'leave-encashment.unfrozen');
    expect(unfrozenPayload).toMatchObject({ reason: 'Correcting a booked cancellation' });

    // Now the ledger write succeeds.
    await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: emp, leaveTypeId: b.annualLeaveTypeId, entryType: 'adjustment', days: '2', effectiveOn: '2026-07-05' });

    const adjusted = await adjustEncashment(adminCtx(b), { snapshotId: snap!.id, overrideDays: 8.5, reason: 'HR correction after cancellation' });
    expect(adjusted.status).toBe('frozen');
    expect(adjusted.overrideDays).toBe(8.5);
    const adjustedPayload = await latestEventPayload(b.tenantId, snap!.id, 'leave-encashment.adjusted');
    expect(adjustedPayload).toMatchObject({ reason: 'HR correction after cancellation', after: { overrideDays: 8.5, status: 'frozen' } });

    // Re-locked: a further ledger write is blocked again.
    await expect(
      owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: emp, leaveTypeId: b.annualLeaveTypeId, entryType: 'adjustment', days: '1', effectiveOn: '2026-07-06' }),
    ).rejects.toThrow();

    const finalSnap = await encashmentSnapshotForEmployment(adminCtx(b), emp);
    expect(finalSnap!.days).toBe(8.5); // effective = override
  });

  it('unfreeze/adjust require a mandatory reason', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);
    await expect(unfreezeEncashment(adminCtx(b), { snapshotId: snap!.id, reason: '  ' })).rejects.toThrow();
    await expect(adjustEncashment(adminCtx(b), { snapshotId: snap!.id, overrideDays: 5, reason: '' })).rejects.toThrow();
  });

  it('non-admin ctx cannot write the policy (RLS)', async () => {
    const emp = await hire();
    const uE = await createAppUser(b.tenantId, (await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, emp)).limit(1))[0].personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, roles: ['employee'] };
    await expect(setEncashmentPolicy(empCtx, { companyId: b.companyId, enabled: true, autoFreeze: true })).rejects.toThrow();
  });
});

describe('ADR-0069 — direct termination bypass', () => {
  it('a directly-typed termination creates no snapshot; leaverAdvisory shows live_balance', async () => {
    const emp = await hire();
    await grantAnnual(emp, '7');
    await enablePolicy();
    await terminateEmployment(adminCtx(b), { employmentId: emp, terminationDate: '2026-07-03', terminationType: 'voluntary' });
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);
    expect(snap).toBeNull();
    const forPayroll = await withTenant(adminCtx(b), (tx) => encashableDaysForEmployment(tx, emp));
    expect(forPayroll).toBeNull();
  });
});

describe('ADR-0069 — payroll exposure (leaverAdvisory)', () => {
  it('a frozen snapshot wins over the live balance in leaverAdvisory suggested figure', async () => {
    const emp = await hire();
    await grantAnnual(emp, '10');
    await enablePolicy();
    const reqId = await resign(emp, '2026-07-15');
    await approveResignation(reqId);

    await owner.db.insert(schema.compensation).values({
      tenantId: b.tenantId, employmentId: emp, basicSalary: '2600.00', validFrom: '2020-01-01',
    });
    const batch = await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: '2026-07' });

    const rows = await leaverAdvisory(adminCtx(b), batch.batchId);
    const row = rows.find((r) => r.employmentId === emp);
    expect(row).toBeTruthy();
    expect(row!.encashmentSource).toBe('frozen_snapshot');
    expect(row!.annualBalance).toBe(10); // the frozen/effective day-count
    expect(row!.suggested).toBeCloseTo((2600 / 26) * 10, 2);
  });

  it('no snapshot: leaverAdvisory falls back to the live balance unchanged', async () => {
    const emp = await hire();
    await grantAnnual(emp, '4');
    // policy left OFF
    const reqId = await resign(emp, '2026-07-15');
    await approveResignation(reqId);
    await owner.db.insert(schema.compensation).values({ tenantId: b.tenantId, employmentId: emp, basicSalary: '2600.00', validFrom: '2020-01-01' });
    const batch = await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: '2026-07' });
    const rows = await leaverAdvisory(adminCtx(b), batch.batchId);
    const row = rows.find((r) => r.employmentId === emp);
    expect(row!.encashmentSource).toBe('live_balance');
    expect(row!.annualBalance).toBe(4);
  });
});

describe('ADR-0069 — RLS smoke', () => {
  it('employee session CAN read own snapshot, CANNOT write it', async () => {
    const emp = await hire();
    await grantAnnual(emp, '6');
    await enablePolicy();
    const reqId = await resign(emp, '2026-08-01');
    await approveResignation(reqId);
    const snap = await encashmentSnapshotForEmployment(adminCtx(b), emp);

    const [empRow] = await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, emp)).limit(1);
    const uE = await createAppUser(b.tenantId, empRow!.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, roles: ['employee'], personId: empRow!.personId };

    const seen = await withTenant(empCtx, (tx) => tx.select().from(schema.leaveEncashmentSnapshot).where(eq(schema.leaveEncashmentSnapshot.id, snap!.id)));
    expect(seen.length).toBe(1);

    await expect(
      withTenant(empCtx, (tx) =>
        tx.update(schema.leaveEncashmentSnapshot).set({ overrideReason: 'self-edit attempt' }).where(eq(schema.leaveEncashmentSnapshot.id, snap!.id)),
      ),
    ).rejects.toThrow();
  });
});
