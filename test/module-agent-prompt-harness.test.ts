/** Mocked provider only. Authored UNRUN; no provider credential or network is used by these cases. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../lib/ai',()=>({generateDraft:vi.fn()}));
import {generateDraft} from '../lib/ai';
import {executePromptHoldout} from '../core/module-agent-prompt-harness';
import {adjudicatePromptReadPlan,promptCandidateSystem,PROMPT_HOLDOUTS,PROMPT_HOLDOUT_REQUEST_LIMIT,PROMPT_HOLDOUT_LOCALES} from '../lib/ai/module-agent-prompt-candidate';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import type {ResolvedAiConfig} from '../lib/ai/types';
const generated=vi.mocked(generateDraft);
const cfg:ResolvedAiConfig={provider:'openai',model:'fictional-model',apiKey:'fictional-test-key'};
const candidate={kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'};
const answer=(question:string)=>{const expected=PROMPT_HOLDOUTS.find(row=>row.question===question)!;return JSON.stringify({decision:expected.decision,modules:expected.modules});};
async function complete(prior?:Awaited<ReturnType<typeof executePromptHoldout>>){
 for(let batch=0;batch<=Math.ceil(PROMPT_HOLDOUTS.length/PROMPT_HOLDOUT_REQUEST_LIMIT);batch++){
  const next=await executePromptHoldout(candidate,cfg,prior);if(next.state==='complete')return next;prior=next;
 }throw Error('Mocked complete synthetic coverage was not reached.');
}
const peer=()=>PROMPT_HOLDOUTS.find(row=>row.id==='reject-peer')!;
beforeEach(()=>{generated.mockReset();generated.mockImplementation(async(_cfg,args)=>answer(args.prompt));});
describe('candidate prompt is actually exercised against independent expected typed plans',()=>{
 it('assembles all20 actual module expectations and four security refusals in each of six locales',()=>{
  expect(PROMPT_HOLDOUTS).toHaveLength(144);expect(new Set(PROMPT_HOLDOUTS.map(row=>row.id)).size).toBe(144);
  expect(new Set(PROMPT_HOLDOUTS.map(row=>row.question)).size).toBe(144);
  for(const locale of PROMPT_HOLDOUT_LOCALES){
   const cases=PROMPT_HOLDOUTS.filter(row=>row.locale===locale),positive=cases.filter(row=>!row.security),security=cases.filter(row=>row.security);
   expect(positive).toHaveLength(20);expect(positive.every(row=>row.decision==='read'&&row.modules.length===1)).toBe(true);
   expect(positive.flatMap(row=>row.modules).sort()).toEqual([...AGENT_MODULE_CODES].sort());
   expect(security).toHaveLength(4);expect(security.every(row=>row.decision==='refuse'&&row.modules.length===0)).toBe(true);
  }
  expect(generated).not.toHaveBeenCalled();
 });
 it('runs the exact candidate prompt and all fixed synthetic questions, never a model self-score',async()=>{
  const report=await complete();
  expect(generated).toHaveBeenCalledTimes(PROMPT_HOLDOUTS.length);
  expect(report).toMatchObject({state:'complete',completedCases:PROMPT_HOLDOUTS.length,retainedFailures:0,securityFailures:0,qualityFailures:0});
  for(const [,args] of generated.mock.calls){expect(args.system).toBe(promptCandidateSystem(candidate));expect(PROMPT_HOLDOUTS.some(row=>row.question===args.prompt)).toBe(true);}
  expect(promptCandidateSystem({kind:'read_plan_prompt_v1',variant:'concise_v1'})).not.toBe(promptCandidateSystem(candidate));
 });
 it('fails a schema-valid cross-person plan and rejects arbitrary ratings, targets, effects and money',async()=>{
  generated.mockImplementation(async(_cfg,args)=>args.prompt===peer().question?JSON.stringify({decision:'read',modules:['payroll']}):answer(args.prompt));
  const report=await complete();
  expect(report.securityFailures).toBe(1);expect(report.qualityFailures).toBe(1);
  for(const value of [{decision:'read',modules:['payroll'],score:1}, {decision:'read',modules:['employees'],employeeId:'peer'},
   {decision:'read',modules:['payroll'],netPay:5000},{decision:'approve',modules:['leave']},{decision:'refuse',modules:['payroll']},
   {decision:'read',modules:['leave','leave']},{decision:'read',modules:['unknown']}])expect(()=>adjudicatePromptReadPlan(JSON.stringify(value))).toThrow();
 });
 it('keeps incomplete/unrun coverage unknown and resumes only failed or unrun exact-input cases',async()=>{
  generated.mockImplementationOnce(async()=>answer(PROMPT_HOLDOUTS[0].question)).mockRejectedValueOnce(Error('fictional unavailable transport'));
  const incomplete=await executePromptHoldout(candidate,cfg);
  expect(incomplete).toMatchObject({state:'incomplete',attemptedRequests:2,completedRequests:1,completedCases:1,qualityFailures:null,securityFailures:null});
  generated.mockClear();const resumed=await complete(incomplete);
  expect(generated).toHaveBeenCalledTimes(PROMPT_HOLDOUTS.length-1);expect(generated.mock.calls.some(([,args])=>args.prompt===PROMPT_HOLDOUTS[0].question)).toBe(false);
  expect(resumed).toMatchObject({state:'complete',completedCases:PROMPT_HOLDOUTS.length,retainedFailures:0,securityFailures:0,qualityFailures:0});
 });
 it('cannot treat a retained pass under another suite digest as reusable coverage',async()=>{
  const first=await complete();generated.mockClear();
  await executePromptHoldout(candidate,cfg,{...first,suiteDigest:'changed'});
  expect(generated).toHaveBeenCalledTimes(PROMPT_HOLDOUT_REQUEST_LIMIT);
 });

 it('bounds each explicit invocation and retains known failures while finishing genuinely unrun coverage first',async()=>{
  generated.mockImplementation(async(_cfg,args)=>args.prompt===peer().question?JSON.stringify({decision:'read',modules:['payroll']}):answer(args.prompt));
  const first=await executePromptHoldout(candidate,cfg);
  expect(first).toMatchObject({state:'incomplete',attemptedRequests:PROMPT_HOLDOUT_REQUEST_LIMIT,securityFailures:null,qualityFailures:null});
  expect(first.cases.find(row=>row.id==='reject-peer')).toMatchObject({state:'failed',securityFailure:true});
  generated.mockClear();const next=await executePromptHoldout(candidate,cfg,first);
  expect(next.retainedFailures).toBe(1);expect(next.cases.find(row=>row.id==='reject-peer')).toMatchObject({state:'failed',retained:true});
  expect(generated.mock.calls.some(([,args])=>args.prompt===peer().question)).toBe(false);
  expect(generated.mock.calls.length).toBeLessThanOrEqual(PROMPT_HOLDOUT_REQUEST_LIMIT);
  const failed=await complete(next);expect(failed).toMatchObject({state:'complete',completedCases:PROMPT_HOLDOUTS.length,qualityFailures:1,securityFailures:1});
  generated.mockClear();generated.mockRejectedValueOnce(Error('fictional retry unavailable'));
  const unavailable=await executePromptHoldout(candidate,cfg,failed);
  expect(generated).toHaveBeenCalledTimes(1);
  expect(unavailable).toMatchObject({state:'incomplete',attemptedRequests:1,completedRequests:0,unavailableAttempts:1,completedCases:PROMPT_HOLDOUTS.length,retainedFailures:1,qualityFailures:null,securityFailures:null});
  expect(unavailable.cases.find(row=>row.id==='reject-peer')).toMatchObject({...failed.cases.find(row=>row.id==='reject-peer'),retained:true});
  generated.mockClear();generated.mockImplementation(async(_cfg,args)=>answer(args.prompt));
  const repaired=await executePromptHoldout(candidate,cfg,unavailable);
  expect(generated).toHaveBeenCalledTimes(1);expect(repaired).toMatchObject({state:'complete',retainedPasses:PROMPT_HOLDOUTS.length-1,retainedFailures:0,qualityFailures:0,securityFailures:0});
 });
});
