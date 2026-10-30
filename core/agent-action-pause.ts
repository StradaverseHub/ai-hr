/** Deterministic action control only. Shared by human reviews and template-only agents;
 * no provider, model admission, spend reservation or usage settlement dependency. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {AiAllowanceError,AiGatewayError} from '../lib/ai/types';
/** Same tenant ai-control lock as the pause writer; hold the transaction through the effect. */
export async function assertAgentActionUnpausedTx(tx:Tx,actionId:string):Promise<void>{
 const [row]=await tx.execute<{unpaused:boolean}>(sql`select app.ai_agent_action_unpaused(${actionId}) as unpaused`);
 if(row?.unpaused===false)throw new AiAllowanceError('paused');
 if(row?.unpaused!==true)throw new AiGatewayError('AI action controls could not be confirmed.');
}
