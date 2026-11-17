/** Separate Node process: genuine public services; Node assertions, no Vitest globals or role switching. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,join,resolve,sep} from 'node:path';
import type {ContractPostingFixture,releaseContractPosting} from './contract-posting-fixture';
import type {RestrictedPostingRuntimeReceipt} from './contract-posting-restricted-owner-runtime';
type Row=Record<string,unknown>;
type Facts={employment:Row;assignment:Row;compensation:Row};
type Payroll={batch:Row;slips:{id:string;row:Row}[]};
type Prepared={version:1;fixture:ContractPostingFixture;posting:Awaited<ReturnType<typeof releaseContractPosting>>;before:Facts;
 closed:{id:string;facts:Payroll}[];open:{id:string;facts:Payroll};documents:unknown[];prefix:{sequence:string;row:Row}[]};
const RESULT='CONTRACT_RESTRICTED_OWNER_RESULT ';

async function main(){
 assert.ok(process.execArgv.includes('--conditions=react-server'),'Use the canonical server runtime condition.');
 const phase=process.env.CONTRACT_POSTING_OWNER_RUNTIME_PHASE,database=process.env.CONTRACT_POSTING_OWNER_RUNTIME_DATABASE;
 const nonce=process.env.CONTRACT_POSTING_OWNER_RUNTIME_NONCE,folder=process.env.CONTRACT_POSTING_OWNER_RUNTIME_FOLDER,temp=process.env.RUNNER_TEMP;
 assert.ok(phase==='prepare'||phase==='apply');assert.ok(database&&/^ai_hr_test_w_aifocus[1-9][0-9]*$/.test(database));
 assert.ok(nonce&&/^[0-9a-f-]{36}$/.test(nonce));assert.ok(folder&&temp);
 assert.equal(realpathSync(folder),resolve(folder));assert.equal(realpathSync(temp),resolve(temp));
 assert.ok(folder.startsWith(realpathSync(temp)+sep));assert.ok(basename(folder).startsWith('aihr-contract-owner-runtime-'));
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.CI,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(process.env.RUNNER_OS,'Linux');assert.equal(process.platform,'linux');assert.equal(process.env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
 assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.WORKER_DB,'0');assert.equal(process.env.TEST_DB_NAMESPACE,'aifocus');
 const binding=JSON.parse(readFileSync(join(folder,'binding.json'),'utf8')) as {version:number;database:string;nonce:string;candidate:string;runId:string;attempt:string};
 assert.deepEqual(binding,{version:1,database,nonce,candidate:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT});
 assert.equal(binding.candidate,process.env.AIHR_CI_HEAD);
 const assertUrls=()=>{
  for(const[key,user]of [['TEST_DATABASE_URL','ai_hr_app'],['DATABASE_URL','ai_hr_app'],['TEST_MIGRATION_DATABASE_URL',phase==='apply'?'ai_hr_owner':'postgres'],['MIGRATION_DATABASE_URL',phase==='apply'?'ai_hr_owner':'postgres']]as const){
   let url:URL;try{url=new URL(process.env[key]??'');}catch{throw Error('Exact disposable runtime URL required.');}
   if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='5433'||url.username!==user||url.password||url.pathname!=='/'+database||url.search||url.hash)throw Error('Exact disposable runtime URL required.');
  }
 };
 assertUrls();
 // Match the standard test environment before the app singleton or harness is imported.
 await import('../env');
 assertUrls(); // Environment bootstrap must not redirect either role or target before app/harness import.
 const{sql}=await import('drizzle-orm');const{owner,closeAll,setModule,entitledCtx}=await import('../harness');
 const{withTenant}=await import('../../db/client');
 const{contractPostingFixture,releaseContractPosting:release}=await import('./contract-posting-fixture');
 const{reportContractPostingTemporalDiagnostics}=await import('./contract-posting-temporal-diagnostics');
 const{createMovementEvent}=await import('../../core/movement');
 const{createBatch,generatePayslips,closeBatch}=await import('../../packs/payroll/service');
 const{payslipForReview}=await import('../../core/payroll-view');
 const{requirePackFor}=await import('../../localization/registry');
 const{approveContractSharedPosting,readContractSharedPosting,readContractSharedPostingApprovalJob,contractPostingApplyJobHandler}=await import('../../packs/contracts/service');
 const{readBulkJob}=await import('../../core/bulk-job');const{runBulkJobTick}=await import('../../core/bulk-job-worker');
 const{openImportWorkerOwner}=await import('../../db/worker-connection');
 const{todayInKualaLumpur,addCalendarMonths}=await import('../../lib/hr-date');const{addDaysIso}=await import('../../lib/roster-month');
 const[bound]=await owner.db.execute<{nonce:string;candidate:string;database_name:string}>(sql`select nonce,candidate,database_name from app._test_contract_posting_owner_runtime_binding`);
 assert.deepEqual(bound,{nonce,candidate:binding.candidate,database_name:database});
 const month=(day:string,offset:number)=>addCalendarMonths(day.slice(0,7)+'-01',offset).slice(0,7);
 async function facts(f:ContractPostingFixture):Promise<Facts>{
  const[row]=await owner.db.execute<Facts>(sql`select to_jsonb(e) as employment,
   (select to_jsonb(a)-array['id','created_at','recorded_at','superseded_at'] from public.assignment a where a.tenant_id=e.tenant_id and a.employment_id=e.id and a.valid_to is null and a.superseded_at is null) as assignment,
   (select to_jsonb(c)-array['id','created_at','recorded_at','updated_at','superseded_at'] from public.compensation c where c.tenant_id=e.tenant_id and c.employment_id=e.id and c.valid_to is null and c.superseded_at is null) as compensation
   from public.employment e where e.tenant_id=${f.b.tenantId}::uuid and e.id=${f.employee.employmentId}::uuid`);
  assert.ok(row&&row.assignment&&row.compensation);return row;
 }
 async function payroll(f:ContractPostingFixture,id:string):Promise<Payroll>{
  const[batch]=await owner.db.execute<{row:Row}>(sql`select to_jsonb(b) as row from public.payroll_batch b where b.tenant_id=${f.b.tenantId}::uuid and b.id=${id}::uuid`);
  const slips=await owner.db.execute<{id:string;row:Row}>(sql`select p.id,to_jsonb(p) as row from public.payslip p where p.tenant_id=${f.b.tenantId}::uuid and p.batch_id=${id}::uuid order by p.id`);
  assert.ok(batch);return{batch:batch.row,slips:Array.from(slips)};
 }
 try{
  if(phase==='prepare'){
   const targetStart=addCalendarMonths(todayInKualaLumpur().slice(0,7)+'-01',-1);
   const f=await contractPostingFixture({endOn:addDaysIso(targetStart,-1),beforeAdopt:async({admin,employee,b,newStart})=>{
    await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'transfer',effectiveDate:addDaysIso(newStart,5),departmentId:b.deptB,remarks:'Fictional restricted-owner later department'});
    await createMovementEvent(admin,{employmentId:employee.employmentId,kind:'salaryAdjustment',effectiveDate:addDaysIso(newStart,10),basicSalary:5291.42,remarks:'Fictional restricted-owner later salary'});
   }});
   const posting=await release(f);await setModule(f.b.tenantId,'payroll','active');
   const payrollAdmin={...f.admin,entitlements:(await entitledCtx(f.b)).entitlements};
   await requirePackFor('MY').statutory.set(payrollAdmin,{personId:f.employee.personId,icNumber:'900101010001',taxCategory:1,numChildren:0});
   const runs:{id:string;facts:Payroll}[]=[];
   for(const offset of [-2,-1,0]){
    const{batchId}=await createBatch(payrollAdmin,{companyId:f.b.companyId,payPeriod:month(f.today,offset),scope:{employmentIds:[f.employee.employmentId]}});
    await generatePayslips(payrollAdmin,{batchId});if(offset<0)await closeBatch(payrollAdmin,{batchId});
    const stored=await payroll(f,batchId);assert.equal(stored.batch.status,offset<0?'closed':'processed');assert.equal(stored.slips.length,1);assert.ok(Number(stored.slips[0].row.net_pay)>0);runs.push({id:batchId,facts:stored});
   }
   const before=await facts(f);assert.equal(before.employment.contract_number,4);assert.equal(before.assignment.department_id,f.b.deptB);assert.equal(before.compensation.basic_salary,5291.42);
   const documents=await Promise.all(runs.map(run=>payslipForReview(payrollAdmin,{companyIds:[f.b.companyId],payslipId:run.facts.slips[0].id})));assert.ok(documents.every(Boolean));
   const prefix=await owner.db.execute<{sequence:string;row:Row}>(sql`select sequence::text,to_jsonb(d) as row from public.domain_event d where d.tenant_id=${f.b.tenantId}::uuid and d.subject_employment_id=${f.employee.employmentId}::uuid order by sequence`);assert.ok(prefix.length);
   const prepared:Prepared={version:1,fixture:{...f,admin:payrollAdmin},posting,before,closed:runs.slice(0,2),open:runs[2],documents,prefix:Array.from(prefix)};
   writeFileSync(join(folder,'prepared.json'),JSON.stringify(prepared),{mode:0o600,flag:'wx'});
   console.log(RESULT+JSON.stringify({prepared:true}));return;
  }
  const prepared=JSON.parse(readFileSync(join(folder,'prepared.json'),'utf8')) as Prepared;assert.equal(prepared.version,1);
  const f=prepared.fixture,posting=prepared.posting;assert.ok(f.newStart<f.today);assert.equal((await facts(f)).employment.contract_number,4);
  const[roles]=await withTenant(f.approver,tx=>tx.execute<{maintain:boolean;payroll:boolean}>(sql`select app.access_workforce_employment(${f.employee.employmentId}::uuid,'workforce.maintain') as maintain,app.can_admin_payroll_for(${f.b.companyId}::uuid) as payroll`));assert.deepEqual({...roles},{maintain:false,payroll:false});assert.deepEqual(f.approver.roles,['employee']);
  const queue=openImportWorkerOwner(process.env.TEST_MIGRATION_DATABASE_URL!);
  type Identity={session:string;current:string;super:boolean;bypass:boolean;createdb:boolean;createrole:boolean;pid:number};
  const identity=async()=>{
   const[row]=await queue<Identity[]>`select session_user::text as session,current_user::text as current,rolsuper as super,rolbypassrls as bypass,rolcreatedb as createdb,rolcreaterole as createrole,pg_backend_pid() as pid from pg_roles where rolname=current_user`;
   assert.deepEqual({...row,pid:0},{session:'ai_hr_owner',current:'ai_hr_owner',super:false,bypass:false,createdb:false,createrole:false,pid:0});return row;
  };
  try{
   const beforeIdentity=await identity();
   const queued=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});assert.equal(queued.postingStatus,'pending');
   if(queued.postingStatus!=='pending')throw Error('The genuine first approval must queue.');
   assert.deepEqual(await facts(f),prepared.before);assert.equal((await readContractSharedPosting(f.approver,posting.id))?.status,'pending');
   let job=await readBulkJob(f.approver,queued.jobId,'contract_posting_apply');
   for(let attempt=0;attempt<100&&job.state!=='completed';attempt++){
    assert.notEqual(job.state,'failed',job.error??'Restricted posting failed');assert.notEqual(job.state,'cancelled');
    assert.equal((await identity()).pid,beforeIdentity.pid);
    await runBulkJobTick(queue,{handlers:[contractPostingApplyJobHandler]});
    assert.equal((await identity()).pid,beforeIdentity.pid);
    job=await readBulkJob(f.approver,queued.jobId,'contract_posting_apply');
   }
   assert.equal(job.state,'completed');
   const status=await readContractSharedPostingApprovalJob(f.approver,queued.jobId);assert.equal(status.postingStatus,'approved');assert.equal(status.applicationState,'applied');
   try{
    assert.deepEqual(await facts(f),{...prepared.before,employment:{...prepared.before.employment,contract_start_date:f.newStart,contract_end_date:f.newEnd,contract_number:5}});
   }catch(error){
    await reportContractPostingTemporalDiagnostics('CONTRACT_POSTING_TEMPORAL_DIAGNOSTICS',f.b.tenantId,f.employee.employmentId);
    throw error;
   }
   for(const closed of prepared.closed)assert.deepEqual(await payroll(f,closed.id),closed.facts);
   const open=await payroll(f,prepared.open.id);assert.deepEqual(open.slips,prepared.open.facts.slips);assert.equal(open.batch.status,'processed');assert.ok(open.batch.needs_recalc_at);assert.ok(Array.isArray(open.batch.recalc_employment_ids)&&open.batch.recalc_employment_ids.includes(f.employee.employmentId));
   const{needs_recalc_at:_oldAt,recalc_employment_ids:_oldIds,...oldOpen}=prepared.open.facts.batch;const{needs_recalc_at:_newAt,recalc_employment_ids:_newIds,...newOpen}=open.batch;assert.deepEqual(newOpen,oldOpen);
   const allRuns=[...prepared.closed,prepared.open];const actualDocuments=await Promise.all(allRuns.map(run=>payslipForReview(f.admin,{companyIds:[f.b.companyId],payslipId:run.facts.slips[0].id})));assert.deepEqual(JSON.parse(JSON.stringify(actualDocuments)),prepared.documents);
   const snapshots=await owner.db.execute<{id:string}>(sql`select payslip_id as id from public.information_payslip_snapshot where tenant_id=${f.b.tenantId}::uuid and employment_id=${f.employee.employmentId}::uuid order by payslip_id`);
   assert.deepEqual(snapshots.map(row=>row.id),allRuns.map(run=>run.facts.slips[0].id).sort());
   const[finish]=await owner.db.execute<{login_name:string;backend_pid:number;actor:string}>(sql`select result.login_name,result.backend_pid,source.requester_user_id as actor from app.contract_posting_job_result result join app.contract_posting_job_source source on source.tenant_id=result.tenant_id and source.job_id=result.job_id where result.tenant_id=${f.b.tenantId}::uuid and result.job_id=${queued.jobId}::uuid`);
   assert.deepEqual({...finish},{login_name:'ai_hr_owner',backend_pid:beforeIdentity.pid,actor:f.approver.userId});
   const prefix=await owner.db.execute<{sequence:string;row:Row}>(sql`select sequence::text,to_jsonb(d) as row from public.domain_event d where d.tenant_id=${f.b.tenantId}::uuid and d.subject_employment_id=${f.employee.employmentId}::uuid and sequence<=${prepared.prefix.at(-1)!.sequence}::bigint order by sequence`);assert.deepEqual(Array.from(prefix),prepared.prefix);
   const duplicate=await approveContractSharedPosting(f.approver,{id:posting.id,revision:posting.revision});assert.equal(duplicate.postingStatus,'approved');assert.equal(duplicate.alreadyApproved,true);assert.ok(!('jobId'in duplicate));
   const receipt:RestrictedPostingRuntimeReceipt={version:1,sessionUser:'ai_hr_owner',currentUser:'ai_hr_owner',superuser:false,bypassRls:false,postingStatus:'approved',applicationState:'applied',preservedPayslips:snapshots.length,queueBackendMatchesReceipt:true};
   console.log(RESULT+JSON.stringify(receipt));
  }finally{await queue.end({timeout:5});}
 }finally{await closeAll();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Restricted Contract runtime fixture failed.');process.exitCode=1;});
