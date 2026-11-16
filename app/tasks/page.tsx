import {resignationInbox} from '@/packs/lifecycle/resignation/service';
import {todayInKualaLumpur} from '@/lib/hr-date';
import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { pendingTaskSummary } from '@/core/approvals-inbox';
import { onboardingTasks } from '@/packs/lifecycle/service';
import {lifecycleModuleNavigation} from '../lifecycle/workflow-availability';
import {lifecycleModuleInbox} from '../lifecycle/module-inbox';
import { TasksView } from './tasks-view';
export default async function Page(){
 const {s,scopeIds}=await scopedSession();
 const modules={attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards'),
  // Probation (Lifecycle, possibly on for some companies only): its Approve steps and tasks are a shared task source.
  probation:isModuleEnabledOrFalse(s,'lifecycle')||!!s.entitlements?.scopedModules.lifecycle?.length};
 const [items,summary,navigation,resignations]=await Promise.all([
  isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),
  pendingTaskSummary(s,undefined,modules),lifecycleModuleNavigation(s),
  modules.probation?resignationInbox(s,{kind:'tasks',companyIds:scopeIds}):Promise.resolve({items:[],total:0}),
 ]);
 const lifecycle=await lifecycleModuleInbox(s,navigation);
 return <TasksView items={items} existing={summary.items} existingTotal={summary.total} claimTotal={summary.claimTotal} lifecycleTasks={lifecycle.items} lifecycleTotal={lifecycle.count} resignationTasks={resignations.items} resignationTotal={resignations.total} today={todayInKualaLumpur()} viewerId={s.userId??undefined}/>;
}
