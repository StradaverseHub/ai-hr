/** Own calendar metadata. No attendance pricing rows, private leave reasons, payroll amounts or
 * peer records are fetched. Each fact retains its existing module owner. Team sharing is separate. */
import {withTenant,type SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {listEligibleLeaveTypesFor,myOwnEmploymentSubjects} from './read';
import {listEmployeeHomeCards} from './dashboard-card-config';
import {getEmployeeHomePreferences} from './dashboard-prefs';
import {homeDisplayClock} from '../lib/employee-home';
import {homeCalendarGrid,type EmployeeHomeCalendar,type HomeCalendarEntry} from '../lib/employee-home-calendar';
import {leaveCalendarPresenceByEmploymentTx} from '../packs/leave/service';
import {readOwnPayrollCalendarPayments} from '../packs/payroll/service';
import {isModuleEnabled} from './entitlements';
import {originalHolidayCalendarFor} from './holidays';
import {replacementHolidayCalendarProjectionsTx} from './holiday-replacement-read';
import {provenCompanyDatesTx} from './employment-company';

export async function readEmployeeHomeCalendar(ctx:SessionContext,employmentId:string,requestedMonth?:string,now=new Date()):Promise<EmployeeHomeCalendar>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 const preferences=await listEmployeeHomeCards(ctx).then(cards=>getEmployeeHomePreferences(ctx,cards));
 const display=homeDisplayClock(now,preferences.timeZone??'Asia/Kuala_Lumpur');
 const month=requestedMonth??display.date.slice(0,7),dates=homeCalendarGrid(month,preferences.weekStartsOn);
 const from=dates[0],to=dates[dates.length-1];
 const payrollEnabled=isModuleEnabled(ctx,'payroll');
 const [facts,paymentDates,eligible,active]=await Promise.all([
  withTenant(ctx,async tx=>{
   const [leave,holidays,replacements,coverage]=await Promise.all([
    leaveCalendarPresenceByEmploymentTx(tx,[subject.employmentId],from,to),
    originalHolidayCalendarFor(tx,{employmentId:subject.employmentId,startDate:from,endDate:to}),
    replacementHolidayCalendarProjectionsTx(tx,{employmentIds:[subject.employmentId],startDate:from,endDate:to}),
    provenCompanyDatesTx(tx,dates.map(date=>({employmentId:subject.employmentId,date}))),
   ]);
   return {leave,holidays,replacements,coverage};
  }),
  payrollEnabled?readOwnPayrollCalendarPayments(ctx,subject.employmentId,from,to):Promise.resolve([]),
  listEligibleLeaveTypesFor(ctx,subject.employmentId),myOwnEmploymentSubjects(ctx,{profileEdit:true}),
 ]);
 const canApply=active.some(row=>row.employmentId===subject.employmentId)&&eligible.length>0;
 const payments=new Set(paymentDates);
 return {version:1,employmentId:subject.employmentId,month,today:display.date,weekStartsOn:preferences.weekStartsOn,payrollEnabled,
  days:dates.map(date=>{
   const entries:HomeCalendarEntry[]=[];
   for(const status of ['approved','pending'] as const){
    const duration=facts.leave[status].get(subject.employmentId)?.get(date);
    if(duration)entries.push({kind:'leave',date,status,duration});
   }
   for(const holiday of facts.holidays)if(holiday.date===date)entries.push({kind:'holiday',date,name:holiday.name,replacement:false,tentative:holiday.tentative});
   if(facts.replacements.some(row=>row.replacementDate===date))entries.push({kind:'holiday',date,name:null,replacement:true,tentative:false});
   if(payments.has(date))entries.push({kind:'payday',date});
   const proof=facts.coverage.get(subject.employmentId+'|'+date);
   // This opens the existing form; only its owner can decide date/notice/blackout policy. In
   // particular, Home must not override a company's configurable backdated-leave permission.
   return {date,entries,canRequestLeave:canApply&&Boolean(proof?.companyId&&!proof.reason)&&!entries.some(entry=>entry.kind==='leave')};
  })};
}
