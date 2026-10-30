/** Authored UNRUN: pure handoff contracts are not effect authority or native runtime acceptance. */
import {describe,expect,it} from 'vitest';
import {AGENT_MODULE_CODES} from '../lib/ai/module-agents';
import {moduleHumanActionHandoffs,checkedModuleHumanHandoffs} from '../lib/ai/module-human-handoffs';
import {presentGroundedToolOutcome} from '../lib/ai/grounded-tool-presentation';
import {getModuleAgentAction,parseModuleAgentActionNomination} from '../lib/ai/module-agent-actions';
describe('the shared Assistant hands actions to humans rather than executing them',()=>{
 it('offers only actual connected specialist pages and no pending or read-only module effects',()=>{
  const connected=['multi_cycle_payroll','country-my','payroll','employees','rewards','typed_pay_components','attendance','approvals','leave','ess','notifications','performance','claims','system_testing','org','knowledge_base','lifecycle','toil'];
  for(const module of AGENT_MODULE_CODES){const rows=moduleHumanActionHandoffs(module);expect(Object.isFrozen(rows)).toBe(true);expect(rows.length>0).toBe(connected.includes(module));
   for(const row of rows){expect(Object.isFrozen(row)).toBe(true);expect(row).toMatchObject({module,effect:'none',requiresHumanSelection:true,authority:row.action==='employees.import'?'rechecked_on_import_page':'rechecked_on_review_page'});expect(Object.keys(row).sort()).toEqual(['module','action','route','requiresHumanSelection','effect','authority'].sort());expect(getModuleAgentAction(module,row.action)?.prepare.status).toBe(row.action==='employees.import'?'human_workflow_only':'implemented');if(row.action==='employees.import')expect(()=>parseModuleAgentActionNomination({module,action:row.action,phase:'prepare'})).toThrow();else expect(parseModuleAgentActionNomination({module,action:row.action,phase:'prepare'}).kind).toBe('prepare');expect(()=>parseModuleAgentActionNomination({module,action:row.action,phase:'confirm'})).toThrow();}
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

it('keeps draft saving and explicit submission on one Claims specialist page without auto-selecting a draft or causing an effect',()=>{
 const actions=moduleHumanActionHandoffs('claims');expect(actions.map(row=>row.action)).toEqual(['claims.draft.save','claims.submit','claims.cancel']);expect(actions.every(row=>row.route==='/assistant/claims'&&row.effect==='none')).toBe(true);
 const result=presentGroundedToolOutcome('my_module_work',{ok:true,module:'claims',data:{claims:[],hasEmployment:true,truncated:false},humanActions:actions});expect(result?.cards).toEqual([{title:{kind:'module',module:'claims'},facts:[],href:'/assistant/claims',linkPurpose:'human_review'}]);
 expect(()=>presentGroundedToolOutcome('my_module_work',{ok:true,module:'claims',data:{claims:[],truncated:false},humanActions:actions})).toThrow('Canonical claim scope unavailable.');
 expect(()=>checkedModuleHumanHandoffs('claims',actions.slice(0,1))).toThrow();expect(()=>checkedModuleHumanHandoffs('claims',actions.map(row=>({...row,route:'/assistant/claims?flow=submit&draftId=posted'})))).toThrow();
});

it('hands Knowledge Base publication to a fixed human page without carrying generated content or audience',()=>{
 const actions=moduleHumanActionHandoffs('knowledge_base');expect(actions).toEqual([{module:'knowledge_base',action:'knowledge_base.article.create',route:'/assistant/knowledge-base',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}]);
 const result=presentGroundedToolOutcome('my_module_work',{ok:true,module:'knowledge_base',data:{rows:[],truncated:false},humanActions:actions});expect(result?.cards).toEqual([{title:{kind:'module',module:'knowledge_base'},facts:[],href:'/assistant/knowledge-base',linkPurpose:'human_review'}]);
 for(const extra of [{title:'model publication'},{body:'model policy'},{audience:'all'},{route:'/assistant/knowledge-base?audience=all'}])expect(()=>checkedModuleHumanHandoffs('knowledge_base',actions.map(row=>({...row,...extra})))).toThrow();
});

it('offers equipment acknowledgement only as a human Lifecycle page with no device/consent/provider content',()=>{
 const actions=moduleHumanActionHandoffs('lifecycle');expect(actions).toEqual([{module:'lifecycle',action:'lifecycle.acknowledgement.submit',route:'/assistant/lifecycle',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}]);
 for(const extra of [{caseId:'posted'},{serialNumber:'model device'},{acknowledged:true},{receiptEmail:'model@example.test'},{route:'/assistant/lifecycle?caseId=other'}])expect(()=>checkedModuleHumanHandoffs('lifecycle',actions.map(row=>({...row,...extra})))).toThrow();
});

it('hands TOIL to human worked-date review without generating work, consent, credit or approval',()=>{
 const actions=moduleHumanActionHandoffs('toil');expect(actions).toEqual([{module:'toil',action:'toil.replacement.request',route:'/assistant/toil',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}]);
 for(const extra of [{rows:[]},{workedDate:'2026-01-01'},{firstScheduleConsent:true},{creditId:'invented'},{approved:true},{route:'/assistant/toil?employmentId=other'}])expect(()=>checkedModuleHumanHandoffs('toil',actions.map(row=>({...row,...extra})))).toThrow();
});

it('hands assigned Leave, claim, attendance and replacement-leave decisions to human selection without model task, decision or confirmation',()=>{
 const rows=moduleHumanActionHandoffs('approvals');expect(rows).toEqual([{module:'approvals',action:'approvals.leave.decide',route:'/assistant/approvals',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'},{module:'approvals',action:'approvals.claim.decide',route:'/assistant/approvals',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'},{module:'approvals',action:'approvals.attendance.decide',route:'/assistant/approvals',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'},{module:'approvals',action:'approvals.toil.decide',route:'/assistant/approvals',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}]);
 for(const extra of [{leaveRequestId:'other'},{currentStepId:'other'},{decision:'approved'},{rejectReason:'model reason'},{confirmAssignedDecision:true},{route:'/assistant/approvals?task=other'}])expect(()=>checkedModuleHumanHandoffs('approvals',rows.map(row=>({...row,...extra})))).toThrow();
});

it('offers only the fixed own Attendance human page without carrying source baselines or work claims',()=>{
 const rows=moduleHumanActionHandoffs('attendance');expect(rows).toEqual([{module:'attendance',action:'attendance.correction.request',route:'/assistant/attendance',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'},{module:'attendance',action:'attendance.overtime.request',route:'/assistant/attendance',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}]);
 for(const extra of [{employmentId:'other'},{baseline:'private'},{clockChanges:{}},{requestedOtMinutes:60},{approved:true},{route:'/assistant/attendance?employee=other'}])expect(()=>checkedModuleHumanHandoffs('attendance',rows.map(row=>({...row,...extra})))).toThrow();
});

it('offers the fixed pay-code human page without model rules, classification or target assignments',()=>{
 const rows=moduleHumanActionHandoffs('typed_pay_components');expect(rows).toEqual([{module:'typed_pay_components',action:'typed_pay_components.create',route:'/assistant/pay-codes',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}]);
 for(const extra of [{input:{}},{rule:{kind:'fixed'}},{includedInPcb:true},{employeeId:'other'},{route:'/assistant/pay-codes?code=INVENTED'}])expect(()=>checkedModuleHumanHandoffs('typed_pay_components',rows.map(row=>({...row,...extra})))).toThrow();
});

it('offers only the whole-unit Rewards human page without amounts, unit selectors or model approval',()=>{
 const rows=moduleHumanActionHandoffs('rewards');expect(rows).toEqual([{module:'rewards',action:'rewards.post',route:'/assistant/rewards',requiresHumanSelection:true,effect:'none',authority:'rechecked_on_review_page'}]);
 for(const extra of [{unitId:'other'},{awards:[]},{newBasic:100},{employeeIds:[]},{approved:true},{route:'/assistant/rewards?unit=other'}])expect(()=>checkedModuleHumanHandoffs('rewards',rows.map(row=>({...row,...extra})))).toThrow();
});

it('offers native Employee import and a local human qualification review without model-filled records',()=>{
