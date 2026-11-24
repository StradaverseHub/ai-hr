/** ADR 0181 (write side) diagnostic: where the Direct Superior, Save movement and reprocess tax review time goes.
 *
 * Production 24 November 2026: Set or correct direct superior up to 8.1 s, Save movement up to 7.4 s, reprocess tax
 * review 18.9 s. This drives the real service owners on a fictional group of 70 companies and 1,000 employments with
 * reporting lines, compensation, six closed months and a processed run, as a group administrator and as an
 * administrator holding one grant per company (70 grants), and prints each action's statement count, total time and
 * slowest statements (time to the next statement, which on one uncontended connection is the statement's own
 * database time). It asserts only that the fixture is non-vacuous; the measurements are the output. */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {client,withTenant,type SessionContext} from '../db/client';
import {sql} from 'drizzle-orm';
import {taxBasisSourceRowsTx} from '../core/payroll-tax-basis-read';
import * as s from '../db/schema';
import {amendDirectSuperior} from '../core/information-correction';
import {createMovementEvent,createMovementEventTx} from '../core/movement';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {hireEmployee} from '../core/org';
import {correctDirectSuperiorPeriod} from '../core/direct-superior-periods';
import {directSuperiorPeriodsFor} from '../core/read';
import {reviewReprocessTaxReadiness} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

vi.mock('next/cache',()=>({revalidatePath:()=>{},revalidateTag:()=>{},updateTag:()=>{}}));

let b:Base;let all:string[]=[];let depts:string[]=[];
const emp:{id:string;company:string;k:number}[]=[];
const actors:Record<string,SessionContext>={};
let processedRoot='';

