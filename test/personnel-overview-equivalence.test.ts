/** The bounded Personnel overview returns exactly the exact owner's rows, order, counts, headcount and
 * choices for every list filter, sort and private search, for an HR administrator and for a scoped
 * manager (allow on two companies, explicit deny on a descendant), with and without the unallocated
 * typed-facts draft installed. The exact reader (`compareExact`) is the pre-existing implementation. */
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {client as applicationClient,type SessionContext} from '../db/client';
import {readPersonnelOverview} from '../core/read';
import {createPersonnelPrivateSearch} from '../core/personnel-private-search';
import {workforceViewScope} from '../core/workforce-access';
import {headcountFilters,parsePersonnelListQuery,type PersonnelSearchParams} from '../app/admin/personnel/list-query';
import {EMPLOYEE_COLUMN_KEYS} from '../lib/employee-columns';
import {closeAll,migrateTestDb,owner} from './harness';
import {restoreWorkforceCapabilityCatalogue,seedPersonnelScaleFixture,type PersonnelScaleFixture} from './performance/personnel-scale-fixture';

const draft=readFileSync(new URL('../db/migration-drafts/personnel_overview_facts.sql',import.meta.url),'utf8');
const dropDraft='drop function if exists app.personnel_overview_facts(date,uuid[]), app.personnel_private_search_entries(text,uuid[]), app.personnel_list_rows_for_ids(date,uuid[],uuid[])';
type Overview=Awaited<ReturnType<typeof readPersonnelOverview>>;
const normalize=(value:Overview)=>({...value,organisationChoices:{...value.organisationChoices,
 rows:value.organisationChoices.rows.map(row=>JSON.stringify(row)).sort()}});

let fixture:PersonnelScaleFixture;
beforeAll(async()=>{await migrateTestDb();fixture=await seedPersonnelScaleFixture(640);},180_000);
afterAll(async()=>{try{await owner.client.unsafe(dropDraft);await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);

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

async function compareAll(role:'admin'|'manager'){
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
  const source=traced.sql.includes('app.personnel_overview_facts(')?'facts'
   :traced.sql.includes('app.personnel_overview_filter_fields(')?'filter-fields':'exact';
  used[source]++;
  expect(normalize(traced.result),role+' '+name+' via '+source).toEqual(normalize(exact));
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
  const [counts]=await owner.client<{all:number;manager:number;terminated:number}[]>`select
   count(*)::int as all,count(*) filter(where company_id=any(${fixture.managerVisibleCompanies}::uuid[]))::int as manager,
   count(*) filter(where terminated_on is not null)::int as terminated
   from employment where tenant_id=${fixture.base.tenantId}::uuid`;
  expect(counts.terminated).toBeGreaterThan(0);
  const list=(ctx:SessionContext,companyIds:string[])=>readPersonnelOverview(ctx,{companyIds,...parsePersonnelListQuery({}).filters,limit:25,offset:0},headcountFilters(parsePersonnelListQuery({})));
  const adminList=await list(fixture.admin,admin.companyIds),managerList=await list(fixture.manager,manager.companyIds);
  expect(adminList.employees.total).toBe(counts.all);expect(adminList.headcount.total).toBe(counts.all);
  expect(managerList.employees.total).toBe(counts.manager);expect(managerList.headcount.total).toBe(counts.manager);
  expect(managerList.employees.rows.length).toBe(25);
  expect(managerList.employees.rows.every(row=>fixture.managerVisibleCompanies.includes(row.companyId))).toBe(true);
  const terminated=await readPersonnelOverview(fixture.admin,{companyIds:admin.companyIds,...parsePersonnelListQuery({status:'terminated'}).filters,limit:25,offset:0},{});
  expect(terminated.employees.total).toBe(counts.terminated);
  // Names repeat in the fixture, so the order also proves the employment-ID tie-break.
  const names=adminList.employees.rows.map(row=>row.name);expect(names).toEqual([...names].sort((x,y)=>x<y?-1:x>y?1:0));
 },120_000);

 for(const role of ['admin','manager'] as const){
  it(`matches the exact owner for every filter, sort and search without the typed-facts draft (${role})`,async()=>{
   await owner.client.unsafe(dropDraft);
   const {used,compared,nonEmpty}=await compareAll(role);
   expect(compared).toBeGreaterThan(60);expect(nonEmpty).toBeGreaterThan(40);
   // Department, business unit, position, type, confirmation, probation and most sorts are now bounded.
   expect(used['filter-fields']).toBeGreaterThan(40);expect(used.facts).toBe(0);
  },600_000);
  it(`matches the exact owner for every filter, sort and search with the typed-facts draft (${role})`,async()=>{
   await owner.client.unsafe(draft);
   try{
    const {used,compared}=await compareAll(role);
    expect(compared).toBeGreaterThan(60);
    // Every case is bounded once the complete typed projection is installed.
    expect(used.exact).toBe(0);expect(used.facts).toBeGreaterThan(30);
   }finally{await owner.client.unsafe(dropDraft);}
  },600_000);
 }
});
