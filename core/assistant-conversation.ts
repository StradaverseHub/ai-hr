/** Shared Home/AI session conversation. Never accepts an actor, scope or source facts from a client. */
import { and, desc, eq, inArray,isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/client';
import * as schema from '../db/schema';
import { resolveAssistantSession, type AssistantSession } from '../lib/assistant-session';
import { resolveEntitlementsTx } from './entitlements';
import { mayUseAssistantTx } from './assistant-grant';
import { AssistantConversationError, assistantScopeFingerprint, assistantConversationId, assistantCapabilityReply, CONVERSATION_LIMITS, type AssistantCapabilityReply } from '../lib/assistant-conversation-model';
export type ConversationIdentity = AssistantSession & {
    authorityStamp: string;
};
export type ConversationView = {
    id: string;
    revision: number;
    pending: boolean;
    messages: {
        id: string;
        question: string;
        askedAt:string;
        reply: AssistantCapabilityReply;
        helpful: boolean | null;
        failure?:AssistantErrorCode;
        proposalStatus?:'awaiting'|'completed'|'refused'|'expired';
    }[];
};
/** Resolve the actual module/grant owner freshly in the same scoped transaction as the opaque
 * stamp. Report/notification entitlement is deliberately irrelevant to basic conversation. */
export async function conversationAuthorityTx(tx: Tx, session: AssistantSession): Promise<ConversationIdentity> {
    const ctx = { ...session.ctx, entitlements: await resolveEntitlementsTx(tx, session.ctx.tenantId), entitlementsExempt: undefined, entitlementsError: undefined };
    if (!(await mayUseAssistantTx(tx, ctx)).allowed)
        throw new AssistantConversationError('unavailable');
    const [row] = await tx.execute(sql `select app.assistant_authority_stamp(${session.scopeIds}::uuid[]) value`);
    const authorityStamp = assistantScopeFingerprint.parse((row as {
        value?: unknown;
    })?.value);
    return { ...session, ctx, authorityStamp };
}
export async function freshConversationIdentity(): Promise<ConversationIdentity> {
    const session = await resolveAssistantSession();
    return withTenant(session.ctx, tx => conversationAuthorityTx(tx, session));
}
export async function assertSameConversationIdentity(expected: ConversationIdentity): Promise<ConversationIdentity> {
    const current = await freshConversationIdentity();
    if (current.ctx.tenantId !== expected.ctx.tenantId || current.ctx.userId !== expected.ctx.userId || current.ctx.personId !== expected.ctx.personId || current.signInHash !== expected.signInHash || current.authorityStamp !== expected.authorityStamp || JSON.stringify(current.scopeIds) !== JSON.stringify(expected.scopeIds))
        throw new AssistantConversationError('scopeChanged');
    return current;
}
async function invalidateTx(tx: Tx, id: string) {
    await tx.update(schema.assistantConversation).set({ invalidatedAt: sql `now()` }).where(and(eq(schema.assistantConversation.id, id), isNull(schema.assistantConversation.invalidatedAt)));
    await tx.update(schema.assistantConfirmation).set({ status: 'refused' }).where(and(eq(schema.assistantConfirmation.conversationId, id), eq(schema.assistantConfirmation.status, 'awaiting')));
}
export async function readConversationTx(tx: Tx, identity: ConversationIdentity, id: string, lock = false) {
    assistantConversationId.parse(id);
    const query = tx.select().from(schema.assistantConversation).where(and(eq(schema.assistantConversation.id, id), eq(schema.assistantConversation.appUserId, identity.ctx.userId!), eq(schema.assistantConversation.tenantId, identity.ctx.tenantId))).limit(1);
    const [row] = await (lock ? query.for('update') : query);
    if (!row)
        throw new AssistantConversationError('notFound');
    if (row.invalidatedAt || row.expiresAt.getTime() <= Date.now() || row.signInHash !== identity.signInHash || row.authorityStamp !== identity.authorityStamp || JSON.stringify(row.companyIds) !== JSON.stringify(identity.scopeIds)) {
        await invalidateTx(tx, row.id);
        return null;
    }
    return row;
}
async function viewTx(tx: Tx, row: typeof schema.assistantConversation.$inferSelect): Promise<ConversationView> {
    const turns = await tx.select({ id: schema.assistantExchange.id, question: schema.assistantExchange.question, askedAt:schema.assistantExchange.askedAt,answer: schema.assistantExchange.answer,error:schema.assistantExchange.error, helpful: schema.assistantConversationTurn.helpful }).from(schema.assistantConversationTurn)
        .innerJoin(schema.assistantExchange, eq(schema.assistantExchange.id, schema.assistantConversationTurn.exchangeId))
        .where(eq(schema.assistantConversationTurn.conversationId, row.id)).orderBy(desc(schema.assistantConversationTurn.revision)).limit(CONVERSATION_LIMITS.historyTurns);
    const messages: ConversationView['messages'] = [];
    let characters = 0;
    for (const turn of turns) {
        let reply: AssistantCapabilityReply;
        try {
            reply = assistantCapabilityReply.parse(JSON.parse(turn.answer ?? ''));
        }
        catch {
            reply={kind:'unavailable',text:'',evidence:[],links:[],tables:[]};
        }
        characters += turn.question.length + reply.text.length;
        if (messages.length && characters > CONVERSATION_LIMITS.historyChars)
            break;
        messages.push({ id: turn.id, question: turn.question, askedAt:turn.askedAt.toISOString(),reply, helpful: turn.helpful, ...(['not_configured','budget_monthly','budget_daily','invalid_question','provider_error','ai_control'].includes(turn.error??'')?{failure:turn.error as AssistantErrorCode}:{}) });
    }
    const proposalIds=messages.flatMap(message=>message.reply.kind==='awaitingConfirmation'?[message.reply.proposalId]:[]);
    const proposals=proposalIds.length?await tx.select({id:schema.assistantConfirmation.id,status:schema.assistantConfirmation.status,expiresAt:schema.assistantConfirmation.expiresAt}).from(schema.assistantConfirmation).where(and(eq(schema.assistantConfirmation.conversationId,row.id),inArray(schema.assistantConfirmation.id,proposalIds))).limit(CONVERSATION_LIMITS.historyTurns):[];
    for(const message of messages)if(message.reply.kind==='awaitingConfirmation'){const proposal=proposals.find(item=>message.reply.kind==='awaitingConfirmation'&&item.id===message.reply.proposalId);message.proposalStatus=proposal?.status==='completed'?'completed':!proposal||proposal.status!=='awaiting'?'refused':proposal.expiresAt.getTime()<=Date.now()?'expired':'awaiting';}
    return { id: row.id, revision: row.revision, pending: !!row.pendingRequestId, messages: messages.reverse() };
}
export async function startAssistantConversation(): Promise<ConversationView> {
    const session = await resolveAssistantSession();
    return withTenant(session.ctx, async (tx) => {
        const identity = await conversationAuthorityTx(tx, session);
        await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['assistant-session-v1', session.ctx.tenantId, session.ctx.userId, session.signInHash])},0))`);
        const [existing] = await tx.select().from(schema.assistantConversation).where(and(eq(schema.assistantConversation.appUserId, session.ctx.userId!), eq(schema.assistantConversation.signInHash, session.signInHash), isNull(schema.assistantConversation.invalidatedAt))).limit(1).for('update');
        if (existing) {
            const valid = await readConversationTx(tx, identity, existing.id);
            if (valid) {
                if (valid.pendingRequestId && valid.busyUntil && valid.busyUntil.getTime() <= Date.now())
                    await invalidateTx(tx, valid.id);
                else
                    return viewTx(tx, valid);
            }
        }
        const [row] = await tx.insert(schema.assistantConversation).values({ tenantId: session.ctx.tenantId, appUserId: session.ctx.userId!, signInHash: session.signInHash, authorityStamp: identity.authorityStamp, companyIds: identity.scopeIds }).returning();
        return viewTx(tx, row!);
    });
}
/** Deterministic capabilities share the existing audit, never a second transcript or usage ledger. */
export async function recordConversationReplyTx(tx: Tx, identity: ConversationIdentity, question: string, raw: unknown) {
    const reply = assistantCapabilityReply.parse(raw);
    const [exchange] = await tx.insert(schema.assistantExchange).values({ tenantId: identity.ctx.tenantId, appUserId: identity.ctx.userId!, question, interactionKind: 'capability', answer: JSON.stringify(reply), stop: 'end', toolCalls: [], turnCount: 0 }).returning({ id: schema.assistantExchange.id });
    return { exchangeId: exchange!.id, reply };
}
import { assistantConversationTurnInput, assistantProposalConfirmation, assistantConfirmedPayload, type AssistantConversationCopy } from '../lib/assistant-conversation-model';
import { askAssistant, AssistantError, type AssistantErrorCode, type AssistantAnswer } from './assistant';
import { proposeActionsTx, executeActionTx, fixedUpstreamProposalDigest, AgentActionError } from './agent-actions';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { ToolOutcome } from './assistant-tools';
import { ASSISTANT_HANDOFFS, type AssistantHandoff } from '../lib/assistant-conversation-model';
function promptHistory(messages: ConversationView['messages']) { let remaining = CONVERSATION_LIMITS.historyChars; const turns: {
    question: string;
    answer: string;
}[] = []; for (const message of [...messages].reverse()) {
    if (remaining <= message.question.length)
        break;
    const answer = message.reply.text.slice(0, remaining - message.question.length);
    turns.push({ question: message.question, answer });
    remaining -= message.question.length + answer.length;
} return turns.reverse(); }
const plainReply = (kind: 'guide' | 'facts' | 'refused' | 'unavailable' | 'unsupported', text: string): AssistantCapabilityReply => ({ kind, text, evidence: [], links: [], tables: [] });
function modelReply(answer: AssistantAnswer, copy: AssistantConversationCopy, sources: readonly {
    name: string;
    outcome: ToolOutcome;
}[] = []): AssistantCapabilityReply {
    const incomplete = answer.hitTurnCap || answer.stop !== 'end';
    const successful = sources.filter(source => source.outcome.ok);
    const routes = [...new Set(sources.flatMap(source => source.name === 'product_guidance' && source.outcome.ok && typeof source.outcome.route === 'string' && ASSISTANT_HANDOFFS.includes(source.outcome.route as AssistantHandoff) ? [source.outcome.route as AssistantHandoff] : []))];
    return { kind: incomplete ? (answer.stop === 'refusal' ? 'refused' : 'unavailable') : successful.some(source => !['product_guidance', 'search_handbook'].includes(source.name)) ? 'facts' : sources.some(source => !source.outcome.ok) && !successful.length ? 'refused' : 'guide',
        text: (incomplete ? copy.notFinished + '\n\n' : '') + answer.answer.slice(0, CONVERSATION_LIMITS.replyChars - copy.notFinished.length - 2),
        evidence: [...new Set(successful.map(source => source.name))].slice(0, 24).map(tool => ({ kind: tool === 'search_handbook' ? 'knowledge' as const : tool === 'product_guidance' ? 'productGuide' as const : tool==='my_statutory_record'?'statutory' as const:tool.includes('pay') ? 'payroll' as const : tool.includes('leave') || tool.includes('away') ? 'leave' as const : tool.includes('holiday') ? 'attendance' as const : 'personnel' as const, label: copy.evidence[tool] ?? copy.evidence.records, asAt: null, companyId: null, truncated: incomplete || sources.some(source => source.name === tool && source.outcome.ok && source.outcome.truncated === true) })), links: routes.slice(0, 12).map(route => ({ route, label: copy.routes[route] })), tables: [] };
}
/** Claim before calling a provider; a lost response cannot automatically spend again. Completed request
 * IDs replay the existing exchange. An expired in-flight claim invalidates the conversation instead of
 * running an unobserved second question beside the first. */
export async function submitAssistantConversationTurn(raw: unknown, copy: AssistantConversationCopy): Promise<ConversationView> {
    const parsed = assistantConversationTurnInput.safeParse(raw);
    if (!parsed.success)
        throw new AssistantConversationError('invalid');
    const input = parsed.data, identity = await freshConversationIdentity();
    const claim = await withTenant(identity.ctx, async (tx) => {
        const live = await conversationAuthorityTx(tx, identity), row = await readConversationTx(tx, live, input.conversationId, true);
        if (!row)
            return { kind: 'invalid' as const };
        const [existing] = await tx.select().from(schema.assistantConversationTurn).where(and(eq(schema.assistantConversationTurn.conversationId, row.id), eq(schema.assistantConversationTurn.requestId, input.requestId))).limit(1);
        if (existing?.exchangeId)
            return { kind: 'replay' as const, view: await viewTx(tx, row) };
        if (existing || row.pendingRequestId) {
            if (row.busyUntil && row.busyUntil.getTime() <= Date.now()) {
                await invalidateTx(tx, row.id);
                return { kind: 'invalid' as const };
            }
            throw new AssistantConversationError('busy');
        }
        if (row.revision !== input.revision)
            throw new AssistantConversationError('stale');
        const revision = row.revision + 1;
        const [turn] = await tx.insert(schema.assistantConversationTurn).values({ tenantId: live.ctx.tenantId, appUserId: live.ctx.userId!, conversationId: row.id, requestId: input.requestId, revision }).returning({ id: schema.assistantConversationTurn.id });
        await tx.update(schema.assistantConversation).set({ revision, pendingRequestId: input.requestId, busyUntil: sql `now()+interval '2 minutes'` }).where(eq(schema.assistantConversation.id, row.id));
        return { kind: 'claimed' as const, turnId: turn!.id, revision, history: promptHistory((await viewTx(tx, row)).messages) };
    });
    if (claim.kind === 'invalid')
        throw new AssistantConversationError('scopeChanged');
    if (claim.kind === 'replay')
        return claim.view;
    let exchangeId: string | undefined;
    try {
        if (input.intent === 'question') {
            const answer = await askAssistant(identity.ctx, { question: input.question, conversation: { history: claim.history, companyIds: identity.scopeIds,
                    refresh: async () => (await assertSameConversationIdentity(identity)).ctx, beforeReserve:async reservationTx=>{const live=await conversationAuthorityTx(reservationTx,identity),row=await readConversationTx(reservationTx,live,input.conversationId);if(!row||row.pendingRequestId!==input.requestId||row.revision!==claim.revision)throw new AssistantConversationError('scopeChanged');},formatAnswer: (answer, sources) => JSON.stringify(modelReply(answer, copy, sources)) } });
            exchangeId = answer.exchangeId;
        }
        await assertSameConversationIdentity(identity);
        const result = await withTenant(identity.ctx, async (tx) => {
            const live = await conversationAuthorityTx(tx, identity), row = await readConversationTx(tx, live, input.conversationId, true);
            if (!row)
                return null;
            if (row.pendingRequestId !== input.requestId || row.revision !== claim.revision || !row.busyUntil || row.busyUntil.getTime() <= Date.now()) {
                await invalidateTx(tx, row.id);
                return null;
            }
            if (input.intent === 'prepareCloseFixed') {
                let reply: AssistantCapabilityReply;
                try {
                    const proposal = (await proposeActionsTx(tx, live.ctx, { companyIds: live.scopeIds }))[0];
                    if (!proposal)
                        reply = plainReply('facts', copy.noCandidates);
                    else if (proposal.overCap)
                        reply = plainReply('refused', copy.overCap);
                    else {
                        const payload = assistantConfirmedPayload.parse({ typeId: 'close_fixed_upstream', verdictIds: proposal.subjects.map(subject => subject.verdictId) });
                        const [confirmation] = await tx.insert(schema.assistantConfirmation).values({ tenantId: live.ctx.tenantId, appUserId: live.ctx.userId!, conversationId: row.id, authorityStamp: live.authorityStamp, payload, preconditionDigest: fixedUpstreamProposalDigest(proposal.subjects) }).returning({ id: schema.assistantConfirmation.id, revision: schema.assistantConfirmation.revision });
                        reply = { kind: 'awaitingConfirmation', text: copy.review, proposalId: confirmation!.id, proposalRevision: confirmation!.revision,
                            evidence: [{ kind: 'payroll', label: copy.evidence.payrollExceptions, asAt: todayInKualaLumpur(), companyId: null, truncated: false }], links: [],
                            tables: [{ columns: [copy.employeeColumn, copy.causeColumn], rows: proposal.subjects.map(subject => [[subject.employeeCode,subject.name,subject.companyName].filter(Boolean).join(' · '), copy.causes[subject.cause as keyof typeof copy.causes]]) }] };
                    }
                }
                catch (error) {
                    if (!(error instanceof AgentActionError))
                        throw error;
                    reply = plainReply('refused', copy.changed);
                }
                exchangeId = (await recordConversationReplyTx(tx, live, input.question, reply)).exchangeId;
            }
            if (!exchangeId)
                throw new AssistantConversationError('unavailable');
            await tx.update(schema.assistantConversationTurn).set({ exchangeId }).where(and(eq(schema.assistantConversationTurn.id, claim.turnId), isNull(schema.assistantConversationTurn.exchangeId)));
            const [updated] = await tx.update(schema.assistantConversation).set({ pendingRequestId: null, busyUntil: null }).where(eq(schema.assistantConversation.id, row.id)).returning();
            return viewTx(tx, updated!);
        });
        if (!result)
            throw new AssistantConversationError('scopeChanged');
        return result;
    }
    catch (error) {
        // Cleanup uses only the captured self-owned metadata identity; it retrieves no previous answer and
        // cannot restore a revoked principal. Scope/session changes invalidate rather than disclose history.
        if (error instanceof AssistantConversationError) {
            await withTenant(identity.ctx, tx => invalidateTx(tx, input.conversationId));
            throw error;
        }
        try {
            await assertSameConversationIdentity(identity);
        }
        catch (scopeError) {
            await withTenant(identity.ctx, tx => invalidateTx(tx, input.conversationId));
            throw scopeError;
        }
        return withTenant(identity.ctx, async (tx) => {
            const live = await conversationAuthorityTx(tx, identity), row = await readConversationTx(tx, live, input.conversationId, true);
            if (!row)
                throw new AssistantConversationError('scopeChanged');
            if (row.pendingRequestId !== input.requestId || row.revision !== claim.revision)
                throw new AssistantConversationError('stale');
            // A failed provider request already owns a reserved question audit. Link that exact row;
            // only refusals before reservation get a zero-model capability receipt.
            let failedExchangeId=error instanceof AssistantError?error.exchangeId:undefined;
            if(failedExchangeId){const [owned]=await tx.select({id:schema.assistantExchange.id}).from(schema.assistantExchange).where(and(eq(schema.assistantExchange.id,failedExchangeId),eq(schema.assistantExchange.appUserId,live.ctx.userId!),eq(schema.assistantExchange.tenantId,live.ctx.tenantId),eq(schema.assistantExchange.interactionKind,'question'))).limit(1);if(!owned)throw new AssistantConversationError('unavailable');}
            else failedExchangeId=(await recordConversationReplyTx(tx, live, input.question, plainReply('unavailable', error instanceof AssistantError?copy.failures[error.code]:copy.unavailable))).exchangeId;
            await tx.update(schema.assistantConversationTurn).set({ exchangeId: failedExchangeId }).where(eq(schema.assistantConversationTurn.id, claim.turnId));
            const [updated] = await tx.update(schema.assistantConversation).set({ pendingRequestId: null, busyUntil: null }).where(eq(schema.assistantConversation.id, row.id)).returning();
            return viewTx(tx, updated!);
        });
    }
}
/** Explicit confirmation is separate from submitting a question. Proposal, actual domain change,
 * canonical event and private result commit together; retry returns that frozen result, never replays
 * the action. Fresh principal/scope checks occur before the transaction and again before/after writes.
 * Source row locks protect the actual supported causes. A stamp is a revocation observation, not a
 * claim that every independent governance writer is serialized by this transaction. */
export async function confirmAssistantConversationProposal(raw: unknown, copy: AssistantConversationCopy): Promise<ConversationView> {
    const parsed = assistantProposalConfirmation.safeParse(raw);
    if (!parsed.success)
        throw new AssistantConversationError('invalid');
    const input = parsed.data, identity = await freshConversationIdentity();
    const result = await withTenant(identity.ctx, async (tx) => {
        const live = await conversationAuthorityTx(tx, identity), row = await readConversationTx(tx, live, input.conversationId, true);
        if (!row)
            return null;
        const [proposal] = await tx.select().from(schema.assistantConfirmation).where(and(eq(schema.assistantConfirmation.id, input.proposalId), eq(schema.assistantConfirmation.conversationId, row.id))).limit(1).for('update');
        if (!proposal)
            throw new AssistantConversationError('notFound');
        if (proposal.status === 'completed')
            return viewTx(tx, row);
        if (row.pendingRequestId)
            throw new AssistantConversationError('busy');
        if (row.revision !== input.conversationRevision || proposal.revision !== input.proposalRevision)
            throw new AssistantConversationError('stale');
        if (proposal.status !== 'awaiting' || proposal.expiresAt.getTime() <= Date.now() || proposal.authorityStamp !== live.authorityStamp)
            throw new AssistantConversationError('expired');
        const payload = assistantConfirmedPayload.parse(proposal.payload);
        await tx.update(schema.assistantConfirmation).set({ status: 'executing', requestId: input.requestId }).where(eq(schema.assistantConfirmation.id, proposal.id));
        let outcome: {
            closed: number;
            stale: number;
        };
        try {
            outcome = await tx.transaction(actionTx => executeActionTx(actionTx, live.ctx, { ...payload, companyIds: live.scopeIds, expectedDigest: proposal.preconditionDigest }));
        }
        catch (error) {
            if (!(error instanceof AgentActionError))
                throw error;
            outcome = { closed: 0, stale: payload.verdictIds.length };
        }
        const after = await conversationAuthorityTx(tx, identity);
        if (after.authorityStamp !== live.authorityStamp)
            throw new AssistantConversationError('scopeChanged');
        await tx.update(schema.assistantConfirmation).set({ status: 'completed', result: outcome, revision: proposal.revision + 1 }).where(eq(schema.assistantConfirmation.id, proposal.id));
        const reply: AssistantCapabilityReply = { kind: 'completed', text: copy.completed(outcome.closed, outcome.stale), proposalId: proposal.id, completedCount: outcome.closed, staleCount: outcome.stale, evidence: [], links: [], tables: [] };
        const recorded = await recordConversationReplyTx(tx, live, copy.review, reply), revision = row.revision + 1;
        await tx.insert(schema.assistantConversationTurn).values({ tenantId: live.ctx.tenantId, appUserId: live.ctx.userId!, conversationId: row.id, requestId: input.requestId, revision, exchangeId: recorded.exchangeId });
        const [updated] = await tx.update(schema.assistantConversation).set({ revision }).where(eq(schema.assistantConversation.id, row.id)).returning();
        return viewTx(tx, updated!);
    });
    if (!result)
        throw new AssistantConversationError('scopeChanged');
    return result;
}
export async function resetAssistantConversation(id: string): Promise<ConversationView> {
    assistantConversationId.parse(id);
    const identity = await freshConversationIdentity();
    await withTenant(identity.ctx, async (tx) => { const live = await conversationAuthorityTx(tx, identity), row = await readConversationTx(tx, live, id, true); if (row)
        await invalidateTx(tx, row.id); });
    return startAssistantConversation();
}
/** Rating is private metadata on the existing conversation/exchange reference, not a new transcript. */
export async function rateAssistantConversationReply(raw: {
    conversationId: string;
    exchangeId: string;
    helpful: boolean;
}): Promise<void> {
    assistantConversationId.parse(raw.conversationId);
    assistantConversationId.parse(raw.exchangeId);
    if (typeof raw.helpful !== 'boolean')
        throw new AssistantConversationError('invalid');
    const identity = await freshConversationIdentity();
    const saved = await withTenant(identity.ctx, async (tx) => {
        const live = await conversationAuthorityTx(tx, identity), row = await readConversationTx(tx, live, raw.conversationId, true);
        if (!row)
            return false;
        const updated = await tx.update(schema.assistantConversationTurn).set({ helpful: raw.helpful, feedbackAt: sql `now()` }).where(and(eq(schema.assistantConversationTurn.conversationId, row.id), eq(schema.assistantConversationTurn.exchangeId, raw.exchangeId))).returning({ id: schema.assistantConversationTurn.id });
        return updated.length === 1;
    });
    if (!saved)
        throw new AssistantConversationError('notFound');
}