type Step={ms:number;sql:string};
async function profile<T>(label:string,work:()=>Promise<T>):Promise<{ok:boolean;ms:number;statements:number;line:string}>{
 const options=(client as unknown as {options:{debug?:unknown}}).options,previous=options.debug;
 const marks:{at:number;sql:string}[]=[];
 options.debug=(_c:number,text:string)=>{marks.push({at:performance.now(),sql:text});};
 const started=performance.now();let ok=true;let error='';
 try{await work();}catch(e){ok=false;error=String((e as Error).message).slice(0,200);}finally{options.debug=previous;}
 const ended=performance.now();
 const steps:Step[]=marks.map((m,i)=>({ms:(marks[i+1]?.at??ended)-m.at,sql:m.sql.replace(/\s+/g,' ').slice(0,260)}));
 const bookkeeping=/^(begin|commit|rollback|savepoint|release)/i;
 const real=steps.filter(st=>!bookkeeping.test(st.sql.trim()));
 const slowest=[...real].sort((x,y)=>y.ms-x.ms).slice(0,12).map(st=>`   ${st.ms.toFixed(1).padStart(8)} ms  ${st.sql}`);
 // Group repeated statement shapes: which kinds of statement the time goes to.
 const shapes=new Map<string,{n:number;ms:number}>();
 for(const st of real){const key=st.sql.slice(0,90);const v=shapes.get(key)??{n:0,ms:0};v.n++;v.ms+=st.ms;shapes.set(key,v);}
 const top=[...shapes].sort((x,y)=>y[1].ms-x[1].ms).slice(0,10).map(([k,v])=>`   ${v.ms.toFixed(1).padStart(8)} ms ×${String(v.n).padStart(3)}  ${k}`);
 const line=`[write-path-profile] ${label}: ${ok?'saved':'REFUSED '+error} in ${Math.round(ended-started)} ms, ${real.length} statements, ${marks.filter(m=>/^begin/i.test(m.sql.trim())).length} transactions\n  slowest:\n${slowest.join('\n')}\n  by shape:\n${top.join('\n')}`;
 console.log(line);
 return {ok,ms:ended-started,statements:real.length,line};
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();const T=b.tenantId;
 const level1=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${T}::uuid,'Fictional W'||g||' Sdn Bhd',${b.companyId}::uuid from generate_series(1,8) g order by g returning id`).map(r=>r.id);
 const level2=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${T}::uuid,'Fictional W unit '||g||' Sdn Bhd',(${level1}::uuid[])[1+(g % 8)] from generate_series(1,61) g order by g returning id`).map(r=>r.id);
 all=[b.companyId,...level1,...level2];expect(all).toHaveLength(70);
 depts=[b.deptA,...(await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name)
  select ${T}::uuid,c,'Operations' from unnest(${all.slice(1)}::uuid[]) with ordinality x(c,k) order by k returning id`).map(r=>r.id)];
 for(const code of ['payroll','typed_pay_components','multi_cycle_payroll'])await setModule(T,code,'active');
 const ADMIN=await entitledCtx(b);
 // 1,000 fictional hires through the real owner: 300 in the root company (the large payroll run), the rest spread.
 for(let k=0;k<1000;k++){
  const c=k<300?0:1+(k%69);
  const hired=await hireEmployee(ADMIN,{person:{fullName:`Fictional WP ${k}`,primaryEmail:`wp-${k}-${T.slice(0,6)}@example.test`},
   companyId:all[c],departmentId:depts[c],employmentType:'full_time',hiredOn:'2025-01-06'} as Parameters<typeof hireEmployee>[1]);
  emp.push({id:(hired as {employmentId:string}).employmentId,company:all[c],k});
 }
 // Compensation and reporting lines as the storage owner: every employee reports to the first hire of their company.
 await owner.client`insert into compensation(tenant_id,employment_id,basic_salary,valid_from)
  select ${T}::uuid,e,4000+(k%50)*10,'2025-01-06' from unnest(${emp.map(e=>e.id)}::uuid[],${emp.map(e=>e.k)}::int[]) x(e,k)
  where not exists(select 1 from compensation c where c.employment_id=x.e)`;
 const head=new Map<string,string>();for(const e of emp)if(!head.has(e.company))head.set(e.company,e.id);
 await owner.client`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from)
  select ${T}::uuid,e,m,'administrative','2025-01-06' from unnest(${emp.filter(e=>head.get(e.company)!==e.id).map(e=>e.id)}::uuid[],${emp.filter(e=>head.get(e.company)!==e.id).map(e=>head.get(e.company)!)}::uuid[]) x(e,m)`;
 // Six closed months and a processed November for every company, with a payslip for every employee.
 const months=['2026-05','2026-06','2026-07','2026-08','2026-09','2026-10'];
 const runs=all.flatMap(c=>[...months.map(m=>({id:randomUUID(),company:c,period:m,status:'closed'})),{id:randomUUID(),company:c,period:'2026-11',status:'processed'}]);
 processedRoot=runs.find(r=>r.company===b.companyId&&r.status==='processed')!.id;
 await owner.client.begin(async tx=>{
  const periods=runs.map(()=>randomUUID());
  await tx`insert into pay_period(id,tenant_id,company_id,period,status)
   select p,${T}::uuid,c,per,(case when st='closed' then 'closed' else 'open' end)::pay_period_status from unnest(${periods}::uuid[],${runs.map(r=>r.company)}::uuid[],${runs.map(r=>r.period)}::text[],${runs.map(r=>r.status)}::text[]) as x(p,c,per,st)`;
  await tx`insert into payroll_batch(id,tenant_id,company_id,pay_period,batch_date,status,employee_count,totals,pay_period_id,closed_at)
   select r,${T}::uuid,c,per,(per||'-25')::date,st::payroll_status,0,'{}'::jsonb,pp,case when st='closed' then now() end
   from unnest(${runs.map(r=>r.id)}::uuid[],${runs.map(r=>r.company)}::uuid[],${runs.map(r=>r.period)}::text[],${runs.map(r=>r.status)}::text[],${periods}::uuid[]) as x(r,c,per,st,pp)`;
  await tx`insert into payslip(tenant_id,batch_id,employment_id,basic_salary,gross_pay,total_deductions,net_pay,employer_cost,statutory)
   select ${T}::uuid,r.id,e.id,4000,4300,620,3680,4940,'{"version":"2026.1","epfEmployee":473,"epfEmployer":559,"socsoEmployee":21.25,"socsoEmployer":74.35,"eisEmployee":8.5,"eisEmployer":8.5,"pcb":120,"componentLines":[]}'::jsonb
   from employment e join payroll_batch r on r.company_id=e.company_id where e.tenant_id=${T}::uuid and r.tenant_id=${T}::uuid`;
 });
 const [{n}]=await owner.client<{n:number}[]>`select count(*)::int as n from payslip where tenant_id=${T}::uuid`;
 expect(n).toBeGreaterThanOrEqual(7000);
 actors['group administrator']=ADMIN;
 // One hr_admin grant per company: the shape of a regional administrator holding every company separately.
 const [u]=await owner.db.insert(s.appUser).values({tenantId:T,workosUserId:`fixture_${randomUUID()}`,personId:null}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values(all.map(companyId=>({tenantId:T,appUserId:u.id,role:'hr_admin',companyId})));
 actors['administrator with 70 company grants']={...ADMIN,userId:u.id,roles:['hr_admin'],grants:all.map(companyId=>({role:'hr_admin',companyId}))} as SessionContext;
},900_000);
afterAll(closeAll);

describe('write-path save cost at 70 companies / 1,000 employments',()=>{
 it('profiles the Direct Superior, movement and reprocess review owners',async()=>{
  const today=todayInKualaLumpur();
  // Subjects and new superiors are never a company's head (everyone reports to the head), so no change is a cycle.
  const heads=new Set<string>();for(const e of emp)if(![...heads].some(h=>emp.find(x=>x.id===h)?.company===e.company))heads.add(e.id);
  const pool=emp.filter(e=>e.company!==b.companyId&&!heads.has(e.id));let n=0;
  const pair=()=>{const a=pool[(n++)*13%pool.length];const m=pool.find(x=>x.company===a.company&&x.id!==a.id&&!used.has(x.id))!;used.add(a.id);used.add(m.id);return[a,m] as const;};
  const used=new Set<string>();
  const out:string[]=[];
  for(const[label,ctx]of Object.entries(actors)){
   {const[a,m]=pair();out.push((await profile(`${label} · amend direct superior`,()=>amendDirectSuperior(ctx,{employmentId:a.id,managerEmploymentId:m.id,reason:'Fictional correction',expectedLineId:null}))).line);}
   {const[a,m]=pair();out.push((await profile(`${label} · direct superior movement today`,()=>createMovementEvent(ctx,{employmentId:a.id,managerEmploymentId:m.id,effectiveDate:today,remarks:'Fictional change',kind:'reportingLineChange'}))).line);}
   {const[a,m]=pair();out.push((await profile(`${label} · direct superior movement backdated`,()=>createMovementEvent(ctx,{employmentId:a.id,managerEmploymentId:m.id,effectiveDate:'2026-06-01',remarks:'Fictional change',kind:'reportingLineChange'}))).line);}
   {const[t]=pair();out.push((await profile(`${label} · transfer with salary today`,()=>createMovementEvent(ctx,{employmentId:t.id,kind:'transfer',effectiveDate:today,basicSalary:4800,remarks:'Fictional transfer'}))).line);}
   {const[t]=pair();out.push((await profile(`${label} · transfer with salary backdated`,()=>createMovementEvent(ctx,{employmentId:t.id,kind:'transfer',effectiveDate:'2026-07-01',basicSalary:4700,remarks:'Fictional transfer'}))).line);}
   {const[p,pm]=pair();
    const periods=await directSuperiorPeriodsFor(ctx,p.id) as {revision:string;periods:{id:string;validFrom:string}[]};
    const line=periods.periods[0];
    out.push((await profile(`${label} · correct direct superior period`,()=>correctDirectSuperiorPeriod(ctx,{employmentId:p.id,reason:'Fictional correction',revision:periods.revision,lineId:line.id,operation:'edit',managerEmploymentId:pm.id,validFrom:line.validFrom,validToInclusive:null}))).line);}
   const ids=emp.filter(e=>e.company===b.companyId).map(e=>e.id);
   out.push((await profile(`${label} · reprocess tax review (300 employees)`,()=>reviewReprocessTaxReadiness(ctx,processedRoot,ids))).line);
  }
  // Contention: another session holds the SHARED Access lock (as every converted writer and display read does) for
  // 1.5 s. A save that asks for the exclusive lock waits for it; a save that joins shared does not.
  const ctx=actors['group administrator'];
  const hold=async()=>{await owner.client.begin(async tx=>{await tx`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+b.tenantId},0))`;await new Promise(r=>setTimeout(r,1500));});};
  for(const[name,run]of [
   ['amend direct superior',()=>{const[a,m]=pair();return amendDirectSuperior(ctx,{employmentId:a.id,managerEmploymentId:m.id,reason:'Fictional correction',expectedLineId:null});}],
   ['direct superior movement today',()=>{const[a,m]=pair();return createMovementEvent(ctx,{employmentId:a.id,managerEmploymentId:m.id,effectiveDate:today,remarks:'Fictional change',kind:'reportingLineChange'});}],
   ['transfer with salary today',()=>{const[t]=pair();return createMovementEvent(ctx,{employmentId:t.id,kind:'transfer',effectiveDate:today,basicSalary:4900,remarks:'Fictional transfer'});}],
  ] as const){
   const holder=hold();await new Promise(r=>setTimeout(r,100));
   out.push((await profile(`contention (shared Access held 1.5 s) · ${name}`,run as ()=>Promise<unknown>)).line);
   await holder;
  }
  // Decomposition of the review's source-row read (core/payroll-tax-basis-read.ts taxBasisSourceRowsTx) for both actors.
  for(const[label,actor]of Object.entries(actors))await withTenant(actor,async tx=>{
   const rootIds=emp.filter(e=>e.company===b.companyId).map(e=>e.id);
   const prior=(await tx.execute<{id:string}>(sql`select p.id::text from payslip p join payroll_batch x on x.id=p.batch_id where p.employment_id=any(${`{${rootIds.join(',')}}`}::uuid[]) and x.company_id=${b.companyId}::uuid and x.pay_period<'2026-11'`)).map(r=>r.id);
   const arr=`{${prior.join(',')}}`;
   const time=async(name:string,run:()=>Promise<unknown>)=>{const t=performance.now();const r=await run();out.push(`[write-path-profile] ${label} · source read part · ${name}: ${Math.round(performance.now()-t)} ms (${Array.isArray(r)?r.length:'-'} rows of ${prior.length})`);console.log(out.at(-1));};
   await time('full taxBasisSourceRowsTx',()=>taxBasisSourceRowsTx(tx,prior));
   await time('row security only (no select-list functions)',()=>tx.execute(sql`select p.id,b.company_id,to_jsonb(p) from payslip p join payroll_batch b on b.id=p.batch_id where p.id=any(${arr}::uuid[])`));
   await time('payslip row security alone',()=>tx.execute(sql`select p.id from payslip p where p.id=any(${arr}::uuid[])`));
   await time('payroll_history_native_baseline per id',()=>tx.execute(sql`select app.payroll_history_native_baseline(x) from unnest(${arr}::uuid[]) x`));
   await time('payroll_tax_import_source_revision per id',()=>tx.execute(sql`select app.payroll_tax_import_source_revision(x)::text from unnest(${arr}::uuid[]) x`));
   await time('can_admin_payroll_employment per employment',()=>tx.execute(sql`select app.can_admin_payroll_employment(x) from unnest(${`{${rootIds.join(',')}}`}::uuid[]) x`));
   await time('payroll_tax_basis_original_employer_read per row',()=>tx.execute(sql`select app.payroll_tax_basis_original_employer_read(p.batch_id) from payroll_batch p where p.company_id=${b.companyId}::uuid`));
   const plan=await tx.execute<{'QUERY PLAN':string}>(sql`explain (analyze, costs off, timing on) select p.id,b.company_id,to_jsonb(p) from payslip p join payroll_batch b on b.id=p.batch_id where p.id=any(${arr}::uuid[])`);
   console.log(`[write-path-profile] ${label} · source read plan:\n`+plan.map(r=>r['QUERY PLAN']).join('\n').slice(0,6000));
  });
  expect(out.length).toBeGreaterThanOrEqual(14);
 },900_000);

 it('strict probe: which movement kinds would run under the SHARED Access lock',async()=>{
  const ctx=actors['group administrator'];const today=todayInKualaLumpur();
  const before=process.env.AIHR_ACCESS_LOCK_STRICT;process.env.AIHR_ACCESS_LOCK_STRICT='on';
  const root=emp.filter(e=>e.company===b.companyId).slice(200);let i=0;const next=()=>root[i++];
  const other=emp.filter(e=>e.company===all[5]);
  const cases:[string,()=>Record<string,unknown>][]=[
   ['reportingLineChange today',()=>{const a=next(),m=next();return{employmentId:a.id,managerEmploymentId:m.id,effectiveDate:today,kind:'reportingLineChange',remarks:'Fictional'};}],
   ['reportingLineChange backdated',()=>{const a=next(),m=next();return{employmentId:a.id,managerEmploymentId:m.id,effectiveDate:'2026-06-01',kind:'reportingLineChange',remarks:'Fictional'};}],
   ['transfer department + salary today',()=>({employmentId:next().id,kind:'transfer',effectiveDate:today,departmentId:b.deptB,basicSalary:5100,remarks:'Fictional'})],
   ['transfer department + salary backdated',()=>({employmentId:next().id,kind:'transfer',effectiveDate:'2026-07-01',departmentId:b.deptB,basicSalary:5000,remarks:'Fictional'})],
   ['increment today',()=>({employmentId:next().id,kind:'increment',effectiveDate:today,basicSalary:5200,remarks:'Fictional'})],
   ['employmentTypeChange today',()=>({employmentId:next().id,kind:'employmentTypeChange',effectiveDate:today,employmentType:'part_time',remarks:'Fictional'})],
   ['entityTransfer today',()=>({employmentId:next().id,kind:'entityTransfer',effectiveDate:today,companyId:all[5],departmentId:depts[5],managerEmploymentId:null,remarks:'Fictional'})],
   ['confirmation today',()=>({employmentId:next().id,kind:'confirmation',effectiveDate:today,remarks:'Fictional'})],
   ['resignation future',()=>({employmentId:next().id,kind:'resignation',effectiveDate:'2027-01-31',resignationDate:today,remarks:'Fictional'})],
   ['termination today',()=>({employmentId:next().id,kind:'termination',effectiveDate:today,endDate:today,terminationReasonCode:'resignation',remarks:'Fictional'})],
  ];
  void other;
  const lines:string[]=[];
  try{
   for(const[name,input]of cases){
    const run=async(mode:'shared first'|'as today')=>{
     const t=performance.now();
     try{const held=await withTenant(ctx,async tx=>{
      await tx.execute(sql`select set_config('app.access_lock_strict','on',true)`);
      if(mode==='shared first')await lockAccessConfigurationTx(tx,ctx.tenantId);
      await createMovementEventTx(tx,ctx,input() as Parameters<typeof createMovementEventTx>[2]);
      const [row]=await tx.execute<{mode:string|null}>(sql`select app.access_lock_mode_held(${ctx.tenantId}::uuid) as mode`);
      throw Object.assign(new Error('probe-rollback'),{held:row?.mode});
     });void held;}
     catch(e){const err=e as Error&{held?:string};return err.message==='probe-rollback'?`ok, held ${err.held} (${Math.round(performance.now()-t)} ms)`:`refused: ${String(err.message).slice(0,160)}`;}
     return 'unexpected commit';
    };
    lines.push(`${name}: as today -> ${await run('as today')}; shared first -> ${await run('shared first')}`);
   }
  }finally{if(before===undefined)delete process.env.AIHR_ACCESS_LOCK_STRICT;else process.env.AIHR_ACCESS_LOCK_STRICT=before;}
  console.log('[write-path-profile] strict probe\n'+lines.join('\n'));
  expect(lines.length).toBe(cases.length);
 },600_000);
});
