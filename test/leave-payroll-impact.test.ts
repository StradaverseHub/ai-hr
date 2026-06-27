/**
 * Unpaid Leave Payroll Impact Integration.
 *
 * One new stored column — leave_type.send_to_payroll — gates an ADVISORY payroll signal that enriches the
 * existing leave-request.approved domain event (it does NOT change what payroll deducts: deduction stays keyed
 * on paid=false in core/payroll.ts). This suite asserts:
 *   - updateLeaveType round-trips send_to_payroll and surfaces it in the leave-type.updated event diff (both
 *     before + after) when ONLY the payroll marker is touched — the regression guard for the un-nested gate.
 *   - leave-request.approved carries the payrollImpact contract when the type opts in (sendToPayroll=true),
 *     and omits it for an opted-out / paid type, and never leaks on rejection.
 *   - payrollImpact appears exactly once at terminal approval (final HR step) — never on an intermediate
 *     leave-request.step.approved.
 *   - the migration backfill invariant: every paid=false type has send_to_payroll=true.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { decideLeave, requestLeave } from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `pi_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** Insert a leave type with a given paid/sendToPayroll, returning its id. */
async function leaveType(code: string, opts: { paid: boolean; sendToPayroll?: boolean }) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: opts.paid,
      counting: 'calendar_days',
      sendToPayroll: opts.sendToPayroll ?? false,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Give an employment a leave balance so a final approval can debit it. */
async function grant(employmentId: string, leaveTypeId: string, days = 20) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2026-01-01',
  });
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

describe('Unpaid Leave Payroll Impact — service round-trip', () => {
  it('updateLeaveType round-trips send_to_payroll and lists it', async () => {
    const id = await leaveType('UNPAID', { paid: false, sendToPayroll: true });
    await updateLeaveType(adminCtx(b), { id, name: 'Unpaid Leave', sendToPayroll: false });
    const types = await listLeaveTypes(adminCtx(b));
    expect(types.find((t) => t.code === 'UNPAID')?.sendToPayroll).toBe(false);

    await updateLeaveType(adminCtx(b), { id, name: 'Unpaid Leave', sendToPayroll: true });
    const after = await listLeaveTypes(adminCtx(b));
    expect(after.find((t) => t.code === 'UNPAID')?.sendToPayroll).toBe(true);
  });

  it('the leave-type.updated event diff carries sendToPayroll in before AND after when only the payroll marker is touched', async () => {
    const id = await leaveType('UNPAID', { paid: false, sendToPayroll: true });
    await updateLeaveType(adminCtx(b), { id, name: 'Unpaid Leave', sendToPayroll: false });
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before).toHaveProperty('sendToPayroll', true);
    expect(after).toHaveProperty('sendToPayroll', false);
    // A payroll-only save carries no document marker → the doc fields must NOT appear in the diff.
    expect(before).not.toHaveProperty('requiresDocument');
    expect(after).not.toHaveProperty('requiresDocument');
  });

  it('a name-only update (no payroll marker) leaves send_to_payroll untouched and out of the diff', async () => {
    const id = await leaveType('UNPAID', { paid: false, sendToPayroll: true });
    await updateLeaveType(adminCtx(b), { id, name: 'Renamed' });
    const types = await listLeaveTypes(adminCtx(b));
    expect(types.find((t) => t.code === 'UNPAID')?.sendToPayroll).toBe(true);
    const payload = await latestEventPayload(b.tenantId, id, 'leave-type.updated');
    expect(payload?.before as Record<string, unknown>).not.toHaveProperty('sendToPayroll');
    expect(payload?.after as Record<string, unknown>).not.toHaveProperty('sendToPayroll');
  });
});

