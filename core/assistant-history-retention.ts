/** Raw transcript privacy only. No provider/Assistant grant or HR write authority is required for
 * own retirement. Identity, dates and usage rows survive so privacy cannot replenish allowances.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertAiPrincipalTx} from './ai-principal';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
// Owner-only expiry lives in a db/client-free module (operator runner import boundary); re-exported
// here so existing transcript consumers keep one public surface.
export {ASSISTANT_TRANSCRIPT_RETENTION_DAYS,expiredAssistantHistoryQueueSql,retireExpiredAssistantHistoryTx} from './assistant-history-expiry';
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
 * Strategy markers, evaluation intents and arms are NOT deleted here: the caller's same-Tx shared
 * bridge app.assistant_conversation_metadata_redact owns them AND their audited count.
 */
export async function redactAssistantHistoryForEmploymentTx(tx:Tx,supplied:SessionContext,employmentId:string):Promise<number>{
 const ctx=capture(supplied),id=employmentId;if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))return unavailable();
 await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);
 const[row]=await tx.execute<{retired:number}>(sql`select app.assistant_transcripts_redact(${id}::uuid) as retired`);return count(row?.retired);
}
