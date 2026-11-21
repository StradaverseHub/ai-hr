/** Compare the full native shell statement with one test-only typed predicate substitution. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql,SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,expect,it} from 'vitest';
import {accountTaskCallerSql,accountTaskStatement,accountTaskStatementSections} from '../core/account-task-bundle';
import {readPreparedTenantRows,withSharedReadSnapshot,type SessionContext,type Tx} from '../db/client';
import {leaveType} from '../db/schema';
import {buildScaleFixture} from './helpers/ai-centre-scale-fixture';
import {closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

afterAll(closeAll);
const dialect=new PgDialect();
const modules={attendance:true,claims:false,performance:true,rewards:true,lifecycle:false};

function fullStatement(tx:Tx,session:SessionContext,companyIds:readonly string[],typed:boolean){
 const statement=accountTaskStatement(accountTaskStatementSections(tx,session,modules,{
  companyIds,personal:false,notices:true,
 }),session);
 if(!typed||!session.personId)return statement;
 const original=dialect.sqlToQuery(accountTaskCallerSql(session)).sql;
 const matching=statement.queryChunks.filter(chunk=>chunk instanceof SQL&&dialect.sqlToQuery(chunk).sql===original);
 expect(matching).toHaveLength(1);
 const caller=sql`task_caller as materialized (
  select array(select e.id from public.employment e where e.person_id=${session.personId}::uuid) as own_ids
 )`;
 return new SQL(statement.queryChunks.map(chunk=>chunk===matching[0]?caller:chunk));
}

function percentile(values:number[],fraction:number){
 const sorted=[...values].sort((a,b)=>a-b);
 return Math.round(sorted[Math.ceil(sorted.length*fraction)-1]*100)/100;
}

it('preserves complete shell task facts while comparing scoped prepared reads across eight concurrent requests',async()=>{
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  for (const code of ['attendance', 'performance', 'rewards', 'lifecycle']) {
    await setModule(base.tenantId, code, 'active');
  }
  const fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);

  const [type] = await owner.db.insert(leaveType).values({
    tenantId: base.tenantId, code: 'PERF_TASK_PROFILE', name: 'Fictional task profile leave',
  }).returning({ id: leaveType.id });
  const [pending] = await owner.client`
    with requests as (
      insert into leave_request (tenant_id, employment_id, leave_type_id, start_date, end_date, days, status)
      select tenant_id, id, ${type.id}::uuid, current_date + 1, current_date + 1, 1, 'pending'
      from employment
      where tenant_id=${base.tenantId}::uuid and employee_code ~ '^FX-[0-9]{4}$' and terminated_on is null
      returning id, tenant_id, employment_id
    ), steps as (
      insert into leave_approval_step (tenant_id, leave_request_id, subject_employment_id, step_index, approver_kind)
      select tenant_id,id,employment_id,0,'hr_admin' from requests
      returning id
    )
    select (select count(*)::int from requests) as requests,(select count(*)::int from steps) as steps
  `;
  expect(pending.requests).toBeGreaterThan(900);
  expect(pending.steps).toBe(pending.requests);
  await owner.client`analyze public.leave_request, public.leave_approval_step`;
  const [employee] = await owner.client`
    select person_id,company_id from employment
    where id=${fixture.activeEmploymentIds[0]}::uuid
  `;
  const employeeContext: SessionContext = {
    ...fixture.personas.group,
    personId: employee.person_id,
    userId: await createAppUser(base.tenantId, employee.person_id, 'employee'),
    roles: ['employee'],
    grants: [{ role: 'employee', companyId: null }],
  };
  const actors=[
    {role:'group HR',session:fixture.personas.group,companyIds:fixture.companyIds},
    {role:'company HR',session:fixture.personas.single,companyIds:[fixture.singleCompanyId]},
    {role:'employee',session:employeeContext,companyIds:[employee.company_id]},
  ];
  const read=async (actor:typeof actors[number],typed:boolean)=>withSharedReadSnapshot(actor.session,()=>
   readPreparedTenantRows(actor.session,tx=>fullStatement(tx,actor.session,actor.companyIds,typed)));
  const result=[];
  for(const actor of actors){
   const baseline=await read(actor,false);
   expect(baseline).toHaveLength(1);
   expect(baseline[0]?.principal).toBe(true);
   expect(await read(actor,true)).toEqual(baseline);
   const durations={current:[] as number[],typed:[] as number[]};
   for(const order of [[false,true],[true,false],[false,true],[true,false]]){
    for(const typed of order){
     const wave=await Promise.all(Array.from({length:8},async()=>{
      const start=performance.now();
      const rows=await read(actor,typed);
      const duration=performance.now()-start;
      expect(rows).toEqual(baseline);
      return duration;
     }));
     durations[typed?'typed':'current'].push(...wave);
    }
   }
   const stats=Object.fromEntries(Object.entries(durations).map(([mode,values])=>[mode,{
    samples:values.length,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),
   }]));
   result.push({role:actor.role,selectedCompanies:actor.companyIds.length,...stats});
  }
  console.info('ACCOUNT_TASK_FULL_READ '+JSON.stringify(result));
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR){
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'account-task-full-read.json'),
    JSON.stringify({releaseEligible:false,companies:fixture.companyIds.length,employments:fixture.employmentIds.length,results:result},null,2));
  }
},240_000);
