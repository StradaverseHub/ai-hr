import {describe,it,expect} from 'vitest';
import {AUTOMATION_FLOOR} from '../lib/automation/floor';
import {v9ConfigSchema,v9RoleSchema} from '../lib/lifecycle-v9-validation';
import {contractWorkflowSchema,contractApproverSchema} from '../lib/contract-management-workflow';
import {PROBATION_WORKFLOW_EVENTS,probationWorkflowIssues,type ProbationWorkflow} from '../lib/probation-workflow';

/**
 * Build step 0 of ADR 2026-11-15-probation-shared-automation: the floor equals what each engine accepts today,
 * read from the engine's own runtime schema (zod v4 definitions) or exercised through its own validator. If an engine
 * gains a capability, add it to `lib/automation/floor.ts`; if one is removed, an owner decision must say so.
 */
type Def={type:string;shape?:Record<string,unknown>;entries?:Record<string,string>;element?:unknown;options?:unknown[];innerType?:unknown;values?:unknown[]};
const def=(schema:unknown):Def=>{const value=(schema as {_zod?:{def?:Def}})?._zod?.def;if(!value)throw new Error('Not a zod v4 schema.');return value;};
const bare=(schema:unknown):unknown=>{const d=def(schema);return d.type==='optional'||d.type==='default'||d.type==='nullable'?bare(d.innerType):schema;};
const field=(schema:unknown,name:string):unknown=>{const d=def(bare(schema));if(d.type!=='object'||!d.shape||!(name in d.shape))throw new Error('No field '+name+'.');return d.shape[name];};
const path=(schema:unknown,...names:string[])=>names.reduce<unknown>((s,name)=>name==='[]'?def(bare(s)).element:field(s,name),schema);
const enumValues=(schema:unknown)=>{const d=def(bare(schema));if(d.type!=='enum'||!d.entries)throw new Error('Not an enum.');return Object.values(d.entries);};
const keys=(schema:unknown)=>Object.keys(def(bare(schema)).shape??{});
const unionTypes=(schema:unknown)=>(def(bare(schema)).options??[]).map(option=>(def(field(option,'type')).values??[])[0]);
const unionOption=(schema:unknown,type:string)=>{const option=(def(bare(schema)).options??[]).find(o=>(def(field(o,'type')).values??[])[0]===type);if(!option)throw new Error('No step '+type+'.');return option;};
const same=(actual:readonly unknown[],floor:readonly unknown[])=>expect([...actual].sort()).toEqual([...floor].sort());

describe('Automation floor · On/Off Boarding V9',()=>{
 const f=AUTOMATION_FLOOR.lifecycleV9,workflow=path(v9ConfigSchema,'workflows','[]'),template=path(v9ConfigSchema,'templates','[]');
 it('pins modules, trigger events and options, conditions, step types and statuses',()=>{
  same(enumValues(field(workflow,'module')),f.modules);
  same(enumValues(path(workflow,'trigger','event')),f.triggerEvents);
  same(keys(field(workflow,'trigger')).filter(k=>k!=='event'),f.triggerOptions);
  same(enumValues(path(workflow,'conditions','[]','field')),f.conditionFields);
  same(enumValues(path(workflow,'conditions','[]','op')),f.conditionOps);
  same(unionTypes(path(workflow,'steps','[]')),f.stepTypes);
  same(enumValues(field(unionOption(path(workflow,'steps','[]'),'waitSign'),'by')),f.waitSignBy);
  same(enumValues(field(workflow,'status')),f.workflowStatuses);
 });
 it('accepts exactly the documented skip-when forms',()=>{
  const skip=path(workflow,'trigger','skipIf') as {safeParse:(v:unknown)=>{success:boolean}};
  for(const value of ['','noPre','allDocsDone','task:checklist-item'])expect(skip.safeParse(value).success).toBe(true);
  expect(skip.safeParse('somethingElse').success).toBe(false);
  expect(f.skipIf).toEqual(['','noPre','allDocsDone','task:<id>']);
 });
 it('pins named recipient roles and the person, group and literal-address forms',()=>{
  same(enumValues((def(bare(v9RoleSchema)).options??[])[0]),f.recipientRoles);
  for(const value of ['person:10000000-0000-4000-8000-000000000001','group:GBS People Ops','people.ops@example.com'])expect(v9RoleSchema.safeParse(value).success).toBe(true);
  expect(v9RoleSchema.safeParse('ceo').success).toBe(false);
  expect(f.recipientForms).toHaveLength(3);
 });
 it('pins template types, HR signature step, matching rules, blocks and fields',()=>{
  same(enumValues(field(template,'type')),f.templateTypes);
  same(enumValues(field(template,'hrStep')),f.templateHrStep);
  same(keys(field(template,'rules')),f.templateRuleFields);
  same(enumValues(path(template,'versions','[]','blocks','[]','type')),f.blockTypes);
  same(enumValues(path(template,'versions','[]','fields','[]','type')),f.fieldTypes);
  same(enumValues(path(template,'versions','[]','fields','[]','owner')),f.fieldOwners);
 });
 it('pins checklist task assignment and the PBP rule dimensions',()=>{
  same(enumValues(path(v9ConfigSchema,'checklists','[]','tasks','[]','by')),f.taskAssignees);
  same(enumValues(path(v9ConfigSchema,'checklists','[]','tasks','[]','mode')),f.taskModes);
  same(keys(path(v9ConfigSchema,'bpRules','[]','rules')),f.bpRuleFields);
 });
});

