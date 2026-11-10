/**
 * Fictional-data rehearsal of the roster bulk jobs (core/roster-bulk-worker.ts). Disposable database only: refuses
 * any URL not pointing at the rehearsal port. Spawns the real protected worker process (scripts/bank-import-runner.ts,
 * which runs the shared bulk-job kernel), runs the hot-path probes of the employee-import rehearsal (login, an
 * Access writer, clock-in, My Profile, Home, Personnel), samples every tenant-wide lock, and reports per operation:
 * wall time, chunk metrics, the longest tenant-lock holds, probe maxima, errors and Busy refusals.
 *
 * Operations (OPS, comma separated): sync (today's single-transaction generateRosterFromTemplate, for comparison),
 * generate, copy, import, group. Env: DATABASE_URL (app), MIGRATION_DATABASE_URL (owner), REHEARSAL_PORT,
 * REHEARSAL_TENANT, REHEARSAL_ADMIN, BASE_EMPLOYEES (3000), ROSTER_EMPLOYEES (all), IMPORT_EMPLOYEES (1200),
 * SYNC_EMPLOYEES (1200), MONTH (2027-01).
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
const OPS=(process.env.OPS??'sync,generate,copy,import,group').split(',').map(s=>s.trim()).filter(Boolean);
const MONTH=process.env.MONTH??'2027-01';
if(process.env.AUDIT_HASH_CHAIN_ENABLED!=='true')process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const monthDays=(month:string)=>{const [y,m]=month.split('-').map(Number);const n=new Date(Date.UTC(y,m,0)).getUTCDate();return Array.from({length:n},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);};
const nextMonth=(month:string)=>{const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);};

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
 const roster=await import('../../core/roster');
 const jobs=await import('../../core/roster-bulk-job');
 const {createAttendanceRule}=await import('../../core/attendance-rule');
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});
 const {entitlements}=await freshImportContext({tenantId:TENANT,userId:ADMIN,roles:['hr_admin']} as never);
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson??undefined,roles:['hr_admin'],entitlements} as never;
 const [{company_id:companyId}]=await obs`select company_id from department where name='Finance' and tenant_id=${TENANT}::uuid limit 1`;
 const [{id:clockEmployment}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code=${process.env.CLOCK_EMPLOYEE_CODE??'EMP-0007'}`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 const tag=Date.now().toString(36).toUpperCase();
 const [{count}]=await obs`select count(*)::int from employment where tenant_id=${TENANT}::uuid and voided_at is null and import_pending_attempt_id is null and terminated_on is null`;
 console.log(`active employees present: ${count}, target ${BASE}`);
 if(count<BASE){
  const need=BASE-count;const t0=Date.now();
  for(let start=0;start<need;start+=200){
   const records=Array.from({length:Math.min(200,need-start)},(_,i)=>({full_name:`Fictional Roster ${tag} ${start+i}`,email:`roster-${tag.toLowerCase()}-${start+i}@example.test`,employee_code:`RR${tag}${start+i}`,department:'Finance',hired_on:'2026-03-02',employment_type:'full_time',basic_salary:'4200'}));
   const r=await commitEmployeeImport(admin,{companyId,records});if(r.failed.length||r.fileErrors.length)throw new Error('base seed failed: '+JSON.stringify(r.fileErrors).slice(0,300)+JSON.stringify(r.failed[0]).slice(0,300));
  }
  console.log(`seeded ${need} base employees in ${Date.now()-t0}ms`);
 }
 // The rostered population: the company's active employments that carry a code (fictional base + demo staff).
 const population=await obs<{id:string;code:string}[]>`select id,employee_code code from employment where tenant_id=${TENANT}::uuid and company_id=${companyId}::uuid
  and voided_at is null and import_pending_attempt_id is null and terminated_on is null and employee_code is not null and id<>${clockEmployment}::uuid order by employee_code`;
 const rosterIds=population.slice(0,Number(process.env.ROSTER_EMPLOYEES??population.length)).map(r=>r.id);
 console.log(`rostered population: ${rosterIds.length}`);
 const day=await roster.createShift(admin,{companyId,name:`Rehearsal Day ${tag}`,code:`RD${tag}`,startTime:'09:00:00',endTime:'18:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]});
 const night=await roster.createShift(admin,{companyId,name:`Rehearsal Night ${tag}`,code:`RN${tag}`,startTime:'21:00:00',endTime:'06:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]});

 const worker:{proc?:ChildProcess}={};
 const startWorker=()=>{worker.proc=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});};
 const stopWorker=async()=>{const proc=worker.proc;if(!proc||proc.exitCode!==null)return;const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await exited;};
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
 const clockBase=Date.parse(process.env.CLOCK_BASE??'2026-06-01');let clockSeq=Number(process.env.CLOCK_OFFSET??0);
 const clockDay=()=>new Date(clockBase+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runProbes=()=>Promise.all([
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
  loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',1000,()=>checkIn(admin,{employmentId:clockEmployment,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,selfUser.employment_id,'en','Replacement holiday')),
 ]);
 const waitTerminal=async(id:string)=>{for(;;){const [r]=await obs`select state,steps_done,steps_total,counters,metrics,error,finished_at-created_at as duration from bulk_job where id=${id}::uuid`;if(['completed','failed','cancelled'].includes(r.state))return r;await sleep(500);}};
 const report:Record<string,unknown>={};
 /** One measured operation: probes and the lock sampler around it, the job (or synchronous call) in between. */
 const measure=async(name:string,run:()=>Promise<{id?:string;detail?:unknown}>)=>{
  lat=newLat();errors.length=0;stop=false;const probes=runProbes();
  const sampler=await startTenantLockSampler(obs,TENANT);
  const started=Date.now();let outcome:unknown;
  try{const r=await run();outcome=r.id?await waitTerminal(r.id):r.detail;}catch(e){outcome={error:String((e as Error).message).slice(0,300)};}
  const wall=Date.now()-started;stop=true;await probes;const tenantLocks=await sampler.stop();
  report[name]={wallMs:wall,outcome,probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errorCount:errors.length,
   busy:errors.filter(e=>/busy|55P03|lock timeout/i.test(e)).length,errors:[...new Set(errors)].slice(0,6),tenantLocks};
  console.log(JSON.stringify({[name]:report[name]},null,2));
 };
 const days=monthDays(MONTH),next=nextMonth(MONTH);
 if(OPS.includes('sync')){
  // Today's path, for comparison: one transaction for the whole grid (no worker involved).
  const ids=rosterIds.slice(0,Number(process.env.SYNC_EMPLOYEES??1200));
  await measure(`sync-generate-${ids.length}x${days.length}`,async()=>({detail:await roster.generateRosterFromTemplate(admin,{shiftId:night.id,employmentIds:ids,from:days[0],to:days[days.length-1]})}));
 }
 startWorker();await sleep(3000);
 if(OPS.includes('generate'))await measure(`job-generate-${rosterIds.length}x${days.length}`,async()=>({id:(await jobs.enqueueRosterGenerateJob(admin,{companyId,input:{shiftId:day.id,employmentIds:rosterIds,from:days[0],to:days[days.length-1]}})).id}));
 if(OPS.includes('copy'))await measure(`job-copy-${rosterIds.length}x${days.length}`,async()=>({id:(await jobs.enqueueRosterCopyJob(admin,{companyId,employmentIds:rosterIds,sourceFrom:days[0],sourceTo:days[days.length-1],targetFrom:`${next}-01`})).id}));
 if(OPS.includes('import')){
  const sample=population.slice(0,Number(process.env.IMPORT_EMPLOYEES??1200));
  const header=['employee_no',...days].join(',');
  const lines=sample.map((e,i)=>[e.code,...days.map((d,j)=>(i+j)%7===5?'RD':(i+j)%7===6?'OFF':(i%2?night.code:day.code))].join(','));
  const csvText=[header,...lines].join('\n')+'\n';
  await measure(`job-import-${sample.length}x${days.length}`,async()=>({id:(await jobs.enqueueRosterImportJob(admin,{csvText,month:MONTH,companyId,fileName:'rehearsal.csv'})).id}));
 }
 if(OPS.includes('group')){
  const rule=await createAttendanceRule(admin,{name:`Rehearsal Group ${tag}`,status:'active',lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,
   earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[]});
  await measure(`job-schedule-group-${rosterIds.length}`,async()=>({id:(await jobs.enqueueScheduleGroupBulkJob(admin,{employmentIds:rosterIds,attendanceRuleId:rule.id,returnQuery:''})).id}));
 }
 await stopWorker();
 const chain=await verifyTenantChain(admin);
 const [{cells}]=await obs`select count(*)::int cells from roster_assignment where tenant_id=${TENANT}::uuid and shift_date between ${days[0]}::date and ${`${next}-28`}::date`;
 console.log(JSON.stringify({auditChain:chain,rosterCells:cells},null,2));
 await obs.end();await client.end();
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
