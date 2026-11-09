import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assertAiPrincipalTx,assertAiPresentationPrincipalTx} from './ai-principal';

/** Pure data readers only. An enforced presentation snapshot may finish at its admission
 * point. Command carriers retain current authority and the original Access barrier.
 * Never use this proof for provider egress, a mutation, admission or settlement. */
export async function assertReadCompositionPrincipalTx(tx:Tx,ctx:SessionContext){
 const [carrier]=await tx.execute<{snapshot:boolean}>(sql`select current_setting('transaction_isolation')='repeatable read'
  and current_setting('transaction_read_only')='on' as snapshot`);
 if(carrier?.snapshot===true)return assertAiPresentationPrincipalTx(tx,ctx);
 return assertAiPrincipalTx(tx,ctx);
}
