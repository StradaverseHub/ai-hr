/**
 * Fictional-data rehearsal of register and section imports and the employee import Revert as background jobs
 * (docs/adr/2026-11-10-register-section-import-jobs.md). Disposable database only: refuses any URL not pointing at the
 * rehearsal port. Expects a populated tenant
 * whose fictional employees RB00000.. each hold one live Highest qualification and one Primary contact. Runs the
 * synchronous register commit once as the "before" measurement, then each import kind as a job through the real
 * protected worker process (scripts/bank-import-runner.ts), with hot-path probes, the tenant-lock sampler and a
 * visibility poll (an all-or-nothing register file must jump from none to all). With REVERT_ROWS it imports that many
 * fictional hires twice and reverts one file synchronously ("before") and the other as a job. Env: DATABASE_URL (app), MIGRATION_DATABASE_URL (owner), REHEARSAL_PORT,
 * REHEARSAL_TENANT, REHEARSAL_ADMIN, IMPORT_ROWS (500), REVERT_ROWS (0 = skip), PHASES (comma list).
 */
import '../lib/stub-server-only';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';

/** Tenant-wide advisory key holds in THIS database only (advisory locks are per database, and other databases on a
 * shared cluster hash the same tenant keys), with every hold kept so the import's own holds get a distribution. */
async function startSampler(obs:postgres.Sql,tenantId:string,intervalMs=25){
 const names:[string,string,'ext'|'int4'][]=[['access','access-configuration:'+tenantId,'ext'],['leave','leave-dependency-configuration:'+tenantId,'ext'],
  ['profile','profile-edit-policy:'+tenantId,'ext'],['cards',tenantId+':card-identifiers','ext'],['audit','audit-chain:'+tenantId,'int4']];
 const keyOf=new Map<string,string>();
 for(const [name,key,kind] of names){const [row]=await obs<{k:string}[]>`select (((k>>32)&4294967295)::oid::text||':'||(k&4294967295)::oid::text) as k from (select case when ${kind}='int4' then hashtext(${key})::bigint else hashtextextended(${key},0) end as k) x`;keyOf.set(row.k,name);}
 const holds=new Map<string,{lock:string;app:string;first:number;last:number}>();let sampling=true;
 const loop=(async()=>{while(sampling){
  const rows=await obs<{pid:number;k:string;mode:string;xact:string;app:string}[]>`select l.pid,(l.classid::text||':'||l.objid::text) as k,l.mode,a.xact_start::text as xact,coalesce(a.application_name,'') as app
   from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and l.granted and l.objsubid=1 and a.xact_start is not null
    and l.database=(select oid from pg_database where datname=current_database()) and (l.classid::text||':'||l.objid::text)=any(${[...keyOf.keys()]}::text[])`;
  const now=Date.now();
  for(const r of rows){const lock=keyOf.get(r.k)!;const id=`${r.pid}|${r.xact}|${lock}|${r.mode}`;const h=holds.get(id)??{lock,app:r.app,first:now,last:now};h.last=now;if(r.app)h.app=r.app;holds.set(id,h);}
  await sleep(intervalMs);}})();
 return{async stop(){
  sampling=false;await loop;
  const all=[...holds.values()].map(h=>({lock:h.lock,import:h.app.startsWith('aihr-bulk:'),app:h.app,ms:h.last-h.first}));
  const summary=(list:typeof all)=>{const ms=list.map(h=>h.ms);return{...stat(ms),over1s:ms.filter(v=>v>1000).length};};
  const byLock:Record<string,unknown>={};
  for(const lock of new Set(all.map(h=>h.lock)))byLock[lock]={import:summary(all.filter(h=>h.lock===lock&&h.import)),other:summary(all.filter(h=>h.lock===lock&&!h.import))};
  const importApps:Record<string,unknown>={};
  for(const app of new Set(all.filter(h=>h.import).map(h=>h.app)))importApps[app]=summary(all.filter(h=>h.app===app&&h.lock==='access'));
  return{byLock,importAccessHoldsByPhase:importApps,longest:all.sort((a,b)=>b.ms-a.ms).slice(0,6).map(h=>({lock:h.lock,app:h.app,ms:h.ms}))};
 }};
}

