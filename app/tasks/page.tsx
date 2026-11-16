import {Pager} from '@/components/pager';
import {parsePageQuery,pageState} from '@/lib/pagination';
import {todayInKualaLumpur} from '@/lib/hr-date';
import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { pendingTaskSummary } from '@/core/approvals-inbox';
import { onboardingTasks,resignationInbox } from '@/packs/lifecycle/service';
import {lifecycleModuleNavigation} from '../lifecycle/workflow-availability';
import {lifecycleModuleInbox} from '../lifecycle/module-inbox';
import { TasksView } from './tasks-view';
export default async function Page({searchParams}:{searchParams?:Promise<{resignationPage?:string;resignationSize?:string;taskView?:string}>}={}){
 const query=await searchParams??{},resignationQuery=parsePageQuery({page:query.resignationPage,size:['200','all'].includes(query.resignationSize??'')?'100':query.resignationSize}),taskView=['all','assigned','tagged','team','overdue'].includes(query.taskView??'')?query.taskView!:'all';
 const {s,scopeIds}=await scopedSession();
 const modules={attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards'),
  // Probation (Lifecycle, possibly on for some companies only): its Approve steps and tasks are a shared task source.
  probation:isModuleEnabledOrFalse(s,'lifecycle')||!!s.entitlements?.scopedModules.lifecycle?.length};
 const [items,summary,navigation,resignations]=await Promise.all([
  isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),
  pendingTaskSummary(s,undefined,modules),lifecycleModuleNavigation(s),
  modules.probation?resignationInbox(s,{kind:'tasks',companyIds:scopeIds,limit:resignationQuery.limit,offset:resignationQuery.offset,filter:taskView as 'all'|'assigned'|'tagged'|'team'|'overdue'}):Promise.resolve({items:[],total:0,counts:{all:0,assigned:0,tagged:0,team:0,overdue:0}}),
 ]);
 const lifecycle=await lifecycleModuleInbox(s,navigation);
 return <TasksView items={items} existing={summary.items} existingTotal={summary.total} claimTotal={summary.claimTotal} lifecycleTasks={lifecycle.items} lifecycleTotal={lifecycle.count} resignationTasks={resignations.items} resignationTotal={resignations.total} resignationCounts={resignations.counts} initialFilter={taskView} resignationPager={<Pager maxPageSize={100} state={pageState(resignationQuery,resignations.total,resignations.items.length)} basePath="/tasks" params={{taskView}} paramNames={{page:"resignationPage",size:"resignationSize"}}/>} today={todayInKualaLumpur()} viewerId={s.userId??undefined}/>;
}
