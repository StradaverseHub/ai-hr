/** Proposed narrow private aggregate: populated, restricted-owner application and closed ACL/RLS boundary. */
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {offlineGroupCountSql,installOfflineGroupCountProposal} from './helpers/mobile-offline-group-count';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(async()=>{await migrateTestDb();await installOfflineGroupCountProposal();});afterAll(async()=>{vi.unstubAllEnvs();await closeAll();});
const script=(path:string)=>readFileSync(path,'utf8').replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'');
it('applies the exact proposal as NOCREATEROLE/NOBYPASSRLS ai_hr_owner and counts private populated rows after cleanup',async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','synthetic-group-count-owner-fixture');await resetDb();const b=await seedBase(),f=await offlineServiceFixture(b),ctx=adminCtx(b);
 const settings=await withTenant(ctx,async tx=>{
  const rows=await tx.execute<{name:string;value:string}>(sql`select name,current_setting(name,true) value from unnest(array['app.tenant_id','app.user_id','app.roles','app.grants','app.agent_principal_id']) name`);
  return rows.filter(row=>row.value!==null).map(row=>[row.name,row.value] as const);
 });
 const rollback=new Error('rollback disposable owner-shape rehearsal');
 await expect(owner.client.begin(async tx=>{
  // This whole populated owner-shape rehearsal rolls back: no prefix object or role owner is left changed.
  await tx.unsafe(`do $$ begin if not exists(select 1 from pg_roles where rolname='ai_hr_owner') then
   create role ai_hr_owner login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
   end if; end $$`);
  const [ownerRole]=await tx`select rolcanlogin and not(rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls) safe from pg_roles where rolname='ai_hr_owner'`;expect(ownerRole.safe).toBe(true);
  await tx.unsafe('drop function app.mobile_offline_open_context_counts(uuid[])');
  await tx.unsafe('drop policy mobile_offline_context_counter_read on mobile_offline_context');
  await tx.unsafe('drop policy mobile_offline_counter_company_read on company');
  await tx.unsafe('alter schema app owner to ai_hr_owner');
  await tx.unsafe('alter table mobile_offline_context owner to ai_hr_owner');
  await tx.unsafe('alter table company owner to ai_hr_owner');
  await tx.unsafe('grant usage on schema public to ai_hr_owner');
  // Refuse unsafe role prerequisites before attempting any application DDL.
  await tx.unsafe(script('deploy/runner-control/mobile-offline-counter-prerequisite.sql'));
  await tx.unsafe('set local role ai_hr_owner');
  await tx.unsafe(offlineGroupCountSql);
  await tx.unsafe('reset role');
  await tx.unsafe(script('deploy/runner-control/mobile-offline-counter-cleanup.sql'));
  const [boundary]=await tx`select pg_has_role('ai_hr_owner','ai_hr_mobile_offline_counter','MEMBER') owner_member,
   pg_has_role('ai_hr_app','ai_hr_mobile_offline_counter','MEMBER') app_member,
   has_schema_privilege('ai_hr_mobile_offline_counter','app','CREATE') schema_create,
   (select pg_get_userbyid(proowner) from pg_proc where oid='app.mobile_offline_open_context_counts(uuid[])'::regprocedure) owner,
   exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='app.mobile_offline_open_context_counts(uuid[])'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE') public_execute`;
  expect(boundary).toEqual({owner_member:false,app_member:false,schema_create:false,owner:'ai_hr_mobile_offline_counter',public_execute:false});
  await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId},true),set_config('app.roles','hr_admin',true)`;
  // Use the same actual application identity settings as withTenant (captured below), not fabricated grants.
  for(const [key,value] of settings)await tx`select set_config(${key},${value},true)`;
  await tx.unsafe('set local role ai_hr_app');
  const counts=await tx`select * from app.mobile_offline_open_context_counts(array[${b.companyId}::uuid])`;expect(counts).toEqual([{company_id:b.companyId,open_count:1}]);
  const [raw]=await tx`select count(*)::int n from mobile_offline_context`;expect(raw.n).toBe(0);
  await tx.unsafe('reset role');
  const [rows]=await tx`select count(*)::int n from mobile_offline_context where id=${f.context.id}::uuid`;expect(rows.n).toBe(1);
  throw rollback;
 })).rejects.toBe(rollback);
 const page=await withTenant(ctx,tx=>tx.execute<{company_id:string;open_count:number}>(sql`select * from app.mobile_offline_open_context_counts(array[${b.companyId}::uuid])`));expect(page).toEqual([{company_id:b.companyId,open_count:1}]);
},180000);
