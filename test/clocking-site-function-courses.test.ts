/** Actual shared-site native courses. Publication stays incomplete until its genuine owners close. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {CompanyDeleteForbiddenError,createCompany,deleteCompany,setCompanyParent} from '../core/admin';
import {setPayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {hireEmployee} from '../core/org';
import {readDataPermissions,previewDataPermission,saveDataPermission,type DataPermissionCommand} from '../core/data-permissions';
import {createClockingLocation,updateClockingLocation,archiveClockingLocation,restoreClockingLocation,deleteClockingLocation,listClockingLocations,listClockingLocationsForMaintenance,clockingSiteActionAccess,type CreateClockingLocationInput} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,companyHr:SessionContext;
const input=(name:string,companyIds=[b.companyId]):CreateClockingLocationInput=>({name,lat:3.1,lng:101.6,radiusM:100,companyIds});
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();admin=adminCtx(b);const userId=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));companyHr={...admin,userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};});
it('uses actual APP native group authority for complete shared-site and company-link changes',async()=>{
 const [principal]=await withTenant(admin,tx=>tx.execute<{groupHr:boolean;owner:boolean}>(sql`select app.is_group_admin() as "groupHr",pg_has_role(session_user,(select relowner from pg_class where oid='public.app_user'::regclass),'USAGE') as owner`));expect(principal).toEqual({groupHr:true,owner:false});
 const other=await createCompany(admin,{legalName:'Fictional second company'}),site=await createClockingLocation(admin,input('Fictional shared gate',[b.companyId,other.id]));
 expect((await listClockingLocationsForMaintenance(admin)).find(row=>row.id===site.id)?.companies.map(row=>row.id).sort()).toEqual([b.companyId,other.id].sort());
 await updateClockingLocation(admin,{...input('Fictional revised gate',[other.id]),clockingLocationId:site.id});
 expect((await listClockingLocationsForMaintenance(admin)).find(row=>row.id===site.id)?.companies.map(row=>row.id)).toEqual([other.id]);
 await archiveClockingLocation(admin,{clockingLocationId:site.id});expect((await listClockingLocationsForMaintenance(admin,{status:'inactive'})).map(row=>row.id)).toContain(site.id);
 await restoreClockingLocation(admin,{clockingLocationId:site.id});await deleteClockingLocation(admin,{clockingLocationId:site.id});
 expect(await owner.db.select().from(s.clockingLocationCompany).where(eq(s.clockingLocationCompany.clockingLocationId,site.id))).toEqual([]);
 expect((await listClockingLocations(admin,{status:'all'})).map(row=>row.id)).not.toContain(site.id);
});
it('keeps scoped HR maintenance View bounded to its open companies and denies every native write',async()=>{
 const other=await createCompany(admin,{legalName:'Fictional unrelated company'}),shared=await createClockingLocation(admin,input('Fictional shared gate',[b.companyId,other.id]));await createClockingLocation(admin,input('Fictional unrelated gate',[other.id]));
 expect((await listClockingLocationsForMaintenance(companyHr)).map(row=>({id:row.id,companies:row.companies.map(co=>co.id)}))).toEqual([{id:shared.id,companies:[b.companyId]}]);
 expect(await Promise.all((['view','add','edit','delete'] as const).map(op=>clockingSiteActionAccess(companyHr,op)))).toEqual([true,false,false,false]);
 await expect(createClockingLocation(companyHr,input('Fictional refused gate'))).rejects.toThrow('Only a group administrator');
 await expect(withTenant(companyHr,tx=>tx.update(s.clockingLocation).set({name:'Forged rename'}).where(eq(s.clockingLocation.id,shared.id)))).rejects.toThrow();
 expect((await owner.db.select().from(s.clockingLocation).where(eq(s.clockingLocation.id,shared.id)))[0].name).toBe('Fictional shared gate');
});
it('aligns stored/current/recipient native floors without fabricating an installed module',async()=>{
 for(const ctx of [admin,companyHr]){
  const floors=await owner.withTenant(ctx,tx=>tx.execute<{operation:string;stored:boolean;current:boolean;recipient:boolean}>(sql`select operation,app.module_function_legacy_allowed(${b.tenantId}::uuid,${ctx.userId}::uuid,'function.attendancePolicy.clockingSites.'||operation,null) as stored,app.module_function_current_legacy_allowed(${b.tenantId}::uuid,${ctx.userId}::uuid,'function.attendancePolicy.clockingSites.'||operation,null) as "current",app.access_function_delegation_floor('function.attendancePolicy.clockingSites.'||operation,null) as recipient from unnest(ARRAY['view','add','edit','delete']) operation`));
  expect(floors).toEqual(['view','add','edit','delete'].map(operation=>({operation,stored:ctx===admin||operation==='view',current:ctx===admin||operation==='view',recipient:ctx===admin||operation==='view'})));
 }
 const narrowed:SessionContext={...admin,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect(await clockingSiteActionAccess(narrowed,'view')).toBe(true);expect(await clockingSiteActionAccess(narrowed,'edit')).toBe(false);
 await expect(withTenant(admin,tx=>tx.execute(sql`select * from app.clocking_site_source`))).rejects.toThrow();
});
it('refuses raw company unticking and site removal while actual employee assignments use them',async()=>{
 const site=await createClockingLocation(admin,input('Fictional assigned gate')),hired=await hireEmployee(admin,{person:{fullName:'Fictional assigned employee',primaryEmail:`${randomUUID()}@test.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 await owner.db.insert(s.employeeClockingLocation).values({tenantId:b.tenantId,employmentId:hired.employmentId,clockingLocationId:site.id});
 const profileId=randomUUID();
 for(const command of [{kind:'create',profileId,name:'Fictional restricted site operator',enabled:true,rules:{legacyCompany:false,predicates:[{field:'company',values:[b.companyId]},{field:'department',values:[b.deptB]}]}},{kind:'assign',userId:b.adminUserId,profileId}] satisfies DataPermissionCommand[]){const state=await readDataPermissions(admin),preview=await previewDataPermission(admin,state.revision,command);await saveDataPermission(admin,state.revision,command,preview.fingerprint);}
 const clipped=await listClockingLocationsForMaintenance(admin);expect(clipped.find(row=>row.id===site.id)?.assignedCount).toBe(0);
 await expect(withTenant(admin,tx=>tx.delete(s.clockingLocationCompany).where(and(eq(s.clockingLocationCompany.clockingLocationId,site.id),eq(s.clockingLocationCompany.companyId,b.companyId))))).rejects.toThrow('Clocking site company is in use');
 await expect(withTenant(admin,tx=>tx.delete(s.clockingLocation).where(eq(s.clockingLocation.id,site.id)))).rejects.toThrow('Clocking site is in use');
 expect(await owner.db.select().from(s.clockingLocationCompany).where(eq(s.clockingLocationCompany.clockingLocationId,site.id))).toHaveLength(1);
});
it('rejects forged cross-tenant parents and immutable company-link rewrites without changing native references',async()=>{
 const site=await createClockingLocation(admin,input('Fictional exact source gate')),foreign=await seedBase();
 await expect(withTenant(admin,tx=>tx.insert(s.clockingLocationCompany).values({tenantId:b.tenantId,clockingLocationId:site.id,companyId:foreign.companyId}))).rejects.toThrow();
 await expect(withTenant(admin,async tx=>{await tx.execute(sql`select set_config('app.clocking_site_birth','true',true)`);await tx.execute(sql`update clocking_location_company set company_id=${foreign.companyId}::uuid where clocking_location_id=${site.id}::uuid`);})).rejects.toThrow();
 expect((await listClockingLocationsForMaintenance(admin)).find(row=>row.id===site.id)?.companies.map(row=>row.id)).toEqual([b.companyId]);
});

it('joins the canonical try-only Access fence before a raw assignment statement without a blocking upgrade',async()=>{
 const hired=await hireEmployee(admin,{person:{fullName:'Fictional lock-order subject',primaryEmail:`${randomUUID()}@test.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('access-configuration:'||${b.tenantId}::text,0))`);
  let failure:unknown;
  try{await withTenant(admin,async appTx=>{
   // A legitimate existing data lock must not turn the later Access request into a wait/deadlock.
   const rows=await appTx.select({id:s.employment.id}).from(s.employment).where(eq(s.employment.id,hired.employmentId)).for('update');expect(rows).toEqual([{id:hired.employmentId}]);
   await appTx.delete(s.employeeClockingLocation).where(eq(s.employeeClockingLocation.employmentId,randomUUID()));
  });}catch(error){failure=error;}
  let retryable=false;for(let cause=failure;cause&&typeof cause==='object';cause=(cause as {cause?:unknown}).cause)if((cause as {code?:string}).code==='55P03')retryable=true;
  expect(retryable).toBe(true);
 });
 await withTenant(admin,tx=>tx.delete(s.employeeClockingLocation).where(eq(s.employeeClockingLocation.employmentId,randomUUID())));
});

async function companyCleanupSources(){
 const child=await createCompany(admin,{legalName:'Fictional empty child company',companyLabel:'FICT-CHILD',registrationNo:'FICT-REG'});
 await setCompanyParent(admin,{companyId:child.id,parentCompanyId:b.companyId});
 const site=await createClockingLocation(admin,input('Fictional shared Company Delete site',[b.companyId,child.id]));
 const leave=await setPayrollPermissionGrant(admin,{companyId:child.id,permissionKey:'leave.apply_on_behalf',role:'manager',allowed:true});
 const report=await setPayrollPermissionGrant(admin,{companyId:child.id,permissionKey:'report.read.personnel',role:'hr_admin',allowed:false});
 return {child,site,leave,report};
}
it('preserves native scoped-parent Company Delete in immediate mode without granting Clocking Edit or detaching its neighbor',async()=>{
 const {child,site,leave,report}=await companyCleanupSources();
 await owner.db.insert(s.payrollCycle).values({tenantId:b.tenantId,companyId:child.id,name:'Fictional native child cycle',code:'FIX',runType:'regular'});
 const neighbor=await setPayrollPermissionGrant(admin,{companyId:b.companyId,permissionKey:'leave.apply_on_behalf',role:'manager',allowed:true});
 expect(await clockingSiteActionAccess(companyHr,'edit')).toBe(false);
 await withTenant(companyHr,async tx=>{
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await deleteCompany(companyHr,{id:child.id},tx);
 });
 expect(await owner.db.select().from(s.company).where(eq(s.company.id,child.id))).toEqual([]);
 expect(await owner.db.select().from(s.payrollCycle).where(eq(s.payrollCycle.companyId,child.id))).toEqual([]);
 expect(await owner.db.select({companyId:s.clockingLocationCompany.companyId}).from(s.clockingLocationCompany).where(eq(s.clockingLocationCompany.clockingLocationId,site.id))).toEqual([{companyId:b.companyId}]);
 expect(await owner.db.select().from(s.clockingLocation).where(eq(s.clockingLocation.id,site.id))).toHaveLength(1);
 for(const id of [leave.id,report.id])expect(await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,id))).toEqual([]);
 expect(await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,neighbor.id))).toHaveLength(1);
 const [audit]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,child.id),eq(s.domainEvent.eventType,'company.deleted')));
 expect(audit).toMatchObject({actorType:'user',actorId:companyHr.userId,payload:{legalName:'Fictional empty child company',code:'FICT-CHILD',registrationNo:'FICT-REG',usageSnapshotRows:0}});
});
it('rolls back unconsumed Company cleanup and refuses a forged completion without the actual Company deletion and audit',async()=>{
 const {child,site,leave,report}=await companyCleanupSources();
 await expect(withTenant(companyHr,async tx=>{
  await tx.execute(sql`select app.module_company_cleanup_begin(${child.id}::uuid)`);
  // Admission alone cannot open the tenant fallback while this company still exists.
  expect(await tx.select({id:s.payrollPermissionGrant.id}).from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,leave.id))).toEqual([{id:leave.id}]);
 })).rejects.toThrow('Company cleanup is incomplete');
 await expect(withTenant(companyHr,async tx=>{
  const [proof]=await tx.execute<{id:string}>(sql`select app.module_company_cleanup_begin(${child.id}::uuid) as id`);expect(proof.id).toBeTruthy();
  await tx.execute(sql`select app.module_company_cleanup_finish(${proof.id}::uuid)`);
 })).rejects.toThrow('Company cleanup completion unavailable');
 expect(await owner.db.select().from(s.company).where(eq(s.company.id,child.id))).toHaveLength(1);
 expect(await owner.db.select().from(s.clockingLocationCompany).where(and(eq(s.clockingLocationCompany.clockingLocationId,site.id),eq(s.clockingLocationCompany.companyId,child.id)))).toHaveLength(1);
 for(const id of [leave.id,report.id])expect(await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,id))).toHaveLength(1);
 expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,child.id),eq(s.domainEvent.eventType,'company.deleted')))).toEqual([]);
});
it('revalidates completed Company cleanup after an early flush and actual ancestor move-restore',async()=>{
 const {child,site}=await companyCleanupSources(),newParent=await createCompany(admin,{legalName:'Fictional alternate ancestor'});
 await expect(withTenant(admin,async tx=>{
  await deleteCompany(admin,{id:child.id},tx);
  await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
  expect(await tx.update(s.company).set({parentCompanyId:newParent.id}).where(eq(s.company.id,b.companyId)).returning({id:s.company.id})).toEqual([{id:b.companyId}]);
  expect(await tx.update(s.company).set({parentCompanyId:null}).where(eq(s.company.id,b.companyId)).returning({id:s.company.id})).toEqual([{id:b.companyId}]);
 })).rejects.toThrow('Company cleanup effects or authority changed');
 expect(await owner.db.select().from(s.company).where(eq(s.company.id,child.id))).toHaveLength(1);
 expect(await owner.db.select().from(s.clockingLocationCompany).where(and(eq(s.clockingLocationCompany.clockingLocationId,site.id),eq(s.clockingLocationCompany.companyId,child.id)))).toHaveLength(1);
 expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,child.id),eq(s.domainEvent.eventType,'company.deleted')))).toEqual([]);
});

it('refuses mismatched Company Delete transaction tenant or actor before any lock or effect',async()=>{
 const {child,site,leave}=await companyCleanupSources(),foreign=await seedBase();
 await withTenant(admin,async tx=>{
  const lockCount=async()=>{
   const [row]=await tx.execute<{count:number}>(sql`select count(*)::int as count from pg_locks where pid=pg_backend_pid() and locktype='advisory'`);
   return row.count;
  };
  const before=await lockCount();
  for(const supplied of [companyHr,adminCtx(foreign)]){
   await expect(deleteCompany(supplied,{id:child.id},tx)).rejects.toBeInstanceOf(CompanyDeleteForbiddenError);
   expect(await lockCount()).toBe(before);
  }
 });
 expect(await owner.db.select().from(s.company).where(eq(s.company.id,child.id))).toHaveLength(1);
 expect(await owner.db.select().from(s.clockingLocationCompany).where(and(eq(s.clockingLocationCompany.clockingLocationId,site.id),eq(s.clockingLocationCompany.companyId,child.id)))).toHaveLength(1);
 expect(await owner.db.select().from(s.payrollPermissionGrant).where(eq(s.payrollPermissionGrant.id,leave.id))).toHaveLength(1);
 expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,child.id),eq(s.domainEvent.eventType,'company.deleted')))).toEqual([]);
});
