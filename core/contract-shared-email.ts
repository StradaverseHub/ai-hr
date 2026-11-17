/** Contract supplies recipients and words; the shared durable OneHR sender owns delivery. */
import type {SqlExecutor} from '../db/sql-executor';
import type {AutomationEmailTemplate} from '../lib/automation/email';
import {automationEmailBodyDoc,fillAutomationMergeFields} from '../lib/automation/email';
import type {AutomationRecipient} from '../lib/automation/workflow';
import type {AutomationExecutors,AutomationStepContext,AutomationStepOutcome} from '../lib/automation/runtime';
import {contractAutomationRecipients,contractAutomationMergeValues,type ContractAutomationContext} from '../lib/contract-automation-context';
import {queueAutomationEmailTx} from './automation-email-delivery';
import {recordContractSharedFallbackTx} from './contract-shared-fallback';
import {CONTRACT_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/contracts';

export type ContractEmailPreparation={decisionRevision:number;template:AutomationEmailTemplate;reference:{id:string;revision:number};waitingFor:string|null;waitingReason:string|null};
export function contractSharedEmailExecutors(tx:SqlExecutor,input:{context:ContractAutomationContext;today:string;templates:readonly {revision:number;retired:boolean;template:AutomationEmailTemplate}[];letterValues?:Readonly<Record<string,string>>;prepareTemplate:(step:AutomationStepContext,current:{revision:number;retired:boolean;template:AutomationEmailTemplate}|undefined)=>Promise<ContractEmailPreparation|null>}):Pick<AutomationExecutors,'notify'|'sendEmail'>{
 const templates=new Map<string,(typeof input.templates)[number]>();
 for(const item of input.templates)if(!templates.has(item.template.id)||templates.get(item.template.id)!.revision<item.revision)templates.set(item.template.id,item);
 const sourceValues={...contractAutomationMergeValues(input.context,input.today),...input.letterValues,'case.link':'{{case.link}}'};
 const deliver=async(effect:AutomationStepContext,cc:readonly AutomationRecipient[],subject:string,body:string,prepared?:ContractEmailPreparation):Promise<AutomationStepOutcome>=>{
  const {run,step}=effect;
  // A waiting case-open/date email cannot acquire decision fields submitted later on the same case.
  const allowedKeys=new Set(CONTRACT_AUTOMATION_CATALOGUE.mergeFields.filter(field=>!field.triggers||field.triggers.includes(run.trigger)).map(field=>field.key));
  const values=Object.fromEntries(Object.entries(sourceValues).filter(([key])=>allowedKeys.has(key)));
  if(prepared){
   const decisionKeys=CONTRACT_AUTOMATION_CATALOGUE.mergeFields.filter(field=>field.triggers?.includes('decisionSubmitted')).map(field=>field.key);
   if(prepared.decisionRevision===0){for(const key of decisionKeys)delete values[key];}
   else if(input.context.flow?.decision?.revision!==prepared.decisionRevision){
    const decision=input.context.flow?.decisionHistory.find(item=>item.revision===prepared.decisionRevision);
    if(!decision||!input.context.flow)throw Error('The email’s accepted decision snapshot is unavailable.');
    const original=contractAutomationMergeValues({...input.context,flow:{...input.context.flow,decision}},input.today);
    for(const key of decisionKeys)if(allowedKeys.has(key))values[key]=original[key]??'';
   }
  }
  const to=contractAutomationRecipients(step.to,input.context),copy=contractAutomationRecipients(cc,input.context,{fallback:false});
  if(!to.userIds.length)return {status:'failed',reason:'Nobody could receive this email, and the fallback group has no active members.'};
  if(to.fallbackUsed)await recordContractSharedFallbackTx(tx,effect,to.unresolved.map(({meantFor,reason})=>({meantFor,reason})));
  const queued=await queueAutomationEmailTx(tx,{module:'contract_staff',subjectId:input.context.caseId,key:run.id+':'+step.id,to:to.userIds,cc:copy.userIds.filter(id=>!to.userIds.includes(id)),
   subject:fillAutomationMergeFields(subject,values).replace(/\s+/g,' ').trim()||'Contract update',body:fillAutomationMergeFields(body,values),
   ...(prepared?{richBody:{doc:automationEmailBodyDoc(prepared.template),values,sourceTemplate:prepared.reference}}:{})});
  return {status:'done',message:queued.queued?`Email queued for ${queued.to.length+queued.cc.length} people.`:'No new email was queued; the delivery intent is already recorded or its recipients have no sign-in email.',
   recipients:[...new Set([...to.userIds,...copy.userIds])],unresolved:[...to.unresolved,...copy.unresolved].map(item=>({meantFor:item.meantFor,reason:item.reason})).concat(queued.unreachable.length?[{meantFor:`${queued.unreachable.length} email recipients`,reason:'No reachable HR sign-in identity is recorded. No email was sent to them.'}]:[])};
 };
 return {
  notify:step=>deliver(step,step.step.cc,typeof step.step.params.subject==='string'?step.step.params.subject:'',typeof step.step.params.body==='string'?step.step.params.body:''),
  sendEmail:async step=>{
   const prepared=await input.prepareTemplate(step,templates.get(String(step.step.params.emailTemplateId)));
   if(!prepared)return {status:'skipped',reason:'The email template is unavailable or turned off.'};
   if(prepared.waitingFor)return {status:'wait',documentId:prepared.waitingFor,retryStep:true,message:prepared.waitingReason??'Complete the required documents and files before sending this email.'};
   const {template}=prepared;
   return deliver(step,[...step.step.cc,...template.cc],template.subject,template.body,prepared);
  },
 };
}
