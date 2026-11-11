import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { listMyTasks } from '@/core/approvals-inbox';
import { onboardingTasks } from '@/packs/lifecycle/service';
import {lifecycleModuleNavigation} from '../lifecycle/workflow-availability';
import {lifecycleModuleInbox} from '../lifecycle/module-inbox';
import { TasksView } from './tasks-view';
// Recruitment slice 9 (D-034): My tasks lists the recruitment to-dos for the same company selection as the bell, whose
// count is this page's sidebar badge (core/approvals-inbox.ts listMyTasks).
export default async function Page(){const {s,scopeIds}=await scopedSession();const [items,existing]=await Promise.all([isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),listMyTasks(s,scopeIds,{attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards'),recruitment:isModuleEnabledOrFalse(s,'recruitment')})]);const lifecycle=await lifecycleModuleInbox(s,await lifecycleModuleNavigation(s));return <TasksView items={items} existing={existing} lifecycleTasks={lifecycle.items} lifecycleTotal={lifecycle.count}/>;}
