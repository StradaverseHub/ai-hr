/**
 * R51 722904dc/71b9143a — leave approval escalation: per-company settings (core/leave-approval-policy.ts)
 * + the nightly sweep (core/leave-escalation.ts). The sweep chases the LOWEST pending approval step of a
 * pending request once it has sat past company.escalate_after_days WORKING days, appending exactly ONE
 * `leave-request.escalation-due` event per (group, step) EVER — the domain_event log is the dedup ledger.
 *
 * August 2026 calendar used throughout: Sat 1, Sun 2, Mon 3 … Fri 7, Sat 8, Sun 9, Mon 10, Tue 11.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../core/leave';
import {
  getLeaveEscalationPolicy,
  setLeaveApprovalPolicy,
  setLeaveEscalationPolicy,
} from '../core/leave-approval-policy';
import { sweepLeaveApprovalEscalations } from '../core/leave-escalation';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let manager: { personId: string; employmentId: string };

const hire = (name: string, companyId?: string, departmentId?: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `esc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: companyId ?? b.companyId,
    departmentId: departmentId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** Submit an ordinary future-dated request for the subject (chain steps are generated at submit). */
const submit = (startDate = '2026-08-03', endDate = '2026-08-04', employmentId?: string) =>
  requestLeave(adminCtx(b), {
    employmentId: employmentId ?? subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate,
    endDate,
  });

/** Backdate a request's submission clock (timestamptz — noon MYT unless a boundary is being tested). */
const backdate = (leaveRequestId: string, iso: string) =>
  owner.db
    .update(schema.leaveRequest)
    .set({ createdAt: new Date(iso) })
    .where(eq(schema.leaveRequest.id, leaveRequestId));

/** Direct settings write (bypasses the service) with escalation_updated_at far in the past, so the
 *  grandfather gate never interferes with the tests that are not about it. */
async function enableEscalation(
  days: number,
  opts: { companyId?: string; target?: string; targetRole?: string | null; updatedAt?: string } = {},
) {
  await owner.db
    .update(schema.company)
    .set({
      escalationEnabled: true,
      escalateAfterDays: days,
      escalationTarget: opts.target ?? 'next_level',
      escalationTargetRole: opts.targetRole ?? null,
      escalationUpdatedAt: new Date(opts.updatedAt ?? '2020-01-01T00:00:00Z'),
    })
    .where(eq(schema.company.id, opts.companyId ?? b.companyId));
}

const sweep = (today: string) => sweepLeaveApprovalEscalations(adminCtx(b), { today });

const escalationEvents = async () =>
  owner.db
    .select({
      payload: schema.domainEvent.payload,
      subjectEmploymentId: schema.domainEvent.subjectEmploymentId,
    })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, b.tenantId),
        eq(schema.domainEvent.eventType, 'leave-request.escalation-due'),
      ),
    );

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject');
  manager = await hire('Manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  // Multi-step chain: direct manager (step 0) then HR (step 1).
  await setLeaveApprovalPolicy(adminCtx(b), {
    companyId: b.companyId,
    levels: ['direct_manager', 'hr_admin'],
  });
});
afterAll(async () => {
  await closeAll();
});

