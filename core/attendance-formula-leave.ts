/** Attendance projections of the approved leave owner's exact pieces and frozen shift boundaries. */
import type {AttendanceTraceV1} from './attendance-trace';
import type {ApprovedAllowanceLeavePiece} from '../packs/leave/service';
import {anchorAttendanceClockMinute} from './attendance-timeline';
import {intersectAttendancePolicyIntervals as intersect,unionAttendancePolicyIntervals as union,subtractAttendancePolicyIntervals as subtract,attendancePolicyIntervalMinutes as minutes,type AttendancePolicyInterval} from '../lib/attendance-policy-intervals';
const minute=(value:string)=>/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value)?Number(value.slice(0,2))*60+Number(value.slice(3,5)):null;
export function attendanceFormulaLeaveMeasurements(trace:AttendanceTraceV1,pieces:readonly ApprovedAllowanceLeavePiece[]|null,breaks:readonly (AttendancePolicyInterval&{breakType?:string;flexible?:boolean;paid?:boolean})[]|null){
 const values:Record<string,number>={},allCodes:{AM:string[];PM:string[]}|null=pieces?.length===0?{AM:[],PM:[]}:null;
 if(pieces===null)return {values,allCodes};
 if(!pieces.length){for(const id of ['LeaveOnBreak1','LeaveOnBreak2','LeaveOnBreak3','LeaveOnBreak4','OnHourlyLeaveLateIn','OnHourlyLeaveEarlyOut','OnLeaveFirstHalfLateIn','OnLeaveSecondHalfEarlyOut','OnLeaveDurationMins'])values[id]=0;return {values,allCodes};}
 const frozen=trace.formulaSchedule,start=trace.schedule.startAbs,end=trace.schedule.endAbs;
 if(!frozen||start===null||end===null||start>=end)return {values,allCodes};
 const cut=minute(frozen.halfDayBefore);if(cut===null)return {values,allCodes};
 const half=anchorAttendanceClockMinute(cut,start,trace.schedule.dailyCutoffMinutes);if(half<=start||half>=end)return {values,allCodes};
 const first={from:start,to:half},second={from:half,to:end};
 const positioned:({piece:ApprovedAllowanceLeavePiece;interval:AttendancePolicyInterval})[]=[];
 for(const piece of pieces){
  let interval:AttendancePolicyInterval;
  if(piece.session==='hourly'){
   const a=piece.from?minute(piece.from):null,b=piece.to?minute(piece.to):null;if(a===null||b===null||piece.minutes===null)return {values,allCodes};
   const from=anchorAttendanceClockMinute(a,start,trace.schedule.dailyCutoffMinutes),to=anchorAttendanceClockMinute(b,start,trace.schedule.dailyCutoffMinutes);if(to<=from||to-from!==piece.minutes)return {values,allCodes};interval={from,to};
  }else if(piece.session==='full_day'){
   if(piece.days!==1&&!(frozen.scheduleDayKind==='half'&&piece.days===0.5))return {values,allCodes};interval={from:start,to:end};
  }else{
   // A half-day shift has no independently recorded quarter-day allocation.
   if(frozen.scheduleDayKind==='half'||piece.days!==0.5)return {values,allCodes};interval=piece.session==='AM'?first:second;
  }
  positioned.push({piece,interval});
 }
 const codes={AM:[...new Set(positioned.filter(row=>intersect([row.interval],[first],4320).length).map(row=>row.piece.typeId))].sort(),PM:[...new Set(positioned.filter(row=>intersect([row.interval],[second],4320).length).map(row=>row.piece.typeId))].sort()};
 const all=union(positioned.map(row=>row.interval),4320),hourly=union(positioned.filter(row=>row.piece.session==='hourly').map(row=>row.interval),4320);
 const regular=breaks?.filter(row=>!row.breakType||row.breakType==='in_shift');
 if(regular){for(let i=0;i<4;i++){const row=regular[i];if(!row)values['LeaveOnBreak'+(i+1)]=0;else if(!row.flexible)values['LeaveOnBreak'+(i+1)]=minutes(intersect(all,[row],4320),4320);}}
 if(breaks&&!breaks.some(row=>row.flexible)&&frozen.flexibleBreakMinutes===null)values.OnLeaveDurationMins=minutes(subtract(intersect(all,[{from:start,to:end}],4320),breaks.filter(row=>!row.paid),4320),4320);
 const late=trace.lateness,early=trace.earlyOut;
 const lateWindow=late&&late.minutes>=0&&late.checkInAbs>late.thresholdAbs?{from:late.startAbs+(late.includeGrace?0:late.graceMinutes),to:late.checkInAbs}:null;
 const earlyWindow=early&&early.minutes>=0&&early.checkOutAbs<early.thresholdAbs?{from:early.checkOutAbs,to:early.endAbs-(early.includeGrace?0:early.graceMinutes)}:null;
 if(late||trace.schedule.dayType!=='workday'||frozen.flexiDuration){values.OnHourlyLeaveLateIn=lateWindow?minutes(intersect(hourly,[lateWindow],4320),4320):0;values.OnLeaveFirstHalfLateIn=lateWindow?minutes(intersect(intersect(all,[first],4320),[lateWindow],4320),4320):0;}
 if(early||trace.schedule.dayType!=='workday'||frozen.flexiDuration){values.OnHourlyLeaveEarlyOut=earlyWindow?minutes(intersect(hourly,[earlyWindow],4320),4320):0;values.OnLeaveSecondHalfEarlyOut=earlyWindow?minutes(intersect(intersect(all,[second],4320),[earlyWindow],4320),4320):0;}
 return {values,allCodes:codes};
}
