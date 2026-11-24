/** ADR 0181 (write side): the Pay Item save's stale-run marker, and the set-based mark of several runs.
 *
 * Production 24 November 2026: a Pay Item save took up to 27.2 s inside the action. The marker read the native payslip
 * view (a security barrier) with a containment test that is not leakproof, so the view's per-row authority function
 * (app.payroll_history_native_artifact_allowed) ran for every payslip of every open run in the tenant, and each marked
 * run then cost three to four statements of its own (markBatchNeedsRecalc in a loop).
 *
 * This test runs the PREVIOUS marker (restated verbatim below, on the unchanged sequential markBatchNeedsRecalc) and the
 * new one side by side on a fictional group of 70 companies and 1,000 employments with processed, processing, closed
 * and draft runs, for several actors and pay items, each inside a transaction that is rolled back. Everything they
 * decide must be identical: the runs and employees returned, every run's stored mark, and every recalc-required event
 * (payload and order). It also proves the cost shape: the authority function now runs only for the slips that itemise
 * the code, and the statement count no longer grows with the number of runs marked. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {bootstrapTenantTx,tenantSessionIdentity,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {nativePayrollPayslip} from '../core/payroll-history-native-baseline';
import {markBatchNeedsRecalc,markBatchesNeedRecalcTx,markRunsAffectedByPayComponentTx,markRunsAffectedByEmploymentChangeTx} from '../core/payroll';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

class Rollback extends Error {}
let b:Base;let all:string[]=[];let employments:string[]=[];
const components:Record<string,string>={};
const actors:Record<string,SessionContext>={};

/** The marker as it was before ADR 0181's write-side change, verbatim (core/payroll.ts at 66f8c20fe). */
async function previousMarkRunsAffectedByPayComponentTx(tx:Tx,ctx:SessionContext,p:{componentId:string;code:string}){
 const open=await tx.select({id:s.payrollBatch.id}).from(s.payrollBatch).where(and(eq(s.payrollBatch.tenantId,ctx.tenantId),inArray(s.payrollBatch.status,['processed','processing'])));
 if(open.length===0)return [];
 const openIds=open.map(r=>r.id);
 const byBatch=new Map<string,Set<string>>();
 const add=(batchId:string,employmentId:string)=>{const set=byBatch.get(batchId)??new Set<string>();set.add(employmentId);byBatch.set(batchId,set);};
 const itemised=await tx.select({batchId:nativePayrollPayslip.batchId,employmentId:nativePayrollPayslip.employmentId}).from(nativePayrollPayslip)
  .where(and(inArray(nativePayrollPayslip.batchId,openIds),sql`${nativePayrollPayslip.statutory} -> 'componentLines' @> ${JSON.stringify([{code:p.code}])}::jsonb`));
 for(const r of itemised)add(r.batchId,r.employmentId);
 const recurring=await tx.select({batchId:nativePayrollPayslip.batchId,employmentId:nativePayrollPayslip.employmentId}).from(nativePayrollPayslip)
  .innerJoin(s.employmentPayComponent,eq(s.employmentPayComponent.employmentId,nativePayrollPayslip.employmentId))
  .where(and(inArray(nativePayrollPayslip.batchId,openIds),eq(s.employmentPayComponent.componentId,p.componentId),isNull(s.employmentPayComponent.supersededAt)));
 for(const r of recurring)add(r.batchId,r.employmentId);
 const oneOff=await tx.select({batchId:s.payrollIndividualTxn.batchId,employmentId:s.payrollIndividualTxn.employmentId}).from(s.payrollIndividualTxn)
  .where(and(inArray(s.payrollIndividualTxn.batchId,openIds),eq(s.payrollIndividualTxn.componentId,p.componentId)));
 for(const r of oneOff)if(r.batchId)add(r.batchId,r.employmentId);
 const marked:{batchId:string;employmentIds:string[]}[]=[];
 for(const[batchId,set]of byBatch){const employmentIds=[...set];await markBatchNeedsRecalc(tx,ctx,{batchId,employmentIds});marked.push({batchId,employmentIds});}
 return marked;
}

