/** Audit Trail company scope, Phase 1 (ADR-0182, owner decision 25 Nov 2026, migration 7360).
 *
 * A fictional group of 72 companies (a scoped administrator's company with a child company, a foreign company, and
 * filler companies) holding 1,000+ employments, with audit events of every anchor kind on both sides of the scope.
 * Every read runs as ai_hr_app under row security; fixture rows are written by the migration owner.
 *  - A company-scoped hr_admin sees exactly the in-scope events (subject employment, payload companyId, the company,
 *    a company-owned row, a login account of someone employed there, their own actions), never the others, in the
 *    list, the count, the record-type / user / company filters, the per-employee History and every download format.
 *  - Group administrators and super administrators see exactly what the previous reader returned (same rows, order,
 *    counts); a non-administrator is unchanged (row security alone decides).
 *  - An employee who moved companies follows their CURRENT company (owner decision 3); a child company is in scope.
 * Expected sets are computed independently from the fixture, never from the reader under test. */
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({session:undefined as unknown,serialized:[] as {format:string;rows:unknown[][]}[]}));
vi.mock('../lib/session',async importOriginal=>({...(await importOriginal<typeof import('../lib/session')>()),getSession:async()=>state.session}));
vi.mock('../lib/report-export',async importOriginal=>{
 const actual=await importOriginal<typeof import('../lib/report-export')>();
 return {...actual,serializeReport:(d:Parameters<typeof actual.serializeReport>[0],format:Parameters<typeof actual.serializeReport>[1])=>{
  state.serialized.push({format,rows:d.rows as unknown[][]});return actual.serializeReport(d,format);}};
});
vi.mock('next/cache',()=>({revalidatePath:()=>{},revalidateTag:()=>{}}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}));
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {auditActors,auditAggregateTypes,auditCompanyScope,auditEvents,auditEventsCount,employeeAudit,listCompanies} from '../core/read';
import {GET as exportAudit} from '../app/admin/audit/export/route';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const M=`scope${randomUUID().slice(0,8)}`;
let b:Base,root:string,child:string,foreign:string,fillers:string[],all:string[];
let foreignDept:string,localSubject:Emp,childSubject:Emp,foreignSubject:Emp,mover:Emp;
let localLogin:string,foreignLogin:string;
let scoped:SessionContext,group:SessionContext,superAdmin:SessionContext,foreignActor:SessionContext,employee:SessionContext;
type Emp={employmentId:string;personId:string};
const companyOf=new Map<string,string>(); // employment id -> company id, as the fixture assigned it
const scaleEvents:{id:string;employmentId?:string;companyId?:string}[]=[];
const IN_SCOPE=['local-subject','child-subject','local-payload','child-payload','local-company','local-department','local-login','own-group','mover','local-person'];
const OUT_OF_SCOPE=['foreign-subject','foreign-payload','foreign-company','foreign-department','foreign-login','group-level','group-null-company','foreign-person'];

