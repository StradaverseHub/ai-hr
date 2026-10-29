/** Registry composition is an additional prerequisite, never subject or effect authority. The native
 * source adapter and owning service still check the exact subject and repeat decision rules in the Tx. */
import type {SessionContext,Tx} from '../../db/client';
import {getAgentAction,type AgentActionId} from '../../lib/ai/agent-action-registry';
import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertAgentActionUnpausedTx} from '../agent-action-pause';
export async function withAgentActionGuard(tx:Tx,supplied:SessionContext,actionId:AgentActionId,tier:'confirm'|'approve'='confirm'):Promise<SessionContext>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 const action=getAgentAction(actionId);
 if(action.prepare.status!=='implemented'||action.confirm.status!=='implemented')throw Error('Agent action has no human review adapter');
 assertHumanReviewedActionTier(ctx,actionId,tier);
 await assertAiPrincipalTx(tx,ctx);
 const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
 await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,action.module);await assertAiActionUnpausedTx(tx,fresh,action.pauseKey);await assertAgentActionUnpausedTx(tx,action.id);
 return fresh;
}
