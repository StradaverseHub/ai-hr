import {addDaysIso} from './roster-month';
import {ProbationError,type ProbationCase,type ProbationPart} from './probation-model';
import type {ProbationWorkflow} from './probation-workflow';
export type ProbationExclusionFlags={noProbation:boolean;internalTransfer:boolean;rehire:boolean;confirmedOnHire:boolean};
export type ProbationIntakePart={type:1|2|3;cycle:number;status:'unfinished'|'completed_offline';evidenceId:string|null};
export type ProbationIntakeDisposition={id:string;revision:number;kind:'exclude'|'unfinished';reason:string;validatedUnknown:boolean;exclusionFlags:ProbationExclusionFlags;parts:ProbationIntakePart[];extensionCount?:number;extensionEventIds?:string[];validatedHistory?:boolean;sourceDigest:string};
export type ProbationCutoverRecipient={role:string;userId:string;name:string};
export type ProbationCutoverOccurrence={module:'probation';workflowId:string;workflowName:string;stepId:string;caseId:string;employmentId:string;partId:string|null;event:string;dueOn:string;recipients:ProbationCutoverRecipient[];subject:string;body:string;conditional:true;excludedPast:boolean};
/** Rehearsal is a conditional projection from the frozen intake stage. Actual dispatch resolves pending actors again. */
export function probationCutoverDates(record:Pick<ProbationCase,'parts'|'config'>,milestones:{kpiReminderOn:string;kpiOverdueOn:string}):{part:ProbationPart;event:string;dueOn:string}[]{
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
export type ProbationExtensionSource={id:string;kind:'probation_extension'|'date_shift'|'unclassified'|'current_source';oldEndOn:string|null;newEndOn:string;months:3|6|null;recordedAt:string|null};
export type ProbationRequiredIntakePart={type:1|2|3;cycle:number;requiresOffline:boolean};
export type ProbationIntakeStageOption={extensionCount:number;requiredParts:ProbationRequiredIntakePart[]};
/** Period ends come from the current source and the next actual extension's prior period, never posted dates. */
export function probationIntakeCycleEnds(source:{startOn:string;endOn:string|null;extensionHistory?:ProbationExtensionSource[]},selectedIds:string[],fallbackEnd:string):string[]{
 const selected=(source.extensionHistory??[]).filter(event=>selectedIds.includes(event.id));
 if(new Set(selectedIds).size!==selectedIds.length||selected.length!==selectedIds.length||selected.length>2||selected.some(event=>event.kind==='date_shift'||!event.months||!event.oldEndOn))throw new ProbationError('invalid','Choose the reviewed canonical extension sources.');
 const ends=[...selected.map(event=>event.oldEndOn!),source.endOn??fallbackEnd];
 if(ends[0]<source.startOn||ends.some((end,i)=>i>0&&end<=ends[i-1]))throw new ProbationError('invalid','The reviewed source periods do not form an ordered probation history.');return ends;
}
export type ProbationOfflineFinalDecision={id:string;entryId:string;revision:number;outcome:'confirm'|'extend'|'not_confirm'|'other';extensionMonths:3|6|null;reason:string;evidenceId:string;fileId:string|null;periodStart:string;periodEnd:string;proposedBy:string;proposedAt:string;acceptedBy:string|null;acceptedAt:string|null};
