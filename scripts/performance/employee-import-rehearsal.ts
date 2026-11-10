/**
 * Fictional-data rehearsal of the staged employee import (design B acceptance). Disposable database only:
 * refuses any URL not pointing at the rehearsal port. Spawns the real worker process, runs hot-path probes, and
 * prints every target from DESIGN.md's acceptance section. Env: DATABASE_URL (app), MIGRATION_DATABASE_URL (owner),
 * REHEARSAL_PORT (the disposable cluster's port), REHEARSAL_TENANT, REHEARSAL_ADMIN, BASE_EMPLOYEES (3000), IMPORT_ROWS (500).
 */
import '../lib/stub-server-only';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';

const required=(name:string)=>{const v=process.env[name];if(!v)throw new Error(`${name} is required`);return v;};
const port=required('REHEARSAL_PORT');
for(const name of ['DATABASE_URL','MIGRATION_DATABASE_URL'])if(new URL(required(name)).port!==port)throw new Error('Refusing: rehearsal runs only against the disposable cluster port.');
const TENANT=required('REHEARSAL_TENANT'),ADMIN=required('REHEARSAL_ADMIN');
const BASE=Number(process.env.BASE_EMPLOYEES??3000),ROWS=Number(process.env.IMPORT_ROWS??500);
process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function main(){
 const {commitEmployeeImport}=await import('../../core/import');
 const {createEmployeeImportJob}=await import('../../core/employee-import-job');
 const {checkIn}=await import('../../packs/attendance/service');
 const {withTenant,client}=await import('../../db/client');
 const {lockAccessConfigurationTx}=await import('../../core/access-configuration-lock');
 const {listEmployeesPage}=await import('../../core/read');
 const {myProfile}=await import('../../core/profile');
 const {verifyTenantChain}=await import('../../core/audit-chain');
 const cat=await import('../../packs/catalog');
 const obs=postgres(required('MIGRATION_DATABASE_URL'),{max:4,onnotice:()=>{}});
 const entitlements={tenantId:TENANT,enabledModules:[...new Set(cat.legacyEnabledModulesIn(process.env))],scopedModules:{},settings:Object.fromEntries(cat.legacyEnabledSettingsIn(process.env).map((s:{key:string;value:unknown})=>[s.key,s.value])),tenantStatus:'active'};
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson??undefined,roles:['hr_admin'],entitlements} as never;
 const [{company_id:companyId}]=await obs`select company_id from department where name='Finance' and tenant_id=${TENANT}::uuid limit 1`;
 const [{id:employmentId}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code=${process.env.CLOCK_EMPLOYEE_CODE??'EMP-0007'}`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const homeEmployment=selfUser.employment_id;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 const {readEmployeeHomeSummary}=await import('../../core/employee-home-summary');
 const tag=Date.now().toString(36).toUpperCase();
 const [{count}]=await obs`select count(*)::int from employment where tenant_id=${TENANT}::uuid and voided_at is null and import_pending_attempt_id is null`;
 console.log(`base employees present: ${count}, target ${BASE}`);
 if(count<BASE){
  const need=BASE-count;const t0=Date.now();
  for(let start=0;start<need;start+=200){
   const records=Array.from({length:Math.min(200,need-start)},(_,i)=>({full_name:`Fictional Base ${tag} ${start+i}`,email:`base-${tag.toLowerCase()}-${start+i}@example.test`,employee_code:`RH${tag}${start+i}`,department:'Finance',hired_on:'2026-03-02',employment_type:'full_time',basic_salary:'4200'}));
   const r=await commitEmployeeImport(admin,{companyId,records});if(r.failed.length||r.fileErrors.length)throw new Error('base seed failed: '+JSON.stringify(r.fileErrors).slice(0,300)+JSON.stringify(r.failed[0]).slice(0,300));
  }
  console.log(`seeded ${need} base employees in ${Date.now()-t0}ms`);
 }
 const csv=(rows:Record<string,string>[])=>{const h=Object.keys(rows[0]);return[h.join(','),...rows.map(r=>h.map(k=>r[k]).join(','))].join('\n')+'\n';};
 const fileRow=(prefix:string,i:number)=>({full_name:`Fictional Staged ${tag} ${i}`,email:`${prefix}-${tag.toLowerCase()}-${i}@example.test`,employee_code:`${prefix}${tag}${String(i).padStart(4,'0')}`,department:'Finance',hired_on:'2026-03-02',employment_type:'full_time',basic_salary:String(3000+i)});
 const worker:{proc?:ChildProcess}={};
 const startWorker=()=>{worker.proc=spawn(process.execPath,['--import','tsx','scripts/employee-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});};
 startWorker();
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
 const clockBase=Date.parse(process.env.CLOCK_BASE??'2026-06-01');
 let clockSeq=0;const clockDay=()=>new Date(clockBase+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runProbes=()=>Promise.all([
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
  loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',1000,()=>checkIn(admin,{employmentId,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,homeEmployment,'en','Replacement holiday')),
 ]);
 const baselineSeconds=Number(process.env.BASELINE_SECONDS??20);
 let probes=runProbes();await sleep(baselineSeconds*1000);stop=true;await probes;const baseline=lat;const baselineErrors=[...errors];errors.length=0;
 lat=newLat();stop=false;probes=runProbes();
 // Independent lock-hold sampler: any backend holding this tenant's Access advisory lock exclusively.
 const [{classid,objid}]=await obs`select (hashtextextended(${'access-configuration:'+TENANT},0)>>32)::oid as classid,(hashtextextended(${'access-configuration:'+TENANT},0)&4294967295)::oid as objid`;
 const holds=new Map<string,{pid:number;first:number;last:number;query:string;state:string}>();let sampling=true;
 const sampler=(async()=>{while(sampling){const rows=await obs`select l.pid,a.xact_start::text as xact,left(regexp_replace(a.query,'\s+',' ','g'),90) as query,a.state from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and l.granted and l.mode='ExclusiveLock' and l.classid=${classid} and l.objid=${objid} and l.objsubid=1 and a.xact_start is not null`;const now=Date.now();for(const r of rows){const k=r.pid+'|'+r.xact;const h=holds.get(k);if(h){h.last=now;h.query=r.query;h.state=r.state;}else holds.set(k,{pid:r.pid,first:now,last:now,query:r.query,state:r.state});}await sleep(25);}})();
 const rows=Array.from({length:ROWS},(_,i)=>fileRow('RI',i));
 const started=Date.now();
 const {job}=await createEmployeeImportJob(admin,{companyId,csv:csv(rows),fileName:'rehearsal.csv',dependentsCsv:'',registers:{},allocationsCsv:''},{name:'rehearsal.csv',content:Buffer.from(csv(rows)),operationKey:randomUUID()});
 console.log('job',job.id);
 const waitTerminal=async(id:string)=>{for(;;){const [r]=await obs`select state,steps_done,steps_total,chunks,max_chunk_ms,activation_ms,imported,error from employee_import_job where id=${id}::uuid`;if(['completed','failed'].includes(r.state))return r;await sleep(500);}};
 const done=await waitTerminal(job.id);const wall=Date.now()-started;
 stop=true;await probes;sampling=false;await sampler;
 const[{visible}]=await obs`select count(*)::int visible from employment where tenant_id=${TENANT}::uuid and employee_code like ${'RI'+tag+'%'} and voided_at is null and import_pending_attempt_id is null`;
 const[{punches,badDays}]=await obs`select count(*)::int punches,(select count(*)::int from (select a.attendance_date,count(*) c from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${employmentId}::uuid and p.direction='in' and a.attendance_date>=${new Date(clockBase).toISOString().slice(0,10)}::date group by 1 having count(*)<>1) x) as "badDays" from attendance a join attendance_punch p on p.attendance_id=a.id where a.employment_id=${employmentId}::uuid and p.direction='in' and a.attendance_date>=${new Date(clockBase).toISOString().slice(0,10)}::date`;
 console.log(JSON.stringify({file:{rows:ROWS,wallMs:wall,state:done.state,imported:done.imported,chunks:done.chunks,maxChunkMs:done.max_chunk_ms,activationMs:done.activation_ms,error:done.error},visibleAfter:visible,clockPunches:{punches,clockProbesOk:lat.clock.length,datesWithOtherThanOnePunch:badDays},probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8),errorCount:errors.length,accessLockHoldMs:[...holds.values()].map(h=>h.last-h.first).sort((a,b)=>b-a).slice(0,8),longestHolds:[...holds.values()].sort((a,b)=>(b.last-b.first)-(a.last-a.first)).slice(0,4).map(h=>({ms:h.last-h.first,lastQuery:h.query,state:h.state})),accessLockHolds:holds.size,baseline:Object.fromEntries(Object.entries(baseline).map(([k,v])=>[k,stat(v)])),baselineErrors:[...new Set(baselineErrors)].slice(0,8)},null,2));
 // Late-row failure: leaves no visible employee.
 const stopWorker=async()=>{const proc=worker.proc;if(!proc||proc.exitCode!==null)return;const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await exited;};
 if(process.env.SKIP_LATE==='1'){await stopWorker();const chain=await verifyTenantChain(admin);console.log(JSON.stringify({auditChain:chain},null,2));await obs.end();await client.end();process.exit(0);}
 await obs.unsafe(`create or replace function public.rehearsal_refuse() returns trigger language plpgsql as $$ begin if exists(select 1 from employment where id=new.employment_id and employee_code like 'RL%0${String(ROWS-10).padStart(3,'0')}') then raise exception 'rehearsal late-row refusal'; end if; return new; end $$;`);
 await obs.unsafe('drop trigger if exists rehearsal_refuse on compensation');
 await obs.unsafe('create trigger rehearsal_refuse before insert on compensation for each row execute function public.rehearsal_refuse()');
 const late=Array.from({length:ROWS},(_,i)=>fileRow('RL',i));
 const {job:failedJob}=await createEmployeeImportJob(admin,{companyId,csv:csv(late),fileName:'rehearsal-late.csv',dependentsCsv:'',registers:{},allocationsCsv:''},{name:'rehearsal-late.csv',content:Buffer.from(csv(late)),operationKey:randomUUID()});
 const failed=await waitTerminal(failedJob.id);
 await obs.unsafe('drop trigger if exists rehearsal_refuse on compensation');await obs.unsafe('drop function public.rehearsal_refuse()');
 const[{visible:lateVisible,voided}]=await obs`select count(*) filter (where voided_at is null and import_pending_attempt_id is null)::int visible,count(*) filter (where voided_at is not null)::int voided from employment where tenant_id=${TENANT}::uuid and (employee_code like ${'RL'+tag+'%'} or voided_employee_code like ${'RL'+tag+'%'})`;
 await stopWorker();
 const chain=await verifyTenantChain(admin);
 console.log(JSON.stringify({lateFailure:{state:failed.state,error:(failed.error??'').slice(0,160),visibleEmployees:lateVisible,voidedStaged:voided},auditChain:chain},null,2));
 await obs.end();await client.end();
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
