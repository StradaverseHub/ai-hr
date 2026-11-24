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
import {client,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {amendDirectSuperior} from '../core/information-correction';
import {createMovementEvent} from '../core/movement';
import {hireEmployee} from '../core/org';
import {correctDirectSuperiorPeriod} from '../core/direct-superior-periods';
import {directSuperiorPeriodsFor} from '../core/read';
import {reviewReprocessTaxReadiness} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

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
 const ADMIN=adminCtx(b);
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
  let n=0;const subject=()=>emp.filter(e=>e.company!==b.companyId)[40+(n++)*7];
  const out:string[]=[];
  for(const[label,ctx]of Object.entries(actors)){
   const a=subject(),m=emp.find(e=>e.company===a.company&&e.id!==a.id&&e.k!==a.k&&e.k>a.k)??emp.find(e=>e.company===a.company&&e.id!==a.id)!;
   out.push((await profile(`${label} · amend direct superior`,()=>amendDirectSuperior(ctx,{employmentId:a.id,managerEmploymentId:m.id,reason:'Fictional correction',expectedLineId:null}))).line);
   const c=subject(),cm=emp.find(e=>e.company===c.company&&e.id!==c.id)!;
   out.push((await profile(`${label} · direct superior movement today`,()=>createMovementEvent(ctx,{employmentId:c.id,managerEmploymentId:cm.id,effectiveDate:today,remarks:'Fictional change',kind:'reportingLineChange'}))).line);
   const d=subject(),dm=emp.find(e=>e.company===d.company&&e.id!==d.id)!;
   out.push((await profile(`${label} · direct superior movement backdated`,()=>createMovementEvent(ctx,{employmentId:d.id,managerEmploymentId:dm.id,effectiveDate:'2026-06-01',remarks:'Fictional change',kind:'reportingLineChange'}))).line);
   const t=subject();
   out.push((await profile(`${label} · transfer with salary today`,()=>createMovementEvent(ctx,{employmentId:t.id,kind:'transfer',effectiveDate:today,basicSalary:4800,remarks:'Fictional transfer'}))).line);
   const u=subject();
   out.push((await profile(`${label} · transfer with salary backdated`,()=>createMovementEvent(ctx,{employmentId:u.id,kind:'transfer',effectiveDate:'2026-07-01',basicSalary:4700,remarks:'Fictional transfer'}))).line);
   const p=subject();
   const periods=await directSuperiorPeriodsFor(ctx,p.id).catch(()=>null) as unknown as {revision?:string;periods?:{id:string;validFrom:string}[]}|null;
   const line=periods?.periods?.[0];const pm=emp.find(e=>e.company===p.company&&e.id!==p.id&&e.k!==emp.find(x=>x.company===p.company)?.k)!;
   if(line&&periods?.revision)out.push((await profile(`${label} · correct direct superior period`,()=>correctDirectSuperiorPeriod(ctx,{employmentId:p.id,reason:'Fictional correction',revision:periods.revision!,lineId:line.id,operation:'edit',managerEmploymentId:pm.id,validFrom:line.validFrom,validToInclusive:null} as Parameters<typeof correctDirectSuperiorPeriod>[1]))).line);
   else out.push(`[write-path-profile] ${label} · correct direct superior period: no period shape ${JSON.stringify(periods)?.slice(0,200)}`);
   const ids=emp.filter(e=>e.company===b.companyId).map(e=>e.id);
   out.push((await profile(`${label} · reprocess tax review (300 employees)`,()=>reviewReprocessTaxReadiness(ctx,processedRoot,ids))).line);
  }
  expect(out.length).toBeGreaterThanOrEqual(10);
 },900_000);
});
