/** ADR 0181 (write side): the tax-basis source read (core/payroll-tax-basis-read.ts taxBasisSourceRowsTx), used by the
 * reprocess tax review, the tax-basis preview and payroll processing's tax opening.
 *
 * Production 24 November 2026: one reprocess tax review took 18.9 s. The focused diagnostic attributed 5.6 s of a
 * 6.4 s source read of 1,800 payslips to one select-list column, app.payroll_tax_import_source_revision(p.id), called
 * once per payslip. 7310 asks the same function only for the requested payslips that have an import snapshot (no
 * other payslip can have a revision) and returns only its non-null answers.
 *
 * This runs the PREVIOUS statement verbatim and the new reader side by side on a fictional group of 70 companies and
 * 1,000 employments with three imported months (some records revised twice), six native closed months and a
 * processed month: 10,000 payslips. Every column of every row, and the row order, must be identical for every actor
 * (group, single-company, 70-grant and payroll-partner administrators and an employee reading their own history)
 * and id set, and the result must be non-vacuous (imported revisions present). */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {taxBasisSourceRowsTx,type TaxBasisSource} from '../core/payroll-tax-basis-read';
import {isIdentityStatement,observeStatements,type Captured} from './helpers/statement-observer';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base;let all:string[]=[];
const emp:{id:string;person:string;company:number}[]=[];
const actors:Record<string,SessionContext>={};
const slipsByCompany=new Map<number,string[]>();let everySlip:string[]=[];

/** The statement as it was before 7310 (core/payroll-tax-basis-read.ts at 66f8c20fe), verbatim. */
function previousSourceRowsTx(tx:Tx,ids:string[]){
 if(!ids.length)return Promise.resolve([] as TaxBasisSource[]);
 return tx.execute<TaxBasisSource>(sql`select p.id,p.employment_id as "employmentId",b.company_id as "companyId",b.pay_period as period,case when app.payroll_history_native_baseline(p.id) then null else b.history_import_attempt_id end as "historyAttemptId",
   to_jsonb(p) as source,jsonb_build_object('id',b.id,'company_id',b.company_id,'pay_period',b.pay_period,'run_seq',b.run_seq,'run_type',b.run_type,'cycle_id',b.payroll_cycle_id,'batch_date',b.batch_date) as batch,
   app.payroll_tax_import_source_revision(p.id)::text as "importRevision"
  from payslip p join payroll_batch b on b.id=p.batch_id where p.id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) order by b.pay_period,b.batch_date,b.payroll_cycle_id,b.run_seq,b.id,p.id`);
}
const plain=(rows:readonly unknown[])=>JSON.parse(JSON.stringify(rows));

/** Shared buffers of the one read statement a piece of work sends, replayed with EXPLAIN (ANALYZE, BUFFERS) under the
 * reader's own identity statement and rolled back. Function calls in the select list count in the top node's buffers.
 * The first replay warms the connection's catalog caches; the second is the measure. A runner stall cannot change it. */
