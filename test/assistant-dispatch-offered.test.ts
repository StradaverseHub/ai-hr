/** Real native dispatch/module/custody regression fixtures. The closed Assistant now performs fixed
 * own-source reads locally; model tool nominations never execute, and the provider sees ordinal
 * metadata only. Actual released-payroll sentinel remains locally reachable and module revocation
 * invalidates history, so zero provider leakage is non-vacuous. Authored UNRUN. */
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

/** Models see references only. A native own read runs before the single selector request. */
const metadata=(args:{turns:{role:string;content?:string}[]})=>{expect(args.turns).toHaveLength(1);const turn=args.turns[0];expect(turn.role).toBe('user');return JSON.parse(turn.content!);};

describe('a tool call the exchange did not offer is never dispatched',()=>{
 it('tenant WITHOUT payroll: source guard refuses before a provider and never discloses the released payslip',async()=>{
  const {ctx,net}=await employeeWithReleasedPayslip(false);
  await expect(ASSISTANT_TOOLS.find(t=>t.spec.name==='my_payslip_summary')!.run(ctx,{limit:12})).rejects.toThrow('data access');
  expect(toolsFor(ctx).map(t=>t.spec.name)).not.toContain('my_payslip_summary');
  converse.mockResolvedValue(toolUse([{id:'c1',name:'my_payslip_summary',input:{limit:12}},{id:'c2',name:'no_such_tool_anywhere',input:{}}]));
  await expect(askAssistant(ctx,{question:'My payslip'})).rejects.toMatchObject({code:'provider_error'});expect(converse).not.toHaveBeenCalled();
  const [row]=await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.appUserId,ctx.userId!));
  expect(await auditOf(row.id)).toEqual([{name:'my_payslip_summary',input:{limit:1},rowCount:null,refusal:'not_offered'}]);expect(sentToModel()).not.toContain(net);
 });
 it('tenant WITH payroll: actual own native payslip is locally available and provider prose never becomes HR evidence',async()=>{
  const {ctx,net}=await employeeWithReleasedPayslip(true);expect(toolsFor(ctx).map(t=>t.spec.name)).toContain('my_payslip_summary');
  converse.mockResolvedValueOnce({...end,text:`MODEL_INVENTED_NET_987654_AND_PAY_APPROVAL. Recorded net: ${net}.`});
  const res=await askAssistant(ctx,{question:'My payslip'}),audit=await auditOf(res.exchangeId);expect(audit[0]).toMatchObject({name:'my_payslip_summary',rowCount:1});expect(audit[0].refusal).toBeUndefined();expect(converse).toHaveBeenCalledOnce();
  expect(sentToModel()).not.toContain(net);expect(metadata(converse.mock.calls[0][1]).reads[0].cards[0].facts.some((fact:{field:string;available:boolean})=>fact.field==='net'&&fact.available)).toBe(true);
  const [stored]=await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.id,res.exchangeId));expect(stored.disclosureReceipt).toBeTruthy();expect(res).not.toHaveProperty('answer');
  const reopened=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});expect(reopened.history[0]).toMatchObject({id:res.exchangeId,answer:null,answerVisibility:'current',grounded:{mode:'grounded'}});expect(JSON.stringify(reopened.history[0].grounded?.views)).toContain(net);
  expect(JSON.stringify(reopened)).not.toContain('MODEL_INVENTED_NET_987654_AND_PAY_APPROVAL');expect(stored.answer).toContain('MODEL_INVENTED_NET_987654_AND_PAY_APPROVAL');expect(JSON.stringify(reopened)).not.toContain(stored.disclosureReceipt!);
  await setModule(base.tenantId,'payroll',null);const retired=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});expect(retired.history[0]).toMatchObject({id:res.exchangeId,answer:null,answerVisibility:'unavailable'});expect(JSON.stringify(retired)).not.toContain(net);
 });
});

