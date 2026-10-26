/** Authored UNRUN: pure handoff contracts are not effect authority or native runtime acceptance. */
import {describe,expect,it} from 'vitest';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {moduleHumanActionHandoffs,checkedModuleHumanHandoffs} from '../lib/ai/module-human-handoffs';
import {presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {getModuleAgentAction,parseModuleAgentActionNomination} from '../lib/ai/module-agent-actions';
describe('the shared Assistant hands actions to humans rather than executing them',()=>{
 it('offers only actual connected specialist pages and no pending or read-only module effects',()=>{
  const connected=['leave','ess','notifications','performance','claims'];
  for(const module of AGENT_MODULE_CODES){const rows=moduleHumanActionHandoffs(module);expect(Object.isFrozen(rows)).toBe(true);expect(rows.length>0).toBe(connected.includes(module));
   for(const row of rows){expect(Object.isFrozen(row)).toBe(true);expect(row).toMatchObject({module,effect:'none',requiresHumanSelection:true,authority:'rechecked_on_review_page'});expect(Object.keys(row).sort()).toEqual(['module','action','route','requiresHumanSelection','effect','authority'].sort());expect(getModuleAgentAction(module,row.action)?.prepare.status).toBe('implemented');expect(parseModuleAgentActionNomination({module,action:row.action,phase:'prepare'}).kind).toBe('prepare');expect(()=>parseModuleAgentActionNomination({module,action:row.action,phase:'confirm'})).toThrow();}
  }
 });
 it('rejects foreign routes, query selectors, appended native actions, posted roles and truncated declarations',()=>{
  const original=moduleHumanActionHandoffs('leave'),first=original[0];
  for(const value of [[{...first,route:'https://attacker.test/'}],[{...first,route:'/assistant/leave?employmentId=other'}],[{...first,module:'payroll'}],[{...first,action:'payroll.close'}],[{...first,effect:'submitted'}],[{...first,roles:['hr_admin']}],[{...first,reviewedDigest:'a'.repeat(64)}],[],[first,first]])expect(()=>checkedModuleHumanHandoffs('leave',value)).toThrow();
  expect(checkedModuleHumanHandoffs('leave',undefined)).toEqual([]);expect(checkedModuleHumanHandoffs('system_explorer',[])).toEqual([]);
 });
 it('normalizes JSON property order but never accepts a partial or altered Performance engine list',()=>{
  const rows=moduleHumanActionHandoffs('performance');expect(rows.map(row=>row.action)).toEqual(['performance.review.acknowledge','performance.onehr.plan.acknowledge']);
  const reversedKeys=rows.map(row=>Object.fromEntries(Object.entries(row).reverse()));expect(checkedModuleHumanHandoffs('performance',reversedKeys)).toEqual(rows);expect(()=>checkedModuleHumanHandoffs('performance',rows.slice(0,1))).toThrow();
 });
 it('renders one fixed human review link for both Performance engines and no fabricated HR facts',()=>{
  const result=presentGroundedToolOutcome('my_module_work',{ok:true,module:'performance',data:{rows:[],truncated:false},humanActions:moduleHumanActionHandoffs('performance')});
  expect(result?.cards).toEqual([{title:{kind:'module',module:'performance'},facts:[],href:'/assistant/performance',linkPurpose:'human_review'}]);expect(result?.truncated).toBe(false);
 });
 it('keeps legacy facts unchanged and refuses forged action metadata before a canonical-looking link exists',()=>{
  const data={rows:[],truncated:false};expect(presentGroundedToolOutcome('my_module_work',{ok:true,module:'leave',data})?.cards).toEqual([]);
  expect(presentGroundedToolOutcome('my_module_work',{ok:true,module:'leave',data,humanActions:moduleHumanActionHandoffs('leave')})?.cards).toMatchObject([{href:'/assistant/leave',linkPurpose:'human_review'}]);
  expect(()=>presentGroundedToolOutcome('my_module_work',{ok:true,module:'leave',data,humanActions:[{...moduleHumanActionHandoffs('leave')[0],route:'/assistant/profile'}]})).toThrow();
 });
});
