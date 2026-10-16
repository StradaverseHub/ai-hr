import { getLocale, getTranslations } from 'next-intl/server';
import type { attendanceApplicationDetail } from '@/packs/attendance/service';
type Workflow = NonNullable<Awaited<ReturnType<typeof attendanceApplicationDetail>>>['workflow'];
export async function AttendanceWorkflowProgress({ workflow, status }: { workflow: Workflow; status: string }) {
    const t = await getTranslations('attendanceHistory'), levels = await getTranslations('attendanceWorkflow'), locale = await getLocale();
    if (!workflow) return <p className="text-sm text-muted-foreground">{t('legacyHelp')}</p>;
    const dt = (value: Date) => new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' }).format(value);
    const names = (approvers: typeof workflow.stages[number]['approvers']) => approvers.map(a => a.kind === 'hr_admin' ? t('hrApprover') : a.name).join(' / ');
    return <div className="space-y-3"><p className="text-sm">{workflow.templateCode} · {workflow.templateName} · {t('version', { number: workflow.templateVersion })}</p><ol className="space-y-3">{workflow.stages.map((original, i) => {
        const stage = workflow.effectiveStages?.[i] ?? original, decision = workflow.decisions.find(d => d.stageIndex === i), changes = workflow.reassignments?.filter(r => r.stageIndex === i) ?? [];
        return <li key={i} className="rounded-lg border border-border p-3 text-sm"><p className="font-medium">{workflow.routingVersion === 2 ? levels('stageNumber', { number: i + 1 }) : `${i + 1}. ${stage.name}`} — {decision ? t(`statuses.${decision.decision}`) : status === 'pending' && i === workflow.currentStage ? t('pendingStage') : t('notDecided')}</p><p>{t('assigned')}: {names(stage.approvers)}</p>{changes.length > 0 && <div className="mt-2 space-y-1 border-l-2 border-border pl-3"><p>{t('originalAssignment')}: {names(original.approvers)}</p>{changes.map(change => <p key={change.id}>{t('reassignedBy')}: {change.actualActorName || change.actualUserId} · {dt(change.occurredAt)} · {change.reason}</p>)}</div>}{decision && <><p>{t('actualActor')}: {decision.actualActorName} · {t(`modes.${decision.actingMode}`)}</p><p>{dt(decision.decidedAt)}</p>{decision.remarks && <p>{t('remarks')}: {decision.remarks}</p>}</>}</li>;
    })}</ol></div>;
}
