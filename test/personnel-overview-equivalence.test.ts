/** The bounded Personnel overview returns exactly the exact owner's rows, order, counts, headcount and
 * choices for every list filter, sort and private search, for an HR administrator and for a scoped
 * manager (allow on two companies, explicit deny on a descendant), with and without the unallocated
 * typed-facts draft installed. The exact reader (`compareExact`) is the pre-existing implementation. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {client as applicationClient,type SessionContext} from '../db/client';
import {readPersonnelOverview} from '../core/read';
import {createPersonnelPrivateSearch} from '../core/personnel-private-search';
import {workforceViewScope} from '../core/workforce-access';
import {headcountFilters,parsePersonnelListQuery,type PersonnelSearchParams} from '../app/admin/personnel/list-query';
import {EMPLOYEE_COLUMN_KEYS} from '../lib/employee-columns';
import {closeAll,migrateTestDb,owner} from './harness';
import {sql} from 'drizzle-orm';
import type {TransactionSql} from 'postgres';
import {withTenant} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {installPersonnelDraft,restoreWorkforceCapabilityCatalogue,seedPersonnelScaleFixture,type PersonnelScaleFixture} from './performance/personnel-scale-fixture';
type Overview=Awaited<ReturnType<typeof readPersonnelOverview>>;
const normalize=(value:Overview)=>({...value,organisationChoices:{...value.organisationChoices,
 rows:value.organisationChoices.rows.map(row=>JSON.stringify(row)).sort()}});

let fixture:PersonnelScaleFixture;
beforeAll(async()=>{await migrateTestDb();fixture=await seedPersonnelScaleFixture(640);},180_000);
let removeDraft:(()=>Promise<void>)|undefined;
afterAll(async()=>{try{await removeDraft?.();await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);
/** The pre-existing exact owner's answers, captured before the draft replaces any function. */
const original=new Map<string,Overview>();
const searchRows=new Map<string,string[]>();
/** The migration owner acting for a session, to call the draft's private (non-application) helper. */
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
  ...sorts,
  ['private-term',{search:tokens.term}],['private-term-second-page',{search:tokens.term},{offset:25}],
  ['private-column-filters',{search:tokens.filtered}],['private-filters-and-status',{search:tokens.filtered,bucket:'active'}],
  ['private-expired-or-invalid',{search:'x'.repeat(43)}],
 ];
}

async function compareAll(role:'admin'|'manager',withDraft:boolean){
 const ctx:SessionContext=fixture[role];
 const scope=(await workforceViewScope(ctx,{personnelList:true})).companyIds;
 const term=await createPersonnelPrivateSearch(ctx,{text:'Tan',companyIds:scope,replaceCriteria:true});
 const filtered=await createPersonnelPrivateSearch(ctx,{text:'',companyIds:scope,replaceCriteria:true,
  columnFilters:[{field:'department',operator:'contains',value:'department 2'}]});
 const used={facts:0,'filter-fields':0,exact:0};let compared=0,nonEmpty=0;
 for(const [name,sp,page] of cases(fixture,{term,filtered})){
  const query=parsePersonnelListQuery(sp);
  const input={companyIds:scope,...query.filters,limit:page?.limit??25,offset:page?.offset??0};
  const exact=await readPersonnelOverview(ctx,input,headcountFilters(query),{compareExact:true});
  const traced=await relations(()=>readPersonnelOverview(ctx,input,headcountFilters(query)));
  // The relation the overview statement reads (the snapshot's probe only names the draft's signatures).
  const source=/app\.personnel_overview_facts\(\$\d+::date/.test(traced.sql)?'facts'
   :/app\.personnel_overview_filter_fields\(\$\d+::date/.test(traced.sql)?'filter-fields':'exact';
  used[source]++;
  const key=role+' '+name;
  if(!withDraft)original.set(key,exact);
  const oracle=original.get(key);expect(oracle,key+' oracle').toBeDefined();
  expect(normalize(traced.result),key+' via '+source).toEqual(normalize(oracle!));
  // With the draft, the exact owner itself runs the set-wise resolver; it must still answer the same.
  if(withDraft)expect(normalize(exact),key+' exact with draft').toEqual(normalize(oracle!));
  compared++;if(exact.employees.rows.length)nonEmpty++;
 }
 return {scope,used,compared,nonEmpty};
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
  // The pre-draft search projection, for the parity check once the draft replaces it.
  for(const [role,ctx] of [['admin',fixture.admin],['manager',fixture.manager]] as const){
   const scope=(role==='admin'?admin:manager).companyIds;
   searchRows.set(role,await withTenant(ctx,tx=>tx.execute<{value:Record<string,unknown>}>(sql`select value from app.personnel_search_rows(array[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) r(value)`))
    .then(rows=>rows.map(row=>JSON.stringify(row.value)).sort()));
  }
 },120_000);

 for(const role of ['admin','manager'] as const){
  it(`matches the exact owner for every filter, sort and search without the typed-facts draft (${role})`,async()=>{
   expect(removeDraft).toBeUndefined();
   const {used,compared,nonEmpty}=await compareAll(role,false);
   expect(compared).toBeGreaterThan(60);expect(nonEmpty).toBeGreaterThan(40);
   // Department, business unit, position, type, confirmation, probation and most sorts are now bounded.
   expect(used['filter-fields']).toBeGreaterThan(40);expect(used.facts).toBe(0);
  },600_000);
 }
 for(const role of ['admin','manager'] as const){
  it(`matches the exact owner for every filter, sort and search with the typed-facts draft (${role})`,async()=>{
   removeDraft??=await installPersonnelDraft();
   const {used,compared}=await compareAll(role,true);
   expect(compared).toBeGreaterThan(60);
   // Every case is bounded once the complete typed projection is installed.
   expect(used.exact).toBe(0);expect(used.facts).toBeGreaterThanOrEqual(30);
  },600_000);
 }
 it('the draft resolves organisation tags, page rows and search rows exactly as the per-row owners',async()=>{
  removeDraft??=await installPersonnelDraft();
  const day=todayInKualaLumpur();
  for(const [role,ctx] of [['admin',fixture.admin],['manager',fixture.manager]] as const){
   const scope=(await workforceViewScope(ctx,{personnelList:true})).companyIds;
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
  }
 },300_000);
});
