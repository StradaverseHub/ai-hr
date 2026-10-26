/** Mocked provider only. Authored UNRUN; no provider credential or network is used by these cases. */
import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../lib/ai',()=>({generateDraft:vi.fn()}));
import {generateDraft} from '../lib/ai';
import {executePromptHoldout} from '../core/module-agent-prompt-harness';
import {adjudicatePromptReadPlan,promptCandidateSystem,PROMPT_HOLDOUTS} from '../lib/ai/module-agent-prompt-candidate';
import type {ResolvedAiConfig} from '../lib/ai/types';
const generated=vi.mocked(generateDraft);
const cfg:ResolvedAiConfig={provider:'openai',model:'fictional-model',apiKey:'fictional-test-key'};
const candidate={kind:'read_plan_prompt_v1',variant:'explicit_scope_v1'};
const answer=(question:string)=>{const expected=PROMPT_HOLDOUTS.find(row=>row.question===question)!;return JSON.stringify({decision:expected.decision,modules:expected.modules});};
beforeEach(()=>{generated.mockReset();generated.mockImplementation(async(_cfg,args)=>answer(args.prompt));});
describe('candidate prompt is actually exercised against independent expected typed plans',()=>{
 it('runs the exact candidate prompt and all fixed synthetic questions, never a model self-score',async()=>{
  const report=await executePromptHoldout(candidate,cfg);
  expect(generated).toHaveBeenCalledTimes(PROMPT_HOLDOUTS.length);
  expect(report).toMatchObject({state:'complete',completedRequests:12,completedCases:12,retainedPasses:0,securityFailures:0,qualityFailures:0});
  for(const [,args] of generated.mock.calls){expect(args.system).toBe(promptCandidateSystem(candidate));expect(PROMPT_HOLDOUTS.some(row=>row.question===args.prompt)).toBe(true);}
  expect(promptCandidateSystem({kind:'read_plan_prompt_v1',variant:'concise_v1'})).not.toBe(promptCandidateSystem(candidate));
 });
 it('fails a schema-valid cross-person plan and rejects arbitrary ratings, targets, effects and money',async()=>{
  generated.mockImplementation(async(_cfg,args)=>args.prompt===PROMPT_HOLDOUTS[9].question?JSON.stringify({decision:'read',modules:['payroll']}):answer(args.prompt));
  const report=await executePromptHoldout(candidate,cfg);
  expect(report.securityFailures).toBe(1);expect(report.qualityFailures).toBe(1);
  for(const value of [{decision:'read',modules:['payroll'],score:1}, {decision:'read',modules:['employees'],employeeId:'peer'},
   {decision:'read',modules:['payroll'],netPay:5000},{decision:'approve',modules:['leave']},{decision:'refuse',modules:['payroll']},
   {decision:'read',modules:['leave','leave']},{decision:'read',modules:['unknown']}])expect(()=>adjudicatePromptReadPlan(JSON.stringify(value))).toThrow();
 });
 it('keeps incomplete/unrun coverage unknown and resumes only failed or unrun exact-input cases',async()=>{
  generated.mockImplementationOnce(async()=>answer(PROMPT_HOLDOUTS[0].question)).mockRejectedValueOnce(Error('fictional unavailable transport'));
  const incomplete=await executePromptHoldout(candidate,cfg);
  expect(incomplete).toMatchObject({state:'incomplete',attemptedRequests:2,completedRequests:1,completedCases:1,qualityFailures:null,securityFailures:null});
  generated.mockClear();const resumed=await executePromptHoldout(candidate,cfg,incomplete);
  expect(generated).toHaveBeenCalledTimes(11);expect(generated.mock.calls.some(([,args])=>args.prompt===PROMPT_HOLDOUTS[0].question)).toBe(false);
  expect(resumed).toMatchObject({state:'complete',attemptedRequests:11,completedRequests:11,completedCases:12,retainedPasses:1,securityFailures:0,qualityFailures:0});
 });
 it('cannot treat a retained pass under another suite digest as reusable coverage',async()=>{
  const first=await executePromptHoldout(candidate,cfg);generated.mockClear();
  await executePromptHoldout(candidate,cfg,{...first,suiteDigest:'changed'});
  expect(generated).toHaveBeenCalledTimes(12);
 });
});
