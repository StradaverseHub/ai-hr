import {describe,expect,it} from 'vitest';
import {PROBATION_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/probation';
import type {AutomationStep,AutomationWorkflow} from '../lib/automation/workflow';
import {
 automationDueDate,decideAutomationRuns,memoryAutomationRunStore,resolveAutomationRecipients,resumeAutomationRuns,runAutomationEvent,
 type AutomationExecutors,type AutomationRun,type AutomationRuntimeEvent,type AutomationStepExecutor,type LiveAutomationWorkflow,
} from '../lib/automation/runtime';

/** lib/automation/runtime.ts: which workflows run, frozen runs, step conditions, pause/resume, guardrails, idempotency. */
const catalogue=PROBATION_AUTOMATION_CATALOGUE;
const step=(id:string,type:string,over:Partial<AutomationStep>={}):AutomationStep=>({id,type,conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{},...over});
const workflow=(over:Partial<AutomationWorkflow>={}):AutomationWorkflow=>({id:'wf-confirm',module:'probation',name:'Outcome · Confirm',description:'',status:'live',required:true,
 trigger:{event:'outcomeDecided',days:0,workdays:false,repeat:false},skipWhen:'caseClosed',conditions:[{field:'outcome',op:'is',values:['Confirm']}],
 steps:[step('letter','generateDocument',{params:{letterTemplateId:'tpl-confirm'}}),step('email','sendEmail',{params:{emailTemplateId:'em-1'}}),step('posting','createPosting',{params:{eventType:'Confirmation'}}),step('offboard','startOffboarding',{conditions:[{field:'outcome',op:'is',values:['Non-confirmation']}]})],...over});
const facts:Record<string,string|null>={outcome:'Confirm',part:'Part 3 · Final Confirmation Review'};
function event(over:Partial<AutomationRuntimeEvent>={},anchors:Record<string,string|null>={},skip:string|null=null):AutomationRuntimeEvent{
 return{trigger:'outcomeDecided',subjectId:'case-1',occurrence:'outcome-1',today:'2026-11-16',read:field=>field in facts?facts[field]:undefined,anchor:a=>anchors[a]??null,skipReason:()=>skip,...over};
}
function harness(){
 const calls:string[]=[],failures:string[]=[];
 const record=(name:string,result?:Awaited<ReturnType<AutomationStepExecutor>>):AutomationStepExecutor=>async({step})=>{calls.push(`${name}:${step.id}`);return result??{status:'done',recipients:['u-1']};};
 const executors:AutomationExecutors={notify:record('notify'),sendEmail:record('sendEmail'),generateDocument:record('generateDocument',{status:'wait',documentId:'doc-1'}),createPosting:record('createPosting'),startOffboarding:record('startOffboarding'),notifyFailure:async(run,reason)=>{failures.push(`${run.workflowId}:${reason}`);}};
 let n=0,clock=0;
 return{calls,failures,executors,store:memoryAutomationRunStore(),newId:()=>`run-${++n}`,now:()=>`2026-11-16T00:00:${String(clock++).padStart(2,'0')}Z`};
}
const live=(wf:AutomationWorkflow,revision=1):LiveAutomationWorkflow=>({workflow:wf,revision});

describe('deciding which workflows run',()=>{
 it('matches trigger and conditions, records skip-when, ignores other triggers and reports no match',()=>{
  const confirm=workflow(),extend=workflow({id:'wf-extend',conditions:[{field:'outcome',op:'is',values:['Extend']}]}),other=workflow({id:'wf-other',trigger:{event:'caseOpened',days:0,workdays:false,repeat:false}});
  const decided=decideAutomationRuns(catalogue,[live(confirm),live(extend),live(other)],event());
  expect(decided.decisions.map(d=>[d.workflowId,d.outcome])).toEqual([['wf-confirm','run'],['wf-extend','noMatch']]);
  expect(decided.matched).toBe(true);
  expect(decideAutomationRuns(catalogue,[live(extend)],event()).matched).toBe(false);
  const skipped=decideAutomationRuns(catalogue,[live(confirm)],event({},{},'The case is already closed'));
  expect(skipped.decisions[0]).toMatchObject({outcome:'skip',reason:'Skipped: The case is already closed'});expect(skipped.matched).toBe(true);
  expect(decideAutomationRuns(catalogue,[live({...confirm,status:'paused'})],event()).decisions[0].outcome).toBe('notLive');
 });
 it('counts dated triggers in calendar or working days and runs once from the due date',()=>{
  const dated=workflow({id:'wf-kpi',trigger:{event:'dueAfterStart',days:5,workdays:true,repeat:false},conditions:[],skipWhen:'never'});
  const anchors={startDate:'2026-11-13'};// a Friday: five working days later is Friday 20 November
  expect(automationDueDate(catalogue,dated,{anchor:a=>anchors[a as 'startDate']??null})).toBe('2026-11-20');
  expect(automationDueDate(catalogue,{...dated,trigger:{...dated.trigger,workdays:false}},{anchor:a=>anchors[a as 'startDate']??null})).toBe('2026-11-18');
  const before=decideAutomationRuns(catalogue,[live(dated)],event({trigger:'dueAfterStart',today:'2026-11-19'},anchors));
  expect(before.decisions[0]).toMatchObject({outcome:'notDue',dueDate:'2026-11-20'});expect(before.matched).toBe(false);
  const due=decideAutomationRuns(catalogue,[live(dated)],event({trigger:'dueAfterStart',today:'2026-11-20'},anchors)).decisions[0];
  const late=decideAutomationRuns(catalogue,[live(dated)],event({trigger:'dueAfterStart',today:'2026-11-23'},anchors)).decisions[0];
  expect(due).toMatchObject({outcome:'run',eventKey:'dueAfterStart|outcome-1|2026-11-20'});expect(late.eventKey).toBe(due.eventKey);
  expect(decideAutomationRuns(catalogue,[live(dated)],event({trigger:'dueAfterStart'})).decisions[0].outcome).toBe('noDate');
  const review=workflow({id:'wf-review',trigger:{event:'dueBeforeReview',days:3,workdays:true,repeat:false},conditions:[],skipWhen:'never'});
  expect(automationDueDate(catalogue,review,{anchor:()=>'2026-11-23'})).toBe('2026-11-18');// Monday minus three working days
 });
 it('repeats every morning from the due date with one run per day',()=>{
  const repeat=workflow({id:'wf-repeat',trigger:{event:'kpiOverdue',days:0,workdays:false,repeat:true},conditions:[],skipWhen:'never',steps:[step('n','notify',{params:{subject:'Overdue'}})]});
  const anchors={kpiOverdueDate:'2026-11-16'};
  const keys=['2026-11-16','2026-11-17','2026-11-18'].map(today=>decideAutomationRuns(catalogue,[live(repeat)],event({trigger:'kpiOverdue',today},anchors)).decisions[0].eventKey);
  expect(keys).toEqual(['kpiOverdue|outcome-1|2026-11-16','kpiOverdue|outcome-1|2026-11-17','kpiOverdue|outcome-1|2026-11-18']);
 });
});

describe('running workflows',()=>{
 it('executes steps in order, records skipped steps, pauses at Generate document and is idempotent per event',async()=>{
  const h=harness(),wf=workflow();
  const first=await runAutomationEvent({catalogue,workflows:[live(wf,4)],event:event(),store:h.store,executors:h.executors,now:h.now,newId:h.newId});
  expect(first.matched).toBe(true);expect(h.calls).toEqual(['generateDocument:letter']);
  const [run]=first.runs;
  expect(run).toMatchObject({workflowRevision:4,status:'waiting',waitingFor:'doc-1',cursor:1});
  expect(run.remaining.map(r=>[r.index,r.step.id])).toEqual([[1,'email'],[2,'posting'],[3,'offboard']]);
  const again=await runAutomationEvent({catalogue,workflows:[live(wf,4)],event:event(),store:h.store,executors:h.executors,now:h.now,newId:h.newId});
  expect(again.runs).toEqual([]);expect(again.alreadyRan.map(r=>r.id)).toEqual([run.id]);expect(h.calls).toEqual(['generateDocument:letter']);
  expect(h.store.runs).toHaveLength(1);
 });
 it('resumes the frozen remaining steps after release, even when the workflow was edited meanwhile',async()=>{
  const h=harness(),wf=workflow();
  await runAutomationEvent({catalogue,workflows:[live(wf)],event:event(),store:h.store,executors:h.executors,now:h.now,newId:h.newId});
  // Someone edits the workflow after the letter was generated: the waiting run must not change.
  wf.steps.splice(1,3,step('new-notify','notify',{params:{subject:'Edited'}}));
  expect(await resumeAutomationRuns({module:'probation',subjectId:'case-1',documentId:'other-doc',store:h.store,executors:h.executors,read:event().read,now:h.now})).toEqual([]);
  const [resumed]=await resumeAutomationRuns({module:'probation',subjectId:'case-1',documentId:'doc-1',store:h.store,executors:h.executors,read:event().read,now:h.now});
  expect(h.calls).toEqual(['generateDocument:letter','sendEmail:email','createPosting:posting']);
  expect(resumed).toMatchObject({status:'done',waitingFor:null,cursor:4,remaining:[]});
  expect(resumed.log.map(e=>[e.kind,e.stepId])).toEqual([['started',null],['waiting','letter'],['resumed',null],['stepDone','email'],['stepDone','posting'],['stepSkipped','offboard'],['done',null]]);
  expect(resumed.log.find(e=>e.stepId==='offboard')?.message).toMatch(/conditions/);
  expect(await resumeAutomationRuns({module:'probation',subjectId:'case-1',documentId:'doc-1',store:h.store,executors:h.executors,read:event().read,now:h.now})).toEqual([]);
 });
 it('stops the run when the document template is missing or retired, runs nothing after it and asks for a hand check',async()=>{
  for(const state of ['missing','retired'] as const){
   const h=harness();
   const result=await runAutomationEvent({catalogue,workflows:[live(workflow())],event:event(),store:h.store,executors:h.executors,guards:{documentTemplate:()=>state},now:h.now,newId:h.newId});
   const [run]=result.runs;
   expect(run.status).toBe('failed');expect(run.failure).toMatch(state==='retired'?/retired/:/no longer exists|No document template/);
   expect(h.calls).toEqual([]);expect(h.failures).toHaveLength(1);
   expect(run.remaining.map(r=>r.step.id)).toEqual(['email','posting','offboard']);
  }
 });
 it('skips a Send email step whose template is turned off and notes it, and fails on an executor failure',async()=>{
  const h=harness(),wf=workflow({steps:[step('email','sendEmail'),step('posting','createPosting')]});
  const [run]=(await runAutomationEvent({catalogue,workflows:[live(wf)],event:event(),store:h.store,executors:h.executors,guards:{emailTemplate:()=>'off'},now:h.now,newId:h.newId})).runs;
  expect(run.status).toBe('done');expect(h.calls).toEqual(['createPosting:posting']);
  expect(run.log.find(e=>e.stepId==='email')).toMatchObject({kind:'stepSkipped',message:'Skipped: the email template is turned off.'});
  const g=harness();g.executors.createPosting=async()=>({status:'failed',reason:'The posting could not be created.'});
  const [failed]=(await runAutomationEvent({catalogue,workflows:[live(wf)],event:event(),store:g.store,executors:g.executors,now:g.now,newId:g.newId})).runs;
  expect(failed).toMatchObject({status:'failed',failure:'The posting could not be created.'});expect(g.failures).toEqual(['wf-confirm:The posting could not be created.']);
 });
 it('fails a step type the module did not provide and records a skipped workflow as a run',async()=>{
  const h=harness();delete h.executors.startOffboarding;
  const wf=workflow({conditions:[],steps:[step('offboard','startOffboarding')]});
  const [run]=(await runAutomationEvent({catalogue,workflows:[live(wf)],event:event(),store:h.store,executors:h.executors,now:h.now,newId:h.newId})).runs;
  expect(run.status).toBe('failed');expect(run.failure).toMatch(/cannot run/);
  const s=harness();
  const skipped=await runAutomationEvent({catalogue,workflows:[live(wf)],event:event({},{},'The case is already closed'),store:s.store,executors:s.executors,now:s.now,newId:s.newId});
  expect(skipped.runs[0]).toMatchObject({status:'skipped'});expect(s.calls).toEqual([]);
 });
 it('keeps the run log bounded',async()=>{
  const h=harness(),many=workflow({conditions:[],steps:Array.from({length:40},(_,i)=>step('n'+i,'notify'))});
  const run:AutomationRun=(await runAutomationEvent({catalogue,workflows:[live(many)],event:event(),store:h.store,executors:h.executors,now:h.now,newId:h.newId})).runs[0];
  expect(run.status).toBe('done');expect(run.log.length).toBeLessThanOrEqual(200);expect(run.log).toHaveLength(42);
 });
});

describe('recipient resolution',()=>{
 it('reaches everyone a routing or group names, and sends the unresolvable to the fallback group with who it was meant for',()=>{
  const result=resolveAutomationRecipients([
   {kind:'role',role:'employee'},{kind:'role',role:'directSuperior'},{kind:'routing',routingId:'r-bp'},{kind:'group',groupId:'g-hod'},{kind:'person',userId:'u-gone'},{kind:'pending'},
  ],{role:r=>r==='employee'?['u-emp']:r==='directSuperior'?[]:null,facts:{businessGroup:'BG1'},
   routing:id=>id==='r-bp'?{id,name:'BP by business group',rows:[{match:{businessGroup:['BG1']},assignTo:{kind:'group',groupId:'g-bp'}}]}:null,
   groupMembers:id=>id==='g-bp'?['u-bp1','u-bp2']:id==='g-hod'?['u-hod']:null,person:()=>false,pending:()=>({userIds:['u-hod'],label:'HOD'}),
   fallback:{groupId:'g-gbs',members:['u-gbs']},describe:r=>r.kind==='role'?r.role:r.kind});
  expect(result.userIds).toEqual(['u-emp','u-bp1','u-bp2','u-hod','u-gbs']);
  expect(result.fallbackUsed).toBe(true);
  expect(result.unresolved.map(u=>[u.meantFor,u.reason])).toEqual([['directSuperior','Nobody holds this role for the case.'],['person','This person can no longer be found.']]);
 });
});
