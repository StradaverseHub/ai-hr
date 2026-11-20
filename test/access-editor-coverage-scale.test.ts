import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {workerDb} from './db-names';
import {buildScaleFixture} from './helpers/ai-centre-scale-fixture';
import {PROJECT_INSTALLED_OWNERSHIP} from './helpers/installed-owner-projection';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('preserves the complete Access editor state while computing effective ancestry once at group scale',async()=>{
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 expect(pool).toBeTruthy();
 const db=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(db.hostname).toBe('127.0.0.1');
 expect(db.pathname).toBe('/'+workerDb(pool!));
 await resetDb();
 const base=await seedBase(),foreignBase=await seedBase();
 const scope=await buildScaleFixture(base,{events:0});
 const group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;
 const foreign={...adminCtx(foreignBase),grants:[{role:'hr_admin',companyId:null}]} satisfies SessionContext;
 expect(scope.companyIds).toHaveLength(71);
 expect(scope.employmentIds).toHaveLength(1000);
 await owner.db.execute(sql`
  insert into app_user(tenant_id,person_id,workos_user_id)
  select e.tenant_id,e.person_id,'fictional_access_scale_'||e.id::text
  from employment e where e.tenant_id=${base.tenantId}::uuid
   and not exists(select 1 from app_user u where u.tenant_id=e.tenant_id and u.person_id=e.person_id)
 `);

 const replacement=readFileSync(new URL('./fixtures/access-editor-coverage-set-proof.sql',import.meta.url),'utf8');
 const rollback=new Error('Roll back the fictional native owner rehearsal');
 const run=owner.client.begin(async tx=>{
  await tx.unsafe(PROJECT_INSTALLED_OWNERSHIP);
  const pendingBindings=[{owner:'fictional.publication',operation:'read'}];
  await tx`insert into app.access_capability_publication(version,bindings_sha256,state,previous)
   values(9001,repeat('f',64),'publishing',${JSON.stringify({'profile.review':{supported:false,bindings:pendingBindings}})}::jsonb)`;
  await tx`insert into app.access_capability_tenant_publication(version,tenant_id) values(9001,${foreignBase.tenantId}::uuid)`;
  const assume=async(actor:SessionContext)=>{
   await tx.unsafe('set local role ai_hr_app');
   await tx`select set_config('app.tenant_id',${actor.tenantId},true),
    set_config('app.user_id',${actor.userId!},true),set_config('app.roles',${actor.roles!.join(',')},true),
    set_config('app.grants',${JSON.stringify(actor.grants)},true),set_config('jit','off',true)`;
  };
  const state=async(actor:SessionContext)=>{
   await assume(actor);
   const [row]=await tx<{state:{companyIds:string[];coverage:{ancestor:string;company:string}[];snapshot:{users:unknown[]};catalog:{id:string;bindings:unknown}[]}}[]>`
    select app.access_configuration_state() as state
   `;
   return row.state;
  };
  const measure=async()=>{
   await assume(group);
   const [plan]=await tx<{'QUERY PLAN':[{'Execution Time':number}]}[]>`
    explain (analyze,format json,timing off) select app.access_configuration_state()
   `;
   return plan['QUERY PLAN'][0]['Execution Time'];
  };

  const before=await state(group),foreignBefore=await state(foreign),canonicalMs=await measure();
  expect([...before.companyIds].sort()).toEqual([...scope.companyIds].sort());
  expect(before.snapshot.users.length).toBeGreaterThanOrEqual(1000);
  expect(before.coverage).toHaveLength(134);
  expect(before.coverage.filter(pair=>pair.ancestor===base.companyId)).toHaveLength(70);
  expect(foreignBefore.companyIds).toEqual([foreignBase.companyId]);
  expect(foreignBefore.coverage).toEqual([]);
  expect(before.catalog.find(capability=>capability.id==='profile.review')?.bindings).toEqual(pendingBindings);
  expect(foreignBefore.catalog.find(capability=>capability.id==='profile.review')?.bindings).not.toEqual(pendingBindings);

  await tx.unsafe('set local role ai_hr_owner');
  await tx.unsafe(replacement);
  expect(await state(group)).toEqual(before);
  expect(await state(foreign)).toEqual(foreignBefore);
  const candidateMs=await measure();
  expect(Number.isFinite(canonicalMs)&&Number.isFinite(candidateMs)).toBe(true);
  console.info('ACCESS_EDITOR_COVERAGE_PROOF '+JSON.stringify({canonicalMs,candidateMs}));
  throw rollback;
 });
 await run.catch(error=>{if(error!==rollback)throw error;});
},120_000);
