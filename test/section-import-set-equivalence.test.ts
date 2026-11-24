/**
 * ADR 0181 J2, imports: the Profile and Family section import's set path (applySectionGroupTx in
 * core/import-sections.ts, groups in core/section-import-worker.ts through core/import-set-group.ts) is equivalent to
 * the per-row path (SECTION_IMPORT_GROUP_MAX=1: every row through applySectionRowTx, as before). Two tenants are built
 * identically at the shape of a real group (SCALE rule 3: 70 companies, 1,000 employments) and import the same files
 * through the background job: tenant A per row, tenant B set-based.
 *
 * Profile file (120 rows: phone, home phone and name changes): an unknown Employee ID, a duplicate Employee ID and a
 * blank one (refused by the plan); a row whose values are already on file (skipped). After the file is prepared:
 *  - another writer saves one row's phone first (that row is skipped while saving);
 *  - one row's Employee ID is renamed (refused while saving: "inputs changed"), mid-file, so its group declines;
 *  - a database trigger refuses one row's write (a refusal while saving inside a group: the group declines).
 * Family file (60 rows): several children for one employee (a group never holds two rows of one person), an invalid
 * date of birth (refused by the plan), and the child-relief refreshes of the finalize.
 *
 * Compared, with ids and timestamps replaced by stable labels: every person and dependent row of the tenant, every
 * domain event the imports appended in chain order with its payload, the job (state, counters, errors, result, steps),
 * the screen's progress view, the Import History run (employee_import_run), and the audit chain verification. The
 * diagnostic line SECTION_IMPORT_SET_EQUIVALENCE_DIAGNOSTIC reports wall time, process CPU (calculation and driver) and
 * the rest (database), application statements and the job's per-chunk split, for both paths. Fictional fixtures only.
 */
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {client,type SessionContext} from '../db/client';
import {createSectionImportJob,getSectionImportJob} from '../core/section-import-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {verifyTenantChain} from '../core/audit-chain';
import type {ImportRecord} from '../lib/import-schema';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

vi.hoisted(()=>{process.env.AUDIT_HASH_CHAIN_ENABLED='true';});
const COMPANIES=70,EMPLOYMENTS=1000,PROFILE_ROWS=120,FAMILY_ROWS=60;
const RENAMED_AT=70,SAVED_AT=30,REFUSED_AT=95,REFUSED_PHONE='0139999000';
type Tenant={base:Base;ctx:SessionContext;companies:string[]};
const code=(n:number)=>`SEC-SHAPE-${String(n).padStart(4,'0')}`;

