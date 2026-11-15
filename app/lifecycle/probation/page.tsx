import {Suspense} from 'react';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationSummaryRows,probationTrackerWorkingDays,canConfigureProbationWorkflows,probationRequiredWorkflowStatus} from '@/packs/probation/service';
import {WorkingDaysOverdue} from './working-days-overdue';
import {trackerFilters} from './tracker-filters';
import {ProbationTracker} from './tracker';
import {WorkflowReadiness} from './workflow-readiness';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule(),filters=trackerFilters(await searchParams);
 const [data,configure]=await Promise.all([probationSummaryRows(session,filters),canConfigureProbationWorkflows(session)]);
 const companies=[...new Set(filters.companyId?[filters.companyId]:data.rows.map(row=>row.companyId))];
 const statuses=await Promise.all(companies.map(async id=>({id,status:await probationRequiredWorkflowStatus(session,id)})));
 // Working days overdue stream in after the list: one holiday resolution per company calendar on the page.
 const workingDays=probationTrackerWorkingDays(session,data.rows).catch(()=>null);
 const overdue=Object.fromEntries(data.rows.flatMap(row=>row.parts).filter(part=>part.type===1&&part.calendarDaysOverdue!==undefined).map(part=>[part.id,<Suspense key={part.id} fallback={null}><WorkingDaysOverdue days={workingDays} partId={part.id} calendarDays={part.calendarDaysOverdue!}/></Suspense>]));
 return <ProbationTracker data={data} filters={filters} configure={configure} overdue={overdue} warning={<WorkflowReadiness companies={statuses}/>}/>;
}
