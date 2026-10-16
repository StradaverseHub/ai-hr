/** Actual app-role ledger/action/RLS tests. Only verified-session adapter and provider transport are
 * fixture substitutes; no conversation, grant, anomaly, private SQL or audit owner is mocked. */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../db/client';
const fixture = vi.hoisted(() => ({ session: vi.fn(), converse: vi.fn() }));
vi.mock('../lib/assistant-session', () => ({ resolveAssistantSession: fixture.session }));
vi.mock('../lib/ai/providers/anthropic',()=>({anthropicAdapter:{converse:fixture.converse}}));
import { withTenant } from '../db/client';
import * as s from '../db/schema';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { grantAssistant, revokeAssistant } from '../core/assistant-grant';
import { saveAiProviderConfig } from '../core/ai-config';
import { askAssistant } from '../core/assistant';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { startAssistantConversation, submitAssistantConversationTurn, confirmAssistantConversationProposal, rateAssistantConversationReply } from '../core/assistant-conversation';
import {prepareAssistantFeedbackDraft,readAssistantFeedbackDraft,submitAssistantFeedbackDraft} from '../core/assistant-feedback';
import { ASSISTANT_HANDOFFS, type AssistantConversationCopy } from '../lib/assistant-conversation-model';
const copy: AssistantConversationCopy = {feedbackDraft:'Suggest improvement',feedbackDraftHelp:'Review and edit before submitting', failures:{not_configured:'No provider',budget_monthly:'Monthly limit',budget_daily:'Daily limit',invalid_question:'Invalid',provider_error:'Transport failed',ai_control:'Control refused'},unavailable: 'Unavailable', notFinished: 'Incomplete', review: 'Review exact exceptions', noCandidates: 'No candidates', overCap: 'Narrow the review', changed: 'Changed', completed: (closed, stale) => `Closed ${closed}; stale ${stale}`, employeeColumn: 'Employee', causeColumn: 'Cause', causes: { no_bank_account: 'Bank corrected', no_tax_number: 'Tax corrected' }, evidence: { records: 'Records', payrollExceptions: 'Payroll' }, routes: Object.fromEntries(ASSISTANT_HANDOFFS.map(key => [key, key])) as AssistantConversationCopy['routes'] };
const priorConfigSecret=process.env.AI_CONFIG_SECRET;
let base: Base, ctx: SessionContext, binding: {
    ctx: SessionContext;
    signInHash: string;
    scopeIds: string[];
};
beforeAll(async () => { await migrateTestDb(); });
afterAll(async()=>{await closeAll();if(priorConfigSecret===undefined)delete process.env.AI_CONFIG_SECRET;else process.env.AI_CONFIG_SECRET=priorConfigSecret;});
beforeEach(async () => {
    vi.resetAllMocks();
    await resetDb();
    base = await seedBase();
    await setModule(base.tenantId, 'assistant', 'active');
    await setModule(base.tenantId, 'payroll', 'active');
    ctx = await entitledCtx(base);
    await grantAssistant(ctx, { appUserId: base.adminUserId });
    binding = { ctx, signInHash: 'a'.repeat(64), scopeIds: [base.companyId] };
    fixture.session.mockImplementation(async () => binding);
    process.env.AI_CONFIG_SECRET = 'fictional-conversation-config-key-0123456789';
    await saveAiProviderConfig(ctx, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'fictional-not-a-provider-key', makeActive: true });
    fixture.converse.mockResolvedValue({ text: 'A recorded answer', stop: 'end', toolCalls: [], usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 0 } });
});
const question = (view: {
    id: string;
    revision: number;
}, requestId = randomUUID()) => ({ conversationId: view.id, revision: view.revision, requestId, question: 'Which records can I check?', intent: 'question' });
async function correctedException() {
    const person = await hireEmployee(ctx, { person: { fullName: 'Fictional Corrected', primaryEmail: 'corrected@conversation.invalid' }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01', paymentMethod: 'bank_transfer' });
    await setStatutoryProfileMY(ctx, { personId: person.personId, bankName: 'Fictional Bank', bankAccountNo: '9990001', taxNumber: 'SG4001' });
    const [period] = await owner.db.insert(s.payPeriod).values({ tenantId: base.tenantId, companyId: base.companyId, period: '2026-10', status: 'open' }).returning();
    const [batch] = await owner.db.insert(s.payrollBatch).values({ tenantId: base.tenantId, companyId: base.companyId, payPeriodId: period.id, payPeriod: '2026-10', batchDate: '2026-10-31', status: 'draft' }).returning();
    const [verdict] = await owner.db.insert(s.payrollAnomalyVerdict).values({ tenantId: base.tenantId, batchId: batch.id, employmentId: person.employmentId, disposition: 'block', detectorsRun: ['missing-bank-profile'], detectorsSkipped: [] }).returning();
    await owner.db.insert(s.payrollAnomalyFinding).values({ tenantId: base.tenantId, verdictId: verdict.id, detectorId: 'missing-bank-profile', severity: 'block', facts: {}, sourceEventIds: [], suggestedAction: 'fixture' });
    return { ...person, verdictId: verdict.id };
}
describe('one sign-in conversation and existing exchange owner', () => {
    it('reuses one conversation and an exact completed request without a second model call or usage increment', async () => {
        const initial = await startAssistantConversation();
        expect((await startAssistantConversation()).id).toBe(initial.id);
        const request = question(initial), first = await submitAssistantConversationTurn(request, copy), replay = await submitAssistantConversationTurn(request, copy);
        expect(replay).toEqual(first);
        expect(fixture.converse).toHaveBeenCalledOnce();
        expect(first.messages).toHaveLength(1);
        const exchanges = await owner.db.select().from(s.assistantExchange);
        expect(exchanges).toHaveLength(1);
        expect(exchanges[0]).toMatchObject({ interactionKind: 'question', inputTokens: 11, outputTokens: 7 });
        expect(JSON.parse(exchanges[0].answer!)).toEqual(first.messages[0].reply);
        expect((await owner.db.select().from(s.assistantUsage))[0].exchangeCount).toBe(1);
    });
    it('re-resolves after provider completion and never attaches or discloses history after a sign-in change', async () => {
        const initial = await startAssistantConversation();
        fixture.converse.mockImplementation(async () => { binding = { ...binding, signInHash: 'b'.repeat(64) }; return { text: 'sensitive fixture answer', stop: 'end', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 } }; });
        await expect(submitAssistantConversationTurn(question(initial), copy)).rejects.toMatchObject({ code: 'scopeChanged' });
        expect((await startAssistantConversation()).messages).toEqual([]);
        expect((await owner.db.select().from(s.assistantConversation).where(eq(s.assistantConversation.id, initial.id)))[0].invalidatedAt).not.toBeNull();
        expect((await owner.db.select().from(s.assistantExchange))[0].answer).toBeNull();
    });
    it('invalidates a conversation and its pending proposal on company selection and actual grant changes', async () => {
        await correctedException();
        const initial = await startAssistantConversation(), review = await submitAssistantConversationTurn({ ...question(initial), intent: 'prepareCloseFixed' }, copy);
        expect(review.messages[0].reply.kind).toBe('awaitingConfirmation');
        binding = { ...binding, scopeIds: [] };
        const next = await startAssistantConversation();
        expect(next.id).not.toBe(initial.id);
        expect(next.messages).toEqual([]);
        expect((await owner.db.select().from(s.assistantConfirmation))[0].status).toBe('refused');
        await revokeAssistant(ctx, { appUserId: ctx.userId! });
        await expect(startAssistantConversation()).rejects.toMatchObject({ code: 'unavailable' });
    });
    it('keeps transcript and feedback private to exact tenant/login even for another administrator', async () => {
        const initial = await startAssistantConversation(), answered = await submitAssistantConversationTurn(question(initial), copy), id = answered.messages[0].id;
        await rateAssistantConversationReply({ conversationId: initial.id, exchangeId: id, helpful: false });
        expect((await startAssistantConversation()).messages[0].helpful).toBe(false);
        const stranger = await createAppUser(base.tenantId, null, 'hr_admin');
        binding = { ...binding, ctx: { ...ctx, userId: stranger } };
        await grantAssistant(ctx, { appUserId: stranger });
        expect((await startAssistantConversation()).messages).toEqual([]);
        await expect(rateAssistantConversationReply({ conversationId: initial.id, exchangeId: id, helpful: true })).rejects.toMatchObject({ code: 'notFound' });
        expect(await withTenant(binding.ctx, tx => tx.select().from(s.assistantExchange))).toEqual([]);
        const foreign = await seedBase();
        expect(await withTenant(adminCtx(foreign), tx => tx.select().from(s.assistantConversation).where(eq(s.assistantConversation.id, initial.id)))).toEqual([]);
    });
    it('preserves a pending in-flight request without automatically starting another model call', async () => {
        const initial = await startAssistantConversation();
        let entered!: () => void, release!: () => void;
        const enteredPromise = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
        fixture.converse.mockImplementation(async () => { entered(); await gate; return { text: 'After wait', stop: 'end', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } }; });
        const request = question(initial), running = submitAssistantConversationTurn(request, copy);
        try {
            await Promise.race([enteredPromise, running.then(() => { throw Error('Missing provider gate'); })]);
            expect((await startAssistantConversation()).pending).toBe(true);
            await expect(submitAssistantConversationTurn(request, copy)).rejects.toMatchObject({ code: 'busy' });
            expect(fixture.converse).toHaveBeenCalledOnce();
        }
        finally {
            release();
            await running;
        }
    });
});
describe('server-bound explicit confirmation', () => {
    it('previews without mutation and concurrently confirms once, retaining one immutable result and no model question', async () => {
        const subject = await correctedException(), initial = await startAssistantConversation(), review = await submitAssistantConversationTurn({ ...question(initial), intent: 'prepareCloseFixed' }, copy), reply = review.messages[0].reply;
        if (reply.kind !== 'awaitingConfirmation')
            throw Error('Expected a real review');
        expect((await owner.db.select().from(s.payrollAnomalyVerdict).where(eq(s.payrollAnomalyVerdict.id, subject.verdictId)))[0].resolvedAt).toBeNull();
        const confirmation = { conversationId: review.id, conversationRevision: review.revision, proposalId: reply.proposalId, proposalRevision: reply.proposalRevision, requestId: randomUUID() };
        const [one, two] = await Promise.all([confirmAssistantConversationProposal(confirmation, copy), confirmAssistantConversationProposal(confirmation, copy)]);
        expect(two).toEqual(one);
        expect(one.messages.at(-1)?.reply).toMatchObject({ kind: 'completed', completedCount: 1, staleCount: 0 });
        expect(fixture.converse).not.toHaveBeenCalled();
        expect(await owner.db.select().from(s.assistantUsage)).toEqual([]);
        expect((await owner.db.select().from(s.assistantExchange)).every(row => row.interactionKind === 'capability' && row.turnCount === 0 && row.provider === null && row.inputTokens === 0 && row.outputTokens === 0)).toBe(true);
        expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, subject.verdictId), eq(s.domainEvent.eventType, 'payroll.anomaly.resolved')))).toHaveLength(1);
    });
    it('does not close changed valid source facts or accept forged IDs/authorization fields', async () => {
        const subject = await correctedException(), initial = await startAssistantConversation(), review = await submitAssistantConversationTurn({ ...question(initial), intent: 'prepareCloseFixed' }, copy), reply = review.messages[0].reply;
        if (reply.kind !== 'awaitingConfirmation')
            throw Error('Expected review');
        const confirmation = { conversationId: review.id, conversationRevision: review.revision, proposalId: reply.proposalId, proposalRevision: reply.proposalRevision, requestId: randomUUID() };
        await expect(confirmAssistantConversationProposal({ ...confirmation, verdictIds: [subject.verdictId], roles: ['hr_admin'] }, copy)).rejects.toMatchObject({ code: 'invalid' });
        await owner.db.update(s.employeeStatutoryMy).set({ bankAccountNo: '9990002' }).where(eq(s.employeeStatutoryMy.personId, subject.personId));
        expect((await confirmAssistantConversationProposal(confirmation, copy)).messages.at(-1)?.reply).toMatchObject({ completedCount: 0, staleCount: 1 });
        expect((await owner.db.select().from(s.payrollAnomalyVerdict).where(eq(s.payrollAnomalyVerdict.id, subject.verdictId)))[0].resolvedAt).toBeNull();
    });
    it('real app-role SQL cannot retarget confirmation identity/payload or cross-link another user audit', async () => {
        await correctedException();
        const initial = await startAssistantConversation();
        await submitAssistantConversationTurn({ ...question(initial), intent: 'prepareCloseFixed' }, copy);
        const [proposal] = await owner.db.select().from(s.assistantConfirmation);
        await expect(withTenant(ctx, tx => tx.update(s.assistantConfirmation).set({ payload: { typeId: 'close_fixed_upstream', verdictIds: [randomUUID()] } }).where(eq(s.assistantConfirmation.id, proposal.id)))).rejects.toThrow();
        await expect(withTenant(ctx, tx => tx.execute(sql `insert into assistant_confirmation(tenant_id,app_user_id,conversation_id,authority_stamp,precondition_digest,payload) values (${base.tenantId},${ctx.userId},${initial.id},${'a'.repeat(64)},${'a'.repeat(64)},jsonb_build_object('typeId','close_fixed_upstream','verdictIds',jsonb_build_array('not-a-uuid')))`))).rejects.toThrow();
        const stranger = await createAppUser(base.tenantId, null, 'hr_admin');
        const [other] = await owner.db.insert(s.assistantExchange).values({ tenantId: base.tenantId, appUserId: stranger, question: 'Foreign private exchange' }).returning();
        await expect(withTenant(ctx, tx => tx.insert(s.assistantConversationTurn).values({ tenantId: base.tenantId, appUserId: ctx.userId!, conversationId: initial.id, requestId: randomUUID(), revision: 99, exchangeId: other.id }))).rejects.toThrow();
    });
});
describe('existing question budget and reserved audit', () => {
    it('counts a real in-flight provider question once, refuses a second before transport, and finalizes the same row', async () => {
        await owner.db.insert(s.assistantBudget).values({ tenantId: base.tenantId, monthlyTokenCeiling: 1000000, perUserDailyQuestions: 1, effectiveFrom: '2020-01-01' });
        let entered!: () => void, release!: () => void;
        const enteredPromise = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
        fixture.converse.mockImplementation(async () => { entered(); await gate; return { text: 'One', stop: 'end', toolCalls: [], usage: { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0 } }; });
        const first = askAssistant(ctx, { question: 'First actual question' });
        try {
            await Promise.race([enteredPromise, first.then(() => { throw Error('Missing provider gate'); })]);
            const [pending] = await owner.db.select().from(s.assistantExchange);
            expect(pending).toMatchObject({ interactionKind: 'question', answer: null, stop: null, inputTokens: 0 });
            await expect(askAssistant(ctx, { question: 'Second actual question', interactionKind: 'capability' } as never)).rejects.toMatchObject({ code: 'budget_daily' });
            expect(fixture.converse).toHaveBeenCalledOnce();
        }
        finally {
            release();
            await first;
        }
        const rows = await owner.db.select().from(s.assistantExchange);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ interactionKind: 'question', answer: 'One', inputTokens: 2, outputTokens: 3 });
    });
    it('actual provider audit cannot be relabelled as a free capability or created with model fields',async()=>{
      const result=await askAssistant(ctx,{question:'An actual model question',interactionKind:'capability'} as never);
      expect((await owner.db.select().from(s.assistantExchange).where(eq(s.assistantExchange.id,result.exchangeId)))[0].interactionKind).toBe('question');
      await expect(withTenant(ctx,tx=>tx.update(s.assistantExchange).set({interactionKind:'capability'}).where(eq(s.assistantExchange.id,result.exchangeId)))).rejects.toThrow();
      await expect(withTenant(ctx,tx=>tx.insert(s.assistantExchange).values({tenantId:base.tenantId,appUserId:ctx.userId!,question:'Forged capability',interactionKind:'capability',provider:'anthropic',inputTokens:1}))).rejects.toThrow();
    });
    it('does not consume the model-question limit for deterministic confirmation, while provider failures retain their reserved question', async () => {
        await correctedException();
        let initial = await startAssistantConversation();
        initial = await submitAssistantConversationTurn({ ...question(initial), intent: 'prepareCloseFixed' }, copy);
        await owner.db.insert(s.assistantBudget).values({ tenantId: base.tenantId, monthlyTokenCeiling: 1000000, perUserDailyQuestions: 1, effectiveFrom: '2020-01-01' });
        fixture.converse.mockRejectedValue(Error('transport fixture failure, never expose'));
        const failed=await submitAssistantConversationTurn({...question(initial),question:'Actual failed question'},copy);
        expect(failed.messages.find(message=>message.question==='Actual failed question')).toMatchObject({failure:'provider_error',reply:{kind:'unavailable'}});
        const rows = await owner.db.select().from(s.assistantExchange);
        expect(rows.filter(row => row.interactionKind === 'question')).toHaveLength(1);
        expect(rows.find(row => row.interactionKind === 'question')).toMatchObject({ id:failed.messages.find(message=>message.question==='Actual failed question')!.id,answer: null, error: 'provider_error' });
        expect(rows.filter(row=>row.question==='Actual failed question')).toHaveLength(1);
        const refused=await submitAssistantConversationTurn({...question(failed),question:'No provider slot remains'},copy);
        expect(refused.messages.find(message=>message.question==='No provider slot remains')!.reply.text).toBe('Daily limit');
        expect((await owner.db.select().from(s.assistantExchange).where(eq(s.assistantExchange.question,'No provider slot remains')))[0].interactionKind).toBe('capability');
        await expect(askAssistant(ctx, { question: 'After failed question' })).rejects.toMatchObject({ code: 'budget_daily' });
        expect(fixture.converse).toHaveBeenCalledOnce();
    });
});

