import {describe,it,expect} from 'vitest';
import {addDays as v9AddDays} from '../lib/lifecycle-v9-model';
import {PROBATION_AUTOMATION_CATALOGUE as P} from '../lib/automation/catalogues/probation';
import {CONTRACT_AUTOMATION_CATALOGUE as C} from '../lib/automation/catalogues/contracts';
import {addAutomationDays,automationMergeWarnings,automationWorkflowProblems,dryRunAutomationWorkflow,freezeAutomationWorkflow,setAutomationWorkflowStatus,type AutomationRecipient,type AutomationWorkflow} from '../lib/automation/workflow';

const refs={routingExists:(id:string)=>id==='r-bp',groupExists:(id:string)=>id==='g-gbs',personExists:(id:string)=>id==='u-ravi'};
const confirm=():AutomationWorkflow=>({id:'wf-confirm',module:'probation',name:'Outcome · Confirm',description:'',status:'paused',required:true,
 trigger:{event:'outcomeDecided',days:0,workdays:false,repeat:false},skipWhen:'caseClosed',
 conditions:[{field:'outcome',op:'is',values:['Confirm']}],
 steps:[
  {id:'s1',type:'generateDocument',conditions:[],to:[],cc:[],params:{templateId:'t-confirm'}},
  {id:'s2',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[{kind:'role',role:'directSuperior'},{kind:'routing',routingId:'r-bp'}],params:{emailTemplateId:'e-letter'}},
  {id:'s3',type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Confirmation'}},
 ]});
const reminder=():AutomationWorkflow=>({...confirm(),id:'wf-kpi',name:'Week 1 KPI reminder',required:false,
 trigger:{event:'dueAfterStart',days:3,workdays:true,repeat:true},skipWhen:'never',
 conditions:[{field:'part',op:'is',values:['Part 1 · Week 1 Success Plan']},{field:'pendingStep',op:'is',values:['Line Manager']}],
 steps:[{id:'n1',type:'notify',conditions:[],to:[{kind:'pending'}],cc:[],params:{subject:'Set Week 1 KPIs for {{employee.name}}',body:'Due {{probation.dueDate}}. Outcome {{probation.outcome}}. {{unknown.token}}'}}]});

describe('Shared workflow definition',()=>{
 it('caps Contract reminders at365 days while preserving the existing Probation range',()=>{
  const contract:AutomationWorkflow={...reminder(),module:'contract_staff',trigger:{event:'beforeContractEnd',days:365,workdays:false,repeat:false},conditions:[],steps:[{id:'notice',type:'notify',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{subject:'Contract reminder',body:'Review the current period.'}}]};
  expect(automationWorkflowProblems(contract,C,refs)).toEqual([]);
  expect(automationWorkflowProblems({...contract,trigger:{...contract.trigger,days:366}},C,refs)).toContain('Enter between 0 and 365 days.');
  expect(automationWorkflowProblems({...contract,trigger:{...contract.trigger,days:0}},C,refs)).toEqual([]);
  const probation={...reminder(),trigger:{...reminder().trigger,days:3660}};
  expect(automationWorkflowProblems(probation,P,refs)).toEqual([]);
  expect(automationWorkflowProblems({...probation,trigger:{...probation.trigger,days:3661}},P,refs)).toContain('Enter between 0 and 3660 days.');
 });
 it('accepts the prototype’s Outcome · Confirm and Week 1 KPI reminder workflows',()=>{
  expect(automationWorkflowProblems(confirm(),P,refs)).toEqual([]);
  expect(automationWorkflowProblems(reminder(),P,refs)).toEqual([]);
 });
 it('refuses conditions the trigger cannot supply, values outside the choices and unknown fields',()=>{
  const wf=confirm();wf.conditions=[{field:'resultBand',op:'lte',values:['2']},{field:'outcome',op:'is',values:['Promote']},{field:'salary',op:'is',values:['1']}];
  wf.steps[1].conditions=[{field:'pendingStep',op:'is',values:['HOD']}];
  expect(automationWorkflowProblems(wf,P,refs)).toEqual(['Condition 1: this field is not available for the chosen trigger.','Condition 2: “Promote” is not one of the choices.','Condition 3: unknown field.','Step 2 condition 1: this field is not available for the chosen trigger.']);
 });
 it('checks trigger days, skip-when, steps and recipients',()=>{
  const wf=confirm();wf.trigger={event:'outcomeDecided',days:5,workdays:false,repeat:true};wf.skipWhen='whenever';
  wf.steps.push({id:'s1',type:'requestApproval',conditions:[],to:[{kind:'role',role:'ceo'},{kind:'routing',routingId:'r-gone'},{kind:'group',groupId:'g-gone'},{kind:'person',userId:'u-gone'}],cc:[],params:{}});
  expect(automationWorkflowProblems(wf,P,refs)).toEqual(['Days, working days and repeat apply only to date-based triggers.','Choose when to skip.','Step 4: each step needs its own id.','Step 4: this module has no requestApproval step.','Step 4 To: unknown recipient ceo.','Step 4 To: a chosen routing no longer exists.','Step 4 To: a chosen assignment group no longer exists.','Step 4 To: a chosen person can no longer be found.']);
  const dated=reminder();dated.trigger.days=-1;expect(automationWorkflowProblems(dated,P,refs)).toContain('Enter between 0 and 3660 days.');
  const empty={...confirm(),name:' ',steps:[],module:'onb' as const};expect(automationWorkflowProblems(empty,P,refs)).toEqual(['This workflow belongs to another module.','Name this workflow.','Add at least one step.']);
 });
 it('flags merge fields the trigger cannot fill without blocking the workflow',()=>{
  expect(automationMergeWarnings(reminder(),P)).toEqual(['Step 1: {{probation.outcome}} cannot be filled for this trigger.','Step 1: {{unknown.token}} cannot be filled for this trigger.']);
  expect(automationWorkflowProblems(reminder(),P,refs)).toEqual([]);
 });
 it('makes a workflow live only without problems, always allows pausing, and never revives a retired one',()=>{
  const wf=confirm();
  expect(setAutomationWorkflowStatus(wf,'live',['Name this workflow.'])).toEqual({ok:false,reason:'Fix the problem before making it live.'});
  expect(setAutomationWorkflowStatus(wf,'live',['a','b'])).toEqual({ok:false,reason:'Fix the 2 problems before making it live.'});
  const live=setAutomationWorkflowStatus(wf,'live',[]);expect(live.ok&&live.workflow.status).toBe('live');
  expect(setAutomationWorkflowStatus({...wf,status:'live'},'paused',['anything']).ok).toBe(true);
  expect(setAutomationWorkflowStatus({...wf,status:'retired'},'live',[]).ok).toBe(false);
 });
 it('keeps a frozen copy that later edits do not reach',()=>{
  const wf=confirm(),frozen=freezeAutomationWorkflow(wf);
  wf.steps[1].cc.push({kind:'person',userId:'u-ravi'});wf.conditions[0].values.push('Extend');
  expect(frozen.steps[1].cc).toHaveLength(2);expect(frozen.conditions[0].values).toEqual(['Confirm']);
 });
 it('adds calendar and working days exactly as V9 does',()=>{
  for(const date of['2026-11-13','2026-11-14','2026-11-15','2026-11-16','2026-12-31'])for(const days of[0,1,3,4,5,7,10,-1,-3,-7,-14])for(const workdays of[false,true])
   expect(addAutomationDays(date,days,workdays)).toBe(v9AddDays(date,days,workdays));
  expect(()=>addAutomationDays('2026-02-30',1,false)).toThrow();
 });
});

describe('Dry run',()=>{
 const people:Record<string,string[]>={'role:employee':['Aina Rahman'],'role:directSuperior':['Kevin Tan'],'routing:r-bp':['Nurul Huda'],pending:['Kevin Tan']};
 const key=(r:AutomationRecipient)=>r.kind==='role'?'role:'+r.role:r.kind==='routing'?'routing:'+r.routingId:r.kind;
 const context=(facts:Record<string,string|null>,anchors:Record<string,string>={},skip:string|null=null)=>({read:(f:string)=>f in facts?facts[f]:undefined,anchor:(a:string)=>anchors[a]??null,skipReason:()=>skip,resolve:(r:AutomationRecipient)=>people[key(r)]?{names:people[key(r)],missing:null}:{names:[],missing:'No one found; it goes to GBS People Ops.'}});
 it('shows the prototype’s Outcome · Confirm run for Aina Rahman, sending nothing',()=>{
  const dry=dryRunAutomationWorkflow({...confirm(),status:'live'},P,context({outcome:'Confirm',part:'Part 3 · Final Confirmation Review'}));
  expect(dry.wouldRun).toBe(true);expect(dry.reason).toBe('It would run for this case.');expect(dry.sends).toBe(false);
  expect(dry.conditions.map(c=>c.ok)).toEqual([true]);
  expect(dry.steps.map(s=>[s.index,s.type,s.runs])).toEqual([[1,'generateDocument',true],[2,'sendEmail',true],[3,'createPosting',true]]);
  expect(dry.steps[1]).toMatchObject({to:['Aina Rahman'],cc:['Kevin Tan','Nurul Huda'],missing:[]});
  expect(dry.runDate).toBeNull();
 });
 it('explains why it would not run: not live, conditions, skip-when and a missing date',()=>{
  expect(dryRunAutomationWorkflow(confirm(),P,context({outcome:'Confirm'})).reason).toBe('It would match, but the workflow is not live.');
  const ext=dryRunAutomationWorkflow({...confirm(),status:'live'},P,context({outcome:'Extend'}));expect(ext.wouldRun).toBe(false);expect(ext.reason).toBe('The conditions do not match this case.');
  expect(dryRunAutomationWorkflow({...confirm(),status:'live'},P,context({outcome:'Confirm'},{},'the case is already closed')).reason).toBe('Skipped: the case is already closed');
  expect(dryRunAutomationWorkflow({...reminder(),status:'live'},P,context({part:'Part 1 · Week 1 Success Plan',pendingStep:'Line Manager'})).reason).toBe('This case has no date to count from.');
 });
 it('computes the run date for a working-day trigger and reports the daily repeat and step skips',()=>{
  const wf={...reminder(),status:'live' as const};wf.steps.push({id:'n2',type:'notify',conditions:[{field:'extensionsUsed',op:'gte',values:['1']}],to:[{kind:'group',groupId:'g-none'}],cc:[],params:{}});
  const dry=dryRunAutomationWorkflow(wf,P,context({part:'Part 1 · Week 1 Success Plan',pendingStep:'Line Manager',extensionsUsed:'0'},{startDate:'2026-11-13'}));
  expect(dry.runDate).toBe('2026-11-18');expect(dry.repeats).toBe(true);expect(dry.wouldRun).toBe(true);
  expect(dry.steps[0]).toMatchObject({runs:true,to:['Kevin Tan']});
  expect(dry.steps[1]).toMatchObject({runs:false,missing:['No one found; it goes to GBS People Ops.']});
 });
});
