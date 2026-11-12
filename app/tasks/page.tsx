import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { myTaskSummary } from '@/core/approvals-inbox';
import { onboardingTasks } from '@/packs/lifecycle/service';
import {lifecycleModuleNavigation} from '../lifecycle/workflow-availability';
import {lifecycleModuleInbox} from '../lifecycle/module-inbox';
import { TasksView } from './tasks-view';
// Recruitment slice 9 (D-034): My tasks lists the recruitment to-dos for the same company selection as the bell, whose
// count is this page's sidebar badge (core/approvals-inbox.ts myTaskSummary, the summary form of listMyTasks).
export default async function Page(){
 const {s,scopeIds}=await scopedSession();
 const modules={attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards'),recruitment:isModuleEnabledOrFalse(s,'recruitment')};
 const [items,summary,navigation]=await Promise.all([
  isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),
  myTaskSummary(s,scopeIds,modules),lifecycleModuleNavigation(s),
 ]);
 const lifecycle=await lifecycleModuleInbox(s,navigation);
 return <TasksView items={items} existing={summary.items} existingTotal={summary.total} claimTotal={summary.claimTotal} lifecycleTasks={lifecycle.items} lifecycleTotal={lifecycle.count}/>;
}