async function user(role:'hr_admin'|'super_admin'|'employee',companyId:string|null,personId:string|null=null):Promise<SessionContext>{
 const[u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`scope_${randomUUID()}`,personId}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
 return{...adminCtx(b),userId:u.id,personId:personId??undefined,roles:[role],grants:[{role,companyId}]} as SessionContext;
}
async function employ(name:string,companyId:string):Promise<Emp>{
 const[p]=await owner.client<{id:string}[]>`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${`${randomUUID()}@example.test`}) returning id`;
 const[e]=await owner.client<{id:string}[]>`insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  values(${b.tenantId}::uuid,${p.id}::uuid,${companyId}::uuid,${'SC'+randomUUID().slice(0,8)},'2025-01-06') returning id`;
 companyOf.set(e.id,companyId);return{employmentId:e.id,personId:p.id};
}
async function event(key:string,e:{aggregateType:string;aggregateId:string;subject?:string;payload?:unknown;actor?:string}){
 await owner.client`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload,subject_employment_id)
  values(${b.tenantId}::uuid,${e.aggregateType},${e.aggregateId}::uuid,${`${M}.${key}`},'user',${e.actor??null}::uuid,${JSON.stringify(e.payload??{})}::jsonb,${e.subject??null}::uuid)`;
}
const keysOf=(rows:{eventType:string}[])=>rows.filter(r=>r.eventType.startsWith(M+'.')).map(r=>r.eventType.slice(M.length+1)).sort();
/** The reader this change replaces, verbatim: the same select, join and order with no company scope. */
async function previousReader(ctx:SessionContext,limit=2000,offset=0):Promise<string[]>{
 return withTenant(ctx,async tx=>(await tx.execute<{id:string}>(sql`select d.id::text as id from domain_event d
  left join app_user u on u.id=d.actor_id left join person p on p.id=u.person_id
  order by d.occurred_at desc, d.sequence desc limit ${limit} offset ${offset}`)).map(r=>r.id));
}
async function previousCount(ctx:SessionContext):Promise<number>{
 return withTenant(ctx,async tx=>Number((await tx.execute<{n:number}>(sql`select count(*)::int as n from domain_event`))[0].n));
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();root=b.companyId;
 const ins=async(names:string[],parents:(string|null)[])=>(await owner.client<{id:string}[]>`insert into company(tenant_id,legal_name,parent_company_id)
  select ${b.tenantId}::uuid,n,p from unnest(${names}::text[],${parents}::uuid[]) with ordinality x(n,p,k) order by k returning id`).map(r=>r.id);
 [child,foreign]=await ins(['Fictional Child Sdn Bhd','Fictional Foreign Bhd'],[root,null]);
 fillers=await ins(Array.from({length:69},(_,i)=>`Fictional Filler ${i+1} Sdn Bhd`),Array.from({length:69},(_,i)=>i%2?foreign:null));
 all=[root,child,foreign,...fillers];expect(all).toHaveLength(72);
 [{id:foreignDept}]=await owner.client<{id:string}[]>`insert into department(tenant_id,company_id,name) values(${b.tenantId}::uuid,${foreign}::uuid,'FICTIONAL-FOREIGN') returning id`;
 localSubject=await employ('Fictional local subject',root);childSubject=await employ('Fictional child subject',child);
 foreignSubject=await employ('Fictional foreign subject',foreign);mover=await employ('Fictional mover',foreign);
 // 1,000 fictional employments spread over the 72 companies, one subject event each, and one company event per company.
 const bulk=await owner.client<{id:string;company_id:string}[]>`with p as (insert into person(tenant_id,full_name,primary_email)
   select ${b.tenantId}::uuid,'Fictional scope '||g,'scope-'||g||'-'||${M}||'@example.test' from generate_series(1,1000) g returning id),
  n as (select id,row_number() over (order by id) k from p)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
  select ${b.tenantId}::uuid,n.id,(${all}::uuid[])[1+(n.k % 72)::int],'SCB'||lpad(n.k::text,5,'0'),'2025-01-06' from n returning id::text,company_id::text`;
 expect(bulk).toHaveLength(1000);for(const r of bulk)companyOf.set(r.id,r.company_id);
 for(const r of await owner.client<{id:string;employment_id:string}[]>`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload,subject_employment_id)
   select ${b.tenantId}::uuid,'employment',e,${M+'-scale.subject'},'system','{}'::jsonb,e from unnest(${bulk.map(r=>r.id)}::uuid[]) e returning id::text,subject_employment_id::text as employment_id`)
  scaleEvents.push({id:r.id,employmentId:r.employment_id});
 for(const r of await owner.client<{id:string;company_id:string}[]>`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
   select ${b.tenantId}::uuid,'pay-component',gen_random_uuid(),${M+'-scale.company'},'system',jsonb_build_object('companyId',c) from unnest(${all}::uuid[]) c returning id::text,payload->>'companyId' as company_id`)
  scaleEvents.push({id:r.id,companyId:r.company_id});

 scoped=await user('hr_admin',root);group={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
 superAdmin=await user('super_admin',null);/* super_admin grants are group-wide by constraint */foreignActor=await user('hr_admin',foreign);
 employee=await user('employee',null,localSubject.personId);localLogin=employee.userId!;
 const foreignEmployee=await user('employee',null,foreignSubject.personId);foreignLogin=foreignEmployee.userId!;

 await event('local-subject',{aggregateType:'employment',aggregateId:localSubject.employmentId,subject:localSubject.employmentId});
 await event('child-subject',{aggregateType:'employment',aggregateId:childSubject.employmentId,subject:childSubject.employmentId});
 await event('local-payload',{aggregateType:'pay-component',aggregateId:randomUUID(),payload:{companyId:root}});
 await event('child-payload',{aggregateType:'pay-component',aggregateId:randomUUID(),payload:{companyId:child}});
 await event('local-company',{aggregateType:'company',aggregateId:root});
 await event('local-department',{aggregateType:'department',aggregateId:b.deptA});
 await event('local-login',{aggregateType:'app-user',aggregateId:localLogin});
 await event('own-group',{aggregateType:'tenant-setting',aggregateId:b.tenantId,actor:scoped.userId});
 await event('mover',{aggregateType:'employment',aggregateId:mover.employmentId,subject:mover.employmentId,payload:{note:'written while in the foreign company'}});
 await event('local-person',{aggregateType:'person',aggregateId:localSubject.personId});
 await event('foreign-subject',{aggregateType:'employment',aggregateId:foreignSubject.employmentId,subject:foreignSubject.employmentId,payload:{note:'foreign-secret'}});
 await event('foreign-payload',{aggregateType:'probe-foreign-only',aggregateId:randomUUID(),payload:{companyId:foreign,note:'foreign-secret'},actor:foreignActor.userId});
 await event('foreign-company',{aggregateType:'company',aggregateId:foreign,payload:{companyId:foreign}});
 await event('foreign-department',{aggregateType:'department',aggregateId:foreignDept});
 await event('foreign-login',{aggregateType:'app-user',aggregateId:foreignLogin});
 await event('group-level',{aggregateType:'tenant-setting',aggregateId:b.tenantId,actor:group.userId});
 await event('group-null-company',{aggregateType:'attendance-recompute',aggregateId:randomUUID(),payload:{companyId:null}});
 await event('foreign-person',{aggregateType:'person',aggregateId:foreignSubject.personId});
 // Owner decision 3: the mover's employment is now in the scoped administrator's company.
 await owner.client`update employment set company_id=${root}::uuid where id=${mover.employmentId}::uuid`;companyOf.set(mover.employmentId,root);
},180_000); // builds 72 companies and 1,000 employments; about 10 s on a hosted runner, 3x headroom plus migrations
afterAll(closeAll);

