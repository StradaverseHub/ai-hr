/** PRIVATE actual/proposed native key facts; these helpers do not authorize a write. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {deletePayrollPermissionGrant,setPayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {resolvePayrollPermission} from '../core/payroll';
import {createCompany} from '../core/admin';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand} from '../core/data-permissions';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);});
async function data(command:DataPermissionCommand){const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,command);return saveDataPermission(admin,state.revision,command,preview.fingerprint);}
it('finds recipients who gain when deleting the last company override restores the whole tenant role set',async()=>{
 const manager=await createAppUser(b.tenantId,null,'manager'),employee=await createAppUser(b.tenantId,null,'employee');
 await setPayrollPermissionGrant(admin,{permissionKey:'leave.apply_on_behalf',role:'manager',allowed:true});
 const companyRow=await setPayrollPermissionGrant(admin,{companyId:b.companyId,permissionKey:'leave.apply_on_behalf',role:'employee',allowed:true});
 const [source]=await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,companyRow.id));expect(source).toBeDefined();
 const [image]=await owner.db.execute<{value:unknown}>(sql`select to_jsonb(actual) as value from public.payroll_permission_grant actual where actual.id=${source.id}::uuid`);
 const before=await owner.db.select().from(s.payrollPermissionGrant);
 const recipients=await owner.db.execute<{userId:string;before:boolean;after:boolean}>(sql`select user_id as "userId",before_allowed as before,after_allowed as after from app.native_permission_override_recipients(${b.tenantId}::uuid,'leave.apply_on_behalf',${JSON.stringify(image.value)}::jsonb,null) where company_id=${b.companyId}::uuid`);
 expect(recipients.find(row=>row.userId===manager)).toEqual({userId:manager,before:false,after:true});expect(recipients.find(row=>row.userId===employee)).toEqual({userId:employee,before:true,after:false});
 const changes=await owner.db.execute<{role:string;before:boolean;after:boolean}>(sql`select role,before_allowed as before,after_allowed as after from app.native_permission_override_role_changes(${b.tenantId}::uuid,'leave.apply_on_behalf',${JSON.stringify(image.value)}::jsonb,null) where company_id=${b.companyId}::uuid`);
 expect(changes.find(row=>row.role==='manager')).toEqual({role:'manager',before:false,after:true});expect(changes.find(row=>row.role==='employee')).toEqual({role:'employee',before:true,after:false});
 expect(await owner.db.select().from(s.payrollPermissionGrant)).toEqual(before);
 await expect(deletePayrollPermissionGrant(admin,{id:companyRow.id})).resolves.toEqual({deleted:true});
 const managerCtx:SessionContext={...admin,userId:manager,personId:null,roles:['manager'],grants:[{role:'manager',companyId:null}]};
 expect(await withTenant(managerCtx,tx=>tx.execute<{allowed:boolean}>(sql`select app.leave_on_behalf_native(${b.companyId}::uuid) as allowed`))).toEqual([{allowed:true}]);
 await expect(withTenant(admin,tx=>tx.execute(sql`select * from app.native_permission_override_recipients(${b.tenantId}::uuid,'leave.apply_on_behalf',${JSON.stringify(image.value)}::jsonb,null)`))).rejects.toThrow();
});
it('uses canonical profile subset semantics for a potential administrative recipient with no current witness',async()=>{
 const recipient=await createAppUser(b.tenantId,null,'manager'),profileId=randomUUID();
 const [legacy]=await owner.withTenant(admin,tx=>tx.execute<{named:boolean;future:boolean}>(sql`select app.native_permission_future_company_ceiling(${b.companyId}::uuid) as named,app.native_permission_future_company_ceiling(null) as future`));expect(legacy).toEqual({named:true,future:true});
 await data({kind:'create',profileId,name:'Fictional potential administrative ceiling',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptA]}]}});
 await data({kind:'assign',userId:b.adminUserId,profileId});
 const [unbounded]=await owner.withTenant(admin,tx=>tx.execute<{current:boolean;potential:boolean;future:boolean}>(sql`select app.data_permission_function_target_ceiling(${recipient}::uuid) as "current",app.native_permission_recipient_data_ceiling(${recipient}::uuid) as potential,app.native_permission_future_company_ceiling(${b.companyId}::uuid) as future`));expect(unbounded).toEqual({current:true,potential:false,future:false});
 await data({kind:'assign',userId:recipient,profileId});
 const [bounded]=await owner.withTenant(admin,tx=>tx.execute<{potential:boolean}>(sql`select app.native_permission_recipient_data_ceiling(${recipient}::uuid) as potential`));expect(bounded.potential).toBe(true);
 await expect(withTenant(admin,tx=>tx.execute(sql`select app.native_permission_recipient_data_ceiling(${recipient}::uuid)`))).rejects.toThrow();
});
it('fails unknown key and foreign scope closed while leaving report keys available to their separate owner',async()=>{
 const foreign=await seedBase();
 const [row]=await owner.db.execute<{unknown:boolean;foreign:boolean;report:boolean}>(sql`select app.native_permission_override_fact(${b.tenantId}::uuid,'not.a.native.key',${b.companyId}::uuid,ARRAY['super_admin'],null,null) as unknown,app.native_permission_override_fact(${b.tenantId}::uuid,'leave.apply_on_behalf',${foreign.companyId}::uuid,ARRAY['super_admin'],null,null) as foreign,app.native_permission_override_fact(${b.tenantId}::uuid,'report.read.personnel',${b.companyId}::uuid,ARRAY['hr_admin'],null,null) as report`);expect(row).toEqual({unknown:false,foreign:false,report:true});
});

it('collects Report roles for the actual company while preserving Leave all-role native semantics',async()=>{
 const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional scoped HR other company'}).returning({id:s.company.id});
 const userId=await createAppUser(b.tenantId,null,'employee');await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role:'hr_admin',companyId:other.id});
 const target:SessionContext={...admin,userId,personId:null,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId:other.id}]};
 expect(await withTenant(target,tx=>resolvePayrollPermission(tx,target,'report.read.personnel',b.companyId))).toBe(false);
 const candidate={id:randomUUID(),tenant_id:b.tenantId,company_id:b.companyId,permission_key:'report.read.personnel',role:'employee',allowed:true};
 const [report]=await owner.db.execute<{before:boolean;after:boolean}>(sql`select before_allowed as before,after_allowed as after from app.native_permission_override_recipients(${b.tenantId}::uuid,'report.read.personnel',null,${JSON.stringify(candidate)}::jsonb) where user_id=${userId}::uuid and company_id=${b.companyId}::uuid`);expect(report).toEqual({before:false,after:true});
 const [leave]=await owner.db.execute<{before:boolean;after:boolean}>(sql`select before_allowed as before,after_allowed as after from app.native_permission_override_recipients(${b.tenantId}::uuid,'leave.apply_on_behalf',null,${JSON.stringify(candidate)}::jsonb) where user_id=${userId}::uuid and company_id=${b.companyId}::uuid`);expect(leave).toEqual({before:true,after:true});
 await setPayrollPermissionGrant(admin,{companyId:b.companyId,permissionKey:'report.read.personnel',role:'employee',allowed:true});
 expect(await withTenant(target,tx=>resolvePayrollPermission(tx,target,'report.read.personnel',b.companyId))).toBe(true);
 const globalCandidate={...candidate,company_id:null};
 const [future]=await owner.db.execute<{before:boolean;after:boolean}>(sql`select before_allowed as before,after_allowed as after from app.native_permission_override_recipients(${b.tenantId}::uuid,'report.read.personnel',null,${JSON.stringify(globalCandidate)}::jsonb) where user_id=${userId}::uuid and company_id is null`);expect(future).toEqual({before:false,after:true});
});

it('commits native self-narrowing with the original audit in immediate mode and keeps raw source writes closed',async()=>{
 const key='leave.apply_on_behalf';
 const [before]=await withTenant(admin,tx=>tx.execute<{allowed:boolean}>(sql`select app.leave_on_behalf_native(${b.companyId}::uuid) as allowed`));expect(before.allowed).toBe(true);
 const id=await withTenant(admin,async tx=>{
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [created]=await tx.execute<{id:string}>(sql`select app.leave_on_behalf_grant_set(${b.companyId}::uuid,'hr_admin',false) as id`);
  const [narrowed]=await tx.execute<{allowed:boolean}>(sql`select app.leave_on_behalf_native(${b.companyId}::uuid) as allowed`);expect(narrowed.allowed).toBe(false);
  return created.id;
 });
 const [source]=await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,id));expect(source).toMatchObject({permissionKey:key,companyId:b.companyId,role:'hr_admin',allowed:false});
 await expect(withTenant(admin,tx=>tx.update(s.payrollPermissionGrant).set({allowed:true}).where(eq(s.payrollPermissionGrant.id,id)))).rejects.toMatchObject({cause:{code:'42501',message:'Leave permission source unavailable'}});
 await expect(withTenant(admin,tx=>tx.delete(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,id)))).rejects.toMatchObject({cause:{code:'42501',message:'Leave permission source unavailable'}});
 await expect(withTenant(admin,tx=>tx.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,id)))).resolves.toEqual([source]);
 const events=await owner.db.select({event:s.domainEvent.eventType,actor:s.domainEvent.actorId,payload:s.domainEvent.payload}).from(s.domainEvent).where(eq(s.domainEvent.aggregateId,id));
 expect(events).toEqual([{event:'payroll-permission-grant.created',actor:b.adminUserId,payload:{companyId:b.companyId,permissionKey:key,role:'hr_admin',allowed:false}}]);
});

it('rechecks a completed company Leave override after actual hierarchy move and restore',async()=>{
 const alternate=await createCompany(admin,{legalName:'Fictional alternative Leave ACL parent'});
 await expect(withTenant(admin,async tx=>{
  const [written]=await tx.execute<{id:string}>(sql`select app.leave_on_behalf_grant_set(${b.companyId}::uuid,'manager',true) as id`);expect(written.id).toBeTruthy();
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
  for(const parentCompanyId of [alternate.id,null]){
   expect(await tx.update(s.company).set({parentCompanyId}).where(eq(s.company.id,b.companyId)).returning({id:s.company.id})).toEqual([{id:b.companyId}]);
  }
 })).rejects.toThrow('Leave permission completion unavailable');
 expect(await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.tenantId,b.tenantId))).toEqual([]);
 expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'payroll-permission-grant.created'))).toEqual([]);
});
