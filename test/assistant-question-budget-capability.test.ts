/** The opaque TypeScript binding only; SQL atomicity/authority require the DB integration suite. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Tx,SessionContext} from '../db/client';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {AiAllowanceError,AiGatewayError} from '../lib/ai/types';
const h=vi.hoisted(()=>({check:undefined as undefined|((tx:unknown,request:unknown)=>Promise<void>)}));
vi.mock('../core/ai-governance',()=>({withAiAdmissionCheck:(cfg:object,_feature:string,check:typeof h.check)=>{h.check=check;return Object.freeze({...cfg});}}));
import {issueAssistantQuestionBudget,bindAssistantQuestionBudgetTx,assistantQuestionBudgetBinding,completeAssistantQuestionBudgetTx,AssistantQuestionBudgetError} from '../core/assistant-question-budget';
const ctx:SessionContext={tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',roles:['employee']};
const root='00000000-0000-4000-8000-000000000003',exchange='00000000-0000-4000-8000-000000000004';
const cfg={provider:'openai',model:'fictional',apiKey:'not-a-real-key'} as ResolvedAiConfig;
const tx=(rows:unknown[])=>({execute:vi.fn(async()=>rows)}) as unknown as Tx;
const reservation=()=>({period:'2026-11',reserved_at:'2026-10-31T16:00:00.000Z',blocked_reason:null});
beforeEach(()=>{h.check=undefined;});
describe('Assistant question quota capability and HR clock',()=>{
 it('uses Malaysia November at UTC October boundary and preserves only the native configuration binding',async()=>{
  const token=issueAssistantQuestionBudget(ctx,root),bound=await bindAssistantQuestionBudgetTx(tx([reservation()]),ctx,cfg,token);
  expect(bound.period).toBe('2026-11');expect(assistantQuestionBudgetBinding(ctx,bound.configuration)).toEqual({period:'2026-11',reservation:token});
  expect(()=>assistantQuestionBudgetBinding(ctx,{...bound.configuration})).toThrow(AiGatewayError);
  expect(()=>assistantQuestionBudgetBinding({...ctx,userId:exchange},bound.configuration)).toThrow(AiGatewayError);
  await expect(bindAssistantQuestionBudgetTx(tx([reservation()]),ctx,cfg,token)).rejects.toThrow('already bound');
 });
 it('refuses cloned tokens and invalid HR periods without issuing a usable configuration',async()=>{
  const token=issueAssistantQuestionBudget(ctx,root);
  await expect(bindAssistantQuestionBudgetTx(tx([reservation()]),ctx,cfg,{...token})).rejects.toThrow(AiGatewayError);
  await expect(bindAssistantQuestionBudgetTx(tx([{...reservation(),period:'2026-10'}]),ctx,cfg,token)).rejects.toThrow(AiGatewayError);
 });
 it.each(['budget_daily','budget_monthly'] as const)('keeps %s distinct from generic AI controls',async blocked_reason=>{
  const promise=bindAssistantQuestionBudgetTx(tx([{...reservation(),blocked_reason}]),ctx,cfg,issueAssistantQuestionBudget(ctx,root));
  await expect(promise).rejects.toBeInstanceOf(AiAllowanceError);
  await expect(promise).rejects.toMatchObject({budgetCode:blocked_reason});
 });
 it('rechecks every conversation admission and refuses other operations or unknown storage replies',async()=>{
  await bindAssistantQuestionBudgetTx(tx([reservation()]),ctx,cfg,issueAssistantQuestionBudget(ctx,root));
  expect(h.check).toBeTypeOf('function');
  await expect(h.check!(tx([{allowed:true,blocked_reason:null}]),{operation:'conversation',reservedTokens:12})).resolves.toBeUndefined();
  await expect(h.check!(tx([{allowed:false,blocked_reason:'budget_monthly'}]),{operation:'conversation',reservedTokens:12})).rejects.toBeInstanceOf(AssistantQuestionBudgetError);
  await expect(h.check!(tx([{allowed:true,blocked_reason:null}]),{operation:'draft',reservedTokens:12})).rejects.toThrow(AiGatewayError);
  await expect(h.check!(tx([]),{operation:'conversation',reservedTokens:12})).rejects.toThrow(AiGatewayError);
 });
 it('never exposes driver text or completes an unbound question',async()=>{
  const token=issueAssistantQuestionBudget(ctx,root);
  await expect(completeAssistantQuestionBudgetTx(tx([]),ctx,token,exchange)).rejects.toThrow(AiGatewayError);
  const broken={execute:async()=>{throw Error('DRIVER SQL PRIVATE PARAMETERS');}} as unknown as Tx;
  await expect(bindAssistantQuestionBudgetTx(broken,ctx,cfg,token)).rejects.toThrow('The Assistant question budget could not be confirmed.');
 });
});