type Outcome={returned:unknown;batches:unknown;events:unknown;authorityCalls:number;statements:number;ms:number}|{error:string};
const sortedMarks=(rows:{batchId:string;employmentIds:string[]}[])=>[...rows].map(r=>({batchId:r.batchId,employmentIds:[...r.employmentIds].sort()})).sort((x,y)=>x.batchId.localeCompare(y.batchId));

/** Runs `work` as the application role with the actor's identity, then reads what it changed as the storage owner in
 * the same transaction (uncommitted rows are visible to it), and rolls everything back. */
async function observe(ctx:SessionContext,work:(tx:Tx)=>Promise<{batchId:string;employmentIds:string[]}[]|void>):Promise<Outcome>{
 let out:Outcome={error:'not run'};
 try{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`set local track_functions='all'`);
   await tx.execute(sql`set local role ai_hr_app`);
   const {grants,roleNames}=tenantSessionIdentity(ctx);
   await bootstrapTenantTx(tx,ctx,grants,roleNames);
   const client=(owner as unknown as {client:{options:{debug?:unknown}}}).client;
   let statements=0;const previous=client.options.debug;client.options.debug=()=>{statements++;};
   const started=performance.now();let returned;
   try{returned=await work(tx);}finally{client.options.debug=previous;}
   const ms=performance.now()-started;
   await tx.execute(sql`reset role`);
   const batches=await tx.execute(sql`select id::text,status::text,needs_recalc_at is not null as marked,
     (select coalesce(jsonb_agg(x order by x),'[]'::jsonb) from jsonb_array_elements_text(coalesce(recalc_employment_ids,'[]'::jsonb)) x) as ids
    from payroll_batch where tenant_id=${b.tenantId}::uuid order by id`);
   const events=await tx.execute(sql`select aggregate_id::text,actor_id::text,payload->'changeCategory' as category,
     (select jsonb_agg(x order by x) from jsonb_array_elements_text(payload->'employmentIds') x) as ids,
     (select jsonb_agg(x order by x) from jsonb_array_elements_text(payload->'addedEmploymentIds') x) as added
    from domain_event where tenant_id=${b.tenantId}::uuid and event_type='payroll-batch.recalc-required' and occurred_at=now() order by aggregate_id,sequence`);
   const [calls]=await tx.execute<{n:number}>(sql`select coalesce(sum(calls),0)::int as n from pg_stat_xact_user_functions where schemaname='app' and funcname='payroll_history_native_artifact_allowed'`);
   out={returned:returned?sortedMarks(returned):null,batches,events,authorityCalls:Number(calls?.n??0),statements,ms:Math.round(ms)};
   throw new Rollback();
  });
 }catch(e){if(!(e instanceof Rollback))out={error:(e as Error).message};}
 return out;
}
const decided=(o:Outcome)=>'error' in o?o:{returned:o.returned,batches:o.batches,events:o.events};

