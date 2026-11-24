/**
 * ADR 0181 J2, imports: the staged employee import's set path (core/employee-import-set.ts, groups in
 * core/employee-import-worker.ts) is equivalent to the per-row path (EMPLOYEE_IMPORT_GROUP_MAX=1: every row through
 * applyEmployeeImportRowTx, as before). Two tenants are built identically at the shape of a real group (SCALE rule 3:
 * 70 companies, 1,000 employments) and import the same files through the background job: tenant A per row, tenant B
 * set-based.
 *
 * The first file (120 rows) holds the common shape (hire, person, statutory profile, tax selection, IC-derived date of
 * birth, first salary, opening leave grants), rows the set path leaves to the per-row path (a spouse on the family
 * sheet), direct superiors (per-row steps that read the group's employments), and invalid rows: a bad email, a
 * duplicate Employee ID in the file, an Employee ID already in use and a blank name. The second file (80 rows) is
 * refused while saving: after it is prepared, one row's Employee ID is taken by another employment, so that row's group
 * is declined mid-file and falls back to the per-row path, which refuses the row; the whole file is then discarded.
 *
 * Compared, with ids, hashes and timestamps replaced by stable labels: every row the imports wrote (person,
 * employment, assignment, statutory profile, tax selection, salary, leave ledger, reporting lines, dependents), every
 * domain event the imports appended, in chain order, with its payload (the owner-transaction events of the discard and
 * the settle, whose batch sizes adapt to measured time, as a sorted set), the job (state, counters, errors, result and
 * the screen's progress view), Import History (attempt, items, events, runs and their error rows), and the audit chain
 * verification. The diagnostic line EMPLOYEE_IMPORT_SET_EQUIVALENCE_DIAGNOSTIC reports wall time, process CPU
 * (calculation and driver) and the rest (database), application statements and the job's per-chunk split from
 * bulk_job.metrics, for both paths. Fictional fixtures only.
 */
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {client,type SessionContext} from '../db/client';
import {createEmployeeImportJob,getEmployeeImportJob} from '../core/employee-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {verifyTenantChain} from '../core/audit-chain';
import type {EmployeeImportUploadInput} from '../core/employee-import-upload';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base} from './harness';

