import type {EmployeeHomeGreeting} from '@/core/employee-home-greeting';
import type {EmployeeHomeTasks} from '@/lib/employee-home-tasks';

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
