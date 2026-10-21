import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { assignDefaultShift, assignShift, createShift, rosterWindowView } from '../core/roster';
import { setAttendancePolicy } from '../packs/attendance/service';
import { approvedLeaveDates, approvedLeavePresenceByEmploymentTx } from '../packs/leave/service';
import { holidayCalendarFactsByEmployment, holidayDatesByEmployment } from '../core/holidays';
import { reconcileReplacementHolidays, saveReplacementHolidayPolicy } from '../core/holiday-replacements';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
const today = todayInKualaLumpur();
const add = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let first = add(today, 35); while (new Date(`${first}T00:00:00Z`).getUTCDay() !== 1) first = add(first, 1);
const dates = Array.from({ length: 4 }, (_, i) => add(first, i));
let b: Base, hr: SessionContext, manager: SessionContext, employee: { employmentId: string; personId: string }, unrelated: { employmentId: string };
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); hr = adminCtx(b);
  const hire = (name: string, departmentId = b.deptA) => hireEmployee(hr, { person: { fullName: name, primaryEmail: `${randomUUID()}@roster-context.invalid` }, companyId: b.companyId, departmentId, employmentType: 'full_time', hiredOn: add(today, -800) });
  // A manager with reports also has the established department visibility arm. Put the unrelated
  // person in another department so this is an actual denial, not an invented narrower policy.
  employee = await hire('Context employee'); const boss = await hire('Context manager'); unrelated = await hire('Unrelated employee', b.deptB);
  const userId = await createAppUser(b.tenantId, boss.personId, 'manager');
  manager = { tenantId: b.tenantId, userId, personId: boss.personId, roles: ['manager'], entitlements: harnessSnapshot(b.tenantId) };
  await setReportingLine(hr, { subordinateEmploymentId: employee.employmentId, managerEmploymentId: boss.employmentId, lineType: 'administrative', validFrom: add(today, -700) });
  const shift = await createShift(hr, { name: 'Context shift', code: 'CTX', startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [2,3,4,5,6,7] });
  await assignDefaultShift(hr, { employmentId: employee.employmentId, shiftId: shift.id });
  await assignShift(hr, { employmentId: employee.employmentId, shiftDate: dates[3], shiftId: shift.id });
  await setAttendancePolicy(hr, { companyId: b.companyId, workStart: '09:00', workEnd: '18:00', breakMinutes: 60, lateAfter: '09:00', halfDayBefore: '13:00', workingDays: [1,2,3,4,5,6,7] });
  await owner.db.insert(schema.holiday).values({ tenantId: b.tenantId, country: 'MY', companyId: b.companyId, holidayDate: first, name: 'Context original holiday' });
  await saveReplacementHolidayPolicy(hr, { companyId: b.companyId, effectiveFrom: today, regime: 'company_confirmed', confirmed: true, restMode: 'scheduled_rest', halfEligible: false, searchDays: 30, reason: 'Fictional company policy confirmed for the roster context fixture.' });
  await reconcileReplacementHolidays(hr, employee.employmentId);
  const request = async (employmentId: string, start: string, end: string, durationType: 'full_day' | 'half_day_am', status: 'approved' | 'pending') => (await owner.db.insert(schema.leaveRequest).values({ tenantId: b.tenantId, employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: start, endDate: end, durationType, status, days: durationType === 'full_day' ? '1' : '0.5', reason: 'PRIVATE medical reason must not reach the roster', employeeRemark: 'PRIVATE consent and medical details' }).returning())[0];
  await request(employee.employmentId, first, first, 'full_day', 'approved');
  const dated = await request(employee.employmentId, dates[1], dates[2], 'full_day', 'pending');
  await owner.db.insert(schema.leaveRequestDate).values([
    { tenantId: b.tenantId, leaveRequestId: dated.id, subjectEmploymentId: employee.employmentId, leaveDate: dates[1], days: '1', status: 'approved' },
    { tenantId: b.tenantId, leaveRequestId: dated.id, subjectEmploymentId: employee.employmentId, leaveDate: dates[2], days: '1', status: 'rejected' },
  ]);
  await request(employee.employmentId, dates[3], dates[3], 'half_day_am', 'approved');
  await request(unrelated.employmentId, dates[3], dates[3], 'full_day', 'approved');
});
const view = (ctx = hr) => rosterWindowView(ctx, { companyIds: [b.companyId], from: first, to: dates[3] });
describe('roster day context uses canonical facts without changing assignments or exposing leave detail', () => {
  it('keeps original and allocated replacement facts separate while legacy calendar consumers retain their union', async () => {
    const facts = await withTenant(hr, tx => holidayCalendarFactsByEmployment(tx, { employmentIds: [employee.employmentId], startDate: first, endDate: dates[3] }));
    expect([...facts.holidays.get(employee.employmentId)!]).toEqual([first]);
    expect([...facts.replacements.get(employee.employmentId)!]).toEqual([dates[1]]);
    const union = await withTenant(hr, tx => holidayDatesByEmployment(tx, { employmentIds: [employee.employmentId], startDate: first, endDate: dates[3] }));
    expect([...union.get(employee.employmentId)!].sort()).toEqual(dates.slice(0, 2));
  });
  it('shows overlapping facts and partial leave, excludes rejected dates, and preserves every assignment and request', async () => {
    const beforeRequests = await owner.db.select().from(schema.leaveRequest).orderBy(asc(schema.leaveRequest.id));
    const beforeRoster = await owner.db.select().from(schema.rosterAssignment).orderBy(asc(schema.rosterAssignment.id));
    const result = await view();
    expect(result.dayContext[`${employee.employmentId}|${first}`]).toEqual({ publicHoliday: true, approvedLeave: 'full_day' });
    expect(result.dayContext[`${employee.employmentId}|${dates[1]}`]).toEqual({ replacementHoliday: true, approvedLeave: 'full_day' });
    expect(result.dayContext[`${employee.employmentId}|${dates[2]}`]).toBeUndefined();
    expect(result.dayContext[`${employee.employmentId}|${dates[3]}`]).toEqual({ approvedLeave: 'part_day' });
    expect(result.cells[`${employee.employmentId}|${dates[3]}`]?.kind).toBe('shift');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await owner.db.select().from(schema.leaveRequest).orderBy(asc(schema.leaveRequest.id))).toEqual(beforeRequests);
    expect(await owner.db.select().from(schema.rosterAssignment).orderBy(asc(schema.rosterAssignment.id))).toEqual(beforeRoster);
  });
  it('retains full-day-only absence relief and keeps unrelated leave outside the manager read', async () => {
    const fullDays = await withTenant(hr, tx => approvedLeaveDates(tx, [employee.employmentId], first, dates[3]));
    expect([...fullDays.get(employee.employmentId)!].sort()).toEqual(dates.slice(0, 2));
    const permitted = await withTenant(manager, tx => approvedLeavePresenceByEmploymentTx(tx, [employee.employmentId, unrelated.employmentId], first, dates[3]));
    expect(permitted.get(employee.employmentId)?.get(dates[3])).toBe('part_day');
    expect(permitted.has(unrelated.employmentId)).toBe(false);
    const result = await view(manager);
    expect(result.employees.some(row => row.employmentId === unrelated.employmentId)).toBe(false);
    expect(Object.keys(result.dayContext).some(key => key.startsWith(unrelated.employmentId))).toBe(false);
  });
});
