/** Shared, versioned document template store; generation pins the live version, never a mutable draft. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {automationReferencesTx} from './automation-builder';
import {AutomationError} from './automation-store';
import {AUTOMATION_MODULES,type AutomationModule} from '../lib/automation/catalogue';
import {automationDocumentTemplateSchema,automationDocumentTemplateProblems,automationDocumentTemplateWarnings,type AutomationDocumentTemplate} from '../lib/automation/document-template';
import {pgSqlState} from '../lib/db-error';

export type StoredAutomationDocumentTemplate={template:AutomationDocumentTemplate;revision:number;liveVersion:number|null;retired:boolean;currentVersion?:number};
export function listAutomationDocumentTemplates(ctx:SessionContext,module:AutomationModule):Promise<StoredAutomationDocumentTemplate[]>{
 z.enum(AUTOMATION_MODULES).parse(module);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const rows=await tx.execute<{template:AutomationDocumentTemplate;revision:number;liveVersion:number|null;retired:boolean;currentVersion?:number}>(sql`
   select v.definition as template,h.revision,h.live_version as "liveVersion",h.retired,v.version as "currentVersion" from automation_document_template h
   join lateral (select definition,version from automation_document_template_version where tenant_id=h.tenant_id and template_id=h.id and deleted_at is null order by version desc limit 1) v on true
   where h.tenant_id=app.current_tenant_id() and h.deleted_at is null and h.module=${module} order by lower(h.name),h.id limit 500`);
  return [...rows];
 });
}
export type AutomationDocumentVersion={version:number;template:AutomationDocumentTemplate;savedAt:string;note:string;documents:number;state:'draft'|'published'|'inUse';canDelete:boolean};
export type AutomationDocumentUsage={documents:number;usedByWorkflow:boolean;deleteReason:string|null;versions:AutomationDocumentVersion[]};
export function automationDocumentUsage(ctx:SessionContext,id:string){z.uuid().parse(id);return withScopedLifecycleTenant(ctx,async tx=>(await tx.execute<{usage:AutomationDocumentUsage}>(sql`select app.automation_document_template_usage(${id}::uuid) as usage`))[0].usage);}
/** Preserve the original generic version reader; Contract's richer history has a separate exact-authority metadata API. */
export function automationDocumentVersions(ctx:SessionContext,id:string){
 z.uuid().parse(id);
 return withScopedLifecycleTenant(ctx,async tx=>[...await tx.execute<{version:number;template:AutomationDocumentTemplate;savedAt:string}>(sql`
  select version,definition as template,saved_at::text as "savedAt" from automation_document_template_version
  where tenant_id=app.current_tenant_id() and template_id=${id}::uuid and deleted_at is null order by version desc limit 100`)]);
}
export function actAutomationDocumentTemplate(ctx:SessionContext,input:{id:string;expectedRevision:number;action:'publishVersion'|'deleteVersion'|'deleteTemplate';version?:number}){
 z.uuid().parse(input.id);z.number().int().positive().parse(input.expectedRevision);if(input.version!==undefined)z.number().int().positive().parse(input.version);
 return withScopedLifecycleTenant(ctx,async tx=>{
  if(input.action==='publishVersion'){
   const [row]=await tx.execute<{definition:AutomationDocumentTemplate}>(sql`select definition from automation_document_template_version where tenant_id=app.current_tenant_id() and template_id=${input.id}::uuid and version=${input.version??0} and deleted_at is null`);
   if(!row)throw new AutomationError('not_found','This version is unavailable.');
   const people=row.definition.routing.flatMap(step=>step.who.kind==='people'?step.who.userIds:[]),problems=automationDocumentTemplateProblems(row.definition,await automationReferencesTx(tx,people));
   if(problems.length)throw new AutomationError('invalid','Fix the routing and content before publishing.',problems);
  }
  try{return (await tx.execute<{revision:number}>(sql`select app.automation_document_template_action(${input.id}::uuid,${input.expectedRevision},${input.action},${input.version??null}::integer) as revision`))[0];}
  catch(error){const state=pgSqlState(error);if(state==='40001')throw new AutomationError('conflict','This template changed. Reload before acting.');if(state==='42501')throw new AutomationError('forbidden','This template is unavailable.');if(state==='22023')throw new AutomationError('invalid', 'This action is unavailable while the template or version is in use.');throw error;}
 });
}
export async function saveAutomationDocumentTemplate(ctx:SessionContext,raw:unknown):Promise<{revision:number;warnings:string[]}>{
 const input=z.object({template:automationDocumentTemplateSchema,expectedRevision:z.number().int().min(0),publish:z.boolean(),retired:z.boolean(),note:z.string().max(1000).optional()}).strict().parse(raw);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.automation_can_manage(${input.template.module},'templates') as ok`);
  if(!allowed?.ok)throw new AutomationError('forbidden','Document templates are unavailable.');
  const people=input.template.routing.flatMap(step=>step.who.kind==='people'?step.who.userIds:[]);
  const problems=automationDocumentTemplateProblems(input.template,await automationReferencesTx(tx,people));
  if(input.publish&&problems.length)throw new AutomationError('invalid','Fix the routing and content before publishing.',problems);
  try{
   const [row]=await tx.execute<{revision:number}>(sql`select app.automation_document_template_save_noted(${input.template.id}::uuid,${input.template.module},${JSON.stringify(input.template)}::jsonb,${input.expectedRevision},${input.publish},${input.retired},${input.note??''}) as revision`);
   return {revision:row.revision,warnings:automationDocumentTemplateWarnings(input.template)};
  }catch(error){const state=pgSqlState(error);if(state==='40001')throw new AutomationError('conflict','This template changed. Reload before saving.');if(state==='42501')throw new AutomationError('forbidden','Document templates are unavailable.');throw error;}
 });
}
