import {attendanceNextApproverLabel, attendanceLevelStatuses, attendanceProgressMessage} from '@/lib/attendance-progress';
import {attendanceLevelStatusLabel, attendanceProgressHeadlineText} from '@/lib/attendance-progress-labels';
import { getLocale, getTranslations } from 'next-intl/server';
import { attendanceStageLevelNumber, type AttendanceResolvedStage, type AttendanceSkippedLevel } from '@/lib/attendance-workflow';
import type { AttendanceProgress } from '@/lib/attendance-progress';

type Decision = { id?:string; stageIndex:number; decision:string; actualActorName:string; actualEmploymentId:string|null; actingMode:string; decidedAt:Date; remarks:string|null };
type ParticipantDecision = Decision & { participantSlot:string; assigned:{kind:string;name:string} };
type Workflow = {
  templateCode:string; templateName:string; templateVersion:number; routingVersion:number; currentStage:number;
  currentParticipantSlot?:string|null; stages:AttendanceResolvedStage[]; effectiveStages?:AttendanceResolvedStage[]; decisions:Decision[];
  participantDecisions?:ParticipantDecision[];
  reassignments?:{id:string;stageIndex:number;actualActorName?:string|null;actualUserId:string;occurredAt:Date;reason:string}[];
  participantReassignments?:{id:string;stageIndex:number;previousAssigned:{name:string};assigned:{kind:string;name:string};actualActorName:string;occurredAt:Date;reason:string}[];
  /** Frozen at submission; levels that were not required because the reporting chain had ended. */
  skippedLevels?:AttendanceSkippedLevel[]; createdAt?:Date;
  /** v4 automatic Escalation Approval moves (5141); a level here was escalated, never approved. */
  /** 96a54ed2: who filed the application on the employee's behalf (NULL when the employee filed it). */
  submittedByName?:string|null;
  escalations?:{id:string;stageIndex:number;nextStageIndex:number;escalateAfterDays:number;escalatedAt:Date;fromParticipants:{kind:string;name:string}[]}[];
  /** 237c31e6: Employee IDs of the frozen identities, read once per page by app.attendance_workflow_approver_codes (5697). */
  approverCodes?:Record<string,string|null>;
};
export async function AttendanceWorkflowProgress({ workflow, status, progress, codes = {} }: {
  workflow:Workflow|null; status:string; progress?:AttendanceProgress; codes?:Record<string,string|null>;
}) {
  const t=await getTranslations('attendanceHistory'),v3=await getTranslations('attendanceWorkflow.v3'),locale=await getLocale();
  const dt=(value:Date)=>new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(value);
  const codeOf=(employmentId:string|null|undefined)=>employmentId?(codes[employmentId]??workflow?.approverCodes?.[employmentId]??null):null;
  const person=(a:{kind:string;name:string;employmentId?:string|null})=>a.kind==='hr_admin'?t('hrApprover'):`${a.name}${codeOf(a.employmentId)?` · ${codeOf(a.employmentId)}`:''}`;
  const names=(stage:AttendanceResolvedStage)=>stage.approvers.map(a=>person(a)+(a.slot&&a.slot===workflow?.currentParticipantSlot?` · ${v3('pendingParticipant')}`:'')+(a.pendingActivation?` · ${t('awaitingActivation')}`:'')).join(' / ');
  const sourceNames=(sources:AttendanceSkippedLevel['sources'])=>sources.map(source=>source.kind==='direct_manager'?v3('depthOption',{number:source.depth}):v3('selectedEmployees')).join(', ');
  const skipped=workflow?.skippedLevels??[];
  const skippedItem=(entry:AttendanceSkippedLevel)=><li key={`skipped-${entry.configuredLevel}`} className="space-y-1 py-4 text-sm"><h3 className="font-semibold">{t('levelNumber',{level:entry.configuredLevel})} · <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{t('skippedNotRequired')}</span></h3><p className="text-muted-foreground">{t('skippedNoSuperior',{sources:sourceNames(entry.sources)})}</p>{workflow?.createdAt&&<p className="text-xs text-muted-foreground">{t('skippedDecidedAt',{date:dt(workflow.createdAt)})}</p>}</li>;
  if(!workflow)return <p className="text-sm text-muted-foreground">{status==='pending'?t('legacyHelp'):t('finalOutcome',{status:t(`statuses.${status}`)})}</p>;
  function actor(record:Decision){return <div className="space-y-1"><p>{t('actualActor')}: {record.actualActorName}{record.actualEmploymentId&&codeOf(record.actualEmploymentId)&&<span className="ml-2 text-xs text-muted-foreground">{t('currentEmployeeId')}: {codeOf(record.actualEmploymentId)}</span>}</p><p className="text-muted-foreground">{t(`modes.${record.actingMode}`)} · {dt(record.decidedAt)}</p>{record.remarks&&<p>{t('remarks')}: {record.remarks}</p>}</div>;}
  const levels=attendanceLevelStatuses(workflow,status);
  const headline=attendanceProgressMessage(workflow,status);
  return <div className="space-y-4">
    {workflow.submittedByName&&<p className="text-sm text-muted-foreground">{t('submittedOnBehalfBy',{name:workflow.submittedByName})}</p>}
    {headline&&<p className="font-semibold" data-approval-headline>{attendanceProgressHeadlineText(t,locale,headline)}</p>}
    {/* HR detail only: the live eligibility of the current level (attendanceProgressTx), never read in lists. */}
    {status==='pending'&&progress&&(progress.state==='pending'?<div className="space-y-1"><p>{t('currentLevel',{level:progress.level??'—'})}</p><p>{t('nextApprover')}: {progress.next.filter(a=>a.eligible).map(a=>attendanceNextApproverLabel(a,{hr:t('hrApprover'),onBehalf:t('modes.administrator')})).join(' / ')}</p><p className="text-sm text-muted-foreground">{t(progress.mode==='sequential'?'modeSequential':progress.mode==='all_required'?'modeAllRequired':'modeAnyOne')}</p>{progress.next.some(a=>!a.eligible)&&<p className="text-sm text-muted-foreground">{t('someApproversUnavailable')}</p>}</div>:<div className="space-y-1">{progress.level!=null&&<p>{t('currentLevel',{level:progress.level})}</p>}<p role="status" className="text-sm">{t('routeUnavailable')}</p></div>)}
    <ol className="divide-y divide-border">{skipped.filter(entry=>entry.levelSkipped&&entry.configuredLevel<attendanceStageLevelNumber(workflow.stages[0],0)).map(skippedItem)}{workflow.stages.map((original,index)=>{
      const levelNumber=attendanceStageLevelNumber(original,index),nextNumber=index+1<workflow.stages.length?attendanceStageLevelNumber(workflow.stages[index+1],index+1):Infinity;
      const partial=skipped.filter(entry=>!entry.levelSkipped&&entry.configuredLevel===levelNumber),after=skipped.filter(entry=>entry.levelSkipped&&entry.configuredLevel>levelNumber&&entry.configuredLevel<nextNumber);
      const stage=workflow.effectiveStages?.[index]??original,decision=workflow.decisions.find(d=>d.stageIndex===index);
      const participants=workflow.participantDecisions?.filter(d=>d.stageIndex===index)??[];
      const changes=workflow.reassignments?.filter(r=>r.stageIndex===index)??[];
      const escalated=workflow.escalations?.find(e=>e.stageIndex===index);
      const state=levels[index];
      // Everyone / sequential / an HR alternative: each approver has their own status line.
      const perPerson=state.participants.length>1;
      const listed=new Set(perPerson?state.participants.map(p=>p.slot):[]);
      const decisionFor=(slot:string)=>participants.find(record=>record.participantSlot===slot);
      const decidedLabel=(record:ParticipantDecision)=>record.actingMode==='on_behalf'?t(record.decision==='rejected'?'rejectedOnBehalf':'approvedOnBehalf'):t(`statuses.${record.decision}`);
      return [<li key={index} className="space-y-2 py-4 text-sm" data-approval-level={levelNumber} data-approval-status={state.status}>
        <h3 className="font-semibold">{t('levelNumber',{level:levelNumber})} · {attendanceLevelStatusLabel(t,state.status)}</h3>
        <p>{t('assigned')}: {names(stage)||t('routeUnavailable')}{stage.hrAlternative?` / ${t('hrApprover')}`:''}</p>
        {stage.approvers.length>1&&<p className="text-xs text-muted-foreground">{t(stage.mode==='sequential'?'modeSequential':stage.mode==='all_required'?'modeAllRequired':'modeAnyOne')}</p>}
        {perPerson&&<ol className="space-y-3">{state.participants.map(p=>{const record=decisionFor(p.slot);return <li key={p.slot} className="space-y-1" data-approval-participant={p.slot} data-approval-status={p.status}><p className="font-medium">{person(p.approver)} · {record?decidedLabel(record):attendanceLevelStatusLabel(t,p.status)}</p>{record&&actor(record)}</li>;})}</ol>}
        {participants.some(record=>!listed.has(record.participantSlot))&&<ol className="space-y-3">{participants.filter(record=>!listed.has(record.participantSlot)).map((record,i)=><li key={record.id??i} className="space-y-1"><p className="font-medium">{record.assigned.kind==='hr_admin'?t('hrApprover'):record.assigned.name} · {decidedLabel(record)}</p>{actor(record)}</li>)}</ol>}
        {participants.length===0&&decision&&actor(decision)}
        {changes.length>0&&<div className="space-y-2 rounded-md bg-muted p-3"><p>{t('originalAssignment')}: {names(original)}</p>{changes.map(change=><p key={change.id}>{t('reassignedBy')}: {change.actualActorName||change.actualUserId} · {dt(change.occurredAt)} · {change.reason}</p>)}</div>}
        {workflow.participantReassignments?.filter(change=>change.stageIndex===index).map(change=><div key={change.id} className="space-y-1 rounded-md bg-muted p-3"><p>{change.previousAssigned.name} → {change.assigned.kind==='hr_admin'?t('hrApprover'):change.assigned.name}</p><p>{t('reassignedBy')}: {change.actualActorName} · {dt(change.occurredAt)} · {change.reason}</p></div>)}
        {escalated&&<div className="space-y-1 rounded-md bg-muted p-3"><p>{t('escalatedMoved',{days:escalated.escalateAfterDays,level:attendanceStageLevelNumber(workflow.stages[escalated.nextStageIndex],escalated.nextStageIndex)})}</p><p>{t('escalatedWaitedFor')}: {escalated.fromParticipants.map(a=>a.kind==='hr_admin'?t('hrApprover'):a.name).join(' / ')||'—'}</p><p className="text-muted-foreground">{t('escalatedBy')} · {dt(escalated.escalatedAt)}</p></div>}
        {partial.map(entry=><p key={`partial-${entry.configuredLevel}`} className="text-xs text-muted-foreground">{t('skippedNoSuperior',{sources:sourceNames(entry.sources)})}</p>)}
      </li>,...after.map(skippedItem)];
    })}</ol>
    <details className="text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">{t('routingRecord')}</summary><p>{workflow.templateCode} · {workflow.templateName} · {t('version',{number:workflow.templateVersion})}</p></details>
  </div>;

}
