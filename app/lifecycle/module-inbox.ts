import 'server-only';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import type {LifecycleTaskItem} from '@/lib/lifecycle-task-item';
import {probationInbox} from '@/packs/probation/service';
import {contractInbox} from '@/packs/contracts/service';
import {lifecycleModuleNavigation} from './workflow-availability';
export async function lifecycleModuleInbox(ctx:SessionContext,navigation:Awaited<ReturnType<typeof lifecycleModuleNavigation>>){
 const [probation,contracts]=await Promise.all([navigation.probation.page?probationInbox(ctx):Promise.resolve({count:0,items:[]}),navigation.contractStaff.page?contractInbox(ctx):Promise.resolve({count:0,items:[]})]);
 const contractCopy=contracts.items.some(item=>['reconciliation','date_amendment'].includes(item.kind))?await getTranslations():null;
 const items:LifecycleTaskItem[]=[...probation.items.slice(0,20).map(item=>({id:'probation:'+item.caseId+':'+item.partId,kind:'probation' as const,ownerKind:item.kind,subjectName:item.employeeName,linkPath:item.href})),...contracts.items.slice(0,20).map(item=>({id:'contract_staff:'+item.caseId+':'+item.kind,kind:'contract_staff' as const,ownerKind:item.kind,subjectName:item.name+' · '+item.number,actionLabel:contractCopy&&['reconciliation','date_amendment'].includes(item.kind)?contractCopy(item.kind==='reconciliation'?'contractManagement.reconcile':'notifications.task.contractDateCorrection'):undefined,linkPath:item.href}))];
 return{count:probation.count+contracts.count,items};
}
