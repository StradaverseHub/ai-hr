import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import * as readOwner from '../core/read';
import {hireEmployee,setReportingLine} from '../core/org';
import {assignDefaultShift,createShift} from '../core/roster';
import {attendanceForEmploymentRange,attendanceForEmploymentsRange,attendanceForDate,checkIn,checkOut} from '../packs/attendance/service';
import {requestLeave,actionableLeaveRequests,setLeaveApprovalPolicy,decideLeave} from '../packs/leave/service';
import {readMyTeam,markMyTeamPunchReviewed,decideMyTeamLeave,decideMyTeamLeaveDates} from '../core/my-team';
import {assertMyTeamSubjectTx,resolveMyTeamScope} from '../core/my-team-scope';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso,weekRangeOf} from '../lib/roster-month';
import {adminCtx,createAppUser,entitledCtx,owner,seedBase,resetDb,migrateTestDb,closeAll,setModule,type Base} from './harness';

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
 it('intersects a real current grant even when a second authenticated employment makes company B reports RLS-visible',async()=>{
  const [otherCompany]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Synthetic Scoped B',country:'MY',currency:'MYR'}).returning({id:schema.company.id});
  const [otherDepartment]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:otherCompany.id,name:'Synthetic Dept B'}).returning({id:schema.department.id});
  const [secondRoot]=await owner.db.insert(schema.employment).values({tenantId:b.tenantId,personId:manager.personId,companyId:otherCompany.id,employmentType:'full_time',hiredOn:'2024-01-01'}).returning({id:schema.employment.id});
  const otherReport=await hireEmployee(adminCtx(b),{person:{fullName:'Scoped B Report',primaryEmail:`myteam_b_${randomUUID()}@t.local`},companyId:otherCompany.id,departmentId:otherDepartment.id,employmentType:'full_time',hiredOn:'2024-01-01'});
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:otherReport.employmentId,managerEmploymentId:secondRoot.id,lineType:'administrative',validFrom:'2024-01-01'});
  const visible=await withTenant(managerCtx,tx=>tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,otherReport.employmentId)));
  expect(visible).toHaveLength(1);
  await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,managerCtx.userId!));
  const forged={...managerCtx,grants:[{role:'manager',companyId:null}]};
  expect((await readMyTeam(forged,{...query,companyIds:[otherCompany.id]})).employees).toEqual([]);
  expect((await readMyTeam(forged,query)).scope.employmentIds).not.toContain(otherReport.employmentId);
 });
 it('refuses live grant revocation during a read and a stale context at the next writer authority check',async()=>{
  const original=readOwner.leaveBalances;let revoked=false;
  const spy=vi.spyOn(readOwner,'leaveBalances').mockImplementation(async(...args)=>{
   const result=await original(...args);
   if(!revoked){revoked=true;await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,managerCtx.userId!));}
   return result;
  });
  try{await expect(readMyTeam(managerCtx,query)).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');expect(revoked).toBe(true);}
  finally{spy.mockRestore();}
  await expect(readMyTeam(managerCtx,query)).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
  const date=addDaysIso(weekRangeOf(today).from,7);
  const {leaveRequestId}=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  await expect(decideMyTeamLeave(managerCtx,query,{leaveRequestId,decision:'approved'})).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
  const [req]=await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id,leaveRequestId));expect(req.status).toBe('pending');
 });
 it('All reports walks deeper than 64 with visited-path protection and no silent model cutoff',async()=>{
  const people=Array.from({length:66},(_,index)=>({id:randomUUID(),tenantId:b.tenantId,fullName:`Deep Synthetic ${index}`,primaryEmail:`deep_${randomUUID()}@t.local`}));
  await owner.db.insert(schema.person).values(people);
  const employments=people.map(p=>({id:randomUUID(),tenantId:b.tenantId,personId:p.id,companyId:b.companyId,employmentType:'full_time' as const,hiredOn:'2024-01-01'}));
  await owner.db.insert(schema.employment).values(employments);
  await owner.db.insert(schema.assignment).values(employments.map(e=>({tenantId:b.tenantId,employmentId:e.id,companyId:b.companyId,departmentId:b.deptA,validFrom:'2024-01-01'})));
  await owner.db.insert(schema.reportingLine).values(employments.map((e,index)=>({tenantId:b.tenantId,subordinateEmploymentId:e.id,
    managerEmploymentId:index===0?manager.employmentId:employments[index-1].id,lineType:'administrative' as const,validFrom:'2024-01-01'})));
  const scope=await resolveMyTeamScope(managerCtx,query);
  expect(scope.employees.map(e=>e.employmentId)).toContain(employments[65].id);
  expect(scope.employees).toHaveLength(68);
 });
 it('Records and My Team use the exact half-day window, including when Attendance is unavailable',async()=>{
  const a=await entitledCtx(b),date='2026-09-26';
  const {id:shiftId}=await createShift(a,{name:'My Team Half',code:'MTH',startTime:'09:00',endTime:'18:00',breakMinutes:60,
    weeklyPattern:[1,2,3,4,5],halfPattern:[6]});
  await assignDefaultShift(a,{employmentId:subject.employmentId,shiftId});
  const records=(await attendanceForDate(managerCtx,date,[b.companyId])).find(r=>r.employmentId===subject.employmentId)!;
  const [range]=await attendanceForEmploymentRange(managerCtx,subject.employmentId,date,date);
  expect(records).toMatchObject({scheduledMinutes:240,shiftStart:'09:00',shiftEnd:'13:30'});
  expect(range).toMatchObject({scheduledMinutes:240,shiftStart:'09:00',shiftEnd:'13:30'});
  const snapshot=await readMyTeam(managerCtx,{...query,anchorDate:date});
  const day=snapshot.employees.find(e=>e.employmentId===subject.employmentId)!.days.find(d=>d.date===date)!;
  expect(day.roster).toMatchObject({kind:'shift',scheduledMinutes:240,start:'09:00',end:'13:30'});
  await setModule(b.tenantId,'attendance','disabled');
  const disabled=await entitledCtx(b,['manager']);
  const noAttendance={...disabled,userId:managerCtx.userId,personId:manager.personId,roles:['manager'],grants:managerCtx.grants};
  const unavailable=await readMyTeam(noAttendance,{...query,anchorDate:date});
  expect(unavailable.availability.attendance).toBe('unavailable');
  const withoutAttendance=unavailable.employees.find(e=>e.employmentId===subject.employmentId)!.days.find(d=>d.date===date)!;
  expect(withoutAttendance.attendance).toBeNull();
  expect(withoutAttendance.roster).toMatchObject({kind:'shift',scheduledMinutes:240,start:'09:00',end:'13:30'});
 });
 it('search and tile only narrow grid IDs, while tiles and attention retain the full authorized team',async()=>{
  const plain=await readMyTeam(managerCtx,query),filtered=await readMyTeam(managerCtx,{...query,search:'Report'});
  expect(filtered.gridEmploymentIds).toEqual([subject.employmentId]);
  expect(filtered.scope.employmentIds).toEqual(plain.scope.employmentIds);expect(filtered.todaySummary).toEqual(plain.todaySummary);
  expect(filtered.employees.map(e=>e.employmentId)).toEqual(plain.employees.map(e=>e.employmentId));
 });
 it('refuses a reporting/assignment change during canonical source reads instead of returning stale team facts',async()=>{
  const original=readOwner.leaveBalances;let changed=false;
  const spy=vi.spyOn(readOwner,'leaveBalances').mockImplementation(async(...args)=>{
   const result=await original(...args);
   if(!changed){changed=true;await owner.db.update(schema.assignment).set({departmentId:b.deptB})
     .where(and(eq(schema.assignment.employmentId,subject.employmentId),sql`${schema.assignment.supersededAt} IS NULL`));}
   return result;
  });
  try{await expect(readMyTeam(managerCtx,query)).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');expect(changed).toBe(true);}
  finally{spy.mockRestore();}
 });
 it('uses one canonical Annual Leave balance and reports ambiguous annual sources unavailable',async()=>{
  expect((await readMyTeam(managerCtx,query)).employees.find(e=>e.employmentId===subject.employmentId)?.annualAvailable).toBe(20);
  const [type]=await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id,b.annualLeaveTypeId));
  const annualId=randomUUID();await owner.db.insert(schema.leaveType).values({...type,id:annualId,code:`SYN_ANNUAL_${randomUUID().slice(0,8)}`,name:'Synthetic Other Annual',role:'annual'});
  await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:annualId,entryType:'accrual',days:'3.00',effectiveOn:today.slice(0,4)+'-01-01'});
  const employee=(await readMyTeam(managerCtx,query)).employees.find(e=>e.employmentId===subject.employmentId)!;
  expect(employee.balances.filter(bal=>bal.leaveTypeId===annualId||bal.leaveTypeId===b.annualLeaveTypeId)).toHaveLength(2);
  expect(employee.annualAvailable).toBeNull();
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

