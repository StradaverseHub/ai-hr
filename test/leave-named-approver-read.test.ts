/**
 * 0669 · A NAMED LEAVE APPROVER CAN READ THE REQUESTS THEY ARE ASKED TO APPROVE, AND NOTHING ELSE.
 *
 * Owner decision (28 Oct 2026): an employee named on a `specific_employee` approval step may SEE that
 * request — view only, HR still records the decision — even when they are not the employee's manager or HR.
 * Every read below runs as the APP ROLE with the named approver's own session, so RLS is the thing tested.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { decideLeave, editLeaveRequest, pendingLeaveTaskMetadata, requestLeave } from '../core/leave';
import { listLeaveRequests, listNamedApproverLeaveRequests } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MON = (() => {
  let d = addDays(TODAY, 14);
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
})();

async function person(name: string, role: 'employee' | 'manager' | 'hr_admin', companyId = b.companyId, departmentId = b.deptA) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `nar_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const ctx: SessionContext = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, e.personId, role),
    personId: e.personId,
    roles: [role],
  };
  return { ...e, ctx };
}

async function world() {
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
  const emp = await person('Nadia Employee', 'employee');
  const mgr = await person('Marcus Manager', 'manager');
  const nora = await person('Nora Named', 'employee');
  const otto = await person('Otto Other', 'employee');
  const colleague = await person('Colin Colleague', 'employee');
  const hr = await person('Hana HR', 'hr_admin');
  for (const sub of [emp, colleague]) {
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: sub.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
    await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId: sub.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '30.00', effectiveOn: TODAY });
  }
  const apply = (who: { ctx: SessionContext; employmentId: string }, start = MON, end = MON) =>
    requestLeave(who.ctx, { employmentId: who.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: start, endDate: end, today: TODAY }).then((r) => r.leaveRequestId);
  /** Route step 0 of a request to a named person, as a `specific_employee` snapshot (0467) would. */
  const nameStep0 = (requestId: string, employmentId: string, alternates: unknown = null) =>
    owner.db.update(schema.leaveApprovalStep)
      .set({ approverKind: 'specific_employee', approverEmploymentId: employmentId, approverAlternates: alternates })
      .where(and(eq(schema.leaveApprovalStep.leaveRequestId, requestId), eq(schema.leaveApprovalStep.stepIndex, 0)));
  return { emp, mgr, nora, otto, colleague, hr, apply, nameStep0 };
}

