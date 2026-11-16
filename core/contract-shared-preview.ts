/** Real Contract dry runs. These readers never adopt a case, create a run, send mail or save a decision. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {contractSharedContextTx} from './contract-shared-read';
import {AutomationError} from './automation-store';
import {CONTRACT_AUTOMATION_CATALOGUE as catalogue} from '../lib/automation/catalogues/contracts';
import {conditionFieldsForTrigger} from '../lib/automation/catalogue';
import {automationWorkflowProblems,dryRunAutomationWorkflow,type AutomationWorkflow} from '../lib/automation/workflow';
import {contractApprovalLayersSchema,contractStepParamProblems} from '../lib/contract-automation';
import {contractAutomationRead,contractAutomationRecipients,type ContractAutomationContext} from '../lib/contract-automation-context';
import {pendingSigningSteps,type SigningDocument} from '../lib/document-signing-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {Routing} from '../lib/automation/routing';
import {terminationReasonCatalogue} from './termination-reason-catalog';

export type ContractDryRunEvent={decision?:string;endReason?:string;declineReason?:string;payChanges?:string;termMonths?:string};
/** The same active, tenant-owned reasons used by Personnel's termination writer. */
export async function contractTerminationReasons(ctx:SessionContext){
 return (await terminationReasonCatalogue(ctx)).filter(reason=>reason.active).map(reason=>({code:reason.code,label:reason.label,builtIn:reason.builtIn}));
}
type PreviewReferences={participants:{id:string;name:string;role:'employee'|'directSuperior'}[];groups:ContractAutomationContext['groups'];people:{id:string;personId:string;name:string}[];routings:Routing[];fallbackGroupId:string|null;postingApproverGroupId:string|null;documents:SigningDocument[];templates:{emails:{id:string;name:string;active:boolean;retired:boolean}[];documents:{id:string}[]}};
export function dryRunContractWorkflow(ctx:SessionContext,input:{workflow:AutomationWorkflow;caseId:string;event:ContractDryRunEvent}){
 z.uuid().parse(input.caseId);
 if(input.workflow?.module!=='contract_staff'||!Array.isArray(input.workflow.steps)||input.workflow.steps.length>40)throw new AutomationError('invalid','Choose a bounded Contract workflow.');
 const event=z.object({decision:z.enum(['Renew','End','Convert to permanent']).optional(),endReason:z.string().max(200).optional(),declineReason:z.string().max(200).optional(),payChanges:z.enum(['Yes','No']).optional(),termMonths:z.string().regex(/^\d{1,3}$/).optional()}).parse(input.event);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const view=await contractSharedContextTx(tx,input.caseId);
  const [row]=await tx.execute<{refs:PreviewReferences}>(sql`select app.contract_shared_preview_references(${input.caseId}::uuid) as refs`);
  const refs=row.refs,source=view.source,pending=refs.documents.flatMap(document=>pendingSigningSteps(document));
  const context:ContractAutomationContext={
   caseId:view.id,companyId:view.companyId,subjectPersonId:source.personId,userPersonIds:Object.fromEntries(refs.people.map(person=>[person.id,person.personId])),employeeUserIds:refs.participants.filter(p=>p.role==='employee').map(p=>p.id),superiorUserIds:refs.participants.filter(p=>p.role==='directSuperior').map(p=>p.id),
   employeeName:source.name,employeeCode:source.employeeId,jobTitle:source.designation,company:source.company,businessGroup:source.businessGroup,businessGroupId:source.businessGroupId??null,
   businessUnitId:source.businessUnitId,department:source.department,departmentId:source.departmentId,managerName:source.manager,
   startOn:source.startOn,endOn:source.endOn,contractNumber:source.contractNumber,flow:view.flow,
   fallbackGroupId:refs.fallbackGroupId,postingApproverGroupId:refs.postingApproverGroupId,groups:refs.groups,routings:refs.routings,
   activePeople:refs.people.map(person=>person.id),names:Object.fromEntries(refs.people.map(person=>[person.id,person.name])),
   pending:pending.length?{userIds:pending.flatMap(step=>step.holderId?[step.holderId]:[]),label:pending.map(step=>step.label??step.role).join(', ')}:null,
  };
  const known={routingExists:(id:string)=>refs.routings.some(r=>r.id===id),groupExists:(id:string)=>refs.groups.some(g=>g.id===id),personExists:(id:string)=>context.activePeople.includes(id)};
  const problems=[...automationWorkflowProblems(input.workflow,catalogue,known),...contractStepParamProblems(input.workflow,{emailTemplates:refs.templates.emails,letterTemplateIds:refs.templates.documents.map(doc=>doc.id)},known)];
  const available=new Set(conditionFieldsForTrigger(catalogue,input.workflow.trigger.event).map(field=>field.id)),base=contractAutomationRead(context,input.workflow.trigger.event,todayInKualaLumpur());
  const resolve=(recipient:Parameters<typeof contractAutomationRecipients>[0][number])=>{
   const result=contractAutomationRecipients([recipient],context);
   return {names:result.userIds.map(id=>context.names[id]??'Linked recipient'),missing:result.unresolved.length?result.unresolved.map(item=>item.reason).join(' ')+(result.fallbackUsed?' The fallback group receives it.':' The fallback group has no available members.'):null};
  };
  const run=dryRunAutomationWorkflow(input.workflow,catalogue,{
   read:field=>available.has(field)&&Object.hasOwn(event,field)?event[field as keyof ContractDryRunEvent]??null:base(field),
   anchor:anchor=>anchor==='contractEnd'?context.endOn:null,
   skipReason:skip=>skip==='decided'&&!!context.flow?.decision?'a decision has been submitted.':skip==='caseClosed'&&context.flow&&['renewed','converted','offboarding'].includes(context.flow.stage)?'the case is closed.':null,
   resolve,
  });
  for(const [index,step] of input.workflow.steps.entries())if(step.type==='requestApproval'){
   const layers=contractApprovalLayersSchema.safeParse(step.params.layers);
   if(layers.success)for(const layer of layers.data){
    const resolved=contractAutomationRecipients([layer.approver],context,{excludeEmployee:true});
    run.steps[index].to.push(layer.name+': '+resolved.userIds.map(id=>context.names[id]??'Linked approver').join(', '));
    run.steps[index].missing.push(...resolved.unresolved.map(item=>item.reason+(resolved.fallbackUsed?' The fallback group takes this layer.':' No fallback approver is available.')));
   }
  }
  return {employeeName:context.employeeName,run:problems.length?{...run,wouldRun:false,reason:'Fix the workflow before it can run. '+problems.join(' ')}:run};
 });
}
