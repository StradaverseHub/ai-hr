/**
 * ADR 0181 J2, imports: the leave ledger import's set path (applyLeaveImportGroupTx in core/leave-import.ts, groups in
 * core/leave-import-worker.ts through core/import-set-group.ts) is equivalent to the per-row path
 * (LEAVE_IMPORT_GROUP_MAX=1: every row through applyLeaveImportRowTx, as before). Two tenants are built identically at
 * the shape of a real group (SCALE rule 3: 70 companies, 1,000 employments, a standing grant for everyone) and import
 * the same file through the background job: tenant A per row, tenant B set-based.
 *
 * The file (160 rows) holds adjustments, accruals and debits referenced by Employee ID (also lower-cased), by e-mail
 * (upper-cased) and by IC digits; accruals that open a leave year followed by a later row of the same year (the
 * group sees the rows it wrote before, as the per-row re-check sees committed ones); a reference that is not plain
 * ASCII (never grouped); and invalid rows: an unknown employee, an unknown leave type, a TOIL row, a bad sign, a bad
 * date, a missing day count and a duplicate row in the file; plus a row already in the ledger before the file
 * (skipped by the plan). After the file is prepared, before any row is written:
 *  - another writer saves one planned row (its re-check finds it already imported: skipped while saving);
 *  - one person's e-mail changes, so the row that names that e-mail mid-file no longer matches its plan: its group
 *    is declined and falls back, the per-row path refuses the row ("Leave source is unavailable"), and groups resume
 *    after it.
 *
 * Compared, with ids and timestamps replaced by stable labels: every ledger row of the tenant, every domain event the
 * imports appended in chain order with its payload, the job (state, counters, errors, error, result, steps) and the
 * screen's progress view, and the audit chain verification. The diagnostic line LEAVE_IMPORT_SET_EQUIVALENCE_DIAGNOSTIC
 * reports wall time, process CPU (calculation and driver) and the rest (database), application statements and the
 * job's per-chunk split from bulk_job.metrics, for both paths. Fictional fixtures only.
 */
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {client,type SessionContext} from '../db/client';
import {createLeaveImportJob,readLeaveImportJob} from '../core/leave-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {verifyTenantChain} from '../core/audit-chain';
import type {LeaveImportRecord} from '../lib/leave-import-schema';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