describe('actual Assistant rejects all model-nominated batches',()=>{
 it('never dispatches duplicate IDs or excessive fan-out and still completes a valid own read',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true),tool=ASSISTANT_TOOLS.find(t=>t.spec.name==='my_payslip_summary')!,spy=vi.spyOn(tool,'run');
  try{
   const duplicate=[{id:'same',name:tool.spec.name,input:{limit:1}},{id:'same',name:tool.spec.name,input:{limit:1}}],excessive=Array.from({length:17},(_,i)=>({id:`c${i}`,name:tool.spec.name,input:{limit:1}}));
   for(const batch of [duplicate,excessive]){spy.mockClear();converse.mockReset();converse.mockResolvedValueOnce(toolUse(batch));const result=await askAssistant(ctx,{question:'My payslip'});expect(result.stop).toBe('other');expect(converse).toHaveBeenCalledOnce();expect(spy).toHaveBeenCalledTimes(2);expect(spy.mock.calls.map(call=>call[1])).toEqual([{limit:1},{limit:1}]);expect(spy.mock.invocationCallOrder.every(order=>order<converse.mock.invocationCallOrder[0])).toBe(true);expect(converse.mock.calls[0][1].tools).toEqual([]);}
   // The two reads are initial source + required preparation replay, both BEFORE model output.
   // A model refusal cannot disable the real native reader or masquerade as a completed answer.
   spy.mockClear();converse.mockReset();converse.mockResolvedValueOnce(end);await expect(askAssistant(ctx,{question:'My payslip'})).resolves.toMatchObject({stop:'end'});expect(spy).toHaveBeenCalledTimes(2);expect(spy.mock.calls.map(call=>call[1])).toEqual([{limit:1},{limit:1}]);expect(spy.mock.invocationCallOrder.every(order=>order<converse.mock.invocationCallOrder[0])).toBe(true);
  }finally{spy.mockRestore();}
 });
 it('keeps actual native refusal codes local and never sends a targeted profile question or public oracle to a model',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true);const tool=ASSISTANT_TOOLS.find(t=>t.spec.name==='employee_profile')!;
  const actual=await tool.run(ctx,{employment_id:'ffffffff-ffff-4fff-bfff-ffffffffffff'});expect(actual).toMatchObject({ok:false,refusal:'not_visible',message:ASSISTANT_PUBLIC_REPLIES.access});
  // The existing public formatter retains identical public wording and removes the internal code.
  const {assistantPublicToolResult}=await import('../lib/ai/assistant-public-replies');expect(assistantPublicToolResult(actual)).toEqual({ok:false,message:ASSISTANT_PUBLIC_REPLIES.access});
  converse.mockResolvedValue(toolUse([{id:'private',name:'employee_profile',input:{employment_id:'ffffffff-ffff-4fff-bfff-ffffffffffff'}}]));const result=await askAssistant(ctx,{question:'Can you open this profile?'});expect(converse).not.toHaveBeenCalled();expect(result.toolsUsed).toEqual([]);expect(await auditOf(result.exchangeId)).toEqual([]);expect(sentToModel()).not.toContain('not_visible');
 });
 it('turns a raw native source exception into a generic failure before provider work without exposing its cause',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true),tool=ASSISTANT_TOOLS.find(t=>t.spec.name==='my_payslip_summary')!,raw='PRIVATE_DATABASE_ERROR_SENTINEL: SELECT salary FROM secret_table; provider-key-fragment',spy=vi.spyOn(tool,'run').mockRejectedValueOnce(Error(raw));
  try{await expect(askAssistant(ctx,{question:'My payslip'})).rejects.toMatchObject({code:'provider_error'});expect(spy).toHaveBeenCalledOnce();expect(converse).not.toHaveBeenCalled();expect(sentToModel()).not.toContain(raw);const [row]=await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.appUserId,ctx.userId!));expect(await auditOf(row.id)).toEqual([{name:tool.spec.name,input:{limit:1},rowCount:null,refusal:'tool_error'}]);expect(JSON.stringify(row)).not.toContain(raw);}finally{spy.mockRestore();}
 });
 it('does not send oversized native content to a provider or persist source rows',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true),tool=ASSISTANT_TOOLS.find(t=>t.spec.name==='my_payslip_summary')!,sentinel='OVERSIZED_CANONICAL_READ_SENTINEL',spy=vi.spyOn(tool,'run').mockResolvedValueOnce({ok:true,text:sentinel+'界'.repeat(23000)});
  try{await expect(askAssistant(ctx,{question:'My payslip'})).rejects.toMatchObject({code:'provider_error'});expect(spy).toHaveBeenCalledOnce();expect(converse).not.toHaveBeenCalled();expect(sentToModel()).not.toContain(sentinel);const [row]=await owner.db.select().from(schema.assistantExchange).where(eq(schema.assistantExchange.appUserId,ctx.userId!));expect(await auditOf(row.id)).toEqual([{name:tool.spec.name,input:{limit:1},rowCount:null,refusal:'tool_error'}]);expect(JSON.stringify(row)).not.toContain(sentinel);}finally{spy.mockRestore();}
 });
});

