/** Shared fixture for the 7240 tests (precomputed employment visibility, docs/adr/0181-addendum-precomputed-employment-
 * visibility.md section 7): the 7210 pilot fixture (70 fictional companies in a three-level tree, 1,000 employments,
 * its administrator actors) plus
 *  * an administrative tree over the 1,000 employments (EQ k reports to EQ k/2, depth about 10), with a second current
 *    manager (EQ7 -> EQ500), a cycle (EQ9 -> EQ2), a terminated intermediate manager (EQ6), a future termination
 *    (EQ13), a line starting tomorrow (EQ20 -> EQ900), a line ending tomorrow (EQ15 -> EQ30), a superseded line
 *    (EQ40 -> EQ950) and a delegate line (EQ50 -> EQ51); many hops leave the root's company subtree (clamp);
 *  * three departments per company (two-deep chain), a five-deep chain in the top company, a cross-company child under
 *    the top company (admitted) and one under another tree (clamped away); every employment has a current assignment
 *    plus ended and superseded history;
 *  * a person with two employments in different companies, a voided and an import-pending employment under EQ1;
 *  * manager, department-head and partner actors, and one user for every tenth employment (the wide comparison).
 * Each test file runs in its own worker database. */
import {expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {readEmployeeChoices} from '../core/employee-choice';
import {owner} from './harness';
import {actors,b,beta,buildFixture,day,leaf,user} from './access-effective-company-fixture';

export {actors,b,day};
export const MODES=['legacy','shadow','precomputed'] as const;
export type Mode=typeof MODES[number];
export const eq=(k:number)=>'EQ'+String(k).padStart(5,'0');
export let byCode:Map<string,{id:string;person:string;company:string}>;
export let sampleUsers:string[]=[];
export let managerUsers:Record<string,string>={};

const MIGRATION=readFileSync('db/migrations/7240_access_visible_employment.sql','utf8');
const constant=(name:string)=>{const m=MIGRATION.match(new RegExp(`${name} constant text := \\$q\\$([\\s\\S]*?)\\$q\\$;`));if(!m)throw Error(name);return m[1];};
/** The predecessors 7240 replaced: the 5144 function statement and the reviewed policy texts. */
const PREVIOUS_FUNCTION=(()=>{const s=readFileSync('db/migrations/5144_attendance_lane_security_review.sql','utf8');const i=s.indexOf('CREATE OR REPLACE FUNCTION app.visible_employment_ids()');return s.slice(i,s.indexOf('$$;',s.indexOf('AS $$',i)+5)+3);})();
const PREVIOUS={employment:constant('emp_pred'),person:constant('person_pred')};
let installed:{fn:string;employment:string;person:string};

export async function setMode(mode:Mode){await owner.client`select app.access_visible_employment_set_mode(${mode})`;}
export async function useVisibility(kind:'old'|'new'){
 await owner.client.begin(async tx=>{
  await tx.unsafe(kind==='old'?PREVIOUS_FUNCTION:installed.fn);
  await tx.unsafe(`alter policy employment_rls on public.employment using (${kind==='old'?PREVIOUS.employment:installed.employment})`);
  await tx.unsafe(`alter policy person_rls on public.person using (${kind==='old'?PREVIOUS.person:installed.person})`);
 });
}

async function line(m:number|string,s:number|string,extra:{from?:string;to?:string|null;type?:string;superseded?:boolean}={}){
 const id=(x:number|string)=>typeof x==='number'?byCode.get(eq(x))!.id:x;
 await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from,valid_to,superseded_at)
  values(${b.tenantId}::uuid,${id(m)}::uuid,${id(s)}::uuid,${extra.type??'administrative'},${extra.from??'2025-01-06'}::date,${extra.to??null}::date,${extra.superseded?new Date().toISOString():null}::timestamptz)`;
}

export async function buildVisibilityFixture(){
 await buildFixture();
 const rows=await owner.client<{code:string;id:string;person:string;company:string}[]>`select employee_code as code,id::text,person_id::text as person,company_id::text as company
  from employment where tenant_id=${b.tenantId}::uuid and employee_code like 'EQ0%' order by employee_code`;
 byCode=new Map(rows.map(r=>[r.code,{id:r.id,person:r.person,company:r.company}]));
 // The tree: EQ k reports to EQ floor(k/2), in one statement (as an import would).
 await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from)
  select ${b.tenantId}::uuid,m.id,s.id,'administrative','2025-01-06' from employment s
  join employment m on m.tenant_id=s.tenant_id and m.employee_code='EQ'||lpad((substr(s.employee_code,3)::int/2)::text,5,'0')
  where s.tenant_id=${b.tenantId}::uuid and s.employee_code like 'EQ0%' and substr(s.employee_code,3)::int>=2`;
 await line(7,500);await line(9,2);await line(20,900,{from:day(1)});await line(40,950,{superseded:true});await line(50,51,{type:'delegate'});
 await owner.client`update reporting_line set valid_to=${day(1)}::date where subordinate_employment_id=${byCode.get(eq(30))!.id}::uuid`;
 await owner.client`update employment set terminated_on=${day(-1)}::date where id=${byCode.get(eq(6))!.id}::uuid`;
 await owner.client`update employment set terminated_on=${day(1)}::date where id=${byCode.get(eq(13))!.id}::uuid`;
 // Departments: three per company (D0 > D1 > D2), D3 > D4 below the top company's D2, a cross-company child of the
 // top company's D0 in the leaf company (admitted) and a child of its D2 in the Beta tree (clamped away).
 await owner.client.unsafe(`
  with c as (select id,row_number() over (order by id) k from company where tenant_id=$1::uuid),
  d0 as (insert into department(tenant_id,company_id,name) select $1::uuid,c.id,'Fictional D0 '||c.k from c returning id,company_id),
  d1 as (insert into department(tenant_id,company_id,name,parent_department_id) select $1::uuid,d0.company_id,'Fictional D1',d0.id from d0 returning id,company_id)
  insert into department(tenant_id,company_id,name,parent_department_id) select $1::uuid,d1.company_id,'Fictional D2',d1.id from d1`,[b.tenantId]);
 const dept=async(company:string,name:string)=>(await owner.client<{id:string}[]>`select id::text from department where company_id=${company}::uuid and name=${name} limit 1`)[0].id;
 const rootD2=await dept(b.companyId,'Fictional D2'),rootD0=await dept(b.companyId,(await owner.client<{n:string}[]>`select name as n from department where company_id=${b.companyId}::uuid and name like 'Fictional D0%' limit 1`)[0].n);
 const[d3]=await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name,parent_department_id) values(${b.tenantId}::uuid,${b.companyId}::uuid,'Fictional D3',${rootD2}::uuid) returning id::text`;
 await owner.client`insert into department(tenant_id,company_id,name,parent_department_id) values(${b.tenantId}::uuid,${b.companyId}::uuid,'Fictional D4',${d3.id}::uuid)`;
 await owner.client`insert into department(tenant_id,company_id,name,parent_department_id) values(${b.tenantId}::uuid,${leaf}::uuid,'Fictional cross-company',${rootD0}::uuid)`;
 await owner.client`insert into department(tenant_id,company_id,name,parent_department_id) values(${b.tenantId}::uuid,${beta}::uuid,'Fictional clamped',${rootD2}::uuid)`;
 // Assignments: current (in one of the company's departments, deeper ones for the top company), ended, superseded.
 await owner.client.unsafe(`
  with e as (select id,company_id,substr(employee_code,3)::int k from employment where tenant_id=$1::uuid and employee_code like 'EQ0%'),
  d as (select e.id,e.company_id,array_agg(x.id order by x.name,x.id) ds from e join department x on x.company_id=e.company_id group by e.id,e.company_id)
  insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from,valid_to,superseded_at)
  select $1::uuid,d.id,d.company_id,d.ds[1+(abs(hashtext(d.id::text)) % cardinality(d.ds))],'full_time'::employment_type,'2025-01-06'::date,null::date,null::timestamptz from d
  union all select $1::uuid,d.id,d.company_id,d.ds[1+((abs(hashtext(d.id::text))+1) % cardinality(d.ds))],'full_time'::employment_type,'2024-01-06'::date,'2025-01-05'::date,null::timestamptz from d
  union all select $1::uuid,d.id,d.company_id,d.ds[1+((abs(hashtext(d.id::text))+2) % cardinality(d.ds))],'full_time'::employment_type,'2025-01-06'::date,null::date,now() from d`,[b.tenantId]);
 // A second employment for EQ3's person, in the Beta tree, managing EQ999.
 const[second]=await owner.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) values(${b.tenantId}::uuid,${byCode.get(eq(3))!.person}::uuid,${beta}::uuid,'EQSECOND','2025-01-06') returning id::text`;
 await line(second.id,999);
 // A voided and an import-pending employment, both reporting to EQ1.
 const people=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'Fictional EV '||g,'ev-'||g||'@example.test' from generate_series(1,2) g returning id::text`;
 const[voided]=await owner.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,voided_at,voided_by,void_reason,voided_import_attempt_id,voided_employee_code)
  values(${b.tenantId}::uuid,${people[0].id}::uuid,${b.companyId}::uuid,null,'2025-01-06',now(),${b.adminUserId}::uuid,'Fictional void',${randomUUID()}::uuid,'EQVOID') returning id::text`;
 const[pending]=await owner.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,import_pending_attempt_id)
  values(${b.tenantId}::uuid,${people[1].id}::uuid,${b.companyId}::uuid,'EQPENDING','2025-01-06',${randomUUID()}::uuid) returning id::text`;
 await line(1,voided.id);await line(1,pending.id);
 // Actors: managers and department heads (their persons), and the two partners.
 for(const k of [1,2,3,5,6,15,20,100,999]){
  const ctx=await user('employee',null,byCode.get(eq(k))!.person);
  actors[`manager EQ${k}`]=ctx;managerUsers[eq(k)]=ctx.userId!;
 }
 for(const role of ['payroll_partner','performance_comp_partner'] as const){
  const[u]=await owner.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id) values(${b.tenantId}::uuid,${'fixture_'+randomUUID()}) returning id::text`;
  await owner.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${b.tenantId}::uuid,${u.id}::uuid,${role},null)`;
  actors[role.replaceAll('_',' ')]={tenantId:b.tenantId,userId:u.id,roles:[role],grants:[{role,companyId:null}]} as SessionContext;
 }
 // One user for every tenth employment's person, for the wide relationship comparison.
 sampleUsers=(await owner.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id,person_id)
  select ${b.tenantId}::uuid,'fixture_'||gen_random_uuid(),e.person_id from employment e
  where e.tenant_id=${b.tenantId}::uuid and e.employee_code like 'EQ0%' and substr(e.employee_code,3)::int % 10=0
   and not exists(select 1 from app_user u where u.person_id=e.person_id) returning id::text`).map(r=>r.id);
 // The writes above maintained the stored rows through the triggers; capture the installed 7240 objects.
 const[fn]=await owner.client<{d:string}[]>`select pg_get_functiondef('app.visible_employment_ids()'::regprocedure) as d`;
 const[emp]=await owner.client<{q:string}[]>`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.employment'::regclass and polname='employment_rls'`;
 const[per]=await owner.client<{q:string}[]>`select pg_get_expr(polqual,polrelid) as q from pg_policy where polrelid='public.person'::regclass and polname='person_rls'`;
 installed={fn:fn.d,employment:emp.q,person:per.q};
}

