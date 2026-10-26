/** Authored actual roster/configuration interleavings. UNRUN pending local resource handback. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { ensureStandardRule } from '../core/attendance-rule';
import { saveScheduleGroupControl } from '../core/schedule-group-controls';
import { generateRosterFromTemplate, replaceShiftOtWindows, saveShiftPay, createShift, updateShift, copyShift, deleteShift, archiveShift, unarchiveShift, assignShift, setRestDay, clearRoster, assignShiftBulk, setRestDayBulk, copyRoster, assignEmployeeShift, setEmploymentScheduleGroup, setEmploymentScheduleGroupTx, setEmploymentScheduleGroupBulk } from '../core/roster';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { assignEmployeeShiftDated, removeShiftArrangement } from '../core/shift-arrangement';
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

/** Dated ladder owners must protect earlier period/cache reads, not merely the final update. UNRUN. */
describe('dated shift arrangement source participants', () => {
  it.each(['assign', 'remove'] as const)
  ('%s refuses without period/cache/event changes while the actual employee is held, then applies after release', async command => {
    const ctx = adminCtx(b), today = todayInKualaLumpur(), tomorrow = addDays(today, 1);
    const rule = await ensureStandardRule(ctx);
    const shift = await createShift(ctx, { name: 'Fictional Dated Backup', code: 'FDB', companyId: b.companyId,
      startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ruleId: rule.id });
    const { employmentId } = await hireEmployee(ctx, { person: { fullName: 'Fictional Dated Subject',
      primaryEmail: `dated-subject-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: today });
    await assignEmployeeShiftDated(ctx, { employmentId, shiftType: 'fixed', shiftId: shift.id, effectiveFrom: today });
    if (command === 'remove') await assignEmployeeShiftDated(ctx, { employmentId, shiftType: 'roster', shiftId: shift.id, effectiveFrom: tomorrow });
    const state = async () => ({
      periods: await owner.db.select().from(schema.employmentShiftArrangement)
        .where(eq(schema.employmentShiftArrangement.employmentId, employmentId)).orderBy(schema.employmentShiftArrangement.id),
      employments: await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId)),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state(), newest = before.periods.find(row => row.validFrom === tomorrow && !row.supersededAt);
    if (command === 'remove') expect(newest).toBeDefined();
    const mutate = () => command === 'assign'
      ? assignEmployeeShiftDated(ctx, { employmentId, shiftType: 'roster', shiftId: shift.id, effectiveFrom: tomorrow })
      : removeShiftArrangement(ctx, { employmentId, arrangementId: newest!.id });
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned dated arrangement handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable'); expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate(); const after = await state();
    expect(after.events.length).toBe(before.events.length + 1);
    expect(after.employments).toEqual(before.employments); // Future period keeps today's canonical cache.
    if (command === 'assign') {
      expect(after.periods.filter(row => !row.supersededAt)).toHaveLength(2);
      expect(after.periods.find(row => row.validFrom === tomorrow && !row.supersededAt)).toMatchObject({ shiftType: 'roster', shiftId: shift.id });
      expect(after.periods.find(row => row.validFrom === today && !row.supersededAt)?.validTo).toBe(today);
    } else {
      expect(after.periods.find(row => row.id === newest!.id)?.supersededAt).not.toBeNull();
      expect(after.periods.find(row => row.validFrom === today && !row.supersededAt)?.validTo).toBeNull();
    }
  });
});

/** Six canonical master owners: configuration ownership precedes source/rotation row locks. UNRUN. */
describe('master shift configuration participants', () => {
  it.each(['create', 'update', 'copy', 'delete', 'archive', 'unarchive'] as const)
  ('%s refuses without catalogue/membership/event effects during an employee interval, then executes after release', async command => {
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const { employmentId } = await hireEmployee(ctx, { person: { fullName: 'Fictional Shift Config Subject',
      primaryEmail: `shift-config-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: today });
    // An unused shift has no group membership or historical assignment; delete's original guards remain valid.
    const input = { name: 'Fictional Master Shift', code: 'FMS', companyId: b.companyId,
      startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] };
    const shift = await createShift(ctx, input);
    if (command === 'unarchive') await archiveShift(ctx, { shiftId: shift.id });
    const mutate = () => {
      switch (command) {
        case 'create': return createShift(ctx, { ...input, name: 'Fictional Additional Shift', code: 'FAS' });
        case 'update': return updateShift(ctx, { ...input, shiftId: shift.id, name: 'Fictional Revised Shift' });
        case 'copy': return copyShift(ctx, { shiftId: shift.id });
        case 'delete': return deleteShift(ctx, { shiftId: shift.id });
        case 'archive': return archiveShift(ctx, { shiftId: shift.id });
        case 'unarchive': return unarchiveShift(ctx, { shiftId: shift.id });
      }
    };
    const state = async () => ({
      shifts: await owner.db.select().from(schema.shift).where(eq(schema.shift.tenantId, b.tenantId)).orderBy(schema.shift.id),
      memberships: await owner.db.select().from(schema.attendanceRuleShift).where(eq(schema.attendanceRuleShift.tenantId, b.tenantId)).orderBy(schema.attendanceRuleShift.shiftId),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned master shift handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable'); expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate(); const after = await state();
    expect(after.events.length).toBe(before.events.length + 1);
    if (command === 'create' || command === 'copy') expect(after.shifts.length).toBe(before.shifts.length + 1);
    if (command === 'update') expect(after.shifts.find(row => row.id === shift.id)?.name).toBe('Fictional Revised Shift');
    if (command === 'delete') expect(after.shifts.find(row => row.id === shift.id)).toBeUndefined();
    if (command === 'archive') expect(after.shifts.find(row => row.id === shift.id)?.archivedAt).not.toBeNull();
    if (command === 'unarchive') expect(after.shifts.find(row => row.id === shift.id)?.archivedAt).toBeNull();
  });
});

/** Generator owns planning and both canonical bulk writes in the same real transaction. UNRUN. */
describe('protected roster generation', () => {
  it.each(['explicit', 'department', 'rest-write-rollback'] as const)
  ('%s retains a fresh protected plan and never commits a partial working/rest generation', async mode => {
    const ctx = adminCtx(b), today = todayInKualaLumpur(), date = addDays(today, 1), end = addDays(date, 6);
    const rule = await ensureStandardRule(ctx);
    await saveScheduleGroupControl(ctx, { ruleId: rule.id, kind: 'duty', enabled: true });
    const shift = await createShift(ctx, { name: 'Fictional Generation Template', code: 'FGT', companyId: b.companyId,
      startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ruleId: rule.id });
    const { employmentId } = await hireEmployee(ctx, { person: { fullName: 'Fictional Generated Roster Subject',
      primaryEmail: `generation-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: today });
    const request = { shiftId: shift.id, from: date, to: end,
      ...(mode === 'department' ? { departmentId: b.deptA } : { employmentIds: [employmentId] }) };
    const state = async () => ({
      roster: await owner.db.select().from(schema.rosterAssignment).where(eq(schema.rosterAssignment.tenantId, b.tenantId)).orderBy(schema.rosterAssignment.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    if (mode === 'rest-write-rollback') {
      await owner.db.execute(sql.raw(`CREATE FUNCTION app.test_leave_generator_rest_failure() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned generation rest failure'; END $$`));
      try {
        await owner.db.execute(sql.raw(`CREATE TRIGGER test_leave_generator_rest_failure BEFORE INSERT OR UPDATE ON public.roster_assignment
          FOR EACH ROW WHEN (NEW.is_rest_day) EXECUTE FUNCTION app.test_leave_generator_rest_failure()`));
        await expect(generateRosterFromTemplate(ctx, request)).rejects.toThrow();
        expect(await state()).toEqual(before); // Working rows and their already-written event must roll back too.
      } finally {
        await owner.db.execute(sql.raw('DROP TRIGGER IF EXISTS test_leave_generator_rest_failure ON public.roster_assignment'));
        await owner.db.execute(sql.raw('DROP FUNCTION app.test_leave_generator_rest_failure()'));
      }
    } else {
      let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
      const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
      const watchdog = setTimeout(() => { fail(new Error('owned generation handshake timed out')); release(); }, 10_000);
      const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish; });
      void holder.catch(fail);
      try {
        await started; await expect(generateRosterFromTemplate(ctx, request)).rejects.toThrow('Leave source is unavailable');
        expect(await state()).toEqual(before);
      } finally { release(); clearTimeout(watchdog); await holder; }
    }
    const result = await generateRosterFromTemplate(ctx, request), after = await state();
    expect(result.employments).toBe(1); expect(result.workingRows + result.restRows).toBe(7);
    expect(result.workingRows).toBeGreaterThan(0); expect(result.restRows).toBeGreaterThan(0);
    expect(after.roster.filter(row => row.employmentId === employmentId)).toHaveLength(7);
    expect(after.events.length).toBe(before.events.length + 4); // Two original per-employee audits plus two summaries.
    const oldEventIds=new Set(before.events.map(row=>row.id)),emitted=after.events.filter(row=>!oldEventIds.has(row.id));
    expect(emitted.filter(row=>row.eventType==='roster.bulk.assigned')).toHaveLength(1);
    expect(emitted.filter(row=>row.eventType==='roster.bulk.rest-day.set')).toHaveLength(1);
  });
});


/** Actual standalone window editor and compound pay editor owners. Authored UNRUN. */
describe('shift window configuration participants', () => {
 it.each(['windows', 'pay'] as const)('%s refuses before shift/window/event changes then saves after release', async command => {
  const ctx = adminCtx(b), today = todayInKualaLumpur();
  const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Window Subject', primaryEmail: `window-${randomUUID()}@t.local` },
   companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: today });
  const created = await createShift(ctx, { name: 'Fictional Window Shift', code: 'FWS', companyId: b.companyId,
   startTime: '09:00', endTime: '18:00', breakMinutes: 60 });
  const windows = [{ startTime: '18:00', endTime: '20:00', endNextDay: false }];
  const mutate = () => command === 'windows' ? replaceShiftOtWindows(ctx, { shiftId: created.id, windows })
   : saveShiftPay(ctx, { shiftId: created.id, windows, differential: null, confirmClear: false });
  const state = async () => ({
   shifts: await owner.db.select().from(schema.shift).where(eq(schema.shift.tenantId, b.tenantId)).orderBy(schema.shift.id),
   windows: await owner.db.select().from(schema.shiftOtWindow).where(eq(schema.shiftOtWindow.tenantId, b.tenantId)).orderBy(schema.shiftOtWindow.id),
   events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
  });
  const before = await state();
  let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
  const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
  const watchdog = setTimeout(() => { fail(new Error('owned shift window handshake timed out')); release(); }, 10_000);
  const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employee.employmentId]); ready(); await finish; });
  void holder.catch(fail);
  try { await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable'); expect(await state()).toEqual(before); }
  finally { release(); clearTimeout(watchdog); await holder; }
  await mutate(); const after = await state();
  expect(after.windows).toHaveLength(1); expect(after.windows[0]).toMatchObject({ shiftId: created.id, startTime: '18:00:00', endTime: '20:00:00' });
  expect(after.events.length).toBe(before.events.length + (command === 'pay' ? 2 : 1));
 });
});
