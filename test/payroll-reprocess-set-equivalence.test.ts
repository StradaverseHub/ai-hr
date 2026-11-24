/**
 * ADR 0181 J2: the set-based selective reprocess (core/payroll-reprocess-job.ts groups, `reprocessEmployeeGroupTx`) is
 * equivalent to the per-employee path (`reprocessSelectedEmployees`, one `reprocessEmployeeTx` per employee) for every
 * pay item, tax and statutory output. Two tenants are built identically through the product owners at the shape of a
 * real group (SCALE rule 3: 70 companies, 1,000 employments). The run reprocessed holds 100 employees with TP3 openings
 * (the five money columns and Section C2 exemptions), income-tax corrections of April and May (ADR 0167), salary and
 * Pay Item changes after processing, two employees added after processing (the per-employee path's additions) and two
 * whose salary record was removed (a refused group pass that falls back to the per-employee transaction). Tenant A runs
 * the per-employee request path; tenant B runs the background job. Everything the reprocess writes is compared with
 * ids, hashes and timestamps replaced by stable labels: payslips (money, statutory breakdown, PCB metadata, version),
 * run totals, headcount and recalculation marks, per-employee result history, tax-basis replacement receipts, the job's
 * outcomes, counts and totals, and the per-employee outcome events.
 *
 * Known, intended difference (recorded in ADR 0181): the run-level audit rows of one engine pass, the status-history
 * row and the `payroll-batch.selective-reprocessed` event, are written once per group instead of once per employee. The
 * test proves they cover exactly the same employees. The Audit loop's inputs capture is taken once per JOB on both paths
 * (ADR 0181 J2, fixed cost): the test proves each path wrote exactly one, naming every employee the job reprocessed, and
 * that its hashes are the run's inputs and results as they stand after the job (an independent read of the same rows).
 *
 * The diagnostic line REPROCESS_SET_EQUIVALENCE_DIAGNOSTIC reports, for both paths, wall time, process CPU (the
 * calculation and the driver), the rest (database), application statements, and the job's per-chunk split from
 * bulk_job.metrics. Fictional fixtures only.
 */
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setPayrollBatchComponent} from '../core/pay-components';
import {setStatutoryProfileMY,setTp3ProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips,getReprocessJob,reprocessSelectedEmployees,resolveBatchCutOffWindow} from '../core/payroll';
import {runInputsTx} from '../core/payroll-audit/inputs';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {requestSelectiveReprocess,payrollReprocessJobHandler} from '../core/payroll-reprocess-job';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {client,withTenant,type Tx} from '../db/client';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const COMPANIES=70,EMPLOYMENTS=1000,PROCESSED=98,ADDED=2,RUN=PROCESSED+ADDED,SHAPE=EMPLOYMENTS-RUN;
const MISSING_SALARY=new Set([37,81]);
/** Phase timings on the log, so a slow hosted run shows where its time went. */
const phase=(label:string,started:number)=>console.info('REPROCESS_SET_EQUIVALENCE_PHASE',label,Math.round(performance.now()-started));
const tp3Money=(n:number)=>n%5===0,c2Opening=(n:number)=>n%7===0&&!tp3Money(n),travel=(n:number)=>n%5===1,raise=(n:number)=>n%2===0,travelChange=(n:number)=>n%10===1;
const nameOf=(n:number)=>`J2 equivalence person ${String(n).padStart(3,'0')}`;

type Tenant={base:Base;ctx:SessionContext;april:string;may:string;employees:Map<number,{employmentId:string;personId:string}>;travelId:string;companies:string[]};