/** What the caller's session can read through RLS, table by table, for one request. */
async function reads(ctx: SessionContext, requestId: string, subjectEmploymentId: string) {
  return withTenant(ctx, async (tx) => {
    const n = async (q: ReturnType<typeof sql>) => Number(((await tx.execute(q)) as unknown as { n: number }[])[0].n);
    return {
      request: await n(sql`select count(*)::int n from leave_request where id = ${requestId}`),
      steps: await n(sql`select count(*)::int n from leave_approval_step where leave_request_id = ${requestId}`),
      dates: await n(sql`select count(*)::int n from leave_request_date where leave_request_id = ${requestId}`),
      employment: await n(sql`select count(*)::int n from employment where id = ${subjectEmploymentId}`),
      person: await n(sql`select count(*)::int n from person p join employment e on e.person_id = p.id where e.id = ${subjectEmploymentId}`),
      ledger: await n(sql`select count(*)::int n from leave_ledger where employment_id = ${subjectEmploymentId}`),
      events: await n(sql`select count(*)::int n from domain_event where aggregate_id = ${requestId}`),
    };
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
});

describe('0669 · the named approver reads the request routed to them', () => {
  it('reads the request, its steps and dates, with the employee name only, and nothing else about the employee', async () => {
    const w = await world();
    const id = await w.apply(w.emp);
    expect(await reads(w.nora.ctx, id, w.emp.employmentId), 'premise: before naming, nothing').toMatchObject({ request: 0, steps: 0, dates: 0 });

    await w.nameStep0(id, w.nora.employmentId);
    // A per-date row (ADR-0068), so the date read below is not vacuous for a whole-request request.
    await owner.db.insert(schema.leaveRequestDate).values({ tenantId: b.tenantId, leaveRequestId: id, subjectEmploymentId: w.emp.employmentId, leaveDate: MON, days: '1.00' }).onConflictDoNothing();
    const r = await reads(w.nora.ctx, id, w.emp.employmentId);
    expect(r.request).toBe(1);
    expect(r.steps).toBe(2);
    const ownerDates = await owner.db.select({ id: schema.leaveRequestDate.id }).from(schema.leaveRequestDate).where(eq(schema.leaveRequestDate.leaveRequestId, id));
    expect(ownerDates.length).toBeGreaterThan(0);
    expect(r.dates, 'every per-date row the request has').toBe(ownerDates.length);
    // Nothing else about the employee: no employment, person, balance or event rows.
    expect({ employment: r.employment, person: r.person, ledger: r.ledger, events: r.events }).toEqual({ employment: 0, person: 0, ledger: 0, events: 0 });

    // The inbox reader: the request with the employee's display name and no profile facts.
    const rows = await listNamedApproverLeaveRequests(w.nora.ctx);
    expect(rows.map((x) => x.id)).toEqual([id]);
    expect(rows[0]).toMatchObject({ employee: 'Nadia Employee', employeeCode: null, personId: null, namedApproverView: true, currentStepKind: 'specific_employee' });
    expect(Number(rows[0].applicantBalance), 'balance stays hidden').toBe(0);
    // The ordinary reader still drops it (its employment join is RLS-bound) — the widening is only this one.
    expect((await listLeaveRequests(w.nora.ctx)).map((x) => x.id)).not.toContain(id);
    // And the task source counts it as hers while her step is current.
    expect((await pendingLeaveTaskMetadata(w.nora.ctx)).map((x) => ({ id: x.id, employee: x.employee, personId: x.personId })))
      .toEqual([{ id, employee: 'Nadia Employee', personId: null }]);
  });

  it('an any-one alternate who is named also reads it', async () => {
    const w = await world();
    const id = await w.apply(w.emp);
    await w.nameStep0(id, w.otto.employmentId, [{ kind: 'specific_employee', employmentId: w.nora.employmentId.toUpperCase() }, 'hr_admin']);
    expect((await reads(w.nora.ctx, id, w.emp.employmentId)).request).toBe(1);
    expect((await reads(w.otto.ctx, id, w.emp.employmentId)).request).toBe(1);
  });

  it('is VIEW ONLY: no write reaches the row and deciding is refused', async () => {
    const w = await world();
    const id = await w.apply(w.emp);
    await w.nameStep0(id, w.nora.employmentId);
    const updated = await withTenant(w.nora.ctx, (tx) => tx.update(schema.leaveRequest).set({ reason: 'tampered' }).where(eq(schema.leaveRequest.id, id)).returning({ id: schema.leaveRequest.id }));
    expect(updated).toEqual([]);
    const stepWrites = await withTenant(w.nora.ctx, (tx) => tx.update(schema.leaveApprovalStep).set({ status: 'approved' }).where(eq(schema.leaveApprovalStep.leaveRequestId, id)).returning({ id: schema.leaveApprovalStep.id }));
    expect(stepWrites).toEqual([]);
    await expect(decideLeave(w.nora.ctx, { leaveRequestId: id, decision: 'approved' })).rejects.toThrow();
    const [row] = await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id));
    expect({ status: row.status, reason: row.reason }).toEqual({ status: 'pending', reason: null });
  });
});

