import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {listPendingReplacementLeaveTasks,decideReplacementLeaveRequest} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function employee(role:'employee'|'hr_admin'='employee',manager?:string){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional assigned credit reader',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),reportingManagerEmploymentId:manager});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:hired.personId,roles:[role],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
async function pending(employmentId:string,count=1){
 return owner.db.insert(s.replacementLeaveRequest).values(Array.from({length:count},()=>({tenantId:b.tenantId,employmentId,unit:'day' as const,totalDays:'1',reason:'Fictional private reason never needed by Home',submittedOn:todayInKualaLumpur()}))).returning({id:s.replacementLeaveRequest.id});
}
describe('Replacement assigned-work metadata uses the real decision owner',()=>{
 it('counts beyond the old inbox ceiling without reading a private header column or request lines',async()=>{
  const subject=await employee(),heads=await pending(subject.employmentId,211),ctx=adminCtx(b);
  await owner.db.execute(sql`REVOKE SELECT ON public.replacement_leave_request FROM ai_hr_app`);
  await owner.db.execute(sql`GRANT SELECT(id,tenant_id,employment_id,status,created_at) ON public.replacement_leave_request TO ai_hr_app`);
  try{
   await expect(withTenant(ctx,tx=>tx.select({reason:s.replacementLeaveRequest.reason}).from(s.replacementLeaveRequest))).rejects.toMatchObject({cause:{code:'42501'}});
   const rows=await listPendingReplacementLeaveTasks(ctx);
   expect(rows).toHaveLength(211);expect(new Set(rows.map(r=>r.id))).toEqual(new Set(heads.map(r=>r.id)));
   for(const row of rows)expect(Object.keys(row).sort()).toEqual(['createdAt','employee','id','personId']);
   expect(JSON.stringify(rows)).not.toContain('private reason');
  }finally{
   await owner.db.execute(sql`GRANT SELECT ON public.replacement_leave_request TO ai_hr_app`);
   await owner.db.execute(sql`REVOKE SELECT(id,tenant_id,employment_id,status,created_at) ON public.replacement_leave_request FROM ai_hr_app`);
  }
 });
 it('uses an actual reporting assignment, excludes own work, and treats an explicit empty company scope as empty',async()=>{
  const manager=await employee(),report=await employee('employee',manager.employmentId),other=await employee();
  const [assigned]=await pending(report.employmentId);await pending(other.employmentId);await pending(manager.employmentId);
  expect((await listPendingReplacementLeaveTasks(manager.ctx)).map(r=>r.id)).toEqual([assigned.id]);
  expect(await listPendingReplacementLeaveTasks(manager.ctx,{companyIds:[]})).toEqual([]);
  await owner.db.update(s.reportingLine).set({validTo:todayInKualaLumpur()}).where(and(eq(s.reportingLine.subordinateEmploymentId,report.employmentId),eq(s.reportingLine.managerEmploymentId,manager.employmentId)));
  expect(await listPendingReplacementLeaveTasks(manager.ctx)).toEqual([]);
 });
 it('refuses a substituted Person or newly archived login rather than returning a false empty queue',async()=>{
  const hr=await employee('hr_admin'),other=await employee();await pending(other.employmentId);
  await expect(listPendingReplacementLeaveTasks({...hr.ctx,personId:other.personId})).rejects.toMatchObject({name:'AssignedWorkPrincipalUnavailableError'});
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,hr.ctx.userId!));
  await expect(listPendingReplacementLeaveTasks(hr.ctx)).rejects.toMatchObject({name:'AssignedWorkPrincipalUnavailableError'});
 });
 it('keeps the genuine rejectable queue after module lapse and removes the real completed request without minting credit',async()=>{
  const subject=await employee(),[head]=await pending(subject.employmentId);await setModule(b.tenantId,'toil','disabled');
  const ctx=await entitledCtx(b);expect((await listPendingReplacementLeaveTasks(ctx)).map(r=>r.id)).toEqual([head.id]);
  await decideReplacementLeaveRequest(ctx,{requestId:head.id,decision:'rejected',note:'Fictional acceptance rejection'});
  expect(await listPendingReplacementLeaveTasks(ctx)).toEqual([]);
  expect(await owner.db.select({id:s.toilAccrual.id}).from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,subject.employmentId))).toEqual([]);
 });
});
