/** Source custody + projection/cache unit contracts, authored UNRUN. Mock carrier is NOT RLS proof. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {SessionContext} from '../db/client';
import type {AssistantReadSession} from '../core/assistant-read-session';
const state=vi.hoisted(()=>({allowed:true,payload:{ok:true,employee:{name:'Canonical person',employeeCode:'CANONICAL-7',company:'Current company',hiredOn:'2020-01-01'}} as unknown}));
vi.mock('../core/module-agent-releases',()=>({reopenGovernedModuleReadJobTx:vi.fn()}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:vi.fn(async(_ctx:unknown,_module:unknown,consume:(read:unknown)=>Promise<unknown>,existing:unknown)=>{
 if(!state.allowed||!existing)throw Error('PRIVATE_AUTHORIZATION_ERROR');return consume(existing);
})}));
vi.mock('../core/assistant-tools',()=>({toolsFor:()=>[{module:'employees',spec:{name:'employee_profile'},run:vi.fn(async()=>state.payload)}]}));
import {withAssistantRead} from '../core/assistant-read-session';
import {workspaceGroundedAnswers} from '../core/workspace-grounded-answers';
import {assertCanonicalModuleJobView} from '../core/workspace-module-jobs';
import {assistantSourceDigest,sealAssistantDisclosure} from '../lib/ai/assistant-disclosure';
import {syntheticAssistantProposalCaller,type AssistantProposalCaller} from '../lib/ai/assistant-action-catalogue';
const ctx:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user',roles:['employee']};
const session={} as AssistantReadSession;
function fixture(answer='MODEL_INVENTED_PAY_999999_AND_APPROVED_LEAVE',names=['employee_profile']){
 const binding={tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:randomUUID(),question:'Show my work profile',answer};
 const reads=names.map(name=>({name,input:{employment_id:'fictional-subject'},digest:assistantSourceDigest(state.payload)}));
 return {binding,receipt:sealAssistantDisclosure(binding,reads)};
}
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('AI_CONFIG_SECRET','fictional-grounded-unit-secret');state.allowed=true;state.payload={ok:true,employee:{name:'Canonical person',employeeCode:'CANONICAL-7',company:'Current company',hiredOn:'2020-01-01'}};});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
describe('sealed source plans nominate current typed facts, never certify model prose',()=>{
 it('displays exact current canonical facts while dropping numeric and effect claims invented by the stored model',async()=>{
  const {binding,receipt}=fixture();const result=await workspaceGroundedAnswers(ctx,session)(binding,receipt);
  expect(result.mode).toBe('grounded');expect(JSON.stringify(result)).toContain('CANONICAL-7');
  expect(JSON.stringify(result)).not.toContain(binding.answer);expect(JSON.stringify(result)).not.toContain('999999');
  expect(JSON.stringify(result)).not.toContain('fictional-subject');expect(JSON.stringify(result)).not.toContain(receipt!);
  expect(()=>assertCanonicalModuleJobView(result.views[0],ctx)).not.toThrow();
 });
 it('deduplicates exact lookups only within this actor/carrier instance and rechecks in a later request',async()=>{
  const first=fixture(undefined,['employee_profile','employee_profile']),second=fixture();const replay=workspaceGroundedAnswers(ctx,session);
  expect((await replay(first.binding,first.receipt)).views).toHaveLength(1);expect((await replay(second.binding,second.receipt)).views).toHaveLength(1);
  expect(vi.mocked(withAssistantRead).mock.calls.filter(call=>call[1]==='employees')).toHaveLength(1);await workspaceGroundedAnswers(ctx,session)(second.binding,second.receipt);expect(vi.mocked(withAssistantRead).mock.calls.filter(call=>call[1]==='employees')).toHaveLength(2);
  const other=await workspaceGroundedAnswers({...ctx,userId:'other-user'},session)(first.binding,first.receipt);expect(other.mode).toBe('unavailable');expect(other.views).toEqual([]);
 });
 it('rechecks authority before a cached view can be reused even in the same bounded carrier',async()=>{
  const first=fixture(),second=fixture(),replay=workspaceGroundedAnswers(ctx,session);
  expect((await replay(first.binding,first.receipt)).mode).toBe('grounded');state.allowed=false;
  expect(await replay(second.binding,second.receipt)).toMatchObject({mode:'unavailable',views:[]});
 });
 it('withholds legacy/swapped receipts, current changed fields and current authorization failures without error details',async()=>{
  const {binding,receipt}=fixture();const replay=workspaceGroundedAnswers(ctx,session);
  expect((await replay(binding,null)).mode).toBe('unavailable');expect((await replay({...binding,answer:'FORGED'},receipt)).mode).toBe('unavailable');
  state.payload={ok:true,employee:{name:'Changed current name',employeeCode:'CANONICAL-7'}};
  const changed=await workspaceGroundedAnswers(ctx,session)(binding,receipt);expect(changed.mode).toBe('unavailable');expect(JSON.stringify(changed)).not.toContain('Changed current name');
  state.allowed=false;const denied=await workspaceGroundedAnswers(ctx,session)(binding,receipt);expect(denied.mode).toBe('unavailable');expect(JSON.stringify(denied)).not.toContain('PRIVATE_AUTHORIZATION_ERROR');
 });
 it('source-free provenance gets fixed generic mode, never arbitrary ungrounded HR prose',async()=>{
  const binding={...fixture().binding,answer:'UNTRUSTED_SOURCE_FREE_PAY_77777'};const receipt=sealAssistantDisclosure(binding,[]);
  const result=await workspaceGroundedAnswers(ctx,session)(binding,receipt);expect(result).toMatchObject({mode:'generic',views:[],tools:[]});
  expect(JSON.stringify(result)).not.toContain(binding.answer);expect(vi.mocked(withAssistantRead).mock.calls.filter(call=>call[1]!==null)).toHaveLength(0);
 });
 it('unknown and safely unrenderable tools do not become facts, and bounded known fallback jobs remain available',async()=>{
  const {binding,receipt}=fixture(undefined,['my_pay_change','unknown_future_tool']);const result=await workspaceGroundedAnswers(ctx,session)(binding,receipt);
  expect(result).toMatchObject({mode:'unavailable',views:[],fallbackModules:['payroll'],partial:true});expect(result.tools).toEqual([]);
 });
 it('R6: replays a sealed proposal against the CURRENT catalogue and marks it stale, never preparable, once it is no longer offered',async()=>{
  const plan={version:1,mode:'propose',action:'leave.cancel',hints:{startDate:'2026-11-03'}} as const;
  const binding={...fixture().binding,answer:JSON.stringify(plan)};const receipt=sealAssistantDisclosure(binding,[],plan);
  const offered=await workspaceGroundedAnswers(ctx,session,undefined,syntheticAssistantProposalCaller(['leave']))(binding,receipt);
  expect(offered).toMatchObject({mode:'generic',conversation:{plan,facts:[]}});expect(offered.conversation?.proposalStale).toBeUndefined();
  const changed:AssistantProposalCaller[]=[{readableModules:['leave'],actors:['self'],pausedKeys:['hr_assistant']},
   {readableModules:['claims'],actors:['self'],pausedKeys:[]},{readableModules:['leave'],actors:['hr_admin'],pausedKeys:[]}];
  for(const caller of changed){
   const stale=await workspaceGroundedAnswers(ctx,session,undefined,caller)(binding,receipt);
   expect(stale.mode,JSON.stringify(caller)).toBe('generic');expect(stale.conversation).toEqual({plan,proposalStale:true,facts:[]});
  }
  // Facts that could not be read (null, or omitted) are NOT "no longer offered": neutral and retryable instead.
  for(const replay of[workspaceGroundedAnswers(ctx,session,undefined,null),workspaceGroundedAnswers(ctx,session)]){
   const unknown=await replay(binding,receipt);expect(unknown.mode).toBe('generic');expect(unknown.conversation).toEqual({plan,proposalUnverified:true,facts:[]});
  }
 });
});
