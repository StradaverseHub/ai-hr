'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { lifecycleQueueRows, type LifecycleQueueRow } from '@/lib/lifecycle-v9-task-queue';
import type { Case, Config } from '@/lib/lifecycle-v9-model';
import type { NativeJoinersData } from './native-joiners';
import { changeOnboarding } from '@/app/lifecycle/onboarding/v31-actions';
import { commandV9 } from './actions';
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('/') : '—';
const statusName = (value: string) => ({ todo: 'To do', progress: 'In progress', done: 'Done', notNeeded: 'Not needed', notReturned: 'Not returned', ready: 'Ready', handed: 'Handed over', printed: 'Printed' } as Record<string,string>)[value] ?? value;
export function TaskQueue({ cases, config, native, actor, users, company, search, openCase }: { cases: Case[]; config: Config; native: NativeJoinersData | null; actor: string; users: { id: string; name: string }[]; company: string; search: string; openCase: (id: string) => void }) {
  const [tab, setTab] = useState<'mine' | 'teams' | 'done'>('mine'), [due, setDue] = useState('all'), [module, setModule] = useState('all'), [error, setError] = useState(''), [busy, start] = useTransition(), router = useRouter(), today = todayInKualaLumpur();
  const rows = lifecycleQueueRows(cases, config, native, actor, today).filter(row => (!company || row.company === company) && (!search || `${row.title} ${row.person}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())));
  const inTab = (row: LifecycleQueueRow, value: typeof tab) => value === 'done' ? row.done && (row.mine || row.team) : !row.done && (value === 'mine' ? row.mine : row.team);
  const filtered = rows.filter(row => inTab(row, tab) && (module === 'all' || row.module === module) && (due === 'all' || due === 'today' && row.due === today || due === 'overdue' && !!row.due && row.due < today));
  function update(row: LifecycleQueueRow, status: 'todo' | 'progress' | 'done') {
    start(async () => {
      setError('');
      try {
        const result = row.owner === 'native' ? await changeOnboarding(row.caseId, row.revision, { type: 'task', taskId: row.taskId, status }) : await commandV9(row.caseId, row.revision, { type: row.kind === 'checklist' ? 'task' : 'item', id: row.taskId, status, reason: '' });
        if (result.error) setError(result.error); else router.refresh();
      } catch { setError('The task could not be saved. Your saved task is unchanged. Try again.'); }
    });
  }
  function reassign(row: LifecycleQueueRow, userId: string) {
    start(async () => {
      setError('');
      try {
        const result = row.owner === 'native' ? await changeOnboarding(row.caseId, row.revision, row.kind === 'checklist' ? { type: 'assignTask', taskId: row.taskId, user: userId, roundRobin: false } : { type: 'equipmentAssignee', itemId: row.taskId, user: userId, roundRobin: false }) : await commandV9(row.caseId, row.revision, { type: row.kind === 'checklist' ? 'assign' : 'assignItem', id: row.taskId, userId });
        if (result.error) setError(result.error); else router.refresh();
      } catch { setError('The assignment could not be saved. Try again.'); }
    });
  }
  function assignment(row: LifecycleQueueRow) {
    const name = users.find(user => user.id === row.assignee)?.name ?? (row.assignee ? 'Unavailable person' : 'Unassigned');
    if (row.done || !row.group || row.locked === 'Case closed') return name;
    const groups = row.owner === 'native' ? native?.config.groups ?? [] : config.groups;
    const members = users.filter(user => groups.some(group => group.id === row.group && group.members.includes(user.id)));
    return <select aria-label={`Assignee for ${row.title} · ${row.person}`} value={row.assignee ?? ''} disabled={busy || !members.length} onChange={event => reassign(row, event.target.value)}><option value="" disabled>Unassigned</option>{row.assignee && !members.some(member => member.id === row.assignee) && <option value={row.assignee} disabled>{name}</option>}{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select>;
  }
  return <div className="v9-stack"><div className="v9-actions" role="tablist" aria-label="Task queues">{(['mine', 'teams', 'done'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} className={'v9-button' + (tab === value ? ' v9-button-primary' : '')} onClick={() => setTab(value)}>{value === 'mine' ? 'Mine' : value === 'teams' ? 'My teams' : 'Done'} <span>{rows.filter(row => inTab(row, value)).length}</span></button>)}</div>
    <div className="v9-panel v9-filters"><label className="v9-field"><span>Module</span><select value={module} onChange={event => setModule(event.target.value)}><option value="all">All modules</option><option value="onb">Onboarding</option><option value="off">Offboarding</option></select></label><label className="v9-field"><span>Due by</span><select value={due} onChange={event => setDue(event.target.value)}><option value="all">All dates</option><option value="today">Today</option><option value="overdue">Overdue</option></select></label></div>
    {error && <p className="v9-notice v9-error" role="alert">{error}</p>}
    <div className="v9-table-scroll"><table className="v9-table"><thead><tr>{['Task', 'Person', 'Module', 'Assigned to', 'Due by', 'Status', ''].map((heading, index) => <th key={index}>{heading}</th>)}</tr></thead><tbody>{filtered.map(row => <tr key={row.id}><td><strong>{row.title}</strong><div className="v9-muted">{row.kind === 'checklist' ? 'Checklist task' : row.kind === 'revoke' ? 'Revoke access' : row.kind === 'return' ? 'Return equipment' : row.kind === 'system' ? 'Access system' : 'Device or facility access'}{row.locked ? ` · ${row.locked.startsWith('Opens ') ? 'Opens ' + date(row.locked.slice(6)) : row.locked}` : ''}</div></td><td>{row.person}</td><td>{row.module === 'onb' ? 'Onboarding' : 'Offboarding'}</td><td>{assignment(row)}</td><td>{date(row.due)}{row.due && row.due < today && !row.done && <div className="v9-muted">Overdue</div>}</td><td>{(row.kind === 'checklist' || row.owner === 'v9') && !row.done && row.mine && !row.document ? <select aria-label={`Status for ${row.title} · ${row.person}`} value={row.status} disabled={busy || !!row.locked} onChange={event => update(row, event.target.value as 'todo' | 'progress' | 'done')}><option value="todo">To do</option><option value="progress">In progress</option><option value="done">Done</option></select> : <span className="v9-badge">{statusName(row.status)}</span>}</td><td>{row.owner === 'native' ? <Link className="v9-link" href={row.kind === 'checklist' ? `/lifecycle/v9/onboarding/${row.caseId}` : `/lifecycle/requisitions/onboarding/${row.caseId}`}>Review</Link> : <button type="button" className="v9-link" onClick={() => openCase(row.caseId)}>Review</button>}</td></tr>)}{!filtered.length && <tr><td colSpan={7}>No tasks in this view.</td></tr>}</tbody></table></div></div>;
}
