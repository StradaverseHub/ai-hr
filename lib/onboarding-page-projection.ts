import type {Actor,Case,Config,Facts} from './onboarding-model';
import {inGroup} from './onboarding-model';
/** Redact at the service boundary, before any case is serialized into a client component. */
export function projectJoinerPage(c:Case,config:Config,actor:Actor):Case {
 const sections=actor.sections;if(actor.module||!sections)return c;
 const result=structuredClone(c);
 if(!actor.hr){for(const key of ['ic','passport','costCentre','finalConfirmationDate','confirmationDate','probationEndDate','provisionalEndOn'] as const){delete result.source[key];delete result.local[key];}}
 const factKeys:Record<string,keyof Facts>={name:'fullName',empNo:'employeeId',joinInput:'joinDate',position:'title',dept:'department',company:'company',group:'businessGroup',supervisor:'supervisor',ta:'gbsTa',email:'email',costCentre:'costCentre',icNo:'ic',passportNo:'passport'};
 for(const field of config.v9CaseFields??[]){if(field.hrOnly&&!actor.hr){const key=factKeys[field.key];if(key){delete result.source[key];delete result.local[key];}if(result.caseValues)delete result.caseValues[field.key];if(field.key==='email')delete result.caseContactEmail;const scalar={hireType:'hiring',replacing:'replacedEmployee',floor:'floor',notes:'notes'} as const;if(field.key in scalar)(result as unknown as Record<string,unknown>)[scalar[field.key as keyof typeof scalar]]='';}}
 if(sections.case==='hidden'){
  const identity=(facts:Partial<Facts>)=>Object.fromEntries(Object.entries(facts).filter(([key])=>['fullName','employeeId','joinDate','businessGroup','company','title'].includes(key)));
  result.source=identity(result.source);result.local=identity(result.local);delete result.caseValues;delete result.caseContactEmail;result.hiring='';result.replacedEmployee='';result.floor='';result.deviceType='';result.notes='';result.cancelNote='';result.cancelReason=null;
 }
 if(sections.notes==='hidden')result.notes='';
 if(sections.checklist!=='all'){
  result.tasks=sections.checklist==='hidden'?[]:result.tasks.filter(task=>task.assignee===actor.id||inGroup(config,task.group,actor.id));
  if(result.confirmedChecklist)result.confirmedChecklist={...result.confirmedChecklist,tasks:sections.checklist==='hidden'?[]:result.confirmedChecklist.tasks.filter(task=>inGroup(config,task.group,actor.id))};
  result.taskHistory=[];
 }
 if(sections.equip==='hidden'){result.requisitions=[];result.selected=[];result.extras=[];delete result.equipmentOverrides;}
 if(sections.history!=='full'){result.history=sections.history==='hidden'?[]:result.history.filter(entry=>/^(item|requisition|holding|approval)\./.test(entry.action));result.taskHistory=[];result.acknowledgementHistory=[];}
 // Acknowledgements and form answers are served only by their existing private/subject owners.
 result.acknowledgement=null;result.acknowledgementHistory=[];
 return result;
}
