/** Authored UNRUN. Mock carrier proves evaluator protocol only; real native source/RLS cases follow.
 * The evaluator owns all expectations; a caller supplies no expected result, callback or score. */
import {describe,expect,it,vi} from 'vitest';
import type {AssistantReadSession} from '../core/assistant-read-session';
import {executeSpecialistHoldout,specialistNativeEvidencePresent} from '../core/module-specialist-harness';
import {AGENT_MODULE_CODES,MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';
import {SPECIALIST_HOLDOUTS} from '../lib/ai/module-specialist-holdouts';
const configuration=(module:AgentModuleCode)=>({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'});
function read(module:AgentModuleCode,data:unknown){return{moduleWork:vi.fn(async actual=>{expect(actual).toBe(module);return{module,scope:'current-caller',capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1],data,humanActions:[]};})} as unknown as AssistantReadSession;}
describe('actual candidate domain evaluator protocol',()=>{
 it.each(AGENT_MODULE_CODES)('%s exercises substantive independently expected state cases, native projection and typed no-effect guards',async module=>{const fixture=SPECIALIST_HOLDOUTS.find(row=>row.module===module)!,carrier=read(module,fixture.data),report=await executeSpecialistHoldout(configuration(module),carrier);expect(report).toMatchObject({module,state:'complete',coverage:'canonical_domain_guidance_only',nativeEvidence:'present',securityFailures:0,qualityFailures:0});expect(report.cases.length).toBeGreaterThan(8);expect(report.cases.every(row=>row.passed)).toBe(true);expect(carrier.moduleWork).toHaveBeenCalledTimes(1);expect(JSON.stringify(report)).not.toMatch(/Fictional|Permitted|7319|7001|1234|employeeCode|personId|employmentId|salary|gross|netPay/);});
 it.each(AGENT_MODULE_CODES)('%s never converts empty native business evidence into specialist readiness merely because synthetic fixtures passed',async module=>{const fixture=SPECIALIST_HOLDOUTS.find(row=>row.id===module+':empty-scope')!,report=await executeSpecialistHoldout(configuration(module),read(module,fixture.data));expect(specialistNativeEvidencePresent(module,fixture.data)).toBe(false);expect(report.state).toBe('incomplete');expect(report.nativeEvidence).toBe('missing');expect(report.qualityFailures).toBeGreaterThan(0);expect(report.cases.find(row=>row.id===module+':nonempty-business-evidence')?.passed).toBe(false);});
 it.each(['leave:permitted-pending-hidden-available','leave:permitted-available-hidden-pending'])('%s evaluates allowed partial summaries and separately rejects forbidden aliases',async id=>{
  const fixture=SPECIALIST_HOLDOUTS.find(row=>row.id===id)!,report=await executeSpecialistHoldout(configuration('leave'),read('leave',fixture.data));
  expect(report).toMatchObject({state:'complete',nativeEvidence:'present',securityFailures:0,qualityFailures:0});
  expect(report.cases).toEqual(expect.arrayContaining([
   {id:'leave:withheld-accrued-alias-refused',category:'security',passed:true},
   {id:'leave:withheld-balance-alias-refused',category:'security',passed:true}
  ]));
  expect(report.cases.find(row=>row.id==='leave:poisoned-withheld-refused')).toBeUndefined();
 });
 it('propagates actual source authority/storage refusal without inventing a completed evaluation',async()=>{const carrier={moduleWork:vi.fn(async()=>{throw Error('Actual source refused');})} as unknown as AssistantReadSession;await expect(executeSpecialistHoldout(configuration('payroll'),carrier)).rejects.toThrow('Actual source refused');});
});
