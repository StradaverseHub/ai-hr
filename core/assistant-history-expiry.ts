/** Owner-only raw transcript expiry. Deliberately free of db/client VALUE imports so the operator
 * maintenance runner keeps its no-application-credential import boundary. No user/model/HTTP entry.
 */
import {sql,type SQL} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
export const ASSISTANT_TRANSCRIPT_RETENTION_DAYS=30 as const;
/** Owner queue projects only tenant+deadline metadata; no transcript text enters maintenance DTOs.
 * Uses now() like every other custody queue member, so the runner's oldest-age signal is never negative. */
export function expiredAssistantHistoryQueueSql():SQL{return sql`select tenant_id,asked_at+interval '30 days' as expires_at from public.assistant_exchange where content_retired_at is null and asked_at<=now()-interval '30 days'`;}
const unavailable=():never=>{throw Error('Assistant history retirement unavailable.');};
/** Existing owner runner supplies its own actual Tx/tenant. Explicit reviewed policy required;
 * no role switch, user impersonation or missing-policy default. Whole failed Tx must roll back.
 */
export async function retireExpiredAssistantHistoryTx(tx:Tx,tenantId:string,retentionDays:number,limit=100):Promise<number>{
 const tid=tenantId,days=retentionDays,batch=limit;
 if(typeof tid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(tid)||days!==ASSISTANT_TRANSCRIPT_RETENTION_DAYS||!Number.isSafeInteger(batch)||batch<1||batch>100)return unavailable();
 await boundNativeOutcomeTransactionTx(tx);
 const[row]=await tx.execute<{retired:number}>(sql`select app.assistant_transcripts_retire_expired(${tid}::uuid,${days},${batch}) as retired`);const retired=row?.retired;
 if(typeof retired!=='number'||!Number.isSafeInteger(retired)||retired<0||retired>batch)return unavailable();return retired;
}
