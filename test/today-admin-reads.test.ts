/** HR administrator Today's set-based reads (core/today-admin-reads.ts) at the shape of a real group: 72 companies and
 * 1,080 employments, under "All companies" and under one company, as a group administrator and as an administrator of
 * one company (docs/SCALE-AND-RELEASE-RULES.md rules 1–3).
 *
 *  - Statutory deadlines are EQUIVALENT to the per-company owner they replace on Today (core/reporting.ts
 *    complianceWorklist, which the earlier Watching section called once per company for the first 20 companies only):
 *    the same overdue and due-soon counts and the same earliest deadline, company by company, for every actor and scope.
 *  - Payroll readiness reads each company's own Pre-salary case for its next cut-off: ready, waiting or not checked.
 *  - What the loops did counts the loop ledger's own cases in the window.
 *  - Every read is a fixed number of statements, whatever the number of companies (no per-company loop), takes the
 *    shared Access lock, refuses anyone but an administrator before it reads, and never shows another tenant's rows. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {terasLoopCase,terasLoopPause,terasWorkerControl} from '../db/teras-schema';
import {complianceWorklist} from '../core/reporting';
import {payrollKey,upcomingPeriod} from '../core/loops/payroll-inputs';
import {readAdminExceptionCounts,readAdminLoopHandled,readAdminPayrollReadiness,readAdminStatutoryDeadlines,TodayAdminReadRefused} from '../core/today-admin-reads';
import {openExceptionsAcrossRuns} from '../core/payroll-anomaly';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addCalendarDays} from '../lib/hr-date-calendar';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const COMPANIES=72,PER_COMPANY=15;
const today=todayInKualaLumpur();
let b:Base,group:SessionContext,single:SessionContext,companies:string[],foreignCountry:string,otherTenantCompany:string;
const allOn=()=>true;

beforeAll(async()=>{
 await migrateTestDb();await resetDb();
 b=await seedBase();group={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
 const more=await owner.db.insert(s.company).values(Array.from({length:COMPANIES-1},(_,i)=>({tenantId:b.tenantId,legalName:`Fictional Group Co ${String(i+1).padStart(2,'0')} Sdn Bhd`})))
  .returning({id:s.company.id});
 companies=[b.companyId,...more.map(row=>row.id)];
 // A company in a country no localization pack owns has no statutory deadline (complianceWorklist's own gate).
 const [sg]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Singapore Pte Ltd',country:'SG'}).returning({id:s.company.id});
 foreignCountry=sg.id;
 // 1,080 fictional employments, 15 per company: hires spread over the last 75 days (inside and outside CP22's 60-day
 // window, overdue, due within 7 days and later), every ninth one leaving between 60 days ago and 90 days ahead (CP22A),
 // some of those leaving by death (no computable deadline).
 await owner.client.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email)
   select $1::uuid,'Fictional Today '||g,'today-'||g||'@example.test' from generate_series(1,$2::int) g returning id),
  n as (select id,row_number() over (order by id) k from p)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on,terminated_on,termination_type)
  select $1::uuid,n.id,($3::uuid[])[1+(n.k % array_length($3::uuid[],1))::int],'TD'||lpad(n.k::text,5,'0'),
   $4::date-((n.k*7)%75)::int,
   case when n.k%9=0 then $4::date+(((n.k*11)%150)-60)::int end,
   case when n.k%9=0 then (case when n.k%45=0 then 'death' else 'voluntary' end)::termination_type end
  from n`,[b.tenantId,COMPANIES*PER_COMPANY,`{${companies.join(',')}}`,today]);
 await owner.client.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email) select $1::uuid,'Fictional SG '||g,'sg-'||g||'@example.test' from generate_series(1,6) g returning id)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select $1::uuid,p.id,$2::uuid,'SG'||row_number() over (),$3::date-20 from p`,[b.tenantId,foreignCountry,today]);
 // Another tenant with recent hires and its own loop cases: never visible here.
 const other=await seedBase();otherTenantCompany=other.companyId;
 await owner.client.unsafe(`with p as (insert into person(tenant_id,full_name,primary_email) select $1::uuid,'Fictional other '||g,'other-'||g||'@example.test' from generate_series(1,8) g returning id)
  insert into employment(tenant_id,person_id,company_id,employee_code,hired_on) select $1::uuid,p.id,$2::uuid,'OT'||row_number() over (),$3::date-35 from p`,[other.tenantId,other.companyId,today]);
 // Payroll: a third of the companies close on their own day, the rest at month end.
 await owner.db.insert(s.companyPayrollConfig).values(companies.filter((_,i)=>i%3===0).map((companyId,i)=>({tenantId:b.tenantId,companyId,cutOffDay:20+(i%8)})) as never);
 // One administrator of a single company (the fifth), with a login.
 const userId=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:companies[4]}).where(eq(s.roleAssignment.appUserId,userId));
 single={...adminCtx(b),userId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:companies[4]}]} as SessionContext;
},180_000);
afterAll(closeAll);

const sum=(rows:readonly {status:string}[],status:string)=>rows.filter(row=>row.status===status).length;
/** The per-company owner, one company at a time: what Today's earlier Watching read did, here for EVERY company. */
async function oracle(actor:SessionContext,scope:readonly string[]){
 const out=new Map<string,{overdue:number;dueSoon:number;earliestDue:string|null}>();
 for(const companyId of scope){
  const items=await complianceWorklist(actor,{companyId,today});
  const due=items.filter(item=>item.status==='overdue'||item.status==='due_soon');
  if(!due.length)continue;
  out.set(companyId,{overdue:sum(items,'overdue'),dueSoon:sum(items,'due_soon'),earliestDue:due.map(item=>item.dueBy!).sort()[0]});
 }
 return out;
}

