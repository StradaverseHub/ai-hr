/** Schedule Group cycle owner. Immutable dated versions; raw attendance is never recalculated here. */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { attendanceRotation, attendanceRule, employment, shift } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { normalizeRotation, rotationDayOn, rotationVersionOn, type RotationCycle } from './week-pattern';
import { lockPayrollForScheduleChange, markPayrollForAttendanceChange } from '../packs/payroll/service';

export type AttendanceRotationVersion = typeof attendanceRotation.$inferSelect;
export type RotationShift = typeof shift.$inferSelect;
export type RotationResolvedDay = { version: AttendanceRotationVersion; day: RotationCycle['days'][number]; shift: RotationShift | null };
export async function rotationLookupTx(tx: Tx) {
  const versions = await tx.select().from(attendanceRotation).orderBy(asc(attendanceRotation.ruleId), asc(attendanceRotation.effectiveFrom));
  const ids = [...new Set(versions.flatMap(v => v.allowedShiftIds))];
  const shifts = ids.length ? await tx.select().from(shift).where(inArray(shift.id, ids)) : [];
  const byShift = new Map(shifts.map(s => [s.id, s]));
  const byRule = new Map<string, AttendanceRotationVersion[]>();
  for (const v of versions) { const rows = byRule.get(v.ruleId) ?? []; rows.push(v); byRule.set(v.ruleId, rows); }
  return Object.assign((ruleId: string | null | undefined, date: string): RotationResolvedDay | null => {
    if (!ruleId) return null;
    const version = rotationVersionOn(byRule.get(ruleId) ?? [], date);
    const day = version ? rotationDayOn(version, date) : null;
    if (!version || !day) return null;
    const selected = day.shiftId ? byShift.get(day.shiftId) : null;
    // Missing sources are a corruption error, never a silent fallback to another shift.
    if (day.shiftId && !selected) throw new Error('The saved rotation shift is unavailable. Ask an administrator to check the Schedule Group.');
    return { version, day, shift: selected ?? null };
  }, { versions, shifts });
}

/** Adapter used by batched attendance displays and payroll clamping. A nonworking
 * day has a sentinel empty week, so it cannot fall through to company working days. */
export function rotationScheduleRow(rotation: RotationResolvedDay, date: string) {
  const sh = rotation.shift;
  const dow0 = new Date(`${date}T00:00:00Z`).getUTCDay(); const dow = dow0 || 7;
  return {
    id: sh?.id ?? '', shiftId: sh?.id ?? null, code: sh?.code ?? null, name: sh?.name ?? '',
    start: sh?.startTime ?? '00:00:00', end: sh?.endTime ?? '00:00:00', brk: sh?.breakMinutes ?? 0,
    crosses: sh?.crossesMidnight ?? false, rounding: sh?.normalHoursRoundingMinutes ?? null,
    override: sh?.normalMinutesOverride ?? null, periods: sh?.breakPeriods ?? null,
    pattern: rotation.day.kind === 'full' ? [dow] : [], halfPattern: rotation.day.kind === 'half' ? [dow] : [],
    offPattern: rotation.day.kind === 'off' ? [dow] : [], ruleId: rotation.version.ruleId,
    lateGrace: sh?.lateGraceMinutes ?? null, earlyLeaveGrace: sh?.earlyLeaveGraceMinutes ?? null,
    otRule: sh?.otRule ?? null, halfDayFirstOut: sh?.halfDayFirstOut ?? null,
    cutoffOn: sh?.dailyCutoffEnabled ?? false, cutoffAt: sh?.dailyCutoffTime ?? null,
    flexOn: sh?.flexibleBreakEnabled ?? false, flexMin: sh?.flexibleBreakMinutes ?? null,
    shiftType: sh?.type ?? 'normal', rotationKind: rotation.day.kind,
  };
}

const revisionOf = (versions: readonly AttendanceRotationVersion[], shifts: readonly {id: string; ruleId: string | null}[], ruleId: string) =>
  createHash('sha256').update(JSON.stringify({ versions: versions.map(v => v.id).sort(), pool: shifts.filter(s => s.ruleId === ruleId).map(s => s.id).sort() })).digest('hex');
