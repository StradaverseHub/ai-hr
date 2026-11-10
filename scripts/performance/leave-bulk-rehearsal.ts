/**
 * Fictional-data rehearsal of the leave family on the shared bulk-job kernel (DESIGN.md acceptance bar): leave
 * ledger import, Generate Entitlement, Run Earned Accrual (background jobs run by the real protected worker
 * process, scripts/bank-import-runner.ts) and the batched accrual and carry-expiry timers (in process). Disposable
 * database only: refuses any URL not pointing at the rehearsal port. For each operation it runs the hot-path probes
 * (login, Access writer, clock-in, My Profile, Home, Personnel), samples every tenant-wide lock, and prints the
 * longest hold, the probe maxima, errors and Busy refusals. SYNC_BASELINE=1 also times the old single-transaction
 * earned accrual for comparison. Env: DATABASE_URL (app), MIGRATION_DATABASE_URL (owner), REHEARSAL_PORT,
 * REHEARSAL_TENANT, REHEARSAL_ADMIN, BASE_EMPLOYEES (3000), OPS (comma list; default all).
 */
import '../lib/stub-server-only';
import {spawn,type ChildProcess} from 'node:child_process';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {startTenantLockSampler} from './tenant-lock-sampler';

const required=(name:string,v:string|undefined)=>{if(!v)throw new Error(`${name} is required`);return v;};
const port=required('REHEARSAL_PORT',process.env.REHEARSAL_PORT);
const OWNER_URL=required('MIGRATION_DATABASE_URL',process.env.MIGRATION_DATABASE_URL);
for(const url of [required('DATABASE_URL',process.env.DATABASE_URL),OWNER_URL])if(new URL(url).port!==port)throw new Error('Refusing: rehearsal runs only against the disposable cluster port.');
const TENANT=required('REHEARSAL_TENANT',process.env.REHEARSAL_TENANT),ADMIN=required('REHEARSAL_ADMIN',process.env.REHEARSAL_ADMIN);
const BASE=Number(process.env.BASE_EMPLOYEES??3000);
const OPS=(process.env.OPS??'idle_baseline,generation_preview,generation,accrual_job,recalc_job,a2c_job,leave_import,expiry_timer,accrual_timer').split(',').map(s=>s.trim()).filter(Boolean);
if(process.env.AUDIT_HASH_CHAIN_ENABLED!=='true')process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const BUSY=/busy|unavailable; review it again|try again|timeout|too many/i;