vi.hoisted(()=>{process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
const COMPANIES=70,EMPLOYMENTS=1000,ROWS=160,CHANGED_AT=95,SAVED_AT=40;
type Tenant={base:Base;ctx:SessionContext;companies:string[]};
const code=(n:number)=>`LV-SHAPE-${String(n).padStart(4,'0')}`;
const email=(n:number)=>`leave-shape-${n}@fixture.invalid`;
const ic=(n:number)=>`900101-14-${String(n).padStart(4,'0')}`;

async function build():Promise<Tenant>{
 const base=await seedBase();
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Leave shape company '||lpad(n::text,2,'0') from generate_series(1,${COMPANIES-1}::integer)n order by n returning id`;
 const all=[base.companyId,...others.map(r=>r.id)];
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'Leave shape person '||lpad(n::text,4,'0'),'leave-shape-'||n||'@fixture.invalid' from generate_series(1,${EMPLOYMENTS}::integer)n returning id,full_name),
  ranked as(select id,row_number()over(order by full_name)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${all}::uuid[])[1+((n-1)%${COMPANIES}::integer)],'LV-SHAPE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 // IC numbers for every tenth person (referenced by digits below), and a standing 2026 grant for everyone but the
 // first 50 (so some 2026 accruals open the year and others land in an opened one).
 await owner.client`insert into employee_statutory_my(tenant_id,person_id,ic_number) select ${base.tenantId}::uuid,e.person_id,'900101-14-'||substr(e.employee_code,10)
  from employment e where e.tenant_id=${base.tenantId}::uuid and substr(e.employee_code,10)::int%10=0`;
 await owner.client`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on,reason)
  select ${base.tenantId}::uuid,e.id,${base.annualLeaveTypeId}::uuid,'accrual',14,'2026-01-01'::date,'Fixture grant' from employment e where e.tenant_id=${base.tenantId}::uuid and substr(e.employee_code,10)::int>50`;
 // A reference that is not plain ASCII (the set path never groups it; the per-row re-check reads the whole tenant).
 await owner.client`with p as(insert into person(tenant_id,full_name,primary_email) values(${base.tenantId}::uuid,'Leave shape person Zoë','leave-shape-zoe@fixture.invalid') returning id)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,${base.companyId}::uuid,'LV-ZOË-1','2025-01-01'::date from p`;
 // Already imported before the file: the plan skips it.
 await owner.client`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on,reason)
  select ${base.tenantId}::uuid,e.id,${base.annualLeaveTypeId}::uuid,'adjustment',2.5,'2026-03-03'::date,'Imported (leave migration)' from employment e where e.tenant_id=${base.tenantId}::uuid and e.employee_code=${code(300)}`;
 const ctx=await entitledCtx(base);
 return{base,ctx,companies:all};
}

const line=(employee_id:string,days:string,effective_date:string,transaction_type='adjustment',leave_type='ANNUAL'):LeaveImportRecord=>({employee_id,leave_type,transaction_type,days,effective_date});
function file():LeaveImportRecord[]{
 const rows:LeaveImportRecord[]=[];
 for(let i=0;i<ROWS;i++){
  const n=1+((i*37)%EMPLOYMENTS);
  const ref=i%11===3?code(n).toLowerCase():i%13===5?email(n).toUpperCase():code(n);
  const type=i%7===2?'accrual':i%9===4?'debit':'adjustment';
  const days=type==='debit'?`-${1+(i%3)}`:(1+(i%4)*0.25).toFixed(2);
  rows.push(line(ref,days,`2026-0${1+(i%6)}-1${i%9}`,type,i%17===8?'annual':'ANNUAL'));
 }
 // Accruals for one of the first 50 (no standing grant): the first opens 2026, the second lands in the opened year.
 rows[20]=line(code(7),'3.00','2026-05-05','accrual');rows[21]=line(code(7),'1.00','2026-06-06','accrual');
 rows[50]=line(ic(400).replace(/-/g,''),'2.00','2026-04-04');
 rows[60]=line('LV-ZOË-1','1.50','2026-02-02');
 rows[70]=line('NO-SUCH-EMPLOYEE','1.00','2026-02-02');
 rows[71]=line(code(501),'1.00','2026-02-02','adjustment','NOPE');
 rows[72]=line(code(502),'1.00','2026-02-02','in_lieu_accrual');
 rows[73]=line(code(503),'-1.00','2026-02-02','accrual');
 rows[74]=line(code(504),'1.00','2026/02/02');
 rows[75]=line(code(505),'','2026-02-02');
 rows[76]=line(code(506),'1.00','2026-02-02');rows[77]=line(code(506),'1.00','2026-02-02');
 rows[80]=line(code(300),'2.50','2026-03-03');
 rows[SAVED_AT]=line(code(600),'4.00','2026-02-14');
 rows[CHANGED_AT]=line(email(700),'1.00','2026-02-15');
 return rows;
}
/** After the file is prepared: another writer saves one planned row, and one referenced e-mail changes. */
const meanwhile=(t:Tenant)=>async()=>{
 await owner.client`insert into leave_ledger(tenant_id,employment_id,leave_type_id,entry_type,days,effective_on,reason)
  select ${t.base.tenantId}::uuid,e.id,${t.base.annualLeaveTypeId}::uuid,'adjustment',4,'2026-02-14'::date,'Imported (leave migration)' from employment e where e.tenant_id=${t.base.tenantId}::uuid and e.employee_code=${code(600)}`;
 await owner.client`update person set primary_email='leave-shape-renamed@fixture.invalid' where tenant_id=${t.base.tenantId}::uuid and primary_email=${email(700)}`;
};

async function runImport(t:Tenant,records:LeaveImportRecord[],groups:boolean,beforeChunks:()=>Promise<void>){
 if(groups)delete process.env.LEAVE_IMPORT_GROUP_MAX;else process.env.LEAVE_IMPORT_GROUP_MAX='1';
 const job=await createLeaveImportJob(t.ctx,{records,source:{kind:'file',name:'leave-equivalence.csv',format:'csv'}});
 const state=async()=>(await owner.client<{state:string;notified_at:Date|null}[]>`select state,notified_at from bulk_job where id=${job.id}::uuid`)[0];
 let prepared=false;
 for(let i=0;i<20000;i++){
  const s=await state();
  if(!prepared&&s.state==='running'){prepared=true;await beforeChunks();}
  if(['completed','failed','cancelled'].includes(s.state)&&s.notified_at)return job.id;
  if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('leave import job did not finish');
}

/** Test-only statement profile of the application pool (client.options.debug): statement text only, never a parameter. */
async function profile<T>(work:()=>Promise<T>){
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const sent:{at:number;text:string}[]=[];
 options.debug=(_connection:number,text:string)=>{sent.push({at:performance.now(),text});};
 const started=performance.now(),cpu=process.cpuUsage();
 try{
  const result=await work();const ms=performance.now()-started,c=process.cpuUsage(cpu),cpuMs=(c.user+c.system)/1000,end=performance.now();
  const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
  const byText=new Map<string,{n:number;ms:number}>();
  sent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,140);const row=byText.get(key)??{n:0,ms:0};row.n++;row.ms+=(sent[i+1]?.at??end)-s.at;byText.set(key,row);});
  return{result,ms,cpuMs,statements:sent.filter(s=>!bookkeeping.test(s.text.trim())).length,
   top:[...byText].sort((a,b)=>b[1].ms-a[1].ms).slice(0,12).map(([text,row])=>({ms:Math.round(row.ms),n:row.n,text}))};
 }finally{options.debug=previous;}
}