describe('Automation floor · Contract staff',()=>{
 const f=AUTOMATION_FLOOR.contractStaff,steps=path(contractWorkflowSchema,'steps','[]');
 it('pins triggers, conditions and step types, and that every step carries its own conditions',()=>{
  same(enumValues(path(contractWorkflowSchema,'trigger','event')),f.triggerEvents);
  same(enumValues(path(contractWorkflowSchema,'trigger','repeatUntil')),f.triggerRepeatUntil);
  same(enumValues(path(contractWorkflowSchema,'conditions','[]','field')),f.conditionFields);
  same(enumValues(path(contractWorkflowSchema,'conditions','[]','op')),f.conditionOps);
  same(unionTypes(steps),f.stepTypes);
  for(const type of f.stepTypes)expect(keys(unionOption(steps,type))).toContain('conditions');
  expect(f.stepConditions).toBe(true);
 });
 it('pins approver kinds, quorum, document types and signature timing',()=>{
  same(unionTypes(contractApproverSchema),f.approverTypes);
  same(enumValues(field(unionOption(contractApproverSchema,'employee_record'),'field')),f.approverRecordFields);
  same(enumValues(field(unionOption(contractApproverSchema,'role_group'),'role')),f.approverRoleGroups);
  same(enumValues(field(unionOption(steps,'request_approval'),'quorum')),f.approvalQuorum);
  same(enumValues(field(unionOption(steps,'generate_document'),'templateType')),f.documentTemplateTypes);
  same(enumValues(field(unionOption(steps,'wait_signature'),'timingSource')),f.signatureTimingSource);
 });
});

describe('Automation floor · Probation',()=>{
 const f=AUTOMATION_FLOOR.probation;
 const workflow=(patch:Partial<ProbationWorkflow['steps'][number]>={},event:string='kpi_assigned'):ProbationWorkflow=>({id:'w1',name:'Floor probe',module:'probation',status:'draft',description:'',trigger:{event:event as ProbationWorkflow['trigger']['event']},conditions:{},steps:[{id:'s1',type:'notify',subject:'Probation update',body:'Hello',to:['employee'],...patch}]});
 it('pins the trigger events',()=>{
  same(PROBATION_WORKFLOW_EVENTS,f.triggerEvents);
  for(const event of f.triggerEvents)expect(probationWorkflowIssues(workflow({},event))).toEqual([]);
  expect(probationWorkflowIssues(workflow({},'outcome_decided'))).not.toEqual([]);
 });
 it('accepts exactly the notify step, the five recipient roles and the six merge fields',()=>{
  expect(f.stepTypes).toEqual(['notify']);
  expect(probationWorkflowIssues(workflow({type:'email' as 'notify'}))).not.toEqual([]);
  for(const role of f.recipientRoles)expect(probationWorkflowIssues(workflow({to:[role]}))).toEqual([]);
  expect(probationWorkflowIssues(workflow({to:['ceo' as 'pbp']}))).not.toEqual([]);
  for(const token of f.mergeFields)expect(probationWorkflowIssues(workflow({body:'Value {{'+token+'}}'}))).toEqual([]);
  expect(probationWorkflowIssues(workflow({body:'Value {{newEndOn}}'}))).not.toEqual([]);
 });
 it('pins the condition fields at the type level',()=>{
  type Fields=keyof ProbationWorkflow['conditions'];type Floor=typeof f.conditionFields[number];
  const exact:[Fields] extends [Floor]?([Floor] extends [Fields]?true:false):false=true;
  expect(exact).toBe(true);
 });
});
