/** Read-only projections from the calculation's frozen schedule and proved closed clocks. */
import type {AttendanceTraceV1} from './attendance-trace';
import {attendancePolicyWorkPlacement} from './attendance-policy-schedule';
import {anchorAttendanceClockMinute} from './attendance-timeline';
import {breakRowMinutes,externalBreakBounds} from './shift-break-rules';
import {intersectAttendancePolicyIntervals as intersect,subtractAttendancePolicyIntervals as subtract,unionAttendancePolicyIntervals as union,attendancePolicyIntervalMinutes as minutes,type AttendancePolicyInterval} from '../lib/attendance-policy-intervals';
const clock=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3,5));
export function attendanceFormulaRecordedMeasurements(trace:AttendanceTraceV1,physical:readonly AttendancePolicyInterval[]|null,selected:readonly AttendancePolicyInterval[]|null=physical){
 const values:Record<string,number>={},frozen=trace.formulaSchedule;if(!frozen||frozen.v!==1)return {values,breaks:null};
 const start=trace.schedule.startAbs,end=trace.schedule.endAbs;
 const regular=(frozen.breakPeriods??[]).filter(row=>!row.breakType||row.breakType==='in_shift');
 for(let i=0;i<4;i++){const row=regular[i];values['Break'+(i+1)+'Interval']=row?breakRowMinutes(row.start,row.end):0;}
 if(trace.schedule.breakSpanned!==null&&!(frozen.breakPeriods??[]).some(row=>row.breakType==='before_shift'||row.breakType==='after_shift'))values.ActualShiftBreak=trace.schedule.breakSpanned;
 if(selected){for(let i=0;i<4;i++)values['Flex'+(i+1)+'Interval']=frozen.flexiDuration?(selected[i]?selected[i].to-selected[i].from:0):0;}
 const gross=physical?minutes(physical,4320):null;
 values.BreakOnShift=regular.filter(row=>!row.flexible).reduce((sum,row)=>sum+breakRowMinutes(row.start,row.end),0);
 if(physical){
  const flexTotal=regular.filter(row=>!row.paid&&row.flexible&&row.flexibleMinutes!=null).reduce((sum,row)=>sum+row.flexibleMinutes!,0);
  if(frozen.flexibleBreakMinutes!==null&&trace.schedule.breakSpanned!==null)values.FlexiBreakOnShift=trace.schedule.breakSpanned;
  else if(flexTotal===0||gross!>=flexTotal&&trace.schedule.breakSpanned!==null&&trace.schedule.breakSpanned>=flexTotal)values.FlexiBreakOnShift=flexTotal;
  for(let i=0;i<4;i++){const row=regular[i];if(!row||row.paid||!row.flexible)values['Break'+(i+1)+'FlexUsed']=0;else if(frozen.flexibleBreakMinutes===null&&row.flexibleMinutes!=null&&gross!>=flexTotal&&trace.schedule.breakSpanned!==null&&trace.schedule.breakSpanned>=flexTotal)values['Break'+(i+1)+'FlexUsed']=row.flexibleMinutes;}
 }
 if(start===null||end===null||end<=start)return {values,breaks:null};
 const rows=(frozen.breakPeriods??[]).map(row=>{
  const bounds=row.breakType==='before_shift'||row.breakType==='after_shift'?externalBreakBounds(row,start,end):{from:anchorAttendanceClockMinute(clock(row.start),start,trace.schedule.dailyCutoffMinutes),to:anchorAttendanceClockMinute(clock(row.end),start,trace.schedule.dailyCutoffMinutes)};
  return {...row,...bounds};
 });
 if(rows.some(row=>row.from<0||row.to<=row.from||row.to>4320))return {values,breaks:null};
 const label=(n:number)=>String(Math.floor(n/60)%24).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
 const placement=attendancePolicyWorkPlacement({start:label(start),end:label(end),crossesMidnight:trace.schedule.crossesMidnight,dailyCutoffMinutes:trace.schedule.dailyCutoffMinutes??null,durationOnly:frozen.durationOnly,flexiDuration:frozen.flexiDuration,dayType:trace.schedule.dayType,breakMinutes:trace.schedule.breakMinutes,breakPeriods:frozen.breakPeriods,flexibleBreakMinutes:frozen.flexibleBreakMinutes,otWindows:null,includeGraceInLateness:trace.lateness?.includeGrace??false,includeGraceInEarlyOut:trace.earlyOut?.includeGrace??false});
 if(selected&&placement.state==='known'&&!frozen.flexiDuration){const net=subtract(selected,placement.unpaidWindows,4320);values.ShiftWorkingMins=minutes(intersect(net,[{from:start,to:end}],4320),4320);const half=anchorAttendanceClockMinute(clock(frozen.halfDayBefore),start,trace.schedule.dailyCutoffMinutes);if(half>start&&half<end){values.ShiftFirstHalfWorkingMins=minutes(intersect(net,[{from:start,to:half}],4320),4320);values.ShiftSecondHalfWorkingMins=minutes(intersect(net,[{from:half,to:end}],4320),4320);}}
 const regions={PreOT:rows.filter(row=>row.breakType==='before_shift'),PostOT:rows.filter(row=>row.breakType==='after_shift'),Shift:rows.filter(row=>!row.breakType||row.breakType==='in_shift')};
 for(const [region,breaks]of Object.entries(regions)){
  values['BreakOn'+region]=breaks.filter(row=>!row.flexible).reduce((sum,row)=>sum+row.to-row.from,0);
  if(!physical)continue;
  const flexible=breaks.filter(row=>!row.paid&&row.flexible&&row.flexibleMinutes!=null),allowance=flexible.reduce((sum,row)=>sum+row.flexibleMinutes!,0);
  // A whole-shift allowance or a clamped short day cannot be attributed to individual break rows.
  if(frozen.flexibleBreakMinutes===null&&gross!>=allowance&&(region!=='Shift'||allowance<=trace.schedule.breakSpanned!))values['FlexiBreakOn'+region]=allowance;
  const windows=breaks.filter(row=>!row.flexible).map(({from,to})=>({from,to}));
  if(region!=='Shift'&&breaks.every(row=>!row.flexible&&row.clockingRequired===true))values[region+'BreakWorkingMins']=minutes(intersect(physical,windows,4320),4320);
 }
 if(selected&&regions.Shift.every(row=>!row.flexible&&row.clockingRequired===true)&&frozen.flexibleBreakMinutes===null){
  const inShift=minutes(intersect(selected,regions.Shift.map(({from,to})=>({from,to})),4320),4320);
  values.ZoneAInShiftOT=inShift;values.ZoneBPreInShiftOT=inShift;values.ZoneBPostInShiftOT=inShift;
 }
 if(physical){
  const covered=union(physical,4320);if(!covered.length)return {values,breaks:rows};
  if(trace.formulaBreaks&&trace.formulaBreaks.v===1&&trace.punch.workedMinutes!==null&&gross!-trace.punch.workedMinutes===trace.formulaBreaks.actualBefore+trace.formulaBreaks.actualAfter+trace.formulaBreaks.actualShift){values.ActualPreOTBreak=trace.formulaBreaks.actualBefore;values.ActualPostOTBreak=trace.formulaBreaks.actualAfter;values.ActualShiftBreak=trace.formulaBreaks.actualShift;}
  // Clocked work during a declared fixed break proves its unused portion; flexible allowances have no position.
  if(rows.every(row=>!row.flexible&&(row.paid||row.clockingRequired===true))&&frozen.flexibleBreakMinutes===null)values.UnUtilisedBreak=minutes(intersect(physical,rows.filter(row=>!row.paid).map(({from,to})=>({from,to})),4320),4320);
  const gaps=covered.slice(1).map((part,index)=>({from:covered[index].to,to:part.from}));
  for(const [region,breaks]of Object.entries(regions)){
   if(breaks.some(row=>row.flexible||row.clockingRequired!==true))continue;
   let late=0,early=0,known=true;
   for(const row of breaks){
    if(covered[0].from>row.from||covered.at(-1)!.to<row.to){known=false;break;}
    const touching=gaps.filter(gap=>gap.from<row.to&&gap.to>row.from);
    if(touching.some(gap=>rows.filter(other=>!other.flexible&&gap.from<other.to&&gap.to>other.from).length!==1)){known=false;break;}
    for(const gap of touching){late+=Math.max(0,gap.to-row.to);early+=Math.max(0,row.from-gap.from);}
   }
   if(known){values['LateOn'+region+'Break']=late;values['EarlyOutOn'+region+'Break']=early;}
  }
 }
 return {values:Object.fromEntries(Object.entries(values).filter(([,value])=>typeof value==='number'&&Number.isFinite(value))),breaks:rows};
}