/** Requires the reviewed Credit Feedback user-only + explicit-Tx owner union, never a fake employee. */
describe('editable confirmed Feedback handoff uses one canonical transaction',()=>{
 async function draft(){const initial=await startAssistantConversation(),answered=await submitAssistantConversationTurn(question(initial),copy);const result=await prepareAssistantFeedbackDraft({conversationId:answered.id,conversationRevision:answered.revision,exchangeId:answered.messages[0].id,requestId:randomUUID()},copy);return{...result,source:answered.messages[0]};}
 const edited=(id:string)=>({draftId:id,expectedRevision:1,reporterEmploymentId:null,category:'enhancement',title:'Edited fictional improvement',description:'Explicitly reviewed and edited before submission.',expectedBehavior:'A clearer safe handoff.',expectedFunction:null});
 it('opens an editable own draft without submitting and consumes concurrent exact confirmations once',async()=>{
  const prepared=await draft(),view=await readAssistantFeedbackDraft(prepared.id);
  expect(view).toMatchObject({title:prepared.source.question,description:prepared.source.question,feedbackId:null,subjects:[]});
  expect(await owner.db.select().from(s.feedbackRequest)).toEqual([]);
  const results=await Promise.all([submitAssistantFeedbackDraft(edited(prepared.id)),submitAssistantFeedbackDraft(edited(prepared.id))]);
  expect(new Set(results.map(row=>row.feedbackId)).size).toBe(1);expect(results.filter(row=>row.created)).toHaveLength(1);
  const rows=await owner.db.select().from(s.feedbackRequest);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({reporterUserId:ctx.userId,reporterEmploymentId:null,title:'Edited fictional improvement',description:'Explicitly reviewed and edited before submission.'});
  expect((await readAssistantFeedbackDraft(prepared.id)).feedbackId).toBe(rows[0].id);
  await expect(submitAssistantFeedbackDraft({...edited(prepared.id),title:'Changed retry'})).rejects.toMatchObject({code:'stale'});
  expect(fixture.converse).toHaveBeenCalledOnce();expect((await owner.db.select().from(s.assistantUsage))[0].exchangeCount).toBe(1);
 });
 it('rolls back the actual Feedback row/event if consumed-link persistence refuses',async()=>{
  const prepared=await draft(),constraint='fixture_handoff_rollback_'+randomUUID().replaceAll('-','');
  await owner.client.unsafe('ALTER TABLE assistant_feedback_draft ADD CONSTRAINT '+constraint+' CHECK(feedback_id IS NULL)');
  try{await expect(submitAssistantFeedbackDraft(edited(prepared.id))).rejects.toThrow();}finally{await owner.client.unsafe('ALTER TABLE assistant_feedback_draft DROP CONSTRAINT '+constraint);}
  expect(await owner.db.select().from(s.feedbackRequest)).toEqual([]);expect((await owner.db.select().from(s.assistantFeedbackDraft))[0]).toMatchObject({feedbackId:null,revision:1});
  expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'feedback.submitted'))).toEqual([]);
  expect((await submitAssistantFeedbackDraft(edited(prepared.id))).created).toBe(true);
 });
 it('refuses borrowed employment, another actor and changed sign-in/company authority without submitting',async()=>{
  const prepared=await draft(),peer=await hireEmployee(ctx,{person:{fullName:'Fictional other reporter',primaryEmail:randomUUID()+'@conversation.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  await expect(submitAssistantFeedbackDraft({...edited(prepared.id),reporterEmploymentId:peer.employmentId})).rejects.toThrow();
  const other=await createAppUser(base.tenantId,null,'hr_admin');await grantAssistant(ctx,{appUserId:other});const original=binding;binding={...binding,ctx:{...ctx,userId:other}};
  await expect(readAssistantFeedbackDraft(prepared.id)).rejects.toMatchObject({code:'notFound'});expect(await withTenant(binding.ctx,tx=>tx.select().from(s.assistantFeedbackDraft))).toEqual([]);
  binding={...original,signInHash:'f'.repeat(64)};await expect(submitAssistantFeedbackDraft(edited(prepared.id))).rejects.toMatchObject({code:'scopeChanged'});
  expect((await owner.db.select().from(s.assistantConversation).where(eq(s.assistantConversation.id,prepared.view.id)))[0].invalidatedAt).not.toBeNull();
  expect(await owner.db.select().from(s.feedbackRequest)).toEqual([]);
 });
});
