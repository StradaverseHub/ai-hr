import 'server-only';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {getAgentAction} from '../../lib/ai/agent-action-registry';
import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {AssignedLeaveActionChoices} from '../../lib/assistant-actions/module-action-http';
import {REVIEWED_LEAVE_DECISION_ACTION} from '../../lib/assistant-actions/reviewed-leave-decision-contract';
import {pendingLeaveDecisionChoiceMetadataTx} from '../../packs/leave/service';
import {assertAgentActionUnpausedTx} from '../agent-action-pause';
import {assertAiPresentationActionUnpausedTx} from '../ai-governance';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertModuleEnabled,resolveEntitlementsTx} from '../entitlements';
import {lockLeaveReadOnlySourceConfigurationTx} from '../leave-dependency-lock';
import {boundNativeOutcomeTransactionTx} from '../module-native-outcome-bounds';

/** Offer the shortcut from live assigned-work metadata under shared Access and AI control.
 * The chooser and any prepare, confirm, or replay retain their own command authority. */
export function hasAssignedLeaveActionForPresentation(ctx:SessionContext):Promise<boolean>{
 const action=getAgentAction(REVIEWED_LEAVE_DECISION_ACTION);
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);
  await boundNativeOutcomeTransactionTx(tx);
  if(action.prepare.status!=='implemented'||action.confirm.status!=='implemented')throw Error('Assigned leave action unavailable.');
  assertHumanReviewedActionTier(ctx,action.id,'approve');
  await assertAiPrincipalTx(tx,ctx);
  const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  await assertMayUseAssistant(fresh,tx);
  assertModuleEnabled(fresh,action.module);
  assertModuleEnabled(fresh,'leave');
  await assertAiPresentationActionUnpausedTx(tx,fresh,action.pauseKey);
  await assertAgentActionUnpausedTx(tx,action.id);
  await lockLeaveReadOnlySourceConfigurationTx(tx,fresh.tenantId);
  const rows=await pendingLeaveDecisionChoiceMetadataTx(tx,fresh);
  const choices=AssignedLeaveActionChoices.parse({kind:'choices',truncated:rows.truncated,
   tasks:rows.tasks.map(row=>({...row,createdAt:row.createdAt.toISOString()}))});
  return choices.kind==='choices'&&choices.tasks.length>0;
 });
}
