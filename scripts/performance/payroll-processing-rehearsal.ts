/**
 * Fictional-data rehearsal of payroll processing as a background job (core/payroll-processing-job.ts). Disposable
 * database only: refuses any URL not pointing at the rehearsal port. Spawns the real protected worker process
 * (scripts/bank-import-runner.ts, which runs the shared bulk-job kernel), seeds a populated company, then:
 *
 *   A. processes the run through the job with hot-path probes AND salary edits for employees of the same company
 *      (the payroll inputs writers the payroll wave made wait for a whole run), sampling every tenant-wide key and
 *      the run's own company keys;
 *   B. resets and processes again through the job with the probes only (no input changes), and
 *   C. resets and processes synchronously (the old single transaction, generatePayslips) with the same probes,
 *
 * and compares the canonical figure digests of B and C (every payslip, the statutory breakdown, run totals). Env:
 * DATABASE_URL (app), MIGRATION_DATABASE_URL (owner), REHEARSAL_PORT, REHEARSAL_TENANT, REHEARSAL_ADMIN,
 * BASE_EMPLOYEES (3000), PAY_PERIOD (2026-06), PAYROLL_PROCESS_CHUNK_EMPLOYEES, SKIP_SYNC=1 (skip C).
 */
import '../lib/stub-server-only';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {startTenantLockSampler} from './tenant-lock-sampler';