/** Every uuid becomes a stable label or its order of first appearance; timestamps a constant. */
function normalizer(t:Tenant,labels:Map<string,string>){
 labels.set(t.base.tenantId,'tenant');labels.set(t.ctx.userId!,'user');labels.set(t.base.annualLeaveTypeId,'leave:ANNUAL');
 t.companies.forEach((id,i)=>labels.set(id,`company:${i}`));
 return(value:unknown)=>{
  const seen=new Map<string,string>();
  const text=JSON.stringify(value,(_key,v)=>v instanceof Date?'ts':typeof v==='bigint'?String(v):v)
   .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)?/g,'ts')
   .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>labels.get(id.toLowerCase())??(seen.get(id)??(seen.set(id,`id#${seen.size}`),seen.get(id)!)))
   .replace(/\b[0-9a-f]{64}\b/g,h=>seen.get(h)??(seen.set(h,`hash#${seen.size}`),seen.get(h)!));
  return JSON.parse(text);
 };
}
const omit=(row:Record<string,unknown>,keys:string[])=>Object.fromEntries(Object.entries(row).filter(([k])=>!keys.includes(k)));
const STAMPS=['id','created_at','updated_at','recorded_at','occurred_at','sequence','finished_at','started_at','not_before','lease_expires_at','lease_token','claimed_at'];

async function snapshot(t:Tenant,jobId:string,sinceSequence:number){
 const tenant=t.base.tenantId;
 const labels=new Map<string,string>([[jobId,'job']]);
 for(const e of await owner.client<{id:string;employee_code:string}[]>`select id,employee_code from employment where tenant_id=${tenant}::uuid`)labels.set(e.id,`employment:${e.employee_code}`);
 const n=normalizer(t,labels);
 const ledger=await owner.client<Record<string,unknown>[]>`select l.*,e.employee_code from leave_ledger l join employment e on e.id=l.employment_id where l.tenant_id=${tenant}::uuid
  order by e.employee_code,l.effective_on,l.entry_type,l.days,l.reason`;
 const events=await owner.client<Record<string,unknown>[]>`select * from domain_event where tenant_id=${tenant}::uuid and sequence>${sinceSequence} order by sequence`;
 const [job]=await owner.client<Record<string,unknown>[]>`select state,phase,counters,errors,error,result,steps_total,steps_done,source_name,input,plan from bulk_job where id=${jobId}::uuid`;
 const view=await readLeaveImportJob(t.ctx,jobId);
 return n({
  ledger:ledger.map(r=>omit(r,STAMPS)),
  events:events.map(r=>omit(r,STAMPS)),
  // The plan's batch id is random on either path; the rest of the plan is compared.
  job:{...job,plan:omit((job.plan??{}) as Record<string,unknown>,['batchId'])},
  view:omit(view as unknown as Record<string,unknown>,['id','updatedAt']),
 });
}
const lastSequence=async(t:Tenant)=>Number((await owner.client<{s:string|null}[]>`select max(sequence)::text as s from domain_event where tenant_id=${t.base.tenantId}::uuid`)[0].s??0);
const metricsOf=async(jobId:string)=>(await owner.client<{metrics:Record<string,number>}[]>`select metrics from bulk_job where id=${jobId}::uuid`)[0].metrics;

beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(async()=>{delete process.env.LEAVE_IMPORT_GROUP_MAX;await closeAll();});

