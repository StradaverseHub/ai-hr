/** Review R6: the CURRENT caller's facts for the registry-derived chat proposal catalogue
 * (lib/ai/assistant-action-catalogue.ts). Offering only: a fact here can hide a proposal, never authorize
 * one. Every choices read, prepare and confirm still re-checks the caller's real authority, module, pause and
 * subject on its own guarded server path, and confirmation stays a separate digest-bound human command.
 */
import type {SessionContext,Tx} from '../db/client';
import {isAdmin,isGroupAdmin,canManagePayroll,canManagePerfComp} from '../lib/authz-model';
import {agentActionPauseKey,type AgentActionActor,type AgentActionPauseKey,type AgentActionOwnPauseKey} from '../lib/ai/agent-action-registry';
import {ASSISTANT_CHAT_PAUSE_KEYS,ASSISTANT_CHAT_ACTIONS,type AssistantProposalCaller} from '../lib/ai/assistant-action-catalogue';
import {assistantReadableModules} from './assistant-readable-modules';
import {assertAiActionUnpausedTx,assertAgentActionUnpausedTx} from './ai-governance';
import {AiAllowanceError} from '../lib/ai/types';

/** The registry actor classes this session currently holds, from its own roles and grants. A person-bound
 * class needs a linked person; the assigned inbox and tester assignment are still decided per item. */
export function assistantActionActors(ctx:SessionContext):readonly AgentActionActor[]{
 const person=typeof ctx.personId==='string'&&ctx.personId.length>0,user=typeof ctx.userId==='string'&&ctx.userId.length>0;
 const held:Record<AgentActionActor,boolean>={
  lifecycle_staff:false, // No inline proposal: the case-specific native guard owns staff/company admission.
  self:person,performance_decider:user,assigned_approver:person,assigned_tester:user,agent_principal:false,
  // Positive Workforce authority requires a fresh owning-service read; it has no inline hint protocol.
  workforce_maintainer:false,hr_admin:isAdmin(ctx),tenant_admin:isGroupAdmin(ctx),payroll_admin:canManagePayroll(ctx),rewards_admin:canManagePerfComp(ctx),
 };
 return Object.freeze((Object.keys(held) as AgentActionActor[]).filter(actor=>held[actor]));
}

/** Read the caller's facts inside the caller's own transaction. Each pause is read fresh in its own savepoint.
 * A confirmed pause (AiAllowanceError) is a FACT: the key is paused and its actions are not offered. Any other
 * failure means the controls could not be checked right now; that THROWS, so the caller can tell "no longer
 * offered" (stale) from "could not check" (retryable) and still fail closed in both cases. */
export async function assistantProposalCallerTx(tx:Tx,ctx:SessionContext):Promise<AssistantProposalCaller>{
 const pausedKeys:(AgentActionPauseKey|AgentActionOwnPauseKey)[]=[];
 for(const key of ASSISTANT_CHAT_PAUSE_KEYS){
  try{await tx.transaction(async savepoint=>{await assertAiActionUnpausedTx(savepoint,ctx,key);});}
  catch(error){if(error instanceof AiAllowanceError&&error.reason==='paused')pausedKeys.push(key);else throw new ProposalCallerUnavailableError();}
 }
 for(const action of ASSISTANT_CHAT_ACTIONS){
  if(pausedKeys.includes(action.pauseKey))continue;
  try{await tx.transaction(async savepoint=>{await assertAgentActionUnpausedTx(savepoint,action.id);});}
  catch(error){if(error instanceof AiAllowanceError&&error.reason==='paused')pausedKeys.push(agentActionPauseKey(action));else throw new ProposalCallerUnavailableError();}
 }
 return Object.freeze({readableModules:Object.freeze(assistantReadableModules(ctx)),actors:assistantActionActors(ctx),pausedKeys:Object.freeze(pausedKeys)});
}

/** The caller's catalogue facts could not be read just now (not a pause, not a refusal). */
export class ProposalCallerUnavailableError extends Error{constructor(){super('Assistant proposal catalogue could not be checked.');this.name='ProposalCallerUnavailableError';}}
