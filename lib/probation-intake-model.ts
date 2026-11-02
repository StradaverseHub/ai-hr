import {addDaysIso} from './roster-month';
import type {ProbationCase,ProbationPart} from './probation-model';
import type {ProbationWorkflow} from './probation-workflow';
export type ProbationExclusionFlags={noProbation:boolean;internalTransfer:boolean;rehire:boolean;confirmedOnHire:boolean};
export type ProbationIntakePart={type:1|2|3;cycle:number;status:'unfinished'|'completed_offline';evidenceId:string|null};
export type ProbationIntakeDisposition={id:string;revision:number;kind:'exclude'|'unfinished';reason:string;validatedUnknown:boolean;exclusionFlags:ProbationExclusionFlags;parts:ProbationIntakePart[];sourceDigest:string};
export type ProbationCutoverRecipient={role:string;userId:string;name:string};
export type ProbationCutoverOccurrence={module:'probation';workflowId:string;workflowName:string;stepId:string;caseId:string;employmentId:string;partId:string|null;event:string;dueOn:string;recipients:ProbationCutoverRecipient[];subject:string;body:string;conditional:true;excludedPast:boolean};
/** Rehearsal is a conditional projection from the frozen intake stage. Actual dispatch resolves pending actors again. */
export function probationCutoverDates(record:ProbationCase,milestones:{kpiReminderOn:string;kpiOverdueOn:string}):{part:ProbationPart;event:string;dueOn:string}[]{
 const dates:{part:ProbationPart;event:string;dueOn:string}[]=[];
 for(const part of record.parts){if(['completed_offline','cancelled','locked'].includes(part.state))continue;
 if(part.type===1){dates.push({part,event:'kpi_assigned',dueOn:part.issueOn},{part,event:'kpi_reminder',dueOn:milestones.kpiReminderOn},{part,event:'kpi_overdue',dueOn:milestones.kpiOverdueOn});continue;}
 dates.push({part,event:'review_issued',dueOn:part.issueOn},{part,event:'review_due',dueOn:part.dueOn});
 const reminders=new Set([addDaysIso(part.dueOn,-record.config.firstReminderDays)]);for(let n=record.config.dailyReminderDays;n>=0;n--)reminders.add(addDaysIso(part.dueOn,-n));
 for(const dueOn of [...reminders].sort())dates.push({part,event:'review_reminder',dueOn});
 }
 return dates.sort((a,b)=>a.dueOn.localeCompare(b.dueOn)||a.part.id.localeCompare(b.part.id)||a.event.localeCompare(b.event));
}
export function probationCutoverWorkflowMatches(workflow:ProbationWorkflow,facts:{companyId:string;businessGroupId:string;businessUnitId:string|null;departmentId:string|null;grade:string},type:number){const c=workflow.conditions;return(!c.businessGroupId||c.businessGroupId===facts.businessGroupId)&&(!c.businessUnitId||c.businessUnitId===facts.businessUnitId)&&(!c.departmentId||c.departmentId===facts.departmentId)&&(!c.grade||c.grade===facts.grade)&&(!c.part||c.part===type);}
