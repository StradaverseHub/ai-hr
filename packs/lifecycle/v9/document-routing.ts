import {updatePersonnelCompletionTx} from './personnel-completion';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../../db/client';
import {withLifecycleTenant} from '../../../core/module-gate';
import {lockAccessConfigurationReadTx,lockAccessConfigurationWriteTx} from '../../../core/access-configuration-lock';
import type {Document} from '../../../lib/lifecycle-v9-model';
import {V9Error} from '../../../lib/lifecycle-v9-model';
import type {SigningDocument} from '../../../lib/document-signing-model';
import {recordV9DocumentRouteAction} from '../../../lib/lifecycle-v9-document-routing';
export type V9DocumentSigningWork={caseId:string;caseRevision:number;number:string;state:string;documentId:string;name:string;signing:SigningDocument;document:Document|null};
const reference=z.object({caseId:z.uuid(),caseRevision:z.number().int().positive(),documentId:z.string().min(1).max(120)});
const action=reference.extend({actionId:z.uuid().optional(),stepId:z.string().min(1).max(120),contentRevision:z.number().int().positive(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['signed','returned','reviewed','approved','resent']),comment:z.string().max(4000).optional(),signature:z.object({method:z.enum(['typed','drawn']),value:z.string().min(1).max(500000),consent:z.literal(true)}).strict().optional()}).strict();
export type V9DocumentRouteAction=z.infer<typeof action>;
async function read(tx:Tx,caseId:string,documentId:string){
 const [row]=await tx.execute<{item:V9DocumentSigningWork|null}>(sql`select app.v9_document_route_read(${caseId}::uuid,${documentId}) as item`);
 if(!row?.item)throw new V9Error('This signing document is unavailable in your current scope.','forbidden');return row.item;
}
/** A bounded document-only projection. Assignment to an unrelated case task grants no document access. */
export async function v9DocumentSigningWork(ctx:SessionContext,input:{search?:string;offset?:number;limit?:number}={}){
 return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{page:{items:V9DocumentSigningWork[];total:number}}>(sql`select app.v9_document_signing_work(${String(input.search??'').slice(0,100)},${Math.max(0,Math.floor(input.offset??0))},${Math.max(1,Math.min(50,Math.floor(input.limit??50)))}) as page`);return row?.page??{items:[],total:0};},{readOnlySnapshot:true});
}
export async function v9DocumentSigningWorkspace(ctx:SessionContext,input:{search?:string;offset?:number}={}){
 return withLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [actor]=await tx.execute<{id:string;name:string}>(sql`select u.id,p.full_name as name from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId??null}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if(!actor)throw new V9Error('The verified document participant is unavailable.','forbidden');
  const [row]=await tx.execute<{page:{items:V9DocumentSigningWork[];total:number}}>(sql`select app.v9_document_signing_work(${String(input.search??'').slice(0,100)},${Math.max(0,Math.floor(input.offset??0))},50) as page`);
  return {actor,...(row?.page??{items:[],total:0})};
 },{readOnlySnapshot:true});
}
export async function v9ReadDocumentSigningWork(ctx:SessionContext,caseId:string,documentId:string){
 z.uuid().parse(caseId);return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);return read(tx,caseId,documentId);},{readOnlySnapshot:true});
}
export async function v9DocumentRouteAct(ctx:SessionContext,input:V9DocumentRouteAction){
 const parsed=action.parse(input);if(!ctx.userId)throw new V9Error('Sign in before acting on a document.','forbidden');
 return withLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  const item=await read(tx,parsed.caseId,parsed.documentId);if(!item.document||item.caseRevision!==parsed.caseRevision&&!item.signing.actions.some(a=>a.id===parsed.actionId&&a.actorId===ctx.userId))throw new V9Error('This document changed. Refresh before trying again.','conflict');
  const [actor]=await tx.execute<{id:string;personId:string;name:string}>(sql`select u.id,u.person_id as "personId",p.full_name as name from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)`);
  if(!actor)throw new V9Error('The verified signer is unavailable.','forbidden');
  const next=structuredClone(item.document),receipt=recordV9DocumentRouteAction(next,{id:parsed.actionId??randomUUID(),stepId:parsed.stepId,revision:parsed.contentRevision,hash:parsed.contentHash,action:parsed.action,comment:parsed.comment,signature:parsed.signature},actor,new Date().toISOString());
  await tx.execute(sql`select app.v9_document_route_act(${parsed.caseId}::uuid,${parsed.caseRevision},${parsed.documentId},${JSON.stringify(receipt)}::jsonb)`);
  return read(tx,parsed.caseId,parsed.documentId);
 });
}
export async function v9DocumentRouteEdit(ctx:SessionContext,input:{caseId:string;caseRevision:number;documentId:string;edits?:Record<string,string>;values?:Record<string,string>}){
 const parsed=reference.extend({edits:z.record(z.string().min(1).max(120),z.string().max(20000)).refine(value=>Object.keys(value).length<=500).optional(),values:z.record(z.string().min(1).max(120),z.string().max(20000)).refine(value=>Object.keys(value).length<=500).optional()}).strict().parse(input);
 return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationWriteTx(tx,ctx.tenantId);let revision=parsed.caseRevision;const item=await read(tx,parsed.caseId,parsed.documentId);if(item.document?.personnelCompletion&&parsed.values&&Object.keys(parsed.values).length){revision=await updatePersonnelCompletionTx(tx,{caseId:parsed.caseId,revision,documentId:parsed.documentId,values:parsed.values},'save');if(!parsed.edits||!Object.keys(parsed.edits).length)return read(tx,parsed.caseId,parsed.documentId);parsed.values={};}await tx.execute(sql`select app.v9_document_route_edit(${parsed.caseId}::uuid,${revision},${parsed.documentId},${parsed.edits?JSON.stringify(parsed.edits):null}::jsonb,${JSON.stringify(parsed.values??{})}::jsonb)`);return read(tx,parsed.caseId,parsed.documentId);});
}
