import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assertCanDecide,decisionEmploymentAuthorityTx} from '../core/approvals';
import {hireEmployee,setReportingLine} from '../core/org';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function actor(role:'employee'|'manager'|'hr_admin'|'super_admin'){
 const e=await hireEmployee(adminCtx(b),{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01',person:{fullName:'Fictional authority '+role,primaryEmail:randomUUID()+'@example.invalid'}});
 const userId=await createAppUser(b.tenantId,e.personId,role);
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:e.personId,roles:[role],grants:[{role,companyId:null}]};
 return {...e,ctx};
}
it('distinguishes self, current direct assignment and broad visibility, then rereads a changed assignment',async()=>{
 const manager=await actor('manager'),subject=await actor('employee'),other=await actor('employee');
 await setReportingLine(adminCtx(b),{managerEmploymentId:manager.employmentId,subordinateEmploymentId:subject.employmentId,lineType:'administrative',validFrom:'2025-01-01'});
 await withTenant(manager.ctx,async tx=>{
  const first=await decisionEmploymentAuthorityTx(tx,manager.ctx,[subject.employmentId,manager.employmentId,other.employmentId,subject.employmentId]);
  expect([...first.allowed]).toEqual([subject.employmentId]);expect([...first.self]).toEqual([manager.employmentId]);
  await expect(assertCanDecide(tx,manager.ctx,manager.employmentId,'claim')).rejects.toThrow('You cannot decide your own claim');
  await owner.db.update(s.reportingLine).set({validTo:todayInKualaLumpur()}).where(eq(s.reportingLine.subordinateEmploymentId,subject.employmentId));
  expect((await decisionEmploymentAuthorityTx(tx,manager.ctx,[subject.employmentId])).allowed.size).toBe(0);
 });
});
it('preserves the admin self ban and the existing super-admin self exception',async()=>{
 const hr=await actor('hr_admin'),superAdmin=await actor('super_admin'),subject=await actor('employee');
 await withTenant(hr.ctx,async tx=>{
  const result=await decisionEmploymentAuthorityTx(tx,hr.ctx,[hr.employmentId,subject.employmentId]);
  expect([...result.allowed]).toEqual([subject.employmentId]);expect([...result.self]).toEqual([hr.employmentId]);
 });
 await withTenant(superAdmin.ctx,async tx=>{await expect(assertCanDecide(tx,superAdmin.ctx,superAdmin.employmentId,'claim')).resolves.toBeUndefined();});
});
it('keeps every real subject across SQL parameter batches without widening the self exception',async()=>{
 const hr=await actor('hr_admin'),rows=Array.from({length:1001},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),name:'Fictional batch '+i}));
 await owner.db.insert(s.person).values(rows.map(row=>({id:row.personId,tenantId:b.tenantId,fullName:row.name,primaryEmail:row.personId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(rows.map(row=>({id:row.employmentId,tenantId:b.tenantId,personId:row.personId,companyId:b.companyId,hiredOn:'2025-01-01'})));
 const result=await withTenant(hr.ctx,tx=>decisionEmploymentAuthorityTx(tx,hr.ctx,[...rows.map(row=>row.employmentId),hr.employmentId]));
 expect(result.allowed).toEqual(new Set(rows.map(row=>row.employmentId)));expect(result.self).toEqual(new Set([hr.employmentId]));
});
