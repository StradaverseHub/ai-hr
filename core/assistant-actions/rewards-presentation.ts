import type {SQL} from 'drizzle-orm';
import type {z} from 'zod';
import type {SessionContext} from '../../db/client';
import {agentActionById} from '../../lib/ai/agent-action-registry';
import {assertHumanReviewedActionTier} from '../../lib/ai/agent-action-tier-guard';
import {aiCentreActivity} from '../../lib/ai/centre-activity';
import type {REWARDS_CALENDAR_ACTION} from '../../lib/assistant-actions/rewards-calendar-contract';
import type {REWARDS_CANCEL_ACTION} from '../../lib/assistant-actions/rewards-cancel-contract';
import type {REWARDS_RETURN_ACTION} from '../../lib/assistant-actions/rewards-return-contract';
import {currentAgentActionScope} from '../agent-action-pause-scope';
import {assertMayUseAssistant} from '../assistant-grant';
import {withModulePresentationRead} from '../module-presentation-read';

type Action=typeof REWARDS_CALENDAR_ACTION|typeof REWARDS_CANCEL_ACTION|typeof REWARDS_RETURN_ACTION;

/** Offer choices from the current snapshot. Prepare and Confirm recheck their own live authority. */
export async function readRewardsPresentationChoices<T>(ctx:SessionContext,action:Action,query:SQL,schema:z.ZodType<T>,unavailable:()=>never):Promise<T>{
 const declared=agentActionById(action);
 if(ctx.agent||currentAgentActionScope()||aiCentreActivity(ctx.tenantId)||!declared||declared.id!==action||
    declared.module!=='rewards'||declared.pauseKey!=='hr_assistant'||
    declared.policy.tier!=='approve'||declared.policy.category!=='pay'||
    declared.prepare.status!=='implemented'||declared.confirm.status!=='implemented')return unavailable();
 assertHumanReviewedActionTier(ctx,declared.id,'approve');
 return withModulePresentationRead(ctx,declared.module,async(tx,current)=>{
  await assertMayUseAssistant(current,tx);
  const [row]=await tx.execute<{choices:unknown}>(query);
  const value=schema.parse(row?.choices);
  if(Buffer.byteLength(JSON.stringify(value))>49152)return unavailable();
  return value;
 });
}
