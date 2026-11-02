/** Private final-effect controls are denial/freshness checks, never positive permission witnesses. */
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {withTenant} from '../db/client';
import {sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {publishWorkforceActionPackage} from '../deploy/access/publish-workforce-capabilities';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function ownerContext<T>(run:(tx:import('postgres').TransactionSql)=>Promise<T>){
 return owner.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${b.adminUserId},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:null}])},true)`;
  return run(tx);
 });
}
it('keeps private APIs unreachable from app callers and known dormant definitions compatible',async()=>{
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.function_action_denial_clear('workforceRecords','view',${b.companyId}::uuid)`))).rejects.toThrow();
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.access_function_authority_stamp()`))).rejects.toThrow();
 const rows=await ownerContext(tx=>tx`select app.function_action_denial_clear('workforceRecords','add',${b.companyId}::uuid) as known,
  app.function_action_denial_clear('unregistered.effect','view',${b.companyId}::uuid) as unknown,
  app.function_action_denial_clear('workforceRecords','approve',${b.companyId}::uuid) as unknown_operation,
  app.function_action_denial_clear('workforceRecords','view',${randomUUID()}::uuid) as unknown_company`);
 expect(rows).toEqual([{known:true,unknown:false,unknown_operation:false,unknown_company:false}]);
});
it('uses the real installed Workforce View/operation and legacy-denial closure without creating a grant',async()=>{
 await publishWorkforceActionPackage(owner.client);
 const read=()=>ownerContext(tx=>tx`select app.access_capability_denial_clear('workforce.edit',${b.companyId}::uuid,ARRAY[]::text[],true) as clear`);
 expect(await read()).toEqual([{clear:true}]);
 const [denial]=await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${b.adminUserId}::uuid,'workforce.maintain',${b.companyId}::uuid,'deny') returning id`;
 expect(await read()).toEqual([{clear:false}]);
 await owner.client`delete from access_user_override where id=${denial.id}`;
 await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${b.adminUserId}::uuid,'workforce.view',${b.companyId}::uuid,'deny')`;
 expect(await read()).toEqual([{clear:false}]);
});
it('detects same-transaction authority revoke and restore even when final override rows are identical',async()=>{
 await ownerContext(async tx=>{
  const [before]=await tx`select app.access_function_authority_stamp() as stamp,(select revision from access_configuration where tenant_id=${b.tenantId}::uuid) as revision`;
  expect(before.stamp).toMatch(/^[a-f0-9]{64}$/);
  const original=await tx`select * from access_user_override where tenant_id=${b.tenantId}::uuid order by id`;
  const [denial]=await tx`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${b.adminUserId}::uuid,'workforce.view',${b.companyId}::uuid,'deny') returning id`;
  await tx`delete from access_user_override where id=${denial.id}`;
  expect(await tx`select * from access_user_override where tenant_id=${b.tenantId}::uuid order by id`).toEqual(original);
  const [after]=await tx`select app.access_function_authority_stamp() as stamp,(select revision from access_configuration where tenant_id=${b.tenantId}::uuid) as revision`;
  expect(after.revision).toBe(before.revision);expect(after.stamp).not.toBe(before.stamp);
 });
});
it('does not invalidate authority on ordinary case outcome mutations that bump only read generations',async()=>{
 // Minimal stored case is only a source-stamp fixture, not a claimed native workflow transition.
 await ownerContext(async tx=>{
  const [stored]=await tx`insert into lc_onboarding_case(tenant_id,company_id,data) values(${b.tenantId}::uuid,${b.companyId}::uuid,'{"version":"1"}'::jsonb) returning id`;
  const [before]=await tx`select app.access_function_authority_stamp() as stamp`;
  await tx`update lc_onboarding_case set data=data||'{"fixtureOutcome":"completed"}'::jsonb where id=${stored.id}`;
  const [after]=await tx`select app.access_function_authority_stamp() as stamp`;
  expect(after.stamp).toBe(before.stamp);
 });
});
it('keeps draft-derived admission/completion private and rejects absent native sources',async()=>{
 const id=randomUUID(),employment=randomUUID(),person=randomUUID();
 for(const query of [
  sql`select app.workforce_draft_active_admitted(${id}::uuid,'{}'::jsonb,${employment}::uuid,${person}::uuid)`,
  sql`select app.workforce_draft_active_completed(${id}::uuid,'{}'::jsonb,${employment}::uuid,${person}::uuid)`,
  sql`select app.workforce_draft_discard_begin(${id}::uuid,'{}'::jsonb)`,
  sql`select app.workforce_draft_discard_completed(${id}::uuid,${id}::uuid,'{}'::jsonb)`,
  sql`select app.workforce_draft_discard_port_record('{}'::jsonb)`,
  sql`select app.workforce_draft_discard_port_needed(${id}::uuid)`,
 ])await expect(withTenant(adminCtx(b),tx=>tx.execute(query))).rejects.toThrow();
 expect(await ownerContext(tx=>tx`select app.workforce_draft_active_admitted(${id}::uuid,'{}'::jsonb,${employment}::uuid,${person}::uuid) as admitted,
  app.workforce_draft_active_completed(${id}::uuid,'{}'::jsonb,${employment}::uuid,${person}::uuid) as completed,
  app.workforce_draft_discard_completed(${id}::uuid,${id}::uuid,'{}'::jsonb) as discarded`)).toEqual([{admitted:false,completed:false,discarded:false}]);
});
