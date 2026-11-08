/** Projection of already-proved physical/approved coverage. Establishes no approval or payable claim. */
import {intersectAttendancePolicyIntervals as intersect,subtractAttendancePolicyIntervals as subtract,attendancePolicyIntervalMinutes as minutes,type AttendancePolicyInterval} from './attendance-policy-intervals';
export function attendanceFormulaOvertimeMeasurements(p:{net:readonly AttendancePolicyInterval[];approved:readonly AttendancePolicyInterval[]|null;eligible:readonly AttendancePolicyInterval[]|null;start:number;end:number;crossesMidnight:boolean}){
 if(!Number.isSafeInteger(p.start)||!Number.isSafeInteger(p.end)||p.start<0||p.start>=p.end||p.end>4320)throw Error('Invalid proved shift boundary.');
 const before=p.start>0?intersect(p.net,[{from:0,to:p.start}],4320):[],after=p.end<4320?intersect(p.net,[{from:p.end,to:4320}],4320):[];
 const values:Record<string,number>={ZoneAWorkingMins:minutes(before,4320),ZoneBWorkingMins:minutes(after,4320)};
 if(p.approved===null||p.eligible===null)return values;
 const beforeOt=intersect(before,p.eligible,4320),afterOt=intersect(after,p.eligible,4320);
 const approvedBefore=minutes(intersect(beforeOt,p.approved,4320),4320),approvedAfter=minutes(intersect(afterOt,p.approved,4320),4320);
 const unapprovedBefore=minutes(subtract(beforeOt,p.approved,4320),4320),unapprovedAfter=minutes(subtract(afterOt,p.approved,4320),4320);
 return {...values,OTAssignmentInShift:minutes(intersect(intersect(p.eligible,p.approved,4320),[{from:p.start,to:p.end}],4320),4320),ApproveZoneAOT:approvedBefore,ApproveZoneAPreOT:p.crossesMidnight?approvedBefore:0,
  ApproveZoneBOT:approvedAfter,ApproveZoneBPreOT:p.crossesMidnight?approvedAfter:0,
  ZoneAPreOT:unapprovedBefore,
  // Reporter-defined exception: this legacy ZoneA machine ID expressly means AFTER the shift end.
  ZoneAPostOT:unapprovedAfter,ZoneBPostOT:unapprovedAfter,ZoneBPreOT:p.crossesMidnight?unapprovedAfter:0};
}
