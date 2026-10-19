/** Import-safe acceptance date boundary. Historical fixture facts never become today's facts. */
import {z} from 'zod';
import {isCalendarDate} from '../lib/calendar-date';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeMasterSpec} from '../lib/employee-master-report';
import {RESIDUAL_DATE} from './managed-report-residual';
export type ReportExecutionDay=Readonly<{fixtureDay:string;executionDay:string;capturedInstant:string}>;
/** Written privately by the finite root publisher before its marker-last publication. */
export const residualExecutionPublication=z.object({
 candidateSha:z.string().regex(/^[a-f0-9]{40}$/),runId:z.uuid(),fixtureDay:z.literal(RESIDUAL_DATE),
 executionDay:z.string().refine(isCalendarDate),capturedInstant:z.iso.datetime().refine(value=>Number.isFinite(new Date(value).getTime())),
}).strict();
/** The publication chooses an expected day, never a clock override for this entry. */
export function assertResidualExecutionPublication(value:unknown,expected:{candidateSha:string;runId:string},execution:ReportExecutionDay):void{
 const publication=residualExecutionPublication.parse(value),publishedAt=new Date(publication.capturedInstant);
 if(publication.candidateSha!==expected.candidateSha||publication.runId!==expected.runId||publication.fixtureDay!==execution.fixtureDay||publication.executionDay!==execution.executionDay||todayInKualaLumpur(publishedAt)!==publication.executionDay||publishedAt.getTime()>new Date(execution.capturedInstant).getTime())throw new Error('Residual execution publication differs from the actual entry capture.');
}
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