async function main(){
 const {commitEmployeeImport}=await import('../../core/import');
 const {checkIn}=await import('../../packs/attendance/service');
 const {withTenant,client}=await import('../../db/client');
 const {lockAccessConfigurationTx}=await import('../../core/access-configuration-lock');
 const {listEmployeesPage}=await import('../../core/read');
 const {myProfile}=await import('../../core/profile');
 const {verifyTenantChain}=await import('../../core/audit-chain');
 const {freshImportContext}=await import('../../core/bank-import-worker');
 const {readEmployeeHomeSummary}=await import('../../core/employee-home-summary');
 const {createLeaveImportJob}=await import('../../core/leave-import-job');
 const {createLeaveGenerationJob,createEarnedAccrualJob,createLeaveRecalcJob}=await import('../../core/leave-cohort-job');
 const {previewLeaveGeneration}=await import('../../core/leave-generation');
 const {updateLeaveType}=await import('../../core/admin');
 const {accrueEarnedLeaveInBatches,expireCarriedLeaveInBatches}=await import('../../core/leave-cohort-run');
 const {accrueEarnedLeave}=await import('../../packs/leave/service');
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});
 const {entitlements}=await freshImportContext({tenantId:TENANT,userId:ADMIN,roles:['hr_admin']} as never);
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson??undefined,roles:['hr_admin'],entitlements} as never;
 const system={tenantId:TENANT,roles:['hr_admin'],entitlementsExempt:'sweeps'} as never;
 const [{company_id:companyId}]=await obs`select company_id from department where name='Finance' and tenant_id=${TENANT}::uuid limit 1`;
 const [{id:employmentId}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code=${process.env.CLOCK_EMPLOYEE_CODE??'EMP-0007'}`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 const tag=Date.now().toString(36).toUpperCase();
 const [{count}]=await obs`select count(*)::int from employment where tenant_id=${TENANT}::uuid and voided_at is null and import_pending_attempt_id is null`;
 console.log(`base employees present: ${count}, target ${BASE}`);
 if(count<BASE){
  const need=BASE-count;const t0=Date.now();
  for(let start=0;start<need;start+=200){
   const records=Array.from({length:Math.min(200,need-start)},(_,i)=>({full_name:`Fictional Leave ${tag} ${start+i}`,email:`leave-${tag.toLowerCase()}-${start+i}@example.test`,employee_code:`RLV${tag}${start+i}`,department:'Finance',hired_on:['2019-03-04','2022-07-15','2025-05-20','2026-02-10'][(start+i)%4],employment_type:'full_time',basic_salary:'4200'}));
   const r=await commitEmployeeImport(admin,{companyId,records});if(r.failed.length||r.fileErrors.length)throw new Error('base seed failed: '+JSON.stringify(r.fileErrors).slice(0,300)+JSON.stringify(r.failed[0]).slice(0,300));
  }
  console.log(`seeded ${need} base employees in ${Date.now()-t0}ms`);
 }
 // Carry-forward rules on Annual Leave so year-open caps and the expiry timer forfeits (fictional configuration).
 await obs`update leave_type set carry_forward_max=coalesce(carry_forward_max,5),carry_forward_expiry_month=coalesce(carry_forward_expiry_month,3),carry_forward_expiry_day=coalesce(carry_forward_expiry_day,31) where tenant_id=${TENANT}::uuid and code='ANNUAL' and archived_at is null`;
 const worker:{proc?:ChildProcess}={};
 worker.proc=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
 const clockBase=Date.parse(process.env.CLOCK_BASE??'2027-01-04');let clockSeq=0;
 const clockDay=()=>new Date(clockBase+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runProbes=()=>Promise.all([
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
  loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',1000,()=>checkIn(admin,{employmentId,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,selfUser.employment_id,'en','Replacement holiday')),
 ]);
 const waitJob=async(id:string)=>{for(;;){const [r]=await obs`select state,steps_done,steps_total,counters,metrics,error,errors,result is not null as has_result from bulk_job where id=${id}::uuid`;if(['completed','failed','cancelled'].includes(r.state))return r;await sleep(500);}};
 const results:Record<string,unknown>={};
 const measure=async(op:string,run:()=>Promise<Record<string,unknown>>)=>{
  lat=newLat();errors.length=0;stop=false;const probes=runProbes();await sleep(1500);
  const sampler=await startTenantLockSampler(obs,TENANT);const started=Date.now();
  let outcome:Record<string,unknown>;try{outcome=await run();}catch(e){outcome={thrown:String((e as Error)?.message??e).slice(0,300)};}
  const wallMs=Date.now()-started;await sleep(1500);stop=true;await probes;const tenantLocks=await sampler.stop();
  const errs=[...errors];
  results[op]={wallMs,...outcome,tenantLocks,probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errorCount:errs.length,busyCount:errs.filter(e=>BUSY.test(e)).length,errors:[...new Set(errs)].slice(0,6)};
  console.log(op,JSON.stringify(results[op]));
 };
 const job=(o:{id:string})=>waitJob(o.id).then(r=>({state:r.state,steps:r.steps_total,counters:r.counters,metrics:r.metrics,error:r.error,rowErrors:(r.errors??[]).length}));
 if(process.env.SYNC_BASELINE==='1')await measure('accrual_sync_baseline',async()=>{const r=await accrueEarnedLeave(admin,{asOf:'2026-11-30'});return{granted:r.granted,forfeits:r.forfeits};});
 for(const op of OPS){
  if(op==='idle_baseline'){
   // The same probes with no bulk work running, so a probe that is slow on this host anyway is not blamed on a job.
   await measure(op,async()=>{await sleep(Number(process.env.BASELINE_SECONDS??30)*1000);return{};});
  }else if(op==='leave_import'){
   const codes=await obs<{code:string}[]>`select employee_code as code from employment where tenant_id=${TENANT}::uuid and voided_at is null and employee_code is not null order by employee_code limit ${BASE}`;
   const records=codes.map(c=>({employee_id:c.code,leave_type:'ANNUAL',transaction_type:'adjustment',days:'0.50',effective_date:process.env.IMPORT_DATE??'2026-11-02'}));
   await measure(op,async()=>({rows:records.length,...await job(await createLeaveImportJob(admin,{records,source:{kind:'paste'}}))}));
  }else if(op==='generation'){
   await measure(op,async()=>job(await createLeaveGenerationJob(admin,{year:Number(process.env.GENERATION_YEAR??2027),targetMode:'criteria',criteria:{}})));
  }else if(op==='generation_preview'){
   // The dry run in its own READ ONLY snapshot: no tenant lock should be held at all while it computes.
   await measure(op,async()=>{const r=await previewLeaveGeneration(admin,{year:Number(process.env.GENERATION_YEAR??2027),targetMode:'criteria',criteria:{}});return{granted:r.granted,reached:r.employeesReached,earnedPosted:r.accrual?.posted??null};});
  }else if(op==='recalc_job'){
   const [{id:annual}]=await obs<{id:string}[]>`select id from leave_type where tenant_id=${TENANT}::uuid and code='ANNUAL' and archived_at is null`;
   await measure(op,async()=>job(await createLeaveRecalcJob(admin,{leaveTypeId:annual,trigger:'rehearsal',asOf:process.env.RECALC_ASOF??'2026-11-30'})));
  }else if(op==='a2c_job'){
   // A Leave Year Type save moving Annual Leave to Anniversary-to-Calendar: the save admits the job, which re-projects
   // every first-year employee staged and releases them at once.
   const [sick]=await obs<{id:string;name:string;override:string|null}[]>`select id,name,year_cycle_override as override from leave_type where tenant_id=${TENANT}::uuid and code='ANNUAL' and archived_at is null`;
   if(sick.override==='a2c')await updateLeaveType(admin,{id:sick.id,name:sick.name,yearCycleOverride:null,asOf:'2026-11-30',a2cInBackground:true});
   await measure(op,async()=>{
    const started=Date.now();
    await updateLeaveType(admin,{id:sick.id,name:sick.name,yearCycleOverride:'a2c',asOf:'2026-11-30',a2cInBackground:true});
    const saveMs=Date.now()-started;
    const [{id}]=await obs<{id:string}[]>`select id from bulk_job where tenant_id=${TENANT}::uuid and kind='leave_a2c' order by created_at desc limit 1`;
    return{saveMs,...await job({id})};
   });
  }else if(op==='accrual_job'){
   await measure(op,async()=>job(await createEarnedAccrualJob(admin,{asOf:'2026-12-31'})));
  }else if(op==='expiry_timer'){
   let longest=0;await measure(op,async()=>({...await expireCarriedLeaveInBatches(system,{today:process.env.EXPIRY_TODAY??'2027-04-01'},{onBatch:ms=>{longest=Math.max(longest,ms);}}),longestBatchTxMs:Math.round(longest)}));
  }else if(op==='accrual_timer'){
   let longest=0;await measure(op,async()=>({...await accrueEarnedLeaveInBatches(system,{asOf:'2026-12-31'},{onBatch:ms=>{longest=Math.max(longest,ms);}}),longestBatchTxMs:Math.round(longest)}));
  }
 }
 const proc=worker.proc;if(proc&&proc.exitCode===null){const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await exited;}
 const chain=await verifyTenantChain(admin);
 console.log(JSON.stringify({rehearsal:results,auditChain:chain},null,2));
 await obs.end();await client.end();
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
