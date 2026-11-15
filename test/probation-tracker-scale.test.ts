/**
 * Tracker read at the shape of a real group (docs/SCALE-AND-RELEASE-RULES.md rule 3): 72 companies and 1,080 cases, read
 * under "All companies" and under one company, and compared with the previous reader (same rows, same order, same
 * counts) for every existing tile, plus an independent count for the new "Suggestion overridden" tile and the
 * Ext. column. Fixture rows are fictional and generated set-based.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes,probationSummaryRows,type ProbationTrackerFlag} from '../packs/probation/service';

const COMPANIES=72,PER_COMPANY=15;
let b:Base,admin:SessionContext;
const today=todayInKualaLumpur();
type Flag=Exclude<ProbationTrackerFlag,'overridden'>;
/** The tile expressions exactly as the reader had them before this change (kpi_submit now also waits for the start date). */
const previousFlags:Record<Flag,ReturnType<typeof sql>>={
 overdue:sql`exists(select 1 from probation_part p where p.case_id=c.id and p.tenant_id=c.tenant_id and p.data->>'state' not in('locked','completed_offline','cancelled') and (p.data->>'dueOn')::date<${today}::date)`,
 end_passed:sql`(c.data->>'endOn')::date<${today}::date and c.data->>'state' not in('confirmed','not_confirmed','withdrawn')`,
 ending14:sql`(c.data->>'endOn')::date between ${today}::date and ${addDaysIso(today,14)}::date and c.data->>'state' not in('confirmed','not_confirmed','withdrawn')`,
 low_result:sql`exists(select 1 from probation_part p where p.case_id=c.id and p.tenant_id=c.tenant_id and (p.data->>'scoreBand')::integer<=2 and p.data->>'state'<>'cancelled')`,
 kpi_submit:sql`exists(select 1 from probation_part p where p.case_id=c.id and p.tenant_id=c.tenant_id and p.data->>'type'='1' and p.data->>'managerSubmittedAt' is null and p.data->>'state' not in('completed_offline','cancelled'))`,
 kpi_ack:sql`exists(select 1 from probation_part p where p.case_id=c.id and p.tenant_id=c.tenant_id and p.data->>'type'='1' and p.data->>'managerSubmittedAt' is not null and p.data->>'acknowledgedAt' is null and p.data->>'state' not in('completed_offline','cancelled'))`,
};
async function previousReader(ctx:SessionContext,filters:{companyId?:string;flag?:Flag}){
 return withTenant(ctx,async tx=>{
  const where=sql`where c.tenant_id=${ctx.tenantId}::uuid ${filters.companyId?sql`and c.company_id=${filters.companyId}::uuid`:sql``}`;
  const[counts]=await tx.execute<Record<'total'|Flag,number>>(sql`select count(*) filter(where ${filters.flag?previousFlags[filters.flag]:sql`true`})::integer as total,count(*) filter(where ${previousFlags.overdue})::integer as overdue,count(*) filter(where ${previousFlags.end_passed})::integer as end_passed,count(*) filter(where ${previousFlags.ending14})::integer as ending14,count(*) filter(where ${previousFlags.low_result})::integer as low_result,count(*) filter(where ${previousFlags.kpi_submit})::integer as kpi_submit,count(*) filter(where ${previousFlags.kpi_ack})::integer as kpi_ack from probation_case c ${where}`);
  const ids=await tx.execute<{id:string}>(sql`select c.id from probation_case c ${where} ${filters.flag?sql`and ${previousFlags[filters.flag]}`:sql``} order by (c.data->>'endOn')::date,c.id`);
  return{counts,ids:ids.map(r=>r.id)};
 });
}
/** First, second and last pages of the current reader; the previous reader's full ordered list must contain them in place. */
async function currentPages(ctx:SessionContext,filters:{companyId?:string;flag?:ProbationTrackerFlag},total:number){
 const offsets=[...new Set([0,100,Math.max(0,Math.floor((total-1)/100)*100)])];
 const pages=[];for(const offset of offsets)pages.push({offset,page:await probationSummaryRows(ctx,{...filters,offset,limit:100})});
 return pages;
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);
 const[hr]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Scale People Ops',${randomUUID()+'@scale.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${hr.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hr.id};
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',bpRules:[]})}::jsonb)`);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups:[{id:'probation-people',name:'Canonical People Ops',members:[admin.userId],limit:10}]})}::jsonb)`);
 const ids={settings:randomUUID(),form:randomUUID(),route:randomUUID()};
 await owner.db.execute(sql`insert into probation_configuration(id,tenant_id,company_id,kind,version,state,data,created_by) values(${ids.settings}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'settings',1,'published',${JSON.stringify(DEFAULT_PROBATION_CONFIG)}::jsonb,${admin.userId}::uuid),(${ids.form}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'form',1,'published',${JSON.stringify(DEFAULT_PROBATION_FORM)}::jsonb,${admin.userId}::uuid),(${ids.route}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'route',1,'published',${JSON.stringify(defaultProbationRoutes())}::jsonb,${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into company(tenant_id,legal_name,country,currency) select ${b.tenantId}::uuid,'Fictional Scale Company '||lpad(n::text,3,'0'),'MY','MYR' from generate_series(1,${COMPANIES}) n`);
 await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) select ${b.tenantId}::uuid,${admin.userId}::uuid,c.id,'gbs','2026-01-01','Scale fixture People Ops' from company c where c.tenant_id=${b.tenantId}::uuid and c.legal_name like 'Fictional Scale Company %'`);
 await owner.db.execute(sql`insert into person(tenant_id,full_name,primary_email) select ${b.tenantId}::uuid,'Fictional Scale Employee '||lpad(n::text,5,'0'),'scale-'||n||'-'||${randomUUID()}||'@scale.example.test' from generate_series(1,${COMPANIES*PER_COMPANY}) n`);
 await owner.db.execute(sql`
  with people as (select id,row_number() over(order by full_name) n from person where tenant_id=${b.tenantId}::uuid and full_name like 'Fictional Scale Employee %'),
  companies as (select id,row_number() over(order by legal_name)-1 k from company where tenant_id=${b.tenantId}::uuid and legal_name like 'Fictional Scale Company %')
  insert into employment(tenant_id,person_id,company_id,hired_on) select ${b.tenantId}::uuid,p.id,c.id,${today}::date-((p.n%200)::integer) from people p join companies c on c.k=(p.n-1)%${COMPANIES}`);
 // Cases rotate through states, ends (passed, within 14 days, later), extensions and settled/open parts.
 await owner.db.execute(sql`
  with rows as (
   select gen_random_uuid() as cid,e.id as employment_id,e.company_id,row_number() over(order by e.id) n,e.hired_on as start_on
   from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id where e.tenant_id=${b.tenantId}::uuid and p.full_name like 'Fictional Scale Employee %')
  insert into probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data)
  select r.cid,${b.tenantId}::uuid,r.company_id,r.employment_id,'employment:'||r.employment_id,${ids.settings}::uuid,${ids.form}::uuid,${ids.route}::uuid,
   jsonb_build_object('id',r.cid,'employmentId',r.employment_id,'companyId',r.company_id,'sourceKey','employment:'||r.employment_id,'startOn',r.start_on::text,'originalEndOn',(r.start_on+180)::text,
    'endOn',(r.start_on+(array[150,190,210,400])[1+r.n%4])::text,'gradeAtStart',(12+r.n%5)::text,'revision',1,'planMonths',6,'planFlag',r.n%9=0,'extensionCount',r.n%3,'kpiAcknowledged',r.n%2=0,
    'state',(array['kpi_setting','in_review','pending_approval','confirmed','withdrawn','extended'])[1+r.n%6],'pendingOutcome',null,'config',jsonb_build_object('maxExtensions',2),
    'facts',jsonb_build_object('employeeName','Fictional Scale Employee '||r.n,'businessGroupId',r.company_id,'businessGroup','Fictional group','holders',jsonb_build_object('employee',null,'lm',null,'hod',null,'pbp',null)))
  from rows r`);
 await owner.db.execute(sql`
  with cases as (select id,row_number() over(order by id) n,(data->>'startOn')::date start_on from probation_case where tenant_id=${b.tenantId}::uuid)
  insert into probation_part(id,tenant_id,case_id,data)
  select x.pid,${b.tenantId}::uuid,c.id,jsonb_build_object('id',x.pid,'type',x.type,'cycle',0,'revision',1,'state',x.state,'dueOn',x.due::text,'issueOn',(x.due-30)::text,'reviewOn','','conductedBy',null,
   'staffSubmittedAt',null,'managerSubmittedAt',case when c.n%3=0 then now()::text end,'acknowledgedAt',case when c.n%6=0 then now()::text end,'kpiException',null,'employeeWaitException',null,'offlinePdfId',null,
   'scoreBand',case when x.type=3 and c.n%4=0 then 1+c.n%5 end,'override',x.type=3 and c.n%7=0)
  from cases c cross join lateral (values
   (gen_random_uuid(),1,(array['issued','locked','completed_offline','cancelled'])[1+c.n%4],c.start_on+7),
   (gen_random_uuid(),3,(array['not_issued','issued','pending_approval','locked','cancelled'])[1+c.n%5],c.start_on+(array[150,190,210,400])[1+c.n%4])) x(pid,type,state,due)`);
});

describe('tracker read at real-group shape',()=>{
 it('returns the same rows, order and counts as the previous reader under All companies and one company, with the new tile counted independently',async()=>{
  const[shape]=await owner.db.execute<{companies:number;cases:number}>(sql`select count(distinct company_id)::int companies,count(*)::int cases from probation_case where tenant_id=${b.tenantId}::uuid`);
  expect(shape.companies).toBeGreaterThanOrEqual(70);expect(shape.cases).toBeGreaterThanOrEqual(1000);
  const[expected]=await owner.db.execute<{overridden:number;company:string}>(sql`select count(distinct c.id) filter(where p.data->>'override'='true' and p.data->>'state'<>'cancelled')::int overridden,(select company_id::text from probation_case where tenant_id=${b.tenantId}::uuid group by company_id order by count(*) desc,company_id limit 1) company from probation_case c join probation_part p on p.case_id=c.id where c.tenant_id=${b.tenantId}::uuid`);
  expect(expected.overridden).toBeGreaterThan(0);
  for(const companyId of [undefined,expected.company]){
   const previous=await previousReader(admin,{companyId});
   expect(previous.ids.length).toBeGreaterThan(0);
   const pages=await currentPages(admin,{companyId},previous.counts.total);
   for(const{offset,page}of pages){
    expect(page.rows.map(r=>r.id)).toEqual(previous.ids.slice(offset,offset+100));
    expect(page.total).toBe(previous.counts.total);
    const{overridden,...existing}=page.totals;
    expect(existing).toEqual({overdue:previous.counts.overdue,end_passed:previous.counts.end_passed,ending14:previous.counts.ending14,low_result:previous.counts.low_result,kpi_submit:previous.counts.kpi_submit,kpi_ack:previous.counts.kpi_ack});
    if(!companyId)expect(overridden).toBe(expected.overridden);
    expect(page.rows.every(row=>row.extensionMax===2&&row.startStatus!=='waiting_for_start')).toBe(true);
   }
   expect(pages.at(-1)!.page.hasMore).toBe(false);
   const overriddenPage=await probationSummaryRows(admin,{companyId,flag:'overridden',limit:100});
   expect(overriddenPage.total).toBe(pages[0].page.totals.overridden);
   expect(overriddenPage.rows.every(row=>row.parts.some(part=>part.override&&part.state!=='cancelled'))).toBe(true);
  }
  for(const flag of Object.keys(previousFlags) as Flag[]){
   const before=await previousReader(admin,{flag}),page=await probationSummaryRows(admin,{flag,limit:100});
   expect(page.rows.map(r=>r.id)).toEqual(before.ids.slice(0,100));expect(page.total).toBe(before.counts.total);
  }
 },180000); // 72 companies and 1,080 cases, about fifteen tracker reads; not yet measured on CI, so generous headroom.
 it('shows nothing to a person without case access',async()=>{
  const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional outsider',${randomUUID()+'@scale.example.test'}) returning id`);
  const userId=await createAppUser(b.tenantId,p.id,'employee');
  const page=await probationSummaryRows({...admin,userId,personId:p.id,roles:['employee'],grants:undefined},{limit:100});
  expect(page.rows).toEqual([]);expect(page.total).toBe(0);expect(page.totals.overridden).toBe(0);
 });
});
