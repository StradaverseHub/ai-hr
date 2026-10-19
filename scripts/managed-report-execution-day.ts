/** Import-safe acceptance date boundary. Historical fixture facts never become today's facts. */
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeMasterSpec} from '../lib/employee-master-report';
import {RESIDUAL_DATE} from './managed-report-residual';
export type ReportExecutionDay=Readonly<{fixtureDay:string;executionDay:string;capturedInstant:string}>;
export function captureReportExecutionDay(mode:'configure'|'verify'|'verify-residual',fixtureDay:string,now:Date=new Date()):ReportExecutionDay{
 if(!isCalendarDate(fixtureDay)||!Number.isFinite(now.getTime()))throw new Error('Invalid report execution date.');
 const executionDay=todayInKualaLumpur(now);
 if(mode==='verify-residual'){
  if(fixtureDay!==RESIDUAL_DATE||executionDay<fixtureDay)throw new Error('Residual historical fixture day differs.');
 }else if(fixtureDay!==executionDay)throw new Error('KL date changed; preserve this journey rather than reseeding.');
 return Object.freeze({fixtureDay,executionDay,capturedInstant:now.toISOString()});
}
export function assertReportExecutionDay(day:ReportExecutionDay,now:Date=new Date()):void{
 if(!Number.isFinite(now.getTime())||todayInKualaLumpur(now)!==day.executionDay)throw new Error('KL execution day changed; preserve this residual attempt and allow owned cleanup.');
}
/** Only a NEW report copy receives the execution day; the saved template remains historical. */
export function residualReportExecutionSpec(template:EmployeeMasterSpec,day:ReportExecutionDay,now:Date=new Date()):EmployeeMasterSpec{
 assertReportExecutionDay(day,now);
 return {...template,asAt:day.executionDay};
}
