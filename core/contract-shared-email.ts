/** Contract supplies recipients and words; the shared durable OneHR sender owns delivery. */
import type {SqlExecutor} from '../db/sql-executor';
import type {AutomationEmailTemplate} from '../lib/automation/email';
import {fillAutomationMergeFields} from '../lib/automation/email';
import type {AutomationRecipient} from '../lib/automation/workflow';
import type {AutomationExecutors,AutomationStepContext,AutomationStepOutcome} from '../lib/automation/runtime';
import {contractAutomationRecipients,contractAutomationMergeValues,type ContractAutomationContext} from '../lib/contract-automation-context';
import {queueAutomationEmailTx} from './automation-email-delivery';

export function contractSharedEmailExecutors(tx:SqlExecutor,input:{context:ContractAutomationContext;today:string;templates:readonly {retired:boolean;template:AutomationEmailTemplate}[];letterValues?:Readonly<Record<string,string>>}):Pick<AutomationExecutors,'notify'|'sendEmail'>{
 const templates=new Map(input.templates.filter(item=>!item.retired).map(item=>[item.template.id,item.template]));
 const values={...contractAutomationMergeValues(input.context,input.today),...input.letterValues,'case.link':'{{case.link}}'};
 const deliver=async({run,step}:AutomationStepContext,cc:readonly AutomationRecipient[],subject:string,body:string,template?:AutomationEmailTemplate):Promise<AutomationStepOutcome>=>{
  const to=contractAutomationRecipients(step.to,input.context),copy=contractAutomationRecipients(cc,input.context,{fallback:false});
  if(!to.userIds.length)return {status:'failed',reason:'Nobody could receive this email, and the fallback group has no active members.'};
  const queued=await queueAutomationEmailTx(tx,{module:'contract_staff',subjectId:input.context.caseId,key:run.id+':'+step.id,to:to.userIds,cc:copy.userIds.filter(id=>!to.userIds.includes(id)),
   subject:fillAutomationMergeFields(subject,values).replace(/\s+/g,' ').trim()||'Contract update',body:fillAutomationMergeFields(body,values),
   ...(template?.bodyDoc?{richBody:{doc:template.bodyDoc,values}}:{})});
  return {status:'done',message:queued.queued?`Email queued for ${queued.to.length+queued.cc.length} people.`:'No new email was queued; the delivery intent is already recorded or its recipients have no sign-in email.',
   recipients:[...new Set([...to.userIds,...copy.userIds])],unresolved:[...to.unresolved,...copy.unresolved].map(item=>({meantFor:item.meantFor,reason:item.reason})).concat(queued.unreachable.length?[{meantFor:`${queued.unreachable.length} email recipients`,reason:'No reachable HR sign-in identity is recorded. No email was sent to them.'}]:[])};
 };
 return {
  notify:step=>deliver(step,step.step.cc,typeof step.step.params.subject==='string'?step.step.params.subject:'',typeof step.step.params.body==='string'?step.step.params.body:''),
  sendEmail:step=>{
   const template=templates.get(String(step.step.params.emailTemplateId));
   if(!template||!template.active)return Promise.resolve({status:'skipped' as const,reason:template?'The email template is turned off.':'The email template is unavailable.'});
   return deliver(step,[...step.step.cc,...template.cc],template.subject,template.body,template);
  },
 };
}
