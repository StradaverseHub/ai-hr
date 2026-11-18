/** Shared schedule-clock placement. Captured punches retain their actual receipt date instead. */
export function anchorAttendanceClockMinute(minutes:number,shiftStartAbs:number,cutoffAbs?:number|null):number{
 if(cutoffAbs!=null)return minutes<cutoffAbs?minutes+1440:minutes;
 return minutes<shiftStartAbs-720?minutes+1440:minutes;
}
