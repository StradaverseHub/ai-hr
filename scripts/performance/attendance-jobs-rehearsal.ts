/**
 * Fictional-data rehearsal of Import Clocking Data and Recompute Attendance as background jobs (draft 9940).
 * Disposable database only: refuses any URL not on the rehearsal port. Builds its own fictional tenant (the test
 * harness seed) with BASE_EMPLOYEES employees and HISTORY_DAYS of recorded attendance, spawns the real protected
 * worker (scripts/bank-import-runner.ts, which runs the shared bulk-job kernel), runs the hot-path probes (clock-in,
 * MFA-style login event, an Access writer, My Profile, Home, Personnel), samples every tenant-wide lock, and prints
 * per run: wall time, the job's own chunk metrics, the longest tenant-lock holds, probe maxima, errors and Busy.
 *  1. a one-day file for every employee (2 lines each) — the measured 57 s shape, at full size;
 *  2. a multi-day file (MULTI_EMPLOYEES × MULTI_DAYS × 2 lines) — large steps;
 *  3. Recompute Attendance preview and apply over the one-day scope after the attendance policy changed.
 * Before each, the synchronous path it replaces runs on SYNC_EMPLOYEES employees (another day) under the same probes,
 * so the before / after holds are measured on the same host.
 * Env: DATABASE_URL (app), MIGRATION_DATABASE_URL (owner), REHEARSAL_PORT, BASE_EMPLOYEES (3000), HISTORY_DAYS (20),
 * MULTI_EMPLOYEES (600), MULTI_DAYS (10), SYNC_EMPLOYEES (1200), BASELINE_SECONDS (15).
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
const BASE=Number(process.env.BASE_EMPLOYEES??3000),HISTORY=Number(process.env.HISTORY_DAYS??20);
const MULTI_EMPLOYEES=Number(process.env.MULTI_EMPLOYEES??600),MULTI_DAYS=Number(process.env.MULTI_DAYS??10),SYNC_EMPLOYEES=Number(process.env.SYNC_EMPLOYEES??1200);
if(process.env.AUDIT_HASH_CHAIN_ENABLED === 'true'){/* already armed by the caller */}else process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
// The harness seed writes through the owner connection named here (the rehearsal database's owner).
process.env.TEST_MIGRATION_DATABASE_URL=OWNER_URL;
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const addDays=(date:string,n:number)=>new Date(Date.parse(`${date}T00:00:00Z`)+n*86_400_000).toISOString().slice(0,10);
const hm=(m:number)=>`${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

async function main(){
 const {seedBase,adminCtx,createAppUser}=await import('../../test/harness');
 const {withTenant,client}=await import('../../db/client');
 const {startClockingImportJob}=await import('../../packs/attendance/service');
 const {startRecomputeJob}=await import('../../core/attendance-recompute-job');
 const {commitClockingImport}=await import('../../packs/attendance/service');
 const {recomputeAttendance}=await import('../../core/attendance-recompute');
 const {commitEmployeeImport}=await import('../../core/import');
 const {checkIn}=await import('../../packs/attendance/service');
 const {hireEmployee}=await import('../../core/org');
 const {lockAccessConfigurationTx}=await import('../../core/access-configuration-lock');
 const {listEmployeesPage}=await import('../../core/read');
 const {myProfile}=await import('../../core/profile');
 const {readEmployeeHomeSummary}=await import('../../core/employee-home-summary');
 const {verifyTenantChain}=await import('../../core/audit-chain');
 const {BUILTIN_MAPPING_ID}=await import('../../lib/clocking-file');
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});

 // ── A fictional tenant: BASE employees with HISTORY_DAYS of recorded days, a probe employee, an employee login.
 const t0=Date.now();
 const b=await seedBase();const admin=adminCtx(b);const TENANT=b.tenantId;
 // Through the real hire path (dated employer provenance, assignments), in 200-row files as an administrator would.
 for(let start=0;start<BASE;start+=200){
  const records=Array.from({length:Math.min(200,BASE-start)},(_,i)=>({full_name:`Fictional Clock ${start+i}`,email:`clock-${start+i}-${TENANT.slice(0,8)}@example.test`,
   employee_code:`RC${String(start+i).padStart(5,'0')}`,department:'Finance',hired_on:'2025-01-01',employment_type:'full_time',basic_salary:'4200'}));
  const r=await commitEmployeeImport(admin,{companyId:b.companyId,records});
  if(r.failed.length||r.fileErrors.length)throw new Error('base seed failed: '+JSON.stringify(r.fileErrors).slice(0,300)+JSON.stringify(r.failed[0]).slice(0,300));
 }
 await obs`update employment set card_id='K'||substr(employee_code,3) where tenant_id=${TENANT}::uuid and employee_code like 'RC%'`;
 const historyFrom='2026-08-03',importDay=addDays(historyFrom,HISTORY+7),syncDay=addDays(historyFrom,HISTORY+3);
 await obs`insert into attendance(tenant_id,employment_id,attendance_date,check_in_at,check_out_at,status,day_type,worked_minutes,ot_minutes,late_minutes,check_in_method,check_out_method)
  select ${TENANT}::uuid,e.id,d::date,('09:0'||(abs(hashtext(e.id::text||d::text))%10)||':00')::time,('18:0'||(abs(hashtext(d::text||e.id::text))%10)||':00')::time,'present','workday',480,0,0,'import','import'
  from employment e cross join generate_series(${historyFrom}::date,${addDays(historyFrom,HISTORY-1)}::date,interval '1 day') d where e.tenant_id=${TENANT}::uuid and e.employee_code like 'RC%'`;
 await obs`analyze`;
 const probe=await hireEmployee(admin,{person:{fullName:'Fictional Probe',primaryEmail:`probe-${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01',employeeCode:'PROBE'});
 const self=await hireEmployee(admin,{person:{fullName:'Fictional Self',primaryEmail:`self-${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01',employeeCode:'SELF'});
 const [{person_id:selfPerson}]=await obs`select person_id from employment where id=${self.employmentId}::uuid`;
 const selfUser=await createAppUser(TENANT,selfPerson,'employee');
 const employee={tenantId:TENANT,userId:selfUser,personId:selfPerson,roles:['employee'],entitlements:admin.entitlements} as never;
 const [{n:recorded}]=await obs`select count(*)::int n from attendance where tenant_id=${TENANT}::uuid`;
 console.log(JSON.stringify({seeded:{tenant:TENANT,employees:BASE,recordedDays:recorded,ms:Date.now()-t0}}));

 const worker:{proc?:ChildProcess}={};
 worker.proc=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
 let clockSeq=0;const clockDay=()=>addDays('2026-06-01',clockSeq++);
 const runProbes=()=>Promise.all([
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,b.adminUserId])),
  loop('access',200,()=>withTenant(admin,async tx=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',500,()=>checkIn(admin,{employmentId:probe.employmentId,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,self.employmentId,'en','Replacement holiday')),
 ]);
 const waitTerminal=async(id:string)=>{for(;;){const [r]=await obs`select state,kind,steps_done,steps_total,counters,metrics,error,errors,result,extract(epoch from finished_at-created_at)*1000 as "wallMs" from bulk_job where id=${id}::uuid`;if(['completed','failed','cancelled'].includes(r.state))return r;await sleep(500);}};
 const report:Record<string,unknown>={};
 /** The synchronous path it replaces, inline, under the same probes and sampler. */
 const measuredSync=async(name:string,run:()=>Promise<unknown>)=>{
  lat=newLat();errors.length=0;stop=false;const probes=runProbes();
  const sampler=await startTenantLockSampler(obs,TENANT);
  const started=Date.now();let outcome:unknown;try{outcome=await run();}catch(e){outcome={error:String((e as Error)?.message??e).slice(0,200)};}
  const wall=Date.now()-started;stop=true;await probes;const tenantLocks=await sampler.stop();
  const busy=errors.filter(e=>/busy|Leave source is unavailable/i.test(e)).length;
  const o=outcome as {checked?:number;updated?:number;imported?:number;error?:string;status?:string};
  report[name]={wallMs:wall,result:{checked:o?.checked,updated:o?.updated,imported:o?.imported,status:o?.status,error:o?.error},tenantLocks,
   probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8),errorCount:errors.length,busy};
  console.log(JSON.stringify({[name]:report[name]},null,2));
 };
 const measured=async(name:string,start:()=>Promise<string>)=>{
  lat=newLat();errors.length=0;stop=false;const probes=runProbes();
  const sampler=await startTenantLockSampler(obs,TENANT);
  const started=Date.now();const id=await start();const done=await waitTerminal(id);const wall=Date.now()-started;
  stop=true;await probes;const tenantLocks=await sampler.stop();
  const busy=errors.filter(e=>/busy|Leave source is unavailable/i.test(e)).length;
  const result=done.result as {checked?:number;updated?:number;imported?:number;counts?:{total:number}}|null;
  report[name]={state:done.state,wallMs:wall,steps:done.steps_total,counters:done.counters,jobMetrics:done.metrics,error:done.error,stepErrors:(done.errors as unknown[]).length,
   result:result&&{checked:result.checked,updated:result.updated,imported:result.imported,lines:result.counts?.total},
   tenantLocks,probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8),errorCount:errors.length,busy};
  console.log(JSON.stringify({[name]:report[name]},null,2));
 };

 // Baseline: the same probes with no job running.
 {const probes=runProbes();await sleep(Number(process.env.BASELINE_SECONDS??15)*1000);stop=true;await probes;
  report.baseline={probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8),errorCount:errors.length};
  console.log(JSON.stringify({baseline:report.baseline},null,2));}

 const codes=(await obs<{code:string;card:string}[]>`select employee_code as code,card_id as card from employment where tenant_id=${TENANT}::uuid and employee_code like 'RC%' order by employee_code`);
 // 0 · before: the synchronous import of a one-day file for SYNC_EMPLOYEES employees.
 const syncFile=['staff,time',...codes.slice(0,SYNC_EMPLOYEES).flatMap((e,i)=>[`${e.code},${syncDay} ${hm(8*60+30+i%45)}`,`${e.code},${syncDay} ${hm(17*60+30+i%61)}`])].join('\n');
 await measuredSync('clockingSynchronousBefore',()=>commitClockingImport(admin,{mappingId:BUILTIN_MAPPING_ID,text:syncFile,fileName:'sync.csv',fileBytes:Buffer.byteLength(syncFile)}));
 // 1 · one day, every employee, in and out (cards for half, codes for the rest).
 const oneDay=['staff,time',...codes.flatMap((e,i)=>[`${i%2?e.card:e.code},${importDay} ${hm(8*60+30+i%45)}`,`${i%2?e.card:e.code},${importDay} ${hm(17*60+30+i%61)}`])].join('\n');
 await measured('clockingOneDay',async()=>(await startClockingImportJob(admin,{mappingId:BUILTIN_MAPPING_ID,text:oneDay,fileName:'one-day.csv',fileBytes:Buffer.byteLength(oneDay),operationKey:randomUUID()})).job.id);
 // 2 · several days for fewer employees: the largest steps.
 const multiFrom=addDays(importDay,1);
 const multi=['staff,time',...codes.slice(0,MULTI_EMPLOYEES).flatMap((e,i)=>Array.from({length:MULTI_DAYS},(_,d)=>[`${e.code},${addDays(multiFrom,d)} ${hm(8*60+20+(i+d)%50)}`,`${e.code},${addDays(multiFrom,d)} ${hm(17*60+40+(i*3+d)%70)}`]).flat())].join('\n');
 await measured('clockingMultiDay',async()=>(await startClockingImportJob(admin,{mappingId:BUILTIN_MAPPING_ID,text:multi,fileName:'multi-day.csv',fileBytes:Buffer.byteLength(multi),operationKey:randomUUID()})).job.id);
 // 3 · the policy changes; preview and apply a recompute of the one-day scope for the whole company.
 await obs`update attendance_policy set late_after='08:45:00' where tenant_id=${TENANT}::uuid`;
 const [{policies}]=await obs`select count(*)::int policies from attendance_policy where tenant_id=${TENANT}::uuid`;
 if(!policies)await obs`insert into attendance_policy(tenant_id,company_id,late_after) values(${TENANT}::uuid,${b.companyId}::uuid,'08:45:00')`;
 await measuredSync('recomputeSynchronousBefore',()=>recomputeAttendance(admin,{companyId:b.companyId,from:syncDay,to:syncDay,dryRun:false}));
 await measured('recomputePreview',async()=>(await startRecomputeJob(admin,{companyId:b.companyId,from:importDay,to:importDay,dryRun:true,operationKey:randomUUID()})).job.id);
 await measured('recomputeApply',async()=>(await startRecomputeJob(admin,{companyId:b.companyId,from:importDay,to:importDay,dryRun:false,operationKey:randomUUID()})).job.id);

 const proc=worker.proc;if(proc&&proc.exitCode===null){const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await exited;}
 const [{punches,badDays}]=await obs`select count(*)::int punches,(select count(*)::int from (select a.attendance_date from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${probe.employmentId}::uuid and p.direction='in' group by 1 having count(*)<>1) x) as "badDays" from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${probe.employmentId}::uuid and p.direction='in'`;
 const chain=await verifyTenantChain(admin);
 console.log(JSON.stringify({clockProbe:{punches,datesWithOtherThanOnePunch:badDays},auditChain:chain},null,2));
 await obs.end();await client.end();
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
