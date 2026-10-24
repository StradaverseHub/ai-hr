import {HOME_TASK_KINDS,type HomeTaskKind} from './employee-home';
import {isCalendarDate} from './calendar-date';

export type EmployeeHomeTask={
 id:string;kind:HomeTaskKind;subjectName:string|null;createdAt:string;linkPath:string;dueDate?:string;
};
export type EmployeeHomeTasks={
 version:1;employmentId:string;grain:'account';asOf:string;total:number;overdue:number;
 effortMinutes:number;unestimated:number;page:number;pages:number;pageSize:12;
 items:(EmployeeHomeTask&{overdue:boolean})[];
};

/** Counts and effort cover every actual assignment, independently of this card's bounded page.
 * A missing estimate/deadline stays unknown. Submission age never manufactures an overdue task. */
export function projectHomeAssignedWork(tasks:readonly EmployeeHomeTask[],options:{
 employmentId:string;today:string;page?:number;effortMinutes:Partial<Record<HomeTaskKind,number>>;
}):EmployeeHomeTasks{
 if(!isCalendarDate(options.today))throw Error('Invalid assigned-work business date.');
 const unique=new Map<string,EmployeeHomeTask&{overdue:boolean}>();
 for(const task of tasks){
  if(!HOME_TASK_KINDS.includes(task.kind)||!task.id||!Number.isFinite(Date.parse(task.createdAt))
   ||!task.linkPath.startsWith('/')||task.linkPath.startsWith('//')||/[\x00-\x20\\]/.test(task.linkPath)
   ||task.dueDate!==undefined&&!isCalendarDate(task.dueDate))throw Error('Invalid assigned-work metadata.');
  const key=task.kind+':'+task.id;
  if(unique.has(key))throw Error('Duplicate assigned-work owner identity.');
  unique.set(key,{...task,overdue:task.dueDate!==undefined&&task.dueDate<options.today});
 }
 const all=[...unique.values()].sort((a,b)=>Number(b.overdue)-Number(a.overdue)
  ||(a.dueDate??'9999-12-31').localeCompare(b.dueDate??'9999-12-31')
  ||b.createdAt.localeCompare(a.createdAt)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
 let effortMinutes=0,unestimated=0;
 for(const task of all){
  const estimate=options.effortMinutes[task.kind];
  if(estimate===undefined)unestimated++;
  else if(!Number.isSafeInteger(estimate)||estimate<0||estimate>1440)throw Error('Invalid assigned-work effort estimate.');
  else effortMinutes+=estimate;
 }
 const pages=Math.max(1,Math.ceil(all.length/12));
 const page=Math.min(pages,Math.max(1,Number.isSafeInteger(options.page)?options.page!:1));
 return {version:1,employmentId:options.employmentId,grain:'account',asOf:options.today,total:all.length,
  overdue:all.filter(task=>task.overdue).length,effortMinutes,unestimated,page,pages,pageSize:12,items:all.slice((page-1)*12,page*12)};
}
