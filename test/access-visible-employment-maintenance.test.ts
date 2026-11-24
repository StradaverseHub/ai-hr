/** ADR 0181 precomputed employment visibility (migration 7240): maintenance and fail-closed behaviour, on
 * test/access-visible-employment-fixture.ts. Every writer class is visible in its own transaction (the stored answer
 * equals the legacy walk for every affected user before commit); a save of columns the walk does not read changes
 * nothing; a line starting tomorrow bounds the window and the effective day falls back until the check recomputes;
 * a company restructure above the inline limit marks the tenant stale until the rebuild pass; a writer that bypassed
 * the triggers is found by the check, which marks the tenant untrusted until an operator re-trusts it; shadow logs
 * counts only; a session whose current_date is not the Kuala Lumpur date gets the legacy answer. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {accessVisibleEmploymentCheck,verifyAccessVisibleEmploymentTenant,visibleEmploymentDifferences} from '../core/access-visible-employment-check';
import {owner} from './harness';
import {teardownFixture,level2,beta} from './access-effective-company-fixture';
import {b,buildVisibilityFixture,byCode,day,eq,managerUsers,relationshipDifferences,sampleUsers,setMode,stateRow,unusable} from './access-visible-employment-fixture';

beforeAll(buildVisibilityFixture,900_000);
afterAll(teardownFixture);

const id=(k:number)=>byCode.get(eq(k))!.id;
const everyone=()=>[...sampleUsers,...Object.values(managerUsers)];
/** Run a write and, in the same transaction, compare the stored answer with the legacy walk for every user. */
async function sameTransaction(write:(tx:postgres.TransactionSql)=>Promise<unknown>){
 return owner.client.begin(async tx=>{
  await write(tx);
  const differing:string[]=[];
  for(const u of everyone()){
   await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${u},true)`;
   const[r]=await tx<{same:boolean}[]>`select app.access_visible_employment_legacy()=app.access_visible_employment_stored() as same`;
   if(!r.same)differing.push(u);
  }
  return differing;
 });
}

describe('precomputed employment visibility (7240): maintenance',()=>{
 it('maintains every writer class in the same transaction',async()=>{
  // A manager change, as the movement writers do it: supersede the current line and insert the new one.
  expect(await sameTransaction(async tx=>{
   await tx`update reporting_line set superseded_at=now() where subordinate_employment_id=${id(10)}::uuid and line_type='administrative' and superseded_at is null`;
   await tx`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from) values(${b.tenantId}::uuid,${id(7)}::uuid,${id(10)}::uuid,'administrative','2025-01-06')`;
  })).toEqual([]);
  // A termination of an intermediate manager, a reinstatement, and a company transfer.
  expect(await sameTransaction(tx=>tx`update employment set terminated_on=${day(-1)}::date where id=${id(12)}::uuid`)).toEqual([]);
  expect(await sameTransaction(tx=>tx`update employment set terminated_on=null where id=${id(6)}::uuid`)).toEqual([]);
  expect(await sameTransaction(tx=>tx`update employment set company_id=${beta}::uuid where id=${id(8)}::uuid`)).toEqual([]);
  // A department moved under another, and a new department.
  expect(await sameTransaction(async tx=>{
   const[d]=await tx<{id:string;parent:string}[]>`select d.id::text,p.id::text as parent from department d join department p on p.company_id=d.company_id and p.name like 'Fictional D0%'
    where d.company_id=${b.companyId}::uuid and d.name='Fictional D4'`;
   await tx`update department set parent_department_id=${d.parent}::uuid where id=${d.id}::uuid`;
   await tx`insert into department(tenant_id,company_id,name,parent_department_id) values(${b.tenantId}::uuid,${b.companyId}::uuid,'Fictional new',${d.id}::uuid)`;
  })).toEqual([]);
  // A bulk statement: every line under EQ4 ended today and re-inserted from today, as an import would.
  expect(await sameTransaction(async tx=>{
   await tx`update reporting_line set superseded_at=now() where manager_employment_id in (${id(4)}::uuid,${id(8)}::uuid,${id(9)}::uuid) and superseded_at is null`;
   await tx`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from)
    select ${b.tenantId}::uuid,${id(3)}::uuid,s.id,'administrative','2025-01-06' from employment s where s.id in (${id(8)}::uuid,${id(9)}::uuid,${id(16)}::uuid,${id(17)}::uuid)`;
  })).toEqual([]);
  expect(await relationshipDifferences(everyone())).toEqual([]);
  const v=await verifyAccessVisibleEmploymentTenant(owner.db,b.tenantId);expect(visibleEmploymentDifferences(v)).toBe(0);expect(v.trusted).toBe(true);
 },1_800_000);

 it('ignores saves of columns the walk does not read',async()=>{
  const before=(await stateRow()).version;
  await owner.client`update employment set employee_code=employee_code where tenant_id=${b.tenantId}::uuid`;
  await owner.client`update employment set hired_on=hired_on,company_id=company_id where tenant_id=${b.tenantId}::uuid`;
  await owner.client`update department set name=name||'' where tenant_id=${b.tenantId}::uuid`;
  await owner.client`update reporting_line set valid_from=valid_from where tenant_id=${b.tenantId}::uuid and line_type='delegate'`;
  await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from) values(${b.tenantId}::uuid,${id(60)}::uuid,${id(61)}::uuid,'delegate','2025-01-06')`;
  expect((await stateRow()).version).toBe(before);
 },120_000);

 it('honours a line starting tomorrow the day before and on its effective day',async()=>{
  expect((await stateRow()).valid_until).toBe(day(1));
  expect(await unusable(managerUsers[eq(20)])).toBeNull();
  // The effective day, without a write: the line takes effect today and the stored rows were computed yesterday.
  await owner.client.begin(async tx=>{
   await tx`alter table reporting_line disable trigger access_visible_employment_update`;
   await tx`update reporting_line set valid_from=${day(0)}::date where subordinate_employment_id=${id(900)}::uuid and manager_employment_id=${id(20)}::uuid`;
   await tx`alter table reporting_line enable trigger access_visible_employment_update`;
   await tx`update access_employment_state set computed_for=${day(-1)}::date,valid_until=${day(0)}::date where tenant_id=${b.tenantId}::uuid`;
  });
  expect(await unusable(managerUsers[eq(20)])).toBe('outside_window');
  // The check rebuilds the expired window: not a difference, and the stored answer is used again.
  const run=await accessVisibleEmploymentCheck(owner.db);
  expect(run).toMatchObject({tenantsRebuilt:1,tenantsDiffering:0,tenantsUntrusted:0,tenantsFailed:0});
  expect(await unusable(managerUsers[eq(20)])).toBeNull();
  expect(await relationshipDifferences(everyone())).toEqual([]);
 },900_000);

 it('marks a tenant stale after a restructure above the inline limit until the rebuild pass',async()=>{
  await owner.client`update access_employment_precompute_control set inline_rebuild_limit=0`;
  try{
   // Moving a company under the Beta tree changes the company closure (7210), which every clamp reads.
   await owner.client`update company set parent_company_id=${beta}::uuid where id=${level2[1]}::uuid`;
   expect((await stateRow()).stale).toBe(true);
   expect(await unusable(managerUsers[eq(2)])).toBe('stale');
   const run=await accessVisibleEmploymentCheck(owner.db,()=>{},{verify:false});
   expect(run.tenantsRebuilt).toBe(1);
   expect(await stateRow()).toMatchObject({stale:false,trusted:true});
   expect(await unusable(managerUsers[eq(2)])).toBeNull();
   expect(await relationshipDifferences(everyone())).toEqual([]);
  }finally{await owner.client`update access_employment_precompute_control set inline_rebuild_limit=20000`;}
 },900_000);

 it('fails closed to the legacy walk when a writer bypassed maintenance, and logs counts only in shadow',async()=>{
  // A manager in the top company (every company but the Beta tree descends from it, so its clamp admits the new
  // report) gains a report through a writer that bypasses the triggers.
  const[pair]=await owner.client<{manager:string;person:string;subject:string}[]>`select m.id::text as manager,m.person_id::text as person,s.id::text as subject
   from employment m join employment s on s.company_id=m.company_id and s.id<>m.id and s.terminated_on is null and s.employee_code like 'EQ0%'
   where m.tenant_id=${b.tenantId}::uuid and m.company_id=${b.companyId}::uuid and m.terminated_on is null and m.employee_code like 'EQ0%'
    and not exists(select 1 from access_reporting_reach r where r.root_employment_id=m.id and r.subject_employment_id=s.id)
    and not exists(select 1 from reporting_line rl where rl.manager_employment_id=s.id) -- a leaf: the new line cannot close a loop
   order by m.employee_code,s.employee_code limit 1`;
  const[known]=await owner.client<{id:string}[]>`select id::text from app_user where person_id=${pair.person}::uuid limit 1`;
  const managerUser=known?.id??(await owner.client<{id:string}[]>`insert into app_user(tenant_id,workos_user_id,person_id) values(${b.tenantId}::uuid,${'fixture_'+randomUUID()},${pair.person}::uuid) returning id::text`)[0].id;
  await owner.client`alter table reporting_line disable trigger access_visible_employment_insert`;
  try{await owner.client`insert into reporting_line(tenant_id,manager_employment_id,subordinate_employment_id,line_type,valid_from) values(${b.tenantId}::uuid,${pair.manager}::uuid,${pair.subject}::uuid,'administrative','2025-01-06')`;}
  finally{await owner.client`alter table reporting_line enable trigger access_visible_employment_insert`;}
  const notices:string[]=[];
  const listen=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:1,onnotice:n=>notices.push(String(n.message))});
  try{
   await setMode('shadow');
   await listen.begin(async tx=>{
    await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${managerUser},true),set_config('client_min_messages','log',true)`;
    await tx`select app.access_visible_employment_ids()`;
   });
   const line=notices.find(n=>n.startsWith('access_visible_employment shadow'));
   expect(line).toMatch(/^access_visible_employment shadow missing=[1-9]\d* extra=0 relationship=1 reason=compared$/);
   expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  }finally{await listen.end();await setMode('legacy');}
  const v=await verifyAccessVisibleEmploymentTenant(owner.db,b.tenantId);
  expect(v.reachMissing).toBeGreaterThan(0);expect(v.trusted).toBe(false);
  expect(await unusable(managerUsers[eq(2)])).toBe('untrusted');
  expect((await verifyAccessVisibleEmploymentTenant(owner.db,b.tenantId)).trusted).toBe(false);
  await owner.client`select app.access_visible_employment_retrust(${b.tenantId}::uuid)`;
  expect(await unusable(managerUsers[eq(2)])).toBeNull();
  const v2=await verifyAccessVisibleEmploymentTenant(owner.db,b.tenantId);expect(visibleEmploymentDifferences(v2)).toBe(0);expect(v2.trusted).toBe(true);
 },900_000);

 it('serves the legacy answer to a session whose current_date is not the Kuala Lumpur date',async()=>{
  const klHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',hour12:false}).format(new Date()));
  // Pago Pago is 19 hours behind Kuala Lumpur, Kiritimati 6 hours ahead: one of them is on another date now.
  const zone=klHour<18?'Pacific/Pago_Pago':'Pacific/Kiritimati';
  const reason=await owner.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${managerUsers[eq(2)]},true),set_config('timezone',${zone},true)`;
   const[r]=await tx<{reason:string|null}[]>`select app.access_visible_employment_unusable() as reason`;return r.reason;
  });
  expect(reason).toBe('clock');
 },120_000);
});
