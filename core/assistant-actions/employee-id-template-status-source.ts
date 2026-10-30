/** Company template status via the native owner; no counter or format edits. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {setStatus} from '../employee-id-config';
import {EmployeeIdTemplateStatusHuman as Human,EmployeeIdTemplateStatusReview as Review,EmployeeIdTemplateStatusConfirmation as Confirmation,EmployeeIdTemplateStatusReceipt as Receipt} from '../../lib/assistant-actions/employee-id-template-status-contract';
export class EmployeeIdTemplateStatusUnavailable extends Error{constructor(){super('Reopen Employee ID settings to review the current template.');this.name='EmployeeIdTemplateStatusUnavailable';}}
export const employeeIdTemplateStatusUnavailable=():never=>{throw new EmployeeIdTemplateStatusUnavailable();};
const fail=employeeIdTemplateStatusUnavailable;
const Fields=z.object({companyId:z.guid(),templateName:z.string().nullable(),prefix:z.string(),suffix:z.string(),startNumber:z.number().int(),numberLength:z.number().int(),increment:z.number().int(),allowManualOverride:z.boolean(),currentRunningNumber:z.number().int(),createdAt:z.string()}).strict();
const Source=z.object({configId:z.guid(),companyId:z.guid(),companyName:z.string(),status:z.enum(['active','inactive']),fields:Fields,revision:z.string(),companyRevision:z.string(),authority:z.unknown(),activePeers:z.unknown()}).strict();
async function read(tx:Tx,id:string){const [row]=await tx.execute<{source:unknown}>(sql`select app.employee_id_template_status_source(${id}::uuid) as source`);return Source.parse(row?.source);}
export async function lockEmployeeIdTemplateStatusSourceTx(tx:Tx,ctx:SessionContext,id:string){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 // Same mounted page admission and native company write authority, before any template projection.
 const [row]=await tx.execute(sql`select c.id from employee_id_config c where c.id=${id}::uuid and c.tenant_id=${ctx.tenantId}::uuid and c.company_id is not null and app.current_user_id() is not null and app.principal_snapshot_current() and app.is_admin() and app.is_admin_for(c.company_id) for update of c`);
 if(!row)return fail();return read(tx,id);
}
async function apply(tx:Tx,ctx:SessionContext,s:z.infer<typeof Source>,status:'active'|'inactive',proofRequired=true){
 const result=await setStatus(ctx,{id:s.configId,status},tx);if(result.id!==s.configId)return fail();
 const after=await read(tx,s.configId);if(after.status!==status||JSON.stringify(after.fields)!==JSON.stringify(s.fields)||after.companyRevision!==s.companyRevision)return fail();
 if(!proofRequired)return{after,eventId:null};
 const [proof]=await tx.execute<{eventId:string|null}>(sql`select app.employee_id_template_status_current_event(${s.configId}::uuid,${status}) as "eventId"`);if(!proof?.eventId)return fail();return{after,eventId:proof.eventId};
}
export async function prepareEmployeeIdTemplateStatusTx(tx:Tx,ctx:SessionContext,value:unknown){
 const content=Human.parse(structuredClone(value)),s=await lockEmployeeIdTemplateStatusSourceTx(tx,ctx,content.configId);if(s.status!==content.expectedStatus)return fail();
 await tx.execute(sql`savepoint employee_id_template_status_preview`);try{await apply(tx,ctx,s,content.status,false);}finally{await tx.execute(sql`rollback to savepoint employee_id_template_status_preview`);await tx.execute(sql`release savepoint employee_id_template_status_preview`);}
 const review=Review.parse({configId:s.configId,companyId:s.companyId,companyName:s.companyName,templateName:s.fields.templateName,prefix:s.fields.prefix,suffix:s.fields.suffix,status:s.status,afterStatus:content.status});
 return{content,review,reviewedDigest:createHash('sha256').update(JSON.stringify([1,ctx.tenantId,ctx.userId??null,ctx.personId??null,content,s])).digest('hex')};
}
export async function confirmEmployeeIdTemplateStatusTx(tx:Tx,ctx:SessionContext,value:unknown,confirmation:unknown){
 const expected=Confirmation.parse(structuredClone(confirmation)),current=await prepareEmployeeIdTemplateStatusTx(tx,ctx,value);if(current.reviewedDigest!==expected.reviewedDigest)return fail();
 const s=await read(tx,current.content.configId),{after,eventId}=await apply(tx,ctx,s,current.content.status);if(!eventId)return fail();
 return Receipt.parse({kind:'recorded',configId:after.configId,companyId:after.companyId,templateName:after.fields.templateName,prefix:after.fields.prefix,suffix:after.fields.suffix,status:after.status,eventId,semantics:'native_employee_id_template_status_current_record'});
}
