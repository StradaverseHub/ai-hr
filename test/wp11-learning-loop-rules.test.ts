/** WP11 (R5): pure rules — the AI source-manifest boundary and the measured outcome regression rule. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {AI_SOURCE_MANIFEST_OUTPUT,aiSourceDigest,aiSourceFiles,isAiSourceFile} from '../scripts/ai-agent-source-scope.mjs';
import {MODULE_AGENT_SOURCE_FILE_COUNT} from '../lib/ai/module-agent-source-manifest';
import {PROMOTION_OUTCOME_POLICY,earlierWindow,outcomeRegressed,outcomeWindow,promotionOutcomeKinds,type OutcomeCountRow} from '../lib/ai/promotion-outcome-regression';
import {AGENT_PROMOTION_SCOPES,isAgentPromotionScope} from '../lib/ai/agent-promotion-scope';
import {NATIVE_OUTCOME_ACTIONS} from '../lib/ai/module-native-outcomes';

describe('AI source manifest boundary (scripts/ai-agent-source-scope.mjs)',()=>{
 it('names an explicit AI behaviour surface and excludes ordinary product files',()=>{
  for(const name of ['lib/ai/module-specialists.ts','lib/ai/assistant-conversation-holdouts.ts','lib/assistant-actions/own-leave-contract.ts','core/module-agent-releases.ts','core/module-specialist-harness.ts','core/module-native-outcome-references.ts',
   'core/assistant-tools.ts','core/assistant-actions/own-leave-store.ts','core/ai-governance.ts','core/agent-principal.ts','packs/catalog.ts','scripts/ai-agent-source-manifest.mjs','scripts/ai-agent-source-scope.mjs',
   'db/migrations/0627_module_agent_improvement.sql','db/migrations/0628_employee_import_ai_evaluation.sql','db/migrations/0815_assistant_learning_loop_scope.sql','db/migrations/0642_module_specialist_diagnostic_playbook.sql'])expect(isAiSourceFile(name),name).toBe(true);
  for(const name of ['packs/payroll/service.ts','core/read.ts','core/leave.ts','app/assistant/page.tsx','messages/en.json','db/migrations/0684_ocbc_bank_payment_exports.sql','db/migrations/0687_maintenance_window.sql',
   'db/migrations/meta/_journal.json','test/wp11-learning-loop.test.ts','core/aircraft.ts','lib/ai/README.md','.github/workflows/x.json',AI_SOURCE_MANIFEST_OUTPUT])expect(isAiSourceFile(name),name).toBe(false);
 });
 it('a change in a non-AI file does not invalidate the digest; a change in an AI file does',()=>{
  const tree=new Map([['lib/ai/module-specialists.ts','export const specialist=1;'],['core/module-agent-releases.ts','owner'],['packs/payroll/service.ts','payroll v1'],['messages/en.json','{"a":"b"}'],['db/migrations/0684_ocbc_bank_payment_exports.sql','select 1;']]);
  const digest=(files:Map<string,string>)=>aiSourceDigest(aiSourceFiles([...files.keys()]).map((name:string)=>[name,createHash('sha256').update(files.get(name)!).digest('hex')]));
  const original=digest(tree);
  expect(aiSourceFiles([...tree.keys()])).toEqual(['core/module-agent-releases.ts','lib/ai/module-specialists.ts']);
  for(const [name,bytes] of [['packs/payroll/service.ts','payroll v2'],['messages/en.json','{"a":"c"}'],['db/migrations/0684_ocbc_bank_payment_exports.sql','select 2;'],['app/new-screen.tsx','new']] as const)expect(digest(new Map(tree).set(name,bytes)),name).toBe(original);
  expect(digest(new Map(tree).set('lib/ai/module-specialists.ts','export const specialist=2;'))).not.toBe(original);
  expect(digest(new Map(tree).set('lib/ai/new-holdouts.ts','new'))).not.toBe(original);
 });
 it('the checked-in manifest is generated from the scoped surface, not the whole repository',()=>{
  expect(MODULE_AGENT_SOURCE_FILE_COUNT).toBeGreaterThan(100);expect(MODULE_AGENT_SOURCE_FILE_COUNT).toBeLessThan(2000);
  expect(readFileSync('lib/ai/module-agent-source-manifest.ts','utf8')).toContain('AI behaviour surface');
 });
});

describe('measured outcome regression rule (lib/ai/promotion-outcome-regression.ts)',()=>{
 const row=(action_kind:string,c:Partial<OutcomeCountRow>):OutcomeCountRow=>({action_kind,completed:0,discarded:0,expired:0,refused:0,reversed:null,...c});
 it('maps a specialist to its own module actions and the Assistant to every action',()=>{
  expect([...promotionOutcomeKinds('leave')].sort()).toEqual(Object.entries(NATIVE_OUTCOME_ACTIONS).filter(([,v])=>v.module==='leave').map(([k])=>k).sort());
  expect(promotionOutcomeKinds('assistant')).toHaveLength(Object.keys(NATIVE_OUTCOME_ACTIONS).length);
  expect(promotionOutcomeKinds('system_explorer')).toEqual([]);
 });
 it('counts settled and unsuccessful outcomes, with proven reversals unsuccessful and unknown reversals never successful',()=>{
  const kinds=['leave.apply','leave.cancel'];
  expect(outcomeWindow([row('leave.apply',{completed:4,discarded:1,expired:1,refused:1,reversed:2}),row('leave.cancel',{completed:2,reversed:null}),row('claims.submit',{discarded:9})],kinds)).toEqual({settled:9,unsuccessful:5});
  expect(earlierWindow({settled:10,unsuccessful:3},{settled:12,unsuccessful:5})).toEqual({settled:0,unsuccessful:0});
  expect(earlierWindow({settled:20,unsuccessful:9},{settled:12,unsuccessful:2})).toEqual({settled:8,unsuccessful:7});
 });
 it('regresses only with the minimum sample in both windows and at least the policy rise, deterministically',()=>{
  expect(PROMOTION_OUTCOME_POLICY).toEqual({version:1,minimumSettledPerWindow:10,regressionPercentagePoints:20});
  expect(outcomeRegressed({settled:10,unsuccessful:0},{settled:12,unsuccessful:6})).toBe(true);
  expect(outcomeRegressed({settled:10,unsuccessful:0},{settled:9,unsuccessful:9})).toBe(false);   // during below sample
  expect(outcomeRegressed({settled:9,unsuccessful:0},{settled:30,unsuccessful:30})).toBe(false);  // before below sample
  expect(outcomeRegressed({settled:10,unsuccessful:1},{settled:10,unsuccessful:3})).toBe(true);   // exactly +20 points
  expect(outcomeRegressed({settled:10,unsuccessful:1},{settled:100,unsuccessful:29})).toBe(false);// +19 points
  expect(outcomeRegressed({settled:20,unsuccessful:10},{settled:20,unsuccessful:2})).toBe(false); // improvement
 });
 it('the approver scope vocabulary is closed',()=>{
  expect(AGENT_PROMOTION_SCOPES).toEqual(['user','company','tenant']);
  for(const value of ['user','company','tenant'])expect(isAgentPromotionScope(value)).toBe(true);
  for(const value of ['group','',null,undefined,'Tenant'])expect(isAgentPromotionScope(value)).toBe(false);
 });
});
