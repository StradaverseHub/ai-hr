/** Inactive protected posting packet: genuine human admission + kernel owner, never forged private frames.
 * Requires the reviewed6000–6008 packet to be registered by its integration owner before hosted execution.
 */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {migrateTestDb,closeAll,owner,setModule,entitledCtx} from './harness';
import {contractPostingFixture,releaseContractPosting,runContractPostingApplyTick,type ContractPostingFixture} from './helpers/contract-posting-fixture';
import {approveContractSharedPosting,readContractSharedPosting,readContractSharedPostingApprovalJob} from '../packs/contracts/service';
import {createMovementEvent,movementHistory,applyDueMovementsTx} from '../core/movement';
import {v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {createBatch,generatePayslips,closeBatch} from '../packs/payroll/service';
import {payslipForReview} from '../core/payroll-view';
import {requirePackFor} from '../localization/registry';
import {readBulkJob} from '../core/bulk-job';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {pgSqlState} from '../lib/db-error';
import {reportContractPostingTemporalDiagnostics} from './helpers/contract-posting-temporal-diagnostics';

beforeAll(migrateTestDb);afterAll(closeAll);
const monthStart=(day:string)=>day.slice(0,7)+'-01';
const periodAt=(day:string,offset:number)=>addCalendarMonths(monthStart(day),offset).slice(0,7);

async function finishPostingJob(actor:SessionContext,id:string){
 for(let count=0;count<100;count++){
  const job=await readBulkJob(actor,id,'contract_posting_apply');
  if(job.state==='completed')return job;
  if(job.state==='failed'||job.state==='cancelled')throw new Error(`Contract posting job ${job.state}: ${job.error??'no failure detail'}`);
  await runContractPostingApplyTick();
 }
 throw new Error('The actual Contract posting job did not settle.');
}
async function subjectFacts(f:ContractPostingFixture){
 const[row]=await owner.db.execute<{employment:Record<string,unknown>;assignment:Record<string,unknown>;compensation:Record<string,unknown>}>(sql`
  select to_jsonb(e) as employment,
   (select to_jsonb(a)-array['id','created_at','recorded_at','superseded_at'] from public.assignment a
    where a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null) as assignment,
   (select to_jsonb(c)-array['id','created_at','recorded_at','updated_at','superseded_at'] from public.compensation c
    where c.tenant_id=e.tenant_id and c.employment_id=e.id and c.valid_to is null and c.superseded_at is null) as compensation
  from public.employment e where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);
 expect(row).toBeTruthy();expect(row.assignment).toBeTruthy();expect(row.compensation).toBeTruthy();return row;
}
async function batchFacts(f:ContractPostingFixture,id:string){
 const[batch]=await owner.db.execute<{row:Record<string,unknown>}>(sql`select to_jsonb(b) as row from public.payroll_batch b where b.tenant_id=${f.b.tenantId}::uuid and b.id=${id}::uuid`);
 const slips=await owner.db.execute<{id:string;row:Record<string,unknown>}>(sql`select p.id,to_jsonb(p) as row from public.payslip p where p.tenant_id=${f.b.tenantId}::uuid and p.batch_id=${id}::uuid order by p.id`);
 expect(batch).toBeTruthy();return{batch:batch.row,slips};
}
async function payrollRun(f:ContractPostingFixture,admin:SessionContext,period:string,closed:boolean){
 const{batchId}=await createBatch(admin,{companyId:f.b.companyId,payPeriod:period,scope:{employmentIds:[f.employee.employmentId]}});
 await generatePayslips(admin,{batchId});
 if(closed)await closeBatch(admin,{batchId});
 const facts=await batchFacts(f,batchId);
 expect(facts.batch.status).toBe(closed?'closed':'processed');
 expect(facts.slips).toHaveLength(1);expect(facts.slips[0].row.employment_id).toBe(f.employee.employmentId);
 expect(Number(facts.slips[0].row.net_pay)).toBeGreaterThan(0);return{batchId,...facts};
}
async function assertNativeRefusal(work:Promise<unknown>){
 const failure=await work.then(()=>null,(error:unknown)=>error);
 expect(failure,'the existing database authority must refuse this path').not.toBeNull();
 expect(pgSqlState(failure)).toBe('42501');
}
function assertRedacted(value:unknown){
 const text=JSON.stringify(value);
 for(const forbidden of ['4976.21','5291.42','basicSalary','oldEmployment','old_employment','preservedCount','sourceHash','requestedValues'])expect(text).not.toContain(forbidden);
}

describe('Contract group approval through one protected native application job',()=>{
 it('keeps a past renewal pending until atomic apply, replays later department/pay, freezes issued Payroll and only stales open inputs',async()=>{
  const today=todayInKualaLumpur(),targetMonth=addCalendarMonths(monthStart(today),-1);
  const f=await contractPostingFixture({endOn:addDaysIso(targetMonth,-1),beforeAdopt:async({admin,employee,b,newStart})=>{
   await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'transfer',effectiveDate:addDaysIso(newStart,5),departmentId:b.deptB,remarks:'Fictional later recorded department decision'});
   await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'salaryAdjustment',effectiveDate:addDaysIso(newStart,10),basicSalary:5291.42,remarks:'Fictional later recorded salary decision'});
  }});
  expect(f.newStart).toBe(targetMonth);expect(f.newStart<f.today).toBe(true);
  const originalMovements=(await movementHistory(f.admin,f.employee.employmentId)).filter(row=>['transfer','salaryAdjustment'].includes(row.kind));
  expect(originalMovements).toHaveLength(2);
  const posting=await releaseContractPosting(f);
  await setModule(f.b.tenantId,'payroll','active');
  const payrollAdmin={...f.admin,entitlements:(await entitledCtx(f.b)).entitlements};
  await requirePackFor('MY').statutory.set(payrollAdmin,{personId:f.employee.personId,icNumber:'900101010001',taxCategory:1,numChildren:0});
  const earlier=await payrollRun(f,payrollAdmin,periodAt(f.today,-2),true);
  const overlapping=await payrollRun(f,payrollAdmin,periodAt(f.today,-1),true);
  const open=await payrollRun(f,payrollAdmin,periodAt(f.today,0),false);
  const draft=await createBatch(payrollAdmin,{companyId:f.b.companyId,payPeriod:periodAt(f.today,1),scope:{employmentIds:[f.employee.employmentId]}});
  const draftBefore=await batchFacts(f,draft.batchId);
  const documentsBefore=await Promise.all([earlier,overlapping,open].map(run=>payslipForReview(payrollAdmin,{companyIds:[f.b.companyId],payslipId:run.slips[0].id})));
  expect(documentsBefore.every(Boolean)).toBe(true);
  const before=await subjectFacts(f);
  expect(before.employment.contract_number).toBe(4);expect(before.assignment.department_id).toBe(f.b.deptB);expect(before.compensation.basic_salary).toBe(5291.42);
  const prefix=await owner.db.execute<{sequence:number;row:Record<string,unknown>}>(sql`select d.sequence,to_jsonb(d) as row from public.domain_event d where d.tenant_id=${f.b.tenantId}::uuid and d.subject_employment_id=${f.employee.employmentId}::uuid order by d.sequence`);
  expect(prefix.length).toBeGreaterThan(0);const maxSequence=prefix[prefix.length-1].sequence;
  const[rights]=await withTenant(f.approver,tx=>tx.execute<{maintain:boolean;payroll:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain,app.can_admin_payroll_for(${f.b.companyId}::uuid) as payroll`));
  expect(rights).toEqual({maintain:false,payroll:false});expect(f.approver.roles).toEqual(['employee']);
  const[visibility]=await withTenant(f.approver,tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from public.payslip where employment_id=${f.employee.employmentId}::uuid`));expect(visibility.n).toBe(0);
  await expect(createMovementEvent(f.approver,{employmentId:f.employee.employmentId,kind:'transfer',effectiveDate:f.today,departmentId:f.b.deptA})).rejects.toThrow();
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select app.preserve_movement_payroll(${f.employee.employmentId}::uuid)`)));

  const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
  if(queued.postingStatus!=='pending')throw new Error('This genuine fixture must enqueue its first approval.');
  expect(queued).toMatchObject({postingId:posting.id,postingStatus:'pending',applicationState:'queued'});expect(queued.jobId).toBeTruthy();
  expect(await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision})).toMatchObject({jobId:queued.jobId,postingStatus:'pending'});
  expect(await readContractSharedPosting(f.approver,posting.id)).toMatchObject({status:'pending',revision:posting.revision,approvalApplication:{jobId:queued.jobId,state:'queued'}});
  expect(await subjectFacts(f)).toEqual(before);
  expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({postingId:posting.id,postingStatus:'pending',applicationState:'queued'});
  await expect(readContractSharedPostingApprovalJob(f.employeeActor,queued.jobId)).rejects.toThrow();
  assertRedacted(queued);

  const job=await finishPostingJob(f.approver,queued.jobId);
  const status=await readContractSharedPostingApprovalJob(f.approver,queued.jobId);
  expect(status).toMatchObject({jobId:queued.jobId,postingId:posting.id,jobState:'completed',postingStatus:'approved',applicationState:'applied'});
  try{
   expect(await subjectFacts(f)).toEqual({...before,employment:{...before.employment,contract_start_date:f.newStart,contract_end_date:f.newEnd,contract_number:5}});
  }catch(error){
   await reportContractPostingTemporalDiagnostics('CONTRACT_POSTING_TEMPORAL_DIAGNOSTICS',f.b.tenantId,f.employee.employmentId);
   throw error;
  }
  expect(await batchFacts(f,earlier.batchId)).toEqual({batch:earlier.batch,slips:earlier.slips});
  expect(await batchFacts(f,overlapping.batchId)).toEqual({batch:overlapping.batch,slips:overlapping.slips});
  const openAfter=await batchFacts(f,open.batchId);
  expect(openAfter.slips).toEqual(open.slips);expect(openAfter.batch.status).toBe('processed');expect(openAfter.batch.needs_recalc_at).not.toBeNull();
  expect(openAfter.batch.recalc_employment_ids).toContain(f.employee.employmentId);
  const{needs_recalc_at:_oldStale,recalc_employment_ids:_oldIds,...openUnchanged}=open.batch;
  const{needs_recalc_at:_newStale,recalc_employment_ids:_newIds,...actualOpenUnchanged}=openAfter.batch;
  expect(actualOpenUnchanged).toEqual(openUnchanged);expect(await batchFacts(f,draft.batchId)).toEqual(draftBefore);
  expect(await Promise.all([earlier,overlapping,open].map(run=>payslipForReview(payrollAdmin,{companyIds:[f.b.companyId],payslipId:run.slips[0].id})))).toEqual(documentsBefore);
  const snapshots=await owner.db.execute<{id:string}>(sql`select s.payslip_id as id from public.information_payslip_snapshot s where s.tenant_id=${f.b.tenantId}::uuid and s.employment_id=${f.employee.employmentId}::uuid order by s.payslip_id`);
  expect(snapshots.map(row=>row.id)).toEqual([earlier,overlapping,open].map(run=>run.slips[0].id).sort());
  expect(await owner.db.execute(sql`select d.sequence,to_jsonb(d) as row from public.domain_event d where d.tenant_id=${f.b.tenantId}::uuid and d.subject_employment_id=${f.employee.employmentId}::uuid and d.sequence<=${maxSequence} order by d.sequence`)).toEqual(prefix);
  const history=await movementHistory(f.admin,f.employee.employmentId);
  for(const original of originalMovements)expect(history.find(row=>row.id===original.id)?.status).toBe('reversed');
  const created=await owner.db.execute<{actor:string;job:string;kind:string}>(sql`select d.actor_id as actor,d.payload->'bulkJob'->>'id' as job,d.payload->'bulkJob'->>'kind' as kind from public.domain_event d where d.tenant_id=${f.b.tenantId}::uuid and d.subject_employment_id=${f.employee.employmentId}::uuid and d.sequence>${maxSequence} order by d.sequence`);
  expect(created.length).toBeGreaterThan(0);expect(created.every(row=>row.actor===f.approver.userId&&row.job===queued.jobId&&row.kind==='contract_posting_apply')).toBe(true);
  assertRedacted(status);assertRedacted(job);
  const settled=await subjectFacts(f);await runContractPostingApplyTick();
  expect(await subjectFacts(f)).toEqual(settled);expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toEqual(status);
  const duplicate=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
  expect(duplicate).toMatchObject({postingStatus:'approved',applicationState:'applied',alreadyApproved:true,movementId:status.movementId,groupId:status.groupId});expect(duplicate).not.toHaveProperty('jobId');
  expect(await subjectFacts(f)).toEqual(settled);
  const[jobs]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.contract_posting_job_source where tenant_id=${f.b.tenantId}::uuid and posting_id=${posting.id}::uuid`);expect(jobs.n).toBe(1);
 },180_000);

 it('records a genuine future schedule without changing current Personnel and leaves due application to the ordinary authorized owner',async()=>{
  const f=await contractPostingFixture({future:true}),posting=await releaseContractPosting(f),before=await subjectFacts(f);
  const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
  if(queued.postingStatus!=='pending')throw new Error('This genuine fixture must enqueue its first approval.');
  expect(queued).toMatchObject({postingStatus:'pending',applicationState:'queued'});expect(await subjectFacts(f)).toEqual(before);
  await finishPostingJob(f.approver,queued.jobId);
  expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',postingStatus:'approved',applicationState:'scheduled'});
  expect(await subjectFacts(f)).toEqual(before);
  await expect(withTenant(f.approver,tx=>applyDueMovementsTx(tx,f.approver,f.employee.employmentId,f.today))).rejects.toThrow();
  expect(await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today))).toMatchObject({applied:0});
  expect(await withTenant(f.admin,tx=>applyDueMovementsTx(tx,f.admin,f.employee.employmentId,f.today))).toMatchObject({applied:0});
  expect(await subjectFacts(f)).toEqual(before);
  const scheduled=await owner.db.execute<{date:string;posting:string}>(sql`select d.payload->>'effectiveDate' as date,d.payload->'input'->>'contractPostingId' as posting from public.domain_event d where d.tenant_id=${f.b.tenantId}::uuid and d.subject_employment_id=${f.employee.employmentId}::uuid and d.event_type='employment.movement.scheduled' and d.payload->'input'->>'contractPostingId'=${posting.id}`);
  expect(scheduled).toEqual([{date:f.newStart,posting:posting.id}]);
 },120_000);

 it('refuses private owners, generic approval, old native aliases and source relabelling outside the genuine held application job',async()=>{
  const f=await contractPostingFixture(),posting=await releaseContractPosting(f),before=await subjectFacts(f);
  // A real existing human UID/PID/group with an agent marker must not be laundered into a human job.
  await assertNativeRefusal(withTenant(f.approver,async tx=>{
   await tx.execute(sql`select set_config('app.agent_principal_id',${randomUUID()},true)`);
   return tx.execute(sql`select app.contract_posting_request(${posting.id}::uuid,${posting.revision}::integer,NULL::jsonb)`);
  }));
  await expect(Promise.resolve().then(()=>approveContractSharedPosting({...f.approver,agent:{principalId:randomUUID(),enablements:[]}},{id:posting.id,revision:posting.revision}))).rejects.toMatchObject({code:'forbidden'});
  const[notAdmitted]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from app.contract_posting_job_source where tenant_id=${f.b.tenantId}::uuid and posting_id=${posting.id}::uuid`);expect(notAdmitted.n).toBe(0);
  const aliases=await owner.db.execute<{name:string}>(sql`select p.proname as name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'contract_shared_posting_approve%' and p.pronargs=3 and p.proargtypes[0]='uuid'::regtype and p.proargtypes[1]='integer'::regtype and p.proargtypes[2]='jsonb'::regtype order by p.proname`);
  expect(aliases.length).toBeGreaterThan(1);
  for(const alias of aliases)await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select ${sql.identifier('app')}.${sql.identifier(alias.name)}(${posting.id}::uuid,${posting.revision}::integer,NULL::jsonb)`)));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select app.personnel_posting_approve(${posting.id}::uuid,${posting.revision}::integer,NULL::jsonb)`)));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`update public.personnel_posting set status='approved',applied=proposed,approved_by=${f.approver.userId}::uuid,approved_at=now(),revision=revision+1 where tenant_id=${f.b.tenantId}::uuid and id=${posting.id}::uuid`)));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`update public.personnel_posting set source='probation',status='approved',applied=proposed,approved_by=${f.approver.userId}::uuid,approved_at=now(),revision=revision+1 where tenant_id=${f.b.tenantId}::uuid and id=${posting.id}::uuid`)));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select app.contract_posting_job_begin(${randomUUID()}::uuid)`)));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select app.preserve_payroll_metadata_owner(${f.employee.employmentId}::uuid,false,true)`)));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select app.workforce_payroll_inputs_changed_windows(${f.employee.employmentId}::uuid,${JSON.stringify([{from:f.newStart,until:null}])}::jsonb,'employment_information')`)));
  const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
  if(queued.postingStatus!=='pending')throw new Error('This genuine fixture must enqueue its first approval.');
  await assertNativeRefusal(withTenant(f.approver,async tx=>{
   await tx.execute(sql`select set_config('app.agent_principal_id',${randomUUID()},true)`);
   return tx.execute(sql`select app.contract_posting_request_status(${queued.jobId}::uuid)`);
  }));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select app.contract_posting_replay_target_begin(${queued.jobId}::uuid)`)));
  await assertNativeRefusal(withTenant(f.approver,tx=>tx.execute(sql`select app.contract_posting_job_protect(${queued.jobId}::uuid,${f.employee.employmentId}::uuid)`)));
  expect(await subjectFacts(f)).toEqual(before);expect(await readContractSharedPosting(f.approver,posting.id)).toMatchObject({status:'pending',revision:posting.revision});
  await finishPostingJob(f.approver,queued.jobId);
  expect(await readContractSharedPostingApprovalJob(f.approver,queued.jobId)).toMatchObject({jobState:'completed',applicationState:'applied'});
 },120_000);

 it('refuses a genuinely revoked posting group after enqueue and leaves the entire agreement pending',async()=>{
  const f=await contractPostingFixture(),posting=await releaseContractPosting(f),before=await subjectFacts(f);
  const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});
  if(queued.postingStatus!=='pending')throw new Error('This genuine fixture must enqueue its first approval.');
  expect(queued).toMatchObject({postingStatus:'pending',applicationState:'queued'});
  const config=(await v9Workspace(f.admin)).config!;
  expect(config.groups.find(group=>group.id===f.groupId)?.members).toContain(f.approver.userId);
  await v9SaveConfig(f.admin,config.revision,{...config,groups:config.groups.map(group=>group.id===f.groupId?{...group,members:[f.admin.userId!]}:group)});
  const[actual]=await withTenant(f.approver,tx=>tx.execute<{approver:boolean}>(sql`select app.contract_shared_posting_approver(${f.b.companyId}::uuid) as approver`));expect(actual.approver).toBe(false);
  await expect(readContractSharedPostingApprovalJob(f.approver,queued.jobId)).rejects.toThrow();
  let job=await readBulkJob(f.approver,queued.jobId,'contract_posting_apply');
  for(let attempt=0;attempt<100&&!['failed','cancelled','completed'].includes(job.state);attempt++){
   await runContractPostingApplyTick();
   expect(await subjectFacts(f)).toEqual(before);
   job=await readBulkJob(f.approver,queued.jobId,'contract_posting_apply');
  }
  expect(job.state).toBe('failed');assertRedacted(job);
  expect(await readContractSharedPosting(f.admin,posting.id)).toMatchObject({status:'pending',revision:posting.revision,movementAppliedAt:null});
  expect(await subjectFacts(f)).toEqual(before);
  const[receipt]=await owner.db.execute<{movement:string|null;applied:Date|null;results:number}>(sql`select p.movement_id as movement,r.applied_at as applied,(select count(*)::int from app.contract_posting_job_result result where result.job_id=${queued.jobId}::uuid) as results from public.personnel_posting p join public.contract_shared_posting r on r.tenant_id=p.tenant_id and r.posting_id=p.id where p.tenant_id=${f.b.tenantId}::uuid and p.id=${posting.id}::uuid`);
  expect(receipt).toEqual({movement:null,applied:null,results:0});
 },120_000);

});