describe('0669 · leakage', () => {
  it('another employee’s request, a colleague, another company and another tenant read nothing', async () => {
    const w = await world();
    const named = await w.apply(w.emp);
    const notNamed = await w.apply(w.colleague);
    await w.nameStep0(named, w.nora.employmentId);
    await w.nameStep0(notNamed, w.otto.employmentId);

    // Nora: only the request that names her.
    expect((await reads(w.nora.ctx, notNamed, w.colleague.employmentId)).request).toBe(0);
    expect((await listNamedApproverLeaveRequests(w.nora.ctx)).map((x) => x.id)).toEqual([named]);
    // A colleague named nowhere reads neither.
    expect((await reads(w.colleague.ctx, named, w.emp.employmentId)).request).toBe(0);
    expect(await listNamedApproverLeaveRequests(w.colleague.ctx)).toEqual([]);

    // Another company in the same tenant: a request whose step names someone else stays invisible to Nora.
    const [c2] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Beta Sdn Bhd', country: 'MY' }).returning({ id: schema.company.id });
    const [d2] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: c2.id, name: 'Beta Ops' }).returning({ id: schema.department.id });
    const beta = await person('Bea Beta', 'employee', c2.id, d2.id);
    const [betaReq] = await owner.client.unsafe(
      `insert into leave_request select (jsonb_populate_record(null::leave_request, to_jsonb(lr) || jsonb_build_object('id', gen_random_uuid(), 'employment_id', $1::uuid))).* from leave_request lr where lr.id = $2 returning id`,
      [beta.employmentId, named],
    ) as unknown as { id: string }[];
    await owner.client.unsafe(
      `insert into leave_approval_step (tenant_id, leave_request_id, subject_employment_id, step_index, approver_kind, approver_employment_id) values ($1, $2, $3, 0, 'specific_employee', $4)`,
      [b.tenantId, betaReq.id, beta.employmentId, w.otto.employmentId],
    );
    expect((await reads(w.nora.ctx, betaReq.id, beta.employmentId)).request).toBe(0);
    expect((await reads(w.otto.ctx, betaReq.id, beta.employmentId)).request, 'sanity: the named one reads it').toBe(1);
    // Company scope fence on the reader: Otto's company-B request is excluded when he scopes to company A.
    expect((await listNamedApproverLeaveRequests(w.otto.ctx, [b.companyId])).map((x) => x.id)).toEqual([notNamed]);

    // Another tenant: the same employment-id trick cannot cross the tenant boundary.
    const bA = b;
    b = await seedBase();
    const foreignNora = await person('Nora Named', 'employee');
    b = bA;
    expect((await reads({ ...w.nora.ctx, tenantId: foreignNora.ctx.tenantId }, named, w.emp.employmentId)).request).toBe(0);
    expect((await reads(foreignNora.ctx, named, w.emp.employmentId)).request).toBe(0);
    expect(await listNamedApproverLeaveRequests(foreignNora.ctx)).toEqual([]);
  });

  it('after the approver is REPLACED (request edited onto a chain naming someone else) the old one reads nothing', async () => {
    const w = await world();
    const id = await w.apply(w.emp);
    await w.nameStep0(id, w.nora.employmentId);
    expect((await reads(w.nora.ctx, id, w.emp.employmentId)).request).toBe(1);
    // Editing a pending request deletes and regenerates its steps (core/leave.ts editLeaveRequest).
    await editLeaveRequest(w.emp.ctx, { leaveRequestId: id, leaveTypeId: b.annualLeaveTypeId, startDate: addDays(MON, 1), endDate: addDays(MON, 1), today: TODAY });
    await w.nameStep0(id, w.otto.employmentId);
    expect(await reads(w.nora.ctx, id, w.emp.employmentId)).toMatchObject({ request: 0, steps: 0, dates: 0 });
    expect(await listNamedApproverLeaveRequests(w.nora.ctx)).toEqual([]);
    expect(await pendingLeaveTaskMetadata(w.nora.ctx)).toEqual([]);
    expect((await reads(w.otto.ctx, id, w.emp.employmentId)).request).toBe(1);
  });

  it('keeps PAST steps for history, but an approver who has left reads nothing', async () => {
    const w = await world();
    const id = await w.apply(w.emp);
    await w.nameStep0(id, w.nora.employmentId);
    // HR clears both steps (the admin override on a named step), so the request is decided.
    await decideLeave(w.hr.ctx, { leaveRequestId: id, decision: 'approved' });
    await decideLeave(w.hr.ctx, { leaveRequestId: id, decision: 'approved' });
    const [row] = await owner.db.select({ status: schema.leaveRequest.status }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id));
    expect(row.status).toBe('approved');
    expect((await reads(w.nora.ctx, id, w.emp.employmentId)).request, 'history stays readable').toBe(1);
    expect(await pendingLeaveTaskMetadata(w.nora.ctx), 'but it is no longer her task').toEqual([]);
    expect(await listNamedApproverLeaveRequests(w.nora.ctx), 'and not in the pending inbox').toEqual([]);

    await owner.db.update(schema.employment).set({ terminatedOn: addDays(TODAY, -1) }).where(eq(schema.employment.id, w.nora.employmentId));
    expect((await reads(w.nora.ctx, id, w.emp.employmentId)).request).toBe(0);
  });

  it('the definer read returns only id, subject, company and name', async () => {
    const cols = (await owner.db.execute(sql`
      SELECT unnest(p.proargnames) AS name, unnest(p.proargmodes) AS mode
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'named_leave_approver_requests'`))
      .filter((r) => (r as { mode: string }).mode === 't').map((r) => (r as { name: string }).name);
    expect(cols).toEqual(['leave_request_id', 'employment_id', 'company_id', 'employee_name']);
    const policies = (await owner.db.execute(sql`
      SELECT tablename, cmd FROM pg_policies WHERE policyname LIKE '%_named_approver_read' ORDER BY tablename`)) as unknown as { tablename: string; cmd: string }[];
    expect(policies).toEqual([
      { tablename: 'leave_approval_step', cmd: 'SELECT' },
      { tablename: 'leave_request', cmd: 'SELECT' },
      { tablename: 'leave_request_attachment', cmd: 'SELECT' },
      { tablename: 'leave_request_date', cmd: 'SELECT' },
    ]);
  });
});
