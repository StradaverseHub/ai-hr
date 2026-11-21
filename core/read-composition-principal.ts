import type {SessionContext,Tx} from '../db/client';
import {assertAiPrincipalTx,assertAiPresentationPrincipalTx} from './ai-principal';
import {isRepeatableReadOnlyTx} from './read-only-snapshot';

/** Pure data readers only. An enforced presentation snapshot may finish at its admission
 * point. Command carriers retain current authority and the original Access barrier.
 * Never use this proof for provider egress, a mutation, admission or settlement. */
export async function assertReadCompositionPrincipalTx(tx:Tx,ctx:SessionContext){
 if(await isRepeatableReadOnlyTx(tx))return assertAiPresentationPrincipalTx(tx,ctx);
 return assertAiPrincipalTx(tx,ctx);
}
