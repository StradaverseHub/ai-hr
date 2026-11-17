import {Pager} from '@/components/pager';
import {parsePageQuery,pageState} from '@/lib/pagination';
import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { pendingTaskSummary } from '@/core/approvals-inbox';
import { onboardingTasks } from '@/packs/lifecycle/service';
import {lifecycleModuleNavigation} from '../lifecycle/workflow-availability';
import {lifecycleModuleInbox} from '../lifecycle/module-inbox';
import {contractSharedWorkPage} from '@/packs/contracts/service';
import {ContractWorkSection} from '@/app/lifecycle/contracts/work-section';
import { TasksView } from './tasks-view';
export default async function Page({searchParams}:{searchParams?:Promise<{contractPage?:string;contractSize?:string}>}={}){
 const query=await searchParams??{};
 const contractQuery=parsePageQuery({page:query.contractPage,size:['200','all'].includes(query.contractSize??'')?'100':query.contractSize});
 const {s}=await scopedSession();
 const modules={attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards'),
  // Probation (Lifecycle, possibly on for some companies only): its Approve steps and tasks are a shared task source.
  probation:isModuleEnabledOrFalse(s,'lifecycle')||!!s.entitlements?.scopedModules.lifecycle?.length};
 const [items,summary,navigation,contracts]=await Promise.all([
  isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),
  pendingTaskSummary(s,undefined,modules),lifecycleModuleNavigation(s),
  modules.probation?contractSharedWorkPage(s,{category:'tasks',limit:contractQuery.limit,offset:contractQuery.offset}):Promise.resolve({items:[],total:0}),
 ]);
 const lifecycle=await lifecycleModuleInbox(s,navigation,{includeShared:false});
 return <TasksView items={items} existing={summary.items} existingTotal={summary.total} claimTotal={summary.claimTotal} lifecycleTasks={lifecycle.items} lifecycleTotal={lifecycle.count} contractTotal={contracts.total} contractSection={<ContractWorkSection items={contracts.items} total={contracts.total} pager={<Pager maxPageSize={100} state={pageState(contractQuery,contracts.total,contracts.items.length)} basePath="/tasks" params={{}} paramNames={{page:"contractPage",size:"contractSize"}}/>}/>}/>;
}
