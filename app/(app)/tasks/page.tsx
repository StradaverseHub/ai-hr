import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { listPendingTasks } from '@/core/approvals-inbox';
import { onboardingTasks } from '@/packs/lifecycle/service';
import { TasksView } from './tasks-view';
export default async function Page(){const {s}=await scopedSession();const [items,existing]=await Promise.all([isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),listPendingTasks(s,undefined,{attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards')})]);return <TasksView items={items} existing={existing}/>;}
