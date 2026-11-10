/**
 * Fictional-data rehearsal of the background movement import (bulk-job kernel, draft 9910). Disposable database only:
 * refuses any URL not on the rehearsal port. Seeds a populated tenant (BASE_EMPLOYEES, default 3000) plus the
 * movement subjects, checks a full-size movement file (50 employees, ~180 rows: promotions with salary, transfers,
 * manager changes, exits of people with logins and company changes), then confirms it twice on separate subjects:
 *   1. the old synchronous confirmation (one request), for the reference lock profile;
 *   2. the background job, run by the real protected worker process (scripts/bank-import-runner.ts).
 * Hot-path probes (login, an Access writer, clock-in, My Profile, Home, Personnel) and an independent sampler of every
 * tenant-wide lock run during each phase. Env: DATABASE_URL (app), MIGRATION_DATABASE_URL (owner), REHEARSAL_PORT,
 * REHEARSAL_TENANT, REHEARSAL_ADMIN, BASE_EMPLOYEES (3000), SUBJECTS (50), SKIP_SYNC=1.
 */
import '../lib/stub-server-only';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {startTenantLockSampler} from './tenant-lock-sampler';

const required=(name:string,v:string|undefined)=>{if(!v)throw new Error(`${name} is required`);return v;};
const port=required('REHEARSAL_PORT',process.env.REHEARSAL_PORT);
const OWNER_URL=required('MIGRATION_DATABASE_URL',process.env.MIGRATION_DATABASE_URL);
for(const url of [required('DATABASE_URL',process.env.DATABASE_URL),OWNER_URL])if(new URL(url).port!==port)throw new Error('Refusing: rehearsal runs only against the disposable cluster port.');
const TENANT=required('REHEARSAL_TENANT',process.env.REHEARSAL_TENANT),ADMIN=required('REHEARSAL_ADMIN',process.env.REHEARSAL_ADMIN);
const BASE=Number(process.env.BASE_EMPLOYEES??3000),SUBJECTS=Number(process.env.SUBJECTS??50);
if(process.env.AUDIT_HASH_CHAIN_ENABLED!=='true')process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function main(){
 const {commitEmployeeImport}=await import('../../core/import');
 const {previewMovementUpload,confirmMovementUpload}=await import('../../core/movement-import-history');
 const {startMovementImportJob}=await import('../../core/movement-import-job');
 const {createJobGrade,createPosition}=await import('../../core/admin');
 const {checkIn}=await import('../../packs/attendance/service');
 const {withTenant,client}=await import('../../db/client');
 const {lockAccessConfigurationTx}=await import('../../core/access-configuration-lock');
 const {listEmployeesPage}=await import('../../core/read');
 const {myProfile}=await import('../../core/profile');
 const {verifyTenantChain}=await import('../../core/audit-chain');
 const {freshImportContext}=await import('../../core/bank-import-worker');
 const {readEmployeeHomeSummary}=await import('../../core/employee-home-summary');
 const {personnelImportLabelResolvers}=await import('../../lib/personnel-import-labels.runtime');
 const {toCsv}=await import('../../lib/csv');
 const {todayInKualaLumpur}=await import('../../lib/hr-date');
 const resolve=personnelImportLabelResolvers[0];
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});
 const {entitlements}=await freshImportContext({tenantId:TENANT,userId:ADMIN,roles:['hr_admin']} as never);
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson??undefined,roles:['hr_admin'],entitlements} as never;
 const [{company_id:companyId,id:financeId}]=await obs`select company_id,id from department where name='Finance' and tenant_id=${TENANT}::uuid limit 1`;
 const [company]=await obs`select legal_name,coalesce(company_label,'') as label,coalesce(registration_no,'') as reg from company where id=${companyId}::uuid`;
 const companyRef=company.label||company.reg||company.legal_name;
 const [{id:employmentId}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code=${process.env.CLOCK_EMPLOYEE_CODE??'EMP-0007'}`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 const tag=Date.now().toString(36).toUpperCase();
 const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
 // Populated tenant, as the employee import rehearsal seeds it.
 const [{count}]=await obs`select count(*)::int from employment where tenant_id=${TENANT}::uuid and voided_at is null and import_pending_attempt_id is null`;
 console.log(`base employees present: ${count}, target ${BASE}`);
 const hireRows=async(prefix:string,n:number,hired:string)=>{for(let start=0;start<n;start+=200){
  const records=Array.from({length:Math.min(200,n-start)},(_,i)=>({full_name:`Fictional ${prefix} ${tag} ${start+i}`,email:`${prefix.toLowerCase()}-${tag.toLowerCase()}-${start+i}@example.test`,employee_code:`${prefix}${tag}${String(start+i).padStart(4,'0')}`,department:'Finance',hired_on:hired,employment_type:'full_time',basic_salary:'4200'}));
  const r=await commitEmployeeImport(admin,{companyId,records});if(r.failed.length||r.fileErrors.length)throw new Error('seed failed: '+JSON.stringify(r.fileErrors).slice(0,300)+JSON.stringify(r.failed[0]).slice(0,300));}};
 if(count<BASE){const t0=Date.now();await hireRows('RB',BASE-count,'2025-03-03');console.log(`seeded ${BASE-count} base employees in ${Date.now()-t0}ms`);}
 // Movement reference data and two disjoint subject sets (sync reference and job), hired well before the movements.
 const grade=async(code:string,rank:number)=>{const [g]=await obs`select id from job_grade where tenant_id=${TENANT}::uuid and code=${code}`;return g?.id??(await createJobGrade(admin,{code,name:code,rank})).id;};
 await grade('RHJR',9);await grade('RHSR',8);
 const [pos]=await obs`select id from position where tenant_id=${TENANT}::uuid and title='Rehearsal Lead'`;if(!pos)await createPosition(admin,{companyId,title:'Rehearsal Lead'});
 let [dest]=await obs`select id,company_label from company where tenant_id=${TENANT}::uuid and company_label='RHDEST'`;
 if(!dest){[dest]=await obs`insert into company(tenant_id,legal_name,company_label,registration_no,country,currency) values(${TENANT}::uuid,'Rehearsal Destination Sdn Bhd','RHDEST','202601009910','MY','MYR') returning id,company_label`;
  await obs`insert into department(tenant_id,company_id,name) values(${TENANT}::uuid,${dest.id}::uuid,'Destination Operations')`;}
 const subjects=async(prefix:string)=>{await hireRows(prefix,SUBJECTS,'2025-01-06');
  const rows=await obs<{id:string;code:string;person_id:string}[]>`select id,employee_code code,person_id from employment where tenant_id=${TENANT}::uuid and employee_code like ${prefix+tag+'%'} order by employee_code`;
  await obs`update employment set grade_id=(select id from job_grade where tenant_id=${TENANT}::uuid and code='RHJR') where id=any(${rows.map(r=>r.id)}::uuid[])`;
  // Exits are of people who sign in (an administrator-set change).
  for(const r of rows.slice(0,5)){const [u]=await obs`insert into app_user(tenant_id,workos_user_id,person_id) values(${TENANT}::uuid,${'user_'+randomUUID()},${r.person_id}::uuid) returning id`;await obs`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${TENANT}::uuid,${u.id}::uuid,null,'employee')`;}
  return rows;};
 const HEADER=['Company ID','Employee ID','Employee Name','Effective Date','Event Type','System Fields','Before','After'];
 const fileFor=(rows:{code:string}[])=>{const out:string[][]=[];const managerCode=rows[rows.length-1].code;
  rows.forEach((r,i)=>{
   if(i<5){out.push([companyRef,r.code,'',day(-2),'termination','endDate','',day(-2)],[companyRef,r.code,'',day(-2),'termination','terminationReasonCode','','contract_expiry']);return;}
   if(i<10){out.push([companyRef,r.code,'',day(-3),'entityTransfer','companyId','','RHDEST'],[companyRef,r.code,'',day(-3),'entityTransfer','departmentId','','Destination Operations']);return;}
   out.push([companyRef,r.code,'',day(-20),'promotion','gradeId','RHJR','RHSR'],[companyRef,r.code,'',day(-20),'promotion','basicSalary','','4700'],
    [companyRef,r.code,'',day(-10),'transfer','departmentId','','Operations']);
   if(r.code!==managerCode)out.push([companyRef,r.code,'',day(-1),'reportingLineChange','managerEmploymentId','',managerCode]);
  });
  return Buffer.from(toCsv([HEADER,...out]));};
 const syncSubjects=process.env.SKIP_SYNC==='1'?null:await subjects('RS'),jobSubjects=await subjects('RJ');
 const check=async(rows:{code:string}[],name:string)=>{const t0=Date.now();const checked=await previewMovementUpload(admin,{name,content:fileFor(rows),resolve});
  const valid=checked.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);const ms=Date.now()-t0;
  const refused=checked.preview.employees.filter(e=>!e.fingerprint).map(e=>`${e.employeeCode}: ${e.rows.flatMap(r=>r.errors).join('; ')}`);
  return{checked,valid,ms,refused,rows:checked.preview.employees.reduce((n,e)=>n+e.rows.length,0)};};

 // Probes and the lock sampler, as in the employee import rehearsal.
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
 const clockBase=Date.parse(process.env.CLOCK_BASE??'2026-06-01');let clockSeq=Number(process.env.CLOCK_OFFSET??0);
 const clockDay=()=>new Date(clockBase+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runProbes=()=>Promise.all([
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
  loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',1000,()=>checkIn(admin,{employmentId,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,selfUser.employment_id,'en','Replacement holiday')),
 ]);
 const phase=async<T>(label:string,run:()=>Promise<T>)=>{
  lat=newLat();errors.length=0;stop=false;const probes=runProbes();const sampler=await startTenantLockSampler(obs,TENANT,25,[['movementReference','movement-import-reference-admission:'+TENANT,'ext'],['movementTypes','movement-type-catalogue:'+TENANT,'ext']]);
  const started=Date.now();let value:T;try{value=await run();}finally{stop=true;await probes;}
  const tenantLocks=await sampler.stop();
  const busy=errors.filter(e=>/busy|try again|timeout|canceling statement|lock timeout/i.test(e)).length;
  return{label,value:value!,wallMs:Date.now()-started,probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8),errorCount:errors.length,busy,tenantLocks};
 };
 const baseline=await phase('baseline',async()=>{await sleep(Number(process.env.BASELINE_SECONDS??15)*1000);return null;});
 const report:Record<string,unknown>={baseline:{probes:baseline.probes,errorCount:baseline.errorCount,errors:baseline.errors}};

 if(syncSubjects){
  const checked=await check(syncSubjects,'rehearsal-sync.csv');
  report.syncPreview={ms:checked.ms,employees:checked.checked.preview.employees.length,rows:checked.rows,valid:checked.valid.length,refused:checked.refused.slice(0,5)};
  const sync=await phase('sync',()=>confirmMovementUpload(admin,{attemptId:checked.checked.attemptId,previewHash:checked.checked.previewHash,employees:checked.valid,acknowledgeExcluded:true,resolve}));
  report.syncConfirm={wallMs:sync.wallMs,imported:sync.value.imported,failed:sync.value.failed,probes:sync.probes,errorCount:sync.errorCount,busy:sync.busy,errors:sync.errors,tenantLocks:sync.tenantLocks};
 }
 // The check (preview) still runs in the request: measured on its own, it is the next conversion candidate.
 const previewed=await phase('preview',()=>check(jobSubjects,'rehearsal-job.csv'));const checked=previewed.value;
 report.jobPreview={ms:checked.ms,employees:checked.checked.preview.employees.length,rows:checked.rows,valid:checked.valid.length,refused:checked.refused.slice(0,5),
  probes:previewed.probes,errorCount:previewed.errorCount,busy:previewed.busy,errors:previewed.errors,tenantLocks:previewed.tenantLocks};
 const worker:{proc?:ChildProcess}={};
 worker.proc=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});
 const job=await phase('job',async()=>{
  const started=await startMovementImportJob(admin,{attemptId:checked.checked.attemptId,previewHash:checked.checked.previewHash,employees:checked.valid,acknowledgeExcluded:true,locale:'en',operationKey:randomUUID()});
  if(!('job' in started))throw new Error('expected a job');
  const admitted=Date.now();
  for(;;){const [r]=await obs`select state,steps_done,steps_total,counters,metrics,error,result->>'imported' as imported,result->>'failed' as failed,finished_at-created_at as duration from bulk_job where id=${started.job.id}::uuid`;
   if(['completed','failed','cancelled'].includes(r.state))return{...r,admissionToTerminalMs:Date.now()-admitted};await sleep(500);}
 });
 const exited=new Promise(resolve=>worker.proc!.once('exit',resolve));worker.proc.kill('SIGTERM');await exited;
 const [{punches,badDays}]=await obs`select count(*)::int punches,(select count(*)::int from (select a.attendance_date,count(*) c from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${employmentId}::uuid and p.direction='in' and a.attendance_date>=${new Date(clockBase).toISOString().slice(0,10)}::date group by 1 having count(*)<>1) x) as "badDays" from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${employmentId}::uuid and p.direction='in' and a.attendance_date>=${new Date(clockBase).toISOString().slice(0,10)}::date`;
 report.job={wallMs:job.wallMs,outcome:job.value,probes:job.probes,errorCount:job.errorCount,busy:job.busy,errors:job.errors,tenantLocks:job.tenantLocks};
 report.clockPunches={punches,datesWithOtherThanOnePunch:badDays};
 // Whole-import revert (Import History, all or nothing in one transaction): measured for the follow-up decision.
 if(process.env.SKIP_REVERT!=='1'){
  const {previewImportRevertForAttempt,revertImportForAttempt}=await import('../../core/import-history-handlers');
  const reverted=await phase('revert',async()=>{const t0=Date.now();const review=await previewImportRevertForAttempt(admin,checked.checked.attemptId);const reviewMs=Date.now()-t0;
   if(!review.eligible)return{reviewMs,eligible:false,blockers:review.blockers.slice(0,3)};
   const t1=Date.now();const done=await revertImportForAttempt(admin,checked.checked.attemptId,{previewHash:review.previewHash,reason:'Fictional rehearsal revert'});return{reviewMs,revertMs:Date.now()-t1,restored:done.restored};});
  report.revert={...reverted.value,probes:reverted.probes,errorCount:reverted.errorCount,busy:reverted.busy,errors:reverted.errors,tenantLocks:reverted.tenantLocks};
 }
 report.auditChain=await verifyTenantChain(admin);
 console.log(JSON.stringify(report,null,2));
 await obs.end();await client.end();
}
main().then(()=>process.exit(0),e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
