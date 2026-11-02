import type {Block,Field,Template} from './lifecycle-v9-model';
import type {SigningRoute} from './document-signing-model';
export type ProbationWorkflowEvent='kpi_assigned'|'kpi_reminder'|'kpi_overdue'|'review_issued'|'review_reminder'|'review_due'|'approval_pending'|'letter_released'|'overdue_summary';
export type ProbationWorkflow={id:string;name:string;module:'probation';status:'draft'|'published';description:string;trigger:{event:ProbationWorkflowEvent};conditions:{businessGroupId?:string;businessUnitId?:string;departmentId?:string;grade?:string;part?:1|2|3};steps:{id:string;type:'notify';subject:string;body:string;to:('employee'|'lm'|'hod'|'pbp'|'gbs')[]}[]};
export type ProbationTemplate=Omit<Template,'module'>&{module:'probation';blocks:Block[];fields:Field[];outcome:'confirm'|'extend'|'not_confirm';unfinished:boolean;route:SigningRoute};
const events:ProbationWorkflowEvent[]=['kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_released','overdue_summary'];
export function probationWorkflowIssues(value:ProbationWorkflow):string[]{
 const issues:string[]=[];if(value.module!=='probation'||!value.id||!value.name?.trim())issues.push('Name this probation workflow.');if(!events.includes(value.trigger?.event))issues.push('Choose a probation event.');if(!value.steps?.length||value.steps.length>10)issues.push('Add one to ten notification steps.');
 for(const step of value.steps??[]){if(step.type!=='notify'||!step.id||!step.subject?.trim()||step.subject.length>200||/[\r\n]/.test(step.subject)||!step.body?.trim()||step.body.length>20000||!step.to?.length||step.to.some(r=>!['employee','lm','hod','pbp','gbs'].includes(r)))issues.push('Complete each message and choose scoped recipients.');for(const text of[step.subject,step.body])for(const token of text?.matchAll(/\{\{([^{}]+)\}\}/g)??[])if(!['employeeName','employeeCode','part','dueOn','endOn','companyName'].includes(token[1].trim()))issues.push('Use a supported probation merge field.');}
 return [...new Set(issues)];
}
export function renderProbationWords(text:string,values:Record<string,string>){return text.replace(/\{\{([^{}]+)\}\}/g,(_,key:string)=>values[key.trim()]??'');}
