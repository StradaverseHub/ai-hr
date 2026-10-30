/** Native source seam only. No Assistant HTTP/registry exposure until catalogue custody is allocated.
 * Single-company positions only: shared/global label consequences require a separate full review. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {archivePositionTx} from './admin';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {lockLabelCriteriaTx} from './system-labels';
import {PositionArchiveHuman as Human,PositionArchiveReview as Review,PositionArchiveConfirmation as Confirmation,PositionArchiveReceipt as Receipt} from '../lib/assistant-actions/position-archive-contract';
export class PositionArchiveUnavailable extends Error { constructor(){super('Reopen the position in System Labels to review its current state.');this.name='PositionArchiveUnavailable';} }
const fail=():never=>{throw new PositionArchiveUnavailable();};
async function source(tx:Tx,ctx:SessionContext,id:string){
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 await lockLabelCriteriaTx(tx,ctx.tenantId);
 // Same native company admin boundary. Do not expose a global or cross-company label as a
 // single-company effect. xmin invalidates even archive/restore ABA or unrelated title edits.
 const [row]=await tx.execute<{positionId:string;companyId:string;title:string;archived:boolean;revision:string}>(sql`
 select p.id as "positionId",p.company_id as "companyId",p.title,p.archived_at is not null as archived,p.xmin::text as revision
 from position p where p.id=${id}::uuid and p.tenant_id=${ctx.tenantId}::uuid
 and app.is_admin() and app.is_admin_for(p.company_id) and not p.is_global
 and not exists(select 1 from label_company_assignment a where a.tenant_id=p.tenant_id
 and a.label_kind='position' and a.label_id=p.id and a.company_id<>p.company_id)
 for update of p`);
 if(!row)return fail();return row;
}
export async function preparePositionArchiveTx(tx:Tx,ctx:SessionContext,value:unknown){
 const content=Human.parse(structuredClone(value)),s=await source(tx,ctx,content.positionId);
 if(s.archived!==content.expectedArchived)return fail();
 const review=Review.parse({positionId:s.positionId,companyId:s.companyId,title:s.title,archived:s.archived,afterArchived:content.archived});
 const reviewedDigest=createHash('sha256').update(JSON.stringify([1,ctx.tenantId,ctx.userId??null,ctx.personId??null,content,s])).digest('hex');
 return {content,review,reviewedDigest};
}
export async function confirmPositionArchiveTx(tx:Tx,ctx:SessionContext,value:unknown,confirmation:unknown){
 const expected=Confirmation.parse(structuredClone(confirmation)),current=await preparePositionArchiveTx(tx,ctx,value);
 if(current.reviewedDigest!==expected.reviewedDigest)return fail();
 const eventId=await archivePositionTx(tx,ctx,{id:current.content.positionId,archived:current.content.archived});
 const after=await source(tx,ctx,current.content.positionId);
 if(after.archived!==current.content.archived)return fail();
 return Receipt.parse({kind:'recorded',positionId:after.positionId,companyId:after.companyId,title:after.title,archived:after.archived,eventId,semantics:'native_position_archive_current_record'});
}
export type PositionArchiveIntent=z.infer<typeof Human>;