describe('My Team recorded leave dates and alternate authority',()=>{
 it('projects partial approvals and half-day pending leave from the same source, never a rejected date',async()=>{
  await setLeaveApprovalPolicy(adminCtx(b),{companyId:b.companyId,levels:['direct_manager']});
  await owner.db.update(schema.leaveType).set({perDateApproval:true,durations:['full_day','half_day_am']}).where(eq(schema.leaveType.id,b.annualLeaveTypeId));
  const from=addDaysIso(weekRangeOf(today).from,7),middle=addDaysIso(from,1),to=addDaysIso(from,2);
  const {leaveRequestId}=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:from,endDate:to});
  const before=await readMyTeam(managerCtx,{...query,anchorDate:from});
  const approval=before.actionableApprovals.find(a=>a.requestId===leaveRequestId)!;
  expect(approval.dateDecisionRequired).toBe(true);expect(approval.dates).toHaveLength(3);expect(approval.dates.every(d=>!!d.id&&d.days===1)).toBe(true);
  await decideMyTeamLeaveDates(managerCtx,query,{leaveRequestId,decisions:[{leaveDate:from,decision:'approved'},
    {leaveDate:middle,decision:'rejected',rejectReason:'Synthetic unavailable date'},{leaveDate:to,decision:'approved'}]});
  const half=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,
    startDate:addDaysIso(from,3),endDate:addDaysIso(from,3),durationType:'half_day_am'});
  const after=await readMyTeam(managerCtx,{...query,anchorDate:from}),employee=after.employees.find(e=>e.employmentId===subject.employmentId)!;
  expect(employee.days.find(d=>d.date===from)?.leave).toEqual([expect.objectContaining({requestId:leaveRequestId,status:'approved',days:1})]);
  expect(employee.days.find(d=>d.date===middle)?.leave).toEqual([]);
  expect(employee.days.find(d=>d.date===to)?.leave).toEqual([expect.objectContaining({requestId:leaveRequestId,status:'approved',days:1})]);
  expect(employee.days.find(d=>d.date===addDaysIso(from,3))?.leave).toEqual([expect.objectContaining({requestId:half.leaveRequestId,status:'pending',session:'AM',days:0.5})]);
  expect(employee.weeks.find(w=>w.from===from)?.approvedLeaveDays).toBe(2);
  expect(after.todaySummary.pendingApprovals).toBe(1);
 });
 it("delegation transfers decision authority, while My Team browsing remains the caller's own reporting team",async()=>{
  const delegateReport=await hire('Delegate Own Report');
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:delegateReport.employmentId,managerEmploymentId:outsider.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
  const delegateUser=await createAppUser(b.tenantId,outsider.personId,'manager');
  const delegateCtx={...managerCtx,userId:delegateUser,personId:outsider.personId};
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:manager.employmentId,managerEmploymentId:outsider.employmentId,lineType:'delegate',validFrom:'2024-01-01'});
  const date=addDaysIso(weekRangeOf(today).from,7);
  const {leaveRequestId}=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  expect((await actionableLeaveRequests(delegateCtx,{employmentIds:[subject.employmentId]})).map(r=>r.requestId)).toContain(leaveRequestId);
  expect((await readMyTeam(delegateCtx,query)).scope.employmentIds).not.toContain(subject.employmentId);
  await expect(decideMyTeamLeave(delegateCtx,query,{leaveRequestId,decision:'approved'})).rejects.toThrow('MY_TEAM_NOT_AUTHORIZED');
  expect(await decideLeave(delegateCtx,{leaveRequestId,decision:'approved'})).toMatchObject({status:'pending',advancedTo:'hr_admin'});
 });
 it.each(['manager','hr','self','stranger','inactive'] as const)('actionability matches the actual writer for %s authority',async kind=>{
  const date=addDaysIso(weekRangeOf(today).from,7);
  const {leaveRequestId}=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  let ctx=managerCtx;
  if(kind==='hr')ctx=adminCtx(b);
  if(kind==='self'||kind==='stranger'){
   const person=kind==='self'?subject:outsider;const userId=await createAppUser(b.tenantId,person.personId,'employee');
   ctx={...managerCtx,userId,personId:person.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  }
  if(kind==='inactive')await owner.db.update(schema.reportingLine).set({validTo:today}).where(eq(schema.reportingLine.subordinateEmploymentId,subject.employmentId));
  const allowed=kind==='manager'||kind==='hr';
  const listed=(await actionableLeaveRequests(ctx,{employmentIds:[subject.employmentId]})).some(r=>r.requestId===leaveRequestId);
  expect(listed).toBe(allowed);
  if(allowed)expect(await decideLeave(ctx,{leaveRequestId,decision:'approved'})).toMatchObject({status:'pending'});
  else await expect(decideLeave(ctx,{leaveRequestId,decision:'approved'})).rejects.toThrow();
 });
 it('approved AM leave is a half-day indicator without being counted as full-day On Leave',async()=>{
  await setLeaveApprovalPolicy(adminCtx(b),{companyId:b.companyId,levels:['direct_manager']});
  await owner.db.update(schema.leaveType).set({durations:['full_day','half_day_am'],dayTypeInclusion:{publicHoliday:true,restDay:true,offDay:true}}).where(eq(schema.leaveType.id,b.annualLeaveTypeId));
  const {leaveRequestId}=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:today,endDate:today,durationType:'half_day_am'});
  await decideMyTeamLeave(managerCtx,query,{leaveRequestId,decision:'approved'});
  const snapshot=await readMyTeam(managerCtx,query),employee=snapshot.employees.find(e=>e.employmentId===subject.employmentId)!;
  expect(employee.today).toMatchObject({onLeave:false,halfDayLeave:true});
  expect(snapshot.todaySummary).toMatchObject({onLeave:0,halfDayLeave:1});
  expect((await readMyTeam(managerCtx,{...query,tile:'on_leave'})).gridEmploymentIds).not.toContain(subject.employmentId);
 });
 it('uses frozen alternates as the actual writer does; configuration faults are never swallowed as refusal',async()=>{
  const date=addDaysIso(weekRangeOf(today).from,7);
  const {leaveRequestId}=await requestLeave(adminCtx(b),{employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  await owner.db.update(schema.leaveApprovalStep).set({approverKind:'hr_admin',approverAlternates:[{kind:'specific_employee',employmentId:manager.employmentId}]})
    .where(and(eq(schema.leaveApprovalStep.leaveRequestId,leaveRequestId),eq(schema.leaveApprovalStep.stepIndex,0)));
  expect((await actionableLeaveRequests(managerCtx,{employmentIds:[subject.employmentId]})).map(a=>a.requestId)).toContain(leaveRequestId);
  await owner.db.update(schema.leaveApprovalStep).set({approverKind:'unknown_synthetic_kind'})
    .where(and(eq(schema.leaveApprovalStep.leaveRequestId,leaveRequestId),eq(schema.leaveApprovalStep.stepIndex,0)));
  await expect(actionableLeaveRequests(managerCtx,{employmentIds:[subject.employmentId]})).rejects.toThrow('Unknown approver step');
  await expect(decideMyTeamLeave(managerCtx,query,{leaveRequestId,decision:'approved'})).rejects.toThrow('Unknown approver step');
  const [request]=await owner.db.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id,leaveRequestId));expect(request.status).toBe('pending');
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
  await owner.db.delete(schema.attendance).where(eq(schema.attendance.id,missing.attendanceId));
  expect(await owner.db.select().from(schema.attendanceAttentionReview).where(eq(schema.attendanceAttentionReview.id,reviewed.reviewId))).toEqual([]);
  expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,reviewed.reviewId))).toHaveLength(1);
 });
 it('rechecks the selected direct-report context after a read-to-review membership race',async()=>{
  const date=addDaysIso(today,-1),direct={...query,scope:'direct' as const,anchorDate:date};
  await checkIn(adminCtx(b),{employmentId:subject.employmentId,date,time:'09:10'});
  const snapshot=await readMyTeam(managerCtx,direct),missing=snapshot.attention.find(a=>a.kind==='missing_punch'&&a.employmentId===subject.employmentId);
  if(missing?.kind!=='missing_punch')throw new Error('non-vacuous direct report missing punch');
  let attempted!:Promise<{error?:unknown}>;
  await owner.db.transaction(async tx=>{
   await tx.select().from(schema.attendance).where(eq(schema.attendance.id,missing.attendanceId)).for('update');
   attempted=markMyTeamPunchReviewed(managerCtx,{attendanceId:missing.attendanceId,fingerprint:missing.fingerprint},snapshot.query)
     .then(()=>({}),error=>({error}));
   let waiting=false;
   for(let attempt=0;attempt<50&&!waiting;attempt++){
    const rows=await tx.execute(sql`SELECT pid FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%attendance%'`);
    waiting=rows.length>0;if(!waiting)await new Promise(r=>setTimeout(r,10));
   }
   expect(waiting).toBe(true);
   await tx.update(schema.reportingLine).set({validTo:today}).where(and(eq(schema.reportingLine.tenantId,b.tenantId),
     sql`${schema.reportingLine.subordinateEmploymentId} IN (${subject.employmentId}::uuid,${downline.employmentId}::uuid)`));
   await tx.insert(schema.reportingLine).values([
    {tenantId:b.tenantId,managerEmploymentId:manager.employmentId,subordinateEmploymentId:downline.employmentId,lineType:'administrative',validFrom:today},
    {tenantId:b.tenantId,managerEmploymentId:downline.employmentId,subordinateEmploymentId:subject.employmentId,lineType:'administrative',validFrom:today},
   ]);
  });
  expect((await attempted).error).toMatchObject({message:'MY_TEAM_NOT_AUTHORIZED'});
  expect((await resolveMyTeamScope(managerCtx,query)).employees.map(e=>e.employmentId)).toContain(subject.employmentId);
  expect((await resolveMyTeamScope(managerCtx,direct)).employees.map(e=>e.employmentId)).not.toContain(subject.employmentId);
  expect(await owner.db.select().from(schema.attendanceAttentionReview).where(eq(schema.attendanceAttentionReview.attendanceId,missing.attendanceId))).toEqual([]);
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
