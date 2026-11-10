/**
 * Fictional-data rehearsal of the chunked operator tools and sweeps (bulk-operation conversion, 10 Nov 2026).
 * Disposable cluster only: refuses any URL not on REHEARSAL_PORT.
 *
 *   prepare  (once, on the populated baseline): a backup shift, covers all but UNCOVERED employments, closed payslips
 *            for the information reconciliation, a pending module change and an uninstalled capability catalogue.
 *   run      (on a fresh copy of the baseline per code version): each operation in turn while the hot-path probes of
 *            scripts/performance/employee-import-rehearsal.ts run and every tenant-wide advisory key is sampled; then
 *            the normalized end state is written to REHEARSAL_OUT (ids replaced by business keys) for comparison.
 *
 * REHEARSAL_CODE_ROOT selects the code under test (default: this checkout), so the same run can execute an exported
 * base commit for the old synchronous path. Env: DATABASE_URL, MIGRATION_DATABASE_URL, REHEARSAL_PORT,
 * REHEARSAL_MODE (prepare|run), REHEARSAL_OUT, UNCOVERED (300), RECONCILE_ITEMS (200), LABEL_ROWS (20 per category).
 */
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {startTenantLockSampler,type TenantLockReport} from './tenant-lock-sampler';

const required=(name:string,v:string|undefined)=>{if(!v)throw new Error(`${name} is required`);return v;};
const port=required('REHEARSAL_PORT',process.env.REHEARSAL_PORT);
const OWNER_URL=required('MIGRATION_DATABASE_URL',process.env.MIGRATION_DATABASE_URL);
for(const url of [required('DATABASE_URL',process.env.DATABASE_URL),OWNER_URL])if(new URL(url).port!==port)throw new Error('Refusing: rehearsal runs only against the disposable cluster port.');
const ROOT=resolve(process.env.REHEARSAL_CODE_ROOT||fileURLToPath(new URL('../..',import.meta.url)));
const MODE=process.env.REHEARSAL_MODE??'run';
const TENANT='11111111-1111-1111-1111-111111111111',ADMIN='22222222-2222-2222-2222-222222222222';
const UNCOVERED=Number(process.env.UNCOVERED??300),RECONCILE_ITEMS=Number(process.env.RECONCILE_ITEMS??200),LABEL_ROWS=Number(process.env.LABEL_ROWS??20);
const TODAY='2026-11-10',SHIFT_CODE='OPAM03';
process.env.AUDIT_HASH_CHAIN_ENABLED='true';
process.env.TZ=process.env.TZ??'Asia/Kuala_Lumpur';
const load=<T=any>(path:string):Promise<T>=>import(`${ROOT}/${path}.ts`);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const stat=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length?{n:s.length,p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],max:s[s.length-1]}:{n:0,p50:0,p95:0,max:0};};

