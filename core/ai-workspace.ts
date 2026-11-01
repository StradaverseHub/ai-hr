/** Current-user AI workspace read model. No shared cache, provider call or background/effect dispatch. */
import { and, isNull, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { assistantExchange } from '../db/schema';
import { assertAiPrincipalTx } from './ai-principal';
import { mayUseAssistant, type AssistantAccess } from './assistant-grant';
import { resolveEntitlementsTx } from './entitlements';
import {assistantReadableModules} from './assistant-readable-modules';
import { toolsFor } from './assistant-tools';
import { workspaceTasksFor } from '../lib/ai/workspace-tasks';
import { withAssistantReadTx } from './assistant-read-session';
import { resolveAiProviderSnapshotTx } from './ai-provider-snapshot';
import { agentReviewWorkspaceTx,specialistReviewWorkspaceTx,reopenOwnModulePlanTx,issueOwnModulePlanPermitTx,type OwnModulePlanView } from './module-agent-releases';
import {loadGovernedWorkspaceJobTx} from './workspace-module-jobs';
import {workspaceGroundedAnswers} from './workspace-grounded-answers';
import {assistantProposalCallerTx} from './assistant-action-catalogue';

export async function loadAiWorkspace(ctx: SessionContext, options:{includeHistory?:boolean;includeGovernance?:boolean;selectedExchangeId?:string;governedJobId?:string;proposalId?:string}={}) {
  const includeHistory=options.includeHistory!==false,includeGovernance=options.includeGovernance!==false,selectedExchangeId=options.selectedExchangeId,governedJobId=options.governedJobId,proposalId=options.proposalId;
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  if (!captured.userId) return { access: { allowed: false, reason: 'no_user' } as AssistantAccess, taskIds: [], history: [],jobModules:[],agentReview:null,specialistReview:null,governedJob:null,proposal:null,planningPermit:null,planningAvailability:'resting' as const };
  const userId = captured.userId;
  try{return await withTenant(captured, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await assertAiPrincipalTx(tx, captured);
    const entitlements = await resolveEntitlementsTx(tx, captured.tenantId);
    const fresh = { ...captured, entitlements };
    const access = await mayUseAssistant(fresh, tx);
    if (!access.allowed) return { access, taskIds: [], history: [],jobModules:[],agentReview:null,specialistReview:null,governedJob:null,proposal:null,planningPermit:null,planningAvailability:'resting' as const };
    // A suggestion needs a configured provider. Without one the planner is not broken, it is not set up:
    // say so calmly and issue no permit for a request that could never be sent. The savepoint keeps a
    // failed provider read from aborting the rest of this read; unknown is never "configured".
    let planningProvider:boolean|null=null;try{planningProvider=await tx.transaction(async savepoint=>(await resolveAiProviderSnapshotTx(savepoint,fresh))!==null);}catch{/* Unknown provider state. */}
    let planningPermit:string|null=null;if(planningProvider!==false)try{planningPermit=await issueOwnModulePlanPermitTx(tx,fresh);}catch{/* Issuance never falls back to a browser nonce. */}
    const planningAvailability=planningPermit?'ready' as const:planningProvider===false?'no_provider' as const:'resting' as const;
    const governedJob=governedJobId?await loadGovernedWorkspaceJobTx(fresh,tx,governedJobId):null;
    let proposal:OwnModulePlanView|null=null;if(proposalId)try{proposal=await reopenOwnModulePlanTx(tx,fresh,proposalId);}catch{/* Bounded current-owner refusal; no existence oracle. */}
    const taskIds = workspaceTasksFor(toolsFor(fresh).map(tool => tool.spec.name));
    // HR visibility is broader than personal conversation custody. Keep the explicit actual-user
    // predicate even when RLS could let an administrator read other users' exchange rows.
    const historyFields={
      id: assistantExchange.id, question: assistantExchange.question, answer: assistantExchange.answer,
      stop: assistantExchange.stop, hitTurnCap: assistantExchange.hitTurnCap,
      toolCalls: assistantExchange.toolCalls, askedAt: assistantExchange.askedAt,
      disclosureReceipt: assistantExchange.disclosureReceipt,
    };
    const rows = includeHistory?await tx.select(historyFields).from(assistantExchange).where(and(eq(assistantExchange.tenantId,captured.tenantId),eq(assistantExchange.appUserId, userId),isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`))
      .orderBy(desc(assistantExchange.askedAt), desc(assistantExchange.id)).limit(10):[];
    // Selecting a retained own exchange is independent of the recent list's page size.
    // A guessed foreign/retired identity returns no row, even under broad administrator RLS.
    if(includeHistory&&typeof selectedExchangeId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(selectedExchangeId)&&!rows.some(row=>row.id===selectedExchangeId)){
      const [selected]=await tx.select(historyFields).from(assistantExchange).where(and(eq(assistantExchange.id,selectedExchangeId),eq(assistantExchange.tenantId,captured.tenantId),eq(assistantExchange.appUserId,userId),isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`)).limit(1);
      if(selected)rows.push(selected);
    }
    // Review R6: a replayed proposal is re-adjudicated against the caller's CURRENT registry-derived
    // catalogue, read in this request; only a selected exchange can replay one. null = could not be checked
    // right now: the card shows a neutral retry, never "out of date" and never a preparable card.
    const proposalCaller=includeHistory&&selectedExchangeId?await assistantProposalCallerTx(tx,fresh).catch(()=>null):null;
    const history = includeHistory?await withAssistantReadTx(fresh, tx, async session => {
      const replay = workspaceGroundedAnswers(fresh, session,tx,proposalCaller);
      const history = [];
      for (const row of rows) {
        const selected=selectedExchangeId===row.id;
        const grounded=selected&&row.answer?await replay({tenantId:captured.tenantId,userId,
          exchangeId:row.id,question:row.question,answer:row.answer},row.disclosureReceipt):null;
        // Raw model text remains audit-only: authentic source provenance never certifies its meaning.
        history.push({id:row.id,question:row.question,answer:null,hasAnswer:Boolean(row.answer),grounded,
          answerVisibility:row.answer?(selected?((grounded?.mode==='grounded'||grounded?.conversation)?'current' as const:'unavailable' as const):'not_requested' as const):'none' as const,
          stop:row.stop,hitTurnCap:row.hitTurnCap,askedAt:row.askedAt,
          toolCalls:(grounded?.tools??[]).map(name=>({name}))});
      }
      return history;
    }):[];
    const agentReview=includeGovernance?await agentReviewWorkspaceTx(tx,fresh):null;
    const specialistReview=includeGovernance?await specialistReviewWorkspaceTx(tx,fresh):null;
    const jobModules=assistantReadableModules(fresh);
    return { access, taskIds, history,agentReview,specialistReview,jobModules,governedJob,proposal,planningPermit,planningAvailability };
  });}catch{return {access:{allowed:false as const,reason:'unavailable' as const},taskIds:[],history:[],jobModules:[],agentReview:null,specialistReview:null,governedJob:null,proposal:null,planningPermit:null,planningAvailability:'resting' as const};}
}

/** AI management › Assistant: the group-administrator reviews (routing and conversation candidates,
 * module specialists, planner evaluation) that used to sit on the employee Assistant page. Same owners and
 * the same gates as before: a current AI principal, Assistant access, then group administration inside
 * each owner. Read-only; never widens who may see or change them. */
export async function loadAiGovernance(ctx: SessionContext) {
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  const none = (access: AssistantAccess | { allowed: false; reason: 'unavailable' }) => ({ access, agentReview: null, specialistReview: null });
  if (!captured.userId) return none({ allowed: false, reason: 'no_user' });
  try{return await withTenant(captured, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await assertAiPrincipalTx(tx, captured);
    const fresh = { ...captured, entitlements: await resolveEntitlementsTx(tx, captured.tenantId) };
    const access = await mayUseAssistant(fresh, tx);
    if (!access.allowed) return none(access);
    return { access, agentReview: await agentReviewWorkspaceTx(tx, fresh), specialistReview: await specialistReviewWorkspaceTx(tx, fresh) };
  });}catch{return none({allowed:false as const,reason:'unavailable' as const});}
}
