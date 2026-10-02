import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {assignDefaultShift,createShift} from '../core/roster';
import {attendanceForEmploymentRange,attendanceForEmploymentsRange,checkIn,checkOut} from '../packs/attendance/service';
import {requestLeave,actionableLeaveRequests} from '../packs/leave/service';
import {readMyTeam,markMyTeamPunchReviewed,decideMyTeamLeave} from '../core/my-team';
import {assertMyTeamSubjectTx} from '../core/my-team-scope';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso,weekRangeOf} from '../lib/roster-month';
import {adminCtx,createAppUser,entitledCtx,owner,seedBase,resetDb,migrateTestDb,closeAll,type Base} from './harness';

let b:Base,manager:{personId:string;employmentId:string},subject:{personId:string;employmentId:string},downline:{personId:string;employmentId:string},outsider:{personId:string;employmentId:string},managerCtx:SessionContext;
const today=todayInKualaLumpur(),query={view:'week' as const,scope:'all' as const,anchorDate:today};
const hire=(name:string)=>hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`myteam_${randomUUID()}@t.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();manager=await hire('My Team Manager');subject=await hire('My Team Report');downline=await hire('My Team Downline');outsider=await hire('My Team Stranger');
 const userId=await createAppUser(b.tenantId,manager.personId,'manager');
 managerCtx={...await entitledCtx(b,['manager']),userId,personId:manager.personId,roles:['manager'],grants:[{role:'manager',companyId:b.companyId}]};
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:downline.employmentId,managerEmploymentId:subject.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'20.00',effectiveOn:today.slice(0,4)+'-01-01'});
});
afterAll(closeAll);

describe('My Team current scope and canonical projection',()=>{
 it('direct/all reports are dated, self-free and never expand through HOD visibility or a caller identity',async()=>{
  const direct=await readMyTeam(managerCtx,{...query,scope:'direct'});
  expect(direct.scope.employmentIds).toEqual([subject.employmentId]);
  const all=await readMyTeam(managerCtx,query);
  expect(new Set(all.scope.employmentIds)).toEqual(new Set([subject.employmentId,downline.employmentId]));
  const hodVisible=await withTenant(managerCtx,tx=>tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,outsider.employmentId)));
  expect(hodVisible).toHaveLength(1);
  expect(all.scope.employmentIds).not.toContain(manager.employmentId);expect(all.scope.employmentIds).not.toContain(outsider.employmentId);
  const forged=await readMyTeam({...managerCtx,personId:outsider.personId},query);
  expect(forged.scope.employmentIds).toEqual(all.scope.employmentIds);
  const empty=await readMyTeam(managerCtx,{...query,companyIds:[]});
  expect(empty.employees).toEqual([]);expect(empty.gridEmploymentIds).toEqual([]);expect(empty.todaySummary.members).toBe(0);
  await expect(readMyTeam({...managerCtx,roles:['employee']},query)).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
  await expect(readMyTeam(managerCtx,{...query,scope:'department',departmentId:b.deptA})).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
  await owner.db.update(schema.reportingLine).set({validTo:today}).where(eq(schema.reportingLine.subordinateEmploymentId,subject.employmentId));
  expect((await readMyTeam(managerCtx,query)).employees).toEqual([]);
 });
 it('search and tile only narrow grid IDs, while tiles and attention retain the full authorized team',async()=>{
  const plain=await readMyTeam(managerCtx,query),filtered=await readMyTeam(managerCtx,{...query,search:'Report'});
  expect(filtered.gridEmploymentIds).toEqual([subject.employmentId]);
  expect(filtered.scope.employmentIds).toEqual(plain.scope.employmentIds);expect(filtered.todaySummary).toEqual(plain.todaySummary);
  expect(filtered.employees.map(e=>e.employmentId)).toEqual(plain.employees.map(e=>e.employmentId));
 });
 it('bulk attendance is exactly the individual owner output, including stored results and off days',async()=>{
  const a=adminCtx(b),week=weekRangeOf(today);
  const shiftId=(await createShift(a,{name:'My Team Source Shift',code:'MTS',startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]})).id;
  await assignDefaultShift(a,{employmentId:subject.employmentId,shiftId});
  await checkIn(a,{employmentId:subject.employmentId,date:week.from,time:'09:20'});
  await checkOut(a,{employmentId:subject.employmentId,date:week.from,time:'18:00'});
  const bulk=await attendanceForEmploymentsRange(managerCtx,[subject.employmentId,downline.employmentId,outsider.employmentId],week.from,week.to);
  // The Records owner retains its RLS scope (which may include HOD-visible people); My Team narrows before calling it.
  expect(bulk.get(outsider.employmentId)??[]).toEqual(await attendanceForEmploymentRange(managerCtx,outsider.employmentId,week.from,week.to));
  const individual=await attendanceForEmploymentRange(managerCtx,subject.employmentId,week.from,week.to);
  expect(individual).toHaveLength(7);expect(individual.some(r=>r.attendanceId)).toBe(true);
  expect(bulk.get(subject.employmentId)).toEqual(individual);
  expect(bulk.get(downline.employmentId)).toEqual(await attendanceForEmploymentRange(managerCtx,downline.employmentId,week.from,week.to));
 });
 it('employee balance visibility hides available without inventing zero or subtracting pending twice',async()=>{
  await owner.db.update(schema.leaveType).set({essViewConfig:{available:false,pendingApproval:false}}).where(eq(schema.leaveType.id,b.annualLeaveTypeId));
  const snapshot=await readMyTeam(managerCtx,query),employee=snapshot.employees.find(e=>e.employmentId===subject.employmentId)!;
  expect(employee.annualAvailable).toBeNull();
  expect(employee.balances.find(bal=>bal.leaveTypeId===b.annualLeaveTypeId)).toMatchObject({available:null,pending:null});
 });
});

describe('My Team actionable current-step decisions',()=>{
 it('manager sees current direct step, loses it after advancing to HR, and cannot approve through a stale scope',async()=>{
  const date=addDaysIso(weekRangeOf(today).from,7);
  const {leaveRequestId}=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  const before=await actionableLeaveRequests(managerCtx,{employmentIds:[subject.employmentId]});
  expect(before.map(r=>r.requestId)).toContain(leaveRequestId);
  const snapshot=await readMyTeam(managerCtx,query);expect(snapshot.actionableApprovals.map(r=>r.requestId)).toContain(leaveRequestId);
  expect(snapshot.todaySummary.pendingApprovals).toBe(1);
  await decideMyTeamLeave(managerCtx,query,{leaveRequestId,decision:'approved'});
  expect((await actionableLeaveRequests(managerCtx,{employmentIds:[subject.employmentId]})).map(r=>r.requestId)).not.toContain(leaveRequestId);
  await expect(decideMyTeamLeave(managerCtx,query,{leaveRequestId,decision:'approved'})).rejects.toThrow(/HR/);
  await owner.db.update(schema.reportingLine).set({validTo:today}).where(eq(schema.reportingLine.subordinateEmploymentId,subject.employmentId));
  await expect(decideMyTeamLeave({...adminCtx(b),personId:manager.personId},{...query,scope:'direct'},{leaveRequestId,decision:'approved'})).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
  const [req]=await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id,leaveRequestId));expect(req.status).toBe('pending');
 });
});

describe('My Team attendance review is per user, observation and fresh authority',()=>{
 it('marks only the observed missing punch; changed attendance reappears and stale/foreign markers refuse',async()=>{
  const date=addDaysIso(today,-1);await checkIn(adminCtx(b),{employmentId:subject.employmentId,date:date,time:'09:10'});
  const before=await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,subject.employmentId),eq(schema.attendance.attendanceDate,date)));
  const snapshot=await readMyTeam(managerCtx,{...query,anchorDate:date});
  const missing=snapshot.attention.find(a=>a.kind==='missing_punch'&&a.employmentId===subject.employmentId);
  expect(missing?.kind).toBe('missing_punch');if(missing?.kind!=='missing_punch')throw new Error('non-vacuous missing punch fixture');
  const reviewed=await markMyTeamPunchReviewed(managerCtx,{attendanceId:missing.attendanceId,fingerprint:missing.fingerprint});
  expect(await markMyTeamPunchReviewed(managerCtx,{attendanceId:missing.attendanceId,fingerprint:missing.fingerprint})).toEqual(reviewed);
  expect(await owner.db.select().from(schema.attendance).where(eq(schema.attendance.id,missing.attendanceId))).toEqual(before);
  const after=await readMyTeam(managerCtx,{...query,anchorDate:date});expect(after.attention.some(a=>a.id===missing.id)).toBe(false);
  const audit=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,reviewed.reviewId));
  expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({eventType:'attendance-attention.reviewed',actorId:managerCtx.userId});
  await owner.db.update(schema.attendance).set({checkInAt:'09:11:00'}).where(eq(schema.attendance.id,missing.attendanceId));
  await expect(markMyTeamPunchReviewed(managerCtx,{attendanceId:missing.attendanceId,fingerprint:missing.fingerprint})).rejects.toThrow('MY_TEAM_REVIEW_CHANGED');
  const changed=await readMyTeam(managerCtx,{...query,anchorDate:date});expect(changed.attention.some(a=>a.id===missing.id)).toBe(true);
  await owner.db.update(schema.reportingLine).set({validTo:today}).where(eq(schema.reportingLine.subordinateEmploymentId,subject.employmentId));
  await expect(markMyTeamPunchReviewed(managerCtx,{attendanceId:missing.attendanceId,fingerprint:missing.fingerprint})).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
  await expect(withTenant(managerCtx,tx=>tx.update(schema.attendanceAttentionReview).set({fingerprint:'0'.repeat(32)}))).rejects.toThrow();
 });
 it('holds membership facts through an app-role transaction, so ending a report waits and the next decision refuses',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
  const holder=withTenant(managerCtx,async tx=>{await assertMyTeamSubjectTx(tx,managerCtx,query,subject.employmentId);entered();await gate;});
  await Promise.race([ready,holder]);
  let changed=false;const mutation=owner.db.update(schema.reportingLine).set({validTo:today}).where(eq(schema.reportingLine.subordinateEmploymentId,subject.employmentId)).then(()=>{changed=true;});
  try{
   let waiting=false;
   for(let attempt=0;attempt<50&&!waiting;attempt++){
    const rows=await owner.db.execute(sql`SELECT pid FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%reporting_line%'`);
    waiting=rows.length>0;if(!waiting)await new Promise(r=>setTimeout(r,10));
   }
   expect(waiting).toBe(true);expect(changed).toBe(false);
  }finally{release();await holder;await mutation;}
  expect((await readMyTeam(managerCtx,query)).scope.employmentIds).not.toContain(subject.employmentId);
 });
});
