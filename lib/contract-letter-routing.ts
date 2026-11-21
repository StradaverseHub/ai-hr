import type {ContractAutomationContext} from './contract-automation-context';
import type {AutomationDocumentTemplate} from './automation/document-template';
import type {DocumentRoutingWho} from './document-signing-routing';
import {resolveContractLetterRouting} from './contract-letter-flow';
import {routedStepChooser} from './routed-step-assignment';
import type {SigningRoute} from './document-signing-model';

export function describeContractLetterWho(who:DocumentRoutingWho,context:ContractAutomationContext):string{
 return who.kind==='employee'?'The employee':who.kind==='directSuperior'?'Their Direct Superior':who.kind==='group'?context.groups.find(group=>group.id===who.groupId)?.name??'Assignment group':who.kind==='routing'?context.routings.find(routing=>routing.id===who.routingId)?.name??'Routing':'Named people';
}
/** One resolver for consequence previews and actual generation. Missing employee sign-in stays held. */
export function contractLetterAssignment(template:AutomationDocumentTemplate,context:ContractAutomationContext,input:{today:string;lastAssigned:Record<string,string|null>},chooser?:ReturnType<typeof routedStepChooser>){
 const active=new Set(context.activePeople.filter(id=>!!context.userPersonIds[id])),group=(id:string|null)=>context.groups.find(group=>group.id===id);
 const pick=chooser??routedStepChooser({today:input.today,groups:context.groups.map(group=>({...group,limit:0})),users:context.activePeople.map(id=>({id,load:0,lastAssigned:input.lastAssigned[id]??null,onLeave:false}))});
 const employee=context.employeeUserIds.filter(id=>active.has(id)),superior=context.superiorUserIds.filter(id=>active.has(id));
 const resolved=resolveContractLetterRouting(template.routing,{
  employeeUserId:employee.length===1?employee[0]:null,directSuperiorUserId:superior.length===1?superior[0]:null,
  facts:{businessGroup:[context.businessGroupId,context.businessUnitId].filter((id):id is string=>!!id),company:context.companyId,department:context.departmentId,jobTitle:context.jobTitle},
  routing:id=>{const routing=context.routings.find(routing=>routing.id===id);return routing?{...routing,rows:routing.rows.map(row=>row.assignTo.kind==='people'?{...row,assignTo:{...row.assignTo,userIds:row.assignTo.userIds.filter(id=>active.has(id))}}:row)}:null;},
  groupMembers:id=>group(id)?.members.filter(id=>active.has(id))??null,choose:pick.choose,choiceProblem:pick.problem,
  fallback:context.fallbackGroupId?{groupId:context.fallbackGroupId,members:group(context.fallbackGroupId)?.members.filter(id=>active.has(id))??[]}:null,
  describe:who=>describeContractLetterWho(who,context),
 });
 const route:SigningRoute={...resolved.route,steps:resolved.route.steps.map(step=>({...step,label:describeContractLetterWho(template.routing.find(row=>row.id===step.id)!.who,context),...(step.holderId?{holderPersonId:context.userPersonIds[step.holderId]}:{})}))};
 return {...resolved,route};
}
