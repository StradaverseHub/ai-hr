import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader} from '@/components/ui';
import {ModuleAssignedLeaveActionSection} from '@/components/assistant/module-assigned-leave-action-section';
import {ReviewedDecisionBatchSection} from '@/components/assistant/reviewed-decision-batch-section';
import {REVIEWED_LEAVE_DECISION_ACTION} from '@/lib/assistant-actions/reviewed-leave-decision-contract';
import {AssignedDecisionPanel} from '@/components/assistant/assigned-decision-panel';
import {ASSIGNED_CLAIM_DECISION_ACTION,ASSIGNED_ATTENDANCE_DECISION_ACTION,ASSIGNED_TOIL_DECISION_ACTION} from '@/lib/assistant-actions/assigned-decision-contract';
/** GET only renders assigned metadata and recovery controls. A separate human-confirmed POST records a decision.
 * ADR-0151 wave 1b: claim, attendance and replacement-leave decisions are separate flows (?flow=claims|attendance|toil);
 * the assigned Leave decision stays the default. Their choices load through the same guarded POST. */
const FLOWS={claims:{action:ASSIGNED_CLAIM_DECISION_ACTION,kind:'claim'},attendance:{action:ASSIGNED_ATTENDANCE_DECISION_ACTION,kind:'attendance'},toil:{action:ASSIGNED_TOIL_DECISION_ACTION,kind:'toil'}} as const;
export default async function AssistantAssignedLeaveDecisionPage({searchParams}:{searchParams:Promise<{review?:string|string[];flow?:string|string[];batch?:string|string[]}>}){
 const t=await getTranslations('assistant.workspace.approvalActions'),d=await getTranslations('assistant.workspace.decisionActions'),query=await searchParams;
 const bulk=query.batch==='review',bulkT=await getTranslations('assistant.workspace.bulkDecisions');
 const flow=typeof query.flow==='string'&&Object.hasOwn(FLOWS,query.flow)?FLOWS[query.flow as keyof typeof FLOWS]:null;
 const link='inline-flex min-h-11 items-center underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',current=(name:string|null)=>(flow?flow.kind:null)===name?'page' as const:undefined;
 return <div className="mx-auto max-w-4xl space-y-5"><Link href="/assistant?job=approvals" className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('back')}</Link><PageHeader title={flow?d(`${flow.kind}.title`):t('title')} description={flow?d(`${flow.kind}.description`):t('description')}/>
  <nav aria-label={d('flowLabel')} className="flex flex-wrap gap-3 text-sm"><Link href="/assistant/approvals" aria-current={current(null)} className={link}>{d('leaveFlow')}</Link><Link href="/assistant/approvals?flow=claims" aria-current={current('claim')} className={link}>{d('claimsFlow')}</Link><Link href="/assistant/approvals?flow=attendance" aria-current={current('attendance')} className={link}>{d('attendanceFlow')}</Link><Link href="/assistant/approvals?flow=toil" aria-current={current('toil')} className={link}>{d('toilFlow')}</Link></nav>
  <Link href={`/assistant/approvals?${flow?`flow=${query.flow}&`:''}${bulk?'':'batch=review'}`} className={link}>{bulkT(bulk?'single':'title')}</Link>
  {bulk?<ReviewedDecisionBatchSection action={flow?.action??REVIEWED_LEAVE_DECISION_ACTION}/>:<Card className="p-5">{flow?<AssignedDecisionPanel key={flow.action} action={flow.action} resumeActionId={typeof query.review==='string'?query.review:undefined}/>:<ModuleAssignedLeaveActionSection resumeActionId={query.review}/>}</Card>}</div>;
}
