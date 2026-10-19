import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {createAdminChain} from '../db/provision';
import {appUser,company,department,domainEvent,employment,roleAssignment} from '../db/schema';
import {resolveEntitlementsTx} from '../core/entitlements';
import {hireEmployee} from '../core/org';
import {createMovementEvent,movementHistory,movementPendingEditInput} from '../core/movement';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
/** Construct each context from real stored rows; no mocked is_admin_for or invented group grant. */
async function storedContext(base:Base,userId:string):Promise<SessionContext>{
  const [user]=await owner.db.select({id:appUser.id,personId:appUser.personId}).from(appUser).where(and(eq(appUser.id,userId),eq(appUser.tenantId,base.tenantId)));
  const grants=await owner.db.select({role:roleAssignment.role,companyId:roleAssignment.companyId}).from(roleAssignment).where(and(eq(roleAssignment.tenantId,base.tenantId),eq(roleAssignment.appUserId,user.id))).orderBy(asc(roleAssignment.role),asc(roleAssignment.companyId));
  const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,base.tenantId));
  return {tenantId:base.tenantId,userId:user.id,personId:user.personId,grants,roles:[...new Set(grants.map(g=>g.role))],entitlements};
}
async function actor(role:'employee'|'hr_admin',companyId:string){
  const user=await owner.db.transaction(tx=>createAdminChain(tx,b.tenantId,{email:randomUUID()+'@pending-read.invalid',fullName:'Fictional scoped pending reader',withRoleAssignment:false}));
  await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.appUserId,companyId,role});
  return storedContext(b,user.appUserId);
}
async function subject(ctx:SessionContext,code:string){return (await hireEmployee(ctx,{person:{fullName:'Fictional pending read subject',primaryEmail:randomUUID()+'@pending-read.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-60),employeeCode:code})).employmentId;}
async function recorded(ctx:SessionContext,id:string){return (await movementHistory(ctx,id)).find(r=>r.status==='pending')!;}
async function originalFacts(id:string){return {employment:await owner.db.select().from(employment).where(eq(employment.id,id)),events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence))};}

describe('canonical pending Edit input read authorization',()=>{
 it('refuses a real non-admin account before exposing any pending values',async()=>{
  const group=await storedContext(b,b.adminUserId),id=await subject(group,'B22-READ-1');
  await createMovementEvent(group,{employmentId:id,kind:'promotion',effectiveDate:day(7),departmentId:b.deptB});
  const pending=await recorded(group,id),employee=await actor('employee',b.companyId),before=await originalFacts(id);
  expect(employee.grants).toEqual([{role:'employee',companyId:b.companyId}]);
  await expect(movementPendingEditInput(employee,id,pending.id)).rejects.toThrow('Only an admin');
  expect(await originalFacts(id)).toEqual(before);
 });
 it('never exposes values for a foreign tenant or a movement belonging to another employment',async()=>{
  const group=await storedContext(b,b.adminUserId),id=await subject(group,'B22-READ-1'),otherId=await subject(group,'B22-READ-2');
  await createMovementEvent(group,{employmentId:id,kind:'promotion',effectiveDate:day(7),departmentId:b.deptB});
  const pending=await recorded(group,id),foreign=await seedBase(),foreignCtx=await storedContext(foreign,foreign.adminUserId),before=await originalFacts(id);
  await expect(movementPendingEditInput(foreignCtx,id,pending.id)).rejects.toThrow('Employment not found');
  expect(await movementPendingEditInput(group,otherId,pending.id)).toBeNull();
  expect(await movementPendingEditInput(group,id,pending.id)).toEqual({values:{departmentId:b.deptB},unavailable:false});
  expect(await originalFacts(id)).toEqual(before);
 });
 it('returns unavailable, without raw targets, to a current-company administrator lacking destination administration',async()=>{
  const group=await storedContext(b,b.adminUserId),id=await subject(group,'B22-READ-1');
  const [destination]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional pending destination'}).returning({id:company.id});
  const [target]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:destination.id,name:'Fictional destination department'}).returning({id:department.id});
  await createMovementEvent(group,{employmentId:id,kind:'entityTransfer',effectiveDate:day(7),companyId:destination.id,departmentId:target.id});
  const pending=await recorded(group,id),scoped=await actor('hr_admin',b.companyId),before=await originalFacts(id);
  expect(scoped.grants).toEqual([{role:'hr_admin',companyId:b.companyId}]);
  const [permissions]=await withTenant(scoped,tx=>tx.execute(sql`select current_user as name,r.rolsuper as superuser,r.rolbypassrls as bypass_rls,app.is_admin_for(${b.companyId}::uuid) as current_admin,app.is_admin_for(${destination.id}::uuid) as destination_admin from pg_roles r where r.rolname=current_user`));
  expect(permissions).toEqual({name:'ai_hr_app',superuser:false,bypass_rls:false,current_admin:true,destination_admin:false});
  expect(await movementPendingEditInput(scoped,id,pending.id)).toEqual({unavailable:true});
  expect(await movementPendingEditInput(group,id,pending.id)).toEqual({values:{companyId:destination.id,departmentId:target.id},unavailable:false});
  expect(await originalFacts(id)).toEqual(before);
 });
});