export const settle=async<T>(fn:()=>Promise<T>):Promise<T|{error:string}>=>{try{return await fn();}catch(e){return{error:(e as Error).message};}};
/** What one actor can see through employment visibility, in its own order. */
export async function observe(ctx:SessionContext){
 const raw=await settle(()=>withTenant(ctx,async tx=>{
  const[v]=await tx.execute<{e:string[];p:string[]}>(sql`select app.visible_employment_ids()::text[] as e,app.visible_person_ids()::text[] as p`);
  const ids=async(q:ReturnType<typeof sql>)=>(await tx.execute<{id:string}>(q)).map(r=>r.id);
  return{visible:v.e,persons:v.p,
   employment:await ids(sql`select id::text as id from employment order by id`),
   person:await ids(sql`select id::text as id from person order by id`),
   assignment:await ids(sql`select id::text as id from assignment order by id`)};
 }));
 const picker=await settle(async()=>{const{contextId:_c,...rest}=await readEmployeeChoices(ctx,{companyIds:[],limit:25});return rest;});
 return{raw,picker};
}
export type Observation=Awaited<ReturnType<typeof observe>>;
export async function observeAll(){const out:Record<string,Observation>={};for(const[label,ctx]of Object.entries(actors))out[label]=await observe(ctx);return out;}
/** Previous function and policies first, then 7240 in each mode: identical observations for every actor. */
export async function expectEquivalent(phase:string,modes:readonly Mode[]=MODES){
 await useVisibility('old');
 let t=performance.now();const before=await observeAll();const timings:Record<string,number>={old:Math.round(performance.now()-t)};
 await useVisibility('new');
 for(const mode of modes){
  await setMode(mode);t=performance.now();const after=await observeAll();timings[mode]=Math.round(performance.now()-t);
  for(const key of Object.keys(before))expect(after[key],`${phase} · ${mode} · ${key}`).toEqual(before[key]);
 }
 await setMode('legacy');
 console.log(`[access-visible-employment] ${phase}: ${Object.keys(before).length} actors, ms ${JSON.stringify(timings)}`);
 return before;
}
/** For each user: the legacy walk and the stored answer, as the owner in one transaction per user. */
export async function relationshipDifferences(users:string[]):Promise<string[]>{
 const differing:string[]=[];
 for(const u of users){
  const same=await owner.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${u},true)`;
   const[r]=await tx<{same:boolean}[]>`select app.access_visible_employment_legacy()=app.access_visible_employment_stored() as same`;return r.same;
  });
  if(!same)differing.push(u);
 }
 return differing;
}
export async function unusable(userId:string):Promise<string|null>{
 return owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${userId},true)`;
  const[r]=await tx<{reason:string|null}[]>`select app.access_visible_employment_unusable() as reason`;return r.reason;
 });
}
export const stateRow=async()=>(await owner.client<{version:string;computed_for:string|null;valid_until:string|null;stale:boolean;trusted:boolean}[]>`
 select access_version::text as version,computed_for::text,valid_until::text,stale,trusted from access_employment_state where tenant_id=${b.tenantId}::uuid`)[0];
