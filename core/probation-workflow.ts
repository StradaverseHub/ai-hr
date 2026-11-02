import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assertModuleEnabled} from './entitlements';
import {withProbationTenant,probationAdministrationOptions,ProbationError} from './probation';
import {probationWorkflowIssues,type ProbationWorkflow,type ProbationTemplate} from '../lib/probation-workflow';
export type {ProbationWorkflow,ProbationTemplate};
type Definition<T>={id:string;companyId:string;key:string;version:number;state:'draft'|'published';data:T};
export function listProbationWorkflows(ctx:SessionContext){return withProbationTenant(ctx,tx=>tx.execute<Definition<ProbationWorkflow>>(sql`select id,company_id as "companyId",definition_key as key,version,state,data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and kind='workflow' order by company_id,definition_key,version desc`));}
export async function probationWorkflowWorkspace(ctx:SessionContext){const options=await probationAdministrationOptions(ctx);return{companies:options.companies,workflows:await listProbationWorkflows(ctx)};}
export function saveProbationWorkflow(ctx:SessionContext,input:{companyId:string;workflow:ProbationWorkflow;publish:boolean;expectedVersion:number}){return withProbationTenant(ctx,async tx=>{
 assertModuleEnabled(ctx,'lifecycle',input.companyId);const issues=probationWorkflowIssues(input.workflow);if(input.publish&&issues.length)throw new ProbationError('invalid',issues.join(' '));
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_definition_save(${input.companyId}::uuid,${input.workflow.id},'workflow',${JSON.stringify(input.workflow)}::jsonb,${input.publish},${input.expectedVersion}) as id`);return row.id;
});}
export function previewProbationWorkflow(ctx:SessionContext,input:{companyId:string;workflow:ProbationWorkflow}){return withProbationTenant(ctx,async tx=>{
 assertModuleEnabled(ctx,'lifecycle',input.companyId);const[access]=await tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${input.companyId}::uuid) as ok`);if(!access?.ok)throw new ProbationError('forbidden','Named workflow preparer access required.');
 const rows=await tx.execute<{id:string;employeeName:string;endOn:string;parts:{id:string;type:number;dueOn:string;state:string}[]}>(sql`select c.id,c.data->'facts'->>'employeeName' as "employeeName",c.data->>'endOn' as "endOn",coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'type',p.data->'type','dueOn',p.data->>'dueOn','state',p.data->>'state')) from probation_part p where p.case_id=c.id and p.tenant_id=c.tenant_id),'[]') as parts from probation_case c where c.tenant_id=${ctx.tenantId}::uuid and c.company_id=${input.companyId}::uuid order by c.id limit 101`);
 return{issues:probationWorkflowIssues(input.workflow),examples:rows.slice(0,100),truncated:rows.length>100,sends:false as const};
});}
export function runProbationWorkflow(ctx:SessionContext,input:{caseId:string;partId:string|null;workflowId:string;expectedRevision:number;reason:string}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string|null}>(sql`select app.probation_workflow_run(${input.caseId}::uuid,${input.partId}::uuid,${input.workflowId}::uuid,${input.expectedRevision},${input.reason}) as id`);return row.id;});}
export function probationNotificationRecipientsTx(tx:Tx,ev:{id?:string;aggregateId:string}){if(!ev.id)return Promise.resolve([]);return tx.execute<{id:string}>(sql`select app.probation_notification_recipients(${ev.aggregateId}::uuid,${ev.id}::uuid) as id`).then(rows=>rows.map(r=>r.id));}
