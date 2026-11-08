/** Projection of already-proved physical/approved coverage. Establishes no approval or payable claim. */
import {intersectAttendancePolicyIntervals as intersect,subtractAttendancePolicyIntervals as subtract,attendancePolicyIntervalMinutes as minutes,type AttendancePolicyInterval} from './attendance-policy-intervals';
export function attendanceFormulaOvertimeMeasurements(p:{net:readonly AttendancePolicyInterval[];approved:readonly AttendancePolicyInterval[]|null;start:number;end:number;crossesMidnight:boolean}){
 if(!Number.isSafeInteger(p.start)||!Number.isSafeInteger(p.end)||p.start<0||p.start>=p.end||p.end>4320)throw Error('Invalid proved shift boundary.');
 const before=p.start>0?intersect(p.net,[{from:0,to:p.start}],4320):[],after=p.end<4320?intersect(p.net,[{from:p.end,to:4320}],4320):[];
 const values:Record<string,number>={ZoneAWorkingMins:minutes(before,4320),ZoneBWorkingMins:minutes(after,4320)};
 if(p.approved===null)return values;
 const approvedBefore=minutes(intersect(before,p.approved,4320),4320),approvedAfter=minutes(intersect(after,p.approved,4320),4320);
 const unapprovedBefore=minutes(subtract(before,p.approved,4320),4320),unapprovedAfter=minutes(subtract(after,p.approved,4320),4320);
 return {...values,ApproveZoneAOT:approvedBefore,ApproveZoneAPreOT:p.crossesMidnight?approvedBefore:0,
  ApproveZoneBOT:approvedAfter,ApproveZoneBPreOT:p.crossesMidnight?approvedAfter:0,
  ZoneAPreOT:unapprovedBefore,
  // Reporter-defined exception: this legacy ZoneA machine ID expressly means AFTER the shift end.
  ZoneAPostOT:unapprovedAfter,ZoneBPostOT:unapprovedAfter,ZoneBPreOT:p.crossesMidnight?unapprovedAfter:0};
}
