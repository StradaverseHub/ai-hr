/** Authored actual roster/configuration interleavings. UNRUN pending local resource handback. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { ensureStandardRule } from '../core/attendance-rule';
import { saveScheduleGroupControl } from '../core/schedule-group-controls';
import { createShift, assignShift, setRestDay, clearRoster, assignShiftBulk, setRestDayBulk, copyRoster, assignEmployeeShift, setEmploymentScheduleGroup, setEmploymentScheduleGroupTx, setEmploymentScheduleGroupBulk } from '../core/roster';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);
const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

describe('roster source participants', () => {
  it.each(['assign', 'rest', 'clear', 'assign-bulk', 'rest-bulk', 'copy', 'control'] as const)
  ('%s refuses before roster/rule/event effects while the last ordered subject is held, then executes after release', async command => {
    const ctx = adminCtx(b), today = todayInKualaLumpur(), date = addDays(today, 1), target = addDays(date, 7);
    const rule = await ensureStandardRule(ctx);
    await saveScheduleGroupControl(ctx, { ruleId: rule.id, kind: 'duty', enabled: true });
    const shift = await createShift(ctx, { name: 'Fictional Guarded Shift', code: 'FGS', companyId: b.companyId,
      startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ruleId: rule.id });
    const employees = [];
    for (let i = 0; i < 2; i++) employees.push(await hireEmployee(ctx, { person: { fullName: 'Fictional Roster Subject',
      primaryEmail: `roster-subject-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: today }));
    const ids = employees.map(row => row.employmentId).sort(), first = ids[0], last = ids[1];
    if (command === 'clear' || command === 'copy') await setRestDay(ctx, { employmentId: first, shiftDate: date });
    if (command === 'copy') await setRestDay(ctx, { employmentId: last, shiftDate: date });
    const mutate = () => {
      switch (command) {
        case 'assign': return assignShift(ctx, { employmentId: last, shiftDate: date, shiftId: shift.id });
        case 'rest': return setRestDay(ctx, { employmentId: last, shiftDate: date });
        case 'clear': return clearRoster(ctx, { employmentId: last, shiftDate: date });
        case 'assign-bulk': return assignShiftBulk(ctx, { employmentIds: ids, shiftDates: [date], shiftId: shift.id });
        case 'rest-bulk': return setRestDayBulk(ctx, { employmentIds: ids, shiftDates: [date], anchorId: b.companyId });
        case 'copy': return copyRoster(ctx, { employmentIds: ids, sourceFrom: date, sourceTo: date, targetFrom: target });
        case 'control': return saveScheduleGroupControl(ctx, { ruleId: rule.id, kind: 'duty', enabled: false });
      }
    };
    if (command === 'clear') await setRestDay(ctx, { employmentId: last, shiftDate: date });
    const state = async () => ({
      roster: await owner.db.select().from(schema.rosterAssignment).where(eq(schema.rosterAssignment.tenantId, b.tenantId)).orderBy(schema.rosterAssignment.id),
      rules: await owner.db.select().from(schema.attendanceRule).where(eq(schema.attendanceRule.tenantId, b.tenantId)).orderBy(schema.attendanceRule.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned roster handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [last]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable'); expect(await state()).toEqual(before);
      // Bulk ownership may acquire the earlier subject before refusing the held final one. The
      // actual command must roll back that partial acquisition, not leave it held after refusal.
      await withTenant(ctx, tx => lockLeaveDependenciesTx(tx, b.tenantId, [first]));
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate(); const after = await state(); expect(after.events.length).toBeGreaterThan(before.events.length);
    if (command === 'control') expect(after.rules.find(row => row.id === rule.id)?.dutyRosterControl).toBe(false);
    else if (command === 'clear') expect(after.roster.some(row => row.employmentId === last && row.shiftDate === date)).toBe(false);
    else if (command === 'copy') expect(after.roster.filter(row => row.shiftDate === target)).toHaveLength(2);
    else if (command === 'assign-bulk' || command === 'rest-bulk') expect(after.roster.filter(row => row.shiftDate === date)).toHaveLength(2);
    else expect(after.roster.find(row => row.employmentId === last && row.shiftDate === date))
      .toMatchObject(command === 'assign' ? { shiftId: shift.id, isRestDay: false } : { shiftId: null, isRestDay: true });
  });
});

/** Actual fixed-shift and schedule-group owner cases, authored UNRUN. */
describe('employment schedule source participants', () => {
  it.each(['backup', 'group', 'group-caller-tx', 'group-bulk'] as const)
  ('%s refuses with unchanged employment/events under held last subject, then applies after release', async command => {
    const ctx = adminCtx(b), rule = await ensureStandardRule(ctx), today = todayInKualaLumpur();
    const shift = await createShift(ctx, { name: 'Fictional Protected Backup', code: 'FPB', companyId: b.companyId,
      startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ruleId: rule.id });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await hireEmployee(ctx, { person: { fullName: 'Fictional Schedule Owner',
      primaryEmail: `schedule-owner-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: today })).employmentId);
    ids.sort(); const first = ids[0], last = ids[1];
    const mutate = () => command === 'backup'
      ? assignEmployeeShift(ctx, { employmentId: last, shiftType: 'fixed', shiftId: shift.id })
      : command === 'group-bulk' ? setEmploymentScheduleGroupBulk(ctx, { employmentIds: ids, attendanceRuleId: rule.id })
        : command === 'group-caller-tx' ? withTenant(ctx, tx => setEmploymentScheduleGroupTx(tx, ctx, { employmentId: last, attendanceRuleId: rule.id }))
          : setEmploymentScheduleGroup(ctx, { employmentId: last, attendanceRuleId: rule.id });
    const state = async () => ({
      employments: await owner.db.select().from(schema.employment).where(eq(schema.employment.tenantId, b.tenantId)).orderBy(schema.employment.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned schedule handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [last]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable'); expect(await state()).toEqual(before);
      await withTenant(ctx, tx => lockLeaveDependenciesTx(tx, b.tenantId, [first]));
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate(); const after = await state();
    expect(after.events.length).toBeGreaterThan(before.events.length);
    if (command === 'backup') expect(after.employments.find(row => row.id === last)).toMatchObject({ defaultShiftId: shift.id, shiftType: 'fixed' });
    else {
      const changed = command === 'group-bulk' ? ids : [last];
      for (const id of changed) expect(after.employments.find(row => row.id === id)?.attendanceRuleId).toBe(rule.id);
    }
  });
});
