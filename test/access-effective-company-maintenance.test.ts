/** ADR 0181 Phase 2 pilot (migration 7210): maintenance and fail-closed behaviour of precomputed company access, on the
 * fixture in test/access-effective-company-fixture.ts. A future-dated restructure the day before and on its effective
 * day (the stored answer is not used outside its date window, and the scheduled check recomputes the window without
 * reporting a difference); and a writer that bypassed the triggers (the scheduled check marks the tenant untrusted,
 * reads fall back to the legacy answer, shadow logs counts only, and an operator re-trusts it). Each phase compares the
 * previous policies with 'precomputed', the only mode whose answer depends on the stored state: 'legacy' and 'shadow'
 * always serve the per-company answer, and test/access-effective-company-equivalence.test.ts proves them. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import postgres from 'postgres';
import type {SessionContext} from '../db/client';
import {verifyAccessEffectiveCompanyTenant,verificationDifferences} from '../core/access-effective-company-check';
import {owner} from './harness';
import {a1,a1Children,actors,b,beta,buildFixture,day,expectEquivalent,listed,setMode,teardownFixture,unusable,user,type Mode} from './access-effective-company-fixture';

const PRECOMPUTED:readonly Mode[]=['precomputed'];
beforeAll(buildFixture,600_000);
afterAll(teardownFixture);

describe('precomputed company access (7210) on Job descriptions: maintenance',()=>{
 it('honours a future-dated restructure the day before and on its effective day',async()=>{
  const[run]=await owner.client<{id:string}[]>`insert into company_organisation_run(tenant_id,kind,effective_on,state,company_ids,authority_company_ids,mapping,source_epoch,digest,requested_by,published_at)
   values(${b.tenantId}::uuid,'restructure',${day(1)}::date,'published',${`{${a1}}`}::uuid[],${`{${a1}}`}::uuid[],'{}'::jsonb,0,'fictional-restructure',${b.adminUserId}::uuid,now()) returning id`;
  await owner.client`insert into company_organisation_mapping(run_id,tenant_id,company_id,parent_company_id) values(${run.id}::uuid,${b.tenantId}::uuid,${a1}::uuid,${beta}::uuid)`;
  const[state]=await owner.client<{until:string}[]>`select valid_until::text as until from access_company_state where tenant_id=${b.tenantId}::uuid`;
  expect(state.until).toBe(day(1));
  expect(await unusable(actors['group administrator'])).toBeNull();
  const dayBefore=await expectEquivalent('restructure published, effective tomorrow',PRECOMPUTED);
  // The effective day, without a write: the run takes effect today and the stored closure was computed yesterday.
  await owner.client.begin(async tx=>{
   await tx`alter table company_organisation_run disable trigger user`;
   await tx`update company_organisation_run set effective_on=${day(0)}::date where id=${run.id}::uuid`;
   await tx`alter table company_organisation_run enable trigger user`;
   await tx`update access_company_state set computed_for=${day(-1)}::date,valid_until=${day(0)}::date where tenant_id=${b.tenantId}::uuid`;
  });
  expect(await unusable(actors['group administrator'])).toBe('outside_window');
  const effective=await expectEquivalent('restructure effective today, stored answer outside its window',PRECOMPUTED);
  expect(listed(effective['second-tree administrator (Beta) / All companies'])).toBe(listed(dayBefore['second-tree administrator (Beta) / All companies'])+2*(1+a1Children.length));
  // The scheduled check recomputes the expired window; it is not a difference, and the stored answer is used again.
  const v=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);
  expect(v).toMatchObject({windowRefreshed:true,trusted:true});expect(verificationDifferences(v)).toBe(0);
  expect(await unusable(actors['group administrator'])).toBeNull();
  await expectEquivalent('restructure effective today, window recomputed',PRECOMPUTED);
 },900_000);


 it('fails closed to the legacy answer when a writer bypassed maintenance, and logs counts only in shadow',async()=>{
  const missed=await user('employee',null);
  // Separate statements: a table with pending trigger events cannot be altered in the same transaction.
  await owner.client`alter table role_assignment disable trigger access_effective_company_insert`;
  try{await owner.client`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${b.tenantId}::uuid,${missed.userId!}::uuid,'hr_admin',null)`;}
  finally{await owner.client`alter table role_assignment enable trigger access_effective_company_insert`;}
  actors['administrator added by a bypassing writer']={...missed,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:null}]} as SessionContext;
  // Shadow serves the legacy answer and reports the difference as counts, with no identifier.
  const notices:string[]=[];
  const listen=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:1,onnotice:n=>notices.push(String(n.message))});
  try{
   await setMode('shadow');
   const served=await listen.begin(async tx=>{
    await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${missed.userId!},true),set_config('app.roles','employee,hr_admin',true),
     set_config('app.grants',${JSON.stringify([{role:'employee',companyId:null},{role:'hr_admin',companyId:null}])},true),set_config('client_min_messages','log',true)`;
    const[r]=await tx<{n:number}[]>`select cardinality(app.access_workforce_companies('workforce.view')) as n`;return r.n;
   });
   expect(served).toBeGreaterThan(0);
   const line=notices.find(n=>n.startsWith('access_effective_company shadow'));
   expect(line).toMatch(/^access_effective_company shadow capability=workforce\.view missing=[1-9]\d* extra=0 reason=compared$/);
   expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  }finally{await listen.end();await setMode('legacy');}
  const v=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);
  expect(v.rowsMissing).toBeGreaterThan(0);expect(v.trusted).toBe(false);
  expect(await unusable(actors['group administrator'])).toBe('untrusted');
  const untrusted=await expectEquivalent('missed writer, tenant untrusted',PRECOMPUTED);
  expect(listed(untrusted['administrator added by a bypassing writer / All companies'])).toBeGreaterThan(0);
  // The next check still reports it, until an operator re-trusts the tenant.
  expect((await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId)).trusted).toBe(false);
  await owner.client`select app.access_effective_company_retrust(${b.tenantId}::uuid)`;
  expect(await unusable(actors['group administrator'])).toBeNull();
  const v2=await verifyAccessEffectiveCompanyTenant(owner.db,b.tenantId);expect(verificationDifferences(v2)).toBe(0);expect(v2.trusted).toBe(true);
  await expectEquivalent('re-trusted after repair',PRECOMPUTED);
 },900_000);

});
