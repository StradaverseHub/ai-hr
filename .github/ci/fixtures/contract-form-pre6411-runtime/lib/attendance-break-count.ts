/** Shared per-row break-count owner. Allowances are counts, never physical unpaid intervals. */
import {anchorAttendanceClockMinute} from '../core/attendance-timeline';
import type {ClosedClockInterval} from './full-flexi-time';
type Break={start:string;end:string;paid?:boolean;flexible?:boolean;flexibleMinutes?:number};
const minute=(clock:string)=>{const [h,m]=clock.split(':').map(Number);return h*60+m;};
/** The canonical schedule supplies the anchor/cutoff; the clock owner supplies closed intervals.
 * A flexible row contributes once per day, while fixed rows count only actual captured overlap.
 * Null preserves the caller's existing non-per-row break owner and precedence. */
export function perRowAttendanceBreakMinutes(periods:readonly Break[]|null,breakMinutes:number,
 intervals:readonly ClosedClockInterval[],startAbs:number,cutoffAbs:number|null|undefined,span:number):number|null{
 if(!periods?.length)return null;
 const unpaid=periods.filter(bp=>bp.paid!==true);
 if(!unpaid.some(bp=>bp.flexible===true&&bp.flexibleMinutes!=null))return null;
 const total=unpaid.reduce((acc,bp)=>{
  if(bp.flexible===true&&bp.flexibleMinutes!=null)return acc+Math.max(0,Math.trunc(bp.flexibleMinutes));
  const from=anchorAttendanceClockMinute(minute(bp.start),startAbs,cutoffAbs);
  const to=anchorAttendanceClockMinute(minute(bp.end),startAbs,cutoffAbs);
  return acc+intervals.reduce((sum,row)=>sum+Math.max(0,Math.min(row.outAbs,to)-Math.max(row.inAbs,from)),0);
 },0);
 return Math.min(total,breakMinutes,span);
}
