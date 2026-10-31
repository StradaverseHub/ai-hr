'use client';
import { OnboardingBreadcrumb, OnboardingBadge } from '@/components/onboarding-workspace';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Button, Card, inputCls, PageHeader, buttonVariants } from '@/components/ui';
import { useFormatter, useTranslations } from 'next-intl';
import type { OnboardingTask } from '@/packs/lifecycle/service';
import type { PendingTaskItem } from '@/core/approvals-inbox';
import { changeOnboarding, loadOnboardingTask, writeOnboardingNote } from '@/app/(app)/lifecycle/onboarding/v31-actions';
import { OnboardingCaseView } from '@/app/(app)/lifecycle/onboarding/case-view';
import { useRouter } from 'next/navigation';
type Detail = NonNullable<Awaited<ReturnType<typeof loadOnboardingTask>>['detail']>;
export function TasksView({ items, existing }: {
    items: OnboardingTask[];
    existing: PendingTaskItem[];
}) {
    const copy = useOnboardingCopy();
    // The approval rows use the SAME label vocabulary as the bell and Home (notifications.task.*), never the
    // raw kind code; the filing date is a fixed date, not "n minutes ago", so server and client render alike.
    const tTask = useTranslations('notifications.task');
    const format = useFormatter();
    const [filter, setFilter] = useState('all'), [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState(''), [busy, start] = useTransition(), router = useRouter();
    const filters = [['all', 'All'], ['assigned', 'Assigned to me'], ['tagged', 'Tagged'], ['team', 'Team items'], ['overdue', 'Overdue']];
    const inFilter = (i: OnboardingTask, key: string) => key === 'all' || key === 'assigned' && i.assigned || key === 'tagged' && i.tagged || key === 'team' && i.team || key === 'overdue' && i.overdue;
    const open = (item: OnboardingTask) => start(async () => {
        const r = await loadOnboardingTask(item.caseId);
        if (r.error)
            setError(r.error);
        else if (r.detail?.actor.module) {
            const requisition = ['team', 'approval', 'manualApproval', 'handover', 'hrNote'].includes(item.kind) || item.kind === 'mention' && item.context === 'requisition' || item.kind === 'owner' && !!item.itemIds?.length;
            router.push((requisition ? '/lifecycle/requisitions/onboarding/' : '/lifecycle/onboarding/cases/') + item.caseId);
        }
        else
            setDetail(r.detail);
    });
    const command = (i: OnboardingTask, type: 'todo' | 'progress' | 'done' | 'approve' | 'handover' | 'readNote') => start(async () => {
        setError('');
        const cmd = type === 'approve' ? { type: 'approve' as const, itemIds: i.itemIds!, decision: 'approve' as const } : type === 'handover' || type === 'readNote' ? { type } : i.kind === 'checklist' ? { type: 'task' as const, taskId: i.taskId!, status: type as 'todo' | 'progress' | 'done' } : { type: 'fulfil' as const, itemId: i.itemIds![0]!, status: type as 'todo' | 'progress' | 'done' };
        const r = await changeOnboarding(i.caseId, i.revision, cmd);
        if (r.error)
            setError(r.error);
        else {
            setDetail(null);
            router.refresh();
        }
    });
    return <div className="onb-workspace space-y-5"><OnboardingBreadcrumb root="Manage" items={[{label:"My tasks"}]}/><PageHeader title={copy("My tasks")} description={copy("Assigned work, team items and conversations that need your action.")}/><nav className="flex flex-wrap gap-2 border-b border-border pb-3" aria-label={copy("Task filters")}>{filters.map(([key, label]) => <Button key={key} aria-pressed={key===filter} variant={key === filter ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter(key!)}>{copy(label!)} <span className="tabular-nums">{items.filter(i => inFilter(i, key!)).length + (key === 'all' || key === 'assigned' ? existing.length : 0)}</span></Button>)}</nav>{error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
 {detail ? <Card className="space-y-4 p-4"><div className="flex justify-end"><Button variant="outline" onClick={() => setDetail(null)}>{copy("Close task details")}</Button></div><OnboardingCaseView key={detail.case.id + ':' + detail.revision} detail={detail} mode="task"/></Card> : <div className="onb-task-cards">{!items.some(i => inFilter(i, filter)) && (!(filter === 'all' || filter === 'assigned') || !existing.length) && <div className="p-8 text-center text-sm text-muted-foreground">{copy("No tasks in this view. Assigned work and mentions appear here automatically.")}</div>}{items.filter(i => inFilter(i, filter)).map(i => <article key={i.id} id={'onboarding-'+i.id} className="scroll-mt-24 onb-panel flex flex-wrap items-center justify-between gap-4"><div className="min-w-0"><OnboardingBadge tone={i.tagged?'warning':i.assigned?'primary':'neutral'}>{copy(i.tagged?'Tagged':i.assigned?'Assigned to me':'Team items')}</OnboardingBadge><button className="mt-2 block text-left font-medium hover:text-primary hover:underline" onClick={() => open(i)}>{i.title} {copy(" for ")}{i.joiner || copy('New joiner')}</button><p className="mt-1 text-sm text-muted-foreground">{i.due ? copy('Due ') + i.due.split('-').reverse().join('/') : copy("Date needed")} · {i.kind === 'team' ? copy("Team item") : i.kind === 'approval' ? copy("Approval") : i.kind === 'mention' ? copy("Mention") : copy("Onboarding")}{i.lockReason && <span> · {i.lockReason}</span>}{i.claimedBy && <span> · {i.claimedBy} {copy(" is on it")}</span>}{i.overdue && <span className="ml-2 text-destructive">{copy("Overdue")}</span>}</p></div><div className="flex flex-wrap gap-2">{(i.kind === 'checklist' || i.kind === 'team') && <select aria-label={copy('Status')} className={inputCls + ' w-auto'} value={i.status ?? 'todo'} disabled={busy || i.locked} onChange={e => command(i, e.target.value as 'todo' | 'progress' | 'done')}>{(['todo', 'progress', 'done'] as const).map(status => <option key={status} value={status}>{copy(status)}</option>)}</select>}{i.kind === 'approval' && <Button size="sm" disabled={busy} onClick={() => command(i, 'approve')}>{copy("Approve all")}</Button>}{i.kind === 'handover' && <Button size="sm" disabled={busy} onClick={() => command(i, 'handover')}>{copy("Done")}</Button>}{i.kind === 'hrNote' && <Button size="sm" disabled={busy} onClick={() => command(i, 'readNote')}>{copy("Mark as read")}</Button>}{i.kind === 'mention' && <Button size="sm" disabled={busy} variant="outline" onClick={() => start(async () => {
                        const r = await writeOnboardingNote(i.caseId, { id: i.noteId, context: i.context ?? 'requisition', body: '', mentions: [], resolve: true });
                        if (r.error)
                            setError(r.error);
                        else
                            router.refresh();
                    })}>{copy("Mark done")}</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => open(i)}>{i.kind === 'manualApproval' ? copy("Choose an approver") : i.kind === 'owner' ? copy("Assign an owner") : i.kind === 'case' ? copy("Open case") : copy("Review")}</Button>{i.kind === 'acknowledgement' && <Link className="inline-flex items-center text-sm text-primary underline" href={'/lifecycle/acknowledgement?case=' + i.caseId}>{copy("Open device acknowledgement")}</Link>}{i.kind === 'case' && <Link className="inline-flex items-center text-sm text-primary underline" href={'/lifecycle/onboarding/cases/' + i.caseId}>{copy("Open onboarding")}</Link>}</div></article>)}{(filter === 'all' || filter === 'assigned') && existing.map(i => <article key={i.kind + ':' + i.id} className="onb-panel flex flex-wrap items-center justify-between gap-4"><div className="flex min-w-0 items-center gap-3"><span aria-hidden className="size-7 shrink-0 rounded-full border-[1.5px] border-dashed border-border" /><div className="min-w-0"><p className="font-medium">{tTask(i.kind)}</p><p className="mt-0.5 text-sm text-muted-foreground">{[i.subjectName ?? copy('Approval request'), format.dateTime(new Date(i.createdAt), { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' })].join(' · ')}</p></div></div><Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href={i.linkPath}>{i.kind==='noticeAcknowledgement'?tTask('noticeAcknowledgement'):copy("Review approval")}</Link></article>)}</div>}</div>;
}
