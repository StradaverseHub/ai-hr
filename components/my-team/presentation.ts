/** Pure presentation of canonical My Team facts, shared by grid and export. No payroll/leave/time rules. */
import type {MyTeamDay,MyTeamEmployee,MyTeamLayers,MyTeamWeekSummary,MyTeamLeaveDay} from '@/lib/my-team-types';
import type messages from '@/messages/en.json';
import {formatDays} from '@/lib/day-format';
export type MyTeamMessageKey=keyof typeof messages.myTeam;
export type MyTeamTranslate=(key:MyTeamMessageKey,values?:Record<string,string|number>)=>string;
export type MyTeamCellStatus='present'|'late'|'absent'|'approved_leave'|'off'|'upcoming'|'unavailable';
export const STATUS_CLASSES:Record<MyTeamCellStatus,string>={
 present:'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
 late:'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
 absent:'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
 approved_leave:'bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200',
 off:'bg-muted text-muted-foreground',upcoming:'bg-card text-muted-foreground',unavailable:'bg-card text-muted-foreground',
};
export function dateText(date:string,locale:string,options:Intl.DateTimeFormatOptions={weekday:'short',day:'numeric',month:'short'}):string{
 return new Intl.DateTimeFormat(locale,{...options,timeZone:'UTC'}).format(new Date(`${date}T00:00:00Z`));
}
export function clockText(value:string|null,locale:string):string{
 if(!value)return '—';
 const instant=new Date(value);if(!Number.isFinite(instant.getTime()))return '—';
 return new Intl.DateTimeFormat(locale,{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Kuala_Lumpur'}).format(instant);
}
export function initials(name:string):string{return name.trim().split(/\s+/).slice(0,2).map(part=>part[0]??'').join('').toLocaleUpperCase();}
export function weekFor(employee:MyTeamEmployee,selectedDate:string):MyTeamWeekSummary|undefined{return employee.weeks.find(week=>week.from<=selectedDate&&week.to>=selectedDate);}
function attendanceText(day:MyTeamDay,locale:string,t:MyTeamTranslate):string|null{
 const a=day.attendance;if(!a)return null;
 const time=clockText(a.checkInAt,locale),out=clockText(a.checkOutAt,locale);
 if(a.checkInAt&&!a.checkOutAt)return t('inNoOut',{time});
 if(!a.checkInAt&&a.checkOutAt)return t('outNoIn',{time:out});
 if(a.checkInAt&&(a.flag==='late'||a.status==='late'))return t('lateIn',{time});
 if(a.checkInAt&&a.checkOutAt)return `${time}–${out}`;
 if(a.status==='absent')return t('status_absent');
 if(a.status==='rest')return t('restCode');
 if(a.status==='off')return t('offCode');
 if(a.status==='on_leave')return t('status_approved_leave');
 return null;
}
export function visualStatus(day:MyTeamDay,today:string):MyTeamCellStatus{
 if(day.leave.some(leave=>leave.status==='approved'&&leave.session==='full_day'))return 'approved_leave';
 if(day.roster?.isRestDay||day.attendance?.status==='rest'||day.attendance?.status==='off'||day.attendance?.status==='ph')return 'off';
 if(day.date>today)return 'upcoming';
 if(day.attendance){
  if(day.attendance.flag==='odd'||day.attendance.flag==='late'||day.attendance.status==='late')return 'late';
  if(day.attendance.status==='absent')return 'absent';
  if(day.attendance.status==='present'||day.attendance.attendanceId)return 'present';
 }
 if(day.leave.some(leave=>leave.status==='approved'))return 'approved_leave';
 return 'unavailable';
}
function leaveText(leave:MyTeamLeaveDay,t:MyTeamTranslate):string{
 let code=leave.code;
 if(leave.session==='AM'||leave.session==='PM')code=t('leaveHalf',{code,session:t(`session_${leave.session}`)});
 else if(leave.session==='hourly'&&leave.fromTime&&leave.toTime)code=`${code} ${leave.fromTime}–${leave.toTime}`;
 return leave.status==='pending'?t('leavePendingCode',{code}):code;
}
export function formatMyTeamCell(day:MyTeamDay,layers:MyTeamLayers,locale:string,t:MyTeamTranslate,options:{today:string;view:'week'|'month'}){
 const status=visualStatus(day,options.today),pending=day.leave.some(leave=>leave.status==='pending');
 const shift=day.roster?.isRestDay?t('restCode'):day.roster?.code??'—';
 const roster=layers.roster&&day.roster?`${shift}${day.roster.isOverride?' *':''}`:null;
 const leaveTexts=layers.leave?day.leave.map(leave=>leaveText(leave,t)):[];
 const attendance=layers.attendance&&day.date<=options.today?attendanceText(day,locale,t):null;
 const future=layers.roster&&day.date>options.today&&day.roster?.start&&day.roster.end?`${day.roster.start}–${day.roster.end}`:null;
 const primary=leaveTexts.length?leaveTexts.join(' · '):attendance??future;
 const secondary=leaveTexts.length&&day.leave.some(leave=>leave.session==='AM'||leave.session==='PM'||leave.session==='hourly')?attendance:null;
 let compact='';
 if(leaveTexts.length)compact=day.leave.map(leave=>`${leave.code}${leave.status==='pending'?'?':''}`).join('/');
 else if(layers.attendance&&day.date<=options.today&&day.attendance){
  if(day.attendance.flag==='odd')compact='!';else if(day.attendance.flag==='late'||day.attendance.status==='late')compact=t('lateCode');else if(day.attendance.status==='absent')compact=t('absentCode');
 }
 if(!compact&&layers.roster&&day.roster)compact=day.roster.isRestDay?t('restCode'):day.attendance?.status==='off'?'·':day.roster.code??'—';
 const details=[day.roster?.code??(day.roster?.isRestDay?t('restCode'):null),attendanceText(day,locale,t),t(`status_${status}`),...day.leave.map(leave=>leaveText(leave,t))].filter(Boolean).join(' · ')||t('status_unavailable');
 return {roster,primary,secondary,compact,description:details,status,pending,exportText:options.view==='month'?compact:[roster,primary,secondary].filter(Boolean).join(' · ')};
}
export function annualText(employee:MyTeamEmployee,t:MyTeamTranslate):string{return employee.annualAvailable==null?t('annualUnavailable'):t('annualBalance',{days:formatDays(employee.annualAvailable)});}
