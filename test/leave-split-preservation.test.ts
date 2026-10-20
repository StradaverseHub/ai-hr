import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { decideLeaveCancellation, requestLeaveCancellation, LeaveCancellationNotAllowedError } from '../core/leave';
import { unpaidDaysByEmployment } from '../core/payroll';
import { leaveSplitReview } from '../core/leave-split-review';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const today = todayInKualaLumpur();
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const monday = (() => {
  let date = addDays(today, 35);
  while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) date = addDays(date, 1);
  return date;
})();
const dates = Array.from({ length: 5 }, (_, i) => addDays(monday, i));
let b: Base;
let subject: { employmentId: string; personId: string };
let employee: SessionContext;
let manager: SessionContext;

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const hire = (name: string) => hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${randomUUID()}@split.test` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: addDays(today, -800),
  });
  subject = await hire('Split subject');
  const boss = await hire('Split approver');
  const userId = await createAppUser(b.tenantId, subject.personId, 'employee');
  const bossId = await createAppUser(b.tenantId, boss.personId, 'manager');
  employee = { tenantId: b.tenantId, userId, personId: subject.personId, roles: ['employee'] };
  manager = { tenantId: b.tenantId, userId: bossId, personId: boss.personId, roles: ['manager'] };
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId, managerEmploymentId: boss.employmentId,
    lineType: 'administrative', validFrom: addDays(today, -700),
  });
});
afterAll(closeAll);

async function original(p: { imported?: boolean; charged?: boolean; maternity?: boolean } = {}) {
  const [type] = await owner.db.insert(schema.leaveType).values({
    tenantId: b.tenantId, code: p.maternity ? 'MATERNITY' : 'UNPAID', name: p.maternity ? 'Maternity' : 'Unpaid',
    paid: p.maternity === true, role: p.maternity ? 'maternity' : null,
    counting: 'working_days', employeeCancelApproved: true,
  }).returning();
  const createdAt = new Date(`${addDays(today, -20)}T09:00:00Z`);
  const unpaidConsentAt = new Date(`${addDays(today, -19)}T09:00:00Z`);
  const [request] = await owner.db.insert(schema.leaveRequest).values({
    tenantId: b.tenantId, employmentId: subject.employmentId, leaveTypeId: type.id,
    startDate: monday, endDate: dates[4], days: '5.00', durationType: 'full_day', status: 'approved',
    reason: 'Original reason', employeeRemark: 'Original employee remark',
    unpaidConsentAt, unpaidConsentBy: employee.userId, survivingChildren: p.maternity ? 5 : null,
    confinementDate: p.maternity ? monday : null, allowanceEligible: p.maternity ? false : null,
    unpaidDays: null, importedHistory: p.imported ?? false,
    externalReference: p.imported ? `OLD/${randomUUID()}` : null,
    entitlementYear: Number(monday.slice(0, 4)) - 1, submittedOn: addDays(today, -19),
    createdAt, decidedAt: new Date(`${addDays(today, -18)}T09:00:00Z`),
  }).returning();
  if (p.charged) {
    await owner.db.insert(schema.leaveLedger).values([
      { tenantId: b.tenantId, employmentId: subject.employmentId, leaveTypeId: type.id, entryType: 'accrual', days: '30.00', effectiveOn: addDays(today, -30) },
      { tenantId: b.tenantId, employmentId: subject.employmentId, leaveTypeId: type.id, entryType: 'debit', days: '-5.00', sourceRequestId: request.id, effectiveOn: monday },
    ]);
  }
  return request;
}

async function cancel(id: string, date: string) {
  const { cancellationRequestId } = await requestLeaveCancellation(employee, { leaveRequestId: id, cancelDates: [date], today });
  await decideLeaveCancellation(manager, { cancellationRequestId, decision: 'approved' });
}
async function requests() {
  return owner.db.select().from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, subject.employmentId))
    .orderBy(asc(schema.leaveRequest.startDate), asc(schema.leaveRequest.id));
}

const preserved = (r: typeof schema.leaveRequest.$inferSelect) => ({
  reason: r.reason, employeeRemark: r.employeeRemark, unpaidConsentAt: r.unpaidConsentAt,
  unpaidConsentBy: r.unpaidConsentBy, survivingChildren: r.survivingChildren,
  confinementDate: r.confinementDate, allowanceEligible: r.allowanceEligible, unpaidDays: r.unpaidDays,
  entitlementYear: r.entitlementYear, submittedOn: r.submittedOn, importedHistory: r.importedHistory,
  createdAt: r.createdAt, decidedAt: r.decidedAt, decidedByEmploymentId: r.decidedByEmploymentId,
});

describe('approved leave split preserves application facts', () => {
  it.each([0, 2, 4])('retains unpaid maternity facts after cancelling date index %i', async (index) => {
    const request = await original({ maternity: true, charged: true });
    await cancel(request.id, dates[index]);
    const rows = await requests();
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(preserved(row)).toEqual(preserved(request));
    const unpaid = await withTenant(adminCtx(b), tx => unpaidDaysByEmployment(tx, monday, dates[4]));
    expect(unpaid.get(subject.employmentId)).toBe(4);
  });

  it.each([false, true])('preserves imported provenance and actual ledger charging (charged=%s), including repeated splits', async (charged) => {
    const request = await original({ imported: true, charged });
    await cancel(request.id, dates[0]);
    const survivor = (await requests()).find(r => r.status === 'approved')!;
    expect(survivor.id).not.toBe(request.id);
    await cancel(survivor.id, dates[2]);
    const rows = await requests();
    expect(rows.filter(r => r.status === 'approved').reduce((sum, r) => sum + Number(r.days), 0)).toBe(3);
    for (const row of rows) expect(preserved(row)).toEqual(preserved(request));
    expect(rows.filter(r => r.externalReference != null).map(r => r.id)).toEqual([request.id]);
    const ledger = await owner.db.select().from(schema.leaveLedger).where(and(
      eq(schema.leaveLedger.employmentId, subject.employmentId), eq(schema.leaveLedger.entryType, 'debit'),
    ));
    expect(ledger.reduce((sum, r) => sum + Number(r.days), 0)).toBe(charged ? -3 : 0);
    const unpaid = await withTenant(adminCtx(b), tx => unpaidDaysByEmployment(tx, monday, dates[4]));
    expect(unpaid.get(subject.employmentId) ?? 0).toBe(charged ? 3 : 0);
    const splitEvents = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'leave-request.split'));
    expect(splitEvents.some(e => (e.payload as { splitFromRequestId?: string }).splitFromRequestId === survivor.id)).toBe(true);
  });

  it.each([false, true])('retains exact database timestamp precision and nullable facts through repeated splits (timestamps=%s)', async hasNullableTimestamps => {
    const request = await original({ imported: true, charged: true });
    // Deliberate historical stored facts: JS Date cannot represent these microseconds.
    const created = `${addDays(today, -20)}T09:00:00.123456Z`;
    const decided = hasNullableTimestamps ? `${addDays(today, -18)}T09:00:00.654321Z` : null;
    const consent = hasNullableTimestamps ? `${addDays(today, -19)}T09:00:00.987654Z` : null;
    await owner.db.execute(sql`update leave_request set created_at=${created}::timestamptz,
      decided_at=${decided}::timestamptz, unpaid_consent_at=${consent}::timestamptz where id=${request.id}::uuid`);
    const rawTimestamps = () => owner.db.select({
      id: schema.leaveRequest.id,
      created: sql<string>`${schema.leaveRequest.createdAt}::text`,
      decided: sql<string | null>`${schema.leaveRequest.decidedAt}::text`,
      consent: sql<string | null>`${schema.leaveRequest.unpaidConsentAt}::text`,
    }).from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, subject.employmentId)).orderBy(asc(schema.leaveRequest.id));
    const before = await rawTimestamps();
    expect(before).toHaveLength(1);
    await cancel(request.id, dates[0]);
    const survivor = (await requests()).find(row => row.status === 'approved');
    expect(survivor).toBeDefined();
    await cancel(survivor!.id, dates[2]);
    const after = await rawTimestamps();
    expect(after.length).toBeGreaterThan(2);
    const {id: _originalId, ...expected} = before[0];
    for (const {id: _id, ...actual} of after) expect(actual).toEqual(expected);
    const stored = await requests();
    const review = await leaveSplitReview(adminCtx(b));
    expect(review.total).toBe(0);
    expect(await requests()).toEqual(stored);
  });

  it('keeps the mixed paid/unpaid refusal without changing rows or ledger', async () => {
    const request = await original({ charged: true });
    await owner.db.update(schema.leaveRequest).set({ unpaidDays: '2.00' }).where(eq(schema.leaveRequest.id, request.id));
    await expect(cancel(request.id, dates[2])).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
    expect(await requests()).toHaveLength(1);
    expect((await requests())[0].status).toBe('approved');
  });

  it('reports older lost import facts as uncertain candidates and never repairs the source', async () => {
    const request = await original({ imported: true });
    await cancel(request.id, dates[0]);
    const survivor = (await requests()).find(r => r.status === 'approved')!;
    // Reproduce the old split writer's output, independently of the new writer.
    await owner.db.update(schema.leaveRequest).set({ importedHistory: false, entitlementYear: null, submittedOn: null })
      .where(eq(schema.leaveRequest.id, survivor.id));
    const before = await requests();
    const review = await leaveSplitReview(adminCtx(b));
    expect(review.total).toBe(1);
    expect(review.rows).toEqual([expect.objectContaining({
      requestId: survivor.id, rootRequestId: request.id, lineage: 'current_root_comparison',
      differences: expect.arrayContaining(['entitlementYear', 'submission', 'importedHistory']),
      charging: 'no_debit_evidence',
    })]);
    expect(await requests()).toEqual(before);
    await expect(leaveSplitReview(manager)).rejects.toThrow('HR administrator required');
    await expect(leaveSplitReview(employee)).rejects.toThrow('HR administrator required');
  });

  it('traces repeated splits to the original application and labels missing evidence unresolved', async () => {
    const request = await original({ imported: true, charged: true });
    await cancel(request.id, dates[0]);
    const survivor = (await requests()).find(r => r.status === 'approved')!;
    await cancel(survivor.id, dates[2]);
    const later = (await requests()).find(r => r.status === 'approved' && r.startDate === dates[3])!;
    await owner.db.update(schema.leaveRequest).set({ entitlementYear: null }).where(eq(schema.leaveRequest.id, later.id));
    const review = await leaveSplitReview(adminCtx(b));
    expect(review.rows).toContainEqual(expect.objectContaining({ requestId: later.id, rootRequestId: request.id }));
    const [broken] = await owner.db.insert(schema.leaveRequest).values({ ...later, id: randomUUID(), externalReference: null }).returning();
    await owner.db.insert(schema.domainEvent).values({
      tenantId: b.tenantId, aggregateType: 'leave-request', aggregateId: broken.id,
      eventType: 'leave-request.split', actorType: 'system', subjectEmploymentId: subject.employmentId,
      payload: { splitFromRequestId: randomUUID() },
    });
    const unresolved = await leaveSplitReview(adminCtx(b));
    expect(unresolved.rows).toContainEqual(expect.objectContaining({ requestId: broken.id, rootRequestId: null, lineage: 'unresolved', differences: ['lineage'] }));
  });
});