describe('Audit Trail company scope for a company-scoped HR administrator',()=>{
 it('lists exactly the in-scope events, in ledger order, and the count agrees',async()=>{
  const rows=await auditEvents(scoped,{limit:2000});
  expect(keysOf(rows)).toEqual([...IN_SCOPE].sort());
  for(const r of rows)expect(JSON.stringify(r.payload)).not.toContain('foreign-secret');
  const inScope=new Set([root,child]);
  const expectedScale=scaleEvents.filter(e=>e.employmentId?inScope.has(companyOf.get(e.employmentId)!):inScope.has(e.companyId!)).map(e=>e.id).sort();
  expect(expectedScale.length).toBeGreaterThan(20);
  expect(rows.filter(r=>r.eventType.startsWith(M+'-scale.')).map(r=>r.id).sort()).toEqual(expectedScale);
  const ordered=await owner.client<{id:string}[]>`select id::text from domain_event where id=any(${rows.map(r=>r.id)}::uuid[]) order by occurred_at desc,sequence desc`;
  expect(rows.map(r=>r.id)).toEqual(ordered.map(r=>r.id));
  expect(await auditEventsCount(scoped,{})).toBe(rows.length);
  expect((await auditEvents(scoped,{limit:25,offset:25})).map(r=>r.id)).toEqual(rows.slice(25,50).map(r=>r.id));
 });
 it('scopes the company, record-type and user filters',async()=>{
  expect(keysOf(await auditEvents(scoped,{companyId:foreign,limit:500}))).toEqual([]);
  expect(await auditEventsCount(scoped,{companyId:foreign})).toBe(0);
  expect(keysOf(await auditEvents(scoped,{companyId:root,limit:500}))).toEqual(['local-payload']);
  expect(keysOf(await auditEvents(scoped,{aggregateType:'department',limit:500}))).toEqual(['local-department']);
  expect(keysOf(await auditEvents(scoped,{actorId:foreignActor.userId,limit:500}))).toEqual([]);
  const offered=(await listCompanies(scoped,{adminOnly:true})).map(c=>c.id).sort();
  expect(offered).toEqual([root,child].sort());
  expect((await listCompanies(group,{adminOnly:true})).map(c=>c.id).sort()).toEqual([...all].sort());
  const types=(await auditAggregateTypes(scoped)).map(t=>t.aggregateType);
  expect(types).toContain('department');expect(types).not.toContain('probe-foreign-only');
  expect((await auditAggregateTypes(group)).map(t=>t.aggregateType)).toContain('probe-foreign-only');
  const actors=(await auditActors(scoped)).map(a=>a.actorId);
  expect(actors).toContain(scoped.userId);expect(actors).not.toContain(foreignActor.userId);
 });
 it('keeps the per-employee History for an authorized subject and refuses a foreign one',async()=>{
  expect(keysOf(await employeeAudit(scoped,localSubject.employmentId,500))).toEqual(['local-person','local-subject']);
  expect(keysOf(await employeeAudit(scoped,mover.employmentId,500))).toEqual(['mover']);
  expect(await employeeAudit(scoped,foreignSubject.employmentId,500)).toEqual([]);
  expect(await auditEventsCount(scoped,{employmentId:foreignSubject.employmentId})).toBe(0);
 });
 it('scopes every download format',async()=>{
  state.session=scoped;
  for(const format of ['csv','xlsx','pdf'] as const){
   state.serialized=[];
   const res=await exportAudit(new Request(`http://localhost/admin/audit/export?format=${format}`));
   expect(res.status).toBe(200);
   expect(state.serialized.map(x=>x.format)).toEqual([format]);
   const events=state.serialized[0].rows.map(r=>String(r[4])).filter(e=>e.startsWith(M+'.')).map(e=>e.slice(M.length+1)).sort();
   expect(events,format).toEqual([...IN_SCOPE].sort());
   const body=format==='csv'?await res.text():'';
   if(format==='csv'){expect(body).toContain(`${M}.local-subject`);expect(body).not.toContain('foreign-secret');for(const k of OUT_OF_SCOPE)expect(body).not.toContain(`${M}.${k},`);}
  }
  state.session=group;state.serialized=[];
  expect((await exportAudit(new Request('http://localhost/admin/audit/export?format=csv'))).status).toBe(200);
  const groupEvents=state.serialized[0].rows.map(r=>String(r[4])).filter(e=>e.startsWith(M+'.')).map(e=>e.slice(M.length+1)).sort();
  expect(groupEvents).toEqual([...IN_SCOPE,...OUT_OF_SCOPE].sort());
 });
});

