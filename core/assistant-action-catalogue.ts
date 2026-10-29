/** Review R6: the CURRENT caller's facts for the registry-derived chat proposal catalogue
 * (lib/ai/assistant-action-catalogue.ts). Offering only: a fact here can hide a proposal, never authorize
 * one. Every choices read, prepare and confirm still re-checks the caller's real authority, module, pause and
 * subject on its own guarded server path, and confirmation stays a separate digest-bound human command.
 */
import type {SessionContext,Tx} from '../db/client';
import {isAdmin,isGroupAdmin,canManagePayroll,canManagePerfComp} from '../lib/authz-model';
import type {AgentActionActor,AgentActionPauseKey} from '../lib/ai/agent-action-registry';
import {ASSISTANT_CHAT_PAUSE_KEYS,type AssistantProposalCaller} from '../lib/ai/assistant-action-catalogue';
import {assistantReadableModules} from './assistant-readable-modules';
import {assertAiActionUnpausedTx} from './ai-governance';

/** The registry actor classes this session currently holds, from its own roles and grants. A person-bound
 * class needs a linked person; the assigned inbox and tester assignment are still decided per item. */
export function assistantActionActors(ctx:SessionContext):readonly AgentActionActor[]{
 const person=typeof ctx.personId==='string'&&ctx.personId.length>0,user=typeof ctx.userId==='string'&&ctx.userId.length>0;
 const held:Record<AgentActionActor,boolean>={
  self:person,assigned_approver:person,assigned_tester:user,
  hr_admin:isAdmin(ctx),tenant_admin:isGroupAdmin(ctx),payroll_admin:canManagePayroll(ctx),rewards_admin:canManagePerfComp(ctx),
 };
 return Object.freeze((Object.keys(held) as AgentActionActor[]).filter(actor=>held[actor]));
}

/** Read the caller's facts inside the caller's own transaction. Each pause is read fresh in its own savepoint;
 * a pause that cannot be confirmed as unpaused counts as paused (fail closed). */
export async function assistantProposalCallerTx(tx:Tx,ctx:SessionContext):Promise<AssistantProposalCaller>{
 const pausedKeys:AgentActionPauseKey[]=[];
 for(const key of ASSISTANT_CHAT_PAUSE_KEYS){
  try{await tx.transaction(async savepoint=>{await assertAiActionUnpausedTx(savepoint,ctx,key);});}catch{pausedKeys.push(key);}
 }
 return Object.freeze({readableModules:Object.freeze(assistantReadableModules(ctx)),actors:assistantActionActors(ctx),pausedKeys:Object.freeze(pausedKeys)});
}
