import type {EmployeeHomeGreeting} from '@/core/employee-home-greeting';
import type {EmployeeHomeTasks} from '@/lib/employee-home-tasks';
import type {readEmployeeHomeToday} from '@/core/employee-home-today';
import type {readEmployeeHomeCalendar} from '@/core/employee-home-calendar';
import {validateHomeTeamCalendar} from '@/lib/employee-home-sharing';

export function todayProjection(value:Awaited<ReturnType<typeof readEmployeeHomeToday>>){
 return {version:1,employmentId:value.employmentId,serverNow:value.serverNow,businessDate:value.businessDate,
  attendanceEnabled:value.attendanceEnabled,payrollEnabled:value.payrollEnabled,
  clock:value.clock?{date:value.clock.date,clockedIn:value.clock.clockedIn,openSince:value.clock.openSince,workedSeconds:value.clock.workedSeconds,
   crossesMidnight:value.clock.crossesMidnight,shift:{code:value.clock.shift.code,start:value.clock.shift.start,end:value.clock.shift.end},
   geofencingRequired:value.clock.geofencingRequired,photoRequired:value.clock.photoRequired}:null,
  dayKind:value.dayKind,leavePresence:value.leavePresence,workLocations:{total:value.workLocations.total,names:[...value.workLocations.names]},
  payday:value.payday?{date:value.payday.date,daysAway:value.payday.daysAway}:null};
}

export function calendarProjection(value:Awaited<ReturnType<typeof readEmployeeHomeCalendar>>){
 return {version:1,employmentId:value.employmentId,month:value.month,today:value.today,
  weekStartsOn:value.weekStartsOn,payrollEnabled:value.payrollEnabled,
  team:validateHomeTeamCalendar(value.team,value.days[0].date,value.days[value.days.length-1].date),days:value.days.map(day=>({date:day.date,canRequestLeave:day.canRequestLeave,
   entries:day.entries.map(entry=>entry.kind==='leave'?{kind:entry.kind,date:entry.date,status:entry.status,duration:entry.duration}:
    entry.kind==='holiday'?{kind:entry.kind,date:entry.date,name:entry.name,replacement:entry.replacement,tentative:entry.tentative}:{kind:entry.kind,date:entry.date})}))};
}

export function greetingProjection(value:EmployeeHomeGreeting){
 return {version:value.version,employmentId:value.employmentId,serverNow:value.serverNow,displayDate:value.displayDate,
  timeZone:value.timeZone,message:value.message,templateKey:value.templateKey,photoHref:value.photoHref};
}

export function tasksProjection(value:EmployeeHomeTasks){
 return {version:value.version,employmentId:value.employmentId,grain:value.grain,asOf:value.asOf,
  total:value.total,overdue:value.overdue,effortMinutes:value.effortMinutes,unestimated:value.unestimated,
  page:value.page,pages:value.pages,pageSize:value.pageSize,items:value.items.map(item=>({id:item.id,kind:item.kind,
   subjectName:item.subjectName,createdAt:item.createdAt,linkPath:item.linkPath,overdue:item.overdue,...(item.dueDate?{dueDate:item.dueDate}:{})}))};
}
