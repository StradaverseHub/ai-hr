/** Migration 7230: the partial index on current assignments by department (ADR 0181 employment-visibility addendum,
 * step (b)). It is an index only, so the employee picker must return identical pages with and without it. This test
 * pins the installed definition, checks the current-assignment department probe uses it, and compares the picker for
 * a group administrator, a subtree administrator (claim) and a line manager on a fictional group of 70 companies,
 * 280 departments and 1,000 employments with superseded and ended assignment history, under "All companies" and one
 * company, with the index dropped and restored. Timings are logged for both. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {readEmployeeChoices} from '../core/employee-choice';
import {appUser} from '../db/schema';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const MIGRATION='db/migrations/7230_assignment_current_department_index.sql';
const DEFINITION='CREATE INDEX assignment_current_department_idx ON public.assignment USING btree (tenant_id, department_id) INCLUDE (employment_id) WHERE ((valid_to IS NULL) AND (superseded_at IS NULL) AND (department_id IS NOT NULL))';
let b:Base,companies:string[]=[],departments:string[]=[],leafCompany:string;
const actors:Record<string,SessionContext>={};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();
 // 70 fictional companies: the seed company, nine children and sixty grandchildren.
 const level1=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${b.tenantId}::uuid,'Fictional D'||g||' Sdn Bhd',${b.companyId}::uuid from generate_series(1,9) g returning id`).map(r=>r.id);
 const level2=(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${b.tenantId}::uuid,'Fictional D unit '||g||' Sdn Bhd',(${level1}::uuid[])[1+(g % 9)] from generate_series(1,60) g returning id`).map(r=>r.id);
 companies=[b.companyId,...level1,...level2];expect(companies).toHaveLength(70);
 leafCompany=level2[0];
 // Four departments per company.
 departments=(await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name)
  select ${b.tenantId}::uuid,c.id,'Fictional department '||k||'-'||g from unnest(${companies}::uuid[]) with ordinality c(id,k) cross join generate_series(1,4) g returning id`).map(r=>r.id);
 expect(departments).toHaveLength(280);
 // 1,000 employments; each has an ended assignment in another department, a superseded correction and a current one.
 await owner.client.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email)
   select $1::uuid,'Fictional DI '||lpad(g::text,4,'0'),'di-'||g||'@example.test' from generate_series(1,1000) g returning id),
  n as (select id,row_number() over (order by id) k from p),
  e as (insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
   select $1::uuid,n.id,($2::uuid[])[1+(n.k % 70)::int],'DI'||lpad(n.k::text,5,'0'),'2020-01-06' from n returning id,company_id),
  d as (select e.id,e.company_id,array_agg(x.id order by x.id) ds from e join department x on x.company_id=e.company_id group by e.id,e.company_id)
  insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from,valid_to,superseded_at)
  select $1::uuid,d.id,d.company_id,d.ds[1+(abs(hashtext(d.id::text)) % 4)],'full_time'::employment_type,'2025-01-01'::date,null::date,null::timestamptz from d
  union all select $1::uuid,d.id,d.company_id,d.ds[1+((abs(hashtext(d.id::text))+1) % 4)],'full_time'::employment_type,'2020-01-06','2024-12-31',null from d
  union all select $1::uuid,d.id,d.company_id,d.ds[1+((abs(hashtext(d.id::text))+2) % 4)],'full_time'::employment_type,'2025-01-01',null,now() from d`,[b.tenantId,`{${companies.join(',')}}`]);
 // A line manager in the top company (every other company descends from it, so no report is clamped away) with 30
 // current administrative reports across the group.
 const[manager]=await owner.client<{id:string;person_id:string}[]>`select id::text,person_id::text from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'DI%' and company_id=${b.companyId}::uuid order by employee_code limit 1`;
 const subordinates=await owner.client<{id:string}[]>`select id::text from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'DI%' and id<>${manager.id}::uuid order by employee_code limit 30`;
 await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from)
  select ${b.tenantId}::uuid,${manager.id}::uuid,s,'administrative','2025-01-01' from unnest(${subordinates.map(s=>s.id)}::uuid[]) s`;
 const[u]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:`fixture_${randomUUID()}`,personId:manager.person_id}).returning({id:appUser.id});
 Object.assign(actors,{
  'group administrator':{...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]},
  'subtree administrator':{...adminCtx(b),grants:[{role:'hr_admin',companyId:level1[0]}]},
  'line manager':{...adminCtx(b),userId:u.id,personId:manager.person_id,roles:['employee'],grants:[{role:'employee',companyId:null}]},
 } as Record<string,SessionContext>);
 await owner.client`analyze assignment`;await owner.client`analyze employment`;await owner.client`analyze department`;
},600_000);
afterAll(closeAll);

async function observeAll(){
 const out:Record<string,unknown>={};
 for(const[label,ctx]of Object.entries(actors))for(const scope of [[],[leafCompany]] as string[][]){
  const page=await readEmployeeChoices(ctx,{companyIds:scope,limit:25});
  const{contextId:_contextId,...rest}=page;
  out[`${label} / ${scope.length?'one company':'All companies'}`]=rest;
 }
 return out;
}

it('installs exactly the reviewed partial index, and the current department probe uses it',async()=>{
 const[row]=await owner.client<{indexdef:string}[]>`select indexdef from pg_indexes where schemaname='public' and indexname='assignment_current_department_idx'`;
 expect(row?.indexdef).toBe(DEFINITION);
 await owner.client.begin(async tx=>{
  // Planner choice on a small fixture: make the comparison about access paths, not table size.
  await tx`set local enable_seqscan=off`;
  const plan=(await tx.unsafe(`explain (costs off) select a.employment_id from assignment a where a.tenant_id='${b.tenantId}' and a.valid_to is null and a.superseded_at is null and a.department_id='${departments[0]}'`)).map((r:Record<string,string>)=>r['QUERY PLAN']).join('\n');
  expect(plan).toContain('assignment_current_department_idx');
 });
},120_000);

it('returns identical picker pages with and without the index for every actor and scope',async()=>{
 let t=performance.now();const withIndex=await observeAll();const withMs=Math.round(performance.now()-t);
 // Not vacuous: the group administrator sees every department with a current member, and the manager sees a page.
 const group=withIndex['group administrator / All companies'] as {total:number;allDepartmentOptions:unknown[]};
 expect(group.total).toBeGreaterThanOrEqual(1000);expect(group.allDepartmentOptions.length).toBeGreaterThan(200);
 // Self, 30 reports, and the department-head arm's colleagues in the manager's own department.
 expect((withIndex['line manager / All companies'] as {total:number}).total).toBeGreaterThanOrEqual(31);
 const statement=readFileSync(MIGRATION,'utf8').split('--> statement-breakpoint')[1].trim();
 await owner.client`drop index assignment_current_department_idx`;
 let withoutMs=0,without:Record<string,unknown>;
 try{t=performance.now();without=await observeAll();withoutMs=Math.round(performance.now()-t);}
 finally{await owner.client.unsafe(statement);}
 expect(without).toEqual(withIndex);
 const[restored]=await owner.client<{indexdef:string}[]>`select indexdef from pg_indexes where schemaname='public' and indexname='assignment_current_department_idx'`;
 expect(restored?.indexdef).toBe(DEFINITION);
 console.log(`[assignment-current-department-index] ${Object.keys(withIndex).length} observations, ms ${JSON.stringify({withIndex:withMs,withoutIndex:withoutMs})}`);
},600_000);