async function build():Promise<Tenant>{
 const started=performance.now();
 const base=await seedBase();
 for(const module of ['payroll','typed_pay_components','multi_cycle_payroll'])await setModule(base.tenantId,module,'active');
 const ctx=await entitledCtx(base);
 const others=await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name) select ${base.tenantId}::uuid,'J2 shape company '||n from generate_series(1,${COMPANIES-1}::integer)n returning id`;
 const companies=[base.companyId,...others.map(row=>row.id)];
 // The rest of the group: people employed by the other 69 companies (not on this run), for the shape of every read.
 await owner.client`with people as(insert into person(tenant_id,full_name,primary_email) select ${base.tenantId}::uuid,'J2 shape person '||n,'j2-shape-'||n||'@fixture.invalid' from generate_series(1,${SHAPE}::integer)n returning id),ranked as(select id,row_number()over(order by id)::int as n from people)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select ${base.tenantId}::uuid,id,(${others.map(row=>row.id)}::uuid[])[1+((n-1)%${COMPANIES-1}::integer)],'J2-SHAPE-'||lpad(n::text,4,'0'),'2025-01-01'::date from ranked`;
 const [item]=await owner.db.insert(schema.payComponent).values({tenantId:base.tenantId,code:'TRV',name:'Fictional travel',kind:'allowance',displayCategory:'allowance',
  includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_NON-TAXABLE'}).returning();
 const employees=new Map<number,{employmentId:string;personId:string}>();
 const hire=async(n:number,hiredOn:string)=>{
  const e=await hireEmployee(ctx,{person:{fullName:nameOf(n),primaryEmail:`j2-${n}.${base.tenantId.slice(0,8)}@fixture.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn});
  await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:`900101011${String(n).padStart(3,'0')}`,taxCategory:1+n%3,numChildren:n%4});
  await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:2800+(n*37)%4200,monthlyAllowance:(n%4)*100,effectiveFrom:hiredOn});
  employees.set(n,{employmentId:e.employmentId,personId:e.personId});
 };
 for(let n=1;n<=PROCESSED;n++)await hire(n,'2026-01-01');
 phase('hired',started);
 // TP3 openings: the five money columns through the owner, and a Section C2 exemption opening for others.
 for(let n=1;n<=PROCESSED;n++)if(tp3Money(n))await setTp3ProfileMY(ctx,{personId:employees.get(n)!.personId,tp3Year:2026,tp3NetRemuneration:12000+n*10,tp3EpfClaimed:1320,tp3PcbPaid:300+n});
 const c2=[...employees].filter(([n])=>c2Opening(n)).map(([,e])=>e.personId);
 await owner.client`update employee_statutory_my set tp3_year=2026,tp3_exemption_used='{"PCB_TRA_BUSINESS":250}'::jsonb where tenant_id=${base.tenantId}::uuid and person_id=any(${c2}::uuid[])`;
 const run=async(period:string)=>{
  const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:period});
  for(const [n,e] of employees)if(travel(n))await setPayrollBatchComponent(ctx,{batchId,employmentId:e.employmentId,componentId:item.id,amount:300+n});
  await generatePayslips(ctx,{batchId});
  return batchId;
 };
 const april=await run('2026-04'),may=await run('2026-05');
 phase('processed April and May',started);
 // ADR 0167: the travel item becomes taxable; April and May are corrected for the employees who were paid it.
 await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TAXABLE'}).where(eq(schema.payComponent.id,item.id));
 const corrected=[...employees].filter(([n])=>travel(n)).map(([,e])=>e.employmentId);
 const preview=await previewTaxBasisRecalculation(ctx,{companyId:base.companyId,year:2026,upToMonth:5,employmentIds:corrected});
 expect(preview.eligibleCount).toBeGreaterThan(0);
 await confirmTaxBasisRecalculation(ctx,{previewId:preview.previewId,previewHash:preview.previewHash});
 phase('corrected',started);
 // Changes after processing that the reprocess picks up.
 for(const [n,e] of employees){
  if(raise(n))await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:3100+(n*37)%4200,monthlyAllowance:(n%4)*100+50,effectiveFrom:'2026-05-01'});
  if(travelChange(n))await setPayrollBatchComponent(ctx,{batchId:may,employmentId:e.employmentId,componentId:item.id,amount:650});
 }
 // A salary record removed after processing: the group pass refuses and these employees take the per-employee path.
 const removed=[...MISSING_SALARY].map(n=>employees.get(n)!.employmentId);
 await owner.client`update compensation set superseded_at=now() where tenant_id=${base.tenantId}::uuid and employment_id=any(${removed}::uuid[]) and superseded_at is null`;
 // Two people who joined during May after the run was processed: additions take the per-employee path.
 for(let n=PROCESSED+1;n<=RUN;n++)await hire(n,'2026-05-15');
 phase('built',started);
 return{base,ctx,april,may,employees,travelId:item.id,companies};
}

/** Every uuid becomes a stable label (employment, person, company, run, Pay Item, tenant, user) or its order of first
 * appearance; every 64-hex hash its order of first appearance; timestamps a constant. Equal structure, equal text. */
