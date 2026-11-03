import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assertModuleEnabled,isModuleEnabledOrFalse} from './entitlements';
import {withProbationTenant,probationAdministrationOptions,ProbationError} from './probation';
import {probationWorkflowIssues,type ProbationWorkflow,type ProbationWorkflowEvent,type ProbationTemplate} from '../lib/probation-workflow';
export type {ProbationWorkflow,ProbationTemplate};
type Definition<T>={id:string;companyId:string;key:string;version:number;state:'draft'|'published'|'retired';retirementReason:string|null;data:T};
export function listProbationWorkflows(ctx:SessionContext){return withProbationTenant(ctx,tx=>tx.execute<Definition<ProbationWorkflow>>(sql`select id,company_id as "companyId",definition_key as key,version,state,retirement_reason as "retirementReason",data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and kind='workflow' order by company_id,definition_key,version desc`));}
export async function probationWorkflowWorkspace(ctx:SessionContext){const options=await probationAdministrationOptions(ctx);return{companies:options.companies,workflows:await listProbationWorkflows(ctx)};}
export function saveProbationWorkflow(ctx:SessionContext,input:{companyId:string;workflow:ProbationWorkflow;publish:boolean;expectedVersion:number}){return withProbationTenant(ctx,async tx=>{
 assertModuleEnabled(ctx,'lifecycle',input.companyId);const issues=probationWorkflowIssues(input.workflow);if(input.publish&&issues.length)throw new ProbationError('invalid',issues.join(' '));
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_definition_save(${input.companyId}::uuid,${input.workflow.id},'workflow',${JSON.stringify(input.workflow)}::jsonb,${input.publish},${input.expectedVersion}) as id`);return row.id;
});}
export type ProbationWorkflowMessagePreview={id:string;subject:string;body:string;recipients:{role:string;name:string;userId:string}[];caseHref:string};
export type ProbationWorkflowPartPreview={id:string;partId:string;type:number;dueOn:string|null;state:string;ready:boolean;holdReason:string|null;messages:ProbationWorkflowMessagePreview[]};
export type ProbationWorkflowPreview={issues:string[];examples:{id:string;employeeName:string;endOn:string;parts:ProbationWorkflowPartPreview[]}[];truncated:boolean;sends:false};
export function previewProbationWorkflow(ctx:SessionContext,input:{companyId:string;workflow:ProbationWorkflow}):Promise<ProbationWorkflowPreview>{return withProbationTenant(ctx,async tx=>{
 assertModuleEnabled(ctx,'lifecycle',input.companyId);const[row]=await tx.execute<{data:Omit<ProbationWorkflowPreview,'issues'>}>(sql`select app.probation_workflow_preview(${input.companyId}::uuid,${JSON.stringify(input.workflow)}::jsonb) as data`);return{...row.data,issues:probationWorkflowIssues(input.workflow)};
});}
export function runProbationWorkflow(ctx:SessionContext,input:{caseId:string;partId:string|null;workflowId:string;expectedRevision:number;reason:string}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string|null}>(sql`select app.probation_workflow_run(${input.caseId}::uuid,${input.partId}::uuid,${input.workflowId}::uuid,${input.expectedRevision},${input.reason}) as id`);return row.id;});}
export function probationNotificationRecipientsTx(tx:Tx,ev:{id?:string;aggregateId:string}){if(!ev.id)return Promise.resolve([]);return tx.execute<{id:string}>(sql`select app.probation_notification_recipients(${ev.aggregateId}::uuid,${ev.id}::uuid) as id`).then(rows=>rows.map(r=>r.id));}


export type ProbationRequiredWorkflowStatus={companyName:string;canConfigure:boolean;missing:ProbationWorkflowEvent[];summaryReady:boolean};
/** Scoped readiness metadata for setup and the tracker, without exposing message drafts. */
export function probationRequiredWorkflowStatus(ctx:SessionContext,companyId:string):Promise<ProbationRequiredWorkflowStatus|null>{
 if(ctx.entitlementsExempt===undefined&&!isModuleEnabledOrFalse(ctx,'lifecycle',companyId))return Promise.resolve(null);
 return withProbationTenant(ctx,async tx=>{
  const [row]=await tx.execute<{data:ProbationRequiredWorkflowStatus|null}>(sql`select app.probation_required_workflow_status(${companyId}::uuid) as data`);
  return row.data;
 });
}
