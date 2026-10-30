/** Mocked protocol/measurement cases only; not real provider admission or quality evidence. Authored UNRUN. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../lib/ai',()=>({generateDraft:vi.fn()}));
// Only this isolated unit suite substitutes capability issuance; DB suite uses real governance.
vi.mock('../core/ai-governance',()=>({
 withAiAdmissionLifecycle:(cfg:unknown)=>cfg,
 preparePrivateAiTask:async(configuration:ResolvedAiConfig,id:string,read:()=>Promise<unknown>)=>{
  const {getProviderWorkloadDescriptor}=await import('../lib/ai/provider-workload-policy');
  const descriptor=getProviderWorkloadDescriptor(id)!;
  return {configuration,operation:descriptor.operation,...descriptor.capture(await read()),dispose(){}};
 },
}));
import {generateDraft} from '../lib/ai';
import {executePromptHoldout} from '../core/module-agent-prompt-harness';
import {adjudicatePromptReadPlan,promptCandidateSystem,PROMPT_BASELINE,PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_HOLDOUT_LOCALES} from '../lib/ai/module-agent-prompt-candidate';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import type {ResolvedAiConfig} from '../lib/ai/types';
const generated=vi.mocked(generateDraft),cfg:ResolvedAiConfig={provider:'openai',model:'fictional-model',apiKey:'fictional-unit-key'};
const candidate={kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'},baseSystem=promptCandidateSystem(PROMPT_BASELINE),candidateSystem=promptCandidateSystem(candidate);
const answer=(question:string)=>{const expected=PROMPT_HOLDOUTS.find(row=>row.question===question)!;return JSON.stringify({decision:expected.decision,modules:expected.modules});};
async function complete(prior?:Awaited<ReturnType<typeof executePromptHoldout>>){for(let batch=0;batch<=Math.ceil(2*PROMPT_HOLDOUTS.length/PROMPT_HOLDOUT_REQUEST_LIMIT);batch++){const next=await executePromptHoldout(candidate,cfg,prior);if(next.state==='complete')return next;prior=next;}throw Error('Paired synthetic coverage not complete.');}
beforeEach(()=>{generated.mockReset();generated.mockImplementation(async(_cfg,args)=>answer(args.prompt));});
describe('paired independently adjudicated prompt measurement',()=>{
 it('keeps20 module expectations and4 refusal expectations per locale independent of both prompts',()=>{expect(PROMPT_HOLDOUTS).toHaveLength(144);for(const locale of PROMPT_HOLDOUT_LOCALES){const fixtures=PROMPT_HOLDOUTS.filter(row=>row.locale===locale);expect(fixtures.filter(row=>!row.security).flatMap(row=>row.modules).sort()).toEqual([...AGENT_MODULE_CODES].sort());expect(fixtures.filter(row=>row.security)).toHaveLength(4);}expect(generated).not.toHaveBeenCalled();});
 it('runs both exact arms under one12-call budget and refuses equal perfect behavior as improvement',async()=>{
  const first=await executePromptHoldout(candidate,cfg);expect(generated).toHaveBeenCalledTimes(12);expect(first.completedCases).toBe(6);expect(first.state).toBe('incomplete');
  const report=await complete(first);expect(generated).toHaveBeenCalledTimes(2*PROMPT_HOLDOUTS.length);expect(report).toMatchObject({state:'complete',completedCases:144,qualityFailures:0,securityFailures:0,comparison:{qualityImproved:false,baseline:{correct:144,tokens:null,costCredits:null},candidate:{correct:144,tokens:null,costCredits:null}}});
  for(const [,args] of generated.mock.calls){expect([baseSystem,candidateSystem]).toContain(args.system);expect(PROMPT_HOLDOUTS.some(row=>row.question===args.prompt)).toBe(true);}
 });
 it('requires an actual strict independently expected quality gain; a mocked counterexample tests the gate, not production improvement',async()=>{
  generated.mockImplementation(async(_cfg,args)=>args.system===baseSystem&&args.prompt===PROMPT_HOLDOUTS[0].question?JSON.stringify({decision:'read',modules:['employees']}):answer(args.prompt));
  const report=await complete();expect(report.comparison).toMatchObject({qualityImproved:true,baseline:{correct:143},candidate:{correct:144}});expect(report.cases.find(row=>row.id===PROMPT_HOLDOUTS[0].id&&row.arm==='baseline')?.state).toBe('failed');
 });
 it('does not turn a candidate security failure or a model self-rating into quality improvement',async()=>{
  const peer=PROMPT_HOLDOUTS.find(row=>row.id==='reject-peer')!;generated.mockImplementation(async(_cfg,args)=>args.system===candidateSystem&&args.prompt===peer.question?JSON.stringify({decision:'read',modules:['payroll']}):answer(args.prompt));
  const report=await complete();expect(report).toMatchObject({securityFailures:1,qualityFailures:1,comparison:{qualityImproved:false}});
  for(const value of [{decision:'read',modules:['payroll'],score:1},{decision:'read',modules:['employees'],employeeId:'peer'},{decision:'read',modules:['payroll'],netPay:5000}])expect(()=>adjudicatePromptReadPlan(JSON.stringify(value))).toThrow();
 });
 it('retains the exact passing arm when its partner is unavailable, without rerunning it or calling incomplete coverage complete',async()=>{
  generated.mockRejectedValueOnce(Error('fictional first-arm transport failure'));const unavailable=await executePromptHoldout(candidate,cfg);expect(unavailable).toMatchObject({state:'incomplete',attemptedRequests:1,completedRequests:0,completedCases:0,qualityFailures:null});
  generated.mockClear();generated.mockImplementationOnce(async()=>answer(PROMPT_HOLDOUTS[0].question)).mockRejectedValueOnce(Error('fictional partner failure'));
  const partial=await executePromptHoldout(candidate,cfg);expect(partial).toMatchObject({completedCases:0,completedRequests:1,state:'incomplete'});
  generated.mockClear();const report=await complete(partial);expect(generated).toHaveBeenCalledTimes(287);expect(generated.mock.calls.filter(([,args])=>args.prompt===PROMPT_HOLDOUTS[0].question&&args.system===baseSystem)).toHaveLength(0);expect(report.state).toBe('complete');
 });
 it('finishes unrun arms before retrying failures and retains all exact passing arms on a failed-only retry',async()=>{
  generated.mockImplementation(async(_cfg,args)=>args.system===candidateSystem&&args.prompt===PROMPT_HOLDOUTS[0].question?JSON.stringify({decision:'refuse',modules:[]}):answer(args.prompt));
  const first=await executePromptHoldout(candidate,cfg);expect(first.cases.find(row=>row.id===PROMPT_HOLDOUTS[0].id&&row.arm==='candidate')?.state).toBe('failed');
  generated.mockClear();const next=await executePromptHoldout(candidate,cfg,first);expect(generated.mock.calls.some(([,args])=>args.prompt===PROMPT_HOLDOUTS[0].question)).toBe(false);expect(next.retainedFailures).toBe(1);
  const failed=await complete(next);generated.mockClear();generated.mockImplementation(async(_cfg,args)=>answer(args.prompt));const repaired=await executePromptHoldout(candidate,cfg,failed);
  expect(generated).toHaveBeenCalledTimes(1);expect(repaired).toMatchObject({state:'complete',attemptedRequests:1,retainedPasses:287,retainedFailures:0,comparison:{qualityImproved:false}});
 });
 it('refuses retention under changed suite or candidate configuration binding',async()=>{const report=await complete();generated.mockClear();await executePromptHoldout(candidate,cfg,{...report,suiteDigest:'changed'});expect(generated).toHaveBeenCalledTimes(12);generated.mockClear();await executePromptHoldout(PROMPT_BASELINE,cfg,report);expect(generated).toHaveBeenCalledTimes(12);});
});
