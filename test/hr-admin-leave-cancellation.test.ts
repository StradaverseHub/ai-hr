/**
 * HR Admin Leave Cancellation on behalf of an employee (feedback 22e68ff0).
 *
 * An HR administrator cancels a PENDING or APPROVED leave for another employee immediately, with no approval
 * workflow: the request flips to 'cancelled', the entitlement balance is restored (net ledger debit reversed),
 * any open give-back on the same leave is superseded, a distinct `leave-request.admin-cancelled` event records
 * the REAL HR actor + display facts, and the employee is notified. HR cannot cancel their own leave here
 * (self-ban; super_admin excepted), a company-scoped admin can't reach another company's leave (RLS), and
 * already-cancelled / rejected / approved-REPLACEMENT / closed-payroll leave are refused.
 *
 * Future dates (Aug 2026) so no future-gate interferes; the service intentionally allows past/started leave.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  adminCancelLeave,
  decideLeave,
  decideLeaveCancellation,
  requestLeave,
  requestLeaveCancellation,
  LeaveCancellationNotAllowedError,
  LeaveCancellationPeriodClosedError,
} from '../core/leave';
import { dispatchNotifications } from '../core/notifications';
import { listLeaveRequests, plannedAbsences } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `hac_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function grantAnnual(days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

/** Submit + single-step approve a 10–12 Aug ANNUAL leave; returns the row id (3 working days). */
async function approvedThreeDay() {
  const res = await requestLeave(subjectCtx, {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: '2026-08-10',
    endDate: '2026-08-12',
  });
  await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
  return res.leaveRequestId;
}

async function statusOf(id: string): Promise<string> {
  const [r] = await owner.db
    .select({ status: schema.leaveRequest.status })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, id));
  return r.status;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // r79 0322 — single- vs multi-step approval is now decided by the company's resolved chain, not by
  // company.leave_multi_approval (which is gone). These cases are whole-request single-approver flows —
  // the shape the old opted-out default produced — so the company is put on an explicit ONE-step chain.
  // Without it the built-in direct_manager → hr_admin fallback applies and an approval stops at step 1.
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  subject = await hire('Subject');
  const u = await createAppUser(b.tenantId, subject.personId, 'employee');
  subjectCtx = { tenantId: b.tenantId, userId: u, personId: subject.personId, roles: ['employee'] };
  manager = await hire('Manager');
  const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
  await grantAnnual('20.00');
});
afterAll(async () => {
  await closeAll();
});

describe('adminCancelLeave — happy path', () => {
  it('cancels a PENDING leave: no ledger movement, event records HR actor + previousStatus pending', async () => {
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20); // no debit on submit

    const out = await adminCancelLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, reason: 'applied in error' });
    expect(out.previousStatus).toBe('pending');
    expect(out.restoredDays).toBe(0);
    expect(await statusOf(res.leaveRequestId)).toBe('cancelled');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20);

    expect(await eventTypesFor(b.tenantId, res.leaveRequestId)).toContain('leave-request.admin-cancelled');
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.admin-cancelled');
    expect(payload?.previousStatus).toBe('pending');
    expect(payload?.reason).toBe('applied in error');
    // Audit shows HR (the acting admin user), NOT the employee.
    const [ev] = await owner.db
      .select({ actorId: schema.domainEvent.actorId, subj: schema.domainEvent.subjectEmploymentId })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.aggregateId, res.leaveRequestId),
          eq(schema.domainEvent.eventType, 'leave-request.admin-cancelled'),
        ),
      );
    expect(ev.actorId).toBe(b.adminUserId);
    expect(ev.subj).toBe(subject.employmentId);
  });

  it('cancels an APPROVED leave: restores the full balance, one reversal ledger row, disappears from reads', async () => {
    const reqId = await approvedThreeDay();
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(17); // 20 − 3

    const out = await adminCancelLeave(adminCtx(b), { leaveRequestId: reqId });
    expect(out.previousStatus).toBe('approved');
    expect(out.restoredDays).toBe(3);
    expect(await statusOf(reqId)).toBe('cancelled');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20); // fully restored

    // exactly one positive reversal row sourced to the request
    const reversals = await owner.db
      .select({ days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.sourceRequestId, reqId));
    const positive = reversals.filter((r) => Number(r.days) > 0);
    expect(positive).toHaveLength(1);
    expect(Number(positive[0].days)).toBe(3);

    // gone from the calendar (status-filtered to approved|pending)
    const abs = await plannedAbsences(adminCtx(b), [b.companyId], { from: '2026-08-01', to: '2026-08-31' }, '2026-07-01');
    const stillThere = abs.some((row) => row.leaves.some((l) => l.id === reqId));
    expect(stillThere).toBe(false);
    // history row now reads cancelled
    const hist = await listLeaveRequests(adminCtx(b), [b.companyId]);
    expect(hist.find((r) => r.id === reqId)?.status).toBe('cancelled');
  });

  it('net-sum reversal: an admin-cancel of a prior-split survivor restores only the survivor days (no double-restore)', async () => {
    // 10–14 Aug (Mon–Fri, 5 working days) approved, then the employee gives back 12 Aug (manager approves).
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-14',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(15); // 20 − 5

    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      today: '2026-08-01',
      leaveRequestId: res.leaveRequestId,
      cancelDates: ['2026-08-12'],
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(16); // one day back

    // The reused row (res.id) is now the 10–11 survivor (2 days). Admin-cancel it → restore exactly 2, not 5.
    const out = await adminCancelLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId });
    expect(out.restoredDays).toBe(2);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(18); // 16 + 2
  });
});

