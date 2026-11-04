/** Real Attendance task reads against a frozen independent pre-batch reader; no authority mocks. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,desc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {attendanceCorrection} from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {pendingAttendanceTaskMetadata,requestAttendanceCorrection} from '../core/attendance';
import {assertAssignedWorkPrincipalTx} from '../core/approvals';
import {actionableAttendanceApplicationIdsTx} from '../core/attendance-workflow';
import type {AssignedApprovalMetadata} from '../lib/assigned-work';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,resetDb,seedBase,setModule} from './harness';
// Frozen bf8056f493681afe6c9ede72b74d89f4c6d7a0ef implementation, with every native owner intact.
function legacyPendingAttendanceTaskMetadata(ctx:SessionContext,companyIds?:string[]):Promise<AssignedApprovalMetadata[]>{
  return withTenant(ctx,async tx=>{
    await assertAssignedWorkPrincipalTx(tx,ctx);
    // A negative result proves no possible assignment source. Positives retain every native
    // request RLS and live decision proof below; this result never authorizes a command or is cached.
    const [candidate]=await tx.execute<{possible:boolean}>(sql`select app.may_have_attendance_task_metadata() as possible`);
    if(candidate?.possible===false)return [];
    const rows=await tx.select({id:attendanceCorrection.id,employmentId:attendanceCorrection.employmentId,
      personId:sql<string>`subject.person_id`,employee:sql<string|null>`subject.employee`,createdAt:attendanceCorrection.createdAt})
      .from(attendanceCorrection)
      .innerJoin(sql`LATERAL app.attendance_application_subject(${attendanceCorrection.id}) AS subject`,sql`true`)
      .where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.status,'pending'),
        sql`NOT app.is_self_person(subject.person_id)`,companyIds===undefined?undefined:companyIds.length===0?sql`false`:
          sql`(subject.company_id IN (${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`,`)}) OR app.attendance_workflow_v3_decision_slot(${attendanceCorrection.id}) IS NOT NULL)`))
      .orderBy(desc(attendanceCorrection.createdAt),attendanceCorrection.id);
    const allowed=await actionableAttendanceApplicationIdsTx(tx,ctx,rows);
    return rows.filter(row=>allowed.has(row.id));
  });
}

beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps the exact uncapped actionable queue while reducing repeated administrator subject work',async()=>{
 await resetDb();const b=await seedBase(),admin=adminCtx(b);await setModule(b.tenantId,'attendance','active');
 const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const subject=await hire('Fictional retained metadata subject'),manager=await hire('Fictional metadata manager');
 await setReportingLine(admin,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const login=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...admin,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:[{role,companyId:b.companyId}]});
 const self=await login(subject.personId,'employee'),reviewer=await login(manager.personId,'manager');
 const ids:string[]=[];const today=todayInKualaLumpur(),fixtureStarted=performance.now();
 for(let index=1;index<=211;index++){
  const day=new Date(today+'T00:00:00Z');day.setUTCDate(day.getUTCDate()-index);
  const {correctionId}=await requestAttendanceCorrection(self,{employmentId:subject.employmentId,date:day.toISOString().slice(0,10),checkIn:'09:00',checkOut:'18:00',reason:'PRIVATE_METADATA_REASON_NOT_FOR_HEADER'});ids.push(correctionId);
 }
 const fixturePreparationMs=performance.now()-fixtureStarted;
 const expected=await legacyPendingAttendanceTaskMetadata(admin,[b.companyId]);expect(expected).toHaveLength(211);
 expect(new Set(expected.map(row=>row.id))).toEqual(new Set(ids));expect(JSON.stringify(expected)).not.toContain('PRIVATE_METADATA_REASON');
 const audienceChecks:string[]=[];
 for(const [name,actor,scope]of [['admin',admin,[b.companyId]],['manager',reviewer,[b.companyId]],['self',self,[b.companyId]],['emptyScope',admin,[]],['unscoped',admin,undefined]]as const){
  expect(await pendingAttendanceTaskMetadata(actor,scope===undefined?undefined:[...scope])).toEqual(await legacyPendingAttendanceTaskMetadata(actor,scope===undefined?undefined:[...scope]));audienceChecks.push(name);
 }
 const foreign=await seedBase();expect(await pendingAttendanceTaskMetadata(adminCtx(foreign),[b.companyId])).toEqual([]);audienceChecks.push('foreignTenant');
 await expect(pendingAttendanceTaskMetadata({...self,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]},[b.companyId])).rejects.toThrow();audienceChecks.push('forgedAdminRefused');
 const measurements:{phase:string;reads:number;elapsedMs:number}[]=[];
 for(const phase of ['original','candidate','candidate-warm','restored']as const){
  const started=performance.now(),read=phase==='original'||phase==='restored'?legacyPendingAttendanceTaskMetadata:pendingAttendanceTaskMetadata;
  for(let index=0;index<15;index++)expect(await read(admin,[b.companyId])).toEqual(expected);
  measurements.push({phase,reads:15,elapsedMs:performance.now()-started});
 }
 const control=Math.min(measurements[0].elapsedMs,measurements[3].elapsedMs),candidate=Math.max(measurements[1].elapsedMs,measurements[2].elapsedMs);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'attendance-task-subject-batch.json'),JSON.stringify({kind:'NATIVE_ATTENDANCE_SUBJECT_BATCH_COMPONENT_ONLY',releaseEligible:false,fixtureRequests:ids.length,fixture:'211 actual native self-submission commands; all triggers and RLS intact',fixturePreparationMs,measurements,audienceChecks,exactUncappedDTOOrder:true,privatePayloadOmitted:true,improvementRatio:candidate/control,limitations:'single principal and211requests; not500-usercapacity or wholepage timings'},null,2));
 expect(candidate,'Both measured batch phases must improve at least20% over the faster control').toBeLessThan(control*.8);
},600000);
