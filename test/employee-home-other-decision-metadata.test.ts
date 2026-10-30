import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {pendingAttendanceTaskMetadata} from '../packs/attendance/service';
import {pendingResignationTaskMetadata,decideResignation} from '../core/offboarding';
import {pendingReviewTaskGroups,pendingReviewTaskMetadata,submitManagerEvaluation,decideReview} from '../core/employment-review';
import {listPendingTasks} from '../core/approvals-inbox';
import {AssignedWorkPrincipalUnavailableError} from '../lib/assigned-work';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function hire(name='Fictional task subject'){
 const hired=new Date(todayInKualaLumpur()+'T00:00:00Z');hired.setUTCFullYear(hired.getUTCFullYear()-1);
 return hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:hired.toISOString().slice(0,10)});
}
const columns=['id','tenant_id','employment_id','status','created_at'];
async function onlyColumns(table:'attendance_correction'|'resignation_request'|'employment_review',extra:string[],privateColumn:string,read:()=>Promise<void>){
 const allowed=[...columns,...extra];
 await owner.db.execute(sql.raw('REVOKE SELECT ON public.'+table+' FROM ai_hr_app'));
 await owner.db.execute(sql.raw('GRANT SELECT('+allowed.join(',')+') ON public.'+table+' TO ai_hr_app'));
 try{
  await expect(withTenant(adminCtx(b),tx=>tx.execute(sql.raw('SELECT '+privateColumn+' FROM public.'+table)))).rejects.toThrow();
  await read();
 }finally{
  await owner.db.execute(sql.raw('GRANT SELECT ON public.'+table+' TO ai_hr_app'));
  await owner.db.execute(sql.raw('REVOKE SELECT('+allowed.join(',')+') ON public.'+table+' FROM ai_hr_app'));
 }
}
function noPrivate(rows:unknown[]){
 for(const row of rows)for(const key of ['reason','lastWorkingDay','proposedCheckIn','clockChanges','managerComments','managerRecommendation','hrComments','decision'])expect(row).not.toHaveProperty(key);
}
describe('Home other assigned-decision metadata owners',()=>{
 it('checks the actual principal for an empty grouped review queue',async()=>{
  const ctx=adminCtx(b);
  expect(await pendingReviewTaskGroups(ctx)).toEqual({manager:[],hr:[]});
  await expect(pendingReviewTaskGroups({...ctx,userId:randomUUID()})).rejects.toThrow(AssignedWorkPrincipalUnavailableError);
  await expect(pendingReviewTaskGroups({...ctx,personId:randomUUID()})).rejects.toThrow(AssignedWorkPrincipalUnavailableError);
 });

 it('counts every attendance header without private proposal access, preserves scope and refuses a forged person',async()=>{
  const e=await hire(),ctx=adminCtx(b);
  const heads=await owner.db.insert(s.attendanceCorrection).values(Array.from({length:211},(_,i)=>{
   const date=new Date(todayInKualaLumpur()+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-i);
   return {tenantId:b.tenantId,employmentId:e.employmentId,attendanceDate:date.toISOString().slice(0,10),proposedCheckIn:'09:00',reason:'Fictional private correction reason'};
  })).returning({id:s.attendanceCorrection.id});
  await onlyColumns('attendance_correction',[],'reason',async()=>{
   const rows=await pendingAttendanceTaskMetadata(ctx);expect(rows).toHaveLength(211);noPrivate(rows);
   expect(new Set(rows.map(r=>r.id))).toEqual(new Set(heads.map(r=>r.id)));
   expect(await pendingAttendanceTaskMetadata(ctx,[])).toEqual([]);
   await expect(pendingAttendanceTaskMetadata({...ctx,personId:e.personId})).rejects.toThrow(AssignedWorkPrincipalUnavailableError);
  });
  const inbox=await listPendingTasks(ctx,undefined,{attendance:true,claims:false,performance:false,rewards:false});
  expect(inbox.filter(t=>t.kind==='attendance')).toHaveLength(211);
 });
 it('counts all resignation headers, reads no reason or attachment, and follows the actual rejection',async()=>{
  const e=await hire(),ctx=adminCtx(b),today=todayInKualaLumpur();
  const heads=await owner.db.insert(s.resignationRequest).values(Array.from({length:211},()=>({tenantId:b.tenantId,employmentId:e.employmentId,personId:e.personId,lastWorkingDay:today,reason:'Fictional private resignation reason'}))).returning({id:s.resignationRequest.id});
  await onlyColumns('resignation_request',['person_id'],'reason',async()=>{
   const rows=await pendingResignationTaskMetadata(ctx);expect(rows).toHaveLength(211);noPrivate(rows);
   expect(new Set(rows.map(r=>r.id))).toEqual(new Set(heads.map(r=>r.id)));expect(await pendingResignationTaskMetadata(ctx,[])).toEqual([]);
  });
  await decideResignation(ctx,{requestId:heads[0].id,decision:'rejected'});
  expect(await pendingResignationTaskMetadata(ctx)).toHaveLength(210);
  const [employment]=await owner.db.select({terminatedOn:s.employment.terminatedOn}).from(s.employment).where(eq(s.employment.id,e.employmentId));expect(employment.terminatedOn).toBeNull();
 });
 it('uses the stored actual manager assignment with Employee role, stage transitions and recorded deadlines',async()=>{
  const e=await hire(),m=await hire('Fictional assigned manager'),x=await hire('Fictional unassigned colleague');
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:e.employmentId,managerEmploymentId:m.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
  const uid=await createAppUser(b.tenantId,m.personId,'employee');
  const ctx:SessionContext={...adminCtx(b),userId:uid,personId:m.personId,roles:['employee']};
  const xuid=await createAppUser(b.tenantId,x.personId,'employee');
  const other:SessionContext={...ctx,userId:xuid,personId:x.personId};
  // The real owner permits only one open review per employment/type. Populate distinct fictional
  // employments rather than dropping that constraint to manufacture the volume witness.
  const [template]=await owner.db.select().from(s.employment).where(eq(s.employment.id,e.employmentId));
  const extra=await owner.db.insert(s.employment).values(Array.from({length:210},(_,i)=>({...template,id:randomUUID(),employeeCode:'HOME-META-'+i}))).returning({id:s.employment.id});
  const subjects=[e.employmentId,...extra.map(r=>r.id)];
  const [line]=await owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.subordinateEmploymentId,e.employmentId));
  await owner.db.insert(s.reportingLine).values(extra.map(r=>({...line,id:randomUUID(),subordinateEmploymentId:r.id})));
  const heads=await owner.db.insert(s.employmentReview).values(subjects.map(employmentId=>({tenantId:b.tenantId,employmentId,personId:e.personId,reviewType:'probation' as const,managerEmploymentId:m.employmentId,endDate:todayInKualaLumpur(),dueDate:todayInKualaLumpur(),managerComments:'Fictional private evaluation'}))).returning({id:s.employmentReview.id});
  await onlyColumns('employment_review',['person_id','manager_employment_id','due_date'],'manager_comments',async()=>{
   const rows=await pendingReviewTaskMetadata(ctx,'manager');expect(rows).toHaveLength(211);noPrivate(rows);
   expect(await pendingReviewTaskGroups(ctx)).toEqual({manager:rows,hr:[]});
   expect(await pendingReviewTaskGroups(ctx,[])).toEqual({manager:[],hr:[]});
   expect(await pendingReviewTaskGroups(other)).toEqual({manager:[],hr:[]});
   expect(await pendingReviewTaskGroups(adminCtx(b))).toEqual({manager:[],hr:[]});
   await expect(pendingReviewTaskGroups({...ctx,personId:x.personId})).rejects.toThrow(AssignedWorkPrincipalUnavailableError);
   expect(rows.every(r=>r.dueDate===todayInKualaLumpur())).toBe(true);expect(await pendingReviewTaskMetadata(ctx,'manager',[])).toEqual([]);
   expect(await pendingReviewTaskMetadata(other,'manager')).toEqual([]);
   expect(await pendingReviewTaskMetadata(adminCtx(b),'manager')).toEqual([]);
   await expect(pendingReviewTaskMetadata({...ctx,personId:x.personId},'manager')).rejects.toThrow(AssignedWorkPrincipalUnavailableError);
  });
  await submitManagerEvaluation(ctx,{reviewId:heads[0].id,recommendation:'recommend_confirm',comments:'Fictional completed evaluation'});
  expect(await pendingReviewTaskMetadata(ctx,'manager')).toHaveLength(210);
  expect(await pendingReviewTaskMetadata(adminCtx(b),'hr')).toMatchObject([{id:heads[0].id,dueDate:todayInKualaLumpur()}]);
  expect(await pendingReviewTaskMetadata(ctx,'hr')).toEqual([]);
  for(const viewer of [ctx,other,adminCtx(b)]){
   const grouped=await pendingReviewTaskGroups(viewer);
   expect(grouped).toEqual({manager:await pendingReviewTaskMetadata(viewer,'manager'),hr:await pendingReviewTaskMetadata(viewer,'hr')});
   noPrivate([...grouped.manager,...grouped.hr]);
  }
  const foreign=await seedBase();
  expect(await pendingReviewTaskGroups(adminCtx(foreign))).toEqual({manager:[],hr:[]});
  await decideReview(adminCtx(b),{reviewId:heads[0].id,decision:'confirm'});
  expect(await pendingReviewTaskMetadata(adminCtx(b),'hr')).toEqual([]);
  expect((await pendingReviewTaskGroups(adminCtx(b))).hr).toEqual([]);
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,uid));
  await expect(pendingReviewTaskGroups(ctx)).rejects.toThrow(AssignedWorkPrincipalUnavailableError);
 });
});