describe('adminCancelLeave — authorization', () => {
  it('a plain employee cannot admin-cancel a peer’s leave', async () => {
    const reqId = await approvedThreeDay();
    await expect(adminCancelLeave(subjectCtx, { leaveRequestId: reqId })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
    expect(await statusOf(reqId)).toBe('approved');
  });

  it('a manager (non-admin) cannot admin-cancel', async () => {
    const reqId = await approvedThreeDay();
    await expect(adminCancelLeave(mgrCtx, { leaveRequestId: reqId })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
  });

  it('an hr_admin cannot admin-cancel their OWN leave (self-ban)', async () => {
    // The admin is themselves an employee with a pending leave.
    const adminEmp = await hire('HR Person');
    const adminU = await createAppUser(b.tenantId, adminEmp.personId, 'hr_admin');
    const selfAdminCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: adminU,
      personId: adminEmp.personId,
      roles: ['hr_admin'],
    };
    const res = await requestLeave(selfAdminCtx, {
      employmentId: adminEmp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-10',
    });
    await expect(adminCancelLeave(selfAdminCtx, { leaveRequestId: res.leaveRequestId })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
  });

  it('a super_admin CAN cancel their own leave (sole-admin escape hatch)', async () => {
    const supEmp = await hire('Super Person');
    const supU = await createAppUser(b.tenantId, supEmp.personId, 'super_admin');
    const supCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: supU,
      personId: supEmp.personId,
      roles: ['super_admin'],
    };
    const res = await requestLeave(supCtx, {
      employmentId: supEmp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-10',
    });
    const out = await adminCancelLeave(supCtx, { leaveRequestId: res.leaveRequestId });
    expect(out.previousStatus).toBe('pending');
    expect(await statusOf(res.leaveRequestId)).toBe('cancelled');
  });

  it('a company-scoped hr_admin cannot reach another company’s leave (RLS → not found)', async () => {
    const reqId = await approvedThreeDay(); // subject is in company A (b.companyId)
    // A second company + an hr_admin scoped ONLY to it.
    const [companyB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [au] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: b.tenantId, appUserId: au.id, companyId: companyB.id, role: 'hr_admin' });
    const scopedCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: au.id,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: companyB.id }],
    };
    await expect(adminCancelLeave(scopedCtx, { leaveRequestId: reqId })).rejects.toThrow(/not found|not visible/i);
    expect(await statusOf(reqId)).toBe('approved');
  });
});

describe('adminCancelLeave — status gates', () => {
  it('refuses an already-cancelled leave', async () => {
    const reqId = await approvedThreeDay();
    await adminCancelLeave(adminCtx(b), { leaveRequestId: reqId });
    await expect(adminCancelLeave(adminCtx(b), { leaveRequestId: reqId })).rejects.toThrow(/already cancelled/i);
  });

  it('refuses a rejected leave', async () => {
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await decideLeave(adminCtx(b), {
      leaveRequestId: res.leaveRequestId,
      decision: 'rejected',
      rejectReason: 'not enough cover',
    });
    await expect(adminCancelLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId })).rejects.toThrow(
      /already rejected/i,
    );
  });
});