async function build():Promise<Tenant>{
 const base=await seedBase();
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'Section shape company '||lpad(n::text,2,'0') from generate_series(1,${COMPANIES-1}::integer)n order by n returning id`;
 const all=[base.companyId,...others.map(r=>r.id)];
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email,phone) select ${base.tenantId}::uuid,'Section shape person '||lpad(n::text,4,'0'),'section-shape-'||n||'@fixture.invalid','0110000000' from generate_series(1,${EMPLOYMENTS}::integer)n returning id,full_name),
  ranked as(select id,row_number()over(order by full_name)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${all}::uuid[])[1+((n-1)%${COMPANIES}::integer)],'SEC-SHAPE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 return{base,ctx:await entitledCtx(base),companies:all};
}

function profileFile():ImportRecord[]{
 const rows:ImportRecord[]=Array.from({length:PROFILE_ROWS},(_,i)=>{
  const n=1+((i*37)%EMPLOYMENTS);
  return{employee_code:code(n),phone:`013${String(1000000+i)}`,home_phone:i%3===0?`03${String(2000000+i)}`:'',full_name:i%10===4?`Section renamed person ${i}`:''};
 });
 rows[10]={employee_code:'NO-SUCH-EMPLOYEE',phone:'0130000001',home_phone:'',full_name:''};
 rows[11]={...rows[12]};
 rows[13]={employee_code:'',phone:'0130000002',home_phone:'',full_name:''};
 // Already on file (every fixture person's phone is 0110000000): skipped by the plan.
 rows[14]={employee_code:code(901),phone:'0110000000',home_phone:'',full_name:''};
 rows[REFUSED_AT]={...rows[REFUSED_AT],phone:REFUSED_PHONE};
 return rows;
}
function familyFile():ImportRecord[]{
 const rows:ImportRecord[]=Array.from({length:FAMILY_ROWS},(_,i)=>({employee_code:code(1+((i*53)%EMPLOYMENTS)),full_name:`Section child ${i}`,relationship:'child',date_of_birth:`2016-0${1+(i%9)}-1${i%9}`}));
 // Three children for one employee in a row, and a second child of an earlier row's employee later on.
 rows[20]={...rows[20],employee_code:code(777)};rows[21]={...rows[21],employee_code:code(777)};rows[22]={...rows[22],employee_code:code(777)};
 rows[40]={...rows[40],employee_code:rows[5].employee_code};
 rows[30]={...rows[30],date_of_birth:'not-a-date'};
 return rows;
}
/** After the Profile file is prepared: another writer saves one row's phone first, and one row's Employee ID changes. */
const meanwhile=(t:Tenant,records:ImportRecord[])=>async()=>{
 await owner.client`update person set phone=${records[SAVED_AT].phone} where id=(select person_id from employment where tenant_id=${t.base.tenantId}::uuid and employee_code=${records[SAVED_AT].employee_code})`;
 await owner.client`update employment set employee_code=${records[RENAMED_AT].employee_code+'-OLD'} where tenant_id=${t.base.tenantId}::uuid and employee_code=${records[RENAMED_AT].employee_code}`;
};

async function runImport(t:Tenant,section:string,records:ImportRecord[],groups:boolean,beforeChunks?:()=>Promise<void>){
 if(groups)delete process.env.SECTION_IMPORT_GROUP_MAX;else process.env.SECTION_IMPORT_GROUP_MAX='1';
 const csv=[Object.keys(records[0]).join(','),...records.map(r=>Object.values(r).join(','))].join('\n');
 const {job}=await createSectionImportJob(t.ctx,{section,records,fileName:`${section}-equivalence.csv`,csv,operationKey:randomUUID()});
 const state=async()=>(await owner.client<{state:string;notified_at:Date|null}[]>`select state,notified_at from bulk_job where id=${job.id}::uuid`)[0];
 let prepared=false;
 for(let i=0;i<20000;i++){
  const s=await state();
  if(!prepared&&s.state==='running'){prepared=true;await beforeChunks?.();}
  if(['completed','failed','cancelled'].includes(s.state)&&s.notified_at)return job.id;
  if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('section import job did not finish');
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

function normalizer(t:Tenant,labels:Map<string,string>){
 labels.set(t.base.tenantId,'tenant');labels.set(t.ctx.userId!,'user');
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

async function snapshot(t:Tenant,jobId:string,sinceSequence:number,fileName:string){
 const tenant=t.base.tenantId;
 const labels=new Map<string,string>([[jobId,'job']]);
 for(const e of await owner.client<{id:string;person_id:string;employee_code:string}[]>`select id,person_id,employee_code from employment where tenant_id=${tenant}::uuid`){
  labels.set(e.id,`employment:${e.employee_code}`);labels.set(e.person_id,`person:${e.employee_code}`);
 }
 const n=normalizer(t,labels);
 const people=await owner.client<Record<string,unknown>[]>`select p.*,e.employee_code from person p join employment e on e.person_id=p.id where p.tenant_id=${tenant}::uuid order by e.employee_code`;
 const dependents=await owner.client<Record<string,unknown>[]>`select d.*,e.employee_code from employee_dependent d join employment e on e.person_id=d.person_id where d.tenant_id=${tenant}::uuid order by e.employee_code,d.full_name`;
 const events=await owner.client<Record<string,unknown>[]>`select * from domain_event where tenant_id=${tenant}::uuid and sequence>${sinceSequence} order by sequence`;
 const [job]=await owner.client<Record<string,unknown>[]>`select state,phase,counters,errors,error,result,steps_total,steps_done,source_name,input,plan from bulk_job where id=${jobId}::uuid`;
 const runs=await owner.client<Record<string,unknown>[]>`select * from employee_import_run where tenant_id=${tenant}::uuid and file_name=${fileName} order by created_at`;
 const view=await getSectionImportJob(t.ctx,jobId);
 return n({
  people:people.map(r=>omit(r,STAMPS)),dependents:dependents.map(r=>omit(r,STAMPS)),events:events.map(r=>omit(r,STAMPS)),
  job,runs:runs.map(r=>omit(r,STAMPS)),view:omit(view as unknown as Record<string,unknown>,['id','updatedAt','createdAt']),
 });
}
const lastSequence=async(t:Tenant)=>Number((await owner.client<{s:string|null}[]>`select max(sequence)::text as s from domain_event where tenant_id=${t.base.tenantId}::uuid`)[0].s??0);
const metricsOf=async(jobId:string)=>(await owner.client<{metrics:Record<string,number>}[]>`select metrics from bulk_job where id=${jobId}::uuid`)[0].metrics;

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 // A database refusal of one row's write while saving (both tenants identically).
 await owner.client.unsafe(`create or replace function public.section_set_fixture_refuse() returns trigger language plpgsql as $$ begin
  if new.phone='${REFUSED_PHONE}' then raise exception 'fixture refusal' using errcode='P0001'; end if; return new; end $$`);
 await owner.client.unsafe('create trigger section_set_fixture_refuse before update on person for each row execute function public.section_set_fixture_refuse()');
});
afterAll(async()=>{
 delete process.env.SECTION_IMPORT_GROUP_MAX;
 await owner.client.unsafe('drop trigger if exists section_set_fixture_refuse on person');
 await owner.client.unsafe('drop function if exists public.section_set_fixture_refuse()');
 await closeAll();
});

// Per-row Profile rows cost about 83 ms on the hosted runner (probe run 45490754369): about 10 s per row for the
// Profile file, 4 s for the Family file; the limit leaves about 3x headroom over both paths together (SCALE rule 15).
it('imports Profile and Family rows set-based exactly as the per-row path, at the shape of a 70-company group',async()=>{
 const a=await build(),b=await build();
 const [shape]=await owner.client<{companies:number;employments:number}[]>`select count(distinct company_id)::int as companies,count(*)::int as employments from employment where tenant_id=${b.base.tenantId}::uuid`;
 expect(shape).toEqual({companies:COMPANIES,employments:EMPLOYMENTS});

 const records=profileFile();
 const sinceA=await lastSequence(a),sinceB=await lastSequence(b);
 const perRow=await profile(()=>runImport(a,'profile',records,false,meanwhile(a,records)));
 const set=await profile(()=>runImport(b,'profile',records,true,meanwhile(b,records)));
 const left=await snapshot(a,perRow.result,sinceA,'profile-equivalence.csv'),right=await snapshot(b,set.result,sinceB,'profile-equivalence.csv');
 const perRowMetrics=await metricsOf(perRow.result),setMetrics=await metricsOf(set.result);

 // Independent of the comparison: the file exercised what it claims.
 const view=right.view as {state:string;result:{updated:number;skipped:number;failed:{rowNum:number;employeeCode:string;message:string}[]}};
 expect(view.state).toBe('completed');
 expect(view.result.failed.map(f=>f.rowNum).sort((x,y)=>x-y)).toEqual([RENAMED_AT+1,REFUSED_AT+1]);
 // Planned: 120 rows less the unknown, the duplicate pair's second row (and its first, both refused), the blank and
 // the already-on-file row; saving skipped one row and refused two.
 expect(view.result.updated).toBeGreaterThan(100);
 expect((right.events as {event_type:string}[]).filter(e=>e.event_type==='person.updated').length).toBeGreaterThan(100);
 expect(right).toEqual(left);
 expect(perRowMetrics.importGroups??0).toBe(0);
 expect(setMetrics.importGroups).toBeGreaterThan(1);
 expect(setMetrics.importSingles).toBeGreaterThan(0);

 const family=familyFile();
 const sinceA2=await lastSequence(a),sinceB2=await lastSequence(b);
 const perRowFamily=await profile(()=>runImport(a,'family',family,false));
 const setFamily=await profile(()=>runImport(b,'family',family,true));
 const left2=await snapshot(a,perRowFamily.result,sinceA2,'family-equivalence.csv'),right2=await snapshot(b,setFamily.result,sinceB2,'family-equivalence.csv');
 const familyView=right2.view as {state:string;result:{updated:number}};
 expect(familyView.state).toBe('completed');
 expect(familyView.result.updated).toBe(FAMILY_ROWS-1);
 expect((right2.dependents as {employee_code:string}[]).filter(d=>d.employee_code===code(777))).toHaveLength(3);
 expect(right2).toEqual(left2);
 const setFamilyMetrics=await metricsOf(setFamily.result);
 expect(setFamilyMetrics.importGroups).toBeGreaterThan(1);
 for(const t of [a,b])expect(await verifyTenantChain(t.ctx)).toMatchObject({valid:true,unchainedInsideChain:0});

 const split=(p:{ms:number;cpuMs:number;statements:number},rows:number)=>({wallMs:Math.round(p.ms),calcMs:Math.round(p.cpuMs),dbMs:Math.round(p.ms-p.cpuMs),
  msPerRow:Math.round(p.ms/rows*10)/10,statements:p.statements,statementsPerRow:Math.round(p.statements/rows*10)/10});
 console.info('SECTION_IMPORT_SET_EQUIVALENCE_DIAGNOSTIC',JSON.stringify({
  shape:{companies:COMPANIES,employments:EMPLOYMENTS,profileRows:PROFILE_ROWS,familyRows:FAMILY_ROWS},
  profile:{perRow:{...split(perRow,PROFILE_ROWS),metrics:perRowMetrics,top:perRow.top},set:{...split(set,PROFILE_ROWS),metrics:setMetrics,top:set.top}},
  family:{perRow:{...split(perRowFamily,FAMILY_ROWS),metrics:await metricsOf(perRowFamily.result)},set:{...split(setFamily,FAMILY_ROWS),metrics:setFamilyMetrics}},
 },null,1));
},240_000);