async function user(role:string,companyId:string|null):Promise<SessionContext>{
 const [u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`fixture_${randomUUID()}`,personId:null}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
 return {...adminCtx(b),userId:u.id,roles:[role],grants:[{role,companyId}]} as SessionContext;
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 const T=b.tenantId;
 // 70 fictional companies: the root, eight children and sixty-one grandchildren.
 const level1=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${T}::uuid,'Fictional R'||g||' Sdn Bhd',${b.companyId}::uuid from generate_series(1,8) g order by g returning id`).map(r=>r.id);
 const level2=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${T}::uuid,'Fictional R unit '||g||' Sdn Bhd',(${level1}::uuid[])[1+(g % 8)] from generate_series(1,61) g order by g returning id`).map(r=>r.id);
 all=[b.companyId,...level1,...level2];expect(all).toHaveLength(70);
 employments=(await owner.client<{id:string}[]>`with p as (insert into person(tenant_id,full_name,primary_email)
   select ${T}::uuid,'Fictional RM '||g,'rm-'||g||'@example.test' from generate_series(1,1000) g returning id),
  n as (select id,row_number() over (order by id) k from p)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select ${T}::uuid,n.id,(${all}::uuid[])[1+(n.k % 70)::int],'RM'||lpad(n.k::text,5,'0'),'2025-01-06' from n order by n.k returning id`).map(r=>r.id);
 expect(employments).toHaveLength(1000);
 for(const code of ['FXA','FXB','FXC']){
  const [c]=await owner.client<{id:string}[]>`insert into pay_component(tenant_id,code,name,kind) values(${T}::uuid,${code},${'Fictional '+code},'allowance') returning id`;
  components[code]=c.id;
 }
 // Runs: every company has a processed October run; ten have a processing November run; five a closed September run;
 // three a draft December run. Each run has its own period row.
 type Run={id:string;company:string;period:string;status:string};
 const runs:Run[]=[
  ...all.map(company=>({id:randomUUID(),company,period:'2026-10',status:'processed'})),
  ...all.slice(0,10).map(company=>({id:randomUUID(),company,period:'2026-11',status:'processing'})),
  ...all.slice(20,25).map(company=>({id:randomUUID(),company,period:'2026-09',status:'closed'})),
  ...all.slice(40,43).map(company=>({id:randomUUID(),company,period:'2026-12',status:'draft'})),
 ];
 await owner.client.begin(async tx=>{
  const periods=runs.map(()=>randomUUID());
  await tx`insert into pay_period(id,tenant_id,company_id,period,status)
   select p,${T}::uuid,c,per,'open' from unnest(${periods}::uuid[],${runs.map(r=>r.company)}::uuid[],${runs.map(r=>r.period)}::text[]) as x(p,c,per)`;
  // A processing run carries its background job's lease (payroll_batch_processing_lease); a fictional job id.
  await tx`insert into payroll_batch(id,tenant_id,company_id,pay_period,batch_date,status,employee_count,totals,pay_period_id,closed_at,processing_job_id,processing_started_at)
   select r,${T}::uuid,c,per,(per||'-25')::date,st::payroll_status,0,'{}'::jsonb,pp,case when st='closed' then now() end,
    case when st='processing' then gen_random_uuid() end,case when st='processing' then now() end
   from unnest(${runs.map(r=>r.id)}::uuid[],${runs.map(r=>r.company)}::uuid[],${runs.map(r=>r.period)}::text[],${runs.map(r=>r.status)}::text[],${periods}::uuid[]) as x(r,c,per,st,pp)`;
  // Payslips: every employee on their company's processed and closed runs, every other employee on a processing run.
  // componentLines itemise FXA for k%5 in (0,1) and FXB for k%7=0; FXC is never itemised.
  await tx`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory)
   select ${T}::uuid,r.id,e.id,4000,4300,620,3680,4940,jsonb_build_object('pcb',120,'componentLines',
     (case when e.k%5 in (0,1) then jsonb_build_array(jsonb_build_object('code','FXA','name','Fictional FXA','amount',100,'buckets','[]'::jsonb)) else '[]'::jsonb end)
     ||(case when e.k%7=0 then jsonb_build_array(jsonb_build_object('code','FXB','name','Fictional FXB','amount',50,'buckets','[]'::jsonb)) else '[]'::jsonb end))
   from (select id,company_id,row_number() over (order by employee_code) k from employment where tenant_id=${T}::uuid and employee_code like 'RM%') e
   join unnest(${runs.map(r=>r.id)}::uuid[],${runs.map(r=>r.company)}::uuid[],${runs.map(r=>r.status)}::text[]) as r(id,company,status) on r.company=e.company_id
   where r.status in ('processed','closed') or (r.status='processing' and e.k%2=0)`;
  // Recurring FXA: live for k%6=0 (some never itemised), superseded for k%11=0. Recurring FXB live for k%9=0.
  await tx`insert into employment_pay_component(tenant_id,employment_id,component_id,amount,valid_from,superseded_at)
   select ${T}::uuid,e.id,${components.FXA}::uuid,100,'2025-01-01',case when e.k%11=0 then now() end
   from (select id,row_number() over (order by employee_code) k from employment where tenant_id=${T}::uuid and employee_code like 'RM%') e where e.k%6=0 or e.k%11=0`;
  await tx`insert into employment_pay_component(tenant_id,employment_id,component_id,amount,valid_from)
   select ${T}::uuid,e.id,${components.FXB}::uuid,50,'2025-01-01'
   from (select id,row_number() over (order by employee_code) k from employment where tenant_id=${T}::uuid and employee_code like 'RM%') e where e.k%9=0`;
  // One-off FXA and FXC rows on the processed runs (k%13=0), some for employees with no FXA line.
  await tx`insert into payroll_individual_txn(tenant_id,batch_id,employment_id,kind,txn_date,amount,component_id)
   select ${T}::uuid,r.id,e.id,'earning','2026-10-10',75,case when e.k%26=0 then ${components.FXC}::uuid else ${components.FXA}::uuid end
   from (select id,company_id,row_number() over (order by employee_code) k from employment where tenant_id=${T}::uuid and employee_code like 'RM%') e
   join payroll_batch r on r.company_id=e.company_id and r.status='processed' where e.k%13=0`;
  // Five processed runs already carry a mark for two of their employees.
  await tx`update payroll_batch b set needs_recalc_at=now()-interval '1 day',recalc_employment_ids=(select jsonb_agg(id::text) from (select id from employment e where e.company_id=b.company_id order by id limit 2) x)
   where b.tenant_id=${T}::uuid and b.status='processed' and b.company_id=any(${all.slice(30,35)}::uuid[])`;
 });
 Object.assign(actors,{
  'group administrator':adminCtx(b),
  'subtree administrator':await user('hr_admin',level1[0]),
  'leaf administrator':await user('hr_admin',level2[5]),
  'payroll partner (group)':await user('payroll_partner',null),
  'employee':await user('employee',null),
 });
},600_000);
afterAll(closeAll);

