/** Compare the unchanged native shell statement around a disposable expression index. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,expect,it} from 'vitest';
import {accountTaskCallerSql,accountTaskStatement,accountTaskStatementSections} from '../core/account-task-bundle';
import {withSharedReadSnapshot,withTenant,type SessionContext,type Tx} from '../db/client';
import {leaveType} from '../db/schema';
import {addHrDays,todayInKualaLumpur} from '../lib/hr-date';
import {buildScaleFixture} from './helpers/ai-centre-scale-fixture';
import {closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

afterAll(closeAll);
const indexName='fixture_employment_person_text_idx';
const modules={attendance:true,claims:false,performance:true,rewards:true,lifecycle:false};

function fullStatement(tx:Tx,session:SessionContext,companyIds:readonly string[]){
 return accountTaskStatement(accountTaskStatementSections(tx,session,modules,{
  companyIds,personal:false,notices:true,
 }),session);
}

function percentile(values:number[],fraction:number){
 const sorted=[...values].sort((a,b)=>a-b);
 return Math.round(sorted[Math.ceil(sorted.length*fraction)-1]*100)/100;
}

it('measures the unchanged shared task query before, with, and after a disposable expression index',async()=>{
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
  const read=(actor:typeof actors[number])=>withSharedReadSnapshot(actor.session,()=>
   withTenant(actor.session,async tx=>{
    await tx.execute(sql`set local jit=off`);
    return Array.from(await tx.execute(fullStatement(tx,actor.session,actor.companyIds)));
   },{readOnlySnapshot:true}));
  const baseline=await Promise.all(actors.map(read));
  for(const rows of baseline){expect(rows).toHaveLength(1);expect(rows[0]?.principal).toBe(true);}

  const report:{
   phase:string;role:string;selectedCompanies:number;samples:number;p50Ms:number;p95Ms:number;indexInCallerPlan:boolean;
  }[]=[];
  async function measure(phase:string){
   for(const [index,actor] of actors.entries()){
    const durations:number[]=[];
    for(let wave=0;wave<4;wave++){
     durations.push(...await Promise.all(Array.from({length:8},async()=>{
      const start=performance.now();
      const rows=await read(actor);
      const duration=performance.now()-start;
      expect(rows).toEqual(baseline[index]);
      return duration;
     })));
    }
    const plan=await withTenant(actor.session,tx=>tx.execute(sql`
     explain (format json) with ${accountTaskCallerSql(actor.session)} select own_ids from task_caller
    `),{readOnlySnapshot:true});
    report.push({phase,role:actor.role,selectedCompanies:actor.companyIds.length,
     samples:durations.length,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),
     indexInCallerPlan:JSON.stringify(plan).includes(indexName)});
   }
  }
  await measure('before');
  let indexBytes=0;
  await owner.client`create index fixture_employment_person_text_idx on public.employment ((person_id::text))`;
  try {
   await owner.client`analyze public.employment`;
   const [storage]=await owner.client`select pg_relation_size('public.fixture_employment_person_text_idx')::int as bytes`;
   indexBytes=storage.bytes;
   expect(indexBytes).toBeGreaterThan(0);
   await measure('with-index');
  }finally{
   await owner.client`drop index public.fixture_employment_person_text_idx`;
   await owner.client`analyze public.employment`;
  }
  await measure('after-removal');
  const [restored]=await owner.client`select to_regclass('public.fixture_employment_person_text_idx') is null as passed`;
  expect(restored.passed).toBe(true);
  const evidence={releaseEligible:false,source:process.env.AIHR_CI_HEAD,companies:fixture.companyIds.length,
   employments:fixture.employmentIds.length,indexBytes,indexRestored:restored.passed,results:report};
  console.info('ACCOUNT_TASK_EXPRESSION_INDEX '+JSON.stringify(evidence));
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR){
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'account-task-expression-index.json'),JSON.stringify(evidence,null,2));
  }
},240_000);
