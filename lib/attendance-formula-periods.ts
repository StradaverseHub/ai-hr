import {addDaysIso,isoWeekdayOf,monthDates} from './roster-month';
import {isCalendarDate} from './calendar-date';
export type AttendanceFormulaPeriod={method:'daily'}|{method:'weekly';cutoff:number}|{method:'monthly';cutoff:number};
/** Cutoff is inclusive. A missing monthly day clamps to that month's last real date. */
export function attendanceFormulaPeriod(date:string,rule:AttendanceFormulaPeriod){
 if(!isCalendarDate(date))throw Error('Choose a real attendance date.');
 if(rule.method==='daily')return {from:date,to:date,key:date};
 if(!Number.isInteger(rule.cutoff)||rule.cutoff<1||rule.cutoff>(rule.method==='weekly'?7:31))throw Error('Choose a valid period cutoff.');
 if(rule.method==='weekly'){const to=addDaysIso(date,(rule.cutoff-isoWeekdayOf(date)+7)%7);return {from:addDaysIso(to,-6),to,key:to};}
 const end=(month:string)=>{const dates=monthDates(month);return dates[Math.min(rule.cutoff,dates.length)-1];};
 let to=end(date.slice(0,7));if(date>to)to=end(addDaysIso(monthDates(date.slice(0,7)).at(-1)!,1).slice(0,7));
 const previous=end(addDaysIso(to.slice(0,7)+'-01',-1).slice(0,7));return {from:addDaysIso(previous,1),to,key:to};
}