const required=(name:string,v:string|undefined)=>{if(!v)throw new Error(`${name} is required`);return v;};
const port=required('REHEARSAL_PORT',process.env.REHEARSAL_PORT);
const OWNER_URL=required('MIGRATION_DATABASE_URL',process.env.MIGRATION_DATABASE_URL);
for(const url of [required('DATABASE_URL',process.env.DATABASE_URL),OWNER_URL])if(new URL(url).port!==port)throw new Error('Refusing: rehearsal runs only against the disposable cluster port.');
const TENANT=required('REHEARSAL_TENANT',process.env.REHEARSAL_TENANT),ADMIN=required('REHEARSAL_ADMIN',process.env.REHEARSAL_ADMIN);
const ROWS=Number(process.env.IMPORT_ROWS??500),REVERT_ROWS=Number(process.env.REVERT_ROWS??0);
const PHASES=new Set((process.env.PHASES??'baseline,sync,qualification,emergency,profile,family,late,revertSync,revertJob').split(','));
if(process.env.AUDIT_HASH_CHAIN_ENABLED === 'true'){/* already armed by the caller */}else process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const code=(i:number)=>`RB${String(i).padStart(5,'0')}`;

async function main(){
 const {commitSectionImport}=await import('../../core/import-sections');
 const {createSectionImportJob}=await import('../../core/section-import-job');
 const {checkIn}=await import('../../packs/attendance/service');
 const {withTenant,client}=await import('../../db/client');
 const {lockAccessConfigurationTx}=await import('../../core/access-configuration-lock');
 const {listEmployeesPage}=await import('../../core/read');
 const {myProfile}=await import('../../core/profile');
 const {verifyTenantChain}=await import('../../core/audit-chain');
 const {freshImportContext}=await import('../../core/bank-import-worker');
 const {registerRecordsForEmployee}=await import('../../core/personnel-register-import');
 const {readEmployeeHomeSummary}=await import('../../core/employee-home-summary');
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});
 const {entitlements}=await freshImportContext({tenantId:TENANT,userId:ADMIN,roles:['hr_admin']} as never);
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson??undefined,roles:['hr_admin'],entitlements} as never;
 const [{id:employmentId}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code=${process.env.CLOCK_EMPLOYEE_CODE??'EMP-0007'}`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 const [{n:base}]=await obs`select count(*)::int n from employment where tenant_id=${TENANT}::uuid and voided_at is null and import_pending_attempt_id is null`;
 const [{n:withRegisters}]=await obs`select count(*)::int n from employee_qualification q join employment e on e.id=q.employment_id where e.employee_code like 'RB%' and q.archived_at is null`;
 console.log(JSON.stringify({baseEmployees:base,baseQualifications:withRegisters,rows:ROWS}));
 const tag=Date.now().toString(36).toUpperCase();
 const records=async(kind:'qualification'|'emergency',offset:number):Promise<Record<string,string>[]>=>{
  // Half the rows update an existing record by its ID, half add a new one (every second new one takes the exclusive
  // flag from the existing holder), one row per employee.
  const ids=kind==='qualification'
   ?await obs<{code:string;id:string}[]>`select e.employee_code as code,q.id from employee_qualification q join employment e on e.id=q.employment_id where e.tenant_id=${TENANT}::uuid and q.archived_at is null and e.employee_code=any(${Array.from({length:ROWS},(_,i)=>code(offset+i))})`
   :await obs<{code:string;id:string}[]>`select e.employee_code as code,c.id from person_emergency_contact c join employment e on e.person_id=c.person_id where e.tenant_id=${TENANT}::uuid and c.archived_at is null and e.employee_code=any(${Array.from({length:ROWS},(_,i)=>code(offset+i))})`;
  const byCode=new Map(ids.map(r=>[r.code,r.id]));
  return Array.from({length:ROWS},(_,i):Record<string,string>=>{
   const c=code(offset+i),update=i%2===0,flag=i%4===1;
   return kind==='qualification'
    ?{employee_code:c,record_id:update?byCode.get(c)!:'',qualification:update?'':'Bachelor',institute:`Rehearsal ${tag} ${i}`,from_ym:'',to_ym:'',graduation_date:'',major:'',result:'',description:'',is_highest:flag?'Yes':''}
    :{employee_code:c,record_id:update?byCode.get(c)!:'',full_name:update?'':`Rehearsal contact ${tag} ${i}`,relationship:update?'':'Parent',mobile_phone:`01${String(i).padStart(8,'0')}`,home_phone:'',priority:flag?'primary':'',address:'',remarks:`Rehearsal ${tag}`};
  });
 };
 const worker:{proc?:ChildProcess}={};
 const startWorker=()=>{worker.proc=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});};
 const stopWorker=async()=>{const proc=worker.proc;if(!proc||proc.exitCode!==null)return;const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await exited;};
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[],visibility:[],registerExport:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;let visible:(()=>Promise<number>)|null=null;const seen=new Set<number>();
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
 const clockBase=Date.parse(process.env.CLOCK_BASE??'2027-01-01');let clockSeq=0;const clockDay=()=>new Date(clockBase+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runProbes=()=>Promise.all([
  loop('visibility',250,async()=>{if(visible)seen.add(await visible());}),
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
  loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',1000,()=>checkIn(admin,{employmentId,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,selfUser.employment_id,'en','Replacement holiday')),
  loop('registerExport',1500,(i)=>registerRecordsForEmployee(admin,i%2?'qualification':'emergency',code(2900+(i%50)))),
 ]);
 const waitTerminal=async(id:string)=>{for(;;){const [r]=await obs`select state,steps_done,steps_total,counters,metrics,error,result,extract(epoch from finished_at-created_at)*1000 as ms from bulk_job where id=${id}::uuid`;if(['completed','failed','cancelled'].includes(r.state))return r;await sleep(300);}};
 const report:Record<string,unknown>={};
 /** One measured phase: probes and the lock sampler around one operation. */
 const phase=async(name:string,run:()=>Promise<unknown>,watch?:()=>Promise<number>)=>{
  lat=newLat();errors.length=0;seen.clear();visible=watch??null;stop=false;
  const probes=runProbes();const sampler=await startSampler(obs,TENANT);
  const started=Date.now();let outcome:unknown;
  try{outcome=await run();}finally{stop=true;await probes;}
  // The state a normal session sees once the operation has finished (the poll may stop before its last sample).
  if(watch)seen.add(await watch());
  const locks=await sampler.stop();
  report[name]={wallMs:Date.now()-started,outcome,visibleCountsSeen:watch?[...seen].sort((a,b)=>a-b):undefined,
   probes:Object.fromEntries(Object.entries(lat).filter(([k])=>k!=='visibility').map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8),errorCount:errors.length,
   busy:errors.filter(e=>/busy/i.test(e)).length,locks};
  console.log(JSON.stringify({[name]:report[name]},null,1));
 };
 const job=async(section:string,recs:Record<string,string>[])=>{
  const csv=[Object.keys(recs[0]).join(','),...recs.map(r=>Object.values(r).join(','))].join('\n');
  const {job:started}=await createSectionImportJob(admin,{section,records:recs,fileName:`Rehearsal · ${section}.csv`,csv,operationKey:randomUUID()});
  const done=await waitTerminal(started.id);
  return{state:done.state,steps:done.steps_total,ms:Math.round(Number(done.ms)),counters:done.counters,metrics:done.metrics,error:done.error,
   result:done.result?{updated:done.result.updated,skipped:done.result.skipped,failed:done.result.failed?.length,fileErrors:done.result.fileErrors}:null};
 };
 const institutes=(prefix:string)=>async()=>(await obs<{n:number}[]>`select count(*)::int n from employee_qualification where tenant_id=${TENANT}::uuid and institute like ${prefix+'%'}`)[0].n;
 const contacts=(prefix:string)=>async()=>(await obs<{n:number}[]>`select count(*)::int n from person_emergency_contact where tenant_id=${TENANT}::uuid and remarks like ${prefix+'%'}`)[0].n;

 // The host's own noise: the same probes and sampler with no import running.
 if(PHASES.has('baseline'))await phase('baseline',()=>sleep(Number(process.env.BASELINE_SECONDS??45)*1000));
 if(PHASES.has('sync'))await phase('syncRegisterBefore',async()=>{
  const r=await commitSectionImport(admin,{section:'qualification',records:await records('qualification',2000),fileName:'Rehearsal · sync qualification.csv'});
  return{updated:r.updated,fileErrors:r.fileErrors};
 });
 startWorker();await sleep(2000);
 if(PHASES.has('qualification')){const recs=await records('qualification',0);await phase('registerQualificationJob',()=>job('qualification',recs),institutes(`Rehearsal ${tag}`));}
 if(PHASES.has('emergency')){const recs=await records('emergency',500);await phase('registerEmergencyJob',()=>job('emergency',recs),contacts(`Rehearsal ${tag}`));}
 if(PHASES.has('profile')){
  const recs=Array.from({length:ROWS},(_,i)=>({employee_code:code(1000+i),phone:`01${tag.slice(-4)}${String(i).padStart(4,'0')}`}));
  await phase('sectionProfileJob',()=>job('profile',recs));
 }
 if(PHASES.has('family')){
  const recs=Array.from({length:ROWS},(_,i)=>({employee_code:code(1500+i),full_name:`Rehearsal child ${tag} ${i}`,relationship:'child',date_of_birth:'2016-02-03'}));
  await phase('sectionFamilyJob',()=>job('family',recs));
 }
 if(PHASES.has('late')){
  // A late refusal (the 490th employee) leaves no register row visible: nothing was ever committed before release.
  const lateTag=`Late ${tag}`;
  const recs=(await records('qualification',2500)).map((r,i)=>({...r,institute:`${lateTag} ${i}`}));
  await obs.unsafe(`create or replace function public.rehearsal_register_refuse() returns trigger language plpgsql as $$ begin if new.institute='${lateTag} 489' then raise exception 'rehearsal late-row refusal'; end if; return new; end $$;`);
  await obs.unsafe('drop trigger if exists rehearsal_register_refuse on employee_qualification');
  await obs.unsafe('create trigger rehearsal_register_refuse before insert or update on employee_qualification for each row execute function public.rehearsal_register_refuse()');
  try{await phase('registerLateFailure',()=>job('qualification',recs),institutes(lateTag));}
  finally{await obs.unsafe('drop trigger if exists rehearsal_register_refuse on employee_qualification');await obs.unsafe('drop function if exists public.rehearsal_register_refuse()');}
  report.lateVisibleAfter=await institutes(lateTag)();
 }
 if(REVERT_ROWS>0){
  // The employee import Revert: the synchronous one transaction ("before"), then the background job, each over its own
  // freshly imported file of REVERT_ROWS fictional hires.
  const {commitEmployeeImport}=await import('../../core/import');
  const {previewImportRevert,revertImport}=await import('../../core/import-history');
  const {employeeFullRevertHandler}=await import('../../core/employee-import-history');
  const {previewImportRevertForAttempt,revertImportForAttempt}=await import('../../core/import-history-handlers');
  const [{company_id:companyId}]=await obs`select company_id from department where name='Finance' and tenant_id=${TENANT}::uuid limit 1`;
  const hires=async(prefix:string)=>{
   const rows=Array.from({length:REVERT_ROWS},(_,i)=>({full_name:`Rehearsal revert ${tag} ${prefix} ${i}`,email:`${prefix.toLowerCase()}-${tag.toLowerCase()}-${i}@example.test`,employee_code:`${prefix}${tag}${String(i).padStart(4,'0')}`,department:'Finance',hired_on:'2026-03-02',employment_type:'full_time',basic_salary:'4200'}));
   const imported=await commitEmployeeImport(admin,{companyId,records:rows,fileName:`rehearsal-${prefix}.csv`,source:{name:`rehearsal-${prefix}.csv`,content:Buffer.from(prefix+tag)}} as never);
   return (imported as {attemptId?:string|null}).attemptId!;
  };
  const voided=(prefix:string)=>async()=>(await obs<{n:number}[]>`select count(*)::int n from employment where tenant_id=${TENANT}::uuid and voided_employee_code like ${prefix+tag+'%'}`)[0].n;
  if(PHASES.has('revertSync')){
   const attemptId=await hires('RS');
   const preview=await previewImportRevert(admin,attemptId,employeeFullRevertHandler);
   await phase('employeeRevertSync',()=>revertImport(admin,attemptId,employeeFullRevertHandler,{previewHash:preview.previewHash,reason:'Rehearsal revert'}));
  }
  if(PHASES.has('revertJob')){
   const attemptId=await hires('RJ');
   await phase('employeeRevertJob',async()=>{
    const preview=await previewImportRevertForAttempt(admin,attemptId);
    const started=await revertImportForAttempt(admin,attemptId,{previewHash:preview.previewHash,reason:'Rehearsal revert'}) as {job:{id:string}};
    const done=await waitTerminal(started.job.id);
    return{state:done.state,ms:Math.round(Number(done.ms)),metrics:done.metrics,error:done.error,result:done.result};
   },voided('RJ'));
  }
 }
 await stopWorker();
 const chain=await verifyTenantChain(admin);
 console.log(JSON.stringify({auditChain:chain},null,1));
 await obs.end();await client.end();process.exit(0);
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
