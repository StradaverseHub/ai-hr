/**
 * r285 (0d40ab99) — SETTING A HEAD ON SYSTEM LABELS ACTUALLY ROUTES A LEAVE REQUEST.
 *
 * The other half of the proof. test/system-labels-head-column.dom.test.tsx pins that the restored Head
 * (leave approver) control renders and what it puts in the Save payload; this file takes that payload
 * shape — typed against the grid itself, so the two cannot drift — feeds it to the service the Save
 * action calls, and asserts the routing consequence.
 *
 * WHY THIS IS THE ASSERTION THAT MATTERS. A control that saves but does not change routing would be the
 * same defect wearing a new coat. `department_head` was a selectable approval step that could never fire:
 * `generateApprovalSteps` DROPS a head step whose head is unset (no dead step nobody can clear), and
 * since 797e3523 nothing in the app could set one — 0 of 25 departments and 0 of 7 business units on the
 * live tenant. So the shape worth pinning is the BEFORE and the AFTER of the same request, in one test:
 * head unset ⇒ the step is not there at all; head set through the grid's own save path ⇒ it is, it
 * resolves to that person, and that person — nobody else — can clear it.
 *
 * And the blank option is pinned as a real value on the same path: choosing None sends `null`, the
 * service clears the column, and the step goes back to being dropped. Blank means "no head".
 *
 * `bulkSaveLabels` is the service `saveLabelsGridAction` (app/admin/settings/actions.ts) hands the grid's
 * payload to VERBATIM — it adds nothing and reshapes nothing — so calling it with a `GridSavePayload` is
 * the same write the screen makes. The action itself cannot be called here: it opens a real session.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { bulkSaveLabels } from '../core/admin';
import { decideLeave, requestLeave, resolveSubjectHead } from '../core/leave';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
// TYPE-ONLY (erased at runtime — this node project never loads the client component): the payload the
// restored Head column submits. If the grid ever stops carrying `headEmploymentId` in its Save payload,
// this file stops COMPILING rather than quietly going green against a control nobody can reach.
import type { SystemLabelsGrid } from '../components/system-labels-grid';

type GridSavePayload = Parameters<React.ComponentProps<typeof SystemLabelsGrid>['actions']['save']>[1];

let b: Base;
let subject: { personId: string; employmentId: string };
let head: { personId: string; employmentId: string };
let peer: { personId: string; employmentId: string };
let other: { personId: string; employmentId: string };
let headCtx: SessionContext;
let otherCtx: SessionContext;

const hire = (name: string, departmentId: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `head_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

const setChain = (levels: string[]) =>
  owner.db.insert(schema.leaveApprovalPolicy).values({ tenantId: b.tenantId, companyId: b.companyId, levels });

const stepsFor = (leaveRequestId: string) =>
  owner.db
    .select({ kind: schema.leaveApprovalStep.approverKind, status: schema.leaveApprovalStep.status })
    .from(schema.leaveApprovalStep)
    .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
    .orderBy(schema.leaveApprovalStep.stepIndex);

const request = (start: string) =>
  requestLeave(adminCtx(b), {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: start,
    endDate: start,
  });

/** The write the Head select makes: one department update carrying the tri-state head. `name` is the
 *  department's required Code cell, re-sent by the grid exactly as it does for every other row. */
const saveHead = (headEmploymentId: string | null) => {
  const payload: GridSavePayload = {
    creates: [],
    updates: [{ key: 'dep-fin', id: b.deptA, name: 'Finance', headEmploymentId }],
  };
  return bulkSaveLabels(adminCtx(b), 'department', payload);
};

const storedHead = () =>
  owner.db
    .select({ head: schema.department.headEmploymentId })
    .from(schema.department)
    .where(eq(schema.department.id, b.deptA))
    .limit(1)
    .then((r) => r[0]?.head ?? null);

const ctxFor = async (p: { personId: string }, role: 'employee' | 'manager') => {
  await createAppUser(b.tenantId, p.personId, role);
  const [u] = await owner.db
    .select({ id: schema.appUser.id })
    .from(schema.appUser)
    .where(eq(schema.appUser.personId, p.personId));
  return { tenantId: b.tenantId, userId: u.id, personId: p.personId, roles: [role] } as SessionContext;
};

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject', b.deptA);
  head = await hire('Head Of Finance', b.deptA);
  peer = await hire('Peer', b.deptA);
  other = await hire('Other Manager', b.deptA);

  // The head is a real HOD: they administratively manage someone in their own department, which is what
  // gives their session RLS sight of the department's people (app.heads_department_of, migration 0121).
  // Deliberately NOT the subject's own manager — otherwise "the head could decide it" would prove
  // manager authority rather than head authority.
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: peer.employmentId,
    managerEmploymentId: head.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  // …and so is the control: another manager in the same department, with the same shape of visibility
  // and none of the head's authority.
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: other.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });

  headCtx = await ctxFor(head, 'manager');
  otherCtx = await ctxFor(other, 'manager');

  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days: '20.00',
    effectiveOn: '2026-01-01',
  });
});