// Expected well under a minute on the hosted runner (the per-row import of 160 rows is about 5 s); the limit leaves
// about 3x headroom over the slowest observed case (SCALE rule 15).
it('imports leave rows set-based exactly as the per-row path, at the shape of a 70-company group',async()=>{
 const a=await build(),b=await build();
 const [shape]=await owner.client<{companies:number;employments:number}[]>`select count(distinct company_id)::int as companies,count(*)::int as employments from employment where tenant_id=${b.base.tenantId}::uuid`;
 expect(shape).toEqual({companies:COMPANIES,employments:EMPLOYMENTS+1});

 const records=file();
 const sinceA=await lastSequence(a),sinceB=await lastSequence(b);
 const perRow=await profile(()=>runImport(a,records,false,meanwhile(a)));
 const set=await profile(()=>runImport(b,records,true,meanwhile(b)));
 const left=await snapshot(a,perRow.result,sinceA),right=await snapshot(b,set.result,sinceB);
 const perRowMetrics=await metricsOf(perRow.result),setMetrics=await metricsOf(set.result);

 // Independent of the comparison: the file exercised what it claims.
 const view=right.view as {state:string;result:{imported:number;skipped:number;failed:{rowNum:number;message:string}[];totalRows:number}};
 expect(view.state).toBe('completed');
 expect(view.result.totalRows).toBe(ROWS);
 // The plan skipped the prior row; saving skipped the row another writer saved meanwhile.
 expect(view.result.skipped).toBe(2);
 // Only the row whose reference changed was refused while saving; invalid rows were never planned.
 expect(view.result.failed).toEqual([{rowNum:CHANGED_AT+1,employeeRef:email(700),message:'Leave source is unavailable; review it again.'}]);
 const job=right.job as {counters:Record<string,number>};
 expect(job.counters).toMatchObject({total:ROWS,failed:1,skipped:2});
 // Invalid rows: unknown employee, unknown type, TOIL, bad sign, bad date, missing days, the in-file duplicate.
 expect(view.result.imported).toBe(ROWS-7-2-1);
 const imported=(right.ledger as {reason:string;employee_code:string}[]).filter(r=>r.reason==='Imported (leave migration)');
 expect(imported.length).toBe(view.result.imported+2);
 expect(imported.some(r=>r.employee_code==='LV-ZOË-1')).toBe(true);
 expect(imported.filter(r=>r.employee_code===code(7))).toHaveLength(2);
 expect((right.events as {event_type:string;payload:unknown}[]).filter(e=>e.event_type==='leave.import.completed').map(e=>e.payload))
  .toEqual([{imported:view.result.imported,failed:1,skipped:2,totalRows:ROWS,source:{kind:'file',name:'leave-equivalence.csv',format:'csv'}}]);

 // Equivalence: every ledger row, every event in chain order, the job and the screen's view.
 expect(right).toEqual(left);

 // The set path really ran in groups; the changed row's group declined mid-file and groups resumed after it.
 expect(perRowMetrics.importGroups??0).toBe(0);
 // Every planned row (all but the invalid ones and the plan's skip) took the per-row path; the refused row records no
 // timing (its step failed).
 expect(perRowMetrics.importSingles).toBe(ROWS-7-1-1);
 expect(setMetrics.importGroups).toBeGreaterThan(1);
 expect(setMetrics.importGroupRows).toBeGreaterThanOrEqual(40);
 // The non-ASCII reference and the declined group's rows took the per-row path; every other row was grouped.
 expect(setMetrics.importSingles).toBeGreaterThan(0);
 expect(setMetrics.importGroupRows+setMetrics.importSingles).toBe(ROWS-7-1-1);
 for(const t of [a,b])expect(await verifyTenantChain(t.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});

 const planned=ROWS-7;
 const split=(p:{ms:number;cpuMs:number;statements:number})=>({wallMs:Math.round(p.ms),calcMs:Math.round(p.cpuMs),dbMs:Math.round(p.ms-p.cpuMs),
  msPerRow:Math.round(p.ms/planned*10)/10,statements:p.statements,statementsPerRow:Math.round(p.statements/planned*10)/10});
 console.info('LEAVE_IMPORT_SET_EQUIVALENCE_DIAGNOSTIC',JSON.stringify({
  shape:{companies:COMPANIES,employments:EMPLOYMENTS,rows:ROWS,plannedRows:planned},
  perRow:{...split(perRow),metrics:perRowMetrics,top:perRow.top},set:{...split(set),metrics:setMetrics,top:set.top},
 },null,1));
},180_000);
