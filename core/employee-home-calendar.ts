/** Own calendar metadata plus the separate, purpose-bound shared-team projection. No attendance
 * pricing, private leave reasons or payroll amounts are fetched. Every fact retains its owner. */
import {withTenant,type SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {isOwnProfileEditEmploymentTx,listEligibleLeaveTypesFor} from './read';
import {getEmployeeHomeDisplayPreferences} from './dashboard-prefs';
import {homeDisplayClock} from '../lib/employee-home';
import {homeCalendarGrid,type EmployeeHomeCalendar,type HomeCalendarEntry} from '../lib/employee-home-calendar';
import {leaveCalendarPresenceByEmploymentTx} from '../packs/leave/service';
import {readOwnPayrollCalendarPayments} from '../packs/payroll/service';
import {isModuleEnabled} from './entitlements';
import {originalHolidayCalendarFor} from './holidays';
import {replacementHolidayCalendarProjectionsTx} from './holiday-replacement-read';
import {provenCompanyDatesTx} from './employment-company';
import {readHomeTeamCalendar} from './employee-home-sharing';

export async function readEmployeeHomeCalendar(ctx:SessionContext,employmentId:string,requestedMonth?:string,now=new Date()):Promise<EmployeeHomeCalendar>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 const preferences=await getEmployeeHomeDisplayPreferences(ctx);
 const display=homeDisplayClock(now,preferences.timeZone??'Asia/Kuala_Lumpur');
 const month=requestedMonth??display.date.slice(0,7),dates=homeCalendarGrid(month,preferences.weekStartsOn);
 const from=dates[0],to=dates[dates.length-1];
 const payrollEnabled=isModuleEnabled(ctx,'payroll');
 const [facts,paymentDates,team]=await Promise.all([
  withTenant(ctx,async tx=>{
   const [leave,holidays,replacements,coverage,eligible,active]=await Promise.all([
    leaveCalendarPresenceByEmploymentTx(tx,[subject.employmentId],from,to),
    originalHolidayCalendarFor(tx,{employmentId:subject.employmentId,startDate:from,endDate:to}),
    replacementHolidayCalendarProjectionsTx(tx,{employmentIds:[subject.employmentId],startDate:from,endDate:to}),
    provenCompanyDatesTx(tx,dates.map(date=>({employmentId:subject.employmentId,date}))),
    listEligibleLeaveTypesFor(ctx,subject.employmentId,undefined,tx),
    isOwnProfileEditEmploymentTx(tx,ctx,subject.employmentId),
   ]);
   return {leave,holidays,replacements,coverage,eligible,active};
  }),
  payrollEnabled?readOwnPayrollCalendarPayments(ctx,subject.employmentId,from,to):Promise.resolve([]),
  readHomeTeamCalendar(ctx,subject.employmentId,from,to),
 ]);
 const canApply=facts.active&&facts.eligible.length>0;
 const payments=new Set(paymentDates);
 return {version:1,employmentId:subject.employmentId,month,today:display.date,weekStartsOn:preferences.weekStartsOn,payrollEnabled,team,
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
