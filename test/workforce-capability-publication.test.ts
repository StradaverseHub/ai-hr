/** Actual storage transaction, default availability, stale-writer and runtime-refusal contracts. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {migrateTestDb,resetDb,seedBase,adminCtx,owner,closeAll,type Base} from './harness';
import {client,db,withTenant,type SessionContext} from '../db/client';
import {appUser,tenant,company,roleAssignment} from '../db/schema';
import {publishActionCapabilityPackage,publishWorkforceCapabilities as publishAllActionCapabilities,publishWorkforceActionPackage as publishWorkforceCapabilities,WORKFORCE_CAPABILITY_BINDINGS_V2 as WORKFORCE_CAPABILITY_BINDINGS,WORKFORCE_ACTION_PACKAGE_BINDINGS_SHA256 as WORKFORCE_CAPABILITY_BINDINGS_SHA256} from '../deploy/access/publish-workforce-capabilities';
import {hireEmployee} from '../core/org';
import {workforceCompanies} from '../core/workforce-access';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {accessConfigurationStore} from '../core/access-configuration-store';
let b:Base;
const ids=WORKFORCE_CAPABILITY_BINDINGS.map(row=>row.id) as string[];
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${ids}::text[])`;});
afterAll(async()=>{try{await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id=any(${ids}::text[])`;}finally{await closeAll();}});
async function snapshot(){return{
 catalog:await owner.client`select * from access_capability order by id`,
 configuration:await owner.client`select * from access_configuration order by tenant_id`,
 generation:await owner.client`select * from app.access_profile_write_generation order by tenant_id`,
 grants:await owner.client`select * from access_group_grant order by id`,
 memberships:await owner.client`select * from access_membership order by id`,
 overrides:await owner.client`select * from access_user_override order by id`,
 roles:await owner.client`select * from role_assignment order by id`,
 users:await owner.client`select * from app_user order by id`,
 events:await owner.client`select id from domain_event order by id`,
};}
it('publishes the complete source bindings atomically, preserves installed facts and is idempotent',async()=>{
 const before=await snapshot(),scope=await workforceCompanies(adminCtx(b));expect(scope).toContain(b.companyId);
 const result=await publishWorkforceCapabilities(owner.client);expect(result).toMatchObject({changed:true,capabilities:WORKFORCE_CAPABILITY_BINDINGS.length,bindingsSha256:WORKFORCE_CAPABILITY_BINDINGS_SHA256});
 const after=await snapshot();for(const key of ['memberships','roles','users']as const)expect(after[key]).toEqual(before[key]);
 for(const key of ['grants','overrides']as const)for(const original of before[key])expect(after[key]).toContainEqual(original);
 for(const extra of after.grants.filter(row=>!before.grants.some(old=>old.id===row.id)))expect(ids).toContain(extra.capability_id);
 for(const extra of after.overrides.filter(row=>!before.overrides.some(old=>old.id===row.id)))expect(ids).toContain(extra.capability_id);
 for(const expected of WORKFORCE_CAPABILITY_BINDINGS)expect(after.catalog.find(row=>row.id===expected.id)).toMatchObject({...expected,supported:true});
 for(const previous of before.catalog.filter(row=>!ids.includes(row.id)))expect(after.catalog.find(row=>row.id===previous.id)).toEqual(previous);
 for(const row of before.generation)expect(after.generation.find(next=>next.tenant_id===row.tenant_id)?.generation).toBe(String(BigInt(row.generation)+BigInt(1)));
 for(const row of before.configuration)expect(after.configuration.find(next=>next.tenant_id===row.tenant_id)?.revision).not.toBe(row.revision);
 expect(await workforceCompanies(adminCtx(b))).toEqual(scope);
 expect(await publishWorkforceCapabilities(owner.client)).toMatchObject({changed:false,tenantsFenced:0});expect(await snapshot()).toEqual(after);
});
it('publishes array bindings and object audits through the plain standalone installer connection',async()=>{
 const standalone=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:1});
 try{
  expect(await publishWorkforceCapabilities(standalone)).toMatchObject({changed:true,capabilities:WORKFORCE_CAPABILITY_BINDINGS.length});
  const shapes=await owner.client`select id,jsonb_typeof(bindings) as shape from access_capability where id=any(${ids}::text[]) order by id`;
  expect(shapes.map(row=>row.shape)).toEqual(Array.from({length:6},()=>'array'));
  const audits=await owner.client`select jsonb_typeof(payload) as shape,payload->>'bindingsSha256' as hash from domain_event where event_type='access-configuration.capabilities-published' order by tenant_id,id`;
  expect(audits.length).toBeGreaterThan(0);expect(audits.every(row=>row.shape==='object'&&row.hash===WORKFORCE_CAPABILITY_BINDINGS_SHA256)).toBe(true);
 }finally{await standalone.end({timeout:3});}
});
it.each(['partial','unknown'])('refuses a %s catalogue without changing any other row or event',async kind=>{
 if(kind==='partial')await owner.client`update access_capability set supported=true,bindings='[{"owner":"foreign-fixture","operation":"unknown"}]'::jsonb where id='workforce.view'`;
 else await owner.client`update access_capability set supported=true,bindings='[{"owner":"foreign-fixture","operation":"unknown"}]'::jsonb where id=any(${ids}::text[])`;
 const before=await snapshot();await expect(publishWorkforceCapabilities(owner.client)).rejects.toThrow('Workforce capability installation refused');expect(await snapshot()).toEqual(before);
});
it('refuses runtime publication and a claimed owner GUC without installing a definer or raw catalogue grant',async()=>{
 const before=await snapshot();await expect(publishWorkforceCapabilities(client)).rejects.toBeTruthy();
 await expect(client.begin(async tx=>{await tx`select set_config('app.owner','true',true)`;await tx`update access_capability set supported=true where id='workforce.view'`;})).rejects.toMatchObject({code:'42501'});
 expect(await snapshot()).toEqual(before);
});
it('refuses an active tenant without initialized recovery defaults instead of inventing a grant or administrator',async()=>{
 const [other]=await owner.db.insert(tenant).values({name:'Fictional uninitialized publication tenant',workosOrgId:'fictional-uninitialized-'+randomUUID()}).returning({id:tenant.id});
 await owner.db.insert(appUser).values({tenantId:other.id,workosUserId:'fictional-publication-without-recovery'});
 const before=await snapshot();await expect(publishWorkforceCapabilities(owner.client)).rejects.toThrow('Workforce capability installation refused');expect(await snapshot()).toEqual(before);
});
it('rolls back catalogue, preview revision and physical generations when the immutable publication audit refuses',async()=>{
 await owner.client`create function public.fixture_refuse_capability_publication() returns trigger language plpgsql as $$begin if NEW.event_type='access-configuration.capabilities-published' then raise exception 'Fictional publication audit refusal';end if;return NEW;end$$`;
 await owner.client`create trigger fixture_refuse_capability_publication before insert on domain_event for each row execute function public.fixture_refuse_capability_publication()`;
 try{const before=await snapshot();await expect(publishWorkforceCapabilities(owner.client)).rejects.toMatchObject({code:'P0001'});expect(await snapshot()).toEqual(before);}
 finally{await owner.client`drop trigger fixture_refuse_capability_publication on domain_event`;await owner.client`drop function public.fixture_refuse_capability_publication()`;}
});
it('invalidates a genuine pre-publication access preview without granting or changing its command',async()=>{
 const ctx=adminCtx(b),state=await readAccessConfigurationEditor(ctx),group=state.snapshot.groups.find(g=>g.name==='Employees');expect(group).toBeDefined();
 const edit={expectedRevision:state.snapshot.revision,command:{kind:'renameGroup',groupId:group!.id,name:'Fictional publication stale preview'}};
 const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);await publishWorkforceCapabilities(owner.client);
 await expect(saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore)).rejects.toMatchObject({code:'changed'});
});
it('fences an actual pre-pinned repeatable-read maintenance transaction after publication',async()=>{
 let pinned!:()=>void,resume!:()=>void;const reached=new Promise<void>(r=>{pinned=r;}),changed=new Promise<void>(r=>{resume=r;});
 const ctx=adminCtx(b);let pinnedReached=false;
 const outcome=db.transaction(async tx=>{
  await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(ctx.grants??[{role:'hr_admin',companyId:null}])},true)`);
  await tx.select({id:appUser.id}).from(appUser).where(eq(appUser.id,b.adminUserId));pinnedReached=true;pinned();await changed;
  await tx.execute(sql`select app.access_workforce_write_lock()`);
 },{isolationLevel:'repeatable read'}).then(()=>null,error=>{pinned();return error;});
 await reached;try{expect(pinnedReached).toBe(true);await publishWorkforceCapabilities(owner.client);}finally{resume();}
 const error=await outcome;let code:string|undefined;for(let e=error;e&&typeof e==='object';e=e.cause){if(typeof e.code==='string'){code=e.code;break;}}
 expect(code).toBe('40001');
});

it('keeps unknown function keys closed and rejects runtime registry mutation',async()=>{
 const result=await client.begin(async tx=>{
  const ctx=adminCtx(b);await tx`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${b.adminUserId},true)`;
  return tx`select app.function_action_allowed('unregistered.fixture','add',${b.companyId}::uuid) as bounded,app.function_global_action_allowed('unregistered.fixture','add') as global`;
 });
 expect(result[0]).toMatchObject({bounded:false,global:false});
 await expect(client`select app.register_function_action('unregistered.fixture','view','company',NULL,NULL,'{}'::jsonb)`).rejects.toMatchObject({code:'42501'});
});


it('registers exact mixed-case native submenu IDs while preserving closed grammar and operations',async()=>{
 const metadata={moduleKey:'financial',labelKey:'nav.payComponents',kind:'submenu',course:'administrative'};
 // Preserve the production key's exact mixed-case grammar without colliding with its migration.
 await owner.client.begin(async tx=>{
  await tx`select app.register_function_action('payComponents.catalogueRegistrationRegression','view','tenant',NULL,NULL,${JSON.stringify(metadata)}::jsonb)`;
  await tx`select app.register_function_action('payComponents.catalogueRegistrationRegression','add','tenant',NULL,NULL,${JSON.stringify(metadata)}::jsonb)`;
  const rows=await tx`select id,prerequisites,supported from access_capability where id like 'function.payComponents.catalogueRegistrationRegression.%' order by id`;
  expect(rows).toEqual([
   {id:'function.payComponents.catalogueRegistrationRegression.add',prerequisites:['function.payComponents.catalogueRegistrationRegression.view'],supported:false},
   {id:'function.payComponents.catalogueRegistrationRegression.view',prerequisites:[],supported:false},
  ]);
 });
 for(const key of ['payComponents..catalogue','payComponents.catalogueRegistrationRegression.','payComponents/catalogue']){
  await expect(owner.client`select app.register_function_action(${key},'view','tenant',NULL,NULL,${JSON.stringify(metadata)}::jsonb)`).rejects.toMatchObject({code:'42501'});
 }
 await expect(owner.client`select app.register_function_action('payComponents.invalidOperation','VIEW','tenant',NULL,NULL,${JSON.stringify(metadata)}::jsonb)`).rejects.toMatchObject({code:'42501'});
 await expect(owner.client`insert into access_capability(id,scope) values('Legacy.MixedCase','tenant')`).rejects.toMatchObject({code:'23514'});
 await expect(owner.client`insert into access_capability(id,scope) values('function.payComponents.catalogueRegistrationRegression.destroy','tenant')`).rejects.toMatchObject({code:'23514'});
});

it('reports registered actions without a package and leaves the full publisher closed',async()=>{
 const before=await snapshot();
 await expect(publishAllActionCapabilities(owner.client))
  .rejects.toThrow(/registry coverage differs .*function\.rewards\.posting\.execute/);
 expect(await snapshot()).toEqual(before);
});
it('publishes Workforce Records and preserves the separate Edit denial',async()=>{
 await publishWorkforceCapabilities(owner.client);
 const ctx=adminCtx(b),cap='function.workforceRecords.edit';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'workforce_records')).toMatchObject({changed:true,capabilities:4});
  expect(await publishActionCapabilityPackage(owner.client,'workforce_records')).toMatchObject({changed:false});
  const read=()=>withTenant(ctx,tx=>tx.execute(sql`select
   app.access_workforce_projection_company(${b.companyId}::uuid) as view,
   app.access_workforce_action_company(${b.companyId}::uuid,'edit') as edit,
   app.access_workforce_action_company(${b.companyId}::uuid,'add') as add`));
  expect(await read()).toEqual([{view:true,edit:true,add:true}]);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  expect(await read()).toEqual([{view:true,edit:false,add:true}]);
 }finally{
  await owner.client`delete from app.access_native_capability_default where capability_id like 'function.workforceRecords.%'`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like 'function.workforceRecords.%'`;
 }
});
it('publishes Profile Maintenance and separates View from reroute Edit',async()=>{
 const ctx=adminCtx(b),cap='function.profileChanges.maintenance.edit';
 const subject=await hireEmployee(ctx,{person:{fullName:'Fictional profile maintenance subject',primaryEmail:'maintenance@fixture.invalid'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
 await publishWorkforceCapabilities(owner.client);
 try{
  expect(await publishActionCapabilityPackage(owner.client,'profile_maintenance')).toMatchObject({changed:true,capabilities:2});
  expect(await publishActionCapabilityPackage(owner.client,'profile_maintenance')).toMatchObject({changed:false});
  const read=()=>withTenant(ctx,tx=>tx.execute(sql`select
   app.workforce_profile_maintenance_allowed(${subject.employmentId}::uuid,'view') as view,
   app.workforce_profile_maintenance_allowed(${subject.employmentId}::uuid,'edit') as edit`));
  expect(await read()).toEqual([{view:true,edit:true}]);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  expect(await read()).toEqual([{view:true,edit:false}]);
 }finally{
  await owner.client`delete from app.access_native_capability_default where capability_id like 'function.profileChanges.maintenance.%'`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like 'function.profileChanges.maintenance.%'`;
 }
});
it('publishes Attendance Schedule and keeps the company-independent View action exact',async()=>{
 const ctx=adminCtx(b),cap='function.attendancePolicy.schedule.view';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'attendance_schedule')).toMatchObject({changed:true,capabilities:8});
  expect(await publishActionCapabilityPackage(owner.client,'attendance_schedule')).toMatchObject({changed:false});
  expect(await publishActionCapabilityPackage(owner.client,'attendance_shifts')).toMatchObject({changed:true,capabilities:4});
  expect(await publishActionCapabilityPackage(owner.client,'attendance_shifts')).toMatchObject({changed:false});
  expect(await publishActionCapabilityPackage(owner.client,'attendance_schedule_controls')).toMatchObject({changed:true,capabilities:6});
  expect(await publishActionCapabilityPackage(owner.client,'attendance_schedule_controls')).toMatchObject({changed:false});
  const controls=()=>withTenant(ctx,tx=>tx.execute(sql`select
   app.attendance_rotation_allowed('edit') as rotation,
   app.attendance_schedule_control_allowed('attendancePolicy.dutyRoster','edit') as duty,
   app.attendance_schedule_control_allowed('attendancePolicy.exceptions','edit') as exception`));
  expect(await controls()).toEqual([{rotation:true,duty:true,exception:true}]);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,'function.attendancePolicy.rotations.edit','deny')`;
  expect(await controls()).toEqual([{rotation:false,duty:true,exception:true}]);
  const view=()=>withTenant(ctx,tx=>tx.execute(sql`select app.module_function_allowed('attendancePolicy.schedule','view',null) as allowed`));
  expect(await view()).toEqual([{allowed:true}]);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${cap},'deny')`;
  expect(await view()).toEqual([{allowed:false}]);
  const shift=()=>withTenant(ctx,tx=>tx.execute(sql`select
   app.attendance_shift_allowed('view') as view,app.attendance_shift_allowed('add') as add`));
  expect(await shift()).toEqual([{view:true,add:true}]);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,'function.attendancePolicy.shifts.add','deny')`;
  expect(await shift()).toEqual([{view:true,add:false}]);
 }finally{
  await owner.client`delete from app.access_native_capability_default
   where capability_id like 'attendance_configuration.%' or capability_id like 'function.attendancePolicy.schedule.%' or capability_id like 'function.attendancePolicy.shifts.%'
    or capability_id like 'function.attendancePolicy.rotations.%' or capability_id like 'function.attendancePolicy.dutyRoster.%' or capability_id like 'function.attendancePolicy.exceptions.%'`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb
   where id like 'attendance_configuration.%' or id like 'function.attendancePolicy.schedule.%' or id like 'function.attendancePolicy.shifts.%'
    or id like 'function.attendancePolicy.rotations.%' or id like 'function.attendancePolicy.dutyRoster.%' or id like 'function.attendancePolicy.exceptions.%'`;
 }
});
it('keeps Workforce Imports closed if the Qualification subject guard is disabled',async()=>{
 await publishWorkforceCapabilities(owner.client);
 const before=await snapshot();
 await owner.client`alter table app.qualification_import_preview disable trigger qualification_import_preview_subject_guard`;
 try{
  await expect(publishActionCapabilityPackage(owner.client,'workforce_imports'))
   .rejects.toThrow('app.workforce_imports_bindings_complete() reported incomplete enforcement');
  expect(await snapshot()).toEqual(before);
 }finally{
  await owner.client`alter table app.qualification_import_preview enable trigger qualification_import_preview_subject_guard`;
 }
});
it('refuses Financial Setup publication before its Payroll Operations parents',async()=>{
 const before=await snapshot();
 await expect(publishActionCapabilityPackage(owner.client,'financial_setup'))
  .rejects.toThrow('publish Payroll Operations before Financial Setup');
 expect(await snapshot()).toEqual(before);
});
it('publishes the full Financial Letters package with its real guards enabled',async()=>{
 const before=await snapshot();
 try{
  expect(await publishActionCapabilityPackage(owner.client,'financial_letters')).toMatchObject({changed:true});
  const installed=await snapshot();
  expect(installed.catalog.find(row=>row.id==='function.performance.onehr.assignedReview.edit'))
   .toMatchObject({supported:true});
  expect(await publishActionCapabilityPackage(owner.client,'financial_letters')).toMatchObject({changed:false});
 }finally{
  await owner.client.begin(async tx=>{
   for(const row of before.catalog.filter(row=>!row.supported)){
    await tx`update access_capability set supported=false,bindings=${JSON.stringify(row.bindings)}::text::jsonb
     where id=${row.id} and supported`;
   }
  });
 }
});
it('refuses Financial Letters if a concrete Letter guard is disabled',async()=>{
 const before=await snapshot();
 await owner.client`alter table public.letter_asset disable trigger financial_letter_action_write`;
 try{
  await expect(publishActionCapabilityPackage(owner.client,'financial_letters'))
   .rejects.toThrow('app.financial_letter_bindings_complete() reported incomplete enforcement');
  expect(await snapshot()).toEqual(before);
 }finally{
  await owner.client`alter table public.letter_asset enable trigger financial_letter_action_write`;
 }
});
it('refuses Organisation Settings publication when a physical write guard is disabled',async()=>{
 const before=await snapshot();
 await owner.client`alter table public.profile_option disable trigger organisation_settings_action`;
 try{
  await expect(publishActionCapabilityPackage(owner.client,'organisation_settings'))
   .rejects.toThrow('Organisation Settings physical enforcement is incomplete');
  expect(await snapshot()).toEqual(before);
 }finally{
  await owner.client`alter table public.profile_option enable trigger organisation_settings_action`;
 }
});
it('derives new native holders live, preserves overrides and refuses narrowed-away native defaults',async()=>{
 await publishActionCapabilityPackage(owner.client,'organisation_settings');
 const [other]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional native default other company'}).returning();
 const [user]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:'native_defaults_'+randomUUID()}).returning();
 await owner.db.insert(roleAssignment).values([{tenantId:b.tenantId,appUserId:user.id,role:'hr_admin',companyId:null},{tenantId:b.tenantId,appUserId:user.id,role:'employee',companyId:null}]);
 const context={...adminCtx(b),userId:user.id,roles:['hr_admin','employee'],grants:[{role:'hr_admin',companyId:null},{role:'employee',companyId:null}]};
 const allowed=(ctx:SessionContext)=>withTenant(ctx,async tx=>(await tx.execute<{allowed:boolean}>(sql`select app.organisation_action_allowed('view',${other.id}::uuid) as allowed`))[0].allowed);
 expect(await allowed(context)).toBe(true);
 expect(await owner.client`select * from access_user_override where tenant_id=${b.tenantId}::uuid and user_id=${user.id}::uuid`).toEqual([]);
 const narrowed={...context,grants:[{role:'hr_admin',companyId:b.companyId},{role:'employee',companyId:null}]};
 expect(await allowed(narrowed)).toBe(false);
 // Pure target/recovery resolution deliberately retains the user's complete stored native state.
 const [pure]=await owner.client`select app.access_allowed_for_tenant(${b.tenantId}::uuid,${user.id}::uuid,'organisation.view',${other.id}::uuid) as allowed`;
 expect(pure.allowed).toBe(true);
 await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect) values(${b.tenantId}::uuid,${user.id}::uuid,'organisation.view',${other.id}::uuid,'deny')`;
 expect(await allowed(context)).toBe(false);
 await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and user_id=${user.id}::uuid`;
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,user.id));
 const employeeOnly={...context,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role:'employee',companyId:null});
 expect(await allowed(employeeOnly)).toBe(false);
});

it('publishes Leave Employee Records View independently and respects a company denial',async()=>{
 const ctx=adminCtx(b),cap='function.leaveEmployeeRecords.view';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'leave_employee_records_view')).toMatchObject({changed:true,capabilities:2});
  expect(await publishActionCapabilityPackage(owner.client,'leave_employee_records_view')).toMatchObject({changed:false});
  const read=()=>withTenant(ctx,tx=>tx.execute(sql`select
   app.module_action_allowed('leave','view',${b.companyId}::uuid) as parent,
   app.leave_employee_records_company_allowed(${b.companyId}::uuid,'view') as records`));
  expect(await read()).toEqual([{parent:true,records:true}]);
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${ctx.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  expect(await read()).toEqual([{parent:true,records:false}]);
 }finally{
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id in ('leave.view',${cap})`;
 }
});
