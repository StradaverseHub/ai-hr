/** ADR-0169 phase B — what is waiting for the signed-in person's decision, minimized for the Assistant.
 *
 * Reuses the one canonical approvals inbox (core/approvals-inbox.ts listPendingTasks — the bell, My tasks and
 * the dashboard card read the same list), which proves actual current assignment per decision owner and
 * excludes the person's own requests. This projection returns counts per kind and the queue page only: no
 * subject names, request ids or dates, so nothing about a colleague can reach a provider. Module flags use
 * the loud `isModuleEnabled` (a service, not the root layout); an entitlement fault propagates and the caller
 * fails closed. Deciding stays on the approvals pages. Not imported by the production Assistant. */
import type {SessionContext} from '../../db/client';
import {isModuleEnabled} from '../entitlements';
import {listPendingTasks,type PendingTaskKind} from '../approvals-inbox';

/** The suggestable review action for a queue kind, where one exists (lib/ai/agent-action-registry.ts). */
const REVIEW_ACTION:Partial<Record<PendingTaskKind,string>>={leave:'approvals.leave.decide',claim:'approvals.claim.decide',attendance:'approvals.attendance.decide',replacementLeave:'approvals.toil.decide'};
export type ApprovalQueueSummary=Readonly<{total:number;groups:readonly Readonly<{kind:string;count:number;href:string;reviewAction:string|null}>[]}>;

/** The queue page for a task, without the request id, task focus or row anchor. */
function queueHref(linkPath:string):string{
 const url=new URL(linkPath,'https://aihr.invalid'),category=url.pathname==='/approvals'?url.searchParams.get('category'):null;
 return url.pathname+(category?'?'+new URLSearchParams({category}):'');
}
const pendingFor=(ctx:SessionContext,companyId:string)=>listPendingTasks(ctx,[companyId],{attendance:isModuleEnabled(ctx,'attendance'),claims:isModuleEnabled(ctx,'claims'),
 performance:isModuleEnabled(ctx,'performance'),rewards:isModuleEnabled(ctx,'rewards')},{noticeAcknowledgements:false});
function summarise(tasks:Awaited<ReturnType<typeof pendingFor>>):ApprovalQueueSummary{
 const groups=new Map<string,{kind:string;count:number;href:string;reviewAction:string|null}>();
 for(const task of tasks){const row=groups.get(task.kind)??{kind:task.kind,count:0,href:queueHref(task.linkPath),reviewAction:REVIEW_ACTION[task.kind]??null};row.count++;groups.set(task.kind,row);}
 return Object.freeze({total:tasks.length,groups:Object.freeze([...groups.values()].sort((a,b)=>b.count-a.count||a.kind.localeCompare(b.kind)).map(row=>Object.freeze(row)))});
}
/** Counts per kind of work currently assigned to this person, largest first. */
export async function approvalQueueFor(ctx:SessionContext,companyId:string):Promise<ApprovalQueueSummary>{
 return summarise(await pendingFor(ctx,companyId));
}
/** The same counts from the same read, and the ids of the leave requests among them. The ids are for the harness alone,
 * which names only those of them the leave decision card can open (core/harness/tools.ts approvalQueueWithLeaveRequests,
 * disclosed under its declared entity); they never leave it. */
export async function approvalQueueWithLeaveIdsFor(ctx:SessionContext,companyId:string):Promise<Readonly<{summary:ApprovalQueueSummary;leaveRequestIds:ReadonlySet<string>}>>{
 const tasks=await pendingFor(ctx,companyId);
 return Object.freeze({summary:summarise(tasks),leaveRequestIds:new Set(tasks.filter(task=>task.kind==='leave').map(task=>task.id))});
}