describe('statutory deadlines (CP22 / CP22A), set-based',()=>{
 it('equal the per-company worklist, company by company, under All companies and under one company, for a group and a single-company administrator',async()=>{
  const cases=[{name:'group, all companies',actor:group,scope:[...companies,foreignCountry]},{name:'group, one company',actor:group,scope:[companies[4]]},
   {name:'single-company administrator, all companies',actor:single,scope:[...companies,foreignCountry]},{name:'single-company administrator, own company',actor:single,scope:[companies[4]]}];
  for(const value of cases){
   const expected=await oracle(value.actor,value.scope);
   const read=await readAdminStatutoryDeadlines(value.actor,{scopeIds:value.scope,today});
   expect(new Map(read.companies.map(row=>[row.companyId,{overdue:row.overdue,dueSoon:row.dueSoon,earliestDue:row.earliestDue}])),value.name).toEqual(expected);
   expect(read.overdue,value.name).toBe([...expected.values()].reduce((n,row)=>n+row.overdue,0));
   expect(read.dueSoon,value.name).toBe([...expected.values()].reduce((n,row)=>n+row.dueSoon,0));
   expect(read.earliestDue,value.name).toBe([...expected.values()].map(row=>row.earliestDue).filter(Boolean).sort()[0]??null);
  }
  // The fixture is not trivially empty: most companies have something due, and the single administrator sees one.
  const all=await readAdminStatutoryDeadlines(group,{scopeIds:companies,today});
  expect(all.companies.length).toBeGreaterThan(60);expect(all.overdue).toBeGreaterThan(100);expect(all.dueSoon).toBeGreaterThan(20);
  expect((await readAdminStatutoryDeadlines(single,{scopeIds:companies,today})).companies.map(row=>row.companyId)).toEqual([companies[4]]);
  expect((await readAdminStatutoryDeadlines(group,{scopeIds:[foreignCountry],today})).companies).toEqual([]);
 },120_000);

 it('never counts another tenant\'s people, even when its company is named in the scope',async()=>{
  const read=await readAdminStatutoryDeadlines(group,{scopeIds:[otherTenantCompany],today});
  expect(read).toEqual({overdue:0,dueSoon:0,earliestDue:null,companies:[]});
 });
});

