/**
 * ADR 0181 J2: payroll processing in set-based groups (core/payroll-processing-job.ts groups, one engine pass per group;
 * the engine's group tax-scheme resolution and multi-row payslip insert in core/payroll.ts) is equivalent to the
 * per-employee path it replaces, for every pay item, tax and statutory output. Two tenants are built identically
 * through the product owners at the shape of a real group (SCALE rule 3: 70 companies, 1,000 employments). The run
 * holds 120 employees: TP3 openings (the five money columns and Section C2 exemption openings), a taxable and a
 * non-taxable Pay Item on the run, salary changes from May, daily-rated employees (the working-day and holiday reads),
 * a person with no income tax (tax circumstance None), and a May joiner. April and May are processed by the background
 * job in both tenants:
 *  - tenant A, the per-employee path as it was: one step of four employees per engine pass (PAYROLL_PROCESS_GROUP_MAX=1)
 *    and each employee's own reads and writes in the pass (PAYROLL_PASS_SET_READS=off: one tax-scheme resolution, the
 *    holiday statements and one payslip insert per employee);
 *  - tenant B, the defaults: set-based groups, group tax resolution, the pass's holiday windows and multi-row inserts.
 * Everything processing writes is compared with ids, hashes and timestamps replaced by stable labels: payslips (money,
 * statutory breakdown, PCB metadata, days, version), run totals, headcount, status and marks, payroll inputs, the runs'
 * audit events and status history, and the job's result and counters. A June run whose processing loses an employee's
 * salary record after it was planned refuses identically in both tenants (same error, same discard): the group path's
 * refused pass falls back to one step per pass. The group tax-scheme resolver is also compared employee by employee with the single
 * resolver, refusals included.
 *
 * The diagnostic line PROCESS_SET_EQUIVALENCE_DIAGNOSTIC reports, for both paths, wall time, process CPU (calculation
 * and driver), the rest (database), application statements per employee and the job's per-chunk split from
 * bulk_job.metrics. Fictional fixtures only.
 */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {client,withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setPayrollBatchComponent} from '../core/pay-components';
import {setStatutoryProfileMY,setTp3ProfileMY} from '../localization/my/statutory';
import {resolveTaxSelectionMY,resolveTaxSelectionsMY} from '../localization/my/tax-selection';
import {createBatch} from '../core/payroll';
import {payrollProcessJobHandler,requestPayrollProcessing} from '../core/payroll-processing-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000,RUN=120,JOINER=RUN,SHAPE=EMPLOYMENTS-RUN;
const DAILY=new Set([11,57,103]),NO_TAX=new Set([23,88]),MISSING_IN_JUNE=61;
const phase=(label:string,started:number)=>console.info('PROCESS_SET_EQUIVALENCE_PHASE',label,Math.round(performance.now()-started));
const tp3Money=(n:number)=>n%5===0,c2Opening=(n:number)=>n%7===0&&!tp3Money(n),travel=(n:number)=>n%5===1,meal=(n:number)=>n%6===2,raise=(n:number)=>n%2===0;
const nameOf=(n:number)=>`J2 processing person ${String(n).padStart(3,'0')}`;

type Tenant={base:Base;ctx:SessionContext;runs:Map<string,string>;employees:Map<number,{employmentId:string;personId:string}>;items:Map<string,string>;companies:string[]};

