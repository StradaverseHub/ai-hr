/** Bounded, authorised inputs for the allowance engine. The attendance resolver owns day/shift identity. */
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { assignment, attendance, department, employment, leaveRequest, person } from '../db/schema';
import { allowanceScheduleFactsTx, newScheduleMemo } from '../packs/attendance/service';
import { companySegmentsForPeriodBulk, employedByCompanyDuring } from './employment-company';
import { datesBetween } from '../lib/roster-month';
import type { AllowanceDay, AllowanceEmployeeFacts } from '../lib/attendance-allowance-rules';
export async function allowanceInputsTx(tx:Tx,companyId:string,from:string,to:string,today:string){
  const employees=await tx.select({id:employment.id,name:person.fullName,companyId:employment.companyId,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn,gradeId:employment.gradeId,employmentCategory:employment.employmentCategory,allowed:sql<boolean>`app.can_admin_employment(${employment.id})`})
    .from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(employedByCompanyDuring(companyId,from,to),lte(employment.hiredOn,to),or(isNull(employment.terminatedOn),gte(employment.terminatedOn,from)))).orderBy(asc(employment.id));
  // A payroll calculation must not silently turn a hidden subordinate into an eligible recipient.
  if(employees.some(e=>!e.allowed)) throw new Error('Allowance preview requires administrative access to every selected employee');
  if(employees.length>2000)throw new Error('Allowance calculations support at most 2,000 employees per company; narrow the policy company before transferring');
  const ids=employees.map(e=>e.id);
  if(!ids.length)return [];
  const [records,assignments,leaves,segments,memo]=await Promise.all([
    tx.select().from(attendance).where(and(inArray(attendance.employmentId,ids),gte(attendance.attendanceDate,from),lte(attendance.attendanceDate,to))).orderBy(asc(attendance.employmentId),asc(attendance.attendanceDate)),
    tx.select({employmentId:assignment.employmentId,companyId:assignment.companyId,departmentId:assignment.departmentId,businessUnitId:assignment.businessUnitId,departmentBusinessUnitId:department.businessUnitId,positionId:assignment.positionId,employmentType:assignment.employmentType,validFrom:assignment.validFrom,validTo:assignment.validTo})
      .from(assignment).leftJoin(department,eq(department.id,assignment.departmentId)).where(and(inArray(assignment.employmentId,ids),isNull(assignment.supersededAt),lte(assignment.validFrom,to),or(isNull(assignment.validTo),gte(assignment.validTo,from)))).orderBy(asc(assignment.employmentId),asc(assignment.validFrom)),
    tx.select({employmentId:leaveRequest.employmentId,from:leaveRequest.startDate,to:leaveRequest.endDate}).from(leaveRequest).where(and(inArray(leaveRequest.employmentId,ids),eq(leaveRequest.status,'approved'),lte(leaveRequest.startDate,to),gte(leaveRequest.endDate,from))),
    companySegmentsForPeriodBulk(tx,ids,from,to,new Map(employees.map(e=>[e.id,e.companyId]))),
    newScheduleMemo(tx,{employmentIds:ids,from,to}),
  ]);
  const recordByDay=new Map(records.map(r=>[`${r.employmentId}:${r.attendanceDate}`,r]));
  const result=[];
  for(const employee of employees){
    const days:AllowanceDay[]=[];
    const factsByDate=new Map<string,AllowanceEmployeeFacts>();
    for(const date of datesBetween(from,to)){
      if(date<employee.hiredOn||(employee.terminatedOn&&date>employee.terminatedOn))continue;
      if(!(segments.get(employee.id)??[]).some(s=>s.companyId===companyId&&s.from<=date&&s.to>=date))continue;
      const placement=assignments.find(a=>a.employmentId===employee.id&&a.validFrom<=date&&(!a.validTo||a.validTo>date));
      factsByDate.set(date,{companyId,departmentId:placement?.departmentId??null,businessUnitId:placement?.businessUnitId??placement?.departmentBusinessUnitId??null,positionId:placement?.positionId??null,gradeId:employee.gradeId,employmentType:placement?.employmentType??null,employmentCategory:employee.employmentCategory,status:employee.terminatedOn&&employee.terminatedOn<=date?'terminated':'active'});
      const schedule=await allowanceScheduleFactsTx(tx,employee.id,date,memo);
      const row=recordByDay.get(`${employee.id}:${date}`);
      const leave=leaves.some(l=>l.employmentId===employee.id&&l.from<=date&&l.to>=date);
      // The three-way day type is frozen on recorded attendance. Never relabel a recorded holiday or
      // rest day as work merely because the calendar was edited. Full/half and shift applicability use
      // the canonical dated resolver; old traces contain no shift identity and are not reconstructed.
      const kind = row?.dayType==='holiday' ? 'holiday' : row?.dayType==='rest_day'
        ? (row.calcTrace?.schedule.source==='default-shift-rest' ? 'off' : 'rest')
        : row?.dayType==='workday' && schedule.kind!=='half' ? 'full' : schedule.kind;
      const working=kind==='full'||kind==='half';
      const absent=working&&!leave&&(!row||row.status==='absent');
      const attended=!!row&&row.status!=='absent';
      const worked=attended?(row?.workedMinutes??null):0,ot=attended?(row?.otMinutes??null):0;
      days.push({date,attendanceId:row?.id??null,kind,shiftId:schedule.shiftId,
        workingMinutes:worked,actualMinutes:worked==null||ot==null?null:Math.max(0,worked-ot),overtimeMinutes:ot,
        lateMinutes:attended&&row?(row.lateMinutes??(kind==='rest'||kind==='off'||kind==='holiday'?0:null)):0,
        earlyOutMinutes:attended&&row?(row.earlyOutMinutes??(kind==='rest'||kind==='off'||kind==='holiday'?0:null)):0,
        absentDays:absent?1:0,attendanceDays:attended?1:0,eligibleWorkingDays:working?1:0,
        complete:date<=today&&(!attended||(row.checkInAt!=null&&row.checkOutAt!=null&&row.workedMinutes!=null&&row.otMinutes!=null))});
    }
    result.push({employmentId:employee.id,name:employee.name,days,factsByDate});
  }
  return result;
}
