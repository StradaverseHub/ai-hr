/** Mounted grid source: a single archive-only subset, no employee identity or copied form metadata. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {bulkSaveLabels} from '../admin';
import {lockLeaveDependencyConfigurationTx} from '../leave-dependency-lock';
import {lockLabelCriteriaReadTx} from '../system-labels';
import {PositionArchiveHuman as Human,PositionArchiveReview as Review,PositionArchiveConfirmation as Confirmation,PositionArchiveReceipt as Receipt} from '../../lib/assistant-actions/position-archive-contract';
export class PositionArchiveUnavailable extends Error { constructor(){super('Reopen the position in System Labels to review its current state.');this.name='PositionArchiveUnavailable';} }
export const positionArchiveUnavailable=():never=>{throw new PositionArchiveUnavailable();};
const fail=positionArchiveUnavailable;
const Fields=z.object({title:z.string(),jobFamily:z.string().nullable(),label:z.string().nullable(),description:z.string().nullable(),isGlobal:z.boolean(),companyId:z.guid()}).strict();
const Source=z.object({positionId:z.guid(),companyId:z.guid(),companyName:z.string(),title:z.string(),archived:z.boolean(),inUse:z.boolean(),fields:Fields,revision:z.string(),companyRevision:z.string(),criteria:z.unknown(),epoch:z.string(),authority:z.unknown()}).strict();
export async function lockPositionArchiveSourceTx(tx:Tx,ctx:SessionContext,id:string){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 await lockLabelCriteriaReadTx(tx,ctx.tenantId);
 // Refuse before projecting private catalogue metadata. Same native HR/origin-company gate.
 const [row]=await tx.execute(sql`select p.id from position p where p.id=${id}::uuid and p.tenant_id=${ctx.tenantId}::uuid and app.is_admin() and app.is_admin_for(p.company_id) for update of p`);
 if(!row)return fail();return read(tx,id);
}
async function read(tx:Tx,id:string){const [row]=await tx.execute<{source:unknown}>(sql`select app.position_archive_grid_source(${id}::uuid) as source`);return Source.parse(row?.source);}
async function apply(tx:Tx,ctx:SessionContext,s:z.infer<typeof Source>,archived:boolean,proofRequired=true){
 const result=await bulkSaveLabels(ctx,'position',{creates:[],updates:[{key:s.positionId,id:s.positionId,title:s.fields.title,jobFamily:s.fields.jobFamily??'',label:s.fields.label??'',description:s.fields.description??'',archived}]},tx);
 if(result.created!==0||result.updated!==1||result.createdIds.length!==0)return fail();
 const after=await read(tx,s.positionId);
 if(after.archived!==archived||JSON.stringify(after.fields)!==JSON.stringify(s.fields)||JSON.stringify(after.criteria)!==JSON.stringify(s.criteria)||after.companyRevision!==s.companyRevision)return fail();
 if(!proofRequired)return {after,eventId:null};
 const [proof]=await tx.execute<{eventId:string|null}>(sql`select app.position_archive_grid_current_event(${s.positionId}::uuid,${archived}) as "eventId"`);
 if(!proof?.eventId)return fail();return {after,eventId:proof.eventId};
}
export async function preparePositionArchiveTx(tx:Tx,ctx:SessionContext,value:unknown){
 const content=Human.parse(structuredClone(value)),s=await lockPositionArchiveSourceTx(tx,ctx,content.positionId);
 if(s.archived!==content.expectedArchived||(content.archived&&s.inUse))return fail();
 // Execute the SAME native owner for its normalization/criteria/duplicate rules; keep source locks
 // outside this savepoint. The preview's row, event and epoch changes are all rolled back.
 await tx.execute(sql`savepoint position_archive_native_preview`);
 try{await apply(tx,ctx,s,content.archived,false);}finally{await tx.execute(sql`rollback to savepoint position_archive_native_preview`);await tx.execute(sql`release savepoint position_archive_native_preview`);}
 const review=Review.parse({positionId:s.positionId,companyId:s.companyId,companyName:s.companyName,title:s.title,archived:s.archived,afterArchived:content.archived});
 const reviewedDigest=createHash('sha256').update(JSON.stringify([1,ctx.tenantId,ctx.userId??null,ctx.personId??null,content,s])).digest('hex');
 return {content,review,reviewedDigest};
}
export async function confirmPositionArchiveTx(tx:Tx,ctx:SessionContext,value:unknown,confirmation:unknown,reviewActionId?:string){
 const expected=Confirmation.parse(structuredClone(confirmation)),current=await preparePositionArchiveTx(tx,ctx,value);
 if(current.reviewedDigest!==expected.reviewedDigest)return fail();
 if(reviewActionId)await tx.execute(sql`select app.assistant_catalogue_native_arm(${reviewActionId}::uuid)`);
 const s=await read(tx,current.content.positionId),{after,eventId}=await apply(tx,ctx,s,current.content.archived);
 if(!eventId)return fail();
 return Receipt.parse({kind:'recorded',positionId:after.positionId,companyId:after.companyId,title:after.title,archived:after.archived,eventId,semantics:'native_position_archive_current_record'});
}
export type PositionArchiveIntent=z.infer<typeof Human>;
