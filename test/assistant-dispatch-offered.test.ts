/**
 * ADR-0077 × ADR-0082 — DISPATCH RESOLVES ONLY FROM WHAT WAS OFFERED.
 *
 * The defect this pins: askAssistant offered the model `toolsFor(ctx)` (module-filtered) but runTools
 * resolved each call against the WHOLE registry. So a tenant without payroll was never offered
 * `my_payslip_summary`, yet if the model named it anyway — hallucinated, or injected through a tool
 * result — it ran, and the caller's released payslip went into the model's context. RLS still held (it
 * is the caller's own payslip); the module gate did not.
 *
 * The loop is driven for real against a real database as `ai_hr_app`; only `converse` is replaced, so
 * the model's tool choice is scripted and every turn the loop would send to a provider is captured.
 *
 * NON-VACUITY IS IN THE FILE: the second case runs the identical script on a tenant that DOES hold
 * payroll and watches the sentinel arrive. If the first case's sentinel assertion were checking a value
 * the tool could never return, the second would fail.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import type { ConverseResult } from '../lib/ai/types';
import { askAssistant } from '../core/assistant';
import { loadAiWorkspace } from '../core/ai-workspace';
import { ownAssistantClarification } from '../core/assistant-clarification';
import { ASSISTANT_PUBLIC_REPLIES } from '../lib/ai/assistant-public-replies';
import { grantAssistant } from '../core/assistant-grant';
import { ASSISTANT_TOOLS, toolsFor } from '../core/assistant-tools';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const { converse } = vi.hoisted(() => ({ converse: vi.fn() }));
vi.mock('../lib/ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('../lib/ai')>()), converse }));

const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
const toolUse = (calls: { id: string; name: string; input: unknown }[]): ConverseResult => ({
  text: '',
  toolCalls: calls,
  stop: 'tool_use',
  usage,
});
const end: ConverseResult = { text: 'Done.', toolCalls: [], stop: 'end', usage };

/** A basic salary nothing else in the fixture produces, so its appearance can only be the payslip. */
const SENTINEL_BASIC = 7319;

let base: Base;

beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  converse.mockReset();
  // resolveActiveAiConfig falls back to an env key when no tenant config is stored. `converse` is mocked,
  // so the key is never sent anywhere; the stub only makes a config exist.
  vi.stubEnv('AI_CONFIG_SECRET', 'fictional-dispatch-disclosure-only');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-never-sent');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('GOOGLE_API_KEY', '');
  vi.stubEnv('GEMINI_API_KEY', '');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeAll();
});

/**
 * An employee with a RELEASED payslip, an assistant grant, and a session whose entitlement snapshot is
 * resolved from the tenant's real rows AFTER `payroll` is set as asked.
 */