describe('Unchanged readers',()=>{
 it('group administrators and super administrators read exactly what the previous reader returned',async()=>{
  for(const ctx of [group,superAdmin]){
   const before=await previousReader(ctx),after=(await auditEvents(ctx,{limit:2000})).map(r=>r.id);
   expect(after.length).toBeGreaterThan(1090);expect(after).toEqual(before);
   expect(await auditEventsCount(ctx,{})).toBe(await previousCount(ctx));
   expect((await auditEvents(ctx,{limit:50,offset:50})).map(r=>r.id)).toEqual(await previousReader(ctx,50,50));
   expect(keysOf(await auditEvents(ctx,{limit:2000}))).toEqual([...IN_SCOPE,...OUT_OF_SCOPE].sort());
  }
 });
 it('a non-administrator is decided by row security alone, as before',async()=>{
  const before=await previousReader(employee),after=(await auditEvents(employee,{limit:2000})).map(r=>r.id);
  expect(after).toEqual(before);expect(await auditEventsCount(employee,{})).toBe(await previousCount(employee));
  expect(keysOf(await auditEvents(employee,{limit:2000}))).toEqual(['local-subject']);
 });
 it('evaluates the scope once per statement at group size (timings logged)',async()=>{
  const time=async(label:string,f:()=>Promise<unknown>)=>{const t=performance.now();await f();const ms=Math.round(performance.now()-t);console.log(`[audit-scope] ${label}: ${ms} ms`);return ms;};
  await auditEvents(scoped,{limit:25});await auditEvents(group,{limit:25}); // warm the pool and plans
  await time('one company, first page',()=>auditEvents(scoped,{limit:25}));
  await time('one company, count',()=>auditEventsCount(scoped,{}));
  await time('one company, user filter',()=>auditActors(scoped));
  await time('all companies (group), first page',()=>auditEvents(group,{limit:25}));
  await time('all companies (group), count',()=>auditEventsCount(group,{}));
  const explain=(predicate:ReturnType<typeof sql>)=>withTenant(scoped,async tx=>(await tx.execute<{'QUERY PLAN':string}>(sql`explain (costs off) select count(*) from domain_event where ${predicate}`)).map(r=>r['QUERY PLAN']).join('\n'));
  const baseline=await explain(sql`true`);
  const plan=await explain(auditCompanyScope());
  console.log('[audit-scope] plan\n'+plan);
  // The anchor sets are uncorrelated: each runs once (InitPlan or hashed SubPlan), never once per event row. The
  // existing restrictive policies already carry their own correlated sub-selects (e.g. 4342's clock-policy check,
  // evaluated only for that event type), so the scope must add hashed sub-plans and no correlated one.
  const correlated=(text:string)=>(text.match(/\(SubPlan \d+\)/g)??[]).length;
  const hashed=(text:string)=>(text.match(/hashed SubPlan \d+/g)??[]).length;
  expect(correlated(plan)).toBe(correlated(baseline));
  expect(hashed(plan)-hashed(baseline)).toBeGreaterThanOrEqual(3);
 },60_000);
});
