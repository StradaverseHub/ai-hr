/** Contract's facts and recipients over the shared engine. Dry runs and real runs use these same resolvers. */
import {conditionFieldsForTrigger} from './automation/catalogue';
import {CONTRACT_AUTOMATION_CATALOGUE} from './automation/catalogues/contracts';
import type {AutomationFactValue} from './automation/conditions';
import type {Routing} from './automation/routing';
import {resolveAutomationRecipients,type AutomationRecipientResolution,type AutomationRecipientContext} from './automation/runtime';
import {resolveRoutingTarget} from './automation/routing';
import {pendingSigningSteps,signingDocumentOwner,signingSendBack,type SigningDocument} from './document-signing-model';
import type {AutomationRecipient} from './automation/workflow';
import type {ContractFlow} from './contract-case-flow';

export type ContractAutomationContext={
 caseId:string;companyId:string;subjectPersonId:string;userPersonIds:Record<string,string>;employeeUserIds:string[];superiorUserIds:string[];
 employeeName:string;employeeCode:string;jobTitle:string;company:string;businessGroup:string;businessGroupId:string|null;
 businessUnitId:string|null;department:string;departmentId:string|null;managerName:string;
 startOn:string;endOn:string;contractNumber:number|null;flow:ContractFlow|null;
 fallbackGroupId:string|null;postingApproverGroupId:string|null;
 groups:{id:string;name:string;members:string[]}[];routings:Routing[];
 activePeople:string[];names:Record<string,string>;pending:{userIds:string[];label:string}|null;
};
const decisionName={renew:'Renew',convert:'Convert to permanent',end:'End'};
/** Send-back belongs to the canonical document owner; there is no pending signer until that owner resends it. */
export function contractAutomationPending(documents:readonly SigningDocument[]):ContractAutomationContext['pending']{
 const pending=documents.flatMap(document=>signingSendBack(document)?[{holderId:signingDocumentOwner(document).userId,label:'Document owner'}]:pendingSigningSteps(document).map(step=>({holderId:step.holderId,label:step.label??step.role})));
 return pending.length?{userIds:[...new Set(pending.flatMap(step=>step.holderId?[step.holderId]:[]))],label:[...new Set(pending.map(step=>step.label))].join(', ')}:null;
}
export function contractAutomationRead(context:ContractAutomationContext,trigger:string,today:string){
 const available=new Set(conditionFieldsForTrigger(CONTRACT_AUTOMATION_CATALOGUE,trigger).map(field=>field.id));
 const decision=context.flow?.decision;
 const days=Math.round((Date.parse((context.flow?.period.endOn??context.endOn)+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);
 const values:Record<string,AutomationFactValue>={
  decision:decision?decisionName[decision.kind]:null,endReason:decision?.endReason??null,
  declineReason:context.flow?.declined?.reason??null,businessGroup:context.businessGroupId,
  payChanges:decision?(decision.payChanges?'Yes':'No'):null,termMonths:decision?.months==null?null:String(decision.months),
  daysToEnd:Number.isFinite(days)?String(days):null,
 };
 return (field:string):AutomationFactValue=>available.has(field)?values[field]??null:undefined;
}
export function contractAutomationRecipients(list:readonly AutomationRecipient[],context:ContractAutomationContext,options:{fallback?:boolean;excludeEmployee?:boolean}={}):AutomationRecipientResolution{
 return resolveAutomationRecipients(list,contractAutomationRecipientContext(context,options));
}
export function contractAutomationRecipientContext(context:ContractAutomationContext,options:{fallback?:boolean;excludeEmployee?:boolean}={}):AutomationRecipientContext{
 const active=new Set(context.activePeople),employees=new Set(context.employeeUserIds);
 const eligible=(ids:readonly string[])=>[...new Set(ids)].filter(id=>active.has(id)&&(!options.excludeEmployee||!employees.has(id)&&!!context.userPersonIds[id]&&context.userPersonIds[id]!==context.subjectPersonId));
 const groups=new Map(context.groups.map(group=>[group.id,eligible(group.members)]));
 const routings=new Map(context.routings.map(routing=>[routing.id,{...routing,rows:routing.rows.map(row=>row.assignTo.kind==='people'?{...row,assignTo:{kind:'people' as const,userIds:eligible(row.assignTo.userIds)}}:row)}]));
 const fallback=options.fallback!==false&&context.fallbackGroupId?{groupId:context.fallbackGroupId,members:groups.get(context.fallbackGroupId)??[]}:null;
 return {
  role:role=>role==='employee'?eligible(context.employeeUserIds):role==='directSuperior'?eligible(context.superiorUserIds):null,
  facts:{businessGroup:[context.businessGroupId,context.businessUnitId].filter((id):id is string=>!!id),company:context.companyId,department:context.departmentId,jobTitle:context.jobTitle},
  groupMembers:id=>groups.get(id)??null,routing:id=>routings.get(id)??null,person:id=>eligible([id]).length>0,
  pending:()=>context.pending?{...context.pending,userIds:eligible(context.pending.userIds)}:null,
  fallback,routingDefaultOnEmpty:true,describe:recipient=>recipient.kind==='role'?(recipient.role==='employee'?'The employee':'Their Direct Superior'):recipient.kind==='routing'?`Routing: ${routings.get(recipient.routingId)?.name??'unavailable'}`:recipient.kind==='group'?`Assignment group: ${context.groups.find(group=>group.id===recipient.groupId)?.name??'unavailable'}`:recipient.kind==='person'?'A named person':'Whoever’s step is pending',
 };
}
/** Approval target retains group identity; candidate filtering and fallback remain the shared recipient resolver's. */
export function contractAutomationApprovalTarget(recipient:AutomationRecipient,context:ContractAutomationContext){
 const refs=contractAutomationRecipientContext(context,{excludeEmployee:true});
 const resolved=resolveAutomationRecipients([recipient],refs);
 const routing=recipient.kind==='routing'?refs.routing(recipient.routingId):null;
 const groupId=resolved.fallbackUsed?refs.fallback?.groupId??null:recipient.kind==='group'?recipient.groupId:routing?resolveRoutingTarget(routing,refs.facts,refs.groupMembers,{defaultOnEmpty:true}).groupId:null;
 return {...resolved,groupId};
}
export function contractAutomationMergeValues(context:ContractAutomationContext,today:string):Record<string,string>{
 const decision=context.flow?.decision;
 const period=context.flow?.period;
 return {
  'employee.name':context.employeeName,'employee.id':context.employeeCode,'employee.jobTitle':context.jobTitle,
  'org.company':context.company,'org.businessGroup':context.businessGroup,'org.department':context.department,
  'people.lineManager':context.managerName,'contract.start':period?.startOn??context.startOn,'contract.end':period?.endOn??context.endOn,
  'contract.number':period?period.number:context.contractNumber==null?'':String(context.contractNumber),
  'contract.newStart':decision?.startOn??'','contract.newEnd':decision?.endOn??'',
  'contract.term':decision?.months==null?'':String(decision.months),'contract.salary':decision?.salaryCents==null?'':formatContractCents(decision.salaryCents),
  'contract.reason':decision?.reason??'','case.link':`/lifecycle/contracts/${context.caseId}`,today,
 };
}
function formatContractCents(cents:string){
 if(!/^\d+$/.test(cents))throw new Error('Invalid agreed salary.');
 const amount=BigInt(cents);return `${amount/BigInt(100)}.${String(amount%BigInt(100)).padStart(2,'0')}`;
}
