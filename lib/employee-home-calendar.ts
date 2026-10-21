import {calendarWindowDates} from './calendar-window';
import {isMonthParam,monthRange,addDaysIso} from './roster-month';

export type HomeCalendarEntry=
 |{kind:'leave';date:string;status:'approved'|'pending';duration:'full_day'|'part_day'}
 |{kind:'holiday';date:string;name:string|null;replacement:boolean;tentative:boolean}
 |{kind:'payday';date:string};
export type EmployeeHomeCalendar={
 version:1;employmentId:string;month:string;today:string;weekStartsOn:number;
 days:{date:string;canRequestLeave:boolean;entries:HomeCalendarEntry[]}[];
 payrollEnabled:boolean;
};
export function homeCalendarMonth(month:string){
 if(!isMonthParam(month)||Number(month.slice(0,4))<1000)throw Error('Invalid calendar month.');
 const range=monthRange(month);calendarWindowDates(range.from,range.to);return range;
}
export function homeCalendarGrid(month:string,weekStartsOn:number){
 if(!Number.isInteger(weekStartsOn)||weekStartsOn<0||weekStartsOn>6)throw Error('Invalid calendar week start.');
 const {from,to}=homeCalendarMonth(month);
 const first=addDaysIso(from,-((new Date(from+'T00:00:00Z').getUTCDay()-weekStartsOn+7)%7));
 const last=addDaysIso(to,(weekStartsOn+6-new Date(to+'T00:00:00Z').getUTCDay()+7)%7);
 return calendarWindowDates(first,last);
}
/** The API whitelist is repeated at the client boundary so malformed/stale provider data fails only
 * this card. A response for another subject/month can never be painted under the current heading. */
export function validateHomeCalendar(value:EmployeeHomeCalendar,employmentId:string,month:string){
 homeCalendarMonth(month);
 if(!value||value.version!==1||value.employmentId!==employmentId||value.month!==month
  ||!Number.isInteger(value.weekStartsOn)||value.weekStartsOn<0||value.weekStartsOn>6
  ||typeof value.payrollEnabled!=='boolean'||!Array.isArray(value.days))throw Error('Calendar unavailable.');
 const dates=homeCalendarGrid(month,value.weekStartsOn);
 if(value.days.length!==dates.length)throw Error('Calendar unavailable.');
 calendarWindowDates(value.today,value.today);
 value.days.forEach((day,index)=>{
  if(!day||day.date!==dates[index]||typeof day.canRequestLeave!=='boolean'||!Array.isArray(day.entries)||day.entries.length>100)throw Error('Calendar unavailable.');
  for(const entry of day.entries){
   if(!entry||entry.date!==day.date)throw Error('Calendar unavailable.');
   if(entry.kind==='leave'){
    if(!['approved','pending'].includes(entry.status)||!['full_day','part_day'].includes(entry.duration))throw Error('Calendar unavailable.');
   }else if(entry.kind==='holiday'){
    if(entry.name!==null&&(typeof entry.name!=='string'||!entry.name.trim()||entry.name.length>1000)
     ||typeof entry.replacement!=='boolean'||typeof entry.tentative!=='boolean')throw Error('Calendar unavailable.');
   }else if(entry.kind!=='payday'||!value.payrollEnabled)throw Error('Calendar unavailable.');
  }
 });
 return value;
}
