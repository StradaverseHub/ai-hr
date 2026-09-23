/**
 * Marriage Leave — feedback 72fca31d.
 *
 * The reporter asked for five things. TWO WERE ALREADY BUILT and are re-derived here rather than
 * re-implemented, because a claim that something already works is worth exactly as much as the test that
 * shows it:
 *   1. only a SINGLE employee may apply — `leave_type.eligibility` {"maritalStatus":["single"]}, narrowing
 *      the dropdown through `isProfileEligible` AND refused independently by `assertEligible` on submit.
 *      Both halves are asserted here, separately, because a UI-only assertion still passes with the server
 *      gate deleted.
 *   5. the employee cannot edit their own marital status — /me renders it read-only and the only employee
 *      route is a profile-change request. Covered by test/me-profile-change-requests.test.ts and the /me
 *      render; what is pinned HERE is the half that matters to this feature: the HR-side writer
 *      (`setPersonComplianceFields`) is the one that owns the column, and writing through it DISOWNS the
 *      leave request's claim on the value (see the reversal cases).
 *
 * The three built here:
 *   2. a second application while one is pending is refused, FOR THE MARRIAGE ROLE ONLY;
 *   3. final approval flips Single → Married in the same transaction, with an audit entry;
 *   4. cancelling or revoking that leave puts it back — and a status a human set by hand never is.
 *
 * ⚠️ WHY THE APPROVER IN THE CENTRAL CASES IS A LINE MANAGER AND NOT AN HR ADMIN. `person_rls`'s WITH
 * CHECK is `app.is_admin() OR app.is_self_person(id)` (migration 0099). A manager clearing the final
 * approval step is neither, so a plain `tx.update(person)` inside the approval transaction is refused by
 * Postgres and takes the approval down with it — and a suite that only ever approved as `adminCtx` would
 * have shipped that. The write goes through migration 0485's SECURITY DEFINER functions; approving as
 * `mgrCtx` is what proves it.
 *
 * Dates are in 2026 (future) so no backdating / notice gate interferes.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  LeaveIneligibleError,
  MarriageLeaveAlreadyPendingError,
  adminCancelLeave,
  decideLeave,
  decideLeaveCancellation,
  editLeaveRequest,
  leaveTypeIs,
  requestLeave,
  requestLeaveCancellation,
} from '../core/leave';
import { setPersonComplianceFields } from '../core/profile';
import { listEligibleLeaveTypesFor } from '../core/read';
import type { SessionContext } from '../db/client';
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

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;
/** role='marriage', code 'MRL' — production's own shape, so the role marker is what is being read and not
 *  a code literal that happens to match. */
