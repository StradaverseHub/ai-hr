/** Reproduced in the real app: one cancellation turned a 98-calendar-day maternity request into
 * 69 recorded days. Exercise public submission/approval/cancellation and both actual candidate reads. */
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';
import { readFileSync } from 'node:fs';

// Supply the real catalogue outside a Next request; database reads and the shipping projection stay real.
vi.mock('next-intl/server', async () => {
  const {createTranslator}=await import('next-intl');
  const {readFileSync}=await import('node:fs');
  const catalogue=JSON.parse(readFileSync('messages/en.json','utf8')) as Record<string,AbstractIntlMessages>;
  return {getLocale:async()=> 'en',getTranslations:async(namespace:string)=>{
    const messages=catalogue[namespace];if(!messages)throw Error(`Unexpected namespace ${namespace}`);
    return createTranslator({locale:'en',messages});
  }};
});
vi.mock('../app/(app)/leave/actions',()=>({requestLeaveCancellationAction:vi.fn(),editLeaveAction:vi.fn(),cancelOwnLeaveAction:vi.fn()}));
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { decideLeave, decideLeaveCancellation, requestLeave, requestLeaveCancellation } from '../core/leave';
import { leaveRequestsFor, listLeaveRequests, plannedAbsences, myEmployment, listLeaveTypes } from '../core/read';
import { loadOwnLeaveHistory } from '../components/leave/own-leave-history';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase } from './harness';