async function employeeWithReleasedPayslip(payroll: boolean): Promise<{ ctx: SessionContext; net: string }> {
  const a = adminCtx(base); // synthetic snapshot with payroll on: the payslip is created while it is held
  const E = await hireEmployee(a, {
    person: { fullName: 'Dispatch Dana', primaryEmail: 'dispatch.dana@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: SENTINEL_BASIC, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '910707030001' });
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
  await generatePayslips(a, { batchId });
  await closeBatch(a, { batchId }); // released: what my_payslip_summary returns

  const [slip] = await owner.db
    .select({ net: schema.payslip.netPay })
    .from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, E.employmentId)));
  expect(slip, 'the released payslip must exist, or the sentinel assertion asserts nothing').toBeTruthy();

  const userId = await createAppUser(base.tenantId, E.personId, 'employee');
  await setModule(base.tenantId, 'assistant', 'active');
  await grantAssistant(a, { appUserId: userId });

  const snap = await entitledCtx(base, ['employee']);
  const ctx: SessionContext = { ...snap, userId, personId: E.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
  const net=String(Number(slip.net));
  if(!payroll){
    // Non-vacuity is established while the actual Assistant grant AND paid module are active.
    const direct=await ASSISTANT_TOOLS.find(tool=>tool.spec.name==='my_payslip_summary')!.run(ctx,{limit:12});
    expect(JSON.stringify(direct)).toContain(net);
    await setModule(base.tenantId,'payroll',null);
    return {ctx:{...ctx,entitlements:(await entitledCtx(base,['employee'])).entitlements},net};
  }
  return {ctx,net};
}

/** Everything the loop sent to the provider, across every turn. */
const sentToModel = () => JSON.stringify(converse.mock.calls.map(([, args]) => args));

const auditOf = async (exchangeId: string) => {
  const [row] = await owner.db
    .select({ toolCalls: schema.assistantExchange.toolCalls })
    .from(schema.assistantExchange)
    .where(eq(schema.assistantExchange.id, exchangeId));
  return row.toolCalls as { name: string; refusal?: string; rowCount: number | null }[];
};

const toolTurn = () => {
  const turns = converse.mock.calls[1][1].turns as { role: string; results?: { id: string; content: string; isError?: boolean }[] }[];
  const tool = turns.find((t) => t.role === 'tool');
  expect(tool, 'the second converse call must carry the tool results').toBeTruthy();
  return tool!.results!;
};

describe('a tool call the exchange did not offer is never dispatched', () => {
  it('tenant WITHOUT payroll: my_payslip_summary is refused not_offered and the payslip never reaches the model', async () => {
    const { ctx, net } = await employeeWithReleasedPayslip(false);

    // The fixture proved actual reachability before the paid grant lapsed. A direct reader must now
    // refuse as well: offered-set filtering cannot bypass the canonical module guard.
    await expect(ASSISTANT_TOOLS.find(t=>t.spec.name==='my_payslip_summary')!.run(ctx,{limit:12})).rejects.toThrow('data access');
    expect(toolsFor(ctx).map((t) => t.spec.name)).not.toContain('my_payslip_summary');

    converse
      .mockResolvedValueOnce(
        toolUse([
          { id: 'c1', name: 'my_payslip_summary', input: { limit: 12 } },
          { id: 'c2', name: 'no_such_tool_anywhere', input: {} },
        ]),
      )
      .mockResolvedValueOnce(end);

    const res = await askAssistant(ctx, { question: 'What was my last net pay?' });
    expect(res.stop).toBe('end');
    expect(converse).toHaveBeenCalledTimes(2);

    // The model was never offered it.
    for (const [, args] of converse.mock.calls) {
      expect((args.tools as { name: string }[]).map((s) => s.name)).not.toContain('my_payslip_summary');
    }

    // The audit separates the two; the model cannot.
    const audit = await auditOf(res.exchangeId);
    expect(audit.find((a) => a.name === 'my_payslip_summary')?.refusal).toBe('not_offered');
    expect(audit.find((a) => a.name === 'no_such_tool_anywhere')?.refusal).toBe('unknown_tool');

    const [notOffered, unknown] = toolTurn();
    expect(notOffered).toMatchObject({ id: 'c1', content: ASSISTANT_PUBLIC_REPLIES.tool, isError: true });
    // NO ORACLE: a registered-but-not-offered name reads exactly like a name that does not exist.
    expect({ content: notOffered.content, isError: notOffered.isError }).toEqual({ content: unknown.content, isError: unknown.isError });

    expect(sentToModel()).not.toContain(net);
  });

  it('tenant WITH payroll: the same script runs the tool and the sentinel arrives (non-vacuity)', async () => {
    const { ctx, net } = await employeeWithReleasedPayslip(true);
    expect(toolsFor(ctx).map((t) => t.spec.name)).toContain('my_payslip_summary');

    converse.mockResolvedValueOnce(toolUse([{ id: 'c1', name: 'my_payslip_summary', input: { limit: 12 } }]))
      .mockResolvedValueOnce({ ...end, text: `MODEL_INVENTED_NET_987654_AND_PAY_APPROVAL. Recorded net: ${net}.` });

    const res = await askAssistant(ctx, { question: 'What was my last net pay?' });
    const audit = await auditOf(res.exchangeId);
    expect(audit[0]).toMatchObject({ name: 'my_payslip_summary', rowCount: 1 });
    expect(audit[0].refusal).toBeUndefined();
    expect(toolTurn()[0].isError).toBeUndefined();
    expect(sentToModel()).toContain(net);
    const [stored] = await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.id, res.exchangeId));
    expect(stored.disclosureReceipt).toBeTruthy();
    expect(res).not.toHaveProperty('answer');
    const reopened = await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});
    expect(reopened.history[0]).toMatchObject({ id: res.exchangeId, answer:null, answerVisibility:'current',grounded:{mode:'grounded'} });
    expect(JSON.stringify(reopened.history[0].grounded?.views)).toContain(net);
    expect(JSON.stringify(reopened)).not.toContain('MODEL_INVENTED_NET_987654_AND_PAY_APPROVAL');
    expect(stored.answer).toContain('MODEL_INVENTED_NET_987654_AND_PAY_APPROVAL');
    expect(JSON.stringify(reopened)).not.toContain(stored.disclosureReceipt!);
    // Actual command -> source receipt -> canonical replay -> module revocation, no forged backfill.
    await setModule(base.tenantId, 'payroll', null);
    const retired = await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});
    expect(retired.history[0]).toMatchObject({ id: res.exchangeId, answer: null, answerVisibility: 'unavailable' });
    expect(JSON.stringify(retired)).not.toContain(net);
  });
});


