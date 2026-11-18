import {Pager} from '@/components/pager';
import {parsePageQuery,pageState} from '@/lib/pagination';
import {todayInKualaLumpur} from '@/lib/hr-date';
import { scopedSession } from '@/lib/scope';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { myTaskSummary } from '@/core/approvals-inbox';
import { lifecycleTaskDocuments,lifecycleTaskCardDocuments,onboardingTasks,resignationInbox } from '@/packs/lifecycle/service';
import {lifecycleModuleNavigation} from '../lifecycle/workflow-availability';
import {lifecycleModuleInbox} from '../lifecycle/module-inbox';
import {contractSharedWorkPage} from '@/packs/contracts/service';
import {ContractWorkSection} from '@/app/lifecycle/contracts/work-section';
import { TasksView } from './tasks-view';
export default async function Page({searchParams}:{searchParams?:Promise<{resignationPage?:string;resignationSize?:string;taskView?:string;contractPage?:string;contractSize?:string;documentsPage?:string}>}={}){
 const query=await searchParams??{},resignationQuery=parsePageQuery({page:query.resignationPage,size:['200','all'].includes(query.resignationSize??'')?'100':query.resignationSize}),taskView=['all','assigned','tagged','team','overdue'].includes(query.taskView??'')?query.taskView!:'all';
 const contractQuery=parsePageQuery({page:query.contractPage,size:['200','all'].includes(query.contractSize??'')?'100':query.contractSize});
 const documentPage=typeof query.documentsPage==='string'&&/^\d{1,5}$/.test(query.documentsPage)?Number(query.documentsPage):0;
 const {s,scopeIds}=await scopedSession();
 const modules={attendance:isModuleEnabledOrFalse(s,'attendance'),claims:isModuleEnabledOrFalse(s,'claims'),performance:isModuleEnabledOrFalse(s,'performance'),rewards:isModuleEnabledOrFalse(s,'rewards'),recruitment:isModuleEnabledOrFalse(s,'recruitment'),
  // Probation (Lifecycle, possibly on for some companies only): its Approve steps and tasks are a shared task source.
  probation:isModuleEnabledOrFalse(s,'lifecycle')||!!s.entitlements?.scopedModules.lifecycle?.length};
 const [items,summary,navigation,resignations,contracts,documents]=await Promise.all([
  isModuleEnabledOrFalse(s,'lifecycle')?onboardingTasks(s):Promise.resolve([]),
  myTaskSummary(s,scopeIds,modules),lifecycleModuleNavigation(s),
  modules.probation?resignationInbox(s,{kind:'tasks',companyIds:scopeIds,limit:resignationQuery.limit,offset:resignationQuery.offset,filter:taskView as 'all'|'assigned'|'tagged'|'team'|'overdue'}):Promise.resolve({items:[],total:0,counts:{all:0,assigned:0,tagged:0,team:0,overdue:0}}),
  modules.probation?contractSharedWorkPage(s,{category:'tasks',limit:contractQuery.limit,offset:contractQuery.offset}):Promise.resolve({items:[],total:0}),
  isModuleEnabledOrFalse(s,'lifecycle')?lifecycleTaskDocuments(s,{companyIds:scopeIds,offset:Math.min(documentPage,20000)*50}):Promise.resolve({items:[],total:0,offset:0,limit:50}),
 ]);
 const cardDocuments=isModuleEnabledOrFalse(s,'lifecycle')?await lifecycleTaskCardDocuments(s,{companyIds:scopeIds,refs:items.flatMap(item=>item.kind==='checklist'&&item.documentTemplate&&item.taskId?[{caseId:item.caseId,taskId:item.taskId}]:[])}):[];
 const lifecycle=await lifecycleModuleInbox(s,navigation,{includeShared:false});
 return <TasksView cardDocuments={cardDocuments} documents={documents} documentPaginationParams={{taskView,contractPage:query.contractPage,contractSize:query.contractSize,resignationPage:query.resignationPage,resignationSize:query.resignationSize}} items={items} existing={summary.items} existingTotal={summary.total} claimTotal={summary.claimTotal} lifecycleTasks={lifecycle.items} lifecycleTotal={lifecycle.count} resignationTasks={resignations.items} resignationTotal={resignations.total} resignationCounts={resignations.counts} initialFilter={taskView} resignationPager={<Pager maxPageSize={100} state={pageState(resignationQuery,resignations.total,resignations.items.length)} basePath="/tasks" params={{taskView,contractPage:query.contractPage,contractSize:query.contractSize,documentsPage:query.documentsPage}} paramNames={{page:"resignationPage",size:"resignationSize"}}/>} contractTotal={contracts.total} contractSection={<ContractWorkSection items={contracts.items} total={contracts.total} pager={<Pager maxPageSize={100} state={pageState(contractQuery,contracts.total,contracts.items.length)} basePath="/tasks" params={{taskView,resignationPage:query.resignationPage,resignationSize:query.resignationSize,documentsPage:query.documentsPage}} paramNames={{page:"contractPage",size:"contractSize"}}/>}/>} today={todayInKualaLumpur()} viewerId={s.userId??undefined}/>;
}
