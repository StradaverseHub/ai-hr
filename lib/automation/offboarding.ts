/** Module-owned settings and checks. Existing shared records in other modules never enter these checks. */
import type {Config} from '../lifecycle-v9-model';
import type {DocumentRouting} from '../document-signing-routing';
import type {AutomationRecipient,AutomationReferences,AutomationWorkflow} from './workflow';
import {OFFBOARDING_DECISION_TRIGGERS,OFFBOARDING_LETTER_TRIGGERS,OFFBOARDING_NOTIFY_TRIGGERS,OFFBOARDING_OFFER_TRIGGERS,OFFBOARDING_POSTING_EVENTS,OFFBOARDING_POSTING_FIELDS} from './catalogues/offboarding';

export type OffboardingSettings = {postingApproverGroupId:string|null;reofferMonths:number|null};
export function offboardingSettings(config:Pick<Config,'peopleOpsGroup'|'offboarding'>):OffboardingSettings {
 return {postingApproverGroupId:config.offboarding?.postingApproverGroupId===undefined?config.peopleOpsGroup:config.offboarding.postingApproverGroupId,
  reofferMonths:config.offboarding?.reofferMonths===undefined?12:config.offboarding.reofferMonths};
}
export function offboardingSettingsProblems(settings:OffboardingSettings,groupExists?:(id:string)=>boolean):string[] {
 const problems:string[]=[];
 if(settings.reofferMonths!==null&&(!Number.isInteger(settings.reofferMonths)||settings.reofferMonths<1||settings.reofferMonths>60))problems.push('Enter 1 to 60 months, or leave the retention-offer limit blank.');
 if(settings.postingApproverGroupId!==null&&(!settings.postingApproverGroupId.trim()||groupExists&&!groupExists(settings.postingApproverGroupId)))problems.push('Choose an existing assignment group for Offboarding Personnel postings.');
 return problems;
}
export type OffboardingStepReferences = {
 emailTemplates:readonly {id:string;name?:string;active:boolean;retired:boolean;attachments?:readonly string[]}[];
 letterTemplateIds:readonly string[]|null;
 /** Versions are optional for callers that have not loaded their full template owner. */
 letterTemplates?:readonly {id:string;retired:boolean;routing?:DocumentRouting;published:boolean}[];
 postingApproverGroupId?:string|null;
 references?:AutomationReferences;
 /** All live generator workflows; absence skips the cross-workflow attachment check. */
 generatedLetterIds?:readonly string[];
};
const includes=(values:readonly string[],value:string)=>values.includes(value);
const text=(value:unknown)=>typeof value==='string'?value:'';
/** Optional integers are never coerced: 0, fractional values, NaN and numeric strings are refused. */
export const offboardingDueValueValid=(value:unknown)=>value===undefined||value===null||value===''||typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=60;
export function offboardingReplyProblems(reply:unknown,reminder:unknown):string[] {
 const problems:string[]=[];
 if(!offboardingDueValueValid(reply))problems.push('Employee replies within must be 1 to 60 working days, or left blank.');
 if(!offboardingDueValueValid(reminder))problems.push('Remind before must be 1 to 60 working days, or left blank.');
 const hasReply=reply!==undefined&&reply!==null&&reply!=='',hasReminder=reminder!==undefined&&reminder!==null&&reminder!=='';
 if(hasReminder&&!hasReply)problems.push('Set Employee replies within before adding a reminder.');
 else if(hasReminder&&typeof reply==='number'&&typeof reminder==='number'&&reminder>=reply)problems.push('The reminder must be fewer working days than the reply window.');
 return problems;
}
function nestedRecipients(value:unknown):AutomationRecipient[]|null {
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>20)return null;
 return value.every(r=>r&&typeof r==='object'&&['role','group','routing','person','pending'].includes(r.kind))?value as AutomationRecipient[]:null;
}
function recipientProblems(list:readonly AutomationRecipient[],refs:AutomationReferences|undefined,letter:boolean):string[] {
 const problems:string[]=[];
 for(const recipient of list){
  if(recipient.kind==='pending'&&!letter)problems.push('Whoever’s letter step is pending is available only on letter triggers.');
  if(recipient.kind==='role'&&!['employee','directSuperior'].includes(recipient.role))problems.push('Choose an Offboarding recipient role.');
  if(recipient.kind==='group'&&(!text(recipient.groupId)||refs&&!refs.groupExists(recipient.groupId)))problems.push('A chosen assignment group no longer exists.');
  if(recipient.kind==='routing'&&(!text(recipient.routingId)||refs&&!refs.routingExists(recipient.routingId)))problems.push('A chosen routing no longer exists.');
  if(recipient.kind==='person'&&(!text(recipient.userId)||refs&&!refs.personExists(recipient.userId)))problems.push('A chosen person is unavailable.');
 }
 return problems;
}
/** Extra recipient lists are module params, so their people must join the shared active-user reference check. */
export function offboardingAdditionalRecipients(workflow:AutomationWorkflow):AutomationRecipient[]{
 if(workflow.module!=='off')return [];
 return workflow.steps.flatMap(step=>[...(nestedRecipients(step.params.watch)??[]),...(Array.isArray(step.params.layers)?step.params.layers.flatMap(layer=>layer&&typeof layer==='object'?nestedRecipients(layer.to)??[]:[]):[])]);
}
/** Retention is accepted by one sole final employee Sign step; employee steps cannot precede it. */
export function retentionRoutingProblems(routing:DocumentRouting):string[] {
 const lastOrder=Math.max(0,...routing.map(row=>row.order)),last=routing.filter(row=>row.order===lastOrder);
 return last.length!==1||last[0].action!=='sign'||last[0].who.kind!=='employee'||routing.some(row=>row.order<lastOrder&&row.who.kind==='employee')
  ?['The retention letter routing must end with the employee’s Sign step on its own.']:[];
}
export function offboardingStepParamProblems(workflow:AutomationWorkflow,refs:OffboardingStepReferences):string[] {
 if(workflow.module!=='off')return [];
 const problems:string[]=[],event=workflow.trigger.event,letter=includes(OFFBOARDING_LETTER_TRIGGERS,event),notifyOnly=includes(OFFBOARDING_NOTIFY_TRIGGERS,event);
 for(const [index,step] of workflow.steps.entries()){
  const at=`Step ${index+1}: `,add=(problem:string)=>problems.push(at+problem),p=step.params;
  if(notifyOnly&&step.type!=='notify')add('This trigger only sends notifications.');
  recipientProblems([...step.to,...step.cc],refs.references,letter).forEach(add);
  if(['requestDecision','createPosting'].includes(step.type)&&!offboardingDueValueValid(p.dueDays))add('Due within must be 1 to 60 working days, or left blank.');
  if(step.type==='requestDecision'){
   if(!includes(OFFBOARDING_DECISION_TRIGGERS,event))add('Request resignation decision is only available for submitted, rejected or declined/lapsed offers.');
   if(!step.to.length)add('Choose who records the resignation decision.');
   if(!['both','accept'].includes(text(p.choices)))add('Choose accept only, or accept and retention offer.');
   if(p.canComment!==undefined&&typeof p.canComment!=='boolean')add('Choose whether people kept in the loop can comment.');
   const watch=nestedRecipients(p.watch);if(!watch)add('Choose a valid list of people kept in the loop.');else recipientProblems(watch,refs.references,letter).forEach(add);
  }
  if(step.type==='generateDocument'){
   const id=text(p.letterTemplateId),template=refs.letterTemplates?.find(t=>t.id===id);
   if(!id)add('Choose a document template.');else if(refs.letterTemplateIds&&!refs.letterTemplateIds.includes(id))add('The document template no longer exists.');
   if(template?.retired)add('The document template is retired.');else if(template&&!template.published)add('The document template has no version in use.');
   offboardingReplyProblems(p.replyDays,p.remindDays).forEach(add);
   if(event!=='retention'&&(p.replyDays!==undefined&&p.replyDays!==null&&p.replyDays!==''||p.remindDays!==undefined&&p.remindDays!==null&&p.remindDays!==''))add('Offer reply settings are available only on the retention trigger.');
   if(event==='retention'&&template?.routing)retentionRoutingProblems(template.routing).forEach(add);
  }
  if(step.type==='sendEmail'){
   const id=text(p.emailTemplateId),template=refs.emailTemplates.find(t=>t.id===id);
   if(!id)add('Choose an email template.');else if(!template||template.retired)add('The email template no longer exists.');
   if(!step.to.length)add('Choose who receives the email.');
   for(const attachment of template?.attachments??[])if(refs.generatedLetterIds&&!refs.generatedLetterIds.includes(attachment))add('An attached letter is not generated by a live workflow.');
  }
  if(step.type==='notify'){
   if(!step.to.length)add('Choose who is notified.');
   if(!text(p.subject).trim())add('Write a notification subject.');
  }
  if(step.type==='createPosting'){
   if(!includes(OFFBOARDING_POSTING_EVENTS,text(p.eventType)))add('Choose the Personnel posting event type.');
   if(p.eventType==='Employment Type Change')add('Employment Type Change requires an employment type, which Offboarding posting fields do not allow. Choose another event type.');
   const fields=Array.isArray(p.fields)?p.fields:[];
   if(!Array.isArray(p.fields)||fields.some(f=>typeof f!=='string'||!includes(OFFBOARDING_POSTING_FIELDS,f))||new Set(fields).size!==fields.length)add('Posting fields can only be Position, Job Grade and Basic salary.');
   if(['Transfer','Promotion','Increment','Salary Adjustment'].includes(text(p.eventType))&&!fields.length)add('Choose at least one field to update.');
   if(!['offerEff','lwd','today'].includes(text(p.dateFrom)))add('Choose the posting effective date.');
   if(!includes(OFFBOARDING_OFFER_TRIGGERS,event)&&(fields.length||p.dateFrom==='offerEff'))add('This trigger has no retention offer fields or effective date.');
   if(p.eventType==='Termination')add('Termination is posted automatically after completed clearance. Choose another event type for a resignation workflow.');
   if(refs.postingApproverGroupId!==undefined&&(!refs.postingApproverGroupId||refs.references&&!refs.references.groupExists(refs.postingApproverGroupId)))add('Choose the Personnel postings approver in Offboarding settings.');
   if('approver' in p)add('Offboarding posting approvers are set in Offboarding settings, not on this step.');
  }
  if(step.type==='requestApproval'){
   if(!Array.isArray(p.layers)||!p.layers.length||p.layers.length>30)add('Add between 1 and 30 approval layers.');
   else for(const layer of p.layers){
    if(!layer||typeof layer!=='object'){add('Complete each approval layer.');continue;}
    if(!text(layer.name).trim())add('Name each approval layer.');
    if(!offboardingDueValueValid(layer.dueDays))add('An approval layer’s Due within must be 1 to 60 working days, or left blank.');
    if(!['approve','review'].includes(text(layer.action)))add('Choose Approve or Review for each approval layer.');
    if(!['any','roundRobin'].includes(text(layer.pick)))add('Choose any member or round robin for each approval layer.');
    const to=nestedRecipients(layer.to);if(!to?.length)add('Choose who acts at each approval layer.');else recipientProblems(to,refs.references,letter).forEach(add);
   }
  }
 }
 return [...new Set(problems)];
}
