import { getLocale, getTranslations } from 'next-intl/server';
import type { attendanceApplicationDetail } from '@/packs/attendance/service';
type Workflow = NonNullable<Awaited<ReturnType<typeof attendanceApplicationDetail>>>['workflow'];
export async function AttendanceWorkflowProgress({ workflow, status }: {
    workflow: Workflow;
    status: string;
}) {
    const t = await getTranslations('attendanceHistory'), locale = await getLocale();
    if (!workflow)
        return <p className="text-sm text-muted-foreground">{t('legacyHelp')}</p>;
    return <div className="space-y-3"><p className="text-sm">{workflow.templateCode} · {workflow.templateName} · {t('version', { number: workflow.templateVersion })}</p><ol className="space-y-3">{workflow.stages.map((stage, i) => { const decision = workflow.decisions.find(d => d.stageIndex === i); return <li key={i} className="rounded-lg border border-border p-3 text-sm"><p className="font-medium">{i + 1}. {stage.name} — {decision ? t(`statuses.${decision.decision}`) : status === 'pending' && i === workflow.currentStage ? t('pendingStage') : t('notDecided')}</p><p>{t('assigned')}: {stage.approvers.map(a => a.kind === 'hr_admin' ? t('hrApprover') : a.name).join(' / ')}</p>{decision && <><p>{t('actualActor')}: {decision.actualActorName} · {t(`modes.${decision.actingMode}`)}</p><p>{new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' }).format(decision.decidedAt)}</p>{decision.remarks && <p>{t('remarks')}: {decision.remarks}</p>}</>}</li>; })}</ol></div>;
}