describe('payroll readiness, set-based',()=>{
 it('reads each company\'s own Pre-salary case for its next cut-off: ready, waiting, or not checked; paused and switched off are not checked',async()=>{
  const config=new Map((await owner.db.select({companyId:s.companyPayrollConfig.companyId,cutOffDay:s.companyPayrollConfig.cutOffDay,overtimeCutOffDay:s.companyPayrollConfig.overtimeCutOffDay,
   claimCutOffDay:s.companyPayrollConfig.claimCutOffDay,unpaidLeaveCutOffDay:s.companyPayrollConfig.unpaidLeaveCutOffDay,attendanceCutOffDay:s.companyPayrollConfig.attendanceCutOffDay,
   payDay:s.companyPayrollConfig.payDay}).from(s.companyPayrollConfig).where(eq(s.companyPayrollConfig.tenantId,b.tenantId))).map(row=>[row.companyId,row]));
  // The payroll owner's own rule for each company's next period (core/loops/payroll-inputs.ts upcomingPeriod).
  const next=(companyId:string)=>{const {period,windows}=upcomingPeriod(config.get(companyId)??null,today);return {period,cutOff:windows.salary.end};};
  const run=randomUUID();
  const state=(i:number)=>i%4===0?'done':i%4===1?'open':i%4===2?'none':'stale';
  await owner.db.insert(terasLoopCase).values(companies.flatMap((companyId,i)=>{
   const {period}=next(companyId),kind=state(i);
   if(kind==='none')return [];
   // 'stale': a case for an earlier period only; the next period has not been checked.
   const key=kind==='stale'?payrollKey(companyId,`${Number(period.slice(0,4))-1}${period.slice(4)}`):payrollKey(companyId,period);
   return [{tenantId:b.tenantId,workerId:'loop_payroll_inputs' as const,companyId,subjectKey:key,recipient:'payroll' as const,
    state:kind==='open'?'open' as const:'closed' as const,closeReason:kind==='open'?null:'done' as const,resolution:null,facts:{},openedRunId:run,checkedRunId:run,
    closedAt:kind==='open'?null:new Date()}];
  }));
  const expected=(scope:readonly string[],paused:ReadonlySet<string>=new Set())=>{
   const rows=scope.map(companyId=>{const i=companies.indexOf(companyId),kind=state(i);
    return {companyId,payPeriod:next(companyId).period,cutOff:next(companyId).cutOff,state:paused.has(companyId)||kind==='none'||kind==='stale'?'not_started':kind==='done'?'ready':'waiting'};});
   const first=[...rows].sort((a,b)=>a.cutOff.localeCompare(b.cutOff)||a.payPeriod.localeCompare(b.payPeriod))[0];
   return {companies:rows.length,ready:rows.filter(row=>row.state==='ready').length,waiting:rows.filter(row=>row.state==='waiting').length,
    notStarted:rows.filter(row=>row.state==='not_started').length,nextCutOff:first?.cutOff??null,nextPeriod:first?.payPeriod??null,checking:true,
    rows:[...rows].sort((a,b)=>a.companyId.localeCompare(b.companyId))};
  };
  // Switched off: nothing has been checked.
  const off=await readAdminPayrollReadiness(group,{scopeIds:companies,today,payrollOn:allOn});
  expect(off.checking).toBe(false);expect(off.companies).toBe(COMPANIES);expect(off.notStarted).toBe(COMPANIES);
  await owner.db.insert(terasWorkerControl).values({tenantId:b.tenantId,workerId:'loop_payroll_inputs',enabled:true,changedByUserId:b.adminUserId});
  const sorted=(read:Awaited<ReturnType<typeof readAdminPayrollReadiness>>)=>({...read,rows:[...read.rows].sort((a,c)=>a.companyId.localeCompare(c.companyId))});
  expect(sorted(await readAdminPayrollReadiness(group,{scopeIds:companies,today,payrollOn:allOn}))).toEqual(expected(companies));
  expect(sorted(await readAdminPayrollReadiness(group,{scopeIds:[companies[4]],today,payrollOn:allOn}))).toEqual(expected([companies[4]]));
  expect(sorted(await readAdminPayrollReadiness(single,{scopeIds:companies,today,payrollOn:allOn}))).toEqual(expected([companies[4]]));
  // A paused company has not been checked; a company without payroll in use is not counted.
  await owner.db.insert(terasLoopPause).values({tenantId:b.tenantId,workerId:'loop_payroll_inputs',companyId:companies[0],paused:true,changedByUserId:b.adminUserId});
  const withoutPayroll=new Set(companies.slice(60));
  expect(sorted(await readAdminPayrollReadiness(group,{scopeIds:companies,today,payrollOn:id=>!withoutPayroll.has(id)})))
   .toEqual(expected(companies.slice(0,60),new Set([companies[0]])));
  // Sanity: the fixture covers every state.
  const counts=await readAdminPayrollReadiness(group,{scopeIds:companies,today,payrollOn:allOn});
  expect(counts.ready).toBeGreaterThan(10);expect(counts.waiting).toBeGreaterThan(10);expect(counts.notStarted).toBeGreaterThan(20);
 },120_000);
});

