/**
 * Tracker read at the shape of a real group (docs/SCALE-AND-RELEASE-RULES.md rule 3): 72 companies and 1,080 cases, read
 * under "All companies" and under one company, and compared with the previous reader (same rows, same order, same
 * counts) for every existing tile, plus an independent count for the new "Suggestion overridden" tile and the
 * Ext. column. Fixture rows are fictional and generated set-based.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
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
/**
 * The previous access rule, exactly as migration 0949 defined it (test/helpers/probation-access-reference.sql), applied
 * per case inside one SECURITY DEFINER reader, so it is independent of the set-based owner of the rule (migration 5746).
 */
async function installReference(){
 for(const statement of readFileSync('test/helpers/probation-access-reference.sql','utf8').split(/\n(?=CREATE OR REPLACE FUNCTION )/).filter(text=>text.includes('CREATE OR REPLACE FUNCTION')))await owner.db.execute(sql.raw(statement));
 await owner.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION app.probation_visible_reference() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT c.id FROM public.probation_case c WHERE c.tenant_id=app.current_tenant_id() AND app.probation_case_access_reference(c.id) $$`));
 await owner.db.execute(sql.raw('GRANT EXECUTE ON FUNCTION app.probation_visible_reference() TO ai_hr_app'));
}
/** Logs the plans of the statements inside the visible-set function for one viewer (auto_explain at NOTICE level, owner session). */
async function explainNested(ctx:SessionContext){
 try{
  await owner.withTenant(ctx,async tx=>{
   await tx.execute(sql.raw("LOAD 'auto_explain'"));
   for(const setting of ["set local auto_explain.log_min_duration=50","set local auto_explain.log_nested_statements=on","set local auto_explain.log_analyze=on","set local auto_explain.log_level='notice'"])await tx.execute(sql.raw(setting));
   await timed('visible set under auto_explain (viewer, owner session)',()=>tx.execute(sql`select count(*) from app.probation_visible_among(null)`));
  });
 }catch(error){console.log('[probation-tracker-scale] auto_explain unavailable: '+(error instanceof Error?error.message:String(error)));}
}
async function previousVisible(ctx:SessionContext){
 return timed('previous access rule (0949, per case) '+(ctx.userId===admin.userId?'GBS':'viewer'),async()=>(await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select app.probation_visible_reference() as id`))).map(r=>r.id).sort());
}
async function currentVisible(ctx:SessionContext){
 return timed('visible set (5746, set-based) '+(ctx.userId===admin.userId?'GBS':'viewer'),async()=>(await withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select app.probation_visible_case_ids() as id`))).map(r=>r.id).sort());
}
async function previousReader(visible:string[],filters:{companyId?:string;flag?:Flag}){
 const ids=sql`array[${visible.length?sql.join(visible.map(id=>sql`${id}::uuid`),sql`, `):sql``}]::uuid[]`;
 const where=sql`where c.tenant_id=${b.tenantId}::uuid and c.id=any(${ids}) ${filters.companyId?sql`and c.company_id=${filters.companyId}::uuid`:sql``}`;
 const[counts]=await owner.db.execute<Record<'total'|Flag,number>>(sql`select count(*) filter(where ${filters.flag?previousFlags[filters.flag]:sql`true`})::integer as total,count(*) filter(where ${previousFlags.overdue})::integer as overdue,count(*) filter(where ${previousFlags.end_passed})::integer as end_passed,count(*) filter(where ${previousFlags.ending14})::integer as ending14,count(*) filter(where ${previousFlags.low_result})::integer as low_result,count(*) filter(where ${previousFlags.kpi_submit})::integer as kpi_submit,count(*) filter(where ${previousFlags.kpi_ack})::integer as kpi_ack from probation_case c ${where}`);
 const rows=await owner.db.execute<{id:string}>(sql`select c.id from probation_case c ${where} ${filters.flag?sql`and ${previousFlags[filters.flag]}`:sql``} order by (c.data->>'endOn')::date,c.id`);
 return{counts,ids:rows.map(r=>r.id)};
}
const timings:string[]=[];
function timing(label:string,started:number){const line=`[probation-tracker-scale] ${label}: ${Date.now()-started} ms`;timings.push(line);console.log(line);}
async function timed<T>(label:string,work:()=>Promise<T>){const started=Date.now();const result=await work();timing(label,started);return result;}
/** First, second and last pages of the current reader; the previous reader's full ordered list must contain them in place. */
async function currentPages(ctx:SessionContext,filters:{companyId?:string;flag?:ProbationTrackerFlag},total:number){
 const offsets=[...new Set([0,100,Math.max(0,Math.floor((total-1)/100)*100)])];
 const pages=[];for(const offset of offsets)pages.push({offset,page:await timed(`tracker read ${filters.companyId?'one company':'all companies'} offset ${offset}`,()=>probationSummaryRows(ctx,{...filters,offset,limit:100}))});
 return pages;
}

beforeAll(async()=>{await migrateTestDb();await installReference();});afterAll(closeAll);
beforeEach(async()=>{
 const seeded=Date.now();
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
 timing('fixture seed (72 companies, 1,080 cases, 2,160 parts)',seeded);
});

describe('tracker read at real-group shape',()=>{
 it('returns the same rows, order and counts as the previous reader under All companies and one company, with the new tile counted independently',async()=>{
  const[shape]=await owner.db.execute<{companies:number;cases:number}>(sql`select count(distinct company_id)::int companies,count(*)::int cases from probation_case where tenant_id=${b.tenantId}::uuid`);
  expect(shape.companies).toBeGreaterThanOrEqual(70);expect(shape.cases).toBeGreaterThanOrEqual(1000);
  const[expected]=await owner.db.execute<{overridden:number;company:string}>(sql`select count(distinct c.id) filter(where p.data->>'override'='true' and p.data->>'state'<>'cancelled')::int overridden,(select company_id::text from probation_case where tenant_id=${b.tenantId}::uuid group by company_id order by count(*) desc,company_id limit 1) company from probation_case c join probation_part p on p.case_id=c.id where c.tenant_id=${b.tenantId}::uuid`);
  expect(expected.overridden).toBeGreaterThan(0);
  const visible=await previousVisible(admin);
  expect(await currentVisible(admin)).toEqual(visible);
  // Every role in the fixture: employee, Line Manager, PBP, delegate and an outsider see exactly what the 0949 rule shows.
  const viewer=async(name:string)=>{const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@scale.example.test'}) returning id`);const userId=await createAppUser(b.tenantId,p.id,'employee');return{person:p.id,ctx:{...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext};};
  const companies=(await owner.db.execute<{id:string}>(sql`select id from company where tenant_id=${b.tenantId}::uuid and legal_name like 'Fictional Scale Company %' order by legal_name limit 3`)).map(r=>r.id);
  const[subject]=await owner.db.execute<{person:string;employment:string;part:string}>(sql`select e.person_id as person,e.id as employment,(select p.id from probation_part p where p.case_id=c.id order by p.id limit 1) as part from probation_case c join employment e on e.id=c.employment_id where c.tenant_id=${b.tenantId}::uuid order by c.id limit 1`);
  const employee=await createAppUser(b.tenantId,subject.person,'employee');
  const manager=await viewer('Fictional Scale Line Manager'),pbp=await viewer('Fictional Scale People Partner'),delegate=await viewer('Fictional Scale Delegate');
  const[managerEmployment]=await owner.db.execute<{id:string}>(sql`insert into employment(tenant_id,person_id,company_id,hired_on) values(${b.tenantId}::uuid,${manager.person}::uuid,${companies[0]}::uuid,'2025-01-01') returning id`);
  await owner.db.execute(sql`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from) select ${b.tenantId}::uuid,c.employment_id,${managerEmployment.id}::uuid,'administrative','2026-01-01' from probation_case c where c.tenant_id=${b.tenantId}::uuid order by c.id limit 40`);
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{bpRules}',${JSON.stringify([{rules:{company:companies},userId:pbp.ctx.userId}])}::jsonb) where tenant_id=${b.tenantId}::uuid`);
  await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) select ${b.tenantId}::uuid,${pbp.ctx.userId}::uuid,id,'pbp','2026-01-01','Scale fixture PBP' from unnest(array[${sql.join(companies.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) id`);
  await owner.db.execute(sql`insert into probation_delegate(tenant_id,part_id,step_id,holder_id,kind,reason,created_by,valid_from) values(${b.tenantId}::uuid,${subject.part}::uuid,'pbp',${delegate.ctx.userId}::uuid,'delegation','Scale fixture delegation',${admin.userId}::uuid,'2026-01-01')`);
  const outsider=await viewer('Fictional Scale Outsider');
  // Head of Department: the first company's employments get an assignment in a department this viewer heads.
  const hod=await viewer('Fictional Scale Department Head');
  const[hodEmployment]=await owner.db.execute<{id:string}>(sql`insert into employment(tenant_id,person_id,company_id,hired_on) values(${b.tenantId}::uuid,${hod.person}::uuid,${companies[0]}::uuid,'2025-01-01') returning id`);
  const[department]=await owner.db.execute<{id:string}>(sql`insert into department(tenant_id,company_id,name,head_employment_id) values(${b.tenantId}::uuid,${companies[0]}::uuid,'Fictional Scale Operations',${hodEmployment.id}::uuid) returning id`);
  await owner.db.execute(sql`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from) select ${b.tenantId}::uuid,c.employment_id,c.company_id,${department.id}::uuid,'full_time','2025-01-01' from probation_case c where c.tenant_id=${b.tenantId}::uuid and c.company_id=${companies[0]}::uuid`);
  for(const[name,ctx,least]of [['employee',{...admin,userId:employee,personId:subject.person,roles:['employee'],grants:undefined} as SessionContext,1],['Line Manager',manager.ctx,40],['PBP',pbp.ctx,1],['delegate',delegate.ctx,1],['Head of Department',hod.ctx,15],['outsider',outsider.ctx,0]] as const){
   const before=await previousVisible(ctx),after=await currentVisible(ctx);await currentVisible(ctx); // a second, warm read separates a cold first statement from the path cost
   if(name==='employee')await explainNested(ctx);
   expect(after,name).toEqual(before);expect(after.length,name).toBeGreaterThanOrEqual(least);
   if(before.length){const previous=await previousReader(before,{}),page=await timed('tracker read '+name,()=>probationSummaryRows(ctx,{limit:100}));expect(page.rows.map(r=>r.id),name).toEqual(previous.ids.slice(0,100));expect(page.total,name).toBe(previous.counts.total);}
  }
  // Profile the set-based pieces for the GBS viewer and log the plans of the two tracker readers.
  const caseIds=visible.slice(0,100);
  await timed('holders for all 1,080 employments (owner call)',()=>owner.withTenant(admin,tx=>tx.execute(sql`select count(*) from app.probation_holders_set(array(select employment_id from probation_case where tenant_id=${b.tenantId}::uuid))`)));
  await timed('tracker page details for 100 cases',()=>withTenant(admin,tx=>tx.execute(sql`select count(*) from app.probation_tracker_page(array[${sql.join(caseIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`)));
  for(const statement of [sql`explain (analyze,buffers) select count(*) from app.probation_tracker_cases()`,sql`explain (analyze,buffers) select * from app.probation_tracker_page(array[${sql.join(caseIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`]){
   const plan=await withTenant(admin,tx=>tx.execute<{'QUERY PLAN':string}>(statement));console.log('[probation-tracker-scale] plan\n'+plan.map(r=>r['QUERY PLAN']).join('\n'));
  }
  for(const companyId of [undefined,expected.company]){
   const previous=await previousReader(visible,{companyId});
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
   const overriddenPage=await timed('tracker read overridden '+(companyId?'one company':'all companies'),()=>probationSummaryRows(admin,{companyId,flag:'overridden',limit:100}));
   expect(overriddenPage.total).toBe(pages[0].page.totals.overridden);
   expect(overriddenPage.rows.every(row=>row.parts.some(part=>part.override&&part.state!=='cancelled'))).toBe(true);
  }
  for(const flag of Object.keys(previousFlags) as Flag[]){
   const before=await previousReader(visible,{flag}),page=await timed('tracker read all companies flag '+flag,()=>probationSummaryRows(admin,{flag,limit:100}));
   expect(page.rows.map(r=>r.id)).toEqual(before.ids.slice(0,100));expect(page.total).toBe(before.counts.total);
  }
 },105000); // Run 43746146505 measured this test at 34.9 s on the CI runner, almost all of it the 0949 reference rule evaluated per case for each viewer (3.3-5.2 s each); about 3x.
 it('shows nothing to a person without case access',async()=>{
  const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional outsider',${randomUUID()+'@scale.example.test'}) returning id`);
  const userId=await createAppUser(b.tenantId,p.id,'employee');
  const page=await probationSummaryRows({...admin,userId,personId:p.id,roles:['employee'],grants:undefined},{limit:100});
  expect(page.rows).toEqual([]);expect(page.total).toBe(0);expect(page.totals.overridden).toBe(0);
 });
});