afterAll(async () => {
  await closeAll();
});

describe('r285 — the Head control on System Labels decides whether a department_head step exists', () => {
  it('unset ⇒ the step is silently skipped; set through the grid payload ⇒ it is generated and resolves to that person', async () => {
    await setChain(['department_head', 'hr_admin']);

    // BEFORE — the production state this round found: no department anywhere had a head, so the step the
    // admin configured was dropped at submission and HR inherited the request without anyone noticing.
    expect(await storedHead()).toBeNull();
    const before = await request('2026-07-01');
    expect(await stepsFor(before.leaveRequestId)).toEqual([{ kind: 'hr_admin', status: 'pending' }]);

    // THE WRITE THE RESTORED SELECT MAKES.
    const res = await saveHead(head.employmentId);
    expect(res).toMatchObject({ updated: 1 });
    expect(await storedHead()).toBe(head.employmentId);

    // AFTER — the step exists, ahead of HR.
    const after = await request('2026-07-02');
    expect(await stepsFor(after.leaveRequestId)).toEqual([
      { kind: 'department_head', status: 'pending' },
      { kind: 'hr_admin', status: 'pending' },
    ]);

    // …and it resolves to the person the admin picked, not to "a head" in the abstract.
    const resolved = await withTenant(adminCtx(b), (tx) =>
      resolveSubjectHead(tx, subject.employmentId, 'department_head'),
    );
    expect(resolved).toBe(head.employmentId);
  });

  it('binds the step to THAT person: the head clears it, another manager in the same department cannot', async () => {
    await setChain(['department_head', 'hr_admin']);
    await saveHead(head.employmentId);
    const { leaveRequestId } = await request('2026-07-03');

    // The subject's own administrative manager has no authority at a HEAD step — that is the whole point
    // of the kind being a separate rung.
    await expect(decideLeave(otherCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow(
      /department head|HR/i,
    );

    // The named head clears it and the chain advances to HR.
    const advanced = await decideLeave(headCtx, { leaveRequestId, decision: 'approved' });
    expect(advanced).toMatchObject({ status: 'pending', advancedTo: 'hr_admin' });
  });

  it('None is a real value: clearing the head through the same path drops the step again', async () => {
    await setChain(['department_head', 'hr_admin']);
    await saveHead(head.employmentId);
    expect(await storedHead()).toBe(head.employmentId);

    // The blank option, which sends null — the tri-state's explicit CLEAR, not "leave it alone".
    await saveHead(null);
    expect(await storedHead()).toBeNull();

    const { leaveRequestId } = await request('2026-07-04');
    expect(await stepsFor(leaveRequestId)).toEqual([{ kind: 'hr_admin', status: 'pending' }]);
  });

  it('a text-only save leaves the head alone — renaming a department cannot unroute its approvals', async () => {
    await setChain(['department_head', 'hr_admin']);
    await saveHead(head.employmentId);

    // Exactly what the grid sends when only a text cell changed: the head re-sent unchanged.
    const payload: GridSavePayload = {
      creates: [],
      updates: [{ key: 'dep-fin', id: b.deptA, name: 'Finance & Treasury', headEmploymentId: head.employmentId }],
    };
    await bulkSaveLabels(adminCtx(b), 'department', payload);
    expect(await storedHead()).toBe(head.employmentId);

    const { leaveRequestId } = await request('2026-07-05');
    expect((await stepsFor(leaveRequestId)).map((s) => s.kind)).toContain('department_head');
  });

  it('refuses a head from another company — the same-company guard the column inherits (ADR-0071 §i)', async () => {
    const [co2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [dept2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: co2.id, name: 'Beta Ops' })
      .returning({ id: schema.department.id });
    const outsider = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Outsider', primaryEmail: `out_${randomUUID().slice(0, 8)}@t.local` },
      companyId: co2.id,
      departmentId: dept2.id,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });

    const payload: GridSavePayload = {
      creates: [],
      updates: [{ key: 'dep-fin', id: b.deptA, name: 'Finance', headEmploymentId: outsider.employmentId }],
    };
    await expect(bulkSaveLabels(adminCtx(b), 'department', payload)).rejects.toThrow();
    expect(await storedHead()).toBeNull();
  });
});