vi.hoisted(()=>{process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
const COMPANIES=70,EMPLOYMENTS=1000,ROWS=120,REFUSED_ROWS=80,REFUSED_AT=25;
const phase=(label:string,started:number)=>console.info('EMPLOYEE_IMPORT_SET_EQUIVALENCE_PHASE',label,Math.round(performance.now()-started));
type Tenant={base:Base;ctx:SessionContext;companies:string[]};

async function build():Promise<Tenant>{
 const base=await seedBase();
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Import shape company '||lpad(n::text,2,'0') from generate_series(1,${COMPANIES-1}::integer)n order by n returning id`;
 // The existing workforce of the group, spread over all 70 companies (the importing company included).
 const all=[base.companyId,...others.map(r=>r.id)];
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Import shape person '||n,'import-shape-'||n||'@fixture.invalid' from generate_series(1,${EMPLOYMENTS}::integer)n returning id,primary_email),
  ranked as(select id,row_number()over(order by primary_email)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${all}::uuid[])[1+((n-1)%${COMPANIES}::integer)],'EQ-SHAPE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 const ctx=await entitledCtx(base);
 // A standing Annual Leave table, so every hire also writes its opening grant through the template resolver.
 await seedEntitlement(ctx,{leaveTypeId:base.annualLeaveTypeId,annualDays:14});
 return{base,ctx,companies:[base.companyId,...others.map(r=>r.id)]};
}

const csv=(rows:Record<string,string>[])=>{const headers=[...new Set(rows.flatMap(r=>Object.keys(r)))];return [headers.join(','),...rows.map(r=>headers.map(h=>r[h]??'').join(','))].join('\n')+'\n';};
const days=['2026-03-02','2026-03-16','2026-04-01'];
function mainFile(){
 const rows:Record<string,string>[]=[];
 for(let i=0;i<ROWS;i++){
  const row:Record<string,string>={employee_code:`EQA${String(i).padStart(4,'0')}`,full_name:`Import Equivalence Person ${i}`,email:`eq-a-${i}@fixture.test`,department:i%2?'Operations':'Finance',
   hired_on:days[i%3],employment_type:i%9===4?'part_time':'full_time',basic_salary:String(2500+i*13),ic_number:i%17===3?'':`880101140${String(i).padStart(3,'0')}`,
   position:i%5===0?'Executive':'',monthly_allowance:i%4===0?'150':'',direct_superior:i>=10&&i<15?'EQA0001':i===15?'EQ-SHAPE-0001':''};
  if(i===30)row.email='not-an-email';
  if(i===31)row.employee_code='EQA0002';
  if(i===32)row.employee_code='EQ-SHAPE-0002';
  if(i===33)row.full_name='';
  rows.push(row);
 }
 const family=rows.filter((_,i)=>i%25===9).map(r=>({employee_code:r.employee_code,full_name:`Spouse of ${r.full_name}`,relationship:'spouse',date_of_birth:'1990-05-05',gender:'female',is_beneficiary:'no'}));
 return{csv:csv(rows),dependentsCsv:csv(family)};
}
function refusedFile(){
 const rows=Array.from({length:REFUSED_ROWS},(_,i)=>({employee_code:`EQR${String(i).padStart(4,'0')}`,full_name:`Import Refusal Person ${i}`,email:`eq-r-${i}@fixture.test`,department:'Finance',
  hired_on:'2026-03-02',employment_type:'full_time',basic_salary:String(3000+i),ic_number:`890202140${String(i).padStart(3,'0')}`}));
 return{csv:csv(rows),dependentsCsv:''};
}
const refusedCode=`EQR${String(REFUSED_AT).padStart(4,'0')}`;

async function runImport(t:Tenant,file:{csv:string;dependentsCsv:string},name:string,groups:boolean,beforeChunks?:()=>Promise<void>){
 if(groups)delete process.env.EMPLOYEE_IMPORT_GROUP_MAX;else process.env.EMPLOYEE_IMPORT_GROUP_MAX='1';
 const input:EmployeeImportUploadInput={companyId:t.base.companyId,csv:file.csv,fileName:name,dependentsCsv:file.dependentsCsv,registers:{},allocationsCsv:''};
 const started=await createEmployeeImportJob(t.ctx,input,{name,content:Buffer.from(file.csv),operationKey:randomUUID()});
 if(!('job' in started))throw new Error('unexpected replay');
 const id=started.job.id;
 const state=async()=>(await owner.client<{state:string;notified_at:Date|null}[]>`select state,notified_at from bulk_job where id=${id}::uuid`)[0];
 let prepared=false;
 for(let i=0;i<20000;i++){
  const s=await state();
  if(!prepared&&s.state==='running'){prepared=true;await beforeChunks?.();}
  if(['completed','failed','cancelled'].includes(s.state)&&s.notified_at)return id;
  if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('employee import job did not finish');
}

/** Test-only statement profile of the application pool (client.options.debug, as test/helpers/statement-observer.ts):
 * statement text only, never a parameter. */
async function profile<T>(work:()=>Promise<T>){
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const sent:{at:number;text:string}[]=[];
 options.debug=(_connection:number,text:string)=>{sent.push({at:performance.now(),text});};
 const started=performance.now(),cpu=process.cpuUsage();
 try{
  const result=await work();const ms=performance.now()-started,c=process.cpuUsage(cpu),cpuMs=(c.user+c.system)/1000,end=performance.now();
  const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
  // Time from each statement's send to the next one's (its execution plus the application work after it), by text.
  const byText=new Map<string,{n:number;ms:number}>();
  sent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,140);const row=byText.get(key)??{n:0,ms:0};row.n++;row.ms+=(sent[i+1]?.at??end)-s.at;byText.set(key,row);});
  return{result,ms,cpuMs,statements:sent.filter(s=>!bookkeeping.test(s.text.trim())).length,transactions:sent.filter(s=>/^select set_config\('app\.tenant_id'/i.test(s.text.trim())).length,
   top:[...byText].sort((a,b)=>b[1].ms-a[1].ms).slice(0,30).map(([text,row])=>({ms:Math.round(row.ms),n:row.n,text}))};
 }finally{options.debug=previous;}
}

/** Every uuid becomes a stable label or its order of first appearance; every 64-hex hash likewise; timestamps a
 * constant. Callers order their rows by stable keys first, so equal structures give equal text. */
function normalizer(t:Tenant,codes:Map<string,string>){
 const labels=new Map<string,string>([[t.base.tenantId,'tenant'],[t.ctx.userId!,'user'],[t.base.deptA,'dept:Finance'],[t.base.deptB,'dept:Operations'],[t.base.positionId,'position'],[t.base.annualLeaveTypeId,'leave:ANNUAL']]);
 t.companies.forEach((id,i)=>labels.set(id,`company:${i}`));
 return(value:unknown)=>{
  for(const [id,label] of codes)labels.set(id,label);
  const seen=new Map<string,string>();
  const text=JSON.stringify(value,(_key,v)=>v instanceof Date?'ts':typeof v==='bigint'?String(v):v)
   .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)?/g,'ts')
   .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>labels.get(id.toLowerCase())??(seen.get(id)??(seen.set(id,`id#${seen.size}`),seen.get(id)!)))
   .replace(/\b[0-9a-f]{64}\b/g,h=>seen.get(h)??(seen.set(h,`hash#${seen.size}`),seen.get(h)!));
  return JSON.parse(text);
 };
}
const omit=(row:Record<string,unknown>,keys:string[])=>Object.fromEntries(Object.entries(row).filter(([k])=>!keys.includes(k)));
const STAMPS=['created_at','updated_at','recorded_at','occurred_at','sequence','settled_at','finished_at','started_at','not_before','lease_expires_at','lease_token','claimed_at'];

