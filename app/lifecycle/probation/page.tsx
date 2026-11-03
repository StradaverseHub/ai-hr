import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {probationSummaryRows,canConfigureProbationWorkflows,probationRequiredWorkflowStatus} from '@/packs/probation/service';
import {trackerFilters} from './tracker-filters';
import {ProbationTracker} from './tracker';
import {WorkflowReadiness} from './workflow-readiness';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireScopedLifecycleModule(),filters=trackerFilters(await searchParams);
 const [data,configure]=await Promise.all([probationSummaryRows(session,filters),canConfigureProbationWorkflows(session)]);
 const companies=[...new Set(filters.companyId?[filters.companyId]:data.rows.map(row=>row.companyId))];
 const statuses=await Promise.all(companies.map(async id=>({id,status:await probationRequiredWorkflowStatus(session,id)})));
 return <ProbationTracker data={data} filters={filters} configure={configure} warning={<WorkflowReadiness companies={statuses}/>}/>;
}
