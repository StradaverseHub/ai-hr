/** The bounded Personnel overview returns exactly the exact owner's rows, order, counts, headcount and
 * choices for every list filter, sort and private search, for an HR administrator and for a scoped
 * manager (allow on two companies, explicit deny on a descendant), before and after migration 9880.
 * The oracle is the exact reader (`compareExact`) over the owners as they were before 9880: the test
 * restores those predecessor bodies from the migrations that installed them, captures every answer,
 * then re-applies 9880 and compares the typed facts, the replaced exact owner, the set-wise resolver,
 * page rows, search rows, private-search creation and the bind trigger's refusals against them. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {client as applicationClient,type SessionContext} from '../db/client';
import {readPersonnelOverview} from '../core/read';
import {createPersonnelPrivateSearch,privateSearchHash} from '../core/personnel-private-search';
import {workforceViewScope} from '../core/workforce-access';
import {headcountFilters,parsePersonnelListQuery,type PersonnelSearchParams} from '../app/admin/personnel/list-query';
import {EMPLOYEE_COLUMN_KEYS} from '../lib/employee-columns';
import {pgSqlState} from '../lib/db-error';
import {closeAll,migrateTestDb,owner} from './harness';
import {sql} from 'drizzle-orm';
import type {TransactionSql} from 'postgres';
import {withTenant} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {installPreMigrationOwners,restoreWorkforceCapabilityCatalogue,seedPersonnelScaleFixture,type PersonnelScaleFixture} from './performance/personnel-scale-fixture';
type Overview=Awaited<ReturnType<typeof readPersonnelOverview>>;
const normalize=(value:Overview)=>({...value,organisationChoices:{...value.organisationChoices,
 rows:value.organisationChoices.rows.map(row=>JSON.stringify(row)).sort()}});

let fixture:PersonnelScaleFixture;
/** A capability-only viewer: an ordinary employee of B with a published workforce.view allow on B
 * (which also covers its descendant C) and an explicit deny on C; no HR, payroll or rewards role. */