async function build():Promise<Tenant>{
 const started=performance.now();
 const base=await seedBase();
 for(const module of ['payroll','typed_pay_components'])await setModule(base.tenantId,module,'active');
 const ctx=await entitledCtx(base);
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'J2 processing shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 const companies=[base.companyId,...others.map(row=>row.id)];
 // The rest of the group: people employed by the other 69 companies (not on these runs), for the shape of every read.
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'J2 processing shape person '||n,'j2p-shape-'||n||'@fixture.invalid' from generate_series(1,${SHAPE}::integer)n returning id),ranked as(select id,row_number()over(order by id)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${others.map(row=>row.id)}::uuid[])[1+((n-1)%${COMPANIES-1}::integer)],'J2P-SHAPE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 const items=new Map<string,string>();
 const [trv]=await owner.db.insert(schema.payComponent).values({tenantId:base.tenantId,code:'TRV',name:'Fictional travel',kind:'allowance',displayCategory:'allowance',
  includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_NON-TAXABLE'}).returning();
 const [mea]=await owner.db.insert(schema.payComponent).values({tenantId:base.tenantId,code:'MEA',name:'Fictional meal',kind:'allowance',displayCategory:'allowance',
  includedInPcb:true,includedInEpf:true,includedInSocsoEis:true,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'}).returning();
 items.set('TRV',trv.id);items.set('MEA',mea.id);
 const employees=new Map<number,{employmentId:string;personId:string}>();
 for(let n=1;n<=RUN;n++){
  const hiredOn=n===JOINER?'2026-05-12':'2026-01-01';
  const e=await hireEmployee(ctx,{person:{fullName:nameOf(n),primaryEmail:`j2p-${n}.${base.tenantId.slice(0,8)}@fixture.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn});
  await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:`910202022${String(n).padStart(3,'0')}`,numChildren:n%4,
   ...(NO_TAX.has(n)?{taxCircumstance:'none'}:{taxCategory:1+n%3})});
  await setCompensation(ctx,DAILY.has(n)
   ?{employmentId:e.employmentId,basicSalary:3900,monthlyAllowance:0,payMode:'daily',rateAmount:150+n,effectiveFrom:hiredOn}
   :{employmentId:e.employmentId,basicSalary:2600+(n*41)%4600,monthlyAllowance:(n%4)*100,effectiveFrom:hiredOn});
  employees.set(n,{employmentId:e.employmentId,personId:e.personId});
 }
 phase('hired',started);
 for(const [n,e] of employees)if(tp3Money(n))await setTp3ProfileMY(ctx,{personId:e.personId,tp3Year:2026,tp3NetRemuneration:11000+n*10,tp3EpfClaimed:1210,tp3PcbPaid:250+n});
 const c2=[...employees].filter(([n])=>c2Opening(n)).map(([,e])=>e.personId);
 await owner.client`update employee_statutory_my set tp3_year=2026,tp3_exemption_used='{"PCB_TRA_BUSINESS":250}'::jsonb where tenant_id=${base.tenantId}::uuid and person_id=any(${c2}::uuid[])`;
 // Salary changes that take effect in May.
 for(const [n,e] of employees)if(raise(n)&&!DAILY.has(n)&&n!==JOINER)await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:3000+(n*41)%4600,monthlyAllowance:(n%4)*100+50,effectiveFrom:'2026-05-01'});
 phase('built',started);
 return{base,ctx,runs:new Map(),employees,items,companies};
}

/** A draft run of `period` with the run's Pay Items keyed, the shape the job then processes. */
async function draft(t:Tenant,period:string){
 const {batchId}=await createBatch(t.ctx,{companyId:t.base.companyId,payPeriod:period});
 t.runs.set(period,batchId);
 for(const [n,e] of t.employees){
  if(n===JOINER&&period<'2026-05')continue;
  if(travel(n))await setPayrollBatchComponent(t.ctx,{batchId,employmentId:e.employmentId,componentId:t.items.get('TRV')!,amount:300+n});
  if(meal(n))await setPayrollBatchComponent(t.ctx,{batchId,employmentId:e.employmentId,componentId:t.items.get('MEA')!,amount:120+n%7});
 }
 return batchId;
}

const tick=()=>runBulkJobTick(owner.client,{handlers:[payrollProcessJobHandler]});
async function drain(){
 for(let i=0;i<20000;i++){
  if(!await tick()){
   const [row]=await owner.client<{n:number}[]>`select count(*)::int as n from bulk_job where kind='payroll_process' and (state not in ('completed','failed','cancelled') or notified_at is null)`;
   if(!row.n)return;await new Promise(r=>setTimeout(r,20));
  }
 }
 throw new Error('payroll processing job did not finish');
}
/** Tick until the job has planned its steps (prepare committed) and nothing more. */
async function untilPlanned(jobId:string){
 for(let i=0;i<2000;i++){
  const [row]=await owner.client<{state:string}[]>`select state from bulk_job where id=${jobId}::uuid`;
  if(row.state==='running')return;
  if(!await tick())await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('payroll processing job was not planned');
}
type Mode='per-employee'|'set';
/** Run `work` on the per-employee path as it was, or on the defaults. */
async function onPath<T>(mode:Mode,work:()=>Promise<T>):Promise<T>{
 if(mode==='per-employee'){process.env.PAYROLL_PROCESS_GROUP_MAX='1';process.env.PAYROLL_PASS_SET_READS='off';}
 try{return await work();}
 finally{delete process.env.PAYROLL_PROCESS_GROUP_MAX;delete process.env.PAYROLL_PASS_SET_READS;}
}
const cpuMs=(start:NodeJS.CpuUsage)=>{const c=process.cpuUsage(start);return Math.round((c.user+c.system)/1000);};
/** Test-only statement profile of the application pool (client.options.debug, as test/helpers/statement-observer.ts).
 * Text only: no parameter is kept or printed. */
async function profile<T>(work:()=>Promise<T>){
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const sent:{at:number;text:string}[]=[];
 options.debug=(_connection:number,text:string)=>{sent.push({at:performance.now(),text});};
 const started=performance.now(),cpu=process.cpuUsage();
 try{
  const result=await work();const ms=performance.now()-started,end=performance.now();
  const byText=new Map<string,{n:number;ms:number}>();
  sent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,150);const row=byText.get(key)??{n:0,ms:0};row.n++;row.ms+=(sent[i+1]?.at??end)-s.at;byText.set(key,row);});
  const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
  return{result,ms,cpuMs:cpuMs(cpu),statements:sent.filter(s=>!bookkeeping.test(s.text.trim())).length,
   top:[...byText].sort((a,b)=>b[1].n-a[1].n).slice(0,12).map(([text,row])=>({n:row.n,ms:Math.round(row.ms),text}))};
 }finally{options.debug=previous;}
}
async function processRun(t:Tenant,mode:Mode,period:string){
 const batchId=t.runs.get(period)!;
 return onPath(mode,()=>profile(async()=>{const {jobId}=await requestPayrollProcessing(t.ctx,{batchId});await drain();return jobId;}));
}

/** Every uuid becomes a stable label or 'id'; every 64-hex hash 'hash'; timestamps 'ts'. Equal structure, equal text. */
function normalizer(t:Tenant){
 const labels=new Map<string,string>([[t.base.tenantId,'tenant'],[t.ctx.userId!,'user']]);
 for(const [period,id] of t.runs)labels.set(id,`run:${period}`);
 for(const [code,id] of t.items)labels.set(id,`item:${code}`);
 t.companies.forEach((id,i)=>labels.set(id,`company:${i}`));
 for(const [n,e] of t.employees){labels.set(e.employmentId,`employment:${n}`);labels.set(e.personId,`person:${n}`);}
 return(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,v)=>v instanceof Date?'ts':v)
  .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:\d{2})?)?/g,'ts')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>labels.get(id.toLowerCase())??'id')
  .replace(/\b[0-9a-f]{64}\b/g,'hash'));
}
const omit=(row:Record<string,unknown>,keys:string[])=>Object.fromEntries(Object.entries(row).filter(([k])=>!keys.includes(k)));
/** Kernel bookkeeping keys on events and results: the job's own id and its attribution. */
const JOB_KEYS=['jobId','processingJobId','bulkJob'];
const stripJob=(value:unknown):unknown=>Array.isArray(value)?value.map(stripJob):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([k])=>!JOB_KEYS.includes(k)).map(([k,v])=>[k,stripJob(v)])):value;
async function snapshot(t:Tenant,periods:string[]){
 const n=normalizer(t),tenant=t.base.tenantId,ids=periods.map(p=>t.runs.get(p)!);
 const sorted=<T,>(rows:T[])=>rows.map(row=>n(row)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const slips=await owner.client<Record<string,unknown>[]>`select * from payslip where tenant_id=${tenant}::uuid and batch_id=any(${ids}::uuid[])`;
 const batches=await owner.client<Record<string,unknown>[]>`select pay_period,status,totals,employee_count,needs_recalc_at,recalc_employment_ids,scope,processing_job_id is null as unleased from payroll_batch where id=any(${ids}::uuid[]) order by pay_period`;
 const inputs=await owner.client<Record<string,unknown>[]>`select * from payroll_input where tenant_id=${tenant}::uuid and batch_id=any(${ids}::uuid[])`;
 const components=await owner.client<Record<string,unknown>[]>`select * from payroll_batch_component where tenant_id=${tenant}::uuid and batch_id=any(${ids}::uuid[])`;
 const history=await owner.client<Record<string,unknown>[]>`select action,before,after from payroll_status_history where batch_id=any(${ids}::uuid[])`;
 const events=await owner.client<Record<string,unknown>[]>`select event_type,aggregate_type,aggregate_id,subject_employment_id,actor_type,payload from domain_event
  where tenant_id=${tenant}::uuid and (aggregate_id=any(${ids}::uuid[]) or payload->>'batchId'=any(${ids}::text[])) and event_type not like 'bulk-job.%'`;
 const jobs=await owner.client<Record<string,unknown>[]>`select state,error,result,counters,steps_total from bulk_job where tenant_id=${tenant}::uuid and kind='payroll_process' and coalesce(plan->>'batchId',input->>'batchId')=any(${ids}::text[])`;
 return{
  payslips:sorted(slips.map(row=>omit(row,['id','created_at','updated_at']))),
  batches:batches.map(row=>n(row)),
  inputs:sorted(inputs.map(row=>omit(row,['id','created_at','updated_at']))),
  components:sorted(components.map(row=>omit(row,['id','created_at','updated_at']))),
  history:sorted(history),
  events:sorted(events.map(row=>({...row,payload:stripJob(row.payload)}))),
  jobs:sorted(jobs.map(row=>({...row,steps_total:undefined,result:stripJob(row.result),counters:row.counters}))),
 };
}

beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(closeAll);

// Measured budget: the first hosted run's case duration is recorded in the PR; this limit is about 3x that run.
it('processes a 120-employee run in set-based groups exactly as the per-employee path, at the shape of a 70-company group',async()=>{
 const a=await build(),b=await build();
 const [shape]=await owner.client<{companies:number;employments:number}[]>`select count(distinct company_id)::int as companies,count(*)::int as employments from employment where tenant_id=${b.base.tenantId}::uuid`;
 expect(shape).toEqual({companies:COMPANIES,employments:EMPLOYMENTS});

 const timing:Record<string,unknown>={};
 for(const period of ['2026-04','2026-05']){
  await draft(a,period);await draft(b,period);
  const per=await processRun(a,'per-employee',period);
  phase(`per-employee ${period}`,performance.now()-per.ms);
  const set=await processRun(b,'set',period);
  phase(`set ${period}`,performance.now()-set.ms);
  const metrics=async(jobId:string)=>(await owner.client<{metrics:Record<string,number>;state:string;error:string|null}[]>`select metrics,state,error from bulk_job where id=${jobId}::uuid`)[0];
  const perJob=await metrics(per.result),setJob=await metrics(set.result);
  expect(perJob).toMatchObject({state:'completed',error:null});
  expect(setJob).toMatchObject({state:'completed',error:null});
  const paid=period==='2026-04'?RUN-1:RUN;
  const split=(p:typeof per,job:typeof perJob)=>({wallMs:Math.round(p.ms),cpuMs:p.cpuMs,dbMs:Math.max(0,Math.round(p.ms-p.cpuMs)),statements:p.statements,
   msPerEmployee:+(p.ms/paid).toFixed(1),statementsPerEmployee:+(p.statements/paid).toFixed(1),metrics:job.metrics,top:p.top});
  timing[period]={perEmployee:split(per,perJob),set:split(set,setJob)};
  // The set path really grouped: no group refused, every employee in a pass, and far fewer passes than steps. A
  // one-step pass is only the run's last step left alone (the group size follows the measured passes, so where the
  // last group ends depends on the host's timing).
  expect(setJob.metrics.processRefusedGroups??0).toBe(0);
  expect(setJob.metrics.processSingles??0).toBeLessThanOrEqual(1);
  expect(setJob.metrics.processGroupEmployees+(setJob.metrics.processSingleEmployees??0)).toBe(paid);
  expect(setJob.metrics.processGroupEmployees).toBeGreaterThan(paid-4);
  expect(setJob.metrics.processGroups+(setJob.metrics.processSingles??0)).toBeLessThan(Math.ceil(paid/4)/2);
  expect(perJob.metrics.processGroups??0).toBe(0);
  expect(perJob.metrics.processSingleEmployees).toBe(paid);
  // Per-employee statements fall: the group path sends fewer statements per employee than the per-employee path.
  expect(set.statements).toBeLessThan(per.statements);
 }
 console.info('PROCESS_SET_EQUIVALENCE_DIAGNOSTIC',JSON.stringify({shape:{companies:COMPANIES,employments:EMPLOYMENTS,run:RUN},timing},null,1));

 const left=await snapshot(a,['2026-04','2026-05']),right=await snapshot(b,['2026-04','2026-05']);
 // The fixture exercised what it claims: every employee paid each month (the joiner from May), PCB charged and not
 // charged, the daily rate and the TP3 openings on the payslips.
 const slips=right.payslips as {employment_id:string;batch_id:string;statutory:{pcb?:number;pcbMeta?:Record<string,unknown>}}[];
 expect(slips.filter(s=>s.batch_id==='run:2026-04')).toHaveLength(RUN-1);
 expect(slips.filter(s=>s.batch_id==='run:2026-05')).toHaveLength(RUN);
 expect(slips.filter(s=>Number(s.statutory.pcb)>0).length).toBeGreaterThan(10);
 for(const n of NO_TAX)expect(slips.filter(s=>s.employment_id===`employment:${n}`).every(s=>!Number(s.statutory.pcb))).toBe(true);
 // Equivalence: every payslip figure, statutory breakdown, tax metadata and day count, the runs, inputs and Pay
 // Items, the audit events and status history, and the jobs' results and counters.
 expect(right.batches).toEqual(left.batches);
 expect(right.payslips).toEqual(left.payslips);
 expect(right).toEqual(left);

 // June: an employee's salary record removed after the run was planned. Both paths refuse with the same error and
 // discard the run identically (the group path's refused pass falls back to one step per pass).
 const june=async(t:Tenant,mode:Mode)=>{
  const batchId=await draft(t,'2026-06');
  return onPath(mode,async()=>{
   const {jobId}=await requestPayrollProcessing(t.ctx,{batchId});
   await untilPlanned(jobId);
   await owner.client`update compensation set superseded_at=now() where tenant_id=${t.base.tenantId}::uuid and employment_id=${t.employees.get(MISSING_IN_JUNE)!.employmentId}::uuid and superseded_at is null`;
   await drain();
   const [job]=await owner.client<{state:string;error:string|null;metrics:Record<string,number>}[]>`select state,error,metrics from bulk_job where id=${jobId}::uuid`;
   return job;
  });
 };
 const juneA=await june(a,'per-employee'),juneB=await june(b,'set');
 expect(juneA.state).toBe('failed');
 expect(juneB.state).toBe('failed');
 expect(normalizer(b)(juneB.error)).toEqual(normalizer(a)(juneA.error));
 expect(await snapshot(b,['2026-06'])).toEqual(await snapshot(a,['2026-06']));
},1_150_000);

it('resolves a group of tax schemes exactly as one call per employee, refusals included',async()=>{
 const t=await (async()=>{
  const base=await seedBase();
  for(const module of ['payroll'])await setModule(base.tenantId,module,'active');
  return{base,ctx:await entitledCtx(base)};
 })();
 const hired:{employmentId:string;personId:string;n:number}[]=[];
 for(let n=1;n<=8;n++){
  const e=await hireEmployee(t.ctx,{person:{fullName:`J2 scheme person ${n}`,primaryEmail:`j2s-${n}.${t.base.tenantId.slice(0,8)}@fixture.invalid`},companyId:t.base.companyId,departmentId:t.base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  await setStatutoryProfileMY(t.ctx,{personId:e.personId,icNumber:`920303033${String(n).padStart(3,'0')}`,...(n===2?{taxCircumstance:'none'}:{taxCategory:1+n%3})});
  hired.push({...e,n});
 }
 const id=(n:number)=>hired.find(h=>h.n===n)!.employmentId;
 // Refusals: a selection awaiting confirmation, a stale applicability epoch, a C-suite scheme for a citizen; an
 // other scheme, a non-resident legacy label and an employment that is not there.
 await owner.client`update employment_tax_selection_my set transition_state='confirmation_required',version=version+1,updated_at=now() where employment_id=${id(3)}::uuid`;
 await owner.client`update employee_statutory_my set tax_applicability_epoch=tax_applicability_epoch+1 where person_id=${hired.find(h=>h.n===4)!.personId}::uuid`;
 await owner.client`update employment_tax_selection_my set scheme='c_suite',version=version+1,updated_at=now() where employment_id=${id(5)}::uuid`;
 await owner.client`update employment_tax_selection_my set scheme='knowledge_worker',version=version+1,updated_at=now() where employment_id=${id(6)}::uuid`;
 const employees=[...hired.map(h=>({employmentId:h.employmentId,legacyScheme:h.n===8?'non_resident':null,resident:h.n!==8,epfCitizenship:'citizen'})),
  {employmentId:'00000000-0000-4000-8000-000000000001',legacyScheme:null,resident:true,epfCitizenship:null}];
 const outcome=(value:unknown,error:unknown)=>error?{error:(error as {code?:string}).code??String(error),details:(error as {details?:unknown}).details??null}:{value};
 for(const period of ['2026-05','2026-13']){
  const single=await withTenant(t.ctx,async tx=>{
   const out:unknown[]=[];
   for(const e of employees){
    try{out.push(outcome(await resolveTaxSelectionMY(tx,{tenantId:t.base.tenantId,companyId:t.base.companyId,payPeriod:period,...e}),null));}
    catch(error){out.push(outcome(null,error));}
   }
   return out;
  });
  const group=await withTenant(t.ctx,async tx=>{
   const map=await resolveTaxSelectionsMY(tx,{tenantId:t.base.tenantId,companyId:t.base.companyId,payPeriod:period,employees});
   return employees.map(e=>{const o=map.get(e.employmentId)!;return o.ok?outcome(o.value,null):outcome(null,o.error);});
  });
  expect(group).toEqual(single);
  if(period==='2026-05'){
   const codes=single.map(o=>(o as {error?:string}).error??'ok');
   // Every branch was reached: resolved, not applicable, each refusal, and an absent employment.
   expect(new Set(codes)).toEqual(new Set(['ok','confirmation_required','citizenship_unknown','not_found']));
   expect(single.filter(o=>(o as {value?:{scheme?:string}}).value?.scheme==='none')).toHaveLength(1);
  }
 }
},300_000);
