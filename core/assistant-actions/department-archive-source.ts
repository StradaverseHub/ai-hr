/** Mounted grid source: a single archive-only subset, no employee identity or copied form metadata. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {bulkSaveLabels} from '../admin';
import {lockLeaveDependencyConfigurationTx} from '../leave-dependency-lock';
import {lockLabelCriteriaReadTx} from '../system-labels';
import {DepartmentArchiveHuman as Human,DepartmentArchiveReview as Review,DepartmentArchiveConfirmation as Confirmation,DepartmentArchiveReceipt as Receipt} from '../../lib/assistant-actions/department-archive-contract';
export class DepartmentArchiveUnavailable extends Error { constructor(){super('Reopen the department in System Labels to review its current state.');this.name='DepartmentArchiveUnavailable';} }
export const departmentArchiveUnavailable=():never=>{throw new DepartmentArchiveUnavailable();};
const fail=departmentArchiveUnavailable;
const Fields=z.object({name:z.string(),businessUnitId:z.guid().nullable(),headEmploymentId:z.guid().nullable(),parentDepartmentId:z.guid().nullable(),label:z.string().nullable(),description:z.string().nullable(),isGlobal:z.boolean(),companyId:z.guid()}).strict();
const Source=z.object({departmentId:z.guid(),companyId:z.guid(),companyName:z.string(),name:z.string(),archived:z.boolean(),inUse:z.boolean(),fields:Fields,revision:z.string(),companyRevision:z.string(),criteria:z.unknown(),epoch:z.string(),authority:z.unknown(),routing:z.unknown()}).strict();
export async function lockDepartmentArchiveSourceTx(tx:Tx,ctx:SessionContext,id:string){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 await lockLabelCriteriaReadTx(tx,ctx.tenantId);
 // Refuse before projecting private catalogue metadata. Same native HR/origin-company gate.
 const [row]=await tx.execute(sql`select p.id from department p where p.id=${id}::uuid and p.tenant_id=${ctx.tenantId}::uuid and app.is_admin() and app.is_admin_for(p.company_id) for update of p`);
 if(!row)return fail();return read(tx,id);
}
async function read(tx:Tx,id:string){const [row]=await tx.execute<{source:unknown}>(sql`select app.department_archive_grid_source(${id}::uuid) as source`);return Source.parse(row?.source);}
async function apply(tx:Tx,ctx:SessionContext,s:z.infer<typeof Source>,archived:boolean,proofRequired=true){
 const result=await bulkSaveLabels(ctx,'department',{creates:[],updates:[{key:s.departmentId,id:s.departmentId,name:s.fields.name,businessUnitId:s.fields.businessUnitId,headEmploymentId:s.fields.headEmploymentId,label:s.fields.label??'',description:s.fields.description??'',archived}]},tx);
 if(result.created!==0||result.updated!==1||result.createdIds.length!==0)return fail();
 const after=await read(tx,s.departmentId);
 if(after.archived!==archived||JSON.stringify(after.fields)!==JSON.stringify(s.fields)||JSON.stringify(after.criteria)!==JSON.stringify(s.criteria)||after.companyRevision!==s.companyRevision||JSON.stringify(after.routing)!==JSON.stringify(s.routing))return fail();
 if(!proofRequired)return {after,eventId:null};
 const [proof]=await tx.execute<{eventId:string|null}>(sql`select app.department_archive_grid_current_event(${s.departmentId}::uuid,${archived}) as "eventId"`);
 if(!proof?.eventId)return fail();return {after,eventId:proof.eventId};
}
export async function prepareDepartmentArchiveTx(tx:Tx,ctx:SessionContext,value:unknown){
 const content=Human.parse(structuredClone(value)),s=await lockDepartmentArchiveSourceTx(tx,ctx,content.departmentId);
 if(s.archived!==content.expectedArchived||(content.archived&&s.inUse))return fail();
 // Execute the SAME native owner for its normalization/criteria/duplicate rules; keep source locks
 // outside this savepoint. The preview's row, event and epoch changes are all rolled back.
 await tx.execute(sql`savepoint department_archive_native_preview`);
 try{await apply(tx,ctx,s,content.archived,false);}finally{await tx.execute(sql`rollback to savepoint department_archive_native_preview`);await tx.execute(sql`release savepoint department_archive_native_preview`);}
 const review=Review.parse({departmentId:s.departmentId,companyId:s.companyId,companyName:s.companyName,name:s.name,archived:s.archived,afterArchived:content.archived});
 const reviewedDigest=createHash('sha256').update(JSON.stringify([1,ctx.tenantId,ctx.userId??null,ctx.personId??null,content,s])).digest('hex');
 return {content,review,reviewedDigest};
}
export async function confirmDepartmentArchiveTx(tx:Tx,ctx:SessionContext,value:unknown,confirmation:unknown){
 const expected=Confirmation.parse(structuredClone(confirmation)),current=await prepareDepartmentArchiveTx(tx,ctx,value);
 if(current.reviewedDigest!==expected.reviewedDigest)return fail();
 const s=await read(tx,current.content.departmentId),{after,eventId}=await apply(tx,ctx,s,current.content.archived);
 if(!eventId)return fail();
 return Receipt.parse({kind:'recorded',departmentId:after.departmentId,companyId:after.companyId,name:after.name,archived:after.archived,eventId,semantics:'native_department_archive_current_record'});
}
export type DepartmentArchiveIntent=z.infer<typeof Human>;
