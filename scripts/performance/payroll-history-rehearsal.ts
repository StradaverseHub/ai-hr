/**
 * Fictional-data rehearsal of payroll history upload confirm and revert as staged jobs (core/payroll-history-job.ts).
 * Disposable database only: refuses any URL not pointing at the rehearsal port. Spawns the real protected worker
 * (scripts/bank-import-runner.ts, which runs the shared bulk-job kernel) and, with hot-path probes running and every
 * tenant-wide key sampled (the Access, audit-chain and other tenant keys, and the payroll history barrier):
 *
 *   J. confirms a one-month file for every fictional employee through the job, then reverts it through the job;
 *   S. confirms the same file through the single transaction (confirmPayrollHistoryUpload), then reverts it.
 *
 * and compares the canonical figure digests of the two imported batches (every payslip's money and statutory
 * breakdown, the batch totals and headcount). Env: DATABASE_URL (app), MIGRATION_DATABASE_URL (owner),
 * REHEARSAL_PORT, REHEARSAL_TENANT, REHEARSAL_ADMIN, EMPLOYEES (3000), HISTORY_PERIOD (2026-05),
 * PAYROLL_HISTORY_CHUNK_BUDGET_MS, PHASES (default JS).
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
const EMPLOYEES=Number(process.env.EMPLOYEES??3000),PERIOD=process.env.HISTORY_PERIOD??'2026-05';
if(process.env.AUDIT_HASH_CHAIN_ENABLED!=='true')process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Holds of named advisory keys (here the payroll history barrier, which the tenant sampler does not list). */
async function startKeySampler(obs:postgres.Sql,keys:{name:string;key:string}[],intervalMs=25){
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
 const {checkIn}=await import('../../packs/attendance/service');
 const {withTenant,client}=await import('../../db/client');
 const {lockAccessConfigurationTx}=await import('../../core/access-configuration-lock');
 const {lockPayrollHistoryReadTx}=await import('../../core/payroll-history-lock');
 const {listEmployeesPage}=await import('../../core/read');
 const {myProfile}=await import('../../core/profile');
 const {verifyTenantChain}=await import('../../core/audit-chain');
 const {freshImportContext}=await import('../../core/bank-import-worker');
 const {readEmployeeHomeSummary}=await import('../../core/employee-home-summary');
 const {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload}=await import('../../core/payroll-history-revisions');
 const {requestPayrollHistoryConfirm,requestPayrollHistoryRevert}=await import('../../core/payroll-history-job');
 const {PAYROLL_HISTORY_HEADERS}=await import('../../lib/payroll-history-import-schema');
 const {toCsv}=await import('../../lib/csv');
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});
 const {entitlements}=await freshImportContext({tenantId:TENANT,userId:ADMIN,roles:['hr_admin']} as never);
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson??undefined,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],entitlements} as never;
 const [{id:employmentId}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code=${process.env.CLOCK_EMPLOYEE_CODE??'EMP-0007'}`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 const emps=await obs<{code:string;basic:string}[]>`select e.employee_code as code,c.basic_salary::text as basic from employment e join compensation c on c.employment_id=e.id and c.valid_to is null
  where e.tenant_id=${TENANT}::uuid and e.employee_code like 'RP%' order by e.employee_code limit ${EMPLOYEES}`;
 const rows:string[][]=[];
 for(const e of emps)for(const [code,amount] of [['BASIC',e.basic],['EEEPF','0'],['EESOCSO','0'],['EEEIS','0'],['PCB','0']])rows.push([e.code,PERIOD,'ME',code,'Demo Sdn Bhd',amount]);
 const content=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows]));
 console.log(JSON.stringify({employees:emps.length,rows:rows.length,bytes:content.length,period:PERIOD}));

 const worker:{proc?:ChildProcess}={};
 worker.proc=spawn(process.execPath,['--import','tsx','scripts/bank-import-runner.ts'],{env:{...process.env,AIHR_DB_POOL_MAX:'4'},stdio:'inherit'});
 const stopWorker=async()=>{const proc=worker.proc;if(!proc||proc.exitCode!==null)return;const exited=new Promise(resolve=>proc.once('exit',resolve));proc.kill('SIGTERM');await exited;};
 const newLat=():Record<string,number[]>=>({login:[],access:[],clock:[],profile:[],personnel:[],home:[],payrollRead:[]});
 let lat=newLat();const errors:string[]=[];let stop=false;
 const loop=async(name:string,gap:number,fn:(i:number)=>Promise<unknown>)=>{let i=0;while(!stop){const s=Date.now();try{await fn(i++);lat[name].push(Date.now()-s);}catch(e){const err=e as {message?:string;code?:string;cause?:{code?:string;message?:string}};errors.push(`${name}: [${err?.cause?.code??err?.code??'-'}] ${String(err?.cause?.message??err?.message??e).slice(0,160)}`);}await sleep(gap);}};
 const clockBase=Date.parse(process.env.CLOCK_BASE??'2034-01-01');
 let clockSeq=0;const clockDay=()=>new Date(clockBase+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runProbes=()=>Promise.all([
  loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
  loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
  loop('clock',1000,()=>checkIn(admin,{employmentId,date:clockDay(),time:'09:00'})),
  loop('profile',600,()=>myProfile(employee)),
  loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
  loop('home',800,()=>readEmployeeHomeSummary(employee,selfUser.employment_id,'en','Replacement holiday')),
  // Every payroll calculation, payslip, report and letter reader takes the history barrier shared.
  loop('payrollRead',300,()=>withTenant(admin,async(tx:any)=>{await lockPayrollHistoryReadTx(tx,TENANT);await tx.execute(sql`select 1`);})),
 ]);
 const figures=async(attemptId:string)=>{
  const docs=await obs<{e:string;doc:unknown}[]>`select p.employment_id::text as e,jsonb_build_object('gross',p.gross_pay,'net',p.net_pay,'ded',p.total_deductions,'cost',p.employer_cost,'basic',p.basic_salary,'allowance',p.allowance,
    'ot',p.overtime_pay,'bonus',p.bonus,'other',p.other_deductions,'statutory',p.statutory) as doc from payslip p join payroll_batch b on b.id=p.batch_id where b.history_import_attempt_id=${attemptId}::uuid order by p.employment_id`;
  const batches=await obs<{totals:unknown;n:number;status:string;period:string;parent:string}[]>`select b.totals,b.employee_count as n,b.status::text as status,b.pay_period as period,pp.status::text as parent
   from payroll_batch b join pay_period pp on pp.id=b.pay_period_id where b.history_import_attempt_id=${attemptId}::uuid order by b.pay_period`;
  const text=JSON.stringify({rows:docs.map(r=>[r.e,r.doc]),batches:batches.map(b=>[b.period,b.totals,b.n,b.status,b.parent])});
  return{digest:createHash('sha256').update(text).digest('hex'),payslips:docs.length,batches:batches.length};
 };
 const waitJob=async(jobId:string)=>{for(;;){const [r]=await obs`select state,steps_done,steps_total,counters,metrics,error,result from bulk_job where id=${jobId}::uuid`;if(['completed','failed','cancelled'].includes(r.state)&&r)return r;await sleep(250);}};
 const phase=async(name:string,run:()=>Promise<{jobId?:string}>)=>{
  lat=newLat();errors.length=0;stop=false;const probes=runProbes();
  const tenantSampler=await startTenantLockSampler(obs,TENANT);const keySampler=await startKeySampler(obs,[{name:'payroll-history',key:'payroll-history:'+TENANT}]);
  await sleep(1000);
  const started=Date.now();const {jobId}=await run();
  const job=jobId?await waitJob(jobId):null;
  const wallMs=Date.now()-started;await sleep(1000);
  stop=true;await probes;const tenantLocks=await tenantSampler.stop();const historyLocks=await keySampler.stop();
  const busy=errors.filter(e=>/busy|55P03|lock timeout|try again/i.test(e)).length;
  const out={phase:name,wallMs,job,probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errorCount:errors.length,busy,errors:[...new Set(errors)].slice(0,8),tenantLocks,historyLocks};
  console.log(JSON.stringify(out,null,2));
  return out;
 };
 // Baseline probes with nothing running.
 lat=newLat();stop=false;const base=runProbes();await sleep(Number(process.env.BASELINE_SECONDS??15)*1000);stop=true;await base;
 console.log(JSON.stringify({baseline:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8)},null,2));
 errors.length=0;
 const PHASES=process.env.PHASES??'JS';
 const validate=async()=>{
  const t=Date.now();const preview=await previewPayrollHistoryUpload(admin,{name:'history.csv',operationKey:randomUUID(),content});
  if(preview.plan.counts.invalid)throw new Error('invalid plan: '+JSON.stringify(preview.plan.issues.slice(0,3)));
  console.log(JSON.stringify({validateMs:Date.now()-t,counts:preview.plan.counts,warnings:preview.plan.rows.filter(r=>r.warnings?.length).length}));
  return{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:true,acknowledgeWarnings:true};
 };
 const out:Record<string,unknown>={};
 if(PHASES.includes('J')){
  const input=await validate();
  const confirm=await phase('J confirm (job)',async()=>{const r=await requestPayrollHistoryConfirm(admin,input);return'jobId' in r?{jobId:r.jobId}:{};});
  const jobFigures=await figures(input.attemptId);
  const review=await previewPayrollHistoryRevert(admin,input.attemptId);
  const revert=await phase('J revert (job)',async()=>({jobId:(await requestPayrollHistoryRevert(admin,input.attemptId,review.previewHash)).jobId}));
  Object.assign(out,{jobConfirm:confirm,jobRevert:revert,jobFigures});
 }
 if(PHASES.includes('S')){
  const input=await validate();
  const confirm=await phase('S confirm (single transaction)',async()=>{await confirmPayrollHistoryUpload(admin,input);return{};});
  const syncFigures=await figures(input.attemptId);
  const review=await previewPayrollHistoryRevert(admin,input.attemptId);
  const revert=await phase('S revert (single transaction)',async()=>{await revertPayrollHistoryUpload(admin,input.attemptId,review.previewHash);return{};});
  Object.assign(out,{syncConfirm:confirm,syncRevert:revert,syncFigures});
 }
 await stopWorker();
 const chain=await verifyTenantChain(admin);
 const pick=(p:unknown)=>{const x=p as {wallMs:number;busy:number;errorCount:number;job:{metrics:Record<string,number>}|null;tenantLocks:{byLock:Record<string,{maxMs:number}>};historyLocks:{byLock:Record<string,{maxMs:number}>};probes:Record<string,{max:number}>}|undefined;
  return x&&{wallMs:x.wallMs,busy:x.busy,errors:x.errorCount,metrics:x.job?.metrics,tenantMax:Object.fromEntries(Object.entries(x.tenantLocks.byLock).map(([k,v])=>[k,v.maxMs])),historyMax:Object.fromEntries(Object.entries(x.historyLocks.byLock).map(([k,v])=>[k,v.maxMs])),
   probeMax:Object.fromEntries(Object.entries(x.probes).map(([k,v])=>[k,v.max]))};};
 const jf=out.jobFigures as {digest:string}|undefined,sf=out.syncFigures as {digest:string}|undefined;
 console.log(JSON.stringify({summary:{jobConfirm:pick(out.jobConfirm),jobRevert:pick(out.jobRevert),syncConfirm:pick(out.syncConfirm),syncRevert:pick(out.syncRevert),
  jobDigest:jf?.digest??null,syncDigest:sf?.digest??null,identical:jf&&sf?jf.digest===sf.digest:null},auditChain:chain},null,2));
 await obs.end();await client.end();
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