const ROLLBACK=new Error('rolled back on purpose');
async function readBuffers(ctx:SessionContext,read:(tx:Tx)=>Promise<unknown>):Promise<number>{
 const observed=await observeStatements(()=>withTenant(ctx,read,{readOnlySnapshot:true}));
 const identity=observed.statements.find(s=>isIdentityStatement(s.sql))!;
 const reads=observed.statements.filter((s:Captured)=>/payslip p join payroll_batch b/.test(s.sql));
 expect(reads).toHaveLength(1);
 let buffers=-1;
 await client.begin(async tx=>{
  await tx.unsafe(identity.sql,identity.params as never[]);
  for(let replay=0;replay<2;replay++){
   const [row]=await tx.unsafe(`explain (analyze, buffers, format json) ${reads[0].sql}`,reads[0].params as never[]);
   const [plan]=(row as Record<string,unknown>)['QUERY PLAN'] as [{Plan:{'Shared Hit Blocks'?:number;'Shared Read Blocks'?:number}}];
   buffers=(plan.Plan['Shared Hit Blocks']??0)+(plan.Plan['Shared Read Blocks']??0);
  }
  throw ROLLBACK;
 }).catch(error=>{if(error!==ROLLBACK)throw error;});
 return buffers;
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();const T=b.tenantId;
 const level1=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${T}::uuid,'Fictional S'||g||' Sdn Bhd',${b.companyId}::uuid from generate_series(1,8) g order by g returning id`).map(r=>r.id);
 const level2=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${T}::uuid,'Fictional S unit '||g||' Sdn Bhd',(${level1}::uuid[])[1+(g % 8)] from generate_series(1,61) g order by g returning id`).map(r=>r.id);
 all=[b.companyId,...level1,...level2];expect(all).toHaveLength(70);
 const rows=await owner.client<{id:string;person:string;k:number}[]>`with p as (insert into person(tenant_id,full_name,primary_email)
   select ${T}::uuid,'Fictional TS '||g,'ts-'||g||'@example.test' from generate_series(1,1000) g returning id),
  n as (select id,row_number() over (order by id) k from p)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select ${T}::uuid,n.id,(${all}::uuid[])[1+(n.k % 70)::int],'TS'||lpad(n.k::text,5,'0'),'2025-01-06' from n order by n.k returning id,person_id as person,(substring(employee_code from 3))::int as k`;
 for(const r of rows)emp.push({id:r.id,person:r.person,company:r.k%70});
 const cycles=all.map(()=>randomUUID()),attempts=all.map(()=>randomUUID());
 type Run={id:string;company:number;period:string;attempt:string|null;status:string};
 const runs:Run[]=[];
 for(let c=0;c<70;c++){
  for(const period of ['2026-01','2026-02','2026-03'])runs.push({id:randomUUID(),company:c,period,attempt:attempts[c],status:'closed'});
  for(const period of ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09'])runs.push({id:randomUUID(),company:c,period,attempt:null,status:'closed'});
  runs.push({id:randomUUID(),company:c,period:'2026-10',attempt:null,status:'processed'});
 }
 await owner.client.begin(async tx=>{
  // Imported history is written directly, with the import guards off in this fixture transaction only (as
  // test/payroll-dashboard-and-choice-multicompany-scale-db.test.ts does): the import job is not what is under test.
  await tx`set local session_replication_role = replica`;
  await tx`insert into payroll_cycle(id,tenant_id,company_id,name,run_type) select y,${T}::uuid,c,'Monthly','regular' from unnest(${cycles}::uuid[],${all}::uuid[]) as x(y,c)`;
  await tx`insert into payroll_history_import_attempt(tenant_id,id,created_by,operation_key,source_name,mime_type,source_hash,source_content,company_ids,plan)
   select ${T}::uuid,a,${b.adminUserId}::uuid,gen_random_uuid(),'history.csv','text/csv',encode(sha256(a::text::bytea),'hex'),a::text::bytea,array[c],
    jsonb_build_object('rows',jsonb_build_array(),'sourceHash',encode(sha256(a::text::bytea),'hex'))
   from unnest(${attempts}::uuid[],${all}::uuid[]) as x(a,c)`;
  const periodIds=runs.map(()=>randomUUID());
  await tx`insert into pay_period(id,tenant_id,company_id,period,status)
   select p,${T}::uuid,c,per,(case when st='closed' then 'closed' else 'open' end)::pay_period_status from unnest(${periodIds}::uuid[],${runs.map(r=>all[r.company])}::uuid[],${runs.map(r=>r.period)}::text[],${runs.map(r=>r.status)}::text[]) as x(p,c,per,st)`;
  await tx`insert into payroll_batch(id,tenant_id,company_id,pay_period,batch_date,status,employee_count,totals,remarks,run_seq,run_type,pay_period_id,payroll_cycle_id,history_import_attempt_id,history_import_cycle_name,closed_at)
   select r,${T}::uuid,c,per,(per||'-25')::date,st::payroll_status,0,'{}'::jsonb,case when a is null then null else 'Imported payroll history' end,1,
    (case when a is null then 'regular' else 'adjustment' end)::payroll_run_type,pp,y,a,case when a is null then null else 'Monthly' end,case when st='closed' then now() end
   from unnest(${runs.map(r=>r.id)}::uuid[],${runs.map(r=>all[r.company])}::uuid[],${runs.map(r=>r.period)}::text[],${runs.map(r=>r.status)}::text[],
    ${runs.map(r=>r.attempt)}::uuid[],${periodIds}::uuid[],${runs.map(r=>cycles[r.company])}::uuid[]) as x(r,c,per,st,a,pp,y)`;
  const slips:{id:string;batch:string;emp:string;company:number;period:string;imported:boolean;record:string;revision:string;second:string|null}[]=[];
  for(const run of runs)for(const e of emp)if(e.company===run.company)
   slips.push({id:randomUUID(),batch:run.id,emp:e.id,company:run.company,period:run.period,imported:run.attempt!==null,record:randomUUID(),revision:randomUUID(),second:run.attempt!==null&&slips.length%4===0?randomUUID():null});
  const col=<K extends keyof typeof slips[number]>(rows:typeof slips,k:K)=>rows.map(x=>x[k]);
  await tx`insert into payslip(id,tenant_id,batch_id,employment_id,basic_salary,allowance,gross_pay,statutory,other_deductions,total_deductions,net_pay,employer_cost)
   select x.s,${T}::uuid,x.bt,x.e,4000,300,4300,'{"version":"2026.1","epfEmployee":473,"epfEmployer":559,"socsoEmployee":21.25,"socsoEmployer":74.35,"eisEmployee":8.5,"eisEmployer":8.5,"pcb":120}'::jsonb,0,622.75,3677.25,4942.1
   from unnest(${col(slips,'id')}::uuid[],${col(slips,'batch')}::uuid[],${col(slips,'emp')}::uuid[]) as x(s,bt,e)`;
  const imported=slips.filter(x=>x.imported);
  await tx`insert into payroll_history_import_record(id,tenant_id,company_id,employment_id,period,cycle_id)
   select r,${T}::uuid,c,e,per,y from unnest(${col(imported,'record')}::uuid[],${imported.map(x=>all[x.company])}::uuid[],${col(imported,'emp')}::uuid[],${col(imported,'period')}::text[],${imported.map(x=>cycles[x.company])}::uuid[]) as x(r,c,e,per,y)`;
  await tx`insert into payroll_history_import_snapshot(id,tenant_id,record_id,value_hash,"values")
   select x.s,${T}::uuid,r,encode(sha256(x.s::text::bytea),'hex'),'{"fixture":true}'::jsonb from unnest(${col(imported,'id')}::uuid[],${col(imported,'record')}::uuid[]) as x(s,r)`;
  await tx`insert into payroll_history_import_revision(id,tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name)
   select v,${T}::uuid,r,1,a,x.s,null,'import','Monthly' from unnest(${col(imported,'revision')}::uuid[],${col(imported,'record')}::uuid[],${imported.map(x=>attempts[x.company])}::uuid[],${col(imported,'id')}::uuid[]) as x(v,r,a,s)`;
  // A quarter of the imported records carry a second revision: the reader returns the latest ordinal.
  const revised=imported.filter(x=>x.second);
  await tx`insert into payroll_history_import_revision(id,tenant_id,record_id,ordinal,attempt_id,snapshot_id,previous_revision_id,kind,cycle_name)
   select v,${T}::uuid,r,2,a,x.s,p,'import','Monthly' from unnest(${revised.map(x=>x.second!)}::uuid[],${col(revised,'record')}::uuid[],${revised.map(x=>attempts[x.company])}::uuid[],${col(revised,'id')}::uuid[],${col(revised,'revision')}::uuid[]) as x(v,r,a,s,p)`;
  for(const x of slips)slipsByCompany.set(x.company,[...(slipsByCompany.get(x.company)??[]),x.id]);
  everySlip=slips.map(x=>x.id);
 });
 for(const table of ['payroll_batch','payslip','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision'])await owner.client.unsafe('analyze '+table);
 const user=async(role:typeof s.roleAssignment.$inferInsert['role'],companies:(string|null)[],personId:string|null=null)=>{
  const [u]=await owner.db.insert(s.appUser).values({tenantId:T,workosUserId:`fixture_${randomUUID()}`,personId}).returning({id:s.appUser.id});
  await owner.db.insert(s.roleAssignment).values(companies.map(companyId=>({tenantId:T,appUserId:u.id,role,companyId})));
  return {...adminCtx(b),userId:u.id,personId:personId??undefined,roles:[role],grants:companies.map(companyId=>({role,companyId}))} as SessionContext;
 };
 const self=emp.find(e=>e.company===0)!;
 Object.assign(actors,{
  'group administrator':adminCtx(b),
  'single-company administrator':await user('hr_admin',[all[2]]),
  'administrator with 70 company grants':await user('hr_admin',all),
  'payroll partner (group)':await user('payroll_partner',[null]),
  'employee reading their own history':await user('employee',[null],self.person),
 });
},900_000);
afterAll(closeAll);