describe('what the loops did, from their own ledger',()=>{
 it('counts cases opened and cases resolved in the window per loop, for the companies in view the caller may see',async()=>{
  const run=randomUUID(),since=new Date(Date.parse(`${addCalendarDays(today,-6)}T00:00:00+08:00`)),old=new Date(since.getTime()-86_400_000*10);
  await owner.db.insert(terasLoopCase).values(companies.flatMap((companyId,i)=>[
   {tenantId:b.tenantId,workerId:'loop_missing_employee_data' as const,companyId,subjectKey:`opened:${companyId}`,recipient:'payroll' as const,state:'open' as const,facts:{},openedRunId:run,checkedRunId:run},
   ...(i%2===0?[{tenantId:b.tenantId,workerId:'loop_missing_employee_data' as const,companyId,subjectKey:`resolved:${companyId}`,recipient:'payroll' as const,state:'closed' as const,
    closeReason:'done' as const,facts:{},openedRunId:run,checkedRunId:run,firstOpenedAt:old,openedAt:old,closedAt:new Date()}]:[]),
   // Opened and closed before the window: not counted.
   {tenantId:b.tenantId,workerId:'loop_document_expiry' as const,companyId,subjectKey:`earlier:${companyId}`,recipient:'payroll' as const,state:'closed' as const,closeReason:'done' as const,
    facts:{},openedRunId:run,checkedRunId:run,firstOpenedAt:old,openedAt:old,closedAt:old},
  ]));
  const all=await readAdminLoopHandled(group,{scopeIds:companies,since});
  expect(all.find(row=>row.workerId==='loop_missing_employee_data')).toEqual({workerId:'loop_missing_employee_data',opened:COMPANIES,done:COMPANIES/2});
  expect(all.find(row=>row.workerId==='loop_document_expiry')).toBeUndefined();
  const one=await readAdminLoopHandled(group,{scopeIds:[companies[4]],since});
  expect(one.find(row=>row.workerId==='loop_missing_employee_data')).toEqual({workerId:'loop_missing_employee_data',opened:1,done:1});
  const own=await readAdminLoopHandled(single,{scopeIds:companies,since});
  expect(own.find(row=>row.workerId==='loop_missing_employee_data')).toEqual({workerId:'loop_missing_employee_data',opened:1,done:1});
 },60_000);
});

describe('open payroll exceptions, set-based',()=>{
 it('equal Operations › Exceptions\' own reader under All companies, and narrow to the company switcher\'s scope',async()=>{
  // One October run per company; a verdict for every employment on it: blocks, reviews and auto-cleared, some resolved,
  // some superseded (a re-evaluation's earlier reading), as the anomaly owner writes them.
  await owner.client.unsafe(`with pp as (insert into pay_period(tenant_id,company_id,period,status) select $1::uuid,c,'2026-10','open' from unnest($2::uuid[]) c returning id,company_id)
   insert into payroll_batch(tenant_id,company_id,pay_period_id,pay_period,run_seq,run_type,batch_date,status) select $1::uuid,pp.company_id,pp.id,'2026-10',1,'regular','2026-10-28','processed' from pp`,
   [b.tenantId,`{${companies.join(',')}}`]);
  await owner.client.unsafe(`with v as (select b.id batch_id,e.id employment_id,row_number() over (order by e.id) n from payroll_batch b join employment e on e.company_id=b.company_id
    where b.tenant_id=$1::uuid and b.pay_period='2026-10')
   insert into payroll_anomaly_verdict(tenant_id,batch_id,employment_id,disposition,resolved_at,superseded_at)
   select $1::uuid,batch_id,employment_id,(array['block','review','auto_clear'])[1+(n%3)::int],case when n%7=0 then now() end,case when n%11=0 then now() end from v`,[b.tenantId]);
  const expected=async(scope:readonly string[])=>{
   const [row]=await owner.client<{total:number;blocking:number}[]>`select count(*)::int total,(count(*) filter (where v.disposition='block'))::int blocking
    from payroll_anomaly_verdict v join payroll_batch b on b.id=v.batch_id where v.tenant_id=${b.tenantId}::uuid and b.company_id = any(${scope as string[]}::uuid[])
     and v.superseded_at is null and v.resolved_at is null and v.disposition<>'auto_clear'`;
   return {total:row.total,blocking:row.blocking};
  };
  const all=await readAdminExceptionCounts(group,{scopeIds:companies});
  const reader=await openExceptionsAcrossRuns(group);
  expect(all).toEqual({total:reader.total,blocking:reader.blocking});
  expect(all).toEqual(await expected(companies));
  expect(all.total).toBeGreaterThan(400);expect(all.blocking).toBeGreaterThan(200);
  expect(await readAdminExceptionCounts(group,{scopeIds:[companies[4]]})).toEqual(await expected([companies[4]]));
  expect(await readAdminExceptionCounts(single,{scopeIds:companies})).toEqual(await expected([companies[4]]));
  expect(await readAdminExceptionCounts(group,{scopeIds:[otherTenantCompany]})).toEqual({total:0,blocking:0});
 },120_000);
});