function normalizer(t:Tenant){
 const labels=new Map<string,string>([[t.base.tenantId,'tenant'],[t.april,'run:2026-04'],[t.may,'run:2026-05'],[t.travelId,'item:TRV'],[t.ctx.userId!,'user']]);
 t.companies.forEach((id,i)=>labels.set(id,`company:${i}`));
 for(const [n,e] of t.employees){labels.set(e.employmentId,`employment:${n}`);labels.set(e.personId,`person:${n}`);}
 return(value:unknown)=>{
  const seen=new Map<string,string>();
  const text=JSON.stringify(value,(_key,v)=>v instanceof Date?'ts':v)
   .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g,'ts')
   .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,id=>labels.get(id.toLowerCase())??(seen.get(id)??(seen.set(id,`id#${seen.size}`),seen.get(id)!)))
   .replace(/\b[0-9a-f]{64}\b/g,h=>seen.get(h)??(seen.set(h,`hash#${seen.size}`),seen.get(h)!));
  return JSON.parse(text);
 };
}

const omit=(row:Record<string,unknown>,keys:string[])=>Object.fromEntries(Object.entries(row).filter(([k])=>!keys.includes(k)));
async function snapshot(t:Tenant,jobId:string){
 const n=normalizer(t),tenant=t.base.tenantId;
 const byEmployment=new Map([...t.employees].map(([k,e])=>[e.employmentId,k]));
 const order=<T extends Record<string,unknown>>(rows:T[],key:(row:T)=>string)=>rows.sort((a,b)=>key(a).localeCompare(key(b)));
 const slips=await owner.client<Record<string,unknown>[]>`select * from payslip where tenant_id=${tenant}::uuid and batch_id=any(${[t.april,t.may]}::uuid[])`;
 const batches=await owner.client<Record<string,unknown>[]>`select id,pay_period,status,totals,employee_count,recalc_employment_ids,scope from payroll_batch where id=any(${[t.april,t.may]}::uuid[]) order by pay_period`;
 const history=await owner.client<Record<string,unknown>[]>`select employment_id,action,reason,version_before,version_after,before,after from payroll_employee_result_history where tenant_id=${tenant}::uuid and batch_id=${t.may}::uuid`;
 const replacements=await owner.client<Record<string,unknown>[]>`select * from payroll_tax_basis_replacement where tenant_id=${tenant}::uuid`;
 const revisions=await owner.client<Record<string,unknown>[]>`select * from payroll_tax_basis_revision where tenant_id=${tenant}::uuid`;
 const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,t.may),eq(schema.domainEvent.eventType,'payroll-batch.employee-reprocess-outcome')));
 const job=await getReprocessJob(t.ctx,jobId);
 const result=job?.result as {outcomes:Record<string,unknown>[]}&Record<string,unknown>;
 const runLabel=(id:unknown)=>id===t.april?'2026-04':id===t.may?'2026-05':'';
 const key=(row:Record<string,unknown>)=>String(byEmployment.get(String(row.employment_id??row.employmentId))).padStart(4,'0')+runLabel(row.batch_id);
 return n({
  status:job?.status,stopCode:job?.stopCode,
  payslips:order(slips.map(row=>({...omit(row,['id','created_at','updated_at']),employment_id:row.employment_id,batch_id:row.batch_id})),key),
  batches,
  history:order(history,key),
  replacements:order(replacements.map(row=>omit(row,['id','created_at'])),row=>JSON.stringify(n(row))),
  revisions:order(revisions.map(row=>omit(row,['created_at'])),row=>JSON.stringify(n(row))),
  outcomes:order((result?.outcomes??[]).map(o=>omit(o,['at'])),key),
  counts:omit(result??{},['outcomes','workerToken']),
  events:order(events.map(e=>omit(e.payload as Record<string,unknown>,['jobId'])),key),
 });
}
/** The run-level audit rows of a pass: one per employee (per-employee path) or one per group (set path). */
async function passAudit(t:Tenant){
 const status=await owner.client<{ids:string[]}[]>`select coalesce(array(select jsonb_array_elements_text(after->'reprocessedEmploymentIds')),'{}') as ids from payroll_status_history where batch_id=${t.may}::uuid and action='reprocess'`;
 const events=await owner.client<{ids:string[]}[]>`select coalesce(array(select jsonb_array_elements_text(payload->'employmentIds')),'{}') as ids from domain_event where aggregate_id=${t.may}::uuid and event_type='payroll-batch.selective-reprocessed'`;
 const captures=await owner.client<{n:number}[]>`select count(*)::int as n from domain_event where aggregate_id=${t.base.companyId}::uuid and event_type='payroll-audit.inputs-not-captured'`;
 const number=new Map([...t.employees].map(([n,e])=>[e.employmentId,n]));
 const ids=(rows:{ids:string[]}[])=>rows.flatMap(row=>row.ids.map(id=>number.get(id)??-1)).sort((x,y)=>x-y);
 return{statusRows:status.length,statusIds:ids(status),eventRows:events.length,eventIds:ids(events),captureMisses:captures[0].n};
}
/** The Audit loop's inputs captures the reprocess wrote for May (trigger `reprocessed`), with an independent read of the
 * run's inputs now: the same owner reads (core/payroll-audit/inputs.ts runInputsTx) through the tenant's own session. */