describe('escalation settings (722904dc)', () => {
  it('saves and reads back the config, appending the audit event', async () => {
    await setLeaveEscalationPolicy(adminCtx(b), {
      companyId: b.companyId,
      enabled: true,
      escalateAfterDays: 5,
      target: 'specific_role',
      targetRole: 'payroll',
      reason: 'audit note',
    });
    expect(await getLeaveEscalationPolicy(adminCtx(b), b.companyId)).toEqual({
      enabled: true,
      escalateAfterDays: 5,
      target: 'specific_role',
      targetRole: 'payroll',
    });
    const [co] = await owner.db
      .select({ updatedAt: schema.company.escalationUpdatedAt })
      .from(schema.company)
      .where(eq(schema.company.id, b.companyId));
    expect(co.updatedAt).not.toBeNull();
    const events = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.eventType, 'leave-escalation-policy.updated'),
        ),
      );
    expect(events).toHaveLength(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.after).toEqual({ enabled: true, escalateAfterDays: 5, target: 'specific_role', targetRole: 'payroll' });
    expect(payload.reason).toBe('audit note');
    // Disabling clears the days.
    await setLeaveEscalationPolicy(adminCtx(b), { companyId: b.companyId, enabled: false });
    expect((await getLeaveEscalationPolicy(adminCtx(b), b.companyId)).escalateAfterDays).toBeNull();
  });

  it('rejects enabled-without-days, days outside 1-90, and a bogus specific role', async () => {
    const base = { companyId: b.companyId, enabled: true };
    await expect(setLeaveEscalationPolicy(adminCtx(b), { ...base, escalateAfterDays: null })).rejects.toThrow();
    await expect(setLeaveEscalationPolicy(adminCtx(b), { ...base, escalateAfterDays: 0 })).rejects.toThrow();
    await expect(setLeaveEscalationPolicy(adminCtx(b), { ...base, escalateAfterDays: 91 })).rejects.toThrow();
    await expect(
      setLeaveEscalationPolicy(adminCtx(b), {
        ...base,
        escalateAfterDays: 5,
        target: 'specific_role',
        targetRole: 'not_a_kind',
      }),
    ).rejects.toThrow();
  });
});

