/** Authored actual calendar writer interleavings. UNRUN pending coordinated local admission. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { createHoliday, updateHoliday, deleteHoliday, createHolidayGroup, updateHolidayGroup,
  deleteHolidayGroup, setGroupHolidays } from '../core/admin';
import { hireEmployee, setEmploymentWorkState, setEmploymentHolidayCalendar } from '../core/org';
import { saveEmploymentHolidayCalendarAssignment } from '../core/holiday-calendar-assignment';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);

async function freeDates() {
  const existing = await owner.db.select({ date: schema.holiday.holidayDate }).from(schema.holiday)
    .where(eq(schema.holiday.tenantId, b.tenantId)).orderBy(schema.holiday.id);
  const used = new Set(existing.map(row => row.date)), free: string[] = [];
  const day = new Date(todayInKualaLumpur() + 'T00:00:00Z');
  for (let i = 0; i < 366 && free.length < 2; i++) {
    const date = day.toISOString().slice(0, 10); if (!used.has(date)) free.push(date);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  if (free.length !== 2) throw new Error('Fictional free holiday dates unavailable');
  return free;
}

describe('canonical holiday and group configuration participants', () => {
  it.each(['create-holiday', 'update-holiday', 'delete-holiday', 'create-group', 'update-group', 'delete-group', 'set-group'] as const)
  ('%s refuses under an employee interval with exact unchanged calendar/events, then executes after release', async command => {
    const ctx = adminCtx(b), [date, otherDate] = await freeDates();
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Calendar Interval',
      primaryEmail: `holiday-interval-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    const holiday = await createHoliday(ctx, { country: 'MY', holidayDate: date, name: 'Fictional Original Holiday' });
    const group = await createHolidayGroup(ctx, { name: 'Fictional Original Calendar', archetype: 'custom', states: [] });
    const mutate = () => {
      switch (command) {
        case 'create-holiday': return createHoliday(ctx, { country: 'MY', holidayDate: otherDate, name: 'Fictional Added Holiday' });
        case 'update-holiday': return updateHoliday(ctx, { id: holiday.id, name: 'Fictional Updated Holiday' });
        case 'delete-holiday': return deleteHoliday(ctx, { id: holiday.id });
        case 'create-group': return createHolidayGroup(ctx, { name: 'Fictional Added Calendar', archetype: 'custom', states: [] });
        case 'update-group': return updateHolidayGroup(ctx, { id: group.id, name: 'Fictional Updated Calendar' });
        case 'delete-group': return deleteHolidayGroup(ctx, { id: group.id });
        case 'set-group': return setGroupHolidays(ctx, { groupId: group.id, holidayIds: [holiday.id] });
      }
    };
    const state = async () => ({
      holidays: await owner.db.select().from(schema.holiday).where(eq(schema.holiday.tenantId, b.tenantId)).orderBy(schema.holiday.id),
      groups: await owner.db.select().from(schema.holidayGroup).where(eq(schema.holidayGroup.tenantId, b.tenantId)).orderBy(schema.holidayGroup.id),
      links: await owner.db.select().from(schema.holidayGroupHoliday).where(eq(schema.holidayGroupHoliday.tenantId, b.tenantId)).orderBy(schema.holidayGroupHoliday.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned holiday handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employee.employmentId]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate(); const after = await state();
    expect(after.events).toHaveLength(before.events.length + 1);
    switch (command) {
      case 'create-holiday': expect(after.holidays.filter(row => row.name === 'Fictional Added Holiday')).toHaveLength(1); break;
      case 'update-holiday': expect(after.holidays.find(row => row.id === holiday.id)?.name).toBe('Fictional Updated Holiday'); break;
      case 'delete-holiday': expect(after.holidays.some(row => row.id === holiday.id)).toBe(false); break;
      case 'create-group': expect(after.groups.filter(row => row.name === 'Fictional Added Calendar')).toHaveLength(1); break;
      case 'update-group': expect(after.groups.find(row => row.id === group.id)?.name).toBe('Fictional Updated Calendar'); break;
      case 'delete-group': expect(after.groups.some(row => row.id === group.id)).toBe(false); break;
      case 'set-group': expect(after.links.filter(row => row.holidayGroupId === group.id && row.holidayId === holiday.id)).toHaveLength(1); break;
    }
  });
});

/** Actual legacy and dated assignment owner cases, UNRUN until the coordinated runtime window. */
describe('employment holiday selection participants', () => {
  it.each(['legacy-state', 'legacy-calendar', 'dated-calendar'] as const)
  ('%s owns the employee before calendar/credit/payroll/row reads and leaves no effect while busy', async command => {
    await setModule(b.tenantId, 'attendance', 'active'); await setModule(b.tenantId, 'payroll', 'active');
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Calendar Selection',
      primaryEmail: `calendar-selection-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: today });
    const group = await createHolidayGroup(ctx, { name: 'Fictional Assigned Calendar', archetype: 'custom', states: [] });
    const mutate = () => command === 'legacy-state'
      ? setEmploymentWorkState(ctx, { employmentId: employee.employmentId, workState: 'Selangor' })
      : command === 'legacy-calendar'
        ? setEmploymentHolidayCalendar(ctx, { employmentId: employee.employmentId, selection: { kind: 'group', groupId: group.id } })
        : saveEmploymentHolidayCalendarAssignment(ctx, { employmentId: employee.employmentId, startDate: today,
          selection: { kind: 'group', groupId: group.id } });
    const state = async () => ({
      employment: await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employee.employmentId)).orderBy(schema.employment.id),
      versions: await owner.db.select().from(schema.employmentHolidayCalendar).where(eq(schema.employmentHolidayCalendar.employmentId, employee.employmentId)).orderBy(schema.employmentHolidayCalendar.id),
      replacements: await owner.db.select().from(schema.replacementHoliday).where(eq(schema.replacementHoliday.employmentId, employee.employmentId)).orderBy(schema.replacementHoliday.id),
      attendance: await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, employee.employmentId)).orderBy(schema.attendance.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned calendar selection handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employee.employmentId]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate(); const after = await state();
    expect(after.events).toHaveLength(before.events.length + 1);
    if (command === 'legacy-state') expect(after.employment[0].workState).toBe('Selangor');
    else if (command === 'legacy-calendar') expect(after.employment[0]).toMatchObject({ holidayGroupId: group.id, workState: null });
    else { expect(after.versions).toHaveLength(1); expect(after.versions[0]).toMatchObject({ kind: 'group', holidayGroupId: group.id, validFrom: today }); }
  });
});