async function reprocessCaptures(t:Tenant){
 const rows=await owner.client<{content:Record<string,unknown>}[]>`select content from payroll_audit_capture where tenant_id=${t.base.tenantId}::uuid
  and source_key=${'inputs:'+t.may} and content->>'trigger'='reprocessed' order by seq`;
 const now=await withTenant(t.ctx,async tx=>{
  const window=(type:'attendance'|'overtime'|'leave'|'claim')=>resolveBatchCutOffWindow(tx,t.base.companyId,type,'2026-05');
  return runInputsTx(tx,{batchId:t.may,payPeriod:'2026-05',windows:{attendance:await window('attendance'),overtime:await window('overtime'),leave:await window('leave'),claim:await window('claim')}});
 });
 return{rows:rows.map(row=>row.content),now};
}
/** (b) evaluation, measurement only: the run's headcount by the pass's own read (the native payslip view, per-row row
 * security) beside cheaper candidate reads, each timed three times in the tenant's session (median). A read the session
 * may not make is reported as refused. */
async function headcountReads(t:Tenant){
 const candidates:Record<string,string>={
  nativeView:'select count(*)::int as n from public.payroll_history_native_payslip where batch_id=$1::uuid',
  nativeWriteView:'select count(*)::int as n from public.payroll_history_native_payslip_write where batch_id=$1::uuid',
  payslipTable:'select count(*)::int as n from public.payslip where batch_id=$1::uuid',
 };
 const out:Record<string,{n:number|null;ms:number|null;refused?:true}>={};
 await withTenant(t.ctx,async tx=>{
  for(const [name,text] of Object.entries(candidates)){
   const times:number[]=[];let n:number|null=null;
   try{
    for(let i=0;i<3;i++){
     const started=performance.now();
     const [row]=await tx.transaction(async savepoint=>(savepoint as unknown as Tx).execute<{n:number}>(sql.raw(text.replace('$1',`'${t.may}'`))));
     times.push(performance.now()-started);n=Number(row?.n??0);
    }
    out[name]={n,ms:Math.round(times.sort((x,y)=>x-y)[1])};
   }catch{out[name]={n:null,ms:null,refused:true};}
  }
 });
 return out;
}
async function drain(){
 for(let i=0;i<5000;i++){
  if(!await runBulkJobTick(owner.client,{handlers:[payrollReprocessJobHandler]})){
   const [row]=await owner.client<{n:number}[]>`select count(*)::int as n from bulk_job where kind='payroll_reprocess' and (state not in ('completed','failed','cancelled') or notified_at is null)`;
   if(!row.n)return;await new Promise(r=>setTimeout(r,20));
  }
 }
 throw new Error('reprocess job did not finish');
}
const cpuMs=(start:NodeJS.CpuUsage)=>{const c=process.cpuUsage(start);return Math.round((c.user+c.system)/1000);};
/** Test-only statement profile of the application pool (client.options.debug, as test/helpers/statement-observer.ts):
 * statements, transactions, and the time from each statement's send to the next one's (its execution plus the
 * application work after it), totalled by statement text. Text only: no parameter is kept or printed. */
