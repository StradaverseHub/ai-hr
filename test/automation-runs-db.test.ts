import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {
 AutomationError,automationRunsForSubjectTx,resumeAutomationRunsTx,runAutomationEventTx,saveAutomationWorkflow,
 type AutomationExecutors,type AutomationRuntimeEvent,type AutomationWorkflow,
} from '../packs/automation/service';

/**
 * Migration 5748 and core/automation-runtime.ts: who may run and read, frozen steps, idempotency, pause/resume through
 * the database store, forward-only progress, append-only audit and tenant isolation. The Probation storage runner is the
 * migration owner session without a signed-in user (app.probation_storage_runner), as for the nightly sweep.
 */
let b:Base,admin:SessionContext,runner:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);runner={...admin,userId:undefined,roles:[],grants:undefined} as SessionContext;});
const asRunner=<T,>(work:(tx:Tx)=>Promise<T>)=>owner.withTenant(runner,work);
const workflow=(over:Partial<AutomationWorkflow>={}):AutomationWorkflow=>({id:randomUUID(),module:'probation',name:'Outcome · Confirm',description:'',status:'live',required:true,
 trigger:{event:'outcomeDecided',days:0,workdays:false,repeat:false},skipWhen:'caseClosed',conditions:[{field:'outcome',op:'is',values:['Confirm']}],
 steps:[{id:'letter',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:'tpl-confirm'}},{id:'tell',type:'notify',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{subject:'Your letter is ready'}}],...over});
