/** Bounded interval arithmetic for the canonical Attendance policy owner. Inputs are evidenced whole
 * minutes on its already-resolved attendance timeline, never inferred clock direction or calendar days.
 * These functions neither approve work nor establish the evidence/authority of their caller's inputs. */
export type AttendancePolicyInterval={from:number;to:number};
// At whole-minute precision a three-day timeline cannot contain more than 4320 disjoint nonempty
// pieces. Keep the same bound for every stage so a legitimate intersection/subtraction result can
// be passed to the next stage without failing a smaller, arbitrary intermediate cardinality limit.
const MAX_INTERVALS=4320;
function period(value:number):void{
 if(!Number.isSafeInteger(value)||value<1||value>4320)throw Error('Invalid canonical attendance period.');
}
/** Union before counting: duplicate and overlapping approved windows cannot pay a minute twice.
 * Normalizing a view does not delete or rewrite any underlying raw clock/approval evidence. */
export function unionAttendancePolicyIntervals(input:readonly AttendancePolicyInterval[],periodMinutes:number):AttendancePolicyInterval[]{
 period(periodMinutes);
 if(input.length>MAX_INTERVALS)throw Error('Too many evidenced attendance intervals.');
 const sorted=input.map(row=>{
  if(!Number.isSafeInteger(row.from)||!Number.isSafeInteger(row.to)||row.from<0||row.from>=row.to||row.to>periodMinutes)
   throw Error('Invalid evidenced attendance interval.');
  return {from:row.from,to:row.to};
 }).sort((a,b)=>a.from-b.from||a.to-b.to);
 const output:AttendancePolicyInterval[]=[];
 for(const row of sorted){
  const previous=output.at(-1);
  if(previous&&row.from<=previous.to)previous.to=Math.max(previous.to,row.to);
  else output.push(row);
 }
 return output;
}
/** Actual intersection, not smaller_of(actualCount, plannedCount). Disjoint windows yield no minutes. */
export function intersectAttendancePolicyIntervals(actual:readonly AttendancePolicyInterval[],planned:readonly AttendancePolicyInterval[],periodMinutes:number):AttendancePolicyInterval[]{
 const a=unionAttendancePolicyIntervals(actual,periodMinutes),b=unionAttendancePolicyIntervals(planned,periodMinutes);
 const output:AttendancePolicyInterval[]=[];let i=0,j=0;
 while(i<a.length&&j<b.length){
  const from=Math.max(a[i].from,b[j].from),to=Math.min(a[i].to,b[j].to);
  if(from<to)output.push({from,to});
  if(a[i].to<b[j].to)i++;else j++;
 }
 return output;
}
/** Remove evidenced exclusions once as a union. An unlocated scalar break cannot be passed as a
 * fabricated interval: its count remains usable only through the existing duration-only owner. */
export function subtractAttendancePolicyIntervals(actual:readonly AttendancePolicyInterval[],excluded:readonly AttendancePolicyInterval[],periodMinutes:number):AttendancePolicyInterval[]{
 const a=unionAttendancePolicyIntervals(actual,periodMinutes),b=unionAttendancePolicyIntervals(excluded,periodMinutes);
 const output:AttendancePolicyInterval[]=[];let j=0;
 for(const row of a){
  let cursor=row.from;
  while(j<b.length&&b[j].to<=cursor)j++;
  let index=j;
  while(index<b.length&&b[index].from<row.to){
   if(b[index].from>cursor)output.push({from:cursor,to:Math.min(row.to,b[index].from)});
   cursor=Math.max(cursor,b[index].to);
   if(cursor>=row.to)break;
   index++;
  }
  if(cursor<row.to)output.push({from:cursor,to:row.to});
 }
 return output;
}
/** Consume a measured lateness offset from the earliest remaining eligible intervals. Call after the
 * canonical break/exclusion owner, exactly once for the day, not independently per punch or session. */
export function offsetAttendancePolicyIntervals(input:readonly AttendancePolicyInterval[],minutes:number,periodMinutes:number):
 {intervals:AttendancePolicyInterval[];removedMinutes:number}{
 const rows=unionAttendancePolicyIntervals(input,periodMinutes);
 if(!Number.isSafeInteger(minutes)||minutes<0||minutes>periodMinutes)throw Error('Invalid measured lateness offset.');
 let remaining=minutes,removedMinutes=0;const intervals:AttendancePolicyInterval[]=[];
 for(const row of rows){
  const removed=Math.min(remaining,row.to-row.from);remaining-=removed;removedMinutes+=removed;
  if(row.from+removed<row.to)intervals.push({from:row.from+removed,to:row.to});
 }
 return {intervals,removedMinutes};
}
export function attendancePolicyIntervalMinutes(input:readonly AttendancePolicyInterval[],periodMinutes:number):number{
 return unionAttendancePolicyIntervals(input,periodMinutes).reduce((sum,row)=>sum+row.to-row.from,0);
}
/** Partition one source rather than creating additional Attendance/payment identities. Date offsets
 * are timeline offsets only: the caller still needs recorded timezone/date and calendar provenance. */
export function splitAttendancePolicyIntervalsAtMidnight(input:readonly AttendancePolicyInterval[],periodMinutes:number):
 {dayOffset:number;from:number;to:number;sourceFrom:number;sourceTo:number}[]{
 const output:{dayOffset:number;from:number;to:number;sourceFrom:number;sourceTo:number}[]=[];
 for(const row of unionAttendancePolicyIntervals(input,periodMinutes)){
  let cursor=row.from;
  while(cursor<row.to){
   const dayOffset=Math.floor(cursor/1440),end=Math.min(row.to,(dayOffset+1)*1440);
   output.push({dayOffset,from:cursor-dayOffset*1440,to:end-dayOffset*1440,sourceFrom:cursor,sourceTo:end});cursor=end;
  }
 }
 return output;
}