async function profile<T>(work:()=>Promise<T>){
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const sent:{at:number;text:string}[]=[];
 options.debug=(_connection:number,text:string)=>{sent.push({at:performance.now(),text});};
 const started=performance.now();
 try{
  const result=await work();const ms=performance.now()-started,end=performance.now();
  const byText=new Map<string,{n:number;ms:number}>();
  sent.forEach((s,i)=>{const key=s.text.replace(/\s+/g,' ').trim().slice(0,150);const row=byText.get(key)??{n:0,ms:0};row.n++;row.ms+=(sent[i+1]?.at??end)-s.at;byText.set(key,row);});
  const bookkeeping=/^(begin|commit|rollback|savepoint|release|start transaction)\b/i;
  return{result,ms,statements:sent.filter(s=>!bookkeeping.test(s.text.trim())).length,
   transactions:sent.filter(s=>/^select set_config\('app\.tenant_id'/i.test(s.text.trim())).length,
   top:[...byText].sort((a,b)=>b[1].ms-a[1].ms).slice(0,15).map(([text,row])=>({ms:Math.round(row.ms),n:row.n,text}))};
 }finally{options.debug=previous;}
}

beforeAll(async()=>{await migrateTestDb();await resetDb();});
afterAll(closeAll);

// Measured budget: the first hosted run's case duration is recorded in the PR; this limit is about 3x that run.
it('recalculates a 100-employee run set-based exactly as the per-employee path, at the shape of a 70-company group',async()=>{
 const a=await build(),b=await build();
 const [shape]=await owner.client<{companies:number;employments:number}[]>`select count(distinct company_id)::int as companies,count(*)::int as employments from employment where tenant_id=${b.base.tenantId}::uuid`;
 expect(shape).toEqual({companies:COMPANIES,employments:EMPLOYMENTS});
 const selection=(t:Tenant)=>[...t.employees.values()].map(e=>e.employmentId);
 expect(selection(a)).toHaveLength(RUN);
 // Both tenants hold corrections of April and May before the reprocess.
 const corrections=async(t:Tenant)=>(await owner.client<{period:string;n:number}[]>`select period,count(*)::int as n from payroll_tax_basis_revision where tenant_id=${t.base.tenantId}::uuid group by period order by period`);
 expect(await corrections(a)).toEqual(await corrections(b));
 expect((await corrections(b)).map(row=>row.period)).toEqual(['2026-04','2026-05']);

 const perCpu=process.cpuUsage();
 const perEmployee=await profile(()=>reprocessSelectedEmployees(a.ctx,{batchId:a.may,employmentIds:selection(a),reason:'J2 equivalence'}));
 const perEmployeeCpu=cpuMs(perCpu);
 phase('per-employee path',performance.now()-perEmployee.ms);
 expect(perEmployee.result.status).toBe('completed');

 const setCpu=process.cpuUsage();
 const set=await profile(async()=>{
  const requested=await requestSelectiveReprocess(b.ctx,{batchId:b.may,employmentIds:selection(b),reason:'J2 equivalence'});
  await drain();
  return requested;
 });
 const setCpuMs=cpuMs(setCpu);
 phase('set path',performance.now()-set.ms);
 const [job]=await owner.client<{metrics:Record<string,number>;counters:Record<string,number>;steps_total:number;steps_done:number}[]>`select metrics,counters,steps_total,steps_done from bulk_job where kind='payroll_reprocess' and tenant_id=${b.base.tenantId}::uuid`;

 const split=(wall:number,cpu:number)=>({wallMs:Math.round(wall),cpuMs:cpu,dbMs:Math.max(0,Math.round(wall-cpu))});
 console.info('REPROCESS_SET_EQUIVALENCE_DIAGNOSTIC',JSON.stringify({
  shape:{companies:COMPANIES,employments:EMPLOYMENTS,run:RUN},
  headcountReads:await headcountReads(b),
  perEmployee:{...split(perEmployee.ms,perEmployeeCpu),statements:perEmployee.statements,transactions:perEmployee.transactions,
   msPerEmployee:Math.round(perEmployee.ms/RUN),statementsPerEmployee:Math.round(perEmployee.statements/RUN),top:perEmployee.top},
  set:{...split(set.ms,setCpuMs),statements:set.statements,transactions:set.transactions,
   msPerEmployee:Math.round(set.ms/RUN),statementsPerEmployee:Math.round(set.statements/RUN),metrics:job.metrics,top:set.top},
 },null,1));
 const left=await snapshot(a,perEmployee.result.jobId),right=await snapshot(b,set.result.jobId);
 // The fixture exercised what it claims: reprocessed, recalculated tax sources, TP3 openings, additions and refusals.
 const outcomes=right.outcomes as {employmentId:string;status:string;classification?:string;taxBasisRecalculated?:boolean}[];
 expect(outcomes).toHaveLength(RUN);
 expect(outcomes.filter(o=>o.classification==='added')).toHaveLength(ADDED);
 expect(outcomes.filter(o=>o.status==='validation_failed').map(o=>o.employmentId).sort()).toEqual([...MISSING_SALARY].map(n=>`employment:${n}`).sort());
 expect(outcomes.filter(o=>o.taxBasisRecalculated).length).toBeGreaterThan(0);
 expect(outcomes.filter(o=>o.status==='reprocessed').length).toBe(RUN-MISSING_SALARY.size);
 // Equivalence: every payslip figure, statutory breakdown, tax metadata and version, the run, the history, the tax
 // receipts and corrections, the job's outcomes and counts, and the outcome events.
 expect(right).toEqual(left);

 // The set path really ran in groups, and the refused group fell back to the per-employee transaction.
 expect(job.steps_done).toBe(RUN);
 expect(job.metrics.reprocessGroups).toBeGreaterThan(0);
 expect(job.metrics.reprocessGroupEmployees+job.metrics.reprocessSingles).toBe(RUN);
 expect(job.metrics.reprocessSingles).toBeGreaterThanOrEqual(ADDED+MISSING_SALARY.size);
 // A refused pass is narrowed to the employee it names, so the per-employee transactions grow with the refusals and
 // additions, never with the group size (before narrowing, a refused group sent all its employees: 58 of 100). Where the
 // random ids place them decides the exact count; at most: each addition and named refusal itself, per refusal the
 // group's first employee and a one-employee group before the named one, one employee left alone before each addition
 // or named refusal, and the last employee.
 expect(job.metrics.reprocessSingles).toBeLessThanOrEqual(ADDED+MISSING_SALARY.size+2*MISSING_SALARY.size+(ADDED+MISSING_SALARY.size)+1);
 // The run-level audit rows cover the same employees: one per employee before, one per group now.
 const auditA=await passAudit(a),auditB=await passAudit(b);
 expect(auditB.statusIds).toEqual(auditA.statusIds);
 expect(auditB.eventIds).toEqual(auditA.eventIds);
 expect(auditA.statusRows).toBe(RUN-MISSING_SALARY.size);
 expect(auditB.statusRows).toBe(job.metrics.reprocessGroups+job.metrics.reprocessSingles-MISSING_SALARY.size);
 expect(auditB.captureMisses).toBe(auditA.captureMisses);
 expect(auditB.captureMisses).toBe(0);
 // The Audit loop's inputs capture: once per job on both paths, naming every employee the job reprocessed, and holding
 // the run's inputs and results as they stand after the job (nothing changed them since).
 const reprocessed=(right.outcomes as {employmentId:string;status:string}[]).filter(o=>o.status==='reprocessed').map(o=>o.employmentId).sort();
 for(const [t,label] of [[a,'per-employee'],[b,'set']] as const){
  const {rows,now}=await reprocessCaptures(t);
  expect(rows,label).toHaveLength(1);
  const [capture]=rows as (Record<string,unknown>&{reprocessedEmploymentIds:string[];components:Record<string,unknown>;results:unknown;employments:number})[];
  expect(normalizer(t)(capture.reprocessedEmploymentIds).sort(),label).toEqual(reprocessed);
  expect(capture,label).toMatchObject({basis:'processed',trigger:'reprocessed',processedBy:t.ctx.userId,employments:RUN,
   components:now.components,results:now.results,windows:now.windows});
  expect(now.results.rows,label).toBe(RUN);
 }
 const [capturedA]=(await reprocessCaptures(a)).rows,[capturedB]=(await reprocessCaptures(b)).rows;
 const shapeOf=(c:Record<string,unknown>)=>({...c,components:Object.fromEntries(Object.entries(c.components as Record<string,{rows:number}>).map(([k,v])=>[k,v.rows])),
  results:(c.results as {rows:number}).rows});
 expect(normalizer(b)(shapeOf(capturedB))).toEqual(normalizer(a)(shapeOf(capturedA)));


},1_150_000);
