/** Authored UNRUN: pure diagnostic comparisons use fictional projections, not RLS/runtime evidence. */
import {describe,expect,it} from 'vitest';
import {executeCanonicalSpecialist,SpecialistCandidate} from '../lib/ai/module-specialists';
import {canonicalSpecialistFollowup} from '../lib/ai/module-specialist-followup';
import {SPECIALIST_FOLLOWUP_CASES} from '../lib/ai/module-specialist-followup-cases';
import {SPECIALIST_HOLDOUTS} from '../lib/ai/module-specialist-holdouts';
import {AGENT_MODULE_CODES,MODULE_AGENT_CAPABILITIES} from '../lib/ai/module-agents';
import type {AgentModuleCode} from '../lib/ai/module-agents';
const input=(module:AgentModuleCode,data:unknown)=>({module,scope:'current-caller',capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1],data});
const candidate=(module:AgentModuleCode,playbook='canonical_followup_v1')=>({kind:'canonical_specialist_v1',module,playbook});
describe('closed, observable specialist diagnostics',()=>{
 it.each(SPECIALIST_FOLLOWUP_CASES)('$inputId makes the independently expected diagnostic decision without losing facts/warnings',fixture=>{
  const held=SPECIALIST_HOLDOUTS.find(row=>row.id===fixture.inputId)!;if(!('data'in fixture))expect(held).toBeDefined();const captured=input(fixture.module,structuredClone('data'in fixture?fixture.data:held!.data)),before=structuredClone(captured),baseline=executeCanonicalSpecialist(candidate(fixture.module,'canonical_domain_v1'),captured),result=executeCanonicalSpecialist(candidate(fixture.module),captured);
  expect(result.diagnostic).toMatchObject({state:fixture.state,code:fixture.code,effect:'none',requiresHumanIntent:true});expect(baseline).not.toHaveProperty('diagnostic');expect(result.presentation).toEqual(baseline.presentation);expect(result.findings).toEqual(baseline.findings);expect(result.effects).toEqual([]);expect(captured).toEqual(before);
  expect(result.diagnostic?.route).toBe(fixture.route);if('recordNumber'in fixture)expect(result.diagnostic?.recordNumber).toBe(fixture.recordNumber);if('evidencePaths'in fixture)expect(result.diagnostic?.evidencePaths).toEqual(fixture.evidencePaths);expect(JSON.stringify(result.diagnostic)).not.toMatch(/salary|7319|7001|PRIVATE_POISON|payment.execute|approve|\/assistant\/payroll-close/);
 });
 it.each(AGENT_MODULE_CODES)('%s has explicit independent coverage and cannot turn partial/empty evidence into an effect recommendation',module=>{
  expect(SPECIALIST_FOLLOWUP_CASES.some(row=>row.module===module)).toBe(true);const held=SPECIALIST_HOLDOUTS.find(row=>row.id===module+':empty-scope')!,empty=executeCanonicalSpecialist(candidate(module),input(module,held.data));expect(empty.diagnostic).toMatchObject({state:'insufficient',code:'insufficient',route:null,evidencePaths:[]});
  const partial=canonicalSpecialistFollowup(module,{}, {module,cards:[],truncated:true});expect(partial).toMatchObject({state:'insufficient',route:null});
 });
 it('rejects arbitrary strategies, self-ratings and executable policy',()=>{for(const value of [{...candidate('claims'),playbook:'learned_script'},{...candidate('claims'),qualityScore:1},{...candidate('claims'),execute:true}])expect(SpecialistCandidate.safeParse(value).success).toBe(false);});
 it('does not infer native effect eligibility from own released pay, KB index, own pending requests or unread notices',()=>{
  for(const id of ['payroll:stored-released','knowledge_base:published-index','approvals:pending','notifications:unread','claims:paid']){const held=SPECIALIST_HOLDOUTS.find(row=>row.id===id)!,result=executeCanonicalSpecialist(candidate(held.module),input(held.module,held.data));expect(result.diagnostic?.route).toBeNull();expect(result.diagnostic?.effect).toBe('none');expect(result.diagnostic?.requiresHumanIntent).toBe(true);}
 });
});
