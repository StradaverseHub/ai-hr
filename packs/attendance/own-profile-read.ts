/** Exact attendance-summary leaf extracted from the existing own-profile reader.
 * No subject, principal or permission admission is granted by this Tx query.
 * The caller captures today's HR date and retains any required presentation course.
 */
import {eq} from 'drizzle-orm';
import type {Tx} from '../../db/client';
import {attendanceRule,shift} from '../../db/schema';
import {scheduleGroupLookupTx,scheduleGroupDisplayName} from '../../core/schedule-group-controls';
import type {ShiftArrangementHistoryRow} from '../../core/shift-arrangement';

type OwnProfileAttendanceSummaryInput={
 employmentId:string;
 today:string;
 defaultShiftId:string|null;
 shifts:readonly ShiftArrangementHistoryRow[];
};
async function readOwnProfileAttendanceSummaryRowsTx(
 tx:Tx,{employmentId,today,defaultShiftId,shifts}:OwnProfileAttendanceSummaryInput,
){
   const groupOn=await scheduleGroupLookupTx(tx,[employmentId],today,today),groupId=groupOn(employmentId,today);
   const [group]=groupId?await tx.select({name:attendanceRule.name,label:attendanceRule.label}).from(attendanceRule).where(eq(attendanceRule.id,groupId)).limit(1):[];
   const periods=shifts.filter(row=>row.effectiveFrom<=today&&(!row.effectiveTo||row.effectiveTo>=today));
   const current=periods.length===1?periods[0]:null;
   const [legacyShift]=!shifts.length&&defaultShiftId?await tx.select({code:shift.code,name:shift.name}).from(shift).where(eq(shift.id,defaultShiftId)).limit(1):[];
   return {scheduleGroupName:group?scheduleGroupDisplayName(group):null,backupShiftCode:current?.shiftCode??legacyShift?.code??null,backupShiftName:current?.shiftName??legacyShift?.name??null,shiftEffectiveFrom:current?.effectiveFrom??null};
}
/** Transaction leaf only. No new connection, policy object, purpose or History capability. */
export function ownProfileAttendanceSummaryTx(tx:Tx,p:OwnProfileAttendanceSummaryInput){
 return readOwnProfileAttendanceSummaryRowsTx(tx,p);
}
