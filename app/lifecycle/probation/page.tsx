import {Suspense} from 'react';
import {getTranslations} from 'next-intl/server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {probationPersonnelDiscrepancies,probationSummaryRows,probationTrackerWorkingDays,canConfigureProbationWorkflows,probationRequiredWorkflowStatus} from '@/packs/probation/service';
import {WorkingDaysOverdue} from './working-days-overdue';
import {trackerFilters} from './tracker-filters';
import {ProbationTracker} from './tracker';
import {WorkflowReadiness} from './workflow-readiness';
import './tracker-parity.css';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule(),params=await searchParams,filters=trackerFilters(params);
 const [data,configure,t,reconciliation]=await Promise.all([probationSummaryRows(session,filters),canConfigureProbationWorkflows(session),getTranslations('probation'),probationPersonnelDiscrepancies(session,{companyId:filters.companyId,offset:Number(params.intakeOffset??0)})]);
 const companies=[...new Set(filters.companyId?[filters.companyId]:data.rows.map(row=>row.companyId))];
 const statuses=await Promise.all(companies.map(async id=>({id,status:await probationRequiredWorkflowStatus(session,id)})));
 // Working days overdue stream in after the list: one holiday resolution per company calendar on the page. Until they
 // arrive (or when the holiday read fails) the row shows the calendar days the list already counted.
 const workingDays=probationTrackerWorkingDays(session,data.rows).catch(()=>null);
 const overdue=Object.fromEntries(data.rows.flatMap(row=>row.parts).filter(part=>part.type===1&&part.calendarDaysOverdue!==undefined).map(part=>[part.id,<Suspense key={part.id} fallback={t('tracker.calendarOverdue',{days:part.calendarDaysOverdue!})}><WorkingDaysOverdue days={workingDays} partId={part.id} calendarDays={part.calendarDaysOverdue!}/></Suspense>]));
 return <ProbationTracker data={data} filters={filters} configure={configure} reconciliation={reconciliation} overdue={overdue} today={todayInKualaLumpur()} warning={<WorkflowReadiness companies={statuses}/>}/>;
}
