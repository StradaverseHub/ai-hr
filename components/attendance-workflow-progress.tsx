import {attendanceNextApproverLabel} from '@/lib/attendance-progress';
import { getLocale, getTranslations } from 'next-intl/server';
import type { AttendanceResolvedStage } from '@/lib/attendance-workflow';
import type { AttendanceProgress } from '@/lib/attendance-progress';

type Decision = { id?:string; stageIndex:number; decision:string; actualActorName:string; actualEmploymentId:string|null; actingMode:string; decidedAt:Date; remarks:string|null };
type ParticipantDecision = Decision & { participantSlot:string; assigned:{kind:string;name:string} };
type Workflow = {
  templateCode:string; templateName:string; templateVersion:number; routingVersion:number; currentStage:number;
  currentParticipantSlot?:string|null; stages:AttendanceResolvedStage[]; effectiveStages?:AttendanceResolvedStage[]; decisions:Decision[];
  participantDecisions?:ParticipantDecision[];
  reassignments?:{id:string;stageIndex:number;actualActorName?:string|null;actualUserId:string;occurredAt:Date;reason:string}[];
  participantReassignments?:{id:string;stageIndex:number;previousAssigned:{name:string};assigned:{kind:string;name:string};actualActorName:string;occurredAt:Date;reason:string}[];
};
export async function AttendanceWorkflowProgress({ workflow, status, progress, codes = {} }: {
  workflow:Workflow|null; status:string; progress?:AttendanceProgress; codes?:Record<string,string|null>;
}) {
  const t=await getTranslations('attendanceHistory'),v3=await getTranslations('attendanceWorkflow.v3'),locale=await getLocale();
  const dt=(value:Date)=>new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'short'}).format(value);
  const names=(stage:AttendanceResolvedStage)=>stage.approvers.map(a=>(a.kind==='hr_admin'?t('hrApprover'):`${a.name}${a.employmentId&&codes[a.employmentId]?` · ${codes[a.employmentId]}`:''}`)+(a.slot&&a.slot===workflow?.currentParticipantSlot?` · ${v3('pendingParticipant')}`:'')).join(' / ');
  if(!workflow)return <p className="text-sm text-muted-foreground">{status==='pending'?t('legacyHelp'):t('finalOutcome',{status:t(`statuses.${status}`)})}</p>;
  function actor(record:Decision){return <div className="space-y-1"><p>{t('actualActor')}: {record.actualActorName}{record.actualEmploymentId&&codes[record.actualEmploymentId]&&<span className="ml-2 text-xs text-muted-foreground">{t('currentEmployeeId')}: {codes[record.actualEmploymentId]}</span>}</p><p className="text-muted-foreground">{t(`modes.${record.actingMode}`)} · {dt(record.decidedAt)}</p>{record.remarks&&<p>{t('remarks')}: {record.remarks}</p>}</div>;}
  return <div className="space-y-4">
    {status!=='pending'?<p className="font-medium">{t('finalOutcome',{status:t(`statuses.${status}`)})}</p>:progress?.state==='pending'?<div className="space-y-1"><p className="font-semibold">{t('currentLevel',{level:progress.level??'—'})}</p><p>{t('nextApprover')}: {progress.next.filter(a=>a.eligible).map(a=>attendanceNextApproverLabel(a,{hr:t('hrApprover'),onBehalf:t('modes.administrator')})).join(' / ')}</p><p className="text-sm text-muted-foreground">{t(progress.mode==='sequential'?'modeSequential':'modeAnyOne')}</p>{progress.next.some(a=>!a.eligible)&&<p className="text-sm text-muted-foreground">{t('someApproversUnavailable')}</p>}</div>:!progress&&workflow.stages[workflow.currentStage]?<div className="space-y-1"><p>{t('currentLevel',{level:workflow.currentStage+1})}</p><p>{t('assigned')}: {names(workflow.effectiveStages?.[workflow.currentStage]??workflow.stages[workflow.currentStage])}</p></div>:<div className="space-y-1">{progress?.level!=null&&<p className="font-semibold">{t('currentLevel',{level:progress.level})}</p>}<p role="status" className="text-sm">{t('routeUnavailable')}</p></div>}
    <ol className="divide-y divide-border">{workflow.stages.map((original,index)=>{
      const stage=workflow.effectiveStages?.[index]??original,decision=workflow.decisions.find(d=>d.stageIndex===index);
      const participants=workflow.participantDecisions?.filter(d=>d.stageIndex===index)??[];
      const changes=workflow.reassignments?.filter(r=>r.stageIndex===index)??[];
      return <li key={index} className="space-y-2 py-4 text-sm">
        <h3 className="font-semibold">{t('levelNumber',{level:index+1})} · {decision?t(`statuses.${decision.decision}`):status==='pending'&&index===workflow.currentStage?t('pendingStage'):t(status==='pending'?'notStarted':'notRequired')}</h3>
        <p>{t('assigned')}: {names(stage)||t('routeUnavailable')}{stage.hrAlternative?` / ${t('hrApprover')}`:''}</p>
        {stage.approvers.length>1&&<p className="text-xs text-muted-foreground">{t(stage.mode==='sequential'?'modeSequential':'modeAnyOne')}</p>}
        {stage.mode==='sequential'&&<ol className="list-inside list-decimal space-y-1">{stage.approvers.map((a,i)=><li key={a.slot??i}>{a.kind==='hr_admin'?t('hrApprover'):a.name}{a.employmentId&&codes[a.employmentId]?` · ${codes[a.employmentId]}`:''}</li>)}</ol>}
        {participants.length>0?<ol className="space-y-3">{participants.map((record,i)=><li key={record.id??i} className="space-y-1"><p className="font-medium">{record.assigned.kind==='hr_admin'?t('hrApprover'):record.assigned.name} · {t(`statuses.${record.decision}`)}</p>{actor(record)}</li>)}</ol>:decision&&actor(decision)}
        {changes.length>0&&<div className="space-y-2 rounded-md bg-muted p-3"><p>{t('originalAssignment')}: {names(original)}</p>{changes.map(change=><p key={change.id}>{t('reassignedBy')}: {change.actualActorName||change.actualUserId} · {dt(change.occurredAt)} · {change.reason}</p>)}</div>}
        {workflow.participantReassignments?.filter(change=>change.stageIndex===index).map(change=><div key={change.id} className="space-y-1 rounded-md bg-muted p-3"><p>{change.previousAssigned.name} → {change.assigned.kind==='hr_admin'?t('hrApprover'):change.assigned.name}</p><p>{t('reassignedBy')}: {change.actualActorName} · {dt(change.occurredAt)} · {change.reason}</p></div>)}
      </li>;
    })}</ol>
    <details className="text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">{t('routingRecord')}</summary><p>{workflow.templateCode} · {workflow.templateName} · {t('version',{number:workflow.templateVersion})}</p></details>
  </div>;

}