describe('actual Assistant consumption of bounded agent batches', () => {
  it('refuses duplicate IDs and excessive fan-out before any otherwise offered reader runs', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    const tool = ASSISTANT_TOOLS.find(t => t.spec.name === 'my_payslip_summary')!;
    const spy = vi.spyOn(tool, 'run');
    try {
      const duplicate = [
        { id: 'same', name: tool.spec.name, input: { limit: 1 } },
        { id: 'same', name: tool.spec.name, input: { limit: 1 } },
      ];
      const excessive = Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, name: tool.spec.name, input: { limit: 1 } }));
      for (const batch of [duplicate, excessive]) {
        converse.mockReset(); converse.mockResolvedValueOnce(toolUse(batch));
        await expect(askAssistant(ctx, { question: 'Read my released payslip.' })).rejects.toMatchObject({ code: 'provider_error' });
        expect(converse).toHaveBeenCalledTimes(1);
        expect(spy).not.toHaveBeenCalled();
      }
      // The same offered tool really can run after a valid proposal; no global disabling shortcut.
      converse.mockReset();
      converse.mockResolvedValueOnce(toolUse([{ id: 'valid', name: tool.spec.name, input: { limit: 1 } }])).mockResolvedValueOnce(end);
      await expect(askAssistant(ctx, { question: 'Read my released payslip.' })).resolves.toMatchObject({ stop: 'end' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('keeps refusal codes in the server audit and gives the model only the public access reply', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    converse.mockResolvedValueOnce(toolUse([{ id: 'private', name: 'employee_profile',
      input: { employment_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' } }])).mockResolvedValueOnce(end);
    const result = await askAssistant(ctx, { question: 'Can you open this profile?' });
    expect(JSON.parse(toolTurn()[0].content)).toEqual({ ok: false, message: ASSISTANT_PUBLIC_REPLIES.access });
    expect(JSON.stringify(toolTurn())).not.toContain('not_visible');
    expect((await auditOf(result.exchangeId))[0].refusal).toBe('not_visible');
  });

  it('turns a raw source exception into the friendly safe reply without exposing its cause', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    const tool = ASSISTANT_TOOLS.find(t => t.spec.name === 'my_payslip_summary')!;
    const raw = 'PRIVATE_DATABASE_ERROR_SENTINEL: SELECT salary FROM secret_table; provider-key-fragment';
    const spy = vi.spyOn(tool, 'run').mockRejectedValueOnce(new Error(raw));
    try {
      converse.mockResolvedValueOnce(toolUse([{ id: 'failed', name: tool.spec.name, input: { limit: 1 } }])).mockResolvedValueOnce(end);
      const result = await askAssistant(ctx, { question: 'Read my released payslip.' });
      expect(toolTurn()).toEqual([{ id: 'failed', name: tool.spec.name, content: ASSISTANT_PUBLIC_REPLIES.lookup, isError: true }]);
      expect(sentToModel()).not.toContain(raw); expect(JSON.stringify(result)).not.toContain(raw);
      expect(JSON.stringify(await auditOf(result.exchangeId))).not.toContain(raw);
    } finally { spy.mockRestore(); }
  });

  it('does not send oversized read content into the next provider turn or persist it as rows', async () => {
    const { ctx } = await employeeWithReleasedPayslip(true);
    const tool = ASSISTANT_TOOLS.find(t => t.spec.name === 'my_payslip_summary')!;
    const sentinel = 'OVERSIZED_CANONICAL_READ_SENTINEL';
    const spy = vi.spyOn(tool, 'run').mockResolvedValueOnce({ ok: true, text: sentinel + '界'.repeat(23_000) });
    try {
      converse.mockResolvedValueOnce(toolUse([{ id: 'large', name: tool.spec.name, input: { limit: 1 } }])).mockResolvedValueOnce(end);
      const result = await askAssistant(ctx, { question: 'Read my released payslip.' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(toolTurn()).toEqual([{ id: 'large', name: tool.spec.name, content: ASSISTANT_PUBLIC_REPLIES.lookup, isError: true }]);
      expect(sentToModel()).not.toContain(sentinel);
      const audit = await auditOf(result.exchangeId);
      expect(audit).toEqual([{ name: tool.spec.name, input: { limit: 1 }, rowCount: null, refusal: 'tool_error' }]);
      expect(JSON.stringify(audit)).not.toContain(sentinel);
    } finally { spy.mockRestore(); }
  });
});


/** Actual command/source/readback composition. Only the provider is scripted, never engine rows. */
describe('model-selected conversational plan reaches current canonical facts',()=>{
 it('offers original source ordinals and reopens only the selected actual net fact',async()=>{
  const {ctx,net}=await employeeWithReleasedPayslip(true);
  converse.mockResolvedValueOnce(toolUse([{id:'conversation-pay',name:'my_payslip_summary',input:{limit:12}}]));
  converse.mockImplementationOnce(async(_cfg,args)=>{
   const catalogues=args.turns.filter((turn:{role:string;content?:string})=>turn.role==='user'&&turn.content?.includes('source_owned_answer_catalogue'));
   expect(catalogues).toHaveLength(1);
   const catalogue=JSON.parse(catalogues[0].content),source=catalogue.reads[0],card=source.cards[0];
   const selected=card.facts.find((fact:{field:string})=>fact.field==='net');expect(selected?.available).toBe(true);
   return {...end,text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'fact',read:source.read,card:card.card,fact:selected.fact}]})};
  });
  const res=await askAssistant(ctx,{question:'Show my recorded net pay only.'});
  const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});
  const conversation=workspace.history[0].grounded?.conversation;
  expect(conversation?.plan.mode).toBe('answer');expect(conversation?.facts).toHaveLength(1);
  const selected=conversation!.facts[0];expect(selected.view.state).toBe('ready');
  if(selected.view.state!=='ready')throw Error('canonical selected fact unavailable');
  expect(selected.view.presentation.cards[selected.card].facts[selected.fact]).toMatchObject({field:'net',value:Number(net)});
  expect(workspace.history[0].answer).toBeNull();
 });
 it('preserves a real no-tool clarification instead of replacing it with a generic reply',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true);
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'period'})});
  const res=await askAssistant(ctx,{question:'Which pay period should we look at?'});
  const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});
  expect(workspace.history[0].grounded?.conversation).toEqual({plan:{version:1,mode:'clarify',slot:'period'},facts:[]});
  const question=await ownAssistantClarification(ctx,res.exchangeId,'March 2026');
  expect(question).toEqual({originalQuestion:'Which pay period should we look at?',slot:'period',answer:'March 2026',earlier:[]});
  expect(converse).toHaveBeenCalledTimes(1);
 });
});


