/** Current-user AI workspace read model. No shared cache, provider call or background/effect dispatch. */
import { desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { assistantExchange } from '../db/schema';
import { assertAiPrincipalTx } from './ai-principal';
import { mayUseAssistant, type AssistantAccess } from './assistant-grant';
import {MODULE_JOBS} from '../lib/ai/module-jobs';
import {isAdmin} from '../lib/authz-model';
import { resolveEntitlementsTx,isModuleEnabled } from './entitlements';
import { toolsFor } from './assistant-tools';
import { workspaceTasksFor } from '../lib/ai/workspace-tasks';
import { withAssistantReadTx } from './assistant-read-session';
import { agentReviewWorkspaceTx,specialistReviewWorkspaceTx,reopenOwnModulePlanTx,issueOwnModulePlanPermitTx,type OwnModulePlanView } from './module-agent-releases';
import {loadGovernedWorkspaceJobTx} from './workspace-module-jobs';
import {workspaceGroundedAnswers} from './workspace-grounded-answers';

export async function loadAiWorkspace(ctx: SessionContext, options:{includeHistory?:boolean;includeGovernance?:boolean;selectedExchangeId?:string;governedJobId?:string;proposalId?:string}={}) {
  const includeHistory=options.includeHistory!==false,includeGovernance=options.includeGovernance!==false,selectedExchangeId=options.selectedExchangeId,governedJobId=options.governedJobId,proposalId=options.proposalId;
  const captured = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  if (!captured.userId) return { access: { allowed: false, reason: 'no_user' } as AssistantAccess, taskIds: [], history: [],jobModules:[],agentReview:null,specialistReview:null,governedJob:null,proposal:null,planningPermit:null };
  const userId = captured.userId;
  try{return await withTenant(captured, async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await assertAiPrincipalTx(tx, captured);
    const entitlements = await resolveEntitlementsTx(tx, captured.tenantId);
    const fresh = { ...captured, entitlements };
    const access = await mayUseAssistant(fresh, tx);
    if (!access.allowed) return { access, taskIds: [], history: [],jobModules:[],agentReview:null,specialistReview:null,governedJob:null,proposal:null,planningPermit:null };
    let planningPermit:string|null=null;try{planningPermit=await issueOwnModulePlanPermitTx(tx,fresh);}catch{/* Issuance never falls back to a browser nonce. */}
    const governedJob=governedJobId?await loadGovernedWorkspaceJobTx(fresh,tx,governedJobId):null;
    let proposal:OwnModulePlanView|null=null;if(proposalId)try{proposal=await reopenOwnModulePlanTx(tx,fresh,proposalId);}catch{/* Bounded current-owner refusal; no existence oracle. */}
    const taskIds = workspaceTasksFor(toolsFor(fresh).map(tool => tool.spec.name));
    // HR visibility is broader than personal conversation custody. Keep the explicit actual-user
    // predicate even when RLS could let an administrator read other users' exchange rows.
    const rows = includeHistory?await tx.select({
      id: assistantExchange.id, question: assistantExchange.question, answer: assistantExchange.answer,
      stop: assistantExchange.stop, hitTurnCap: assistantExchange.hitTurnCap,
      toolCalls: assistantExchange.toolCalls, askedAt: assistantExchange.askedAt,
      disclosureReceipt: assistantExchange.disclosureReceipt,
    }).from(assistantExchange).where(eq(assistantExchange.appUserId, userId))
      .orderBy(desc(assistantExchange.askedAt), desc(assistantExchange.id)).limit(10):[];
    const history = includeHistory?await withAssistantReadTx(fresh, tx, async session => {
      const replay = workspaceGroundedAnswers(fresh, session,tx);
      const history = [];
      for (const row of rows) {
        const selected=selectedExchangeId===row.id;
        const grounded=selected&&row.answer?await replay({tenantId:captured.tenantId,userId,
          exchangeId:row.id,question:row.question,answer:row.answer},row.disclosureReceipt):null;
        // Raw model text remains audit-only: authentic source provenance never certifies its meaning.
        history.push({id:row.id,question:row.question,answer:null,hasAnswer:Boolean(row.answer),grounded,
          answerVisibility:row.answer?(selected?(grounded?.mode==='grounded'?'current' as const:'unavailable' as const):'not_requested' as const):'none' as const,
          stop:row.stop,hitTurnCap:row.hitTurnCap,askedAt:row.askedAt,
          toolCalls:(grounded?.tools??[]).map(name=>({name}))});
      }
      return history;
    }):[];
    const agentReview=includeGovernance?await agentReviewWorkspaceTx(tx,fresh):null;
    const specialistReview=includeGovernance?await specialistReviewWorkspaceTx(tx,fresh):null;
    const jobModules=MODULE_JOBS.filter(([code])=>isModuleEnabled(fresh,code)&&(code!=='system_explorer'||isAdmin(fresh))).map(([code])=>code);
    return { access, taskIds, history,agentReview,specialistReview,jobModules,governedJob,proposal,planningPermit };
  });}catch{return {access:{allowed:false as const,reason:'unavailable' as const},taskIds:[],history:[],jobModules:[],agentReview:null,specialistReview:null,governedJob:null,proposal:null,planningPermit:null};}
}
