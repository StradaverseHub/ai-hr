import 'server-only';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import type {LifecycleTaskItem} from '@/lib/lifecycle-task-item';
import {contractInbox,contractSharedWorkPage} from '@/packs/contracts/service';
import {isModuleEnabledOrFalse} from '@/core/entitlements';
import {lifecycleModuleNavigation} from './workflow-availability';
import {v9EmailHoldInbox} from '@/packs/lifecycle/service';
/**
 * Lifecycle module work beside the shared task list. Probation work is not listed here: it is a shared task source
 * (core/approvals-inbox.ts PACK_TASK_SOURCES, kinds probationApproval and probationTask), so the bell, Home, Today and
 * My Tasks read it once, without the former 20-item cut.
 */
export async function lifecycleModuleInbox(ctx:SessionContext,navigation:Awaited<ReturnType<typeof lifecycleModuleNavigation>>,options:{includeShared?:boolean}={}){
 // Held On/Off Boarding emails: rechecked against Full case view and company access on every read.
 const sharedEnabled=options.includeShared!==false&&(isModuleEnabledOrFalse(ctx,'lifecycle')||!!ctx.entitlements?.scopedModules.lifecycle?.length);
 const [contracts,holds,shared]=await Promise.all([navigation.contractStaff.page?contractInbox(ctx):Promise.resolve({count:0,items:[]}),v9EmailHoldInbox(ctx).catch(()=>({count:0,items:[]})),sharedEnabled?contractSharedWorkPage(ctx,{limit:20}):Promise.resolve({items:[],total:0,approvalTotal:0})]);
 const holdCopy=holds.items.length?await getTranslations('lifecycleEmailHold'):null;
 const contractCopy=contracts.items.some(item=>['reconciliation','date_amendment'].includes(item.kind))?await getTranslations():null;
 const sharedCopy=shared.items.length?await getTranslations('contractWork'):null;
 const items:LifecycleTaskItem[]=[...contracts.items.slice(0,20).map(item=>({id:'contract_staff:'+item.caseId+':'+item.kind,kind:'contract_staff' as const,ownerKind:item.kind,subjectName:item.name+' · '+item.number,actionLabel:contractCopy&&['reconciliation','date_amendment'].includes(item.kind)?contractCopy(item.kind==='reconciliation'?'contractManagement.reconcile':'notifications.task.contractDateCorrection'):undefined,linkPath:item.href}))];
 items.push(...holds.items.map(item=>({id:'lifecycle_email:'+item.caseId+':'+item.heldAt,kind:'lifecycle_email' as const,subjectName:item.name+' · '+item.number,actionLabel:holdCopy!('inboxAction',{email:item.email}),linkPath:item.module==='onb'?'/lifecycle/onboarding/cases/'+encodeURIComponent(item.caseId):'/lifecycle/v9?view=leavers&case='+encodeURIComponent(item.caseId)})));
 items.push(...shared.items.map(item=>({id:item.kind+':'+item.id,kind:'contract_staff' as const,ownerKind:item.action,subjectName:item.subjectName,actionLabel:sharedCopy!(item.action),linkPath:item.linkPath})));
 return{count:contracts.count+holds.count+shared.total,approvalCount:shared.approvalTotal,items};
}