let marriageTypeId: string;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `mrl_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function makeLeaveType(p: {
  code: string;
  name: string;
  role?: string | null;
  eligibility?: unknown;
}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: p.code,
      name: p.name,
      role: (p.role ?? null) as never,
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
      employeeCancelApproved: true,
      eligibility: p.eligibility ?? { maritalStatus: ['single'] },
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Give an employment a leave balance. Marriage Leave needs one: `allowNegativeBalance` only opens the
 *  SUBMIT gate, while `finalizeLeaveApproval` refuses to take an approved balance below zero unless a
 *  negative FLOOR is configured too (9861b8a4). Without this the approval cases fail on balance before
 *  ever reaching the marital-status write, which is a fixture fault, not a finding. */
async function grant(employmentId: string, leaveTypeId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

async function setMaritalDirect(personId: string, value: string | null) {
  await owner.db.update(schema.person).set({ maritalStatus: value }).where(eq(schema.person.id, personId));
}

async function personRow(personId: string) {
  const [r] = await owner.db
    .select({
      maritalStatus: schema.person.maritalStatus,
      source: schema.person.maritalStatusSourceRequestId,
    })
    .from(schema.person)
    .where(eq(schema.person.id, personId));
  return r;
}

async function statusOf(leaveRequestId: string): Promise<string> {
  const [r] = await owner.db
    .select({ status: schema.leaveRequest.status })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, leaveRequestId));
  return r.status;
}

/** Every `person.updated` audit entry for this person, newest last, with its payload. Read straight off
 *  `domain_event` — the SAME table core/read.ts `auditEvents` pages, which is the point of reusing
 *  `appendEvent` rather than inventing a second history. */
async function personAudit(personId: string) {
  return owner.db
    .select({ payload: schema.domainEvent.payload, actorId: schema.domainEvent.actorId, seq: schema.domainEvent.sequence })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.aggregateId, personId), eq(schema.domainEvent.eventType, 'person.updated')))
    .orderBy(schema.domainEvent.sequence);
}

/** Submit as the employee, approve as the LINE MANAGER (see the header). Returns the request id. */
async function submitAndApprove(leaveTypeId = marriageTypeId, startDate = '2026-08-10', endDate = '2026-08-12') {
  const res = await requestLeave(subjectCtx, {
    employmentId: subject.employmentId,
    leaveTypeId,
    startDate,
    endDate,
  });
  // `deciderEmploymentId` is passed because app/approvals/actions.ts passes it: the fixture must approve
  // the way the screen does, or the audit assertion below would be asserting the fixture's omission.
  await decideLeave(mgrCtx, {
    leaveRequestId: res.leaveRequestId,
    decision: 'approved',
    deciderEmploymentId: manager.employmentId,
  });
  return res.leaveRequestId;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // A ONE-step chain ending at the direct manager, so `decideLeave(mgrCtx, …)` IS the final approval and
  // finalizeLeaveApproval runs under the manager's session rather than an admin's.
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
  marriageTypeId = await makeLeaveType({ code: 'MRL', name: 'Marriage Leave', role: 'marriage' });
  await grant(subject.employmentId, marriageTypeId, '10.00');
  await setMaritalDirect(subject.personId, 'single');
});
afterAll(async () => {
  await closeAll();
});

// ── Point 1 (ALREADY BUILT) — re-derived, both halves, separately ────────────────────────────────────
describe('point 1 — only a Single employee may apply (already built; verified, not rebuilt)', () => {
  it('SINGLE: the type is offered in the dropdown AND the submission is accepted', async () => {
    const menu = await listEligibleLeaveTypesFor(subjectCtx, subject.employmentId);
    expect(menu.map((t) => t.id)).toContain(marriageTypeId);
    await expect(
      requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: marriageTypeId,
        startDate: '2026-08-10',
        endDate: '2026-08-12',
      }),
    ).resolves.toMatchObject({ days: 3 });
  });

  // ⚠️ THE API REFUSAL IS ASSERTED SEPARATELY FROM THE DROPDOWN, for every blocked value. A test that only
  // checked the menu would stay green with `assertEligible` deleted from requestLeave — the exact shape of
  // defect this repo's verification standard names.
  for (const marital of ['married', 'divorced', 'widowed', null] as const) {
    it(`${marital ?? 'NOT SET'}: absent from the dropdown`, async () => {
      await setMaritalDirect(subject.personId, marital);
      const menu = await listEligibleLeaveTypesFor(subjectCtx, subject.employmentId);
      expect(menu.map((t) => t.id)).not.toContain(marriageTypeId);
    });

    it(`${marital ?? 'NOT SET'}: the API refuses the submission independently of the dropdown`, async () => {
      await setMaritalDirect(subject.personId, marital);
      await expect(
        requestLeave(subjectCtx, {
          employmentId: subject.employmentId,
          leaveTypeId: marriageTypeId,
          startDate: '2026-08-10',
          endDate: '2026-08-12',
        }),
      ).rejects.toBeInstanceOf(LeaveIneligibleError);
    });
  }
});

// ── Point 2 — one pending application at a time, MARRIAGE ONLY ───────────────────────────────────────
describe('point 2 — a second application while one is pending', () => {
  it('the second Marriage Leave submission is refused, naming the type', async () => {
    await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    const second = requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-09-01',
      endDate: '2026-09-02',
    });
    await expect(second).rejects.toBeInstanceOf(MarriageLeaveAlreadyPendingError);
    await expect(second).rejects.toThrow('You already have a Marriage Leave request pending approval.');
  });

  it('only PENDING blocks: once the first is approved, there is no second pending claim to refuse', async () => {
    // The second is refused, but by the ELIGIBILITY gate (the employee is now married), not by this rule —
    // asserted so the two refusals can never be confused for one another.
    await submitAndApprove();
    await expect(
      requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: marriageTypeId,
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    ).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('a cancelled first application releases the rule', async () => {
    const first = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await adminCancelLeave(adminCtx(b), { leaveRequestId: first.leaveRequestId });
    await expect(
      requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: marriageTypeId,
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    ).resolves.toMatchObject({ days: 2 });
  });

  it('OTHER LEAVE TYPES ARE UNAFFECTED — two pending Annual Leave requests are still ordinary', async () => {
    await grant(subject.employmentId, b.annualLeaveTypeId, '20.00');
    await expect(
      requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-10',
        endDate: '2026-08-11',
      }),
    ).resolves.toMatchObject({ days: 2 });
    await expect(
      requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    ).resolves.toMatchObject({ days: 2 });
  });

  it('an UNCLASSIFIED type coded MARRIAGE is caught by the code fallback, exactly as leaveTypeIs resolves it', async () => {
    const legacy = await makeLeaveType({ code: 'MARRIAGE', name: 'Kahwin', role: null });
    expect(leaveTypeIs({ role: null, code: 'MARRIAGE' }, 'marriage')).toBe(true);
    await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: legacy,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await expect(
      requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: legacy,
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    ).rejects.toBeInstanceOf(MarriageLeaveAlreadyPendingError);
  });

  it('a type NAMED "Marriage Leave" but classified as something else is NOT caught — the role wins, never the name', async () => {
    const notMarriage = await makeLeaveType({ code: 'XX', name: 'Marriage Leave', role: 'annual' });
    await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: notMarriage,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await expect(
      requestLeave(subjectCtx, {
        employmentId: subject.employmentId,
        leaveTypeId: notMarriage,
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    ).resolves.toMatchObject({ days: 2 });
  });

  it('editing the pending request does not count it as its own duplicate', async () => {
    const first = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await expect(
      editLeaveRequest(subjectCtx, {
        leaveRequestId: first.leaveRequestId,
        leaveTypeId: marriageTypeId,
        startDate: '2026-08-17',
        endDate: '2026-08-19',
      }),
    ).resolves.toMatchObject({ days: 3 });
  });

  it('editing ANOTHER pending request INTO Marriage Leave is refused at the same gate', async () => {
    await grant(subject.employmentId, b.annualLeaveTypeId, '20.00');
    await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    const annual = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-09-01',
      endDate: '2026-09-02',
    });
    await expect(
      editLeaveRequest(subjectCtx, {
        leaveRequestId: annual.leaveRequestId,
        leaveTypeId: marriageTypeId,
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    ).rejects.toBeInstanceOf(MarriageLeaveAlreadyPendingError);
  });
});

// ── Point 3 — final approval sets Married ────────────────────────────────────────────────────────────
describe('point 3 — final approval flips Single to Married', () => {
  it('APPROVED BY A LINE MANAGER: the status changes, the cause is persisted, and one audit entry names everything', async () => {
    const reqId = await submitAndApprove();
    expect(await statusOf(reqId)).toBe('approved');

    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('married');
    expect(p.source).toBe(reqId);

    const audit = await personAudit(subject.personId);
    const entry = audit.find((a) => (a.payload as Record<string, unknown>)?.via === 'marriage-leave');
    expect(entry, 'a person.updated audit entry with via=marriage-leave').toBeTruthy();
    const payload = entry!.payload as Record<string, unknown>;
    expect(payload.fields).toEqual(['maritalStatus']);
    expect(payload.before).toEqual({ maritalStatus: 'single' });
    expect(payload.after).toEqual({ maritalStatus: 'married' });
    expect(payload.leaveRequestId).toBe(reqId);
    // The APPROVER, not the applicant: the audit must be able to say who decided.
    expect(payload.deciderEmploymentId).toBe(manager.employmentId);
  });

  it('is NOT applied when the employee is no longer single at the moment of approval', async () => {
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    // HR corrects the record between submission and approval.
    await setPersonComplianceFields(adminCtx(b), {
      employmentId: subject.employmentId,
      maritalStatus: 'divorced',
    });
    await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });

    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('divorced'); // untouched
    expect(p.source).toBeNull(); // and no claim on it
    const audit = await personAudit(subject.personId);
    expect(audit.some((a) => (a.payload as Record<string, unknown>)?.via === 'marriage-leave')).toBe(false);
  });

  it('OTHER LEAVE TYPES ARE UNAFFECTED — approving Annual Leave touches no marital status', async () => {
    await grant(subject.employmentId, b.annualLeaveTypeId, '20.00');
    await submitAndApprove(b.annualLeaveTypeId);
    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('single');
    expect(p.source).toBeNull();
  });

  it('REJECTION changes nothing', async () => {
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'rejected', rejectReason: 'no' });
    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('single');
    expect(p.source).toBeNull();
  });
});

// ── Point 4 — reversal, and only by the application that caused it ───────────────────────────────────
describe('point 4 — cancelling or revoking an approved Marriage Leave', () => {
  it('HR REVOKES it: the status goes back to single, the pointer is cleared, and the reversal is audited', async () => {
    const reqId = await submitAndApprove();
    expect((await personRow(subject.personId)).maritalStatus).toBe('married');

    await adminCancelLeave(adminCtx(b), {
      leaveRequestId: reqId,
      reason: 'applied in error',
      cancelledByEmploymentId: manager.employmentId,
    });

    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('single');
    expect(p.source).toBeNull();

    const audit = await personAudit(subject.personId);
    const entry = audit.find((a) => (a.payload as Record<string, unknown>)?.via === 'marriage-leave-reversal');
    expect(entry, 'a person.updated audit entry with via=marriage-leave-reversal').toBeTruthy();
    const payload = entry!.payload as Record<string, unknown>;
    expect(payload.before).toEqual({ maritalStatus: 'married' });
    expect(payload.after).toEqual({ maritalStatus: 'single' });
    expect(payload.leaveRequestId).toBe(reqId);
    // Both entries survive: the set AND its reversal are in the one audit trail, in order.
    expect(audit.filter((a) => String((a.payload as Record<string, unknown>)?.via).startsWith('marriage-leave'))).toHaveLength(2);
  });

  it('THE EMPLOYEE GIVES THE WHOLE LEAVE BACK and a manager approves: it reverts', async () => {
    const reqId = await submitAndApprove();
    // Pin the PRE-state: without it this case passes on a build where the approval never set anything,
    // because 'single' is then both the start and the end.
    expect(await personRow(subject.personId)).toEqual({ maritalStatus: 'married', source: reqId });
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      today: '2026-08-01',
      leaveRequestId: reqId,
      cancelDates: ['2026-08-10', '2026-08-11', '2026-08-12'],
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });
    expect(await statusOf(reqId)).toBe('cancelled');
    expect((await personRow(subject.personId)).maritalStatus).toBe('single');
  });

  it('A PARTIAL give-back does NOT revert — one day of three back does not un-marry anybody', async () => {
    const reqId = await submitAndApprove();
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      today: '2026-08-01',
      leaveRequestId: reqId,
      cancelDates: ['2026-08-12'],
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });
    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('married');
    expect(p.source).toBe(reqId); // the claim survives, so a LATER full cancellation still reverts
  });

  // ⚠️ THE CASE THE WHOLE PERSISTED-POINTER DESIGN EXISTS FOR.
  it('A STATUS A HUMAN SET BY HAND IS NOT REVERTED', async () => {
    const reqId = await submitAndApprove();
    // Pin the PRE-state for the same reason: 'married' must be the leave's doing before HR overwrites it,
    // or this case would pass on a build where the approval wrote nothing at all.
    expect(await personRow(subject.personId)).toEqual({ maritalStatus: 'married', source: reqId });
    // HR sets the value themselves afterwards — even to the SAME value, which is the nastiest version:
    // nothing about the value itself distinguishes it from the one the leave wrote.
    await setPersonComplianceFields(adminCtx(b), {
      employmentId: subject.employmentId,
      maritalStatus: 'married',
    });
    expect((await personRow(subject.personId)).source).toBeNull(); // the write disowned the leave's claim

    await adminCancelLeave(adminCtx(b), { leaveRequestId: reqId });

    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('married'); // HR's value stands
    expect(p.source).toBeNull();
    const audit = await personAudit(subject.personId);
    expect(audit.some((a) => (a.payload as Record<string, unknown>)?.via === 'marriage-leave-reversal')).toBe(false);
  });

  it('A DIFFERENT employee’s cancellation cannot revert this one — the pointer is per person', async () => {
    const other = await hire('Other');
    const uO = await createAppUser(b.tenantId, other.personId, 'employee');
    const otherCtx: SessionContext = { tenantId: b.tenantId, userId: uO, personId: other.personId, roles: ['employee'] };
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: other.employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await grant(other.employmentId, marriageTypeId, '10.00');
    await setMaritalDirect(other.personId, 'single');

    const mine = await submitAndApprove();
    const theirs = await requestLeave(otherCtx, {
      employmentId: other.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await decideLeave(mgrCtx, { leaveRequestId: theirs.leaveRequestId, decision: 'approved' });
    expect((await personRow(other.personId)).maritalStatus).toBe('married');

    await adminCancelLeave(adminCtx(b), { leaveRequestId: theirs.leaveRequestId });
    expect((await personRow(other.personId)).maritalStatus).toBe('single');
    // Mine is untouched.
    const mineRow = await personRow(subject.personId);
    expect(mineRow.maritalStatus).toBe('married');
    expect(mineRow.source).toBe(mine);
  });

  it('cancelling a PENDING Marriage Leave reverts nothing — it never set anything', async () => {
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: marriageTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await adminCancelLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId });
    const p = await personRow(subject.personId);
    expect(p.maritalStatus).toBe('single');
    expect(p.source).toBeNull();
  });
});

// ── Point 5 (ALREADY BUILT) — the half this feature depends on ───────────────────────────────────────
describe('point 5 — the employee cannot set their own marital status (already built)', () => {
  it('the HR-only writer refuses a non-admin outright', async () => {
    await expect(
      setPersonComplianceFields(subjectCtx, {
        employmentId: subject.employmentId,
        maritalStatus: 'married',
      }),
    ).rejects.toThrow('Only an admin can set gender / marital status.');
  });

  it('marital status is a REQUESTABLE field — the employee asks, it is not written directly', async () => {
    const { PROFILE_REQUESTABLE_FIELDS } = await import('../lib/profile-requestable-fields');
    const field = PROFILE_REQUESTABLE_FIELDS.find((f) => f.key === 'maritalStatus');
    expect(field, 'maritalStatus is declared as a profile-change-requestable field').toBeTruthy();
    expect(field!.target).toBe('person');
  });
});