let viewer:SessionContext;
let reapplyMigration:(()=>Promise<void>)|undefined;
beforeAll(async()=>{
 await migrateTestDb();fixture=await seedPersonnelScaleFixture(640);
 const t=fixture.base.tenantId;
 const [person]=await owner.client<{personId:string}[]>`select e.person_id as "personId" from employment e
  where e.tenant_id=${t}::uuid and e.company_id=${fixture.companies.b}::uuid and e.terminated_on is null
   -- A current employee, so app.login_blocked admits the account.
   and e.resignation_date is null and e.last_working_date is null and e.blacklisted_at is null
   and not exists(select 1 from app_user u where u.person_id=e.person_id) order by e.employee_code limit 1`;
 const [user]=await owner.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id,person_id)
  values(${t}::uuid,${'fictional-viewer-'+randomBytes(6).toString('hex')},${person.personId}::uuid) returning id`;
 await owner.client`insert into role_assignment(tenant_id,app_user_id,company_id,role) values(${t}::uuid,${user.id}::uuid,${fixture.companies.b}::uuid,'employee')`;
 await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values
  (${t}::uuid,${user.id}::uuid,'workforce.view',${fixture.companies.b}::uuid,'allow'),
  (${t}::uuid,${user.id}::uuid,'workforce.view',${fixture.companies.c}::uuid,'deny')`;
 viewer={tenantId:t,userId:user.id,personId:person.personId,roles:['employee'],grants:[{role:'employee',companyId:fixture.companies.b}],
  entitlements:fixture.admin.entitlements};
 // The oracle state: the Personnel owners exactly as they were before 9880.
 reapplyMigration=await installPreMigrationOwners();
},240_000);
afterAll(async()=>{try{await reapplyMigration?.();await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);
async function migrate9880(){if(reapplyMigration){const reapply=reapplyMigration;reapplyMigration=undefined;await reapply();}}

/** The pre-9880 exact owner's answers. */
const original=new Map<string,Overview>();
const searchRows=new Map<string,string[]>();
const tokenMatches=new Map<string,string[]>();
const refusals=new Map<string,(string|null)[]>();
/** The migration owner acting for a session, to call the migration's private (non-application) helper. */
function asSession<T>(ctx:SessionContext,work:(tx:TransactionSql)=>Promise<T>){
 return owner.client.begin(async (tx:TransactionSql)=>{
  await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),
   set_config('app.roles',${(ctx.roles??[]).join(',')},true),set_config('app.grants',${JSON.stringify(ctx.grants??[])},true)`;
  return work(tx);
 }) as Promise<T>;
}

/** Which relations a read actually used, from the application client's own statements. */
async function relations<T>(work:()=>Promise<T>){
 const options=applicationClient.options as {debug?:unknown},previous=options.debug,seen:string[]=[];
 options.debug=(_connection:number,query:string)=>{seen.push(query);};
 try{return {result:await work(),sql:seen.join('\n')};}finally{options.debug=previous;}
}

function cases(f:PersonnelScaleFixture,tokens:{term:string;filtered:string}):[string,PersonnelSearchParams,{limit?:number;offset?:number}?][]{
 const b=f.companies.b,deptB=f.departments.b[1];
 const sorts=EMPLOYEE_COLUMN_KEYS.flatMap(key=>(['asc','desc'] as const).map(direction=>
  ['sort-'+key+'-'+direction,{sort:key,direction}] as [string,PersonnelSearchParams]));
 return [
  ['list',{}],['second-page',{},{offset:25}],['beyond-last-page',{},{offset:100000}],['size-100',{},{limit:100}],['size-all',{},{limit:2000}],
  ['q-name',{q:'Siew Ling'}],['q-code',{q:'FX00012'}],['q-literal-wildcards',{q:'%_'}],
  ['companies',{companies:b}],['legacy-company',{company:b}],['department',{dept:deptB}],['employment-type',{type:'contract'}],
  ['business-unit',{bu:f.businessUnits[2]}],['business-units',{bu:[f.businessUnits[2],f.businessUnits[7]]}],
  ['parent-company',{parent:b}],['business-group',{group:b}],['grades',{grade:'13,H'}],['position',{position:f.positions[5]}],
  ['confirmed',{confirmation:'confirmed'}],['unconfirmed',{confirmation:'unconfirmed'}],
  ['joined-range',{joinedFrom:'2019-01-01',joinedTo:'2023-06-30'}],['probation-range',{probationFrom:'2020-01-01',probationTo:'2025-12-31'}],
  ...(['missing_business_unit','missing_job_grade','missing_direct_superior','company_not_in_structure','suspected_duplicate'] as const)
   .map(flag=>['quality-'+flag,{quality:flag}] as [string,PersonnelSearchParams]),
  ['quality-two',{quality:'missing_job_grade,missing_direct_superior'}],
  ['bucket-active',{bucket:'active'}],['bucket-probation',{bucket:'probation'}],['bucket-resigned',{bucket:'resigned'}],
  ['bucket-serving-notice',{bucket:'active_serving_notice'}],['bucket-blacklisted',{bucket:'blacklisted'}],
  ['legacy-terminated',{status:'terminated'}],['legacy-active',{status:'active'}],
  ['department-active',{dept:deptB,bucket:'active'}],['department-sorted-desc',{dept:deptB,sort:'joinDate',direction:'desc'},{offset:5}],
  ['parent-sorted-reporting',{parent:b,sort:'reportingTo',direction:'desc'},{offset:3}],
  ['grade-superior-page',{grade:'13,H',quality:'missing_direct_superior'},{offset:2,limit:10}],
  ...sorts,
  ['private-term',{search:tokens.term}],['private-term-second-page',{search:tokens.term},{offset:25}],
  ['private-term-sorted',{search:tokens.term,sort:'costCenter',direction:'asc'}],
  ['private-column-filters',{search:tokens.filtered}],['private-filters-and-status',{search:tokens.filtered,bucket:'active'}],
  ['private-expired-or-invalid',{search:'x'.repeat(43)}],
 ];
}

const scopeOf=async(ctx:SessionContext)=>(await workforceViewScope(ctx,{personnelList:true})).companyIds;
const roles=()=>({admin:fixture.admin,manager:fixture.manager});
/** Private search tokens, created once per phase by the phase's own search projection and bind trigger. */
async function tokensFor(ctx:SessionContext,scope:string[]){
 const term=await createPersonnelPrivateSearch(ctx,{text:'Tan',companyIds:scope,replaceCriteria:true});
 const filtered=await createPersonnelPrivateSearch(ctx,{text:'',companyIds:scope,replaceCriteria:true,
  columnFilters:[{field:'department',operator:'contains',value:'department 2'}]});
 return {term,filtered};
}
/** A token's stored entries, as the bind trigger admitted them. */
async function storedMatches(token:string){
 const [row]=await owner.client<{matches:unknown[]}[]>`select matches from personnel_private_search where token_hash=${privateSearchHash(token)}`;
 return row.matches.map(entry=>JSON.stringify(entry)).sort();
}

async function compareAll(role:'admin'|'manager',migrated:boolean){
 const ctx:SessionContext=roles()[role];
 const scope=await scopeOf(ctx);
 const tokens=await tokensFor(ctx,scope);
 for(const [name,token] of Object.entries(tokens)){
  const key=role+' '+name,matches=await storedMatches(token);
  if(!migrated)tokenMatches.set(key,matches);
  else expect(matches,key+' private search entries').toEqual(tokenMatches.get(key));
 }
 const used={facts:0,'filter-fields':0,exact:0};let compared=0,nonEmpty=0;
 for(const [name,sp,page] of cases(fixture,tokens)){
  const query=parsePersonnelListQuery(sp);
  const input={companyIds:scope,...query.filters,limit:page?.limit??25,offset:page?.offset??0};
  const exact=await readPersonnelOverview(ctx,input,headcountFilters(query),{compareExact:true});
  const traced=await relations(()=>readPersonnelOverview(ctx,input,headcountFilters(query)));
  // The relation the overview statement reads (the snapshot's probe only names the signatures).
  const source=/app\.personnel_overview_facts\(\$\d+::date/.test(traced.sql)?'facts'
   :/app\.personnel_overview_filter_fields\(\$\d+::date/.test(traced.sql)?'filter-fields':'exact';
  used[source]++;
  const key=role+' '+name;
  if(!migrated)original.set(key,exact);
  const oracle=original.get(key);expect(oracle,key+' oracle').toBeDefined();
  expect(normalize(traced.result),key+' via '+source).toEqual(normalize(oracle!));
  // After 9880 the exact owner itself runs the set-wise resolver; it must still answer the same.
  if(migrated)expect(normalize(exact),key+' exact after 9880').toEqual(normalize(oracle!));
  compared++;if(exact.employees.rows.length)nonEmpty++;
 }
 return {scope,used,compared,nonEmpty};
}

/** The bind trigger's verdict (SQLSTATE, or null when admitted) for crafted entries, as the application. */
async function bindVerdicts(ctx:SessionContext){
 const scope=await scopeOf(ctx);
 const t=ctx.tenantId;
 const [visible,hidden]=await Promise.all([
  owner.client<{id:string;e:string;p:string}[]>`select e.id,e.xmin::text as e,p.xmin::text as p from employment e join person p on p.id=e.person_id
   where e.tenant_id=${t}::uuid and e.company_id=any(${scope}::uuid[]) order by e.employee_code limit 3`,
  owner.client<{id:string;e:string;p:string}[]>`select e.id,e.xmin::text as e,p.xmin::text as p from employment e join person p on p.id=e.person_id
   where e.tenant_id=${t}::uuid and not (e.company_id=any(${scope}::uuid[])) order by e.employee_code limit 1`,
 ]);
 const entry=(row:{id:string;e:string;p:string},extra:Record<string,string>={})=>({employmentId:row.id,kind:'public',personRevision:row.p,employmentRevision:row.e,...extra});
 const attempts:unknown[][]=[
  [entry(visible[0]),entry(visible[1])],
  [entry(visible[0]),{...entry(visible[1]),employmentRevision:String(Number(visible[1].e)+7)}],
  [{...entry(visible[2]),personRevision:'1'}],
  [entry(visible[0]),{...entry(visible[1]),filterRevision:'0'.repeat(32)}],
  ...(hidden.length?[[entry(hidden[0])]]:[]),
  [{...entry(visible[0]),kind:'identity',identityRevision:'1'}],
 ];
 const verdicts:(string|null)[]=[];
 for(const matches of attempts){
  const hash=privateSearchHash(randomBytes(32).toString('base64url'))!;
  try{
   await withTenant(ctx,tx=>tx.execute(sql`insert into personnel_private_search(token_hash,tenant_id,actor_id,scope_ids,matches,criteria)
    values(${hash},${ctx.tenantId}::uuid,${ctx.userId!}::uuid,ARRAY[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[],${JSON.stringify(matches)}::jsonb,null)`));
   verdicts.push(null);
  }catch(error){verdicts.push(pgSqlState(error)??'unknown');}
 }
 return verdicts;
}

describe('bounded Personnel overview equivalence on a fictional multi-company fixture',()=>{
 it('admits exactly the independently expected companies, employees and terminated records',async()=>{
  const admin=await workforceViewScope(fixture.admin,{personnelList:true});
  const manager=await workforceViewScope(fixture.manager,{personnelList:true});
  expect([...admin.companyIds].sort()).toEqual(Object.values(fixture.companies).sort());
  // Allowed on B (and its descendant C) and D, explicitly denied on C: deny wins.
  expect([...manager.companyIds].sort()).toEqual(fixture.managerVisibleCompanies);
  const [counts]=await owner.client<{all:number;manager:number;terminated:number;managerTerminated:number}[]>`select
   count(*)::int as all,count(*) filter(where company_id=any(${fixture.managerVisibleCompanies}::uuid[]))::int as manager,
   count(*) filter(where terminated_on is not null)::int as terminated,
   count(*) filter(where terminated_on is not null and company_id=any(${fixture.managerVisibleCompanies}::uuid[]))::int as "managerTerminated"
   from employment where tenant_id=${fixture.base.tenantId}::uuid`;
  expect(counts.terminated).toBeGreaterThan(0);expect(counts.managerTerminated).toBeGreaterThan(0);
  const list=(ctx:SessionContext,companyIds:string[])=>readPersonnelOverview(ctx,{companyIds,...parsePersonnelListQuery({}).filters,limit:25,offset:0},headcountFilters(parsePersonnelListQuery({})));
  const adminList=await list(fixture.admin,admin.companyIds),managerList=await list(fixture.manager,manager.companyIds);
  expect(adminList.employees.total).toBe(counts.all);expect(adminList.headcount.total).toBe(counts.all);
  expect(managerList.employees.total).toBe(counts.manager);expect(managerList.headcount.total).toBe(counts.manager);
  expect(managerList.employees.rows.length).toBe(25);
  expect(managerList.employees.rows.every(row=>fixture.managerVisibleCompanies.includes(row.companyId))).toBe(true);
  const terminated=await readPersonnelOverview(fixture.admin,{companyIds:admin.companyIds,...parsePersonnelListQuery({status:'terminated'}).filters,limit:25,offset:0},{});
  expect(terminated.employees.total).toBe(counts.terminated);
  const managerTerminated=await readPersonnelOverview(fixture.manager,{companyIds:manager.companyIds,...parsePersonnelListQuery({status:'terminated'}).filters,limit:25,offset:0},{});
  expect(managerTerminated.employees.total).toBe(counts.managerTerminated);
  // The pre-9880 search projection and bind trigger, for the parity checks once 9880 replaces them.
  for(const [role,ctx] of Object.entries(roles())){
   const scope=(role==='admin'?admin:manager).companyIds;
   searchRows.set(role,await withTenant(ctx,tx=>tx.execute<{value:Record<string,unknown>}>(sql`select value from app.personnel_search_rows(array[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) r(value)`))
    .then(rows=>rows.map(row=>JSON.stringify(row.value)).sort()));
   refusals.set(role,await bindVerdicts(ctx));
  }
  // Admitted; then two stale revisions, a stale fingerprint, (for the manager) a company outside the
  // scope and an identity entry without a current identity revision are all refused.
  for(const [role,verdicts] of refusals){
   expect(verdicts[0],role+' admitted entries').toBeNull();
   expect(verdicts.slice(1).every(verdict=>verdict!==null),role+' refused entries').toBe(true);
  }
  expect(refusals.get('admin')).toHaveLength(5);expect(refusals.get('manager')).toHaveLength(6);
 },180_000);

 it('before 9880 a capability-only Workforce viewer is admitted to Personnel but its company choices refuse (the defect)',async()=>{
  const scope=await scopeOf(viewer);
  expect(scope).toEqual([fixture.companies.b]);
  const query=parsePersonnelListQuery({});
  await expect(readPersonnelOverview(viewer,{companyIds:scope,...query.filters,limit:25,offset:0},headcountFilters(query)))
   .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 },60_000);

 for(const role of ['admin','manager'] as const){
  it(`before 9880 the bounded overview matches the exact owner for every filter, sort and search (${role})`,async()=>{
   expect(reapplyMigration).toBeDefined();
   const {used,compared,nonEmpty}=await compareAll(role,false);
   expect(compared).toBeGreaterThan(60);expect(nonEmpty).toBeGreaterThan(40);
   // Department, business unit, position, type, confirmation, probation and most sorts are bounded.
   expect(used['filter-fields']).toBeGreaterThan(40);expect(used.facts).toBe(0);
  },600_000);
 }
 for(const role of ['admin','manager'] as const){
  it(`after 9880 every filter, sort and search is bounded and matches the pre-9880 exact owner (${role})`,async()=>{
   await migrate9880();
   const {used,compared}=await compareAll(role,true);
   expect(compared).toBeGreaterThan(60);
   // Every case is bounded once the complete typed projection is installed.
   expect(used.exact).toBe(0);expect(used.facts).toBeGreaterThanOrEqual(30);
  },600_000);
 }
 it('after 9880 the set-wise resolver, page rows, search rows and bind trigger answer exactly as the per-row owners',async()=>{
  await migrate9880();
  const day=todayInKualaLumpur();
  for(const [role,ctx] of Object.entries(roles())){
   const scope=await scopeOf(ctx);
   const [tags]=await asSession(ctx,tx=>tx<{n:number;different:number}[]>`select count(*)::int as n,
    count(*) filter(where t.tags is distinct from app.employment_organisation_tags(t.employment_id,${day}::date))::int as different
    from app._personnel_employment_tags(array(select e.id from employment e where e.tenant_id=${ctx.tenantId}::uuid
     and e.company_id=any(${scope}::uuid[])),${day}::date) t`);
   expect(tags.n,role+' tagged subjects').toBeGreaterThan(100);expect(tags.different,role+' tag differences').toBe(0);
   const scopeSql=sql`array[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
   const [rows]=await withTenant(ctx,tx=>tx.execute<{n:number;different:number}>(sql`
    with ids as materialized (select array(select e.id from employment e where e.tenant_id=${ctx.tenantId}::uuid
      and e.company_id=any(${scopeSql}) order by e.id limit 2000) as ids),
    per_row as materialized (select a.value from ids cross join lateral app.personnel_overview_page_rows(${day}::date,${scopeSql},ids.ids) a(value)),
    set_wise as materialized (select b.value from ids cross join lateral app.personnel_overview_page_rows_typed(${day}::date,${scopeSql},ids.ids) b(value))
    select count(*)::int as n,count(*) filter(where a.value is distinct from b.value)::int as different
    from per_row a full join set_wise b on a.value->>'employmentId'=b.value->>'employmentId'`));
   expect(rows.n,role+' page rows').toBeGreaterThan(100);expect(rows.different,role+' page row differences').toBe(0);
   const after=await withTenant(ctx,tx=>tx.execute<{value:Record<string,unknown>}>(sql`select value from app.personnel_search_rows(${scopeSql}) r(value)`))
    .then(found=>found.map(row=>JSON.stringify(row.value)).sort());
   expect(after.length,role+' search rows').toBeGreaterThan(100);expect(after).toEqual(searchRows.get(role));
   expect(await bindVerdicts(ctx),role+' bind verdicts').toEqual(refusals.get(role));
  }
 },300_000);

 it('after 9880 the capability-only viewer opens Personnel with exactly its own companies and employees',async()=>{
  await migrate9880();
  const scope=await scopeOf(viewer);
  expect(scope).toEqual([fixture.companies.b]);
  const [expected]=await owner.client<{total:number;ids:string[]}[]>`select count(*)::int as total,
   coalesce(array_agg(id order by id),'{}') as ids from employment
   where tenant_id=${fixture.base.tenantId}::uuid and company_id=${fixture.companies.b}::uuid and voided_at is null`;
  expect(expected.total).toBeGreaterThan(50);
  for(const sp of [{},{parent:fixture.companies.b},{sort:'reportingTo',direction:'asc'},{status:'terminated'},{quality:'missing_direct_superior'}] as PersonnelSearchParams[]){
   const query=parsePersonnelListQuery(sp);
   const input={companyIds:scope,...query.filters,limit:2000,offset:0};
   const exact=await readPersonnelOverview(viewer,input,headcountFilters(query),{compareExact:true});
   const bounded=await readPersonnelOverview(viewer,input,headcountFilters(query));
   expect(normalize(bounded),JSON.stringify(sp)).toEqual(normalize(exact));
   expect(bounded.employees.rows.every(row=>row.companyId===fixture.companies.b)).toBe(true);
   expect(bounded.employees.rows.every(row=>expected.ids.includes(row.employmentId))).toBe(true);
   expect(bounded.organisationChoices.companies.map(company=>company.id)).toEqual([fixture.companies.b]);
   if(!Object.keys(sp).length){
    expect(bounded.employees.total).toBe(expected.total);
    expect([...bounded.employees.rows.map(row=>row.employmentId)].sort()).toEqual(expected.ids);
   }
  }
  // Still no wider reach: the company choices owner admits nothing outside the viewer's projection.
  const foreign=await withTenant(viewer,tx=>tx.execute<{id:string}>(sql`select id from app.personnel_filter_companies(
   array[${fixture.companies.a}::uuid,${fixture.companies.c}::uuid,${fixture.companies.d}::uuid]::uuid[],${todayInKualaLumpur()}::date)`));
  expect(foreign).toHaveLength(0);
  // A missing day keeps the checked owner's refusal.
  await expect(withTenant(viewer,tx=>tx.execute(sql`select * from app.personnel_filter_companies(array[${fixture.companies.b}::uuid]::uuid[],null::date)`)))
   .rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');
 },300_000);
});
