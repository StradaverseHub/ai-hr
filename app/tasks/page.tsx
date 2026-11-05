import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { pendingTaskSummary } from '@/core/approvals-inbox';
import { onboardingTasks } from '@/packs/lifecycle/service';
import {lifecycleModuleNavigation} from '../lifecycle/workflow-availability';
import {lifecycleModuleInbox} from '../lifecycle/module-inbox';
import { TasksView } from './tasks-view';
export default async function Page(){
 const {s}=await scopedSession();
 const modules={attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards')};
 const [items,summary,navigation]=await Promise.all([
  isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),
  pendingTaskSummary(s,undefined,modules),lifecycleModuleNavigation(s),
 ]);
 const lifecycle=await lifecycleModuleInbox(s,navigation);
 return <TasksView items={items} existing={summary.items} existingTotal={summary.total} claimTotal={summary.claimTotal} lifecycleTasks={lifecycle.items} lifecycleTotal={lifecycle.count}/>;
}
