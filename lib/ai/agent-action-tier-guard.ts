import {AGENT_ACTION_TIER_CEILING,AGENT_ACTION_CATEGORY} from './agent-capability-inventory';
import {assertAgentTierPolicy,type AgentTier,type AgentActionPolicy} from './agent-action-tiers';
/** Runtime strings fail closed, including unknown/future actions. No permissions are granted here. */
export function assertAgentActionTier(action:string,requested:AgentTier):void {
 if(!Object.hasOwn(AGENT_ACTION_TIER_CEILING,action)||!Object.hasOwn(AGENT_ACTION_CATEGORY,action))
  throw new Error('Agent action tier unavailable');
 const id=action as keyof typeof AGENT_ACTION_TIER_CEILING;
 assertAgentTierPolicy({category:AGENT_ACTION_CATEGORY[id],tier:AGENT_ACTION_TIER_CEILING[id]} as AgentActionPolicy,requested);
}
/** Human command services cannot be used as an unattended executor, even with a fabricated role. */
export function assertHumanReviewedActionTier(ctx:{userId?:string|null},action:string,tier:'confirm'|'approve'):void {
 assertAgentActionTier(action,ctx.userId?tier:'automatic');
 if(!ctx.userId)throw new Error('Agent action requires human confirmation');
}
