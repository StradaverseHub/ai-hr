/** Contract preflight over the shared evaluators and routing owners. This describes effects; it performs none. */
import {evaluateAutomationConditions} from './automation/conditions';
import {CONTRACT_AUTOMATION_CATALOGUE} from './automation/catalogues/contracts';
import {automationWorkflowProblems,type AutomationWorkflow} from './automation/workflow';
import {automationDocumentMatches,type AutomationDocumentTemplate} from './automation/document-template';
import {contractApprovalLayersSchema,contractStepParamProblems,contractWorkflowWarnings} from './contract-automation';
import {contractAutomationRead,contractAutomationRecipients,type ContractAutomationContext} from './contract-automation-context';
import {contractApprovalAssignments} from './contract-approval-assignment';
import {resolveContractLetterRouting,contractLetterRoutingProblems} from './contract-letter-flow';
import {contractLetterAssignment} from './contract-letter-routing';
import {routedStepChooser} from './routed-step-assignment';
import type {ContractApprovalAssignment} from './contract-approval-flow';
import type {ContractFlowDecision} from './contract-case-flow';
import type {SigningRoute} from './document-signing-model';

export type ContractProposedDecision=Omit<ContractFlowDecision,'submittedBy'|'submittedAt'|'revision'>;
export type ContractPreviewStep={id:string;type:string;label:string;to:string[];cc:string[];layers:{id:string;name:string;who:string;pick:'any'|'roundRobin'}[];letter:{name:string;version:number;steps:{label:string;action:string;who:string;owner:boolean}[]}|null};
export type ContractDecisionPlan={
 blockers:string[];warnings:string[];
 workflowVersions:{workflowId:string;revision:number}[];
 workflows:{id:string;revision:number;name:string;steps:ContractPreviewStep[]}[];
 /** Private execution evidence; the public preview omits these person bindings and frozen routes. */
 approvalAssignments:Record<string,ContractApprovalAssignment[]>;
 letterAssignments:Record<string,{templateId:string;version:number;route:SigningRoute;unresolved:ReturnType<typeof resolveContractLetterRouting>['unresolved']}>;
};
export type ContractPreviewDefinitions={
 workflows:{workflow:AutomationWorkflow;revision:number}[];
 documents:{template:AutomationDocumentTemplate;version:number}[];
 emails:{id:string;name:string;active:boolean;retired:boolean}[];
 lastAssigned:Record<string,string|null>;
};
export const contractStepKey=(workflowId:string,stepId:string)=>workflowId+':'+stepId;

