// Lane I (I5, I6; migration 5761): a named person who is not an active user is not "resolved" (the fallback group gets
// the message and the run says who it was meant for); an event that cannot be processed records a failed run with the
// error class instead of vanishing; the case History shows the run log only to people who can see the case.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import type {SessionContext} from '../db/client';
import {probationAutomationHistory} from '../packs/probation/service';
import {emitProbationEventsSafelyTx} from '../core/probation-automation';

let b:Base,admin:SessionContext,fixture:ReturnType<typeof probationOutcomeFixture>;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);fixture=probationOutcomeFixture(b,admin);});

async function liveWorkflow(name:string,trigger:string,steps:Record<string,unknown>[]){
 const id=randomUUID();
 const definition={name,description:'',module:'probation',trigger:{event:trigger,days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],
  steps:steps.map((step,i)=>({id:'s'+(i+1),conditions:[],to:[],cc:[],params:{},...step}))};
 await owner.db.execute(sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${id}::uuid,1,'probation','live',false,${JSON.stringify(definition)}::jsonb,'Fictional live workflow',${admin.userId}::uuid)`);
 return id;
}
const runner=()=>({...admin,userId:undefined,roles:[],grants:undefined} as SessionContext);
const emit=(caseId:string,partId:string,occurrence:string)=>owner.withTenant(runner(),tx=>emitProbationEventsSafelyTx(tx,runner(),caseId,[{trigger:'lmSubmitted',occurrence,facts:{partId,partType:3,dueOn:null,resultBand:3,overridden:false,pendingStep:null}}]));

describe('named-person recipients (I6)',()=>{
 it('counts a named person only while they are an active user; otherwise the fallback group receives it and the run says so',async()=>{
  const {ids,admin:pbp}=await fixture.recordedConfirm();admin=pbp;
  const leaver=await fixture.person('Fictional Leaver');
  await owner.db.execute(sql`update app_user set archived_at=now() where id=${leaver.userId}::uuid`);
  await liveWorkflow('Fictional named notice','lmSubmitted',[{type:'notify',params:{subject:'Named',body:'Named'},to:[{kind:'person',userId:leaver.userId}]}]);
  await emit(ids.caseId,ids.part,'named-1');
  const [run]=await owner.db.execute<{status:string;log:{kind:string;recipients?:string[];unresolved?:{meantFor:string;reason:string}[]}[]}>(sql`select status,log from automation_run where subject_id=${ids.caseId}::uuid and event_key like 'lmSubmitted|named-1%'`);
  expect(run.status).toBe('done');
  const done=run.log.find(entry=>entry.kind==='stepDone')!;
  expect(done.recipients).toEqual([admin.userId]);
  expect(done.unresolved).toContainEqual(expect.objectContaining({meantFor:'A named person',reason:'This person can no longer be found.'}));
  // An active named person is reached directly.
  const active=await fixture.person('Fictional Active Person');
  await liveWorkflow('Fictional active notice','lmSubmitted',[{type:'notify',params:{subject:'Active',body:'Active'},to:[{kind:'person',userId:active.userId}]}]);
  await emit(ids.caseId,ids.part,'named-2');
  const runs=await owner.db.execute<{log:{kind:string;recipients?:string[]}[]}>(sql`select log from automation_run where subject_id=${ids.caseId}::uuid and event_key like 'lmSubmitted|named-2%' order by started_at`);
  expect(runs.map(r=>r.log.find(entry=>entry.kind==='stepDone')?.recipients)).toContainEqual([active.userId]);
 });
});

describe('an event that cannot be processed (I6) and the case History (I5)',()=>{
 it('records a failed run with the error class, shows it in the History to people who see the case only, and never fails the caller',async()=>{
  const {ids,staff,admin:pbp}=await fixture.recordedConfirm();admin=pbp;
  // 201 active members: more than one notice may address (app.probation_automation_notify refuses), so the event throws.
  const members=await owner.db.execute<{id:string}>(sql`with p as (insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'Fictional member '||g,'member-'||g||'-'||${randomUUID()}||'@probation.example.test' from generate_series(1,201) g returning id)
   insert into app_user(tenant_id,workos_user_id,person_id) select ${b.tenantId}::uuid,'user_'||gen_random_uuid(),id from p returning id`);
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',(data->'groups')||jsonb_build_array(jsonb_build_object('id','everyone','name','Fictional everyone','members',${JSON.stringify(members.map(m=>m.id))}::jsonb,'limit',10))) where tenant_id=${b.tenantId}::uuid`);
  await liveWorkflow('Fictional crowded notice','lmSubmitted',[{type:'notify',params:{subject:'Crowded',body:'Crowded'},to:[{kind:'group',groupId:'everyone'}]}]);
  await expect(emit(ids.caseId,ids.part,'crowded')).resolves.toBeUndefined();
  await emit(ids.caseId,ids.part,'crowded');
  const runs=await owner.db.execute<{status:string;failure:string|null;key:string}>(sql`select status,failure,event_key as key from automation_run where subject_id=${ids.caseId}::uuid and event_key like 'failed|lmSubmitted|crowded|%'`);
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe('failed');expect(runs[0].failure).toContain('database 22023');
  expect(await owner.db.execute(sql`select 1 from probation_occurrence where case_id=${ids.caseId}::uuid and kind='automation'`)).toHaveLength(0);
  // History: newest first, bounded, the failure visible; an outsider without case access sees nothing.
  const history=await probationAutomationHistory(admin,ids.caseId);
  expect(history).toEqual([expect.objectContaining({trigger:'lmSubmitted',triggerLabel:expect.any(String),status:'failed',failure:expect.stringContaining('could not be processed')})]);
  expect(history[0].entries.map(entry=>entry.kind)).toEqual(['started','failed']);
  expect(history[0].entries[0].message).toContain('Fictional crowded notice');
  const outsider=await fixture.person('Fictional Outsider');
  expect(await probationAutomationHistory(outsider.ctx,ids.caseId)).toEqual([]);
  expect((await probationAutomationHistory(staff.ctx,ids.caseId)).length).toBeLessThanOrEqual(1);
 });
});