async function snapshot(t:Tenant,jobId:string,prefix:string,sinceSequence:number){
 const tenant=t.base.tenantId;
 const employments=await owner.client<Record<string,unknown>[]>`select * from employment where tenant_id=${tenant}::uuid and employee_code like ${prefix+'%'} order by employee_code`;
 const codes=new Map<string,string>();
 for(const e of employments){codes.set(String(e.id),`employment:${e.employee_code}`);codes.set(String(e.person_id),`person:${e.employee_code}`);}
 const n=normalizer(t,codes);
 const ids=employments.map(e=>String(e.id)),people=employments.map(e=>String(e.person_id));
 const byCode=(rows:Record<string,unknown>[],key:string)=>rows.sort((a,b)=>String(codes.get(String(a[key])))!.localeCompare(String(codes.get(String(b[key]))))||JSON.stringify(n(a)).localeCompare(JSON.stringify(n(b))));
 const persons=await owner.client<Record<string,unknown>[]>`select * from person where id=any(${people}::uuid[])`;
 const assignments=await owner.client<Record<string,unknown>[]>`select * from assignment where employment_id=any(${ids}::uuid[])`;
 const statutory=await owner.client<Record<string,unknown>[]>`select * from employee_statutory_my where person_id=any(${people}::uuid[])`;
 const selections=await owner.client<Record<string,unknown>[]>`select * from employment_tax_selection_my where employment_id=any(${ids}::uuid[])`;
 const salaries=await owner.client<Record<string,unknown>[]>`select * from compensation where employment_id=any(${ids}::uuid[])`;
 const ledger=await owner.client<Record<string,unknown>[]>`select * from leave_ledger where employment_id=any(${ids}::uuid[])`;
 const lines=await owner.client<Record<string,unknown>[]>`select * from reporting_line where subordinate_employment_id=any(${ids}::uuid[])`;
 const dependents=await owner.client<Record<string,unknown>[]>`select * from employee_dependent where person_id=any(${people}::uuid[])`;
 const events=await owner.client<Record<string,unknown>[]>`select * from domain_event where tenant_id=${tenant}::uuid and sequence>${sinceSequence} order by sequence`;
 const [job]=await owner.client<Record<string,unknown>[]>`select state,phase,counters,errors,error,result,steps_total,steps_done,attempt_id,company_ids,source_name from bulk_job where id=${jobId}::uuid`;
 codes.set(jobId,'job');if(job.attempt_id)codes.set(String(job.attempt_id),'attempt');
 const attempts=await owner.client<Record<string,unknown>[]>`select * from import_attempt where id=${job.attempt_id as string}::uuid`;
 const items=await owner.client<Record<string,unknown>[]>`select * from import_attempt_item where attempt_id=${job.attempt_id as string}::uuid order by ordinal,item_key`;
 const history=await owner.client<Record<string,unknown>[]>`select * from import_attempt_event where attempt_id=${job.attempt_id as string}::uuid order by created_at,kind`;
 const runs=await owner.client<Record<string,unknown>[]>`select * from employee_import_run where tenant_id=${tenant}::uuid and file_name=${job.source_name as string} order by created_at`;
 const view=await getEmployeeImportJob(t.ctx,jobId);
 return n({
  employments:employments.map(r=>omit(r,STAMPS)),
  persons:byCode(persons.map(r=>omit(r,STAMPS)),'id'),
  assignments:byCode(assignments.map(r=>omit(r,[...STAMPS,'id'])),'employment_id'),
  statutory:byCode(statutory.map(r=>omit(r,STAMPS)),'person_id'),
  selections:byCode(selections.map(r=>omit(r,STAMPS)),'employment_id'),
  salaries:byCode(salaries.map(r=>omit(r,STAMPS)),'employment_id'),
  ledger:byCode(ledger.map(r=>omit(r,[...STAMPS,'id'])),'employment_id'),
  lines:byCode(lines.map(r=>omit(r,[...STAMPS,'id'])),'subordinate_employment_id'),
  dependents:byCode(dependents.map(r=>omit(r,[...STAMPS,'id'])),'person_id'),
  // The imports' own events in chain order. The owner-transaction events (attributed to the job: the discard's voids,
  // the settle's follow-ups) are written in bounded batches whose size adapts to measured time, so their order is the
  // batches' on either path: they are compared as a sorted set, without their chain position.
  events:events.filter(r=>!(r.payload as {bulkJob?:unknown}|null)?.bulkJob).map(r=>omit(r,[...STAMPS,'id'])),
  ownerEvents:events.filter(r=>(r.payload as {bulkJob?:unknown}|null)?.bulkJob).map(r=>omit(r,[...STAMPS,'id','chain_seq','hash','prev_hash']))
   .map(r=>({row:r,key:JSON.stringify(n(r))})).sort((a,b)=>a.key.localeCompare(b.key)).map(r=>r.row),
  job:{...job,attempt_id:'attempt'},
  view:{...omit(view as unknown as Record<string,unknown>,['id','createdAt','updatedAt','finishedAt','startedAt','metrics']),attemptId:'attempt'},
  attempts:attempts.map(r=>omit(r,[...STAMPS,'id'])),
  items:items.map(r=>omit(r,[...STAMPS,'id','attempt_id'])),
  history:history.map(r=>omit(r,[...STAMPS,'id','attempt_id'])),
  runs:runs.map(r=>omit(r,[...STAMPS,'id'])),
 });
}
const lastSequence=async(t:Tenant)=>Number((await owner.client<{s:string|null}[]>`select max(sequence)::text as s from domain_event where tenant_id=${t.base.tenantId}::uuid`)[0].s??0);
const metricsOf=async(jobId:string)=>(await owner.client<{metrics:Record<string,number>}[]>`select metrics from bulk_job where id=${jobId}::uuid`)[0].metrics;
/** After prepare, another employment takes one row's Employee ID: that row is refused while saving. */
const takeCode=(t:Tenant)=>async()=>{
 await owner.client`with p as(insert into person(tenant_id,full_name,primary_email) values(${t.base.tenantId}::uuid,'Import code holder','import-code-holder@fixture.invalid') returning id)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${t.base.tenantId}::uuid,id,${t.base.companyId}::uuid,${refusedCode},'2025-01-01'::date from p`;
};

beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(async()=>{delete process.env.EMPLOYEE_IMPORT_GROUP_MAX;await closeAll();});

// Budget about 3x the first hosted run's case duration, recorded in the PR (SCALE rule 15).
it('imports set-based exactly as the per-row path, at the shape of a 70-company group',async()=>{
 const started=performance.now();
 const a=await build(),b=await build();
 phase('built',started);
 const [shape]=await owner.client<{companies:number;employments:number}[]>`select count(distinct company_id)::int as companies,count(*)::int as employments from employment where tenant_id=${b.base.tenantId}::uuid`;
 expect(shape).toEqual({companies:COMPANIES,employments:EMPLOYMENTS});

 const file=mainFile();
 const sinceA=await lastSequence(a),sinceB=await lastSequence(b);
 const perRow=await profile(()=>runImport(a,file,'equivalence.csv',false));
 phase('per-row import',started);
 const set=await profile(()=>runImport(b,file,'equivalence.csv',true));
 phase('set import',started);
 const left=await snapshot(a,perRow.result,'EQA',sinceA),right=await snapshot(b,set.result,'EQA',sinceB);
 const perRowMetrics=await metricsOf(perRow.result),setMetrics=await metricsOf(set.result);

 // The file exercised what it claims: the job completed, invalid rows were rejected, the rest were hired with their
 // opening grants, dates of birth, superiors and dependents.
 const job=right.job as {state:string;counters:Record<string,number>;result:{imported:number;skipped:number;dependentsImported:number}};
 expect(job.state).toBe('completed');
 expect(job.counters.total).toBe(ROWS);
 expect(job.counters.invalid).toBeGreaterThanOrEqual(4);
 expect(job.result).toMatchObject({imported:job.counters.valid,skipped:job.counters.invalid,dependentsImported:5});
 expect((right.employments as unknown[]).length).toBe(job.counters.valid);
 expect((right.ledger as unknown[]).length).toBeGreaterThan(0);
 expect((right.lines as unknown[]).length).toBe(6);
 expect((right.events as {event_type:string}[]).filter(e=>e.event_type==='person.updated').length).toBeGreaterThan(90);
 expect((right.events as {event_type:string}[]).filter(e=>e.event_type==='employment.hired').length).toBe(job.counters.valid);
 // Equivalence, part 1: every saved row, every event in chain order, the job, the screen's view and Import History.
 expect(right).toEqual(left);

 // Part 2: a file refused while saving, the refusal mid-file in a set-based group.
 const refused=refusedFile();
 const sinceA2=await lastSequence(a),sinceB2=await lastSequence(b);
 const perRowRefused=await profile(()=>runImport(a,refused,'equivalence-refused.csv',false,takeCode(a)));
 const setRefused=await profile(()=>runImport(b,refused,'equivalence-refused.csv',true,takeCode(b)));
 phase('refused imports',started);
 const left2=await snapshot(a,perRowRefused.result,'EQR',sinceA2),right2=await snapshot(b,setRefused.result,'EQR',sinceB2);
 const refusedJob=right2.job as {state:string;error:string;errors:{rowNum:number;message:string}[]};
 expect(refusedJob.state).toBe('failed');
 expect(refusedJob.errors).toHaveLength(REFUSED_ROWS);
 expect(refusedJob.errors.filter(e=>e.message.includes(refusedCode))).toHaveLength(1);
 // Nothing of the discarded file is visible; its hires were voided exactly as the per-row path voids them.
 expect(right2).toEqual(left2);
 const setRefusedMetrics=await metricsOf(setRefused.result);

 // The set path really ran in groups; the refused file declined one group mid-file and resumed groups after it.
 expect(perRowMetrics.importGroups??0).toBe(0);
 expect(setMetrics.importGroups).toBeGreaterThan(0);
 expect(setMetrics.importGroupRows).toBeGreaterThan(ROWS/2);
 expect(setRefusedMetrics.importGroups).toBeGreaterThan(1);
 expect(setRefusedMetrics.importSingles).toBeGreaterThan(0);
 for(const t of [a,b])expect(await verifyTenantChain(t.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});

 const split=(p:{ms:number;cpuMs:number;statements:number;transactions:number},rows:number)=>({wallMs:Math.round(p.ms),calcMs:Math.round(p.cpuMs),dbMs:Math.round(p.ms-p.cpuMs),
  msPerRow:Math.round(p.ms/rows),statements:p.statements,statementsPerRow:Math.round(p.statements/rows),transactions:p.transactions});
 console.info('EMPLOYEE_IMPORT_SET_EQUIVALENCE_DIAGNOSTIC',JSON.stringify({
  shape:{companies:COMPANIES,employments:EMPLOYMENTS,rows:ROWS,refusedRows:REFUSED_ROWS},
  perRow:{...split(perRow,ROWS),metrics:perRowMetrics},set:{...split(set,ROWS),metrics:setMetrics,top:set.top},
  perRowRefused:split(perRowRefused,REFUSED_ROWS),setRefused:{...split(setRefused,REFUSED_ROWS),metrics:setRefusedMetrics},
 },null,1));
},900_000);