export async function getScheduleRotation(ctx: SessionContext, ruleId: string) {
  return withTenant(ctx, async tx => {
    const versions = await tx.select().from(attendanceRotation).where(eq(attendanceRotation.ruleId, ruleId)).orderBy(asc(attendanceRotation.effectiveFrom));
    const shifts = await tx.select({ id: shift.id, ruleId: shift.ruleId }).from(shift).orderBy(asc(shift.id));
    return { versions, revision: revisionOf(versions, shifts, ruleId) };
  });
}
export async function saveScheduleRotation(ctx: SessionContext, p: {
  ruleId: string; expectedRevision: string; allowedShiftIds: string[]; cycle: RotationCycle;
}) {
  return withTenant(ctx, async tx => {
    const [authority] = await tx.execute(sql`select app.is_group_admin() as allowed`) as unknown as { allowed: boolean }[];
    if (!authority?.allowed) throw new Error('A group-wide HR administrator is required to change tenant-wide schedule rotations.');
    const [rule] = await tx.select().from(attendanceRule).where(eq(attendanceRule.id, p.ruleId)).for('update');
    if (!rule || rule.isDefault) throw new Error('Choose a non-Standard Schedule Group in this tenant.');
    const all = await tx.select().from(shift).orderBy(asc(shift.id)).for('update');
    const versions = await tx.select().from(attendanceRotation).where(eq(attendanceRotation.ruleId, p.ruleId)).orderBy(asc(attendanceRotation.effectiveFrom));
    if (p.expectedRevision !== revisionOf(versions, all, p.ruleId)) throw new Error('This schedule was changed by another administrator. Reload before saving.');
    const pool = [...new Set(p.allowedShiftIds)].sort();
    const cycle = normalizeRotation(p.cycle, pool);
    if (cycle.effectiveFrom <= todayInKualaLumpur()) throw new Error('Choose an effective date tomorrow or later. Recorded attendance is not changed.');
    if (versions.some(v => v.effectiveFrom >= cycle.effectiveFrom)) throw new Error('The effective date must be later than every saved version. Save a new dated revision instead of replacing history.');
    const byId = new Map(all.map(s => [s.id, s]));
    for (const id of pool) {
      const sh = byId.get(id);
      if (!sh) throw new Error('A selected shift is unavailable in this tenant.');
      // Existing assignments may keep archived sources; a new revision must use active ones.
      if (sh.archivedAt) throw new Error(`Shift ${sh.name} is archived. Select an active shift for the new rotation.`);
      if (sh.ruleId && sh.ruleId !== rule.id) throw new Error(`Shift ${sh.name} belongs to another Schedule Group. Move it there first before using it in this rotation.`);
    }
    // Tenant-wide rules cannot bypass a company's payroll lock through payslip RLS.
    // This seam returns only operational window/status facts and locks the runs.
    const members = await tx.select({ id: employment.id }).from(employment).where(sql`${employment.attendanceRuleId} = ${rule.id} OR ${employment.defaultShiftId} IN (SELECT id FROM shift WHERE rule_id=${rule.id})`).orderBy(asc(employment.id));
    for (const member of members) {
      const batches = await lockPayrollForScheduleChange(tx, member.id, cycle.effectiveFrom);
      if (batches.some(b => b.status === 'closed')) throw new Error('This rotation would change a closed payroll attendance period. Choose a later effective date.');
      await markPayrollForAttendanceChange(tx, ctx, batches, member.id);
    }
    if (pool.length) await tx.update(shift).set({ ruleId: rule.id }).where(inArray(shift.id, pool));
    const detach = all.filter(s => s.ruleId === rule.id && !pool.includes(s.id)).map(s => s.id);
    if (detach.length) await tx.update(shift).set({ ruleId: null }).where(inArray(shift.id, detach));
    const [version] = await tx.insert(attendanceRotation).values({ tenantId: ctx.tenantId, ruleId: rule.id,
      ...cycle, allowedShiftIds: pool, createdBy: ctx.userId ?? 'system' }).returning();
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance-rule', aggregateId: rule.id,
      eventType: 'attendance-rule.rotation-saved', actor: actorOf(ctx),
      payload: { versionId: version.id, effectiveFrom: cycle.effectiveFrom, anchorDate: cycle.anchorDate,
        unit: cycle.unit, length: cycle.length, allowedShiftIds: pool, days: cycle.days, previousVersionIds: versions.map(v => v.id) } });
    return { id: version.id };
  });
}

/** Legacy shift/group writers must not mutate the pool behind a saved cycle. */
export async function assertRotationPoolWriteTx(tx: Tx, from: string | null | undefined, to: string | null | undefined) {
  if (from === to) return;
  const ids = [...new Set([from,to].filter((id):id is string=>!!id))];
  if (!ids.length) return;
  const [saved] = await tx.select({id:attendanceRotation.id}).from(attendanceRotation)
    .where(inArray(attendanceRotation.ruleId,ids)).limit(1);
  if (saved) throw new Error('Edit Shifts Allowed together with the dated rotation in its Schedule Group.');
}
