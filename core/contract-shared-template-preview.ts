/** Read-only Contract template previews: templates authority plus the real case-view source, never an inferred actor. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {contractSharedContextTx,type ContractSharedSummary} from './contract-shared-read';
import {contractSharedAutomationContext} from './contract-shared-context';
import {contractAutomationMergeValues} from '../lib/contract-automation-context';
import {todayInKualaLumpur} from '../lib/hr-date';
import {resolveRoutingRow,routingProblems,type Routing} from '../lib/automation/routing';
import type {AutomationGroupWorkspace} from './automation-groups';
import {AutomationError} from './automation-store';
async function allowed(tx:Tx,kind:'templates'|'groups'='templates'){const [row]=await tx.execute<{ok:boolean}>(sql`select app.automation_can_manage('contract_staff',${kind}) as ok`);if(!row?.ok)throw new AutomationError('forbidden','Contract template previews are unavailable.');}
export function contractTemplatePreviewCases(ctx:SessionContext,search=''){
 return withScopedLifecycleTenant(ctx,async tx=>{await allowed(tx);const [row]=await tx.execute<{page:{rows:ContractSharedSummary[]}}>(sql`select app.contract_shared_page(${String(search).slice(0,100)},20,0) as page`);return row.page.rows.slice(0,20).map(c=>({id:c.id,label:[c.employeeName,c.employeeCode,c.caseNumber].filter(Boolean).join(' · ')}));});
}
export function contractTemplatePreviewValues(ctx:SessionContext,caseId:string){
 z.uuid().parse(caseId);return withScopedLifecycleTenant(ctx,async tx=>{await allowed(tx);const view=await contractSharedContextTx(tx,caseId);const context=contractSharedAutomationContext(view,{participants:[],groups:[],people:[],routings:[],fallbackGroupId:null,postingApproverGroupId:null,documents:[]});return contractAutomationMergeValues(context,todayInKualaLumpur());});
}

/** A single explicitly selected case; check shows the matched row only, never an enhanced fallback simulation. */
const routingCheckSchema=z.object({id:z.uuid(),name:z.string().trim().min(1).max(200),rows:z.array(z.object({match:z.object({businessGroup:z.array(z.string().max(200)).max(200).optional(),company:z.array(z.string().max(200)).max(200).optional(),department:z.array(z.string().max(200)).max(200).optional(),jobTitle:z.array(z.string().max(200)).max(200).optional()}).strict(),assignTo:z.discriminatedUnion('kind',[z.object({kind:z.literal('group'),groupId:z.string().max(200)}).strict(),z.object({kind:z.literal('people'),userIds:z.array(z.uuid()).min(1).max(50)}).strict()])}).strict()).max(500)}).strict();
export function contractRoutingCheck(ctx:SessionContext,routing:Routing,caseId:string){
 routing=routingCheckSchema.parse(routing);z.uuid().parse(caseId);if(routingProblems(routing,()=>true).length)throw new AutomationError('invalid','Finish the routing before checking it.');
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [grant]=await tx.execute<{ok:boolean}>(sql`select app.automation_can_manage('contract_staff','groups') as ok`);if(!grant?.ok)throw new AutomationError('forbidden','Routing checks are unavailable.');
  const view=await contractSharedContextTx(tx,caseId),source=view.source;
  const matched=resolveRoutingRow(routing,{businessGroup:[source.businessGroupId??'',source.businessUnitId??'',source.businessGroup],company:[view.companyId,source.company],department:[source.departmentId??'',source.department??''],jobTitle:source.jobTitle??source.designation});
  const [row]=await tx.execute<{data:AutomationGroupWorkspace|null}>(sql`select app.automation_assignment_group_workspace() as data`),data=row?.data;
  if(!data)throw new AutomationError('forbidden','Routing checks are unavailable.');
  const target=matched?.row.assignTo,ids=(target?.kind==='group'?data.groups.find(group=>group.id===target.groupId)?.members??[]:target?.userIds??[]).slice(0,500);
  const active=ids.length?target?.kind==='group'?await tx.execute<{id:string;name:string}>(sql`select permitted.id,''::text as name from app.automation_active_users(${`{${ids.join(',')}}`}::uuid[]) permitted(id)`):await tx.execute<{id:string;name:string}>(sql`select id,name from app.automation_routing_check_names(${`{${ids.join(',')}}`}::uuid[])`):[];
  const names=ids.flatMap(id=>{const person=active.find(person=>person.id===id);return person?[target?.kind==='group'?data.people.find(member=>member.id===id)?.name??'Unavailable member':person.name]:[];});
  return {employee:source.name,row:matched?matched.index+1:null,people:names};
 });
}

export function contractRoutingPreviewCases(ctx:SessionContext,search=''){
 return withScopedLifecycleTenant(ctx,async tx=>{await allowed(tx,'groups');const [row]=await tx.execute<{page:{rows:ContractSharedSummary[]}}>(sql`select app.contract_shared_page(${String(search).slice(0,100)},20,0) as page`);return row.page.rows.slice(0,20).map(c=>({id:c.id,name:c.employeeName,detail:[c.employeeCode,c.caseNumber].filter(Boolean).join(' · ')}));});
}
