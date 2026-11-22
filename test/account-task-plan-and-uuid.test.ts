/** Compare bound UUIDs and reusable plans for native account tasks on a fictional group. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {SQL,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import {afterAll,expect,it} from 'vitest';
import {accountTaskCallerSql,accountTaskStatement,accountTaskStatementSections} from '../core/account-task-bundle';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {leaveType} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addHrDays} from '../lib/today/audience';
import {buildScaleFixture} from './helpers/ai-centre-scale-fixture';
import {closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

afterAll(closeAll);
const modules={attendance:true,claims:false,performance:true,rewards:true,lifecycle:false};
const dialect=new PgDialect();

const canonicalPersonId=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function typedCaller(session:SessionContext):SQL|null{
 const personId=session.personId;
 if(!personId||!canonicalPersonId.test(personId))return null;
 return sql`task_caller as materialized (
  select array(select e.id from public.employment e where e.person_id=${personId}::uuid) as own_ids
 )`;
}
function fullStatement(tx:Tx,session:SessionContext,companyIds:readonly string[],typed:boolean){
 const statement=accountTaskStatement(accountTaskStatementSections(tx,session,modules,{
  companyIds,personal:false,notices:true,
 }),session);
 const caller=typed?typedCaller(session):null;
 if(!caller)return statement;
 const original=dialect.sqlToQuery(accountTaskCallerSql(session)).sql;
 const matching=statement.queryChunks.filter(chunk=>chunk instanceof SQL&&dialect.sqlToQuery(chunk).sql===original);
 expect(matching).toHaveLength(1);
 return new SQL(statement.queryChunks.map(chunk=>chunk===matching[0]?caller:chunk));
}

function percentile(values:number[],fraction:number){
 const sorted=[...values].sort((a,b)=>a-b);
 return Math.round(sorted[Math.ceil(sorted.length*fraction)-1]*100)/100;
}

it('compares UUID predicates and generic plans for shared account tasks across eight overlapping transactions',async()=>{
  expect(process.env.GITHUB_ACTIONS).toBe('true');
  expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
  expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
  const target=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
  expect(target.hostname).toBe('127.0.0.1');
  expect(target.port).toBe('5433');
  expect(target.pathname).toMatch(/^\/ai_hr_test(?:_w[a-z0-9_]+)?$/i);
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
  const tomorrow=addHrDays(todayInKualaLumpur(),1);
  const [pending] = await owner.client`
    with requests as (
      insert into leave_request (tenant_id, employment_id, leave_type_id, start_date, end_date, days, status)
      select tenant_id, id, ${type.id}::uuid, ${tomorrow}::date, ${tomorrow}::date, 1, 'pending'
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
  const variants=[
    {name:'current',typed:false,prepared:false},
    {name:'typedUuid',typed:true,prepared:false},
    {name:'generic',typed:false,prepared:true},
    {name:'typedUuidGeneric',typed:true,prepared:true},
  ] as const;
  type Actor=typeof actors[number];
  type Variant=typeof variants[number];

  const read=(actor:Actor,variant:Variant)=>withTenant(actor.session,async tx=>{
    const {session}=tx as unknown as {session:{client:postgres.TransactionSql}};
    const connection=session.client;
    await tx.execute(sql`set local jit=off`);
    if (variant.prepared) await tx.execute(sql`set local plan_cache_mode=force_generic_plan`);
    const compiled=dialect.sqlToQuery(fullStatement(tx,actor.session,actor.companyIds,variant.typed));
    const statement=variant.prepared?'/* native account task paired plan proof */ '+compiled.sql:compiled.sql;
    const [backend]=await connection<{pid:number}[]>`select pg_backend_pid() as pid`;
    const counters=()=>connection<{generic:number;custom:number}[]>`
      select coalesce(sum(generic_plans),0)::int as generic,coalesce(sum(custom_plans),0)::int as custom
      from pg_prepared_statements where statement=${statement}`;
    const before=variant.prepared?(await counters())[0]:null;
    const started=performance.now();
    const rows=Array.from(await connection.unsafe(statement,compiled.params as postgres.ParameterOrJSON<never>[],
      {prepare:variant.prepared}));
    const elapsedMs=performance.now()-started;
    if (before) {
      const [after]=await counters();
      expect(after.generic-before.generic).toBe(1);
      expect(after.custom-before.custom).toBe(0);
    }
    return {rows,elapsedMs,backend:backend.pid,warm:(before?.generic??0)>0};
  },{readOnlySnapshot:true});

  const concurrency=8;
  const results=[];
  for (const actor of actors) {
    const control=await read(actor,variants[0]);
    expect(control.rows).toHaveLength(1);
    expect(control.rows[0]?.principal).toBe(true);
    const collected=new Map(variants.map(variant=>[variant.name,[] as Awaited<ReturnType<typeof read>>[]]));
    for (let wave=0;wave<variants.length;wave++) {
      // Rotate mode order so each comparison gets the same position in a wave.
      for (const variant of [...variants.slice(wave),...variants.slice(0,wave)]) {
        const samples=await Promise.all(Array.from({length:concurrency},()=>read(actor,variant)));
        for (const sample of samples) expect(sample.rows).toEqual(control.rows);
        collected.get(variant.name)!.push(...samples);
      }
    }
    const timings=Object.fromEntries(variants.map(variant=>{
      const measured=collected.get(variant.name)!;
      const backends=new Set(measured.map(sample=>sample.backend));
      expect(backends.size).toBeGreaterThan(1);
      const warmSamples=measured.filter(sample=>sample.warm);
      if (variant.prepared) expect(warmSamples.length).toBeGreaterThan(concurrency);
      const durations=measured.map(sample=>sample.elapsedMs);
      return [variant.name,{samples:durations.length,backends:backends.size,warmSamples:warmSamples.length,
        p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),
        warmP95Ms:warmSamples.length?percentile(warmSamples.map(sample=>sample.elapsedMs),.95):null}];
    }));
    results.push({role:actor.role,companies:actor.companyIds.length,timings});
  }

  const employeeActor=actors[2];
  for (const personId of [employee.person_id.toUpperCase(),null]) {
    const actor={...employeeActor,session:{...employeeActor.session,personId}};
    const fallback=await read(actor,variants[1]);
    expect(fallback.rows).toEqual((await read(actor,variants[0])).rows);
  }
  const [other]=await owner.client`
    select person_id from public.employment where tenant_id=${base.tenantId}::uuid
      and person_id<>${employee.person_id}::uuid order by id limit 1
  `;
  const mismatch={...employeeActor,session:{...employeeActor.session,personId:other.person_id}};
  for (const variant of variants) expect((await read(mismatch,variant)).rows[0]?.principal).toBe(false);
  const evidence={releaseEligible:false,source:process.env.AIHR_CI_HEAD,concurrency,
    companies:fixture.companyIds.length,employments:fixture.employmentIds.length,results};
  console.info('ACCOUNT_TASK_PLAN_AND_UUID '+JSON.stringify(evidence));
  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) {
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'account-task-plan-and-uuid.json'),JSON.stringify(evidence,null,2));
  }
},240_000);
