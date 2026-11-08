/** Frozen c5e36cb03095527ba1fb6a0e8fc2bf54080f2c46 usualShiftsFor body;
 * only its export name changes. Native parity must not share the new rule selection. */
import {inArray} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {employment,shift} from '../../db/schema';
import {weekLookupTx} from '../../core/attendance';
import {rotationLookupTx} from '../../packs/attendance/service';
import {liveArrangementsTx} from '../../core/shift-arrangement-resolve';
import type {UsualShiftRow} from '../../core/roster';
import type {UsualShift} from '../../lib/roster-month';

export function legacyUsualShiftsFor(ctx: SessionContext, employmentIds: string[], existingTx?: Tx): Promise<UsualShiftRow[]> {
  if (employmentIds.length === 0) return Promise.resolve([]);
  const read = async (tx: Tx) => {
    const rows = await tx
      .select({
        employmentId: employment.id,
        shiftId: shift.id,
        code: shift.code,
        name: shift.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
        pattern: shift.weeklyPattern,
        // The four-way row and the two Schedule Group
        // columns the ghost cells must now resolve through (migration 0483).
        halfPattern: shift.halfPattern,
        offPattern: shift.offPattern,
        shiftRuleId: shift.ruleId,
        groupRuleId: employment.attendanceRuleId,
      })
      .from(employment)
      .leftJoin(shift, eq(shift.id, employment.defaultShiftId))
      .where(inArray(employment.id, employmentIds));
    // 07ebd04d — the ghost cells follow the SCHEDULE GROUP's week when it has one, the same chain
    // scheduleFor uses (employee's group → shift's group → tenant default), so the grid cannot say OFF on
    // a day the engine pays as work. One extra set-based read for the whole grid.
    //
    // Half working weekdays must travel with the resolved full pattern to every roster consumer.
    // They are working cells; this read does not invent half-day duration or reclassify rest/off days.
    const lookup = await weekLookupTx(tx, null, [...rows.map((r) => r.shiftRuleId), ...rows.map((r) => r.groupRuleId)]);
    const rotationLookup = await rotationLookupTx(tx);
    const periodsByEmp = rotationLookup.versions.length ? await liveArrangementsTx(tx,employmentIds) : new Map();
    const datedIds=[...new Set([...periodsByEmp.values()].flatMap(periods=>periods.map((p:{shiftId:string})=>p.shiftId)))];
    const datedRules=datedIds.length ? await tx.select({id:shift.id,ruleId:shift.ruleId}).from(shift).where(inArray(shift.id,datedIds)) : [];
    const ruleByShift=new Map(datedRules.map(sh=>[sh.id,sh.ruleId]));
    return rows.flatMap(({ halfPattern, offPattern, shiftRuleId, groupRuleId, ...r }) => {
      const periods:{validFrom:string;ruleId:string|null}[] = !groupRuleId ? (periodsByEmp.get(r.employmentId)??[])
        .map((p:{validFrom:string;shiftId:string})=>({validFrom:p.validFrom,ruleId:ruleByShift.get(p.shiftId)??null})) : [];
      const ruleIds=periods.length ? periods.map(p=>p.ruleId) : [groupRuleId??shiftRuleId];
      const rotations = rotationLookup.versions.filter(v => ruleIds.includes(v.ruleId));
      if (!r.shiftId && !rotations.length) return [];
      const week=lookup(groupRuleId ?? shiftRuleId, { pattern: r.pattern, halfPattern, offPattern });
      const ids = new Set(rotations.flatMap(v=>v.allowedShiftIds));
      return [{...r,shiftId:r.shiftId??'',code:r.code??null,name:r.name??'',startTime:r.startTime??'00:00:00',endTime:r.endTime??'00:00:00',
        pattern:week.pattern,halfPattern:week.halfPattern??null,
        ...(rotations.length?{noDefault:!r.shiftId,rotations:rotations.map(({ruleId,effectiveFrom,anchorDate,unit,length,days})=>({ruleId,effectiveFrom,anchorDate,unit,length,days})),...(periods.length?{rotationPeriods:periods}:{}),
          rotationShifts:rotationLookup.shifts.filter(s=>ids.has(s.id))}:{})}];
    });
  };
  return existingTx ? read(existingTx) : withTenant(ctx, read);
}

