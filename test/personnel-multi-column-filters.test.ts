/** aa045103 — the Personnel header filters: Department, Employment Type and Status are multi-select (any of),
 * "Blank / unassigned" combines with chosen values, and date columns take From/To ranges. Every count below is
 * computed independently from the native tables by the migration owner, never from the reader under test.
 * Scope: a selected company outside the reader's Workforce scope narrows to nothing and never widens. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {readPersonnelOverview} from '../core/read';
import {workforceViewScope} from '../core/workforce-access';
import {headcountFilters,parsePersonnelListQuery,personnelQueryParams,type PersonnelSearchParams} from '../app/admin/personnel/list-query';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,migrateTestDb,owner} from './harness';
import {restoreWorkforceCapabilityCatalogue,seedPersonnelScaleFixture,type PersonnelScaleFixture} from './performance/personnel-scale-fixture';

let fixture:PersonnelScaleFixture;
let blanked:string[]=[];
beforeAll(async()=>{
 await migrateTestDb();fixture=await seedPersonnelScaleFixture(320);
 // Give a few current placements no department, so "Blank / unassigned" has rows to find.
 blanked=(await owner.client<{id:string}[]>`update assignment a set department_id=null
  where a.id in (select a2.id from assignment a2 join employment e on e.id=a2.employment_id
   where e.tenant_id=${fixture.base.tenantId}::uuid and e.company_id=${fixture.companies.b}::uuid and a2.superseded_at is null
    and a2.valid_from<=${todayInKualaLumpur()}::date and (a2.valid_to is null or a2.valid_to>${todayInKualaLumpur()}::date)
   order by e.employee_code limit 4) returning a.employment_id as id`).map(row=>row.id);
},240_000);
afterAll(async()=>{try{await restoreWorkforceCapabilityCatalogue();}finally{await closeAll();}},120_000);

const read=async(ctx:SessionContext,sp:PersonnelSearchParams)=>{
 const scope=(await workforceViewScope(ctx,{personnelList:true})).companyIds;
 const query=parsePersonnelListQuery(sp);
 return readPersonnelOverview(ctx,{companyIds:scope,...query.filters,limit:2000,offset:0},headcountFilters(query));
};
/** The native answer: current placement (the applicable, unsuperseded assignment today) per visible employment. */
async function expected(companies:string[],where:(row:{department_id:string|null;employment_type:string|null;hired_on:string;confirmation_date:string|null})=>boolean){
 const day=todayInKualaLumpur();
 const rows=await owner.client<{id:string;department_id:string|null;employment_type:string|null;hired_on:string;confirmation_date:string|null}[]>`
  select e.id,a.department_id,a.employment_type::text as employment_type,e.hired_on::text as hired_on,e.confirmation_date::text as confirmation_date
  from employment e left join lateral (select x.department_id,x.employment_type from assignment x where x.employment_id=e.id and x.superseded_at is null
    and x.valid_from<=${day}::date and (x.valid_to is null or x.valid_to>${day}::date) order by x.valid_from desc,x.id desc limit 1) a on true
  where e.tenant_id=${fixture.base.tenantId}::uuid and e.voided_at is null and e.company_id=any(${companies}::uuid[])`;
 return rows.filter(where).map(row=>row.id).sort();
}
const ids=(result:Awaited<ReturnType<typeof read>>)=>result.employees.rows.map(row=>row.employmentId).sort();

it('Department, Employment Type and Blank / unassigned narrow to any of the ticked values',async()=>{
 const admin=fixture.admin,all=Object.values(fixture.companies);
 const [d1,d2]=[fixture.departments.b[1],fixture.departments.a[0]];
 expect(blanked).toHaveLength(4);
 const cases:[PersonnelSearchParams,Parameters<typeof expected>[1]][]=[
  [{dept:[d1,d2]},row=>row.department_id===d1||row.department_id===d2],
  [{dept:d1+',__blank'},row=>row.department_id===d1||row.department_id===null],
  [{dept:'__blank'},row=>row.department_id===null],
  [{type:'contract,intern'},row=>row.employment_type==='contract'||row.employment_type==='intern'],
  [{type:['part_time','__blank']},row=>row.employment_type==='part_time'||row.employment_type===null],
  [{hiredFrom:'2019-01-01',hiredTo:'2022-12-31'},row=>row.hired_on>='2019-01-01'&&row.hired_on<='2022-12-31'],
  [{confirmedFrom:'2020-06-01'},row=>row.confirmation_date!==null&&row.confirmation_date>='2020-06-01'],
  [{dept:[d1,d2],type:'full_time,contract'},row=>(row.department_id===d1||row.department_id===d2)&&(row.employment_type==='full_time'||row.employment_type==='contract')],
 ];
 let nonEmpty=0;
 for(const [sp,where] of cases){
  const want=await expected(all,where),result=await read(admin,sp);
  expect(ids(result),JSON.stringify(sp)).toEqual(want);
  expect(result.employees.total,JSON.stringify(sp)).toBe(want.length);
  expect(result.headcount.total,JSON.stringify(sp)+' headcount').toBe(want.length);
  if(want.length)nonEmpty++;
 }
 expect(nonEmpty).toBe(cases.length);
 // Blank genuinely adds the unassigned rows rather than replacing the chosen department.
 const one=await read(admin,{dept:d1}),withBlank=await read(admin,{dept:d1+',__blank'});
 expect(withBlank.employees.total).toBe(one.employees.total+(await expected(all,row=>row.department_id===null)).length);
},120_000);