describe('a clarification reply carries the earlier human turns of its conversation (0658)',()=>{
 it('links each reply to the exchange it answered and sends only the human turns, oldest first',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true);
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'period'})});
  const first=await askAssistant(ctx,{question:'How much was I paid?'});
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'module'})});
  const second=await askAssistant(ctx,{question:'March 2026',clarificationExchangeId:first.exchangeId});
  const [stored]=await owner.db.select({continues:schema.assistantExchange.continuesExchangeId,question:schema.assistantExchange.question}).from(schema.assistantExchange).where(eq(schema.assistantExchange.id,second.exchangeId));
  expect(stored).toEqual({continues:first.exchangeId,question:'March 2026'});
  const carried=await ownAssistantClarification(ctx,second.exchangeId,'Payroll');
  expect(carried).toEqual({originalQuestion:'March 2026',slot:'module',answer:'Payroll',earlier:[{question:'How much was I paid?',slot:'period'}]});
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'period'})});
  await askAssistant(ctx,{question:'Payroll',clarificationExchangeId:second.exchangeId});
  const turns=(converse.mock.calls.at(-1)![1].turns as {role:string;content:string}[]).slice(0,3);
  expect(turns).toEqual([{role:'user',content:'How much was I paid?'},
   {role:'user',content:JSON.stringify({humanClarification:{slot:'period',answer:'March 2026'}})},
   {role:'user',content:JSON.stringify({humanClarification:{slot:'module',answer:'Payroll'}})}]);
  expect(JSON.stringify(converse.mock.calls.at(-1)![1].turns)).not.toContain('"mode":"clarify"');
 });
 it('starts the conversation later when an earlier reply was cleared, and never carries it',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true);
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'period'})});
  const first=await askAssistant(ctx,{question:'Secret first question'});
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'module'})});
  const second=await askAssistant(ctx,{question:'March 2026',clarificationExchangeId:first.exchangeId});
  await owner.db.delete(schema.assistantExchange).where(eq(schema.assistantExchange.id,first.exchangeId));
  const [stored]=await owner.db.select({continues:schema.assistantExchange.continuesExchangeId}).from(schema.assistantExchange).where(eq(schema.assistantExchange.id,second.exchangeId));
  expect(stored.continues).toBeNull();
  expect(await ownAssistantClarification(ctx,second.exchangeId,'Payroll')).toEqual({originalQuestion:'March 2026',slot:'module',answer:'Payroll',earlier:[]});
 });
 it('refuses a link to another login\'s exchange and any later re-pointing',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true);
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'period'})});
  const mine=await askAssistant(ctx,{question:'Mine'});
  const row={tenantId:base.tenantId,appUserId:base.adminUserId,question:'Theirs',continuesExchangeId:mine.exchangeId};
  // Non-vacuous: the same login may store its own row; only the foreign link is refused.
  const {continuesExchangeId:_link,...unlinked}=row;await owner.db.insert(schema.assistantExchange).values(unlinked);
  await expect(owner.db.insert(schema.assistantExchange).values(row)).rejects.toThrow();
  converse.mockResolvedValueOnce({...end,text:JSON.stringify({version:1,mode:'clarify',slot:'module'})});
  const reply=await askAssistant(ctx,{question:'March 2026',clarificationExchangeId:mine.exchangeId});
  converse.mockResolvedValueOnce({...end,text:'Done.'});
  const third=await askAssistant(ctx,{question:'Another'});
  await expect(owner.db.update(schema.assistantExchange).set({continuesExchangeId:third.exchangeId}).where(eq(schema.assistantExchange.id,reply.exchangeId))).rejects.toThrow();
 });
});