const today = todayInKualaLumpur();
const add = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const start = (() => { let date = add(today, 35); while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) date = add(date, 1); return date; })();
const dates = Array.from({ length: 98 }, (_, i) => add(start, i));
let employmentId: string;
let companyId: string;
let leaveTypeId: string;
let requestId: string;
let employee: SessionContext;
let manager: SessionContext;

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  const b = await seedBase(), hr = adminCtx(b);
  const hire = (name: string) => hireEmployee(hr, { person: { fullName: name, primaryEmail: `${randomUUID()}@calendar-cancel.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: add(today, -900) });
  const subject = await hire('Fictional calendar maternity subject'), boss = await hire('Fictional calendar approver');
  employmentId = subject.employmentId; companyId = b.companyId;
  await owner.db.update(schema.person).set({ gender: 'female' }).where(eq(schema.person.id, subject.personId));
  employee = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, subject.personId, 'employee'), personId: subject.personId, roles: ['employee'] };
  manager = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, boss.personId, 'manager'), personId: boss.personId, roles: ['manager'] };
  await setLeaveApprovalPolicy(hr, { companyId: b.companyId, levels: ['direct_manager'] });
  await setReportingLine(hr, { subordinateEmploymentId: employmentId, managerEmploymentId: boss.employmentId, lineType: 'administrative', validFrom: add(today, -800) });
  const [type] = await owner.db.insert(schema.leaveType).values({ tenantId: b.tenantId, code: 'MATERNITY', name: 'Maternity', role: 'maternity', paid: true, counting: 'calendar_days', eligibility: { gender: 'female' }, employeeCancelApproved: true }).returning();
  leaveTypeId = type.id;
  await owner.db.insert(schema.leaveLedger).values({ tenantId: b.tenantId, employmentId, leaveTypeId, entryType: 'accrual', days: '120.00', effectiveOn: today });
  const submitted = await requestLeave(employee, { employmentId, leaveTypeId, startDate: start, endDate: add(start, 97), today, survivingChildren: 5, confinementDate: start, employeeRemark: 'Original maternity statement', reason: 'Fictional calendar-counted request' });
  requestId = submitted.leaveRequestId;
  await decideLeave(manager, { leaveRequestId: requestId, decision: 'approved' });
  const [approved] = await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, requestId));
  expect(approved).toMatchObject({ status: 'approved', days: '98.00' });
  expect(net(await ledger())).toBe(22);
});
afterAll(closeAll);

const rows = () => owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, employmentId)).orderBy(asc(schema.leaveRequest.startDate), asc(schema.leaveRequest.id));
const ledger = () => owner.db.select().from(schema.leaveLedger).where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId))).orderBy(asc(schema.leaveLedger.effectiveOn), asc(schema.leaveLedger.createdAt), asc(schema.leaveLedger.id));
const net = (entries: Awaited<ReturnType<typeof ledger>>) => entries.reduce((sum, row) => sum + Number(row.days), 0);
const facts = (row: Awaited<ReturnType<typeof rows>>[number]) => ({ employeeRemark: row.employeeRemark, reason: row.reason, survivingChildren: row.survivingChildren, confinementDate: row.confinementDate, allowanceEligible: row.allowanceEligible, entitlementYear: row.entitlementYear, submittedOn: row.submittedOn, createdAt: row.createdAt, decidedAt: row.decidedAt });

describe('calendar-counted partial cancellation preserves the actual charged dates', () => {
  it('offers all calendar dates in request history, personnel history and the calendar, including terminal weekends', async () => {
    const history = await listLeaveRequests(employee, [companyId]);
    expect(history.find(row => row.id === requestId)?.workingDates).toEqual(dates);
    const personnelHistory = await leaveRequestsFor(employee, employmentId);
    expect(personnelHistory.find(row => row.id === requestId)?.workingDates).toEqual(dates);
    const calendar = await plannedAbsences(employee, [companyId], { from: start, to: add(start, 97) }, today);
    expect(calendar.flatMap(person => person.leaves).find(row => row.id === requestId)?.candidateCancelDates).toEqual(dates);
  });

  it.each([2, 5, 97])('cancels calendar date offset %i and retains exactly the other 97 dates and one-day ledger movement', async offset => {
    const original = (await rows()).find(row => row.id === requestId)!;
    expect(original.days).toBe('98.00');
    const before = await ledger();
    expect(net(before)).toBe(22);
    const cancelledDate = add(start, offset);
    const pending = await requestLeaveCancellation(employee, { leaveRequestId: requestId, cancelDates: [cancelledDate], today });
    expect(pending.requestedDays).toBe(1);
    const result = await decideLeaveCancellation(manager, { cancellationRequestId: pending.cancellationRequestId, decision: 'approved' });
    expect(result).toMatchObject({ status: 'approved', restoredDays: 1, remainingDays: 97 });
    const after = await rows(), approved = after.filter(row => row.status === 'approved');
    expect(approved.reduce((sum, row) => sum + Number(row.days), 0)).toBe(97);
    const survivingDates = approved.flatMap(row => Array.from({ length: Math.round((Date.parse(row.endDate) - Date.parse(row.startDate)) / 86_400_000) + 1 }, (_, i) => add(row.startDate, i))).sort();
    expect(survivingDates).toEqual(dates.filter(date => date !== cancelledDate));
    expect(after.filter(row => row.status === 'cancelled').map(row => ({ start: row.startDate, end: row.endDate, days: row.days }))).toEqual([{ start: cancelledDate, end: cancelledDate, days: '1.00' }]);
    for (const row of after) expect(facts(row)).toEqual(facts(original));
    const history = await listLeaveRequests(employee, [companyId]);
    const personal = await leaveRequestsFor(employee, employmentId);
    for (const row of after) {
      expect(row.parentGroupId).not.toBeNull();
      expect(history.find(item => item.id === row.id)?.isEmergencyGroup).toBe(false);
      expect(personal.find(item => item.id === row.id)?.isEmergencyGroup).toBe(false);
    }
    if (offset === 2) {
      const me=await myEmployment(employee);if(!me)throw Error('Expected the authenticated fixture employment');
      const leaveTypes=await listLeaveTypes(employee);
      const projected=await loadOwnLeaveHistory({session:employee,me,sp:{hTab:'approved'},locale:'en',leaveTypes,eligibleTypeIds:new Set(leaveTypes.map(type=>type.id))});
      const messages=JSON.parse(readFileSync('messages/en.json','utf8')) as AbstractIntlMessages;
      const html=renderToStaticMarkup(createElement(NextIntlClientProvider,{locale:'en',timeZone:'Asia/Kuala_Lumpur',messages,children:projected.history}));
      const actualType=leaveTypes.find(type=>type.id===leaveTypeId);if(!actualType)throw Error('Expected the actual maternity fixture type');
      expect(html).toContain(actualType.name);
      expect(html).not.toContain('Emergency Leave');
    }
    const afterLedger = await ledger();
    expect(net(afterLedger)).toBe(23);
    expect(net(afterLedger) - net(before)).toBe(1);
  });
});