describe('model-selected conversational plan reaches current canonical facts',()=>{
 it('offers original source ordinals without values and reopens only the selected actual net fact',async()=>{
  const {ctx,net}=await employeeWithReleasedPayslip(true);converse.mockImplementationOnce(async(_cfg,args)=>{const catalogue=metadata(args),source=catalogue.reads[0],card=source.cards[0],selected=card.facts.find((fact:{field:string})=>fact.field==='net');expect(selected?.available).toBe(true);expect(JSON.stringify(args)).not.toContain(net);return{...end,text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'fact',read:source.read,card:card.card,fact:selected.fact}]})};});
  const res=await askAssistant(ctx,{question:'My payslip'}),workspace=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false}),conversation=workspace.history[0].grounded?.conversation;expect(conversation?.plan.mode).toBe('answer');expect(conversation?.facts).toHaveLength(1);const selected=conversation!.facts[0];expect(selected.view.state).toBe('ready');if(selected.view.state!=='ready')throw Error('canonical selected fact unavailable');expect(selected.view.presentation.cards[selected.card].facts[selected.fact]).toMatchObject({field:'net',value:Number(net)});expect(workspace.history[0].answer).toBeNull();
 });
 it('preserves a real local no-tool clarification instead of replacing it with a generic reply',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true),res=await askAssistant(ctx,{question:'Which pay period should we look at?'}),workspace=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});expect(workspace.history[0].grounded?.conversation).toEqual({plan:{version:1,mode:'clarify',slot:'module'},facts:[]});expect(await ownAssistantClarification(ctx,res.exchangeId,'March 2026')).toEqual({originalQuestion:'Which pay period should we look at?',slot:'module',answer:'March 2026',earlier:[]});expect(converse).not.toHaveBeenCalled();
 });
});