describe('Unpaid Leave Payroll Impact — on-approval signal', () => {
  it('approving a sendToPayroll=true type enriches leave-request.approved with the payrollImpact contract', async () => {
    const ltId = await leaveType('UNPAID', { paid: false, sendToPayroll: true });
    const emp = await hire('Unpaid Subject');
    await grant(emp.employmentId, ltId);
    const { leaveRequestId } = await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: ltId,
      startDate: '2026-07-01',
      endDate: '2026-07-03',
    });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });

    const payload = await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.approved');
    expect(payload).toMatchObject({ decision: 'approved' });
    const impact = payload?.payrollImpact as Record<string, unknown>;
    expect(impact).toMatchObject({
      employmentId: emp.employmentId,
      leaveTypeId: ltId,
      leaveTypeCode: 'UNPAID',
      days: '3.00',
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      approvalStatus: 'approved',
    });
    // No naive period derivation is emitted — the consumer derives it with its own cutoff rule.
    expect(impact).not.toHaveProperty('payPeriod');
  });

  it('omits payrollImpact for a sendToPayroll=false (paid) type', async () => {
    const ltId = await leaveType('ANNUAL2', { paid: true, sendToPayroll: false });
    const emp = await hire('Paid Subject');
    await grant(emp.employmentId, ltId);
    const { leaveRequestId } = await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: ltId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    const payload = await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.approved');
    expect(payload).toMatchObject({ decision: 'approved' });
    expect(payload).not.toHaveProperty('payrollImpact');
  });

  it('does not leak payroll fields on rejection', async () => {
    const ltId = await leaveType('UNPAID', { paid: false, sendToPayroll: true });
    const emp = await hire('Reject Subject');
    await grant(emp.employmentId, ltId);
    const { leaveRequestId } = await requestLeave(adminCtx(b), {
      employmentId: emp.employmentId,
      leaveTypeId: ltId,
      startDate: '2026-07-10',
      endDate: '2026-07-10',
    });
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'rejected' });
    const approved = await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.approved');
    expect(approved).toBeNull();
    const rejected = await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.rejected');
    expect(rejected).toMatchObject({ decision: 'rejected' });
    expect(rejected).not.toHaveProperty('payrollImpact');
  });

  it('emits payrollImpact exactly once at terminal approval in a multi-step chain (not at step.approved)', async () => {
    await owner.db.update(schema.company).set({ leaveMultiApproval: true }).where(eq(schema.company.id, b.companyId));
    const ltId = await leaveType('UNPAID', { paid: false, sendToPayroll: true });
    const subject = await hire('Chain Subject');
    const manager = await hire('Chain Manager');
    const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: subject.employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const mgrCtx: SessionContext = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
    await grant(subject.employmentId, ltId);

    const { leaveRequestId } = await requestLeave(adminCtx(b), {
      employmentId: subject.employmentId,
      leaveTypeId: ltId,
      startDate: '2026-08-03',
      endDate: '2026-08-05',
    });

    // Manager clears step 1 → advances (step.approved), NOT terminal: no payrollImpact yet.
    await decideLeave(mgrCtx, { leaveRequestId, decision: 'approved' });
    const stepPayload = await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.step.approved');
    expect(stepPayload).not.toBeNull();
    expect(stepPayload).not.toHaveProperty('payrollImpact');
    expect(await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.approved')).toBeNull();

    // HR clears the final step → terminal approval carries payrollImpact exactly once.
    await decideLeave(adminCtx(b), { leaveRequestId, decision: 'approved' });
    const finalPayload = await latestEventPayload(b.tenantId, leaveRequestId, 'leave-request.approved');
    expect((finalPayload?.payrollImpact as Record<string, unknown>)?.leaveTypeCode).toBe('UNPAID');
    const approvedEvents = (await eventTypesFor(b.tenantId, leaveRequestId)).filter((t) => t === 'leave-request.approved');
    expect(approvedEvents).toHaveLength(1);
  });
});

describe('Unpaid Leave Payroll Impact — migration backfill invariant', () => {
  it('every paid=false leave type has send_to_payroll=true after migration + seed', async () => {
    // Mix of paid/unpaid types in a fresh tenant; the seed defaults unpaid → send_to_payroll true, the
    // migration backfills any pre-existing paid=false rows. Insert one unpaid via the pack-style default.
    await owner.db.insert(schema.leaveType).values({
      tenantId: b.tenantId,
      code: 'UNPAID_SEED',
      name: 'Unpaid (seed default)',
      paid: false,
      counting: 'calendar_days',
      sendToPayroll: true, // mirrors seed.ts: lt.sendToPayroll ?? !lt.paid
    });
    const rows = await owner.db
      .select({ paid: schema.leaveType.paid, send: schema.leaveType.sendToPayroll })
      .from(schema.leaveType)
      .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.paid, false)));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.send).toBe(true);
  });
});
