/** Dated calendar assignment owns its history; calendar, Attendance and Payroll retain their calculations. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { attendance, employment, employmentHolidayCalendar, holidayGroup, replacementHoliday, toilAccrual } from '../db/schema';
import { isAdmin } from '../lib/authz-model';
import { todayInKualaLumpur } from '../lib/hr-date';
import { holidayDatesFor } from './holidays';
import { companySegmentsForPeriod } from './employment-company';
import { requirePackFor } from '../localization/registry';
import { reconcileReplacementHolidaysTx } from './holiday-replacements';
import { attendanceDayCalculationTx, lockOvertimeSubjectForAttendanceWriteTx, recomputeDayFigures, refreshOvertimePatternDayTx } from '../packs/attendance/service';
import { lockPayrollForHolidayCalendarTx, markPayrollForAttendanceChange } from '../packs/payroll/service';
import type { HolidayCalendarSelection } from './org';

export type HolidayCalendarErrorCode='dates'|'overlap'|'changed'|'scope'|'calendar'|'closedPayroll'|'credit'|'tooMany';
export class HolidayCalendarAssignmentError extends Error {
  constructor(readonly code:HolidayCalendarErrorCode){super(`Holiday calendar assignment: ${code}`);this.name='HolidayCalendarAssignmentError';}
}
const fail=(code:HolidayCalendarErrorCode):never=>{throw new HolidayCalendarAssignmentError(code);};
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const add=(value:string,days:number)=>{const iso=new Date(Date.parse(value+'T00:00:00Z')+days*86400000).toISOString();if(iso.length!==24)fail('dates');return iso.slice(0,10);};
export const holidayCalendarInclusiveEnd=(exclusive:string|null)=>exclusive?add(exclusive,-1):null;

export function employmentHolidayCalendarHistory(ctx:SessionContext,employmentId:string){
  if(!isAdmin(ctx))fail('scope');
  return withTenant(ctx,async tx=>{
    // The legacy helper's group-admin arm is company-scoped, not a tenant existence check.
    // Refuse a foreign/missing target explicitly rather than returning an apparently empty history.
    const [access]=await tx.execute(sql`select exists(select 1 from employment e where e.id=${employmentId}::uuid
      and e.tenant_id=${ctx.tenantId}::uuid and app.can_admin_employment(e.id)) as allowed`) as unknown as {allowed:boolean}[];
    if(!access?.allowed)fail('scope');
    const rows=await tx.select().from(employmentHolidayCalendar).where(eq(employmentHolidayCalendar.employmentId,employmentId))
      .orderBy(asc(employmentHolidayCalendar.validFrom),asc(employmentHolidayCalendar.recordedAt),asc(employmentHolidayCalendar.id)).limit(2001);
    if(rows.length>2000)fail('tooMany');return rows;
  });
}

export async function saveEmploymentHolidayCalendarAssignment(ctx:SessionContext,p:{
  employmentId:string;replacesId?:string|null;startDate:string;endDate?:string|null;selection:HolidayCalendarSelection;
}){
  if(!isAdmin(ctx))fail('scope');
  const recordedBy=ctx.userId;
  if(!recordedBy)throw new HolidayCalendarAssignmentError('scope');
  if(!validDate(p.startDate)||p.endDate&&(!validDate(p.endDate)||p.endDate<p.startDate))fail('dates');
  const validTo=p.endDate?add(p.endDate,1):null;
  if(!p.selection||!['none','state','group'].includes(p.selection.kind))fail('calendar');
  return withTenant(ctx,async tx=>{
    const [access]=await tx.execute(sql`select app.can_admin_employment(${p.employmentId}::uuid) as allowed`) as unknown as {allowed:boolean}[];
    if(!access?.allowed)fail('scope');
    // Same subject interlock as clocking, punch imports, corrections and the recompute owner.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);
    const [subject]=await tx.select().from(employment).where(eq(employment.id,p.employmentId)).for('update');
    if(!subject)fail('scope');
    if(p.startDate<subject.hiredOn||subject.terminatedOn&&(p.startDate>subject.terminatedOn||p.endDate&&p.endDate>subject.terminatedOn))fail('dates');
    const versions=await tx.select().from(employmentHolidayCalendar).where(eq(employmentHolidayCalendar.employmentId,p.employmentId)).orderBy(asc(employmentHolidayCalendar.validFrom),asc(employmentHolidayCalendar.id)).limit(2001);
    if(versions.length>=2000)fail('tooMany');
    const before=p.replacesId?versions.find(row=>row.id===p.replacesId&&!row.supersededAt):undefined;
    if(p.replacesId&&!before)fail('changed');
    if(versions.some(row=>!row.supersededAt&&row.id!==before?.id&&(!row.validTo||row.validTo>p.startDate)&&(!validTo||row.validFrom<validTo)))fail('overlap');
    const workState=p.selection.kind==='state'?p.selection.state?.trim()||null:null;
    const groupId=p.selection.kind==='group'?p.selection.groupId?.trim()||null:null;
    if(p.selection.kind==='state'&&!workState||p.selection.kind==='group'&&!groupId)fail('calendar');
    const today=todayInKualaLumpur();
    const from=[p.startDate,before?.validFrom].filter((date):date is string=>!!date).sort()[0];
    const sourceEnd=[p.endDate,before?.validTo?add(before.validTo,-1):null,`${Math.max(Number(today.slice(0,4)),Number(p.startDate.slice(0,4)))+1}-12-31`,p.startDate].filter((date):date is string=>!!date).sort().at(-1)!;
    if(groupId){
      const [group]=await tx.select().from(holidayGroup).where(eq(holidayGroup.id,groupId));
      const onlyShortening=before?.holidayGroupId===groupId&&p.startDate>=before.validFrom&&(!before.validTo||!!validTo&&validTo<=before.validTo);
      if(!group||!group.active&&!onlyShortening)fail('calendar');
    }
    if(workState){
      const companies=await companySegmentsForPeriod(tx,p.employmentId,p.startDate,p.endDate??sourceEnd);
      const [known]=await tx.execute(sql`select country from company where id=${subject.companyId}::uuid`) as unknown as {country:string}[];
      for(const segment of companies){
        const [company]=await tx.execute(sql`select country from company where id=${segment.companyId}::uuid`) as unknown as {country:string}[];
        if(!company||!requirePackFor(company.country).states?.includes(workState))fail('calendar');
      }
      if(!companies.length&&(!known||!requirePackFor(known.country).states?.includes(workState)))fail('calendar');
    }
    if(before&&before.validFrom===p.startDate&&before.validTo===validTo&&before.kind===p.selection.kind&&before.workState===workState&&before.holidayGroupId===groupId)
      return {id:before.id,updated:0,reviewDates:[] as string[],changed:false};
    await lockOvertimeSubjectForAttendanceWriteTx(tx,p.employmentId);
    const payroll=await lockPayrollForHolidayCalendarTx(tx,p.employmentId);
    const days=await tx.select().from(attendance).where(eq(attendance.employmentId,p.employmentId)).orderBy(asc(attendance.attendanceDate),asc(attendance.id)).limit(20001);
    const replacements=await tx.select().from(replacementHoliday).where(eq(replacementHoliday.employmentId,p.employmentId)).limit(20001);
    if(days.length>20000||replacements.length>20000)fail('tooMany');
    const readFrom=add(from,-366);
    const reconciliationEnd=[sourceEnd,...payroll.map(run=>run.end),...replacements.map(row=>row.sourceDate)].sort().at(-1)!;
    const to=[add(reconciliationEnd,366),...days.map(row=>row.attendanceDate),...replacements.flatMap(row=>[row.sourceDate,row.replacementDate].filter((date):date is string=>!!date))].sort().at(-1)!;
    if((Date.parse(to+'T00:00:00Z')-Date.parse(readFrom+'T00:00:00Z'))/86400000>36600)fail('tooMany');
    const oldDates=await holidayDatesFor(tx,{employmentId:p.employmentId,startDate:readFrom,endDate:to});
    if(before)await tx.update(employmentHolidayCalendar).set({supersededAt:new Date()}).where(eq(employmentHolidayCalendar.id,before.id));
    const [saved]=await tx.insert(employmentHolidayCalendar).values({tenantId:ctx.tenantId,employmentId:p.employmentId,
      validFrom:p.startDate,validTo,kind:p.selection.kind,workState,holidayGroupId:groupId,replacesId:before?.id??null,recordedBy}).returning();
    await reconcileReplacementHolidaysTx(tx,ctx,p.employmentId,{sourceWindow:{from:readFrom,to:reconciliationEnd}});
    const nextDates=await holidayDatesFor(tx,{employmentId:p.employmentId,startDate:readFrom,endDate:to});
    const changedDates=[...new Set([...oldDates,...nextDates])].filter(date=>oldDates.has(date)!==nextDates.has(date)).sort();
    const affected=payroll.filter(run=>changedDates.some(date=>date>=run.start&&date<=run.end));
    if(affected.some(run=>run.status==='closed'))fail('closedPayroll');
    const credits=await tx.select({date:toilAccrual.workedDate}).from(toilAccrual).where(and(eq(toilAccrual.employmentId,p.employmentId),sql`${toilAccrual.status}<>'reversed'`));
    if(credits.some(row=>changedDates.includes(row.date)))fail('credit');
    let updated=0;const reviewDates:string[]=[];
    for(const day of days.filter(day=>changedDates.includes(day.attendanceDate))){
      if(!day.checkInAt||!day.checkOutAt||day.status==='absent'){reviewDates.push(day.attendanceDate);continue;}
      const approved=await attendanceDayCalculationTx(tx,p.employmentId,day.attendanceDate);
      const result=await recomputeDayFigures(tx,{employmentId:p.employmentId,date:day.attendanceDate,checkInAt:day.checkInAt,checkOutAt:day.checkOutAt,approvedOtMinutes:approved.approvedOtMinutes});
      await tx.update(attendance).set(result.columns).where(eq(attendance.id,day.id));
      await refreshOvertimePatternDayTx(tx,ctx,{employmentId:p.employmentId,date:day.attendanceDate,reason:'Dated holiday calendar assignment'});
      await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance',aggregateId:day.id,eventType:'attendance.calendar-recomputed',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{calendarAssignmentId:saved.id,date:day.attendanceDate,before:{dayType:day.dayType,workedMinutes:day.workedMinutes,otMinutes:day.otMinutes},after:result.columns}});updated++;
    }
    await markPayrollForAttendanceChange(tx,ctx,affected,p.employmentId);
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:p.employmentId,eventType:'employment.holiday-calendar.assignment-recorded',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
      payload:{assignmentId:saved.id,replacesId:before?.id??null,before:before?{validFrom:before.validFrom,validTo:before.validTo,kind:before.kind,workState:before.workState,holidayGroupId:before.holidayGroupId}:null,after:{validFrom:p.startDate,validTo,kind:p.selection.kind,workState,holidayGroupId:groupId},changedDates,recomputed:updated,reviewDates}});
    return {id:saved.id,updated,reviewDates,changed:true};
  });
}