export function buildContractDecisionPlan(input:{context:ContractAutomationContext;decision:ContractProposedDecision;definitions:ContractPreviewDefinitions;today:string}):ContractDecisionPlan{
 const {definitions,today}=input;
 const plan:ContractDecisionPlan={blockers:[],warnings:[],workflowVersions:[],workflows:[],approvalAssignments:{},letterAssignments:{}};
 if(!input.context.flow){plan.blockers.push('Start the current Contract case before previewing a decision.');return plan;}
 const context:ContractAutomationContext={...input.context,flow:{...input.context.flow,decision:{...input.decision,submittedBy:'preview',submittedAt:today+'T00:00:00Z',revision:(input.context.flow.decisionHistory.at(-1)?.revision??0)+1}}};
 const read=contractAutomationRead(context,'decisionSubmitted',today);
 const active=new Set(context.activePeople.filter(id=>!!context.userPersonIds[id]));
 const refs={routingExists:(id:string)=>context.routings.some(r=>r.id===id),groupExists:(id:string)=>context.groups.some(g=>g.id===id),personExists:(id:string)=>active.has(id)};
 // Contract's basic Round robin intentionally excludes the deferred leave/open-task-limit policy. The shared
 // assignment owner still makes the choice and accounts for choices already made in this proposed chain.
 const chooser=routedStepChooser({today,groups:context.groups.map(g=>({...g,limit:0})),users:context.activePeople.map(id=>({id,load:0,lastAssigned:definitions.lastAssigned[id]??null,onLeave:false}))});
 const group=(id:string|null)=>id?context.groups.find(g=>g.id===id):undefined;
 const names=(ids:readonly string[])=>ids.map(id=>context.names[id]??'A linked person');
 if(!group(context.fallbackGroupId))plan.blockers.push('Choose an existing Contract fallback group.');
 if(!group(context.postingApproverGroupId)?.members.some(id=>active.has(id)))plan.blockers.push('Choose a posting approver group with an active member.');
 const matched=definitions.workflows.filter(({workflow})=>workflow.status==='live'&&workflow.trigger.event==='decisionSubmitted'&&evaluateAutomationConditions(workflow.conditions,read).ok);
 if(!matched.length)plan.blockers.push('No live workflow matches this decision. People Ops can set one up in HR Automation.');
 for(const {workflow,revision} of matched){
  plan.workflowVersions.push({workflowId:workflow.id,revision});
  plan.blockers.push(...automationWorkflowProblems(workflow,CONTRACT_AUTOMATION_CATALOGUE,refs).map(p=>workflow.name+': '+p));
  plan.blockers.push(...contractStepParamProblems(workflow,{emailTemplates:definitions.emails,letterTemplateIds:definitions.documents.map(d=>d.template.id)},refs,{skipUnavailableEmails:true}).map(p=>workflow.name+': '+p));
  plan.warnings.push(...contractWorkflowWarnings(workflow));
  const preview={id:workflow.id,revision,name:workflow.name,steps:[] as ContractPreviewStep[]};
  let hasLetter=false;
  plan.workflows.push(preview);
  for(const step of workflow.steps){
   if(!evaluateAutomationConditions(step.conditions,read).ok)continue;
   const at=workflow.name+': ',key=contractStepKey(workflow.id,step.id);
   const to=contractAutomationRecipients(step.to,context),cc=contractAutomationRecipients(step.cc,context,{fallback:false});
   const detail:ContractPreviewStep={id:step.id,type:step.type,label:CONTRACT_AUTOMATION_CATALOGUE.stepTypes.find(s=>s.id===step.type)?.label??step.type,to:names(to.userIds),cc:names(cc.userIds),layers:[],letter:null};
   preview.steps.push(detail);
   if(to.fallbackUsed)plan.warnings.push(at+'The fallback group receives a message whose intended recipient is unavailable.');
   if(step.type==='sendEmail'){
    const template=definitions.emails.find(email=>email.id===step.params.emailTemplateId);
    detail.label=template?.name??'Email template unavailable';
    if(!template||!template.active||template.retired)plan.warnings.push(at+detail.label+': this email step will be skipped.');
   }else if(step.type==='requestApproval'){
    const parsed=contractApprovalLayersSchema.safeParse(step.params.layers);
    if(!parsed.success)continue; // The shared parameter validator has already reported the blocking problem.
    const assignments=contractApprovalAssignments({layers:parsed.data,context,today,lastAssigned:definitions.lastAssigned},chooser);
    for(const assignment of assignments){
     const {layer,selectedUserId:selected}=assignment;
     if(!assignment.candidateUserIds.length||layer.pick==='roundRobin'&&!selected)plan.blockers.push(at+layer.name+': no eligible approver or fallback member is available.');
     if(assignment.fallbackUsed)plan.warnings.push(at+layer.name+': the fallback group takes this approval layer.');
     detail.layers.push({id:layer.id,name:layer.name,pick:layer.pick,who:selected?names([selected])[0]:group(assignment.groupId)?.name??names(assignment.candidateUserIds).join(', ')});
    }
    plan.approvalAssignments[key]=assignments;
   }else if(step.type==='generateDocument'){
    const chosen=definitions.documents.find(d=>d.template.id===step.params.letterTemplateId);
    if(!chosen)continue;
    const {template,version}=chosen;
    const facts={businessGroup:context.businessGroupId,company:context.companyId,department:context.departmentId,jobTitle:context.jobTitle,decision:read('decision')};
    if(!automationDocumentMatches(template,field=>{const value=facts[field as keyof typeof facts];return typeof value==='string'?value:null;})){
     plan.blockers.push(at+template.name+' does not match this decision and organisation.');continue;
    }
    plan.blockers.push(...contractLetterRoutingProblems(template.routing,refs).map(p=>at+template.name+': '+p));
    const resolved=contractLetterAssignment(template,context,{today,lastAssigned:definitions.lastAssigned},chooser);
    const route=resolved.route;
    for(const issue of resolved.unresolved){
     if(issue.fallbackGroupId&&issue.holderId)plan.warnings.push(at+template.name+': the fallback group takes '+issue.meantFor+'.');
     else if(route.steps.find(s=>s.id===issue.stepId)?.role==='employee')plan.warnings.push('The employee has no unique active sign-in. Their signature will be held; nobody signs for them.');
     else plan.blockers.push(at+template.name+': '+issue.reason);
    }
    plan.letterAssignments[key]={templateId:template.id,version,route,unresolved:resolved.unresolved};
    hasLetter=true;
    detail.letter={name:template.name,version,steps:route.steps.map(s=>({label:s.label??s.role,action:s.kind,who:s.holderId?names([s.holderId])[0]:'Waiting for the employee sign-in',owner:!!s.owner}))};
   }else if(step.type==='createPosting'){
    detail.label=String(step.params.eventType??'Personnel posting');
    if(!hasLetter)plan.blockers.push(at+'Generate and release the outcome letter before creating a Personnel posting.');
    if(!context.flow||!((input.decision.kind==='renew'&&step.params.eventType==='Renewal')||(input.decision.kind==='convert'&&step.params.eventType==='Conversion to permanent')))plan.blockers.push(at+'The Personnel posting does not match this decision.');
   }else if(step.type==='startOffboarding'){
    if(input.decision.kind!=='end')plan.blockers.push(at+'Only an End decision starts Offboarding.');
    if(!hasLetter)plan.blockers.push(at+'Generate and release the ending letter before starting Offboarding.');
   }
  }
 }
 plan.blockers=[...new Set(plan.blockers)];plan.warnings=[...new Set(plan.warnings)];
 return plan;
}