describe('Pay Item stale-run marker: previous and set-based give the same marks',()=>{
 it('marks the same runs, employees and events for every actor and pay item, at a fraction of the authority calls',async()=>{
  const lines:string[]=[];let compared=0,nonEmpty=0;
  for(const[label,ctx]of Object.entries(actors))for(const code of ['FXA','FXB','FXC']){
   const p={componentId:components[code],code};
   const before=await observe(ctx,tx=>previousMarkRunsAffectedByPayComponentTx(tx,ctx,p));
   const after=await observe(ctx,tx=>markRunsAffectedByPayComponentTx(tx,ctx,p));
   expect(decided(after),`${label} · ${code}`).toEqual(decided(before));
   compared++;
   if(!('error' in before)&&Array.isArray(before.returned)&&before.returned.length>0)nonEmpty++;
   if(!('error' in before)&&!('error' in after)){
    lines.push(`${label} ${code}: ms ${before.ms}->${after.ms} statements ${before.statements}->${after.statements} authority ${before.authorityCalls}->${after.authorityCalls}`);
    if(label==='group administrator'&&code==='FXA'){
     // Non-vacuous: the group administrator marks every processed run and the processing runs' paid employees.
     expect((before.returned as unknown[]).length).toBeGreaterThan(70);
     // Cost shape: previously the authority function ran for every slip of every open run (1,000 processed + 70 of
     // the processing runs' at least); now only for the itemised matches, and the statement count is flat.
     expect(before.authorityCalls).toBeGreaterThan(1000);
     expect(after.authorityCalls).toBeLessThan(before.authorityCalls/2);
     expect(after.statements).toBeLessThan(20);
     expect(before.statements).toBeGreaterThan(200);
    }
   }
  }
  console.log(`[payroll-recalc-mark] ${compared} comparisons, ${nonEmpty} non-empty\n`+lines.join('\n'));
  expect(nonEmpty).toBeGreaterThanOrEqual(8);
 },600_000);

 it('marks several runs in one pass exactly as the sequential calls did, including a run named twice and a processing run',async()=>{
  const ctx=actors['group administrator'];
  const runs=await owner.client<{id:string;status:string;company:string}[]>`select id::text,status::text,company_id::text as company from payroll_batch where tenant_id=${b.tenantId}::uuid order by status,id`;
  const byCompany=new Map<string,string[]>();
  for(const e of await owner.client<{id:string;company:string}[]>`select id::text,company_id::text as company from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'RM%' order by id`)
   byCompany.set(e.company,[...(byCompany.get(e.company)??[]),e.id]);
  const pick=(status:string,n:number)=>runs.filter(r=>r.status===status).slice(0,n);
  const targets=[...pick('processed',6),...pick('processing',3),...pick('closed',2),...pick('draft',1)].map((r,i)=>({batchId:r.id,employmentIds:(byCompany.get(r.company)??[]).slice(i%3,i%3+5),category:(i%2?'compensation':undefined) as 'compensation'|undefined}));
  targets.push({...targets[0],employmentIds:(byCompany.get(runs.find(r=>r.id===targets[0].batchId)!.company)??[]).slice(5,8),category:'transfer' as unknown as undefined});
  targets.push({batchId:randomUUID(),employmentIds:[employments[0]],category:undefined});
  const before=await observe(ctx,async tx=>{for(const t of targets)await markBatchNeedsRecalc(tx,ctx,t);});
  const after=await observe(ctx,tx=>markBatchesNeedRecalcTx(tx,ctx,targets));
  expect(decided(after)).toEqual(decided(before));
  expect('error' in before?0:(before.events as unknown[]).length).toBeGreaterThanOrEqual(7);
 },120_000);

 it('the employment-change marker gives the same marks through the set-based pass',async()=>{
  for(const[label,ctx]of Object.entries(actors)){
   const ids=employments.slice(0,60);
   const previous=async(tx:Tx)=>{
    // The previous loop, verbatim apart from the shared read: one markBatchNeedsRecalc per run in id order.
    const rows=await tx.select({batchId:nativePayrollPayslip.batchId,employmentId:nativePayrollPayslip.employmentId}).from(nativePayrollPayslip)
     .innerJoin(s.payrollBatch,eq(s.payrollBatch.id,nativePayrollPayslip.batchId))
     .where(and(inArray(nativePayrollPayslip.employmentId,ids),inArray(s.payrollBatch.status,['processed','processing']),sql`app.can_admin_payroll_for(${s.payrollBatch.companyId})`));
    const byBatch=new Map<string,Set<string>>();
    for(const r of rows)byBatch.set(r.batchId,(byBatch.get(r.batchId)??new Set<string>()).add(r.employmentId));
    const marked:{batchId:string;employmentIds:string[]}[]=[];
    for(const[batchId,set]of[...byBatch].sort(([x],[y])=>x.localeCompare(y))){const employmentIds=[...set].sort();await markBatchNeedsRecalc(tx,ctx,{batchId,employmentIds,category:'compensation'});marked.push({batchId,employmentIds});}
    return marked;
   };
   const before=await observe(ctx,previous);
   const after=await observe(ctx,tx=>markRunsAffectedByEmploymentChangeTx(tx,ctx,{employmentIds:ids,category:'compensation',from:null}));
   expect(decided(after),label).toEqual(decided(before));
  }
 },300_000);
});
