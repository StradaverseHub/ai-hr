import {isModuleEnabledOrFalse} from '@/core/entitlements';
import {withBackgroundReadWork,withSharedReadSnapshot,type SessionContext} from '@/db/client';
import {AuthRequiredError} from '@/lib/auth-errors';
import {isAdmin} from '@/lib/authz-model';
import {capacityAwareRoute} from '@/lib/database-degraded';
import {onboardingNotificationTask} from '@/lib/onboarding-notification-task';
import {companyContextForPage} from '@/lib/scope';
import {getSession} from '@/lib/session';
import {readShellTaskSummary} from '@/lib/shell-task-summary';
import {contractNavigationAccess} from '@/packs/contracts/service';
import {onboardingTasks} from '@/packs/lifecycle/service';
import {lifecycleModuleInbox} from '../../../lifecycle/module-inbox';

const headers={'Cache-Control':'private, no-store',Vary:'Cookie, Authorization'};

function readApprovals(session:SessionContext,signal:AbortSignal){
 return withSharedReadSnapshot(session,async()=>{
  const {scopeIds}=await companyContextForPage(session);
  signal.throwIfAborted();
  return readShellTaskSummary(session,scopeIds,{
   attendance:isModuleEnabledOrFalse(session,'attendance'),
   claims:isModuleEnabledOrFalse(session,'claims'),
   performance:isModuleEnabledOrFalse(session,'performance'),
   rewards:isModuleEnabledOrFalse(session,'rewards'),
   recruitment:isModuleEnabledOrFalse(session,'recruitment'),
   probation:isModuleEnabledOrFalse(session,'lifecycle')||!!session.entitlements?.scopedModules.lifecycle?.length,
  });
 },signal);
}

async function readLifecycle(session:SessionContext,signal:AbortSignal){
 const contractStaff=await contractNavigationAccess(session);
 signal.throwIfAborted();
 const [onboarding,inbox]=await Promise.all([
  isModuleEnabledOrFalse(session,'lifecycle')?onboardingTasks(session):[],
  lifecycleModuleInbox(session,{contractStaff}),
 ]);
 return {
  items:[...onboarding.map(onboardingNotificationTask),...inbox.items],
  count:onboarding.length+inbox.count,
  myTasksCount:onboarding.length+inbox.myTasksCount,
  approvalCount:inbox.approvalCount,
  queueLinks:inbox.queueLinks,
 };
}

export const GET=capacityAwareRoute(async function GET(request:Request){
 try{
  const session=await getSession();
  return await withBackgroundReadWork(session.tenantId,async()=>{
   const [approvalRead,lifecycleRead]=await Promise.allSettled([
    readApprovals(session,request.signal),readLifecycle(session,request.signal),
   ]);
   request.signal.throwIfAborted();
   const lifecycle=lifecycleRead.status==='fulfilled'?lifecycleRead.value:null;
   const preview=lifecycle?{items:lifecycle.items,count:lifecycle.count,queueLinks:lifecycle.queueLinks}:null;
   if(approvalRead.status!=='fulfilled'||!lifecycle){
    return Response.json({approvals:{state:'unavailable'},lifecycle:preview},{headers});
   }
   const approval=approvalRead.value;
   const approvalCount=approval.approvalCount+lifecycle.approvalCount;
   const canApprove=isAdmin(session)||session.roles?.includes('manager')===true;
   return Response.json({
    approvals:{state:'ready',items:approval.items,total:approval.total,claimTotal:approval.claimTotal,
     lifecycleMyTasksCount:lifecycle.myTasksCount,approvalCount,
     hasAssignedAttendanceApproval:!canApprove&&approval.items.some(task=>task.kind==='attendance'),
     hasAssignedApproval:!canApprove&&approvalCount>0},
    lifecycle:preview,
   },{headers});
  },request.signal);
 }catch(error){
  return error instanceof AuthRequiredError
   ?Response.json({error:'authentication'},{status:401,headers})
   :Response.json({error:'unavailable'},{status:503,headers});
 }
});