describe('escalation sweep (71b9143a — via the nightly review-sweep)', () => {
  it('inside the window fires nothing; past the window fires exactly one event with the routing payload', async () => {
    await enableEscalation(3);
    const { leaveRequestId } = await submit();
    await backdate(leaveRequestId, '2026-08-03T04:00:00Z'); // Mon noon MYT
    // Mon→Wed = 2 elapsed working days (Tue, Wed) — inside the 3-day window.
    expect((await sweep('2026-08-05')).escalated).toBe(0);
    expect(await escalationEvents()).toHaveLength(0);
    // Thu = 3 elapsed working days — fires.
    expect((await sweep('2026-08-06')).escalated).toBe(1);
    const events = await escalationEvents();
    expect(events).toHaveLength(1);
    expect(events[0].subjectEmploymentId).toBe(subject.employmentId);
    const p = events[0].payload as Record<string, unknown>;
    expect(p).toMatchObject({
      groupKey: leaveRequestId,
      leaveRequestId,
      stepIndex: 0,
      currentKind: 'direct_manager',
      nextKind: 'hr_admin',
      targetKind: 'hr_admin', // next_level target ⇒ the NEXT chain level
      daysWaiting: 3,
      startDate: '2026-08-03',
      endDate: '2026-08-04',
    });
    expect(typeof p.leaveTypeName).toBe('string');
  });

  it('a specific_role target snapshots the configured role as targetKind', async () => {
    await enableEscalation(2, { target: 'specific_role', targetRole: 'payroll' });
    const { leaveRequestId } = await submit();
    await backdate(leaveRequestId, '2026-08-03T04:00:00Z');
    expect((await sweep('2026-08-05')).escalated).toBe(1);
    const [ev] = await escalationEvents();
    expect((ev.payload as Record<string, unknown>).targetKind).toBe('payroll');
  });

  it('fires once per (group, step) EVER — a same-day re-sweep and a later-day sweep both add nothing', async () => {
    await enableEscalation(3);
    const { leaveRequestId } = await submit();
    await backdate(leaveRequestId, '2026-08-03T04:00:00Z');
    expect((await sweep('2026-08-06')).escalated).toBe(1);
    expect((await sweep('2026-08-06')).escalated).toBe(0); // same day
    expect((await sweep('2026-08-11')).escalated).toBe(0); // NOT once per day — once per (group, step)
    expect(await escalationEvents()).toHaveLength(1);
  });

  it('a request that advances to the next step escalates AGAIN for the new step, with a fresh clock', async () => {
    await enableEscalation(2);
    const { leaveRequestId } = await submit();
    await backdate(leaveRequestId, '2026-08-03T04:00:00Z');
    expect((await sweep('2026-08-05')).escalated).toBe(1); // step 0 (Tue+Wed = 2)
    // The manager clears step 0 on Wed — step 1 (HR) becomes the pending step with a Wed clock start.
    await owner.db
      .update(schema.leaveApprovalStep)
      .set({ status: 'approved', decidedAt: new Date('2026-08-05T04:00:00Z') })
      .where(
        and(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId), eq(schema.leaveApprovalStep.stepIndex, 0)),
      );
    expect((await sweep('2026-08-06')).escalated).toBe(0); // Thu — only 1 elapsed day for step 1
    expect((await sweep('2026-08-07')).escalated).toBe(1); // Fri — 2 elapsed days, fires for step 1
    const events = await escalationEvents();
    expect(events).toHaveLength(2);
    const second = events
      .map((e) => e.payload as Record<string, unknown>)
      .find((p) => p.stepIndex === 1)!;
    expect(second).toMatchObject({
      stepIndex: 1,
      currentKind: 'hr_admin',
      nextKind: null, // the stuck step is the LAST one …
      targetKind: null, // … so the resolver falls back to HR admins at dispatch time
    });
  });

  it('weekends and a seeded public holiday are excluded from the working-day count', async () => {
    await enableEscalation(2);
    await owner.db.insert(schema.holiday).values({
      tenantId: b.tenantId,
      country: 'MY',
      state: null,
      holidayDate: '2026-08-07', // Friday
      name: 'Test Holiday',
    });
    const { leaveRequestId } = await submit('2026-08-20', '2026-08-21');
    await backdate(leaveRequestId, '2026-08-06T04:00:00Z'); // Thursday
    // (Thu, Mon] = Fri (holiday) + Sat/Sun (weekend) excluded, Mon = 1 elapsed day. Without the
    // exclusions this would be 2 and fire.
    expect((await sweep('2026-08-10')).escalated).toBe(0);
    expect((await sweep('2026-08-11')).escalated).toBe(1); // Tue = 2 elapsed working days
  });

  it('approved, rejected and cancelled requests are never picked up', async () => {
    await enableEscalation(1);
    for (const status of ['approved', 'rejected', 'cancelled'] as const) {
      const { leaveRequestId } = await submit('2026-08-17', '2026-08-17');
      await backdate(leaveRequestId, '2026-08-03T04:00:00Z');
      await owner.db.update(schema.leaveRequest).set({ status }).where(eq(schema.leaveRequest.id, leaveRequestId));
    }
    expect((await sweep('2026-08-14')).escalated).toBe(0);
    expect(await escalationEvents()).toHaveLength(0);
  });

  it('partial per-date approval counts as approver activity and resets the clock (ADR-0068)', async () => {
    await enableEscalation(3);
    const { leaveRequestId } = await submit();
    await backdate(leaveRequestId, '2026-07-27T04:00:00Z'); // Mon, ancient — would long since be overdue
    // The approver decided ONE of the requested dates on Wed Aug 5 — demonstrably working the request.
    await owner.db.insert(schema.leaveRequestDate).values({
      tenantId: b.tenantId,
      leaveRequestId,
      subjectEmploymentId: subject.employmentId,
      leaveDate: '2026-08-03',
      days: '1.00',
      status: 'approved',
      decidedAt: new Date('2026-08-05T04:00:00Z'),
    });
    expect((await sweep('2026-08-06')).escalated).toBe(0); // clock restarted Wed — only 1 elapsed day
    expect((await sweep('2026-08-10')).escalated).toBe(1); // Thu+Fri+Mon = 3 — now genuinely stuck again
  });

  it('grandfathering: a request already waiting when escalation was switched on never fires; later ones do', async () => {
    await enableEscalation(3, { updatedAt: '2026-08-04T04:00:00Z' }); // switched on Tue
    const { leaveRequestId: oldReq } = await submit();
    await backdate(oldReq, '2026-08-03T04:00:00Z'); // clock started Mon, BEFORE the switch-on
    expect((await sweep('2026-08-20')).escalated).toBe(0);
    const { leaveRequestId: newReq } = await submit('2026-08-24', '2026-08-25');
    await backdate(newReq, '2026-08-05T04:00:00Z'); // clock started Wed, AFTER the switch-on
    expect((await sweep('2026-08-10')).escalated).toBe(1); // Thu+Fri+Mon = 3
    const events = await escalationEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).leaveRequestId).toBe(newReq);
  });

  it('timezone: a request created at 01:00 local (17:00 UTC the previous day) counts from the LOCAL date', async () => {
    await enableEscalation(2);
    const { leaveRequestId } = await submit();
    // 2026-08-03T17:30Z = Tue 2026-08-04 01:30 MYT — the clock starts on the LOCAL date (Tue).
    await backdate(leaveRequestId, '2026-08-03T17:30:00Z');
    // A UTC slice would start the clock Mon and see 2 elapsed days (Tue+Wed) on Wednesday — must NOT fire.
    expect((await sweep('2026-08-05')).escalated).toBe(0);
    expect((await sweep('2026-08-06')).escalated).toBe(1); // Wed+Thu = 2 from the local Tue start
  });

  it('a company with an empty working-day roster is skipped (counted), and the sweep does not throw', async () => {
    await enableEscalation(1);
    await owner.db.insert(schema.attendancePolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      workingDays: [],
      halfWorkingDays: [],
    });
    const { leaveRequestId } = await submit();
    await backdate(leaveRequestId, '2026-08-03T04:00:00Z');
    const res = await sweep('2026-08-20');
    expect(res.escalated).toBe(0);
    expect(res.skippedEmptyRosterCompanies).toBe(1);
    expect(await escalationEvents()).toHaveLength(0);
  });

  it('multi-company isolation: only the escalation-enabled company fires', async () => {
    await enableEscalation(2); // company A only
    const others: string[] = [];
    for (const name of ['Beta Sdn Bhd', 'Gamma Sdn Bhd']) {
      const [co] = await owner.db
        .insert(schema.company)
        .values({ tenantId: b.tenantId, legalName: name })
        .returning({ id: schema.company.id });
      const [dept] = await owner.db
        .insert(schema.department)
        .values({ tenantId: b.tenantId, companyId: co.id, name: 'Ops' })
        .returning({ id: schema.department.id });
      // r79 0322 — TWO levels, so these companies genuinely produce approval steps. A one-level chain is
      // the single-approver path and generates none, which would make this test pass for the wrong reason:
      // "no candidates" instead of "escalation is off here".
      await setLeaveApprovalPolicy(adminCtx(b), { companyId: co.id, levels: ['hr_admin', 'payroll'] });
      const emp = await hire(`Emp ${name}`, co.id, dept.id);
      const { leaveRequestId } = await requestLeave(adminCtx(b), {
        employmentId: emp.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-17',
        endDate: '2026-08-17',
      });
      await backdate(leaveRequestId, '2026-08-03T04:00:00Z'); // long overdue — but escalation is OFF here
      others.push(leaveRequestId);
    }
    const { leaveRequestId: aReq } = await submit();
    await backdate(aReq, '2026-08-03T04:00:00Z');
    expect((await sweep('2026-08-05')).escalated).toBe(1);
    const events = await escalationEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).leaveRequestId).toBe(aReq);
  });

  it('Emergency Leave: the linked child pair with one stuck approver produces exactly ONE event', async () => {
    await enableEscalation(2);
    const parentGroupId = randomUUID();
    for (let i = 0; i < 2; i++) {
      const [row] = await owner.db
        .insert(schema.leaveRequest)
        .values({
          tenantId: b.tenantId,
          employmentId: subject.employmentId,
          leaveTypeId: b.annualLeaveTypeId,
          startDate: '2026-08-03',
          endDate: '2026-08-04',
          days: '2.00',
          parentGroupId,
          createdAt: new Date('2026-08-03T04:00:00Z'),
        })
        .returning({ id: schema.leaveRequest.id });
      await owner.db.insert(schema.leaveApprovalStep).values({
        tenantId: b.tenantId,
        leaveRequestId: row.id,
        subjectEmploymentId: subject.employmentId,
        stepIndex: 0,
        approverKind: 'direct_manager',
      });
    }
    expect((await sweep('2026-08-05')).escalated).toBe(1);
    const events = await escalationEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).groupKey).toBe(parentGroupId);
    // And the probe holds across runs for the WHOLE group.
    expect((await sweep('2026-08-06')).escalated).toBe(0);
  });
});
