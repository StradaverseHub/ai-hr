/** Native regression for the registered, reviewed private empty-opening finisher.
 * Genuine worker admission only. Negative tampering is confined to rollback savepoints; no valid proof is minted.
 */
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {owner,migrateTestDb,closeAll} from './harness';
import {contractPostingFixture,releaseContractPosting,approveAppliedContractPosting,finishContractPostingJob} from './helpers/contract-posting-fixture';
import {contractSharedTracker,openContractSharedPeriod,contractSharedContext,previewContractSharedDecision,submitContractSharedDecision,contractAutomationJobHandler} from '../packs/contracts/service';
import {saveAutomationWorkflow,saveAutomationEmailTemplate} from '../packs/automation/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {addDaysIso} from '../lib/roster-month';
import {addCalendarMonths} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
beforeAll(migrateTestDb);afterAll(closeAll);
// Both real reserved owner handles and begin() transactions expose this canonical query interface.
// Requiring connection-management methods would incorrectly exclude TransactionSql.
type Native=postgres.ISql;
function requiredIdentity(actor:SessionContext){
 const {userId,personId}=actor;
 if(!userId||!personId)throw Error('The native fixture requires an actual bound user and person.');
 return {...actor,userId,personId};
}
async function setup(nonempty=false){
 const fixture=await contractPostingFixture({future:false,payChanges:false});
 const f={...fixture,admin:requiredIdentity(fixture.admin),proposer:requiredIdentity(fixture.proposer),approver:requiredIdentity(fixture.approver),employeeActor:requiredIdentity(fixture.employeeActor)};
 const posting=await releaseContractPosting(f);await approveAppliedContractPosting(f.approver,{id:posting.id,revision:posting.revision});
 if(nonempty){
  const emailId=randomUUID();await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Fictional real opening effect',active:true,subject:'Opening',body:'Actual native queued mail; no transport is run.',cc:[]},expectedRevision:0,retired:false,reason:'Exercise genuine started opening work'});
  await saveAutomationWorkflow(f.admin,{workflow:{id:randomUUID(),module:'contract_staff',name:'Actual nonempty opening',description:'',status:'live',required:false,trigger:{event:'caseOpened',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:randomUUID(),type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:0,reason:'A real nonempty opening must never use empty technical completion'});
 }
 const row=(await contractSharedTracker(f.proposer)).rows.find(row=>row.employmentId===f.employee.employmentId);if(!row?.sourceRevision)throw Error('Native new-period source required');
 const result=await openContractSharedPeriod(f.proposer,{employmentId:f.employee.employmentId,sourceRevision:row.sourceRevision});
 const jobId=result.jobId;if(!jobId)throw Error('A genuine new-period opening must return its queued job.');
 const opened={...result,jobId};
 const[event]=await owner.db.execute<{id:string;versions:unknown;revision:number}>(sql`select id,workflow_versions as versions,decision_revision as revision from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and job_id=${opened.jobId}::uuid`);
 expect(event.revision).toBe(0);expect(event.versions).toHaveLength(nonempty?1:0);
 const accept=async()=>{
  const revision=(await contractSharedContext(f.proposer,opened.caseId)).flow!.revision,startOn=addDaysIso(f.newEnd,1);
  const preview=await previewContractSharedDecision(f.proposer,{caseId:opened.caseId,revision,draft:{kind:'renew',payChanges:false,months:6,startOn,endOn:addDaysIso(addCalendarMonths(startOn,6),-1),reason:'Real immediate next-period decision'}});
  // Only preview handlers run here; the opening event has not been drained by this helper.
  await finishContractPostingJob(preview.jobId,f.proposer,'contract_preview');
  return submitContractSharedDecision(f.proposer,{caseId:opened.caseId,revision,previewId:preview.previewId});
 };
 return {...f,opened,event,accept};
}
type F=Awaited<ReturnType<typeof setup>>;
async function image(native:Native,f:F){
 const [row]=await native<{value:unknown}[]>`select jsonb_build_object(
 'events',(select jsonb_agg(case when id=${f.event.id}::uuid then to_jsonb(e)-'processed_at' else to_jsonb(e) end order by id) from contract_shared_event e where tenant_id=${f.b.tenantId}::uuid),
 'cases',(select jsonb_agg(to_jsonb(c) order by id) from contract_case c where tenant_id=${f.b.tenantId}::uuid),
 'flows',(select jsonb_agg(to_jsonb(c) order by case_id) from contract_shared_case c where tenant_id=${f.b.tenantId}::uuid),
 'employment',(select to_jsonb(e) from employment e where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid),
 'assignments',(select jsonb_agg(to_jsonb(a) order by id) from assignment a where tenant_id=${f.b.tenantId}::uuid),
 'runs',(select jsonb_agg(to_jsonb(r) order by id) from automation_run r where tenant_id=${f.b.tenantId}::uuid),
 'letters',(select jsonb_agg(to_jsonb(l) order by id) from contract_shared_letter l where tenant_id=${f.b.tenantId}::uuid),
 'approvals',(select jsonb_agg(to_jsonb(a) order by id) from contract_shared_approval a where tenant_id=${f.b.tenantId}::uuid),
 'postings',(select jsonb_agg(to_jsonb(p) order by id) from personnel_posting p where tenant_id=${f.b.tenantId}::uuid),
 'deliveries',(select jsonb_agg(to_jsonb(d) order by id) from automation_email_delivery d where tenant_id=${f.b.tenantId}::uuid),
 'audit',(select jsonb_agg(to_jsonb(d) order by id) from domain_event d where tenant_id=${f.b.tenantId}::uuid)
 ) as value`;return row.value;
}
async function invoke(native:Native,f:F){const[row]=await native<{closed:boolean}[]>`select app.contract_shared_finish_empty_opening(${f.event.id}::uuid,${f.opened.jobId}::uuid) as closed`;return row.closed;}
async function processed(f:F){const[row]=await owner.db.execute<{value:unknown}>(sql`select processed_at as value from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and id=${f.event.id}::uuid`);return row.value;}
async function drive(f:F,probe:(native:Native)=>Promise<void>,failure=false){
 let reached=0,cause:unknown;
 const handler:typeof contractAutomationJobHandler={...contractAutomationJobHandler,
  async describeFailure(job,error,step,native){if(job.id===f.opened.jobId)cause=error;return contractAutomationJobHandler.describeFailure!(job,error,step,native);},
  async finalize(ctx,job,unit){
   if(job.id===f.opened.jobId&&reached===0){
    await unit.verifySeal();await unit.ownerTx!(async native=>{
     await native`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true),set_config('app.contract_event',${f.event.id},true)`;
     reached++;await probe(native);
    });
   }
   return contractAutomationJobHandler.finalize!(ctx,job,unit);
  }};
 const deadline=Date.now()+30_000;
 while(Date.now()<deadline){
  const[job]=await owner.db.execute<{state:string;notBefore:string|null}>(sql`select state,not_before::text as "notBefore" from bulk_job where id=${f.opened.jobId}::uuid`);
  if(job.state==='completed'||job.state==='failed'){
   expect(job.state).toBe(failure?'failed':'completed');
   if(!failure)expect(await owner.db.execute(sql`select id,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`)).toEqual([]);
   return {reached,cause};
  }
  const delay=job.notBefore?Date.parse(job.notBefore)-Date.now():0;
  if(delay>0){await new Promise(resolve=>setTimeout(resolve,Math.min(delay,250)));continue;}
  if(!await runBulkJobTick(owner.client,{handlers:[handler]}))await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw Error('Actual opening job did not settle');
}
it('denies app execution and an owner without an actual held capability',async()=>{
 const f=await setup();await f.accept();
 let denied:unknown;try{await withTenant(f.proposer,tx=>tx.execute(sql`select app.contract_shared_finish_empty_opening(${f.event.id}::uuid,${f.opened.jobId}::uuid)`));}catch(error){denied=error;}expect(pgSqlState(denied)).toBe('42501');
 await owner.client.begin(async native=>{await native`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true)`;expect(await invoke(native,f)).toBe(false);});
 expect(await processed(f)).toBeNull();
},180_000);
it('changes only processed_at inside an authentic held empty opening and rolls a successful probe back before normal completion',async()=>{
 const f=await setup();await f.accept();
 const result=await drive(f,async native=>{
  const before=await image(native,f);await native`savepoint empty_opening_positive`;
  expect(await invoke(native,f)).toBe(true);expect(await image(native,f)).toEqual(before);
  const[e]=await native<{done:boolean;error:string|null;reconciliation:unknown}[]>`select processed_at is not null as done,error,email_reconciliation as reconciliation from contract_shared_event where id=${f.event.id}::uuid`;
  expect(e).toEqual({done:true,error:null,reconciliation:null});
  await native`rollback to savepoint empty_opening_positive`;await native`release savepoint empty_opening_positive`;
  expect(await image(native,f)).toEqual(before);
 });expect(result.reached).toBe(1);expect(await processed(f)).not.toBeNull();
},180_000);
it('rejects actual actor, company and source drift plus sealed cursor tampering within a real held frame without any mutation',async()=>{
 const f=await setup();await f.accept();
 await drive(f,async native=>{
  const probes:[string,()=>Promise<unknown>][]=[
   ['actor archived',()=>native`update app_user set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${f.proposer.userId}::uuid`],
   ['actor relinked',()=>native`update app_user set person_id=${f.admin.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.proposer.userId}::uuid`],
   ['employment subject changed',()=>native`update employment set person_id=${f.admin.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`],
   ['module revoked',()=>native`update tenant_module set status='disabled' where tenant_id=${f.b.tenantId}::uuid and module_code='lifecycle'`],
   ['company archived',()=>native`update company set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${f.b.companyId}::uuid`],
   ['sealed cursor changed',()=>native`update bulk_job set plan=jsonb_set(plan,'{workflowCursor}','1'::jsonb) where id=${f.opened.jobId}::uuid`],
   ['extra cursor member',()=>native`update bulk_job set plan=plan||' {"unknownCursor":true}'::jsonb where id=${f.opened.jobId}::uuid`],
   ['seal digest changed',()=>native`update app.bulk_job_seal set input_digest=decode(repeat('00',32),'hex') where job_id=${f.opened.jobId}::uuid`],
  ];
  for(const[name,mutate]of probes){
   await native`savepoint empty_opening_negative`;await mutate();const before=await image(native,f);
   expect(await invoke(native,f),name).toBe(false);expect(await image(native,f),name).toEqual(before);
   await native`rollback to savepoint empty_opening_negative`;await native`release savepoint empty_opening_negative`;
  }
 });
},180_000);
it('rolls processed_at back when the genuine owner transaction fails after technical closure',async()=>{
 const f=await setup();await f.accept();let before:unknown;
 const result=await drive(f,async native=>{before=await image(native,f);expect(await invoke(native,f)).toBe(true);expect(await image(native,f)).toEqual(before);throw Error('Deliberate post-finisher transaction failure');},true);
 expect(result.reached).toBe(1);expect(String(result.cause)).toContain('Deliberate post-finisher transaction failure');expect(await processed(f)).toBeNull();
 await owner.client.begin(async native=>{await native`select set_config('app.tenant_id',${f.b.tenantId},true)`;expect(await image(native,f)).toEqual(before);});
},180_000);
it('keeps a genuine nonempty unstarted opening strict',async()=>{
 const f=await setup(true);await f.accept();
 const result=await drive(f,async native=>{const before=await image(native,f);expect(await invoke(native,f)).toBe(false);expect(await image(native,f)).toEqual(before);},true);
 expect(result.reached).toBeGreaterThan(0);expect(await processed(f)).toBeNull();
},180_000);
it('refuses the empty-opening finisher while existing native email recovery technically closes a genuinely completed email run',async()=>{
 const f=await setup(true);let started=false;
 const deadline=Date.now()+30_000;
 while(!started&&Date.now()<deadline){
  const[job]=await owner.db.execute<{notBefore:string|null}>(sql`select not_before::text as "notBefore" from bulk_job where id=${f.opened.jobId}::uuid`);
  const delay=job.notBefore?Date.parse(job.notBefore)-Date.now():0;
  if(delay>0){await new Promise(resolve=>setTimeout(resolve,Math.min(delay,250)));continue;}
  if(!await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]}))await new Promise(resolve=>setTimeout(resolve,50));
  const[run]=await owner.db.execute<{id:string}>(sql`select id from automation_run where tenant_id=${f.b.tenantId}::uuid and module='contract_staff' and subject_id=${f.opened.caseId}::uuid and trigger_event='caseOpened'`);started=!!run;
 }
 expect(started).toBe(true);expect(await processed(f)).toBeNull();
 const runs=()=>owner.db.execute<{id:string;status:string;cursor:number;waiting:string|null;remaining:unknown[];log:unknown[];row:unknown}>(sql`select id,status,step_cursor as cursor,waiting_for as waiting,remaining_steps as remaining,log,to_jsonb(r) as row from automation_run r where tenant_id=${f.b.tenantId}::uuid and module='contract_staff' and subject_id=${f.opened.caseId}::uuid and trigger_event='caseOpened' order by id`);
 const deliveries=()=>owner.db.execute<{row:unknown}>(sql`select to_jsonb(d) as row from automation_email_delivery d where tenant_id=${f.b.tenantId}::uuid and module='contract_staff' and subject_id=${f.opened.caseId}::uuid order by id`);
 const beforeRuns=await runs(),beforeDeliveries=await deliveries();expect(beforeRuns).toHaveLength(1);
 expect(beforeRuns[0]).toMatchObject({status:'done',cursor:1,waiting:null,remaining:[]});expect(beforeRuns[0].log.length).toBeGreaterThan(0);expect(beforeDeliveries).toHaveLength(1);
 const origins=await owner.db.execute<{run:string;root:string;origin:string;documents:unknown}>(sql`select pin.workflow_run_id as run,binding.root_event_id as root,binding.origin_event_id as origin,pin.documents from app.contract_email_prerequisite_origin binding join contract_shared_email_document_step pin on pin.tenant_id=binding.tenant_id and pin.id=binding.pin_id where binding.tenant_id=${f.b.tenantId}::uuid and binding.job_id=${f.opened.jobId}::uuid`);
 expect(origins).toEqual([{run:beforeRuns[0].id,root:f.event.id,origin:f.event.id,documents:{}}]);
 await f.accept();const decisionBefore=await contractSharedContext(f.proposer,f.opened.caseId);
 let held=false;
 const result=await drive(f,async native=>{
  const[guards]=await native<{ordinary:boolean;recovery:boolean}[]>`select app.contract_shared_worker_event_held(${f.opened.caseId}::uuid,0) as ordinary,app.contract_shared_email_recovery_frame(${f.opened.jobId}::uuid) as recovery`;
  expect(guards).toEqual({ordinary:false,recovery:true});held=true;
  const before=await image(native,f);expect(await invoke(native,f)).toBe(false);expect(await image(native,f)).toEqual(before);
 });
 expect(result.reached).toBe(1);expect(held).toBe(true);expect(await processed(f)).not.toBeNull();
 const[event]=await owner.db.execute<{error:string|null;reconciliation:unknown;versions:unknown}>(sql`select error,email_reconciliation as reconciliation,workflow_versions as versions from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and id=${f.event.id}::uuid`);
 expect(event.error).toBe('Original workflow authority changed; unattempted work is retained for reconciliation.');expect(event.reconciliation).toBeNull();expect(event.versions).toHaveLength(1);
 expect(await runs()).toEqual(beforeRuns);expect(await deliveries()).toEqual(beforeDeliveries);
 expect(await contractSharedContext(f.proposer,f.opened.caseId)).toEqual(decisionBefore);
 for(const table of ['contract_shared_approval','contract_shared_letter'] as const){
  const rows=table==='contract_shared_approval'?await owner.db.execute(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and case_id=${f.opened.caseId}::uuid`):await owner.db.execute(sql`select id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.opened.caseId}::uuid`);expect(rows).toEqual([]);
 }
 expect(await owner.db.execute(sql`select id from personnel_posting where tenant_id=${f.b.tenantId}::uuid and source='contract_staff' and source_ref=${f.opened.caseId}::uuid`)).toEqual([]);
},180_000);

it.each(['archived','relinked'] as const)('never reaches a finisher when the actual creator is %s before the kernel fence',async change=>{
 const f=await setup();await f.accept();
 if(change==='archived')await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${f.proposer.userId}::uuid`);
 else await owner.db.execute(sql`update app_user set person_id=${f.admin.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.proposer.userId}::uuid`);
 const result=await drive(f,async()=>{throw Error('A revoked/relinked creator must not reach the held finisher');},true);
 expect(result.reached).toBe(0);expect(await processed(f)).toBeNull();
},180_000);