describe('bounded, authorize-first and shared-locked',()=>{
 it('runs the same number of statements for 72 companies as for one, taking the shared Access lock and never the exclusive one',async()=>{
  const statements=async(read:()=>Promise<unknown>)=>{
   const probe=observeNativeRead({captureQueries:true});
   try{await read();return probe.queries.map(query=>query.sql);}finally{probe.restore();}
  };
  for(const read of [
   (scope:string[])=>readAdminPayrollReadiness(group,{scopeIds:scope,today,payrollOn:allOn}),
   (scope:string[])=>readAdminStatutoryDeadlines(group,{scopeIds:scope,today}),
   (scope:string[])=>readAdminLoopHandled(group,{scopeIds:scope,since:new Date(Date.parse(`${today}T00:00:00+08:00`))}),
   (scope:string[])=>readAdminExceptionCounts(group,{scopeIds:scope}),
  ]){
   const many=await statements(()=>read(companies)),few=await statements(()=>read([companies[4]]));
   const seen=JSON.stringify(many.map(text=>text.slice(0,120)));
   expect(many.length,seen).toBe(few.length);
   expect(many.length,seen).toBeGreaterThan(0);
   expect(many.length,seen).toBeLessThanOrEqual(10);
   expect(many.some(text=>/advisory_xact_lock_shared\(/.test(text)),seen).toBe(true);
   expect(many.some(text=>/pg_(try_)?advisory_xact_lock\(/.test(text)),seen).toBe(false);
  }
 });
 it('refuses anyone but an administrator with a login before it reads, and reads nothing for an empty scope',async()=>{
  const employee={...group,roles:['employee'],grants:[]} as SessionContext;
  const agent={...group,agent:{kind:'worker'}} as unknown as SessionContext;
  const noLogin={...group,userId:undefined} as SessionContext;
  for(const actor of [employee,agent,noLogin]){
   const probe=observeNativeRead();
   try{
    await expect(readAdminPayrollReadiness(actor,{scopeIds:companies,today,payrollOn:allOn})).rejects.toBeInstanceOf(TodayAdminReadRefused);
    await expect(readAdminStatutoryDeadlines(actor,{scopeIds:companies,today})).rejects.toBeInstanceOf(TodayAdminReadRefused);
    await expect(readAdminLoopHandled(actor,{scopeIds:companies,since:new Date()})).rejects.toBeInstanceOf(TodayAdminReadRefused);
    await expect(readAdminExceptionCounts(actor,{scopeIds:companies})).rejects.toBeInstanceOf(TodayAdminReadRefused);
    expect(probe.queries).toEqual([]);expect(probe.properties).toEqual([]);
   }finally{probe.restore();}
  }
  const probe=observeNativeRead();
  try{
   expect((await readAdminPayrollReadiness(group,{scopeIds:[],today,payrollOn:allOn})).companies).toBe(0);
   expect((await readAdminStatutoryDeadlines(group,{scopeIds:[],today})).companies).toEqual([]);
   expect(await readAdminLoopHandled(group,{scopeIds:[],since:new Date()})).toEqual([]);
   expect(probe.queries).toEqual([]);expect(probe.properties).toEqual([]);
  }finally{probe.restore();}
 });
});
