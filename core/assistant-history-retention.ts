/** Raw transcript privacy only. No provider/Assistant grant or HR write authority is required for
 * own retirement. Identity, dates and usage rows survive so privacy cannot replenish allowances.
 */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertAiPrincipalTx} from './ai-principal';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
export const ASSISTANT_TRANSCRIPT_RETENTION_DAYS=30 as const;
/** Owner queue projects only tenant+deadline metadata; no transcript text enters maintenance DTOs. */
export function expiredAssistantHistoryQueueSql():SQL{return sql`select tenant_id,asked_at+interval '30 days' as expires_at from public.assistant_exchange where content_retired_at is null and asked_at<=clock_timestamp()-interval '30 days'`;}
const capture=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const unavailable=():never=>{throw Error('Assistant history retirement unavailable.');};
const count=(value:unknown):number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:unavailable();
export async function eraseOwnAssistantHistory(supplied:SessionContext):Promise<Readonly<{retired:number}>>{
 const ctx=capture(supplied);
 try{return await withTenant(ctx,async tx=>{await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);
  const[row]=await tx.execute<{retired:number}>(sql`select app.assistant_transcripts_erase_own() as retired`);
  return Object.freeze({retired:count(row?.retired)});
 });}catch{return unavailable();}
}
/** Compose AFTER the real review-erasure admission and BEFORE deleting conversation metadata.
 * SQL requires the same canonical person erasure/audit intent. This grants no target authority.
 */
export async function redactAssistantHistoryForEmploymentTx(tx:Tx,supplied:SessionContext,employmentId:string):Promise<number>{
 const ctx=capture(supplied),id=employmentId;if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return unavailable();
 await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);
 const[row]=await tx.execute<{retired:number}>(sql`select app.assistant_transcripts_redact(${id}::uuid) as retired`);return count(row?.retired);
}
/** Existing owner runner supplies its own actual Tx/tenant. Explicit reviewed policy required;
 * no role switch, user impersonation or missing-policy default. Whole failed Tx must roll back.
 */
export async function retireExpiredAssistantHistoryTx(tx:Tx,tenantId:string,retentionDays:number,limit=100):Promise<number>{
 const tid=tenantId,days=retentionDays,batch=limit;
 if(typeof tid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tid)||days!==ASSISTANT_TRANSCRIPT_RETENTION_DAYS||!Number.isSafeInteger(batch)||batch<1||batch>100)return unavailable();
 await boundNativeOutcomeTransactionTx(tx);
 const[row]=await tx.execute<{retired:number}>(sql`select app.assistant_transcripts_retire_expired(${tid}::uuid,${days},${batch}) as retired`);const retired=count(row?.retired);if(retired>batch)return unavailable();return retired;
}