describe('adminCancelLeave — REPLACEMENT (TOIL)', () => {
  async function replacementType() {
    const [lt] = await owner.db
      .insert(schema.leaveType)
      .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'REPLACEMENT', name: 'Replacement Leave', paid: true })
      .returning({ id: schema.leaveType.id });
    return lt.id;
  }

  // 3fb1a611 (r299) — THIS USED TO PIN A REFUSAL ("no TOIL-register inverse"). The inverse exists now
  // (core/toil.ts restoreReplacementLeaveTx), so an approved Replacement Leave cancels and its credit goes back.
  // This fixture has a ledger debit and NO register rows (the legacy ghost credit), so the day comes back to
  // the ledger and nothing is invented in the register. r300 — and NOTHING IS LOGGED EITHER: an employee who never
  // held a credit has no register to keep in step (core/toil.ts employmentHoldsCreditsTx gates consumption and
  // give-back alike), which is also what keeps a tenant without Leave Credit byte-for-byte on main's behaviour. The give-back into real
  // credits — FIFO-split, and refused after expiry — is pinned in test/r299-leave-credit-cancel.test.ts.
  it('cancels an APPROVED replacement leave and gives the day back (3fb1a611)', async () => {
    const rt = await replacementType();
    const [row] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: subject.employmentId,
        leaveTypeId: rt,
        startDate: '2026-08-10',
        endDate: '2026-08-10',
        days: '1.00',
        durationType: 'full_day',
        status: 'approved',
      })
      .returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: rt,
      entryType: 'debit',
      days: '-1.00',
      sourceRequestId: row.id,
      effectiveOn: '2026-08-10',
    });
    const out = await adminCancelLeave(adminCtx(b), { leaveRequestId: row.id });
    expect(out.restoredDays).toBe(1);
    expect(await statusOf(row.id)).toBe('cancelled');
    const shortfall = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.eventType, 'toil.restore.shortfall'), eq(schema.domainEvent.aggregateId, row.id)));
    expect(shortfall, 'no register was ever used for this employee, so there is no bookkeeping gap to flag').toHaveLength(0);
  });

  it('cancels a PENDING replacement leave cleanly (register never consumed)', async () => {
    const rt = await replacementType();
    const [row] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: subject.employmentId,
        leaveTypeId: rt,
        startDate: '2026-08-10',
        endDate: '2026-08-10',
        days: '1.00',
        durationType: 'full_day',
        status: 'pending',
      })
      .returning({ id: schema.leaveRequest.id });
    const out = await adminCancelLeave(adminCtx(b), { leaveRequestId: row.id });
    expect(out.restoredDays).toBe(0);
    expect(await statusOf(row.id)).toBe('cancelled');
  });
});

describe('adminCancelLeave — closed payroll period', () => {
  it('refuses when the leave month has a closed payroll batch with the employee’s payslip', async () => {
    const reqId = await approvedThreeDay(); // 10–12 Aug 2026 → month 2026-08
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: b.companyId, period: '2026-08', status: 'closed' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        payPeriodId: pp.id,
        payPeriod: '2026-08',
        batchDate: '2026-08-25',
        status: 'closed',
      })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId: subject.employmentId,
      basicSalary: '5000.00',
      grossPay: '5000.00',
      statutory: {},
      totalDeductions: '0.00',
      netPay: '5000.00',
      employerCost: '5000.00',
    });
    await expect(adminCancelLeave(adminCtx(b), { leaveRequestId: reqId })).rejects.toBeInstanceOf(
      LeaveCancellationPeriodClosedError,
    );
    expect(await statusOf(reqId)).toBe('approved');
  });
});

describe('adminCancelLeave — supersede open give-back', () => {
  it('flips a pending employee cancellation request to rejected (HR as decider) with a supersede flag', async () => {
    const reqId = await approvedThreeDay();
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      today: '2026-08-01',
      leaveRequestId: reqId,
      cancelDates: ['2026-08-11'],
    });
    await adminCancelLeave(adminCtx(b), { leaveRequestId: reqId, cancelledByEmploymentId: manager.employmentId });

    const [cr] = await owner.db
      .select({ status: schema.leaveCancellationRequest.status, decidedBy: schema.leaveCancellationRequest.decidedByEmploymentId })
      .from(schema.leaveCancellationRequest)
      .where(eq(schema.leaveCancellationRequest.id, cancellationRequestId));
    expect(cr.status).toBe('rejected');
    expect(cr.decidedBy).toBe(manager.employmentId);

    const payload = await latestEventPayload(b.tenantId, cancellationRequestId, 'leave-cancellation.rejected');
    expect(payload?.supersededByAdminCancellation).toBe(true);
  });
});

describe('adminCancelLeave — notification', () => {
  it('the employee holds one leave.admin-cancelled notification; the HR actor holds none', async () => {
    // ADR-0077 slice 3: notifications is a per-tenant module ROW now, not NOTIFICATIONS_ENABLED. The
    // dispatch call must run on `entitledCtx` — a REAL snapshot resolved from this tenant's rows,
    // built AFTER the grant — because `adminCtx` derives its snapshot from
    // `legacyEnabledModulesIn(process.env)` and would not see this row.
    await setModule(b.tenantId, 'notifications', 'active');
    const reqId = await approvedThreeDay();
    await adminCancelLeave(adminCtx(b), { leaveRequestId: reqId });
    await dispatchNotifications(await entitledCtx(b));

    const notes = await owner.db
      .select({ kind: schema.notification.kind, recipient: schema.notification.recipientEmploymentId })
      .from(schema.notification)
      .where(eq(schema.notification.kind, 'leave.admin-cancelled'));
    expect(notes).toHaveLength(1);
    expect(notes[0].recipient).toBe(subject.employmentId);
  });
});
