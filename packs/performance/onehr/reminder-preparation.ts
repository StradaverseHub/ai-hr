/** Pure preparation decisions shared by the web resolver and a fixed native port.
 * The two stages preserve the existing lazy read order: no cooldown/route/epoch
 * read can turn an earlier automatic-disable or no-work refusal into another reason. */
import {fillAssessmentReminderWords,type AssessmentReminderWords,type AssessmentReminderTask} from '../../../lib/assessment-reminder-mail';
export type ReminderPreparationActor={employmentIds:readonly string[];tasks:AssessmentReminderTask[]};
export type ReminderPreparationEpoch={scopeId:string;revision:number};
export type ReminderPreparationRefusal='changed'|'noPendingWork'|'noConsent'|'cooldown';
export function assessmentReminderPreparationStart(mode:string,automaticEnabled:boolean,employmentId:string,actor:ReminderPreparationActor|undefined):'changed'|'noPendingWork'|null{
 if(mode==='automatic'&&!automaticEnabled)return 'changed';
 if(!actor||!actor.employmentIds.includes(employmentId))return 'noPendingWork';
 return null;
}
export function assessmentReminderPreparationRoute(cooling:boolean,mailRoute:string|undefined,employmentId:string):'cooldown'|'noConsent'|null{
 if(cooling)return 'cooldown';
 if(mailRoute!==employmentId)return 'noConsent';
 return null;
}
export function assessmentReminderPreparationCurrent(epochs:readonly ReminderPreparationEpoch[],checked:readonly ReminderPreparationEpoch[],expiresAt:number,now:number){
 return !(checked.length!==epochs.length||checked.some(row=>epochs.find(e=>e.scopeId===row.scopeId)?.revision!==row.revision)||expiresAt<=now);
}
export function assessmentReminderPreparationSkip(outcome:ReminderPreparationRefusal){
 const tasks:AssessmentReminderTask[]=[];return {outcome,tasks,mailWords:null,preparedAt:null,preparedUntil:null};
}
export function assessmentReminderPreparationValue(input:{actor:ReminderPreparationActor;name:string;cycleName:string;cycleId:string;tenantScope:string;epochs:readonly ReminderPreparationEpoch[];expiresAt:number;now:Date;words:AssessmentReminderWords|null}){
 const until=new Date(Math.min(input.now.getTime()+60_000,input.expiresAt));
 return {tasks:input.actor.tasks,mailWords:fillAssessmentReminderWords(input.words,input.name,input.cycleName,input.actor.tasks.length),preparedAt:input.now,preparedUntil:until,
  tenantEpoch:input.epochs.find(e=>e.scopeId===input.tenantScope)?.revision??0,cycleEpoch:input.epochs.find(e=>e.scopeId===input.cycleId)?.revision??0};
}