async function main(){
 await load('scripts/lib/stub-server-only');
 const {withTenant,client}=await load('db/client');
 const {sql}=await import('drizzle-orm');
 const {freshImportContext}=await load('core/bank-import-worker');
 const obs=postgres(OWNER_URL,{max:4,onnotice:()=>{}});
 const {entitlements}=await freshImportContext({tenantId:TENANT,userId:ADMIN,roles:['hr_admin']} as never);
 const [{person_id:adminPerson}]=await obs`select person_id from app_user where id=${ADMIN}::uuid`;
 const admin={tenantId:TENANT,userId:ADMIN,personId:adminPerson,roles:['hr_admin'],entitlements} as never;
 const [{id:companyId}]=await obs`select company_id as id from department where name='Finance' and tenant_id=${TENANT}::uuid limit 1`;

 if(MODE==='prepare'){
  const {createShift,assignEmployeeShift}=await load('core/roster');
  let [shift]=await obs`select id from shift where tenant_id=${TENANT}::uuid and code=${SHIFT_CODE}`;
  if(!shift)shift=await createShift(admin,{name:'Fictional AM03',code:SHIFT_CODE,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]});
  const uncovered=await obs<{id:string}[]>`select id from employment where tenant_id=${TENANT}::uuid and terminated_on is null and default_shift_id is null order by employee_code`;
  const t0=Date.now();
  for(const row of uncovered.slice(UNCOVERED))await assignEmployeeShift(admin,{employmentId:row.id,shiftType:'fixed',shiftId:shift.id});
  console.log(`covered ${Math.max(0,uncovered.length-UNCOVERED)} employments in ${Date.now()-t0}ms; ${Math.min(UNCOVERED,uncovered.length)} left uncovered`);
  const [{n:slips}]=await obs`select count(*)::int n from payslip where tenant_id=${TENANT}::uuid`;
  if(!slips){
   const [period]=await obs`insert into pay_period(tenant_id,company_id,period,status) values(${TENANT}::uuid,${companyId}::uuid,'2025-01','closed') returning id`;
   const [batch]=await obs`insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,batch_date,status,released_at) values(${TENANT}::uuid,${companyId}::uuid,${period.id}::uuid,'2025-01','2025-01-25','closed','2025-01-25T00:00:00Z') returning id`;
   await obs`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,statutory,total_deductions,net_pay,employer_cost)
    select ${TENANT}::uuid,${batch.id}::uuid,e.id,3000,3000,'{"epfEmployee":330,"epfEmployer":390,"pcb":10}'::jsonb,340,2660,3390
    from employment e where e.tenant_id=${TENANT}::uuid and e.company_id=${companyId}::uuid and e.terminated_on is null order by e.employee_code limit ${RECONCILE_ITEMS}`;
  }
  await obs`insert into subscription_line(tenant_id,module_code) select ${TENANT}::uuid,'toil' where not exists(select 1 from subscription_line where tenant_id=${TENANT}::uuid and module_code='toil')`.catch(e=>console.log('subscription line:',String(e.message).slice(0,160)));
  await obs`insert into module_change_request(tenant_id,module_code,action,requested_by) select ${TENANT}::uuid,'toil','activate',${ADMIN}::uuid where not exists(select 1 from module_change_request where tenant_id=${TENANT}::uuid and module_code='toil')`.catch(e=>console.log('module request:',String(e.message).slice(0,160)));
  await obs`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${['workforce.view','workforce.maintain','profile.review']}::text[])`;
  console.log('prepared');await obs.end();await client.end();return;
 }

 // ── probes (same set and cadence as the employee import rehearsal) ──
 const {checkIn}=await load('packs/attendance/service');
 const {lockAccessConfigurationTx}=await load('core/access-configuration-lock');
 const {listEmployeesPage}=await load('core/read');
 const {myProfile}=await load('core/profile');
 const {readEmployeeHomeSummary}=await load('core/employee-home-summary');
 const {verifyTenantChain}=await load('core/audit-chain');
 const [{id:clockEmployment}]=await obs`select id from employment where tenant_id=${TENANT}::uuid and employee_code='EMP-0007'`;
 const [selfUser]=await obs`select u.id,u.person_id,e.id as employment_id,coalesce(array_agg(r.role),'{}') as roles from app_user u join employment e on e.person_id=u.person_id left join role_assignment r on r.app_user_id=u.id where e.employee_code='EMP-0001' and u.tenant_id=${TENANT}::uuid group by 1,2,3`;
 const employee={tenantId:TENANT,userId:selfUser.id,personId:selfUser.person_id,roles:[...new Set(['employee',...selfUser.roles])],entitlements} as never;
 let clockSeq=0;const clockDay=()=>new Date(Date.parse('2027-01-04')+(clockSeq++)*86400000).toISOString().slice(0,10);
 const runPhase=async(name:string,fn:()=>Promise<unknown>)=>{
  const lat:Record<string,number[]>={login:[],access:[],clock:[],profile:[],personnel:[],home:[]};const errors:string[]=[];let stop=false;
  const loop=async(probe:string,gap:number,work:()=>Promise<unknown>)=>{while(!stop){const s=Date.now();try{await work();lat[probe].push(Date.now()-s);}catch(e){const c=(e as {cause?:{code?:string;message?:string}})?.cause;errors.push(`${probe}: ${c?.code??(e as {code?:string})?.code??''} ${String(c?.message??(e as Error)?.message??e).slice(0,160)}`);}await sleep(gap);}};
  const probes=Promise.all([
   loop('login',200,()=>client.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.logged-in','user',$2::uuid,NULL)",[TENANT,ADMIN])),
   loop('access',200,()=>withTenant(admin,async(tx:any)=>{await lockAccessConfigurationTx(tx,TENANT);await tx.execute(sql`select 1`);})),
   loop('clock',1000,()=>checkIn(admin,{employmentId:clockEmployment,date:clockDay(),time:'09:00'})),
   loop('profile',600,()=>myProfile(employee)),
   loop('personnel',800,()=>listEmployeesPage(admin,{limit:50,offset:0},'workforce')),
   loop('home',800,()=>readEmployeeHomeSummary(employee,selfUser.employment_id,'en','Replacement holiday')),
  ]);
  const sampler=await startTenantLockSampler(obs,TENANT,10);
  await sleep(1000);
  const started=Date.now();let result:unknown,failure:string|null=null;
  try{result=await fn();}catch(e){failure=String((e as Error)?.message??e).slice(0,300);}
  const wallMs=Date.now()-started;await sleep(1000);stop=true;await probes;const locks:TenantLockReport=await sampler.stop();
  // Holds by the operation itself, not the probes (which share its pool): a hold whose statements are the probes'.
  const probeQuery=/attendance|personnel_filter|append_auth_event|employee_home|^select \$?1\b|^select 1$/;
  const opHolds=locks.holds.filter(h=>!h.queries.some(q=>probeQuery.test(q)));
  const operationMaxHold=Object.fromEntries(['access','leave','audit','profile'].map(lock=>[lock,Math.max(0,...opHolds.filter(h=>h.lock===lock).map(h=>h.ms))]));
  const out={name,wallMs,result,failure,operationMaxHold,probes:Object.fromEntries(Object.entries(lat).map(([k,v])=>[k,stat(v)])),errors:[...new Set(errors)].slice(0,8),errorCount:errors.length,busy:errors.filter(e=>/busy|55P03|57014|try again/i.test(e)).length,tenantLocks:{byLock:locks.byLock,longest:locks.longest}};
  console.log(JSON.stringify({phase:name,wallMs,failure,operationMaxHold,result:typeof result==='object'?JSON.stringify(result).slice(0,300):result,maxHold:Object.fromEntries(Object.entries(locks.byLock).map(([k,v])=>[k,v.maxMs])),longest:locks.longest.slice(0,3).map(h=>({lock:h.lock,mode:h.mode,ms:h.ms,app:h.app,q:h.queries.slice(0,3)})),probes:out.probes,errorCount:out.errorCount,errors:out.errors}));
  return out;
 };

 const phases:unknown[]=[];
 const runStart=(await obs`select now() as at`)[0].at as Date;
 const sweepCtx={tenantId:TENANT,roles:['hr_admin'],entitlements} as never;
 const {sweepDueReviews,sweepReviewReminders}=await load('core/employment-review');
 phases.push(await runPhase('sweepDueReviews',()=>sweepDueReviews(sweepCtx,{today:TODAY})));
 phases.push(await runPhase('sweepReviewReminders',()=>sweepReviewReminders(sweepCtx,{today:TODAY})));
 const {backfillBackupShift}=await load('core/roster');
 phases.push(await runPhase('backfillBackupShift',async()=>{const r=await backfillBackupShift(admin,{shiftCode:SHIFT_CODE,apply:true});return{before:r.before.length,after:r.after.length,applied:r.applied};}));
 // System Labels import: LABEL_ROWS new codes in every category, through preview then apply (the admin's two steps).
 const {previewSystemLabelImport,applySystemLabelImport}=await load('core/system-label-import');
 const {buildSystemLabelWorkbook}=await load('lib/system-label-workbook');
 const {LABEL_IMPORT_DEFINITIONS}=await load('lib/system-label-definition');
 const rows=Object.fromEntries((LABEL_IMPORT_DEFINITIONS as {kind:string}[]).map((d,i)=>[d.kind,Array.from({length:d.kind==='grade_groups'?Math.min(LABEL_ROWS,5):LABEL_ROWS},(_,n)=>({Code:d.kind==='grades'?`OPG${i}_${n}`:`OP_${i}_${n}`,Name:`Fictional group ${i} ${n}`,Label:`Fictional ${i} ${n}`,Description:'Fictional rehearsal label',Company:companyId,Status:'Active'}))]));
 const bytes=await buildSystemLabelWorkbook({kinds:Object.keys(rows),rows,includeStatus:true,references:{companies:[],grades:[],employees:[]}});
 const preview=await previewSystemLabelImport(admin,bytes);
 phases.push(await runPhase('systemLabelImport',async()=>{const r=await applySystemLabelImport(admin,{bytes,token:preview.token});return{imported:r.imported,skipped:r.skipped,failed:r.failed};}));
 // Information snapshot reconciliation on the private operator connection.
 const {reconcileInformationSnapshots}=await load('scripts/reconcile-information-snapshots');
 const {createDb}=await load('db/client');
 const storage=createDb(OWNER_URL,{max:1});
 const slips=await obs<{id:string;employment_id:string}[]>`select p.id,p.employment_id from payslip p where p.tenant_id=${TENANT}::uuid order by p.employment_id`;
 const manifest={version:1 as const,tenantId:TENANT,actorUserId:ADMIN,verifiedOriginals:true as const,items:slips.map(s=>({payslipId:s.id,employmentId:s.employment_id,companyId,original:{grade:null,employmentType:'full_time' as const,hiredOn:'2026-03-02',joinDate:null},evidence:[{path:'fictional.pdf',sha256:'a'.repeat(64),reference:'Fictional reviewed original'}]}))};
 if(manifest.items.length)phases.push(await runPhase('reconcileInformationSnapshots',()=>reconcileInformationSnapshots(storage,manifest,true)));
 // Module change runner (one pending request) and the capability publication (storage owner).
 const {runModuleChangeTick}=await load('scripts/module-change-runner');
 phases.push(await runPhase('moduleChangeRunner',()=>runModuleChangeTick(storage)));
 const {publishWorkforceCapabilities}=await load('deploy/access/publish-workforce-capabilities');
 const installer=postgres(OWNER_URL,{max:1,onnotice:()=>{}});
 phases.push(await runPhase('publishWorkforceCapabilities',()=>publishWorkforceCapabilities(installer)));
 await installer.end();await storage.client.end();

 // ── normalized end state ──
 const labels=new Map<string,string>();
 for(const r of await obs<{id:string;code:string}[]>`select id::text,coalesce(employee_code,'?') as code from employment where tenant_id=${TENANT}::uuid`)labels.set(r.id,'E:'+r.code);
 for(const r of await obs<{id:string;k:string}[]>`select r.id::text,e.employee_code||':'||r.review_type as k from employment_review r join employment e on e.id=r.employment_id where r.tenant_id=${TENANT}::uuid`)labels.set(r.id,'R:'+r.k);
 for(const r of await obs<{id:string;code:string}[]>`select id::text,coalesce(code,name) as code from shift where tenant_id=${TENANT}::uuid`)labels.set(r.id,'S:'+r.code);
 const norm=(v:unknown)=>JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,m=>labels.get(m.toLowerCase())??'uuid');
 const multiset=(rows:readonly unknown[])=>rows.map(norm).sort();
 const state={
  reviews:multiset(await obs`select r.employment_id,r.review_type,r.status,r.end_date::text,r.due_date::text,r.manager_employment_id,r.auto_triggered from employment_review r where r.tenant_id=${TENANT}::uuid`),
  reminders:multiset(await obs`select review_id,employment_id,offset_days,sent_on::text from employment_review_reminder where tenant_id=${TENANT}::uuid`),
  shifts:multiset(await obs`select id,default_shift_id,shift_type from employment where tenant_id=${TENANT}::uuid`),
  arrangements:multiset(await obs`select employment_id,shift_type,shift_id,valid_from::text,valid_to::text,superseded_at is null as current from employment_shift_arrangement where tenant_id=${TENANT}::uuid`),
  labels:{
   department:multiset(await obs`select name,label,is_global,archived_at is null as active from department where tenant_id=${TENANT}::uuid`),
   position:multiset(await obs`select title,label,is_global from "position" where tenant_id=${TENANT}::uuid`),
   costCenter:multiset(await obs`select code,name,is_global from cost_center where tenant_id=${TENANT}::uuid`),
   businessUnit:multiset(await obs`select code,name,is_global from business_unit where tenant_id=${TENANT}::uuid`),
   profileOption:multiset(await obs`select category,value,label,sort_order,is_active,scope_company_ids from profile_option where tenant_id=${TENANT}::uuid`),
   jobGrade:multiset(await obs`select code,name,rank,scope_company_ids from job_grade where tenant_id=${TENANT}::uuid`),
   gradeGroup:multiset(await obs`select g.name,array(select jg.code from grade_group_member m join job_grade jg on jg.id=m.grade_id where m.grade_group_id=g.id order by 1) from grade_group g where g.tenant_id=${TENANT}::uuid`),
  },
  snapshots:multiset(await obs`select payslip_id is not null as slip,employment_id,grade,employment_type,hired_on::text,join_date::text from information_payslip_snapshot where tenant_id=${TENANT}::uuid`),
  modules:multiset(await obs`select module_code,status,company_id from tenant_module where tenant_id=${TENANT}::uuid`),
  toil:multiset(await obs`select company_id,enabled from toil_policy where tenant_id=${TENANT}::uuid`),
  moduleRequests:multiset(await obs`select module_code,action,status,current_step,error from module_change_request where tenant_id=${TENANT}::uuid`),
  capabilities:multiset(await obs`select id,supported,bindings from access_capability order by id`),
  // Every event the run appended (probe events excluded): type, aggregate, subject and payload, ids as business keys.
  events:multiset(await obs`select event_type,aggregate_type,aggregate_id,subject_employment_id,actor_type,payload from domain_event where tenant_id=${TENANT}::uuid and occurred_at>=${runStart}
    and aggregate_type not like 'attendance%' and aggregate_type<>'app-user' and (subject_employment_id is null or subject_employment_id<>${clockEmployment}::uuid)`),
 };
 const chain=await verifyTenantChain(admin);
 const out=process.env.REHEARSAL_OUT;
 if(out)writeFileSync(out,JSON.stringify({root:ROOT,phases,state,chain},null,1));
 console.log(JSON.stringify({chain,counts:{reviews:state.reviews.length,reminders:state.reminders.length,events:state.events.length,snapshots:state.snapshots.length}}));
 await obs.end();await client.end();
}
main().catch(e=>{console.error('REHEARSAL FATAL',e);process.exit(1);});
