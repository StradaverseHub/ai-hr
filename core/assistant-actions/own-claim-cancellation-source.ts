/** ADR-0151 wave 1 source adapter: cancel the caller's own pending claim through the native claims
 * service. Own employments only (never the admin course cancelClaim also permits); the native service
 * keeps every cancellation rule, the row lock and the event. Nothing here computes or moves money. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {cancelClaimTx} from '../../packs/claims/service';
import {withAgentActionGuard} from './agent-action-guard';
import {myOwnEmploymentSubjectsTx} from '../read';
import {OwnClaimCancellationHumanContent as Human,OwnClaimCancellationPreparedSource as Prepared,OwnClaimCancellationReview as Review,OwnClaimCancellationSourceReceipt as Receipt,OwnClaimCancellationChoices as Choices} from '../../lib/assistant-actions/own-claim-cancellation-contract';
export class OwnClaimCancellationUnavailable extends Error{constructor(){super('That claim cancellation needs another look. Please reopen your claims.');this.name='OwnClaimCancellationUnavailable';}}
const fail=():never=>{throw new OwnClaimCancellationUnavailable();};
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const digestOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function assertOwnClaimCancellationActorTx(tx:Tx,supplied:SessionContext){if(!supplied.personId)return fail();return withAgentActionGuard(tx,capture(supplied),'claims.cancel');}
type ClaimRow={claimId:string;employmentId:string;companyId:string;claimTypeName:string;incurredOn:string;amount:string;status:string};
async function ownEmploymentIds(tx:Tx,fresh:SessionContext){const subjects=await myOwnEmploymentSubjectsTx(tx,fresh);if(subjects.length>16)return fail();return subjects.map(row=>row.employmentId);}
async function claimRow(tx:Tx,fresh:SessionContext,claimId:string,lock:boolean):Promise<ClaimRow|undefined>{
 const rows=await tx.execute<ClaimRow>(sql`select q.id as "claimId",q.employment_id as "employmentId",e.company_id as "companyId",t.name as "claimTypeName",
  to_char(q.incurred_on,'YYYY-MM-DD') as "incurredOn",to_char(q.amount,'FM999999999990.00') as amount,q.status::text as status
  from public.claim_request q join public.employment e on e.id=q.employment_id and e.tenant_id=q.tenant_id join public.claim_type t on t.id=q.claim_type_id and t.tenant_id=q.tenant_id
  where q.id=${claimId}::uuid and q.tenant_id=${fresh.tenantId}::uuid ${lock?sql`for update of q`:sql``}`);
 return (rows as unknown as ClaimRow[])[0];
}
/** The caller's own pending claims, newest first. Metadata a person needs to recognise each claim only. */
export async function readOwnClaimCancellationChoicesTx(tx:Tx,supplied:SessionContext):Promise<z.infer<typeof Choices>>{
 const fresh=await assertOwnClaimCancellationActorTx(tx,supplied),ids=await ownEmploymentIds(tx,fresh);if(!ids.length)return Choices.parse({kind:'choices',claims:[],truncated:false});
 const rows=await tx.execute<{employmentId:string;claimId:string;claimTypeName:string;incurredOn:string;amount:string}>(sql`select q.employment_id as "employmentId",q.id as "claimId",t.name as "claimTypeName",
  to_char(q.incurred_on,'YYYY-MM-DD') as "incurredOn",to_char(q.amount,'FM999999999990.00') as amount
  from public.claim_request q join public.claim_type t on t.id=q.claim_type_id and t.tenant_id=q.tenant_id
  where q.tenant_id=${fresh.tenantId}::uuid and q.status='pending' and q.employment_id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})
  order by q.created_at desc,q.id desc limit 26`);
 const list=rows as unknown as {employmentId:string;claimId:string;claimTypeName:string;incurredOn:string;amount:string}[];
 return Choices.parse({kind:'choices',claims:list.slice(0,25),truncated:list.length>25});
}
/** Own-subject interval: the claim must belong to one of the caller's own employments. */
export async function withOwnClaimCancellationSubjectTx<T>(tx:Tx,supplied:SessionContext,claimId:string,work:(fresh:SessionContext,own:{claimId:string;employmentId:string;companyId:string})=>Promise<T>):Promise<T>{
 const fresh=await assertOwnClaimCancellationActorTx(tx,supplied),ids=await ownEmploymentIds(tx,fresh),row=await claimRow(tx,fresh,z.guid().parse(claimId),false);
 if(!row||!ids.includes(row.employmentId))return fail();
 return work(fresh,{claimId:row.claimId,employmentId:row.employmentId,companyId:row.companyId});
}
function reviewOf(row:ClaimRow){if(row.status!=='pending')return fail();return Review.parse({employmentId:row.employmentId,claimId:row.claimId,claimTypeName:row.claimTypeName,incurredOn:row.incurredOn,amount:row.amount,status:'pending'});}
export async function prepareOwnClaimCancellationSourceTx(tx:Tx,fresh:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const human=Human.parse(structuredClone(value)),row=await claimRow(tx,fresh,human.claimId,false);if(!row||row.employmentId!==human.employmentId)return fail();
 const review=reviewOf(row);return Prepared.parse({kind:'prepared_source',content:human,review,reviewedDigest:digestOf(review),consequence:'pending_claim_cancelled_no_payment'});
}
/** Re-reads the claim under its row lock, requires the reviewed values to be unchanged, then cancels it
 * through the native service in the caller's transaction. Any refusal must roll back the whole command. */
export async function confirmOwnClaimCancellationSourceTx(tx:Tx,fresh:SessionContext,value:unknown,reviewedDigest:string):Promise<z.infer<typeof Receipt>>{
 const human=Human.parse(structuredClone(value)),row=await claimRow(tx,fresh,human.claimId,true);if(!row||row.employmentId!==human.employmentId)return fail();
 if(digestOf(reviewOf(row))!==reviewedDigest)return fail();
 const done=await cancelClaimTx(tx,fresh,human.claimId,human.employmentId);if(done.employmentId!==human.employmentId)return fail();
 return Receipt.parse({kind:'cancelled',claimId:human.claimId,cancelledEventId:done.eventId,employmentId:human.employmentId,currentStatus:'cancelled'});
}
/** Completed receipt from the canonical event and the claim's current status. Never repeats the cancel. */
export async function reconcileOwnClaimCancellationSourceTx(tx:Tx,fresh:SessionContext,reference:{claimId:string;eventId:string;employmentId:string}):Promise<z.infer<typeof Receipt>>{
 const rows=await tx.execute<{status:string}>(sql`select q.status::text as status from public.claim_request q join public.domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id
  where q.id=${reference.claimId}::uuid and q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${reference.employmentId}::uuid
   and d.id=${reference.eventId}::uuid and d.aggregate_type='claim-request' and d.event_type='claim-request.cancelled' and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid`);
 const row=(rows as unknown as {status:string}[])[0];if(!row)return fail();
 return Receipt.parse({kind:'cancelled',claimId:reference.claimId,cancelledEventId:reference.eventId,employmentId:reference.employmentId,currentStatus:row.status});
}
