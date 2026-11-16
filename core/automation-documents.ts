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

export type StoredAutomationDocumentTemplate={template:AutomationDocumentTemplate;revision:number;liveVersion:number|null;retired:boolean};
export function listAutomationDocumentTemplates(ctx:SessionContext,module:AutomationModule):Promise<StoredAutomationDocumentTemplate[]>{
 z.enum(AUTOMATION_MODULES).parse(module);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const rows=await tx.execute<{template:AutomationDocumentTemplate;revision:number;liveVersion:number|null;retired:boolean}>(sql`
   select v.definition as template,h.revision,h.live_version as "liveVersion",h.retired from automation_document_template h
   join automation_document_template_version v on v.tenant_id=h.tenant_id and v.template_id=h.id and v.version=h.revision
   where h.tenant_id=app.current_tenant_id() and h.module=${module} order by lower(h.name),h.id limit 500`);
  return [...rows];
 });
}
export function automationDocumentVersions(ctx:SessionContext,id:string){
 z.uuid().parse(id);
 return withScopedLifecycleTenant(ctx,async tx=>[...await tx.execute<{version:number;template:AutomationDocumentTemplate;savedAt:string}>(sql`
  select version,definition as template,saved_at::text as "savedAt" from automation_document_template_version
  where tenant_id=app.current_tenant_id() and template_id=${id}::uuid order by version desc limit 100`)]);
}
export async function saveAutomationDocumentTemplate(ctx:SessionContext,raw:unknown):Promise<{revision:number;warnings:string[]}>{
 const input=z.object({template:automationDocumentTemplateSchema,expectedRevision:z.number().int().min(0),publish:z.boolean(),retired:z.boolean()}).strict().parse(raw);
 return withScopedLifecycleTenant(ctx,async tx=>{
  const [allowed]=await tx.execute<{ok:boolean}>(sql`select app.automation_can_configure(${input.template.module}) as ok`);
  if(!allowed?.ok)throw new AutomationError('forbidden','Document templates are unavailable.');
  const people=input.template.routing.flatMap(step=>step.who.kind==='people'?step.who.userIds:[]);
  const problems=automationDocumentTemplateProblems(input.template,await automationReferencesTx(tx,people));
  if(input.publish&&problems.length)throw new AutomationError('invalid','Fix the routing and content before publishing.',problems);
  try{
   const [row]=await tx.execute<{revision:number}>(sql`select app.automation_document_template_save(${input.template.id}::uuid,${input.template.module},${JSON.stringify(input.template)}::jsonb,${input.expectedRevision},${input.publish},${input.retired}) as revision`);
   return {revision:row.revision,warnings:automationDocumentTemplateWarnings(input.template)};
  }catch(error){const state=pgSqlState(error);if(state==='40001')throw new AutomationError('conflict','This template changed. Reload before saving.');if(state==='42501')throw new AutomationError('forbidden','Document templates are unavailable.');throw error;}
 });
}
