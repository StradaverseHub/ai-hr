/** Bounded, authorised inputs for the allowance engine. The attendance resolver owns day/shift identity. */
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { assignment, attendance, department, employment, person } from '../db/schema';
import { allowanceScheduleFactsTx, newScheduleMemo } from '../packs/attendance/service';
import { companySegmentsForPeriodBulk, employedByCompanyDuring } from './employment-company';
import { datesBetween } from '../lib/roster-month';
import { absenceBreakdownByEmployment } from './absence-days';
import { approvedLeaveMeasurementsTx } from '../packs/leave/service';
import type { AllowanceDay, AllowanceEmployeeFacts } from '../lib/attendance-allowance-rules';
export async function allowanceInputsTx(tx:Tx,companyId:string,from:string,to:string,today:string,version:2|3=2){
  const employees=await tx.select({id:employment.id,name:person.fullName,companyId:employment.companyId,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn,gradeId:employment.gradeId,employmentCategory:employment.employmentCategory,allowed:sql<boolean>`app.can_admin_employment(${employment.id})`})
    .from(employment).innerJoin(person,eq(person.id,employment.personId)).where(and(employedByCompanyDuring(companyId,from,to),lte(employment.hiredOn,to),or(isNull(employment.terminatedOn),gte(employment.terminatedOn,from)))).orderBy(asc(employment.id));
  // A payroll calculation must not silently turn a hidden subordinate into an eligible recipient.
  if(employees.some(e=>!e.allowed)) throw new Error('Allowance preview requires administrative access to every selected employee');
  if(employees.length>2000)throw new Error('Allowance calculations support at most 2,000 employees per company; narrow the policy company before transferring');
  const ids=employees.map(e=>e.id);
  if(!ids.length)return [];
  const [records,assignments,segments,memo]=await Promise.all([
    tx.select().from(attendance).where(and(inArray(attendance.employmentId,ids),gte(attendance.attendanceDate,from),lte(attendance.attendanceDate,to))).orderBy(asc(attendance.employmentId),asc(attendance.attendanceDate)),
    tx.select({employmentId:assignment.employmentId,companyId:assignment.companyId,departmentId:assignment.departmentId,businessUnitId:assignment.businessUnitId,departmentBusinessUnitId:department.businessUnitId,positionId:assignment.positionId,employmentType:assignment.employmentType,validFrom:assignment.validFrom,validTo:assignment.validTo})
      .from(assignment).leftJoin(department,eq(department.id,assignment.departmentId)).where(and(inArray(assignment.employmentId,ids),isNull(assignment.supersededAt),lte(assignment.validFrom,to),or(isNull(assignment.validTo),gte(assignment.validTo,from)))).orderBy(asc(assignment.employmentId),asc(assignment.validFrom)),
    companySegmentsForPeriodBulk(tx,ids,from,to,new Map(employees.map(e=>[e.id,e.companyId]))),
    newScheduleMemo(tx,{employmentIds:ids,from,to}),
  ]);
  // V2 explicitly opts into the canonical scheduled absence semantics. Do not infer leave from
  // request spans: the owner resolves per-date approvals, partial leave, calendar, roster and tenure.
  // Per-date reads are bounded to the period window; a shared date-map seam can optimize this later.
  const absenceByDay=new Map<string,Map<string,{absentDays:number;leaveDays:number}>>();
  for(const date of datesBetween(from,to)){
    if(date<=today)absenceByDay.set(date,await absenceBreakdownByEmployment(tx,date,date,ids,{rules:'scheduled',until:today}));
  }
  const leave=version===3?await approvedLeaveMeasurementsTx(tx,{employmentIds:ids,from,to,today}):null;
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
      const schedule=await allowanceScheduleFactsTx(tx,employee.id,date,memo,version===3?{includeApplicability:true}:undefined);
      const row=recordByDay.get(`${employee.id}:${date}`);
      // The three-way day type is frozen on recorded attendance. Never relabel a recorded holiday or
      // rest day as work merely because the calendar was edited. Full/half/off and shift applicability use
      // the canonical dated resolver; old traces contain no shift identity and are not reconstructed.
      // Off-day work is deliberately stored as workday for ordinary-overtime pricing. Its canonical
      // off marker must survive here; source='default-shift-rest' is shared by both Off and Rest.
      const kind = row?.dayType==='holiday' ? 'holiday' : row?.dayType==='rest_day'
        ? 'rest' : row?.dayType==='workday'
        ? (schedule.kind==='half'||schedule.kind==='off'?schedule.kind:'full') : schedule.kind;
      const working=kind==='full'||kind==='half';
      const absentDays=absenceByDay.get(date)?.get(employee.id)?.absentDays??0;
      const attended=!!row&&row.status!=='absent';
      const worked=attended?(row?.workedMinutes??null):0,ot=attended?(row?.otMinutes??null):0;
      const day:AllowanceDay={date,attendanceId:row?.id??null,kind,shiftId:schedule.shiftId,
        factSources:{measurements:row?'recorded-attendance':'canonical-scheduled-absence',recordedDayType:row?.dayType??null,dayAndShift:'canonical-schedule-at-calculation',canonicalKind:schedule.kind},
        workingMinutes:worked,actualMinutes:worked==null||ot==null?null:Math.max(0,worked-ot),overtimeMinutes:ot,
        lateMinutes:attended&&row?(row.lateMinutes??(kind==='rest'||kind==='off'||kind==='holiday'?0:null)):0,
        earlyOutMinutes:attended&&row?(row.earlyOutMinutes??(kind==='rest'||kind==='off'||kind==='holiday'?0:null)):0,
        absentDays,attendanceDays:attended?1:0,eligibleWorkingDays:working?1:0,
        complete:date<=today&&(!attended||(row.checkInAt!=null&&row.checkOutAt!=null&&row.workedMinutes!=null&&row.otMinutes!=null))};
      days.push(day);
      if(version===3){
       const approved=leave?.get(employee.id+':'+date);
       day.v3Facts={shortMinutes:attended?(day.complete?working?row?.underMinutes??null:0:null):0,incomplete:attended&&!day.complete,fixedClockApplicable:schedule.fixedClockApplicable??true,leave:approved?approved.leave:[],leaveTypesPresent:approved?.types??[],source:approved?.source??'canonical-approved-leave-empty'};
      }
    }
    result.push({employmentId:employee.id,name:employee.name,days,factsByDate});
  }
  return result;
}
