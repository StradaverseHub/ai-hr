import {requireModule} from '@/lib/authz';
import {probationSummaryRows,canConfigureProbationWorkflows} from '@/packs/probation/service';
import {trackerFilters} from './tracker-filters';
import {ProbationTracker} from './tracker';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireModule('lifecycle'),filters=trackerFilters(await searchParams);
 const [data,configure]=await Promise.all([probationSummaryRows(session,filters),canConfigureProbationWorkflows(session)]);
 return <ProbationTracker data={data} filters={filters} configure={configure}/>;
}