describe('actual model selection of current canonical explanation clauses',()=>{
 it('uses the recorded payroll specialist and retires its explanation after module revocation',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true);
  converse.mockResolvedValueOnce(toolUse([{id:'explain-recorded-pay',name:'my_module_work',input:{module:'payroll'}}]));
  converse.mockImplementationOnce(async(_cfg,args)=>{
   const turn=args.turns.find((row:{role:string;content?:string})=>row.role==='user'&&row.content?.includes('source_owned_answer_catalogue'));
   expect(turn).toBeTruthy();const catalogue=JSON.parse(turn.content),read=catalogue.reads[0];
   const clause=read.explanations.find((row:{code:string})=>row.code==='specialist_finding:released_pay_stored_only');
   expect(clause,'the actual source must offer this clause, not merely register its global code').toBeTruthy();
   return {...end,text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'explanation',read:read.read,card:clause.card,code:clause.code}]})};
  });
  const res=await askAssistant(ctx,{question:'What does this recorded payroll result establish?'});
  const reopened=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});
  const conversation=reopened.history[0].grounded?.conversation;
  expect(conversation?.facts).toEqual([]);expect(conversation?.segments).toHaveLength(1);
  const segment=conversation!.segments![0];expect(segment.kind).toBe('explanation');
  if(segment.kind!=='explanation'||segment.view.state!=='ready')throw Error('actual explanation source unavailable');
  expect(segment.explanation.content).toEqual({kind:'specialist_finding',finding:'released_pay_stored_only'});
  expect(segment.view.answerExplanations).toContain(segment.explanation);
  await setModule(base.tenantId,'payroll',null);
  const retired=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});
  expect(retired.history[0].grounded?.conversation).toBeUndefined();
  expect(JSON.stringify(retired.history[0])).not.toContain('released_pay_stored_only');
 });
});