const event=(subjectId:string,over:Partial<AutomationRuntimeEvent>={}):AutomationRuntimeEvent=>({trigger:'outcomeDecided',subjectId,occurrence:'outcome-1',today:'2026-11-16',read:f=>f==='outcome'?'Confirm':undefined,anchor:()=>null,skipReason:()=>null,...over});
function executors(calls:string[]):AutomationExecutors{return{generateDocument:async({step})=>{calls.push(step.id);return{status:'wait',documentId:'00000000-0000-4000-8000-000000000d01'};},notify:async({step})=>{calls.push(step.id);return{status:'done',recipients:['fictional']};},notifyFailure:async()=>{calls.push('failure');}};}
async function plainUser(){const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional runner user',${randomUUID()+'@runs.example.test'}) returning id`);const userId=await createAppUser(b.tenantId,p.id,'employee');return{...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;}
const rejects=async(p:Promise<unknown>,code:AutomationError['code'])=>{await expect(p).rejects.toBeInstanceOf(AutomationError);await expect(p).rejects.toMatchObject({code});};

describe('shared workflow runs in the database',()=>{
 it('pins the live revision, pauses at the document, is idempotent and resumes the frozen steps after release',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Default'});
  const subject=randomUUID(),calls:string[]=[];
  const first=await asRunner(tx=>runAutomationEventTx(tx,{module:'probation',event:event(subject),executors:executors(calls)}));
  expect(first.matched).toBe(true);expect(first.runs[0]).toMatchObject({workflowId:wf.id,workflowRevision:1,status:'waiting',cursor:1});
  const again=await asRunner(tx=>runAutomationEventTx(tx,{module:'probation',event:event(subject),executors:executors(calls)}));
  expect(again.runs).toEqual([]);expect(again.alreadyRan.map(r=>r.id)).toEqual([first.runs[0].id]);expect(calls).toEqual(['letter']);
  // A later revision removes the notify step; the waiting run keeps its frozen copy.
  await saveAutomationWorkflow(admin,{workflow:{...wf,steps:[wf.steps[0]]},expectedRevision:1,reason:'Edited later'});
  const resumed=await asRunner(tx=>resumeAutomationRunsTx(tx,{module:'probation',subjectId:subject,documentId:'00000000-0000-4000-8000-000000000d01',executors:executors(calls),read:event(subject).read}));
  expect(resumed.map(r=>r.status)).toEqual(['done']);expect(calls).toEqual(['letter','tell']);
  const[row]=await owner.db.execute<{status:string;step_cursor:number;waiting_for:string|null;remaining:number;revision:number}>(sql`select status,step_cursor,waiting_for,jsonb_array_length(remaining_steps) remaining,workflow_revision revision from automation_run where id=${first.runs[0].id}::uuid`);
  expect(row).toEqual({status:'done',step_cursor:2,waiting_for:null,remaining:0,revision:1});
  const events=await owner.db.execute<{event_type:string}>(sql`select event_type from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${first.runs[0].id}::uuid order by sequence`);
  expect(events.map(e=>e.event_type)).toEqual(['automation.run.started','automation.run.waiting','automation.run.done']);
  expect((await withTenant(admin,tx=>automationRunsForSubjectTx(tx,'probation',subject))).map(r=>r.status)).toEqual(['done']);
 });
 it('reports no matching workflow and ignores paused workflows and other triggers',async()=>{
  await saveAutomationWorkflow(admin,{workflow:workflow({status:'paused'}),expectedRevision:0,reason:'Paused'});
  await saveAutomationWorkflow(admin,{workflow:workflow({trigger:{event:'caseOpened',days:0,workdays:false,repeat:false},conditions:[]}),expectedRevision:0,reason:'Other trigger'});
  const result=await asRunner(tx=>runAutomationEventTx(tx,{module:'probation',event:event(randomUUID()),executors:executors([])}));
  expect(result).toMatchObject({matched:false,runs:[],decisions:[]});
 });
 it('lets only the module runner for the case start runs and keeps runs closed to direct writes',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Default'});
  const plain=await plainUser(),subject=randomUUID();
  await rejects(withTenant(plain,tx=>runAutomationEventTx(tx,{module:'probation',event:event(subject),executors:executors([])})),'forbidden');
  // Configuring workflows is not access to a case: without case access a configurer cannot run them either.
  await rejects(withTenant(admin,tx=>runAutomationEventTx(tx,{module:'probation',event:event(subject),executors:executors([])})),'forbidden');
  const{runs:[run]}=await asRunner(tx=>runAutomationEventTx(tx,{module:'probation',event:event(subject),executors:executors([])}));
  expect(await withTenant(plain,tx=>automationRunsForSubjectTx(tx,'probation',subject))).toEqual([]);
  for(const statement of[
   sql`insert into automation_run(tenant_id,id,module,workflow_id,workflow_revision,subject_id,event_key,trigger_event,status) values(${b.tenantId}::uuid,${randomUUID()}::uuid,'probation',${wf.id}::uuid,1,${subject}::uuid,'forged','outcomeDecided','done')`,
   sql`update automation_run set status='done',waiting_for=null where id=${run.id}::uuid`,
   sql`delete from automation_run where id=${run.id}::uuid`,
   sql`select app.automation_run_save(${run.id}::uuid,'waiting','done',2,null,'[]'::jsonb,'[]'::jsonb,null)`,
  ])await expect(withTenant(admin,tx=>tx.execute(statement))).rejects.toThrow();
 });
 it('refuses tampered frozen steps, backward progress and changes to a finished run',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Default'});
  const subject=randomUUID(),frozen=JSON.stringify(wf.steps.map((step,index)=>({index,step})));
  const start=(id:string,remaining:string,key:string)=>asRunner(tx=>tx.execute<{r:{created:boolean}}>(sql`select app.automation_run_start(${id}::uuid,'probation',${wf.id}::uuid,1,${subject}::uuid,${key},'outcomeDecided','running',${remaining}::jsonb,'[]'::jsonb) as r`));
  await expect(start(randomUUID(),JSON.stringify([{index:0,step:{...wf.steps[0],type:'startOffboarding'}},{index:1,step:wf.steps[1]}]),'tampered')).rejects.toThrow();
  const id=randomUUID();expect((await start(id,frozen,'k1'))[0].r.created).toBe(true);
  expect((await start(randomUUID(),frozen,'k1'))[0].r.created).toBe(false);
  const save=(expected:string,status:string,cursor:number,waiting:string|null,remaining:string,failure:string|null=null)=>asRunner(tx=>tx.execute(sql`select app.automation_run_save(${id}::uuid,${expected},${status},${cursor},${waiting}::uuid,${remaining}::jsonb,'[]'::jsonb,${failure})`));
  await expect(save('running','running',1,null,JSON.stringify([{index:1,step:{...wf.steps[1],type:'startOffboarding'}}]))).rejects.toThrow();
  await expect(save('running','waiting',1,null,JSON.stringify([{index:1,step:wf.steps[1]}]))).rejects.toThrow();
  await expect(save('waiting','done',2,null,'[]')).rejects.toThrow();
  await save('running','failed',1,null,JSON.stringify([{index:1,step:wf.steps[1]}]),'The document template is retired.');
  await expect(save('failed','running',1,null,JSON.stringify([{index:1,step:wf.steps[1]}]))).rejects.toThrow();
  await expect(asRunner(tx=>tx.execute(sql`select app.automation_run_start(${randomUUID()}::uuid,'probation',${wf.id}::uuid,9,${subject}::uuid,'k2','outcomeDecided','running',${frozen}::jsonb,'[]'::jsonb)`))).rejects.toThrow();
 });
 it('never crosses tenants',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Default'});
  const subject=randomUUID();await asRunner(tx=>runAutomationEventTx(tx,{module:'probation',event:event(subject),executors:executors([])}));
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const foreignAdmin=adminCtx(foreign),foreignRunner={...foreignAdmin,userId:undefined,roles:[],grants:undefined} as SessionContext;
  expect(await withTenant(foreignAdmin,tx=>automationRunsForSubjectTx(tx,'probation',subject))).toEqual([]);
  const other=await owner.withTenant(foreignRunner,tx=>runAutomationEventTx(tx,{module:'probation',event:event(subject),executors:executors([])}));
  expect(other.matched).toBe(false);
  expect(await owner.withTenant(foreignRunner,tx=>resumeAutomationRunsTx(tx,{module:'probation',subjectId:subject,documentId:'00000000-0000-4000-8000-000000000d01',executors:executors([]),read:()=>undefined}))).toEqual([]);
 });
});
