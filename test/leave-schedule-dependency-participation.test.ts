/** Authored actual configuration owner interleavings. ALL UNRUN pending resource handback. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createShift } from '../core/roster';
import { createAttendanceRule, updateAttendanceRule, updateAttendanceRuleSection, copyAttendanceRule,
  setAttendanceRuleStatus, deleteAttendanceRule, setRuleShifts, ensureStandardRule, type AttendanceRuleInput } from '../core/attendance-rule';
import { getScheduleRotation, saveScheduleRotation } from '../core/attendance-rotation';
import { lockLeaveDependenciesTx } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b: Base;
beforeAll(migrateTestDb); beforeEach(async () => { await resetDb(); b = await seedBase(); }); afterAll(closeAll);
const input = (name: string): AttendanceRuleInput => ({ name, lateGracePeriodMinutes: 0, lateAfterMinutes: 0,
  lateDeductMinutes: 0, includeGraceInLateness: false, earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0,
  earlyDeductMinutes: 0, includeGraceInEarlyOut: false, applyToEarlyOt: false, otRows: [] });
const add = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

describe('canonical schedule configuration source owners', () => {
  it.each(['pool', 'standard', 'create', 'update', 'section', 'copy', 'status', 'delete', 'rotation'] as const)
  ('%s refuses before catalogue/membership/version/event effects then executes after employee interval release', async command => {
    const ctx = adminCtx(b), today = todayInKualaLumpur();
    const { employmentId } = await hireEmployee(ctx, { person: { fullName: 'Fictional Schedule Configuration Subject',
      primaryEmail: `schedule-configuration-${randomUUID()}@t.local` }, companyId: b.companyId, departmentId: b.deptA,
      employmentType: 'full_time', hiredOn: today });
    const rule = await createAttendanceRule(ctx, input('Fictional Protected Group'));
    const shift = await createShift(ctx, { name: 'Fictional Allowed Shift', code: 'FLS', startTime: '09:00',
      endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    const date = add(today, 8), revision = (await getScheduleRotation(ctx, rule.id)).revision;
    const mutate = () => {
      switch (command) {
        case 'pool': return setRuleShifts(ctx, { ruleId: rule.id, shiftIds: [shift.id] });
        case 'standard': return ensureStandardRule(ctx);
        case 'create': return createAttendanceRule(ctx, input('Fictional Additional Group'));
        case 'update': return updateAttendanceRule(ctx, { ...input('Fictional Revised Group'), ruleId: rule.id });
        case 'section': return updateAttendanceRuleSection(ctx, { ruleId: rule.id, section: 'attendance', fields: { lateGracePeriodMinutes: 7 } });
        case 'copy': return copyAttendanceRule(ctx, { ruleId: rule.id });
        case 'status': return setAttendanceRuleStatus(ctx, { ruleId: rule.id, status: 'inactive' });
        case 'delete': return deleteAttendanceRule(ctx, { ruleId: rule.id });
        case 'rotation': return saveScheduleRotation(ctx, { ruleId: rule.id, expectedRevision: revision,
          allowedShiftIds: [shift.id], cycle: { unit: 'day', length: 2, effectiveFrom: date, anchorDate: date,
            days: [{ kind: 'full', shiftId: shift.id }, { kind: 'rest', shiftId: null }] } });
      }
    };
    const state = async () => ({
      rules: await owner.db.select().from(schema.attendanceRule).where(eq(schema.attendanceRule.tenantId, b.tenantId)).orderBy(schema.attendanceRule.id),
      bands: await owner.db.select().from(schema.attendanceRuleOtRow).where(eq(schema.attendanceRuleOtRow.tenantId, b.tenantId)).orderBy(schema.attendanceRuleOtRow.id),
      membership: await owner.db.select().from(schema.attendanceRuleShift).where(eq(schema.attendanceRuleShift.tenantId, b.tenantId)).orderBy(schema.attendanceRuleShift.ruleId, schema.attendanceRuleShift.shiftId),
      rotations: await owner.db.select().from(schema.attendanceRotation).where(eq(schema.attendanceRotation.tenantId, b.tenantId)).orderBy(schema.attendanceRotation.id),
      events: await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, fail!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; fail = no; }), finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { fail(new Error('owned schedule configuration handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => { await lockLeaveDependenciesTx(tx, b.tenantId, [employmentId]); ready(); await finish; });
    void holder.catch(fail);
    try {
      await started; await expect(mutate()).rejects.toThrow('Leave source is unavailable'); expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate(); const after = await state(), existing = after.rules.find(row => row.id === rule.id);
    const standardExisted = before.rules.some(row => row.isDefault);
    expect(after.events.length).toBe(before.events.length + (command === 'standard' && standardExisted ? 0 : 1));
    if (command === 'pool') expect(after.membership.some(row => row.ruleId === rule.id && row.shiftId === shift.id)).toBe(true);
    if (command === 'standard') expect(after.rules.filter(row => row.isDefault)).toHaveLength(1);
    if (command === 'create' || command === 'copy') expect(after.rules.length).toBe(before.rules.length + 1);
    if (command === 'update') expect(existing?.name).toBe('Fictional Revised Group');
    if (command === 'section') expect(existing?.lateGracePeriodMinutes).toBe(7);
    if (command === 'status') expect(existing?.status).toBe('inactive');
    if (command === 'delete') expect(existing).toBeUndefined();
    if (command === 'rotation') expect(after.rotations.find(row => row.ruleId === rule.id)).toMatchObject({ effectiveFrom: date, allowedShiftIds: [shift.id] });
  });
});
