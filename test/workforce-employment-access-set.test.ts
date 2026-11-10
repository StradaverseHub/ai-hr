/** Set-wise Workforce employment access (draft 9911) against its per-row owner, app.access_workforce_employment:
 * the same employment set for every actor shape (group, company-scoped and descendant-scoped administrators, super
 * administrator, explicit deny, employee role, stale grants, archived and date-blocked logins), both capabilities,
 * voided and staged employments, another tenant, at 340 and 3,000+ employments; and the movement import's manager
 * catalogue built from it lists exactly the managers the per-row predicate admits, including an access refusal. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {movementImportCatalog,previewMovementImport} from '../core/movement-import';
import {workforceEmploymentSetPredicate} from '../core/workforce-access';
import {hireEmployee} from '../core/org';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
/** The per-row owner this set-wise function mirrors, as installed. A change to it must change 9911 too. */
const PER_ROW_OWNER=`
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND e.voided_at IS NULL AND (app.import_marker_visible(e.import_pending_attempt_id) OR e.import_pending_attempt_id::text=current_setting('app.import_attempt',true))
  AND app.access_workforce_company(e.company_id,p_capability));
`;

let b:Base,childId:string,betaId:string,otherTenantIds:string[];
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]}) as SessionContext;
async function user(role:'hr_admin'|'super_admin'|'employee',companyId:string|null,personId:string|null=null){
 const[u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:`fixture_${randomUUID()}`,personId}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role,companyId});
 return{...adminCtx(b),userId:u.id,personId:personId??undefined,roles:[role],grants:[{role,companyId}]} as SessionContext;
}
async function override(capabilityId:'workforce.view'|'workforce.maintain',companyId:string,effect:'deny'|null){
 const actor=group(),before=await withTenant(actor,tx=>accessConfigurationStore.loadCurrent(tx,actor));
 const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId:b.adminUserId,capabilityId,companyId,effect}};
 const preview=await previewAccessConfiguration(actor,edit,accessConfigurationStore);
 return saveAccessConfiguration(actor,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
/** Bulk fictional employments written by the owner: spread over the three companies, some ended. */
async function populate(count:number,prefix:string,companies:string[]){
 await owner.client.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email)
   select $1::uuid,'Fictional ${prefix} '||g,'${prefix.toLowerCase()}-'||g||'@example.test' from generate_series(1,$2::int) g returning id),
  n as (select id,row_number() over (order by id) k from p)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
  select $1::uuid,n.id,($3::uuid[])[1+(n.k % array_length($3::uuid[],1))::int],'${prefix}'||lpad(n.k::text,5,'0'),'2025-01-06',case when n.k % 17=0 then current_date-30 end from n`,[b.tenantId,count,`{${companies.join(',')}}`]);
}
type Sets={perRow:string[];setWise:string[];readerPerRow:string[];readerSetWise:string[]};
const rowColumns={tenantId:sql`e.tenant_id`,companyId:sql`e.company_id`,voidedAt:sql`e.voided_at`,importPendingAttemptId:sql`e.import_pending_attempt_id`};
/** Both forms over every employment row of every tenant (owner, no row security, the actor's session settings), and
 * both forms as the actor's own reader query (row security applies), each pair in ONE statement of one snapshot. */
async function compare(ctx:SessionContext,capability:'view'|'maintain'|'other',attempt?:string):Promise<Sets>{
 const cap='workforce.'+capability;
 const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
 const raw=await owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
   set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.import_attempt',${attempt??''},true)`;
  const[r]=await tx<{perRow:string[];setWise:string[]}[]>`select
   coalesce(array_agg(e.id order by e.id) filter (where app.access_workforce_employment(e.id,${cap})),'{}') as "perRow",
   coalesce(array_agg(e.id order by e.id) filter (where app.access_workforce_employment_permitted(e.tenant_id,e.company_id,e.voided_at,e.import_pending_attempt_id,(select app.access_workforce_permitted_companies(${cap})))),'{}') as "setWise"
   from employment e`;
  return r;
 });
 const reader=await withTenant(ctx,async tx=>{
  if(attempt)await tx.execute(sql`select set_config('app.import_attempt',${attempt},true)`);
  const[r]=await tx.execute<{readerPerRow:string[];readerSetWise:string[]}>(sql`select
   coalesce((select array_agg(e.id order by e.id) from employment e where app.access_workforce_employment(e.id,${cap})),'{}') as "readerPerRow",
   coalesce((select array_agg(e.id order by e.id) from employment e where ${workforceEmploymentSetPredicate(rowColumns,capability as 'view')}),'{}') as "readerSetWise"`);
  return r;
 });
 return{...raw,...reader};
}
const expectSame=(r:Sets,label:string)=>{expect(r.setWise,label).toEqual(r.perRow);expect(r.readerSetWise,label+' (reader)').toEqual(r.readerPerRow);};

beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const[child]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Child Fictional Sdn Bhd',parentCompanyId:b.companyId}).returning();childId=child.id;
 const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd'}).returning();betaId=beta.id;
 // Another tenant's employments must never appear.
 const other=await seedBase();
 await owner.client.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email) select $1::uuid,'Fictional other '||g,'other-'||g||'@example.test' from generate_series(1,5) g returning id)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select $1::uuid,p.id,$2::uuid,'OT'||row_number() over (),'2025-01-06' from p`,[other.tenantId,other.companyId]);
 otherTenantIds=(await owner.client<{id:string}[]>`select id from employment where tenant_id=${other.tenantId}::uuid`).map(r=>r.id);
});
afterAll(async()=>{try{await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);}finally{await closeAll();}});

describe('set-wise Workforce employment access (9911)',()=>{
 it('mirrors the installed per-row owner',async()=>{
  const[row]=await owner.client<{body:string;definer:boolean;volatility:string}[]>`select prosrc as body,prosecdef as definer,provolatile as volatility from pg_proc where oid='app.access_workforce_employment(uuid,text)'::regprocedure`;
  expect(row).toEqual({body:PER_ROW_OWNER,definer:true,volatility:'s'});
  const fns=await owner.client<{name:string;definer:boolean;volatility:string;app:boolean;public:boolean}[]>`select p.proname as name,p.prosecdef as definer,p.provolatile as volatility,
   has_function_privilege('ai_hr_app',p.oid,'execute') as app,exists(select 1 from aclexplode(p.proacl) a where a.grantee=0) as public
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname in ('access_workforce_permitted_companies','access_workforce_employment_permitted') order by 1`;
  expect(fns).toEqual([{name:'access_workforce_employment_permitted',definer:true,volatility:'s',app:true,public:false},{name:'access_workforce_permitted_companies',definer:true,volatility:'s',app:true,public:false}]);
  // The row predicate is a filter on the reader's own scan and the company set is computed once (an InitPlan), so the
  // plan keeps the per-row owner's shape whatever the statistics: no join on a set, no company check per row.
  const plan=await withTenant(group(),tx=>tx.execute<{'QUERY PLAN':string}>(sql`explain (verbose,costs off) select e.id from employment e where ${workforceEmploymentSetPredicate(rowColumns,'view')}`));
  const text=plan.map(r=>r['QUERY PLAN']).join('\n');
  expect(text).toMatch(/Filter: .*app\.access_workforce_employment_permitted\(/);expect(text).toMatch(/InitPlan[\s\S]*access_workforce_permitted_companies/);expect(text).not.toMatch(/Join|Function Scan/);
 });

 for(const size of [340,3100])it(`returns exactly the per-row set for every actor shape at ${size} employments`,async()=>{
  await populate(size,'AS',[b.companyId,childId,betaId]);
  // A voided employment (owner path, with its import attempt as the void constraint requires) and a staged one.
  const[attempt]=await owner.client<{id:string}[]>`insert into import_attempt(tenant_id,kind,created_by,company_ids,mime_type,operation_key,plan,source_content,source_hash,source_name)
   values(${b.tenantId}::uuid,'employee_full',${b.adminUserId}::uuid,${`{${b.companyId}}`}::uuid[],'text/csv',${randomUUID()}::uuid,'{}'::jsonb,'\\x'::bytea,encode(sha256('\\x'::bytea),'hex'),'fixture.csv') returning id`;
  const[voided]=await owner.client<{id:string;code:string}[]>`select id,employee_code code from employment where tenant_id=${b.tenantId}::uuid and employee_code='AS00002'`;
  await owner.client`update employment set voided_at=now(),voided_by=${b.adminUserId}::uuid,void_reason='Fictional void',voided_import_attempt_id=${attempt.id}::uuid,voided_employee_code=${voided.code},employee_code=null where id=${voided.id}::uuid`;
  // Staged by the attempt (the database stamps the marker while app.import_attempt is set); not released.
  const staged=attempt.id;
  await owner.client.begin(async tx=>{await tx`select set_config('app.import_attempt',${staged},true)`;
   await tx.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email) values($1::uuid,'Fictional staged','staged-access@example.test') returning id)
    insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select $1::uuid,p.id,$2::uuid,'ASSTAGED','2025-01-06' from p`,[b.tenantId,b.companyId]);});
  const[stagedRow]=await owner.client<{id:string;marker:string|null}[]>`select id,import_pending_attempt_id::text marker from employment where employee_code='ASSTAGED'`;
  expect(stagedRow.marker).toBe(staged);
  // A date-blocked administrator: their own employment ended yesterday.
  const[blockedPerson]=await owner.client<{id:string}[]>`select person_id id from employment where employee_code='AS00003'`;
  await owner.client`update employment set last_working_date=current_date-1 where employee_code='AS00003'`;
  const actors:[string,SessionContext][]=[
   ['group administrator',group()],
   ['company-scoped administrator (covers its child company)',await user('hr_admin',b.companyId)],
   ['other-company administrator',await user('hr_admin',betaId)],
   ['super administrator',await user('super_admin',null)],
   ['employee role',await user('employee',null)],
   ['stale grants',{...group(),grants:[{role:'hr_admin',companyId:betaId}],roles:['hr_admin','super_admin']} as SessionContext],
   ['date-blocked administrator',await user('hr_admin',null,blockedPerson.id)],
  ];
  const archived=await user('hr_admin',null);await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,archived.userId!));
  actors.push(['archived administrator',archived]);
  const report:Record<string,number>={};
  for(const [label,ctx] of actors)for(const capability of ['view','maintain','other'] as const){
   const r=await compare(ctx,capability);expectSame(r,`${label} ${capability}`);report[`${label} ${capability}`]=r.setWise.length;
   for(const id of otherTenantIds){expect(r.setWise).not.toContain(id);expect(r.readerSetWise).not.toContain(id);}
   expect(r.setWise).not.toContain(voided.id);expect(r.setWise).not.toContain(stagedRow.id);
  }
  // The staged employment is visible only to its own attempt's session, in both forms.
  const own=await compare(group(),'view',staged);expectSame(own,'own staged attempt');expect(own.setWise).toContain(stagedRow.id);
  // Explicit deny of view on the parent company, with the capability enforced.
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);
  const allowedBefore=await compare(group(),'view');expectSame(allowedBefore,'capability enforced');
  await override('workforce.view',b.companyId,'deny');
  const denied=await compare(group(),'view'),maintained=await compare(group(),'maintain');
  expectSame(denied,'explicit deny view');expectSame(maintained,'explicit deny, maintain still allowed');
  expect(denied.setWise.length).toBeLessThan(allowedBefore.setWise.length);expect(maintained.setWise.length).toBe(allowedBefore.setWise.length);
  // The shapes are not vacuous: the group sees everything live in this tenant, the employee nothing.
  expect(report['group administrator view']).toBeGreaterThanOrEqual(size-1);expect(report['employee role view']).toBe(0);expect(report['date-blocked administrator view']).toBe(0);
  expect(report['company-scoped administrator (covers its child company) view']).toBeGreaterThan(0);expect(report['other-company administrator view']).toBeGreaterThan(0);
 },600_000);

 it('lists exactly the per-row managers in the movement catalogue, and still refuses a manager outside the actor\'s companies',async()=>{
  await populate(3100,'MC',[b.companyId,childId,betaId]);
  const scoped=await user('hr_admin',b.companyId);
  for(const [label,ctx] of [['group',group()],['company-scoped',scoped]] as const){
   const started=performance.now();
   const catalog=await movementImportCatalog(ctx,b.companyId);
   const ms=performance.now()-started;
   const reference=await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select e.id from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id
    where e.tenant_id=${b.tenantId}::uuid and e.terminated_on is null and app.access_workforce_employment(e.id,'workforce.view') order by e.employee_code,e.id`));
   expect(catalog.fields.managerEmploymentId!.map(o=>o.value),label).toEqual(reference.map(r=>r.id));
   expect(reference.length,label).toBeGreaterThan(1000);
   console.log(`[access-set] ${label} catalogue over 3,100 employments: ${Math.round(ms)} ms, ${reference.length} managers`);
  }
  // The refusal that exists today: a Direct Superior in a company the actor cannot view is an unknown reference.
  const [subject]=await Promise.all([hireEmployee(group(),{person:{fullName:'Fictional subject',primaryEmail:`${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-200),employeeCode:'MCSUBJECT'})]);
  expect(subject.employmentId).toBeTruthy();
  const[betaManager]=await owner.client<{code:string}[]>`select employee_code code from employment where company_id=${betaId}::uuid and terminated_on is null order by employee_code limit 1`;
  const csv=toCsv([['employee_code','event_type','effective_date','manager_employment_id'],['MCSUBJECT','reportingLineChange',day(-1),betaManager.code]]);
  const refused=await previewMovementImport(scoped,{companyId:b.companyId,csv});
  expect(refused.employees[0].rows[0]).toMatchObject({status:'invalid',errors:['unknown_reference:managerEmploymentId']});
  const[ownManager]=await owner.client<{code:string}[]>`select employee_code code from employment where company_id=${b.companyId}::uuid and terminated_on is null and employee_code like 'MC%' order by employee_code limit 1`;
  const allowed=await previewMovementImport(scoped,{companyId:b.companyId,csv:toCsv([['employee_code','event_type','effective_date','manager_employment_id'],['MCSUBJECT','reportingLineChange',day(-1),ownManager.code]])});
  expect(allowed.employees[0].rows[0].errors).not.toContain('unknown_reference:managerEmploymentId');
 },600_000);
});