describe('a clarification retains earlier human turns locally (0658)',()=>{
 it('links replies chronologically while never disclosing human turns and permits an explicit own-task restart',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true),first=await askAssistant(ctx,{question:'How much was I paid?'}),second=await askAssistant(ctx,{question:'March 2026',clarificationExchangeId:first.exchangeId});
  const [stored]=await owner.db.select({continues:schema.assistantExchange.continuesExchangeId,question:schema.assistantExchange.question}).from(schema.assistantExchange).where(eq(schema.assistantExchange.id,second.exchangeId));expect(stored).toEqual({continues:first.exchangeId,question:'March 2026'});expect(await ownAssistantClarification(ctx,second.exchangeId,'Payroll')).toEqual({originalQuestion:'March 2026',slot:'module',answer:'Payroll',earlier:[{question:'How much was I paid?',slot:'module'}]});
  const third=await askAssistant(ctx,{question:'Payroll',clarificationExchangeId:second.exchangeId});expect(converse).not.toHaveBeenCalled();converse.mockResolvedValueOnce(end);const restarted=await askAssistant(ctx,{question:'My payslip',clarificationExchangeId:third.exchangeId});expect(converse).toHaveBeenCalledOnce();expect(restarted.toolsUsed).toEqual(['my_payslip_summary']);for(const human of ['How much was I paid?','March 2026','Payroll','My payslip'])expect(sentToModel()).not.toContain(human);expect(sentToModel()).not.toContain('humanClarification');
 });
 it('starts later when an earlier reply was cleared and never recreates it',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true),first=await askAssistant(ctx,{question:'Secret first question'}),second=await askAssistant(ctx,{question:'March 2026',clarificationExchangeId:first.exchangeId});await owner.db.delete(schema.assistantExchange).where(eq(schema.assistantExchange.id,first.exchangeId));const [stored]=await owner.db.select({continues:schema.assistantExchange.continuesExchangeId}).from(schema.assistantExchange).where(eq(schema.assistantExchange.id,second.exchangeId));expect(stored.continues).toBeNull();expect(await ownAssistantClarification(ctx,second.exchangeId,'Payroll')).toEqual({originalQuestion:'March 2026',slot:'module',answer:'Payroll',earlier:[]});expect(converse).not.toHaveBeenCalled();
 });
 it('refuses another login link and later re-pointing while permitting an unlinked same-login row',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true),mine=await askAssistant(ctx,{question:'Mine'}),row={tenantId:base.tenantId,appUserId:base.adminUserId,question:'Theirs',continuesExchangeId:mine.exchangeId};const {continuesExchangeId:_link,...unlinked}=row;await owner.db.insert(schema.assistantExchange).values(unlinked);await expect(owner.db.insert(schema.assistantExchange).values(row)).rejects.toThrow();const reply=await askAssistant(ctx,{question:'March 2026',clarificationExchangeId:mine.exchangeId}),third=await askAssistant(ctx,{question:'Another'});await expect(owner.db.update(schema.assistantExchange).set({continuesExchangeId:third.exchangeId}).where(eq(schema.assistantExchange.id,reply.exchangeId))).rejects.toThrow();expect(converse).not.toHaveBeenCalled();
 });
});

describe('actual model selection of current canonical explanation clauses',()=>{
 it('uses the actual payroll specialist and retires its explanation after module revocation',async()=>{
  const {ctx}=await employeeWithReleasedPayslip(true);converse.mockImplementationOnce(async(_cfg,args)=>{const catalogue=metadata(args),read=catalogue.reads[0],clause=read.explanations.find((row:{code:string})=>row.code==='specialist_finding:released_pay_stored_only');expect(clause,'actual source must offer this clause, not only register its code').toBeTruthy();return{...end,text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'explanation',read:read.read,card:clause.card,code:clause.code}]})};});
  const res=await askAssistant(ctx,{question:'Show current capabilities for payroll'}),reopened=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false}),conversation=reopened.history[0].grounded?.conversation;expect(conversation?.facts).toEqual([]);expect(conversation?.segments).toHaveLength(1);const segment=conversation!.segments![0];expect(segment.kind).toBe('explanation');if(segment.kind!=='explanation'||segment.view.state!=='ready')throw Error('actual explanation source unavailable');expect(segment.explanation.content).toEqual({kind:'specialist_finding',finding:'released_pay_stored_only'});expect(segment.view.answerExplanations).toContain(segment.explanation);
  await setModule(base.tenantId,'payroll',null);const retired=await loadAiWorkspace(ctx,{selectedExchangeId:res.exchangeId,includeGovernance:false});expect(retired.history[0].grounded?.conversation).toBeUndefined();expect(JSON.stringify(retired.history[0])).not.toContain('released_pay_stored_only');
 });
});
