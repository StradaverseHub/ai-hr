import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../../db/client';
import {withLifecycleTenant} from '../../../core/module-gate';
import {lockAccessConfigurationReadTx,lockAccessConfigurationWriteTx} from '../../../core/access-configuration-lock';
import {V9Error,type Document} from '../../../lib/lifecycle-v9-model';
import {normalizeCompletionPhone,validatePersonnelCompletionScalar} from '../../../lib/lifecycle-v9-personnel-completion';
const reference=z.object({caseId:z.uuid(),revision:z.number().int().positive(),documentId:z.string().min(1).max(120)});
const submission=reference.extend({values:z.record(z.string().min(1).max(120),z.string().max(20000))}).strict();
export type PersonnelCompletionReference=z.infer<typeof reference>;
export async function updatePersonnelCompletionTx(tx:Tx,input:PersonnelCompletionReference&{values?:Record<string,string>;override?:{fieldId:string;owner:'employee'|'hr';reason:string}},operation:'save'|'submit'|'refresh'|'override'|'adopt'){
 const [row]=await tx.execute<{document:Document|null}>(sql`select app.v9_personnel_completion_read(${input.caseId}::uuid,${input.documentId}) as document`);
 if(!row?.document)throw new V9Error('This completion document is unavailable in your current scope.','forbidden');
 const values={...input.values};
 for(const [id,value] of Object.entries(values)){
  const field=row.document.fields.find(field=>field.id===id);if(!field)throw new V9Error('This field cannot be changed.','forbidden');
  validatePersonnelCompletionScalar(field,value,row.document.personnelCompletion?.country??null);
  if(field.type==='phone')values[id]=normalizeCompletionPhone(value,row.document.personnelCompletion?.country??null);
 }
 const [result]=await tx.execute<{revision:number}>(sql`select app.v9_personnel_completion_update(${input.caseId}::uuid,${input.revision},${input.documentId},${JSON.stringify(values)}::jsonb,${operation},${input.override?JSON.stringify(input.override):null}::jsonb) as revision`);
 return result.revision;
}
export async function v9SubmitOwnDocumentCompletion(ctx:SessionContext,input:z.infer<typeof submission>){
 const parsed=submission.parse(input);
 return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationWriteTx(tx,ctx.tenantId);return updatePersonnelCompletionTx(tx,parsed,'submit');});
}
export async function v9RefreshOwnDocumentCompletion(ctx:SessionContext,input:PersonnelCompletionReference){
 const parsed=reference.strict().parse(input);
 return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationWriteTx(tx,ctx.tenantId);return updatePersonnelCompletionTx(tx,parsed,'refresh');});
}
export async function v9ReadPersonnelCompletion(ctx:SessionContext,input:{caseId:string;documentId:string}){
 const parsed=reference.omit({revision:true}).strict().parse(input);
 return withLifecycleTenant(ctx,async tx=>{await lockAccessConfigurationReadTx(tx,ctx.tenantId);const [row]=await tx.execute<{document:Document|null}>(sql`select app.v9_personnel_completion_read(${parsed.caseId}::uuid,${parsed.documentId}) as document`);return row.document;},{readOnlySnapshot:true});
}