it('several Status values show the employees in any of those statuses, matching the headcount cards',async()=>{
 const admin=fixture.admin;
 const cards=(await read(admin,{})).headcount.byStatus as Record<string,number>;
 const pairs=[['active','probation'],['resigned','active_serving_notice'],['active','probation','resigned','active_serving_notice','blacklisted']];
 for(const buckets of pairs){
  const result=await read(admin,{bucket:buckets.join(',')});
  const want=buckets.reduce((sum,bucket)=>sum+(cards[bucket]??0),0);
  expect(want,buckets.join()).toBeGreaterThan(0);
  expect(result.employees.total,buckets.join()).toBe(want);
  // The cards are a facet of the view without the Status choice: they still show every bucket.
  expect(result.headcount.byStatus).toEqual(cards);
 }
 // Draft alongside a status keeps the employee narrowing (drafts are another table, shown beside them).
 const withDraft=parsePersonnelListQuery({bucket:'resigned,draft'});
 expect(withDraft.draftOnly).toBe(false);expect(withDraft.includeDrafts).toBe(true);
 expect((await read(admin,{bucket:'resigned,draft'})).employees.total).toBe(cards.resigned);
},120_000);

it('a company outside the reader scope narrows to nothing and multi values never widen the scope',async()=>{
 const manager=fixture.manager,visible=fixture.managerVisibleCompanies;
 const hidden=Object.values(fixture.companies).filter(id=>!visible.includes(id));
 expect(hidden.length).toBeGreaterThan(0);
 const depts=Object.values(fixture.departments).flat();
 // Departments of every company, including the hidden ones: only the visible companies' rows come back.
 const want=await expected(visible,row=>row.department_id!==null&&depts.includes(row.department_id));
 const result=await read(manager,{dept:depts.join(',')});
 expect(ids(result)).toEqual(want);expect(want.length).toBeGreaterThan(0);
 expect((await read(manager,{companies:hidden.join(','),dept:depts.join(',')})).employees.total).toBe(0);
 expect((await read(manager,{companies:hidden[0],type:'full_time,part_time,contract,intern,__blank',bucket:'active,probation,resigned'})).employees.total).toBe(0);
},120_000);

it('the export link carries exactly the filters the screen applied (one parse, no dropped value)',()=>{
 const d=fixture.departments.b[1];
 const sp:PersonnelSearchParams={dept:[d,'__blank'],type:'contract,intern',bucket:['active','draft'],bu:'__blank',position:fixture.positions[0]+',__blank',grade:'H,__blank',
  hiredFrom:'2019-01-01',hiredTo:'2022-12-31',confirmedFrom:'2020-01-01',confirmedTo:'2024-12-31',sort:'department',direction:'desc'};
 const screen=parsePersonnelListQuery(sp);
 // The export route reads the same params from the href the page builds (personnelQueryParams).
 const exported=parsePersonnelListQuery(Object.fromEntries(personnelQueryParams(sp)));
 expect(exported.filters).toEqual(screen.filters);
 expect(exported.includeDrafts).toBe(true);expect(exported.buckets).toEqual(['active']);
 expect(screen.filters).toMatchObject({departmentIds:[d],employmentTypes:['contract','intern'],employmentStatuses:['active'],
  blankChoices:['department','businessUnit','position','jobGrade'],hiredFrom:'2019-01-01',hiredTo:'2022-12-31',confirmationFrom:'2020-01-01',confirmationTo:'2024-12-31'});
 // Forged values are dropped rather than reaching SQL.
 expect(parsePersonnelListQuery({dept:'not-a-uuid',type:"x'; drop",bucket:'withhold'}).filters).toMatchObject({departmentIds:[],employmentTypes:[],employmentStatuses:undefined});
});
