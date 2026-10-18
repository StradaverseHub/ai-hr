'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Button, Card, inputCls, PageHeader } from '@/components/ui';
import type { OnboardingTask } from '@/packs/lifecycle/service';
import type { PendingTaskItem } from '@/core/approvals-inbox';
import { changeOnboarding, loadOnboardingTask, writeOnboardingNote } from '@/app/lifecycle/onboarding/v31-actions';
import { OnboardingCaseView } from '@/app/lifecycle/onboarding/case-view';
import { useRouter } from 'next/navigation';
type Detail = NonNullable<Awaited<ReturnType<typeof loadOnboardingTask>>['detail']>;
export function TasksView({ items, existing }: {
    items: OnboardingTask[];
    existing: PendingTaskItem[];
}) {
    const [filter, setFilter] = useState('all'), [detail, setDetail] = useState<Detail | null>(null), [error, setError] = useState(''), [busy, start] = useTransition(), router = useRouter();
    const filters = [['all', 'All'], ['assigned', 'Assigned to me'], ['tagged', 'Tagged'], ['team', 'Team items'], ['overdue', 'Overdue']];
    const inFilter = (i: OnboardingTask, key: string) => key === 'all' || key === 'assigned' && i.assigned || key === 'tagged' && i.tagged || key === 'team' && i.team || key === 'overdue' && i.overdue;
    const open = (id: string) => start(async () => {
        const r = await loadOnboardingTask(id);
        if (r.error)
            setError(r.error);
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
    return <div className="space-y-5"><PageHeader title="My tasks" description="Assigned work, team items and conversations that need your action."/><nav className="flex flex-wrap gap-2 border-b border-border pb-3" aria-label="Task filters">{filters.map(([key, label]) => <Button key={key} variant={key === filter ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter(key!)}>{label} <span className="tabular-nums">{items.filter(i => inFilter(i, key!)).length + (key === 'all' || key === 'assigned' ? existing.length : 0)}</span></Button>)}</nav>{error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
 {detail ? <Card className="space-y-4 p-4"><div className="flex justify-end"><Button variant="outline" onClick={() => setDetail(null)}>Close task details</Button></div><OnboardingCaseView key={detail.case.id + ':' + detail.revision} detail={detail} mode="task"/></Card> : <div className="divide-y divide-border rounded-lg border border-border bg-card">{!items.some(i => inFilter(i, filter)) && (!(filter === 'all' || filter === 'assigned') || !existing.length) && <div className="p-8 text-center text-sm text-muted-foreground">No tasks in this view. Assigned work and mentions appear here automatically.</div>}{items.filter(i => inFilter(i, filter)).map(i => <article key={i.id} className="flex flex-wrap items-center justify-between gap-4 p-4"><div className="min-w-0"><button className="text-left font-medium hover:text-primary hover:underline" onClick={() => open(i.caseId)}>{i.title} for {i.joiner || 'New joiner'}</button><p className="mt-1 text-sm text-muted-foreground">{i.due ? 'Due ' + i.due.split('-').reverse().join('/') : 'Date needed'} · {i.kind === 'team' ? 'Team item' : i.kind === 'approval' ? 'Approval' : i.kind === 'mention' ? 'Mention' : 'Onboarding'}{i.claimedBy && <span> · {i.claimedBy} is on it</span>}{i.overdue && <span className="ml-2 text-destructive">Overdue</span>}</p></div><div className="flex flex-wrap gap-2">{(i.kind === 'checklist' || i.kind === 'team') && (['todo', 'progress', 'done'] as const).map(s => <Button key={s} size="sm" variant={i.status === s ? 'secondary' : 'outline'} disabled={busy || i.locked} onClick={() => command(i, s)}>{s === 'todo' ? 'To do' : s === 'progress' ? 'In progress' : 'Done'}</Button>)}{i.kind === 'approval' && <Button size="sm" disabled={busy} onClick={() => command(i, 'approve')}>Approve all</Button>}{i.kind === 'handover' && <Button size="sm" disabled={busy} onClick={() => command(i, 'handover')}>Done</Button>}{i.kind === 'hrNote' && <Button size="sm" disabled={busy} onClick={() => command(i, 'readNote')}>Mark as read</Button>}{i.kind === 'mention' && <Button size="sm" disabled={busy} variant="outline" onClick={() => start(async () => {
                        const r = await writeOnboardingNote(i.caseId, { id: i.noteId, context: i.context??'requisition', body: '', mentions: [], resolve: true });
                        if (r.error)
                            setError(r.error);
                        else
                            router.refresh();
                    })}>Mark done</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => open(i.caseId)}>{i.kind === 'manualApproval' ? 'Choose an approver' : i.kind === 'owner' ? 'Assign an owner' : i.kind === 'case' ? 'Open case' : 'Review'}</Button>{i.kind === 'acknowledgement' && <Link className="inline-flex items-center text-sm text-primary underline" href="/lifecycle/acknowledgement">Open device acknowledgement</Link>}{i.kind === 'case' && <Link className="inline-flex items-center text-sm text-primary underline" href={'/lifecycle/onboarding/cases/' + i.caseId}>Open onboarding</Link>}</div></article>)}{(filter === 'all' || filter === 'assigned') && existing.map(i => <article key={i.kind + ':' + i.id} className="flex items-center justify-between gap-3 p-4"><div><p className="font-medium">{i.subjectName ?? 'Approval request'}</p><p className="text-sm text-muted-foreground">{i.kind}</p></div><Link className="text-sm text-primary underline" href={i.linkPath}>Review approval</Link></article>)}</div>}</div>;
}