const required=(name:string,v:string|undefined)=>{if(!v)throw new Error(`${name} is required`);return v;};
const port=required('REHEARSAL_PORT',process.env.REHEARSAL_PORT);
const OWNER_URL=required('MIGRATION_DATABASE_URL',process.env.MIGRATION_DATABASE_URL);
for(const url of [required('DATABASE_URL',process.env.DATABASE_URL),OWNER_URL])if(new URL(url).port!==port)throw new Error('Refusing: rehearsal runs only against the disposable cluster port.');
const TENANT=required('REHEARSAL_TENANT',process.env.REHEARSAL_TENANT),ADMIN=required('REHEARSAL_ADMIN',process.env.REHEARSAL_ADMIN);
const BASE=Number(process.env.BASE_EMPLOYEES??3000),PERIOD=process.env.PAY_PERIOD??'2026-06';
if(process.env.AUDIT_HASH_CHAIN_ENABLED!=='true')process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Holds of the run's own company/month and payroll-inputs keys (the keys the old run held for its whole length). */
async function startRunKeySampler(obs:postgres.Sql,keys:{name:string;key:string}[],intervalMs=25){
 const resolved:{name:string;classid:string;objid:string}[]=[];
 for(const k of keys){const [row]=await obs<{classid:string;objid:string}[]>`select ((k>>32)&4294967295)::oid::text as classid,(k&4294967295)::oid::text as objid from (select hashtextextended(${k.key},0) as k) x`;resolved.push({name:k.name,...row});}
 const nameOf=new Map(resolved.map(k=>[`${k.classid}:${k.objid}`,k.name]));
 const holds=new Map<string,{lock:string;mode:string;app:string;first:number;last:number}>();
 let sampling=true;
 const loop=(async()=>{while(sampling){
  const rows=await obs<{pid:number;classid:string;objid:string;mode:string;xact:string;app:string}[]>`select l.pid,l.classid::text as classid,l.objid::text as objid,l.mode,a.xact_start::text as xact,coalesce(a.application_name,'') as app
   from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and l.granted and l.objsubid=1 and a.xact_start is not null
    and (l.classid::text||':'||l.objid::text)=any(${resolved.map(k=>`${k.classid}:${k.objid}`)}::text[])`;
  const now=Date.now();
  for(const r of rows){const lock=nameOf.get(`${r.classid}:${r.objid}`)??'?';const id=`${r.pid}|${r.xact}|${lock}|${r.mode}`;const h=holds.get(id)??{lock,mode:r.mode,app:r.app,first:now,last:now};h.last=now;if(r.app)h.app=r.app;holds.set(id,h);}
  await sleep(intervalMs);
 }})();
 return{async stop(){sampling=false;await loop;const all=[...holds.values()].map(h=>({lock:h.lock,mode:h.mode,app:h.app,ms:h.last-h.first}));
  const byLock:Record<string,{holds:number;maxMs:number;over1s:number}>={};for(const h of all){const b=byLock[`${h.lock}/${h.mode}`]??={holds:0,maxMs:0,over1s:0};b.holds++;b.maxMs=Math.max(b.maxMs,h.ms);if(h.ms>1000)b.over1s++;}
  return{byLock,longest:all.sort((a,b)=>b.ms-a.ms).slice(0,5)};}};
}

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
 const {createBatch,generatePayslips,resetProcessedBatch}=await import('../../core/payroll');
 const {setCompensation}=await import('../../core/comp');
 const {requestPayrollProcessing}=await import('../../core/payroll-processing-job');
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});
 await obs`insert into tenant_setting(tenant_id,key,value,source) values(${TENANT}::uuid,'payroll.reset_enabled','true'::jsonb,'platform') on conflict(tenant_id,key) do update set value='true'::jsonb,source='platform'`;
 const {entitlements}=await freshImportContext({tenantId:TENANT,userId:ADMIN,roles:['hr_admin']} as never);
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson??undefined,roles:['hr_admin'],entitlements} as never;
 const [{company_id:companyId}]=await obs`select company_id from department where name='Finance' and tenant_id=${TENANT}::uuid limit 1`;
 const [{id:employmentId}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code=${process.env.CLOCK_EMPLOYEE_CODE??'EMP-0007'}`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 const tag=Date.now().toString(36).toUpperCase();
 const [{count}]=await obs`select count(*)::int from employment where tenant_id=${TENANT}::uuid and company_id=${companyId}::uuid and voided_at is null and import_pending_attempt_id is null`;
 console.log(`company employees present: ${count}, target ${BASE}`);
 if(count<BASE){
  const need=BASE-count;const t0=Date.now();
  for(let start=0;start<need;start+=200){
   const records=Array.from({length:Math.min(200,need-start)},(_,i)=>({full_name:`Fictional Payroll ${tag} ${start+i}`,email:`pay-${tag.toLowerCase()}-${start+i}@example.test`,employee_code:`RP${tag}${start+i}`,department:'Finance',hired_on:'2026-03-02',employment_type:'full_time',basic_salary:String(2500+((start+i)%40)*137)}));
   const r=await commitEmployeeImport(admin,{companyId,records});if(r.failed.length||r.fileErrors.length)throw new Error('base seed failed: '+JSON.stringify(r.fileErrors).slice(0,300)+JSON.stringify(r.failed[0]).slice(0,300));
  }
  console.log(`seeded ${need} employees in ${Date.now()-t0}ms`);
 }
 let [batch]=await obs<{id:string;status:string}[]>`select id,status::text from payroll_batch where tenant_id=${TENANT}::uuid and company_id=${companyId}::uuid and pay_period=${PERIOD} and run_type='regular'`;
 if(!batch){const created=await createBatch(admin,{companyId,payPeriod:PERIOD});batch={id:created.batchId,status:'draft'};}
 if(batch.status==='processed')await resetProcessedBatch(admin,{batchId:batch.id,reason:'Rehearsal reset'});
 const batchId=batch.id;
 // Salary-edit subjects: employees of the processing company spread over the run.
 const editable=await obs<{id:string;basic:string}[]>`select e.id,c.basic_salary::text as basic from employment e join compensation c on c.employment_id=e.id and c.valid_to is null
  where e.tenant_id=${TENANT}::uuid and e.company_id=${companyId}::uuid and e.employee_code like 'RP%' order by e.id limit 40`;
 const worker:{proc?:ChildProcess}={};
 worker.proc=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});
 const stopWorker=async()=>{const proc=worker.proc;if(!proc||proc.exitCode!==null)return;const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await exited;};
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[],salaryEdit:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;let edits=false;let editSeq=0;
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){errors.push(`${name}: ${String((e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
 const clockBase=Date.parse(process.env.CLOCK_BASE??'2027-01-01');
 let clockSeq=0;const clockDay=()=>new Date(clockBase+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runProbes=()=>Promise.all([
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
  loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',1000,()=>checkIn(admin,{employmentId,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,selfUser.employment_id,'en','Replacement holiday')),
  // A payroll inputs writer of the processing company (the payroll wave made it wait for the whole run).
  loop('salaryEdit',1000,async()=>{if(!edits)return;const e=editable[editSeq++%editable.length];await setCompensation(admin,{employmentId:e.id,basicSalary:Number(e.basic)+1+editSeq,monthlyAllowance:0,effectiveFrom:`${PERIOD}-01`});}),
 ]);
 const runKeys=[
  {name:'payroll-inputs',key:'payroll-inputs:'+TENANT+':'+companyId},
  {name:'payroll-period',key:'payroll-period:'+JSON.stringify([TENANT,companyId,PERIOD])},
  {name:'pay-catalog',key:TENANT+':pay-component-catalog'},
 ];
 const canonicalDigest=async()=>{
  const rows=await obs<{e:string;doc:unknown}[]>`select p.employment_id::text as e,jsonb_build_object('gross',p.gross_pay,'net',p.net_pay,'ded',p.total_deductions,'cost',p.employer_cost,'basic',p.basic_salary,'allowance',p.allowance,'ot',p.overtime_pay,'bonus',p.bonus,'other',p.other_deductions,'days',p.days_worked,'statutory',p.statutory) as doc from payslip p where p.batch_id=${batchId}::uuid order by p.employment_id`;
  const [b]=await obs<{totals:unknown;n:number;status:string}[]>`select totals,employee_count as n,status::text from payroll_batch where id=${batchId}::uuid`;
  const text=JSON.stringify({rows:rows.map(r=>[r.e,r.doc]),totals:b.totals,n:b.n});
  return{digest:createHash('sha256').update(text).digest('hex'),payslips:rows.length,status:b.status,employeeCount:b.n};
 };
 const phase=async(name:string,run:()=>Promise<{jobId?:string}>,withEdits:boolean)=>{
  lat=newLat();errors.length=0;stop=false;edits=withEdits;const probes=runProbes();
  const tenantSampler=await startTenantLockSampler(obs,TENANT);const keySampler=await startRunKeySampler(obs,runKeys);
  await sleep(1000);
  const started=Date.now();const {jobId}=await run();
  let job:Record<string,unknown>|null=null;
  if(jobId){for(;;){const [r]=await obs`select state,steps_done,steps_total,counters,metrics,error,result from bulk_job where id=${jobId}::uuid`;if(['completed','failed','cancelled'].includes(r.state)){job=r;break;}await sleep(250);}}
  const wallMs=Date.now()-started;await sleep(1000);
  stop=true;await probes;const tenantLocks=await tenantSampler.stop();const runLocks=await keySampler.stop();
  const [mark]=await obs<{n:number}[]>`select coalesce(jsonb_array_length(recalc_employment_ids),0)::int as n from payroll_batch where id=${batchId}::uuid`;
  const busy=errors.filter(e=>/busy|55P03|lock timeout|try again/i.test(e)).length;
  const out={phase:name,wallMs,job,figures:await canonicalDigest(),recalcMarked:mark.n,probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errorCount:errors.length,busy,errors:[...new Set(errors)].slice(0,8),tenantLocks,runLocks};
  console.log(JSON.stringify(out,null,2));
  return out;
 };
 // Baseline probes with nothing running.
 lat=newLat();stop=false;const base=runProbes();await sleep(Number(process.env.BASELINE_SECONDS??15)*1000);stop=true;await base;
 console.log(JSON.stringify({baseline:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8)},null,2));
 errors.length=0;
 const a=await phase('A job + salary edits',async()=>({jobId:(await requestPayrollProcessing(admin,{batchId,operationKey:randomUUID()})).jobId}),true);
 await resetProcessedBatch(admin,{batchId,reason:'Rehearsal reset'});
 // B and C both run after A's last edit and change no input, so they read identical inputs.
 const b=await phase('B job',async()=>({jobId:(await requestPayrollProcessing(admin,{batchId,operationKey:randomUUID()})).jobId}),false);
 let c:Awaited<ReturnType<typeof phase>>|null=null;
 if(process.env.SKIP_SYNC!=='1'){
  await resetProcessedBatch(admin,{batchId,reason:'Rehearsal reset'});
  c=await phase('C synchronous',async()=>{await generatePayslips(admin,{batchId});return{};},false);
 }
 await stopWorker();
 const chain=await verifyTenantChain(admin);
 console.log(JSON.stringify({summary:{employees:b.figures.payslips,jobDigest:b.figures.digest,syncDigest:c?.figures.digest??null,identical:c?b.figures.digest===c.figures.digest:null,
  phaseA:{wallMs:a.wallMs,busy:a.busy,errors:a.errorCount,recalcMarked:a.recalcMarked,chunkHoldMs:(a.job?.metrics as Record<string,number>|undefined)?.chunkHoldMs,finalizeTxMs:(a.job?.metrics as Record<string,number>|undefined)?.finalizeTxMs}},auditChain:chain},null,2));
 await obs.end();await client.end();
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