describe('tax-basis source rows: previous and set-based import revisions are identical',()=>{
 it('returns the same rows, columns and order for every actor and id set, faster',async()=>{
  const rootIds=slipsByCompany.get(0)!;
  const mixed=everySlip.filter((_,i)=>i%5===0).slice(0,2000);
  const sets:Record<string,string[]>={
   'one company, the whole year':rootIds,
   'two thousand slips across the group':mixed,
   'with unknown and repeated ids':[...rootIds.slice(0,30),randomUUID(),rootIds[0],randomUUID()],
  };
  const lines:string[]=[];let revisions=0;
  for(const[label,ctx]of Object.entries(actors))for(const[setName,ids]of Object.entries(sets)){
   const timed=async(read:(tx:Tx)=>Promise<unknown>)=>withTenant(ctx,async tx=>{const t=performance.now();const rows=await read(tx);return{rows:plain(rows as unknown[]),ms:Math.round(performance.now()-t)};},{readOnlySnapshot:true});
   const before=await timed(tx=>previousSourceRowsTx(tx,ids));
   const after=await timed(tx=>taxBasisSourceRowsTx(tx,ids));
   expect(after.rows,`${label} · ${setName}`).toEqual(before.rows);
   revisions+=(before.rows as {importRevision:string|null}[]).filter(r=>r.importRevision).length;
   lines.push(`${label} · ${setName}: ${before.rows.length} rows, ms ${before.ms}->${after.ms}`);
   if(label==='group administrator'&&setName==='two thousand slips across the group'){
    expect(before.rows.length).toBeGreaterThan(1000);
    // Primary check: the set form reads fewer shared buffers than the per-slip call (deterministic for this fixture).
    // Wall time is only a loose ceiling: a strict after<before comparison of two single timings failed on shared-runner
    // noise alone, so it no longer decides the result.
    const beforeBuffers=await readBuffers(ctx,tx=>previousSourceRowsTx(tx,ids));
    const afterBuffers=await readBuffers(ctx,tx=>taxBasisSourceRowsTx(tx,ids));
    console.log('TAX_SOURCE_ROWS_BUFFERS '+JSON.stringify({before:beforeBuffers,after:afterBuffers,beforeMs:before.ms,afterMs:after.ms}));
    expect(afterBuffers).toBeGreaterThan(0);
    expect(afterBuffers).toBeLessThan(beforeBuffers);
    expect(after.ms).toBeLessThanOrEqual(before.ms*1.5+250);
   }
  }
  console.log('[payroll-tax-source-rows]\n'+lines.join('\n'));
  // Non-vacuous: imported revisions were found (both ordinals) by actors allowed to read them.
  expect(revisions).toBeGreaterThan(100);
 },900_000);

 it('discloses nothing beyond the per-slip function: only non-null answers, never for another tenant',async()=>{
  const other=await seedBase();
  const otherCtx=adminCtx(other);
  const ids=slipsByCompany.get(0)!.slice(0,60);
  const answers=await withTenant(otherCtx,tx=>tx.execute<{n:number}>(sql`select count(*)::int as n from app.payroll_tax_import_source_revisions(${`{${ids.join(',')}}`}::uuid[])`));
  expect(answers[0].n).toBe(0);
  // The set form restates the single-payslip function: the same non-null answers for every actor, over imported,
  // native and other companies' slips (and both revision ordinals).
  const probe=everySlip.filter((_,i)=>i%17===0).slice(0,600);let answered=0;
  for(const[label,ctx]of Object.entries(actors)){
   const mine=await withTenant(ctx,async tx=>{
    const set=await tx.execute<{payslip_id:string;revision_id:string}>(sql`select payslip_id::text,revision_id::text from app.payroll_tax_import_source_revisions(${`{${probe.join(',')}}`}::uuid[]) order by 1`);
    const single=await tx.execute<{id:string;revision:string|null}>(sql`select x::text as id,app.payroll_tax_import_source_revision(x)::text as revision from unnest(${`{${probe.join(',')}}`}::uuid[]) x order by 1`);
    return {set:set.map(r=>[r.payslip_id,r.revision_id]),single:single.filter(r=>r.revision).map(r=>[r.id,r.revision])};
   });
   expect(mine.set,label).toEqual(mine.single);answered+=mine.set.length;
  }
  expect(answered).toBeGreaterThan(50);
 },300_000);
});
