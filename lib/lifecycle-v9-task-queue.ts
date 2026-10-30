import type { Case, Config } from './lifecycle-v9-model';
import { isResolved } from './lifecycle-v9-model';
import { currentReq, effectiveFacts, equipmentDate, type Case as NativeCase, type Config as NativeConfig } from './onboarding-model';
export type LifecycleQueueRow = {
  id: string; caseId: string; revision: number; owner: 'native' | 'v9'; module: 'onb' | 'off';
  kind: 'checklist' | 'system' | 'device' | 'return' | 'revoke'; taskId: string; title: string; person: string;
  businessGroup: string; company: string; due: string; assignee: string | null; group: string | null;
  status: string; done: boolean; mine: boolean; team: boolean; locked: string | null; document: boolean;
};
/** Presentation only: each row retains the canonical owner, case revision and work ID. */
export function lifecycleQueueRows(cases: Case[], config: Config, native: { config: NativeConfig; rows: { case: NativeCase; revision: number }[] } | null, actor: string, today: string): LifecycleQueueRow[] {
  const out: LifecycleQueueRow[] = [];
  for (const c of cases.filter(c => c.state !== 'pending' && c.state !== 'cancelled')) {
    const base = { caseId: c.id, revision: c.revision, owner: 'v9' as const, module: c.module, person: c.facts.name, businessGroup: c.facts.businessGroup, company: c.facts.company };
    for (const task of c.tasks) out.push({ ...base, id: `v9:${c.id}:task:${task.id}`, kind: 'checklist', taskId: task.id, title: task.name, due: task.dueOn, assignee: task.assignee, group: task.group, status: task.status, done: isResolved(task.status), mine: task.assignee === actor, team: config.groups.some(g => g.id === task.group && g.members.includes(actor)), locked: c.state !== 'submitted' ? 'Case closed' : task.opensOn && task.opensOn > today ? `Opens ${task.opensOn}` : null, document: !!task.documentTemplate });
    for (const item of c.items) out.push({ ...base, id: `v9:${c.id}:item:${item.id}`, kind: item.kind === 'system' ? 'revoke' : 'return', taskId: item.id, title: item.name, due: item.dueOn, assignee: item.assignee, group: item.group, status: item.status, done: isResolved(item.status) || item.status === 'notReturned', mine: item.assignee === actor, team: config.groups.some(g => g.id === item.group && g.members.includes(actor)), locked: c.state !== 'submitted' ? 'Case closed' : null, document: false });
  }
  for (const row of native?.rows ?? []) {
    const c = row.case; if (c.state !== 'submitted') continue;
    const facts = effectiveFacts(c), req = currentReq(c), base = { caseId: c.id, revision: row.revision, owner: 'native' as const, module: 'onb' as const, person: facts.fullName, businessGroup: facts.businessGroup, company: facts.company };
    for (const task of c.tasks) out.push({ ...base, id: `native:${c.id}:task:${task.id}`, kind: 'checklist', taskId: task.id, title: task.name, due: task.dueOn, assignee: task.assignee, group: task.group, status: task.status, done: task.status === 'done', mine: task.assignee === actor, team: native!.config.groups.some(g => g.id === task.group && g.members.includes(actor)), locked: task.gate && !req?.handedAt ? 'After Day 1 handover' : task.opensOn && task.opensOn > today ? `Opens ${task.opensOn}` : null, document: !!task.documentTemplate });
    for (const item of req?.cancelledAt ? [] : req?.items ?? []) {
      if (item.removed || item.approval === 'withdrawn' || item.approval === 'rejected') continue;
      out.push({ ...base, id: `native:${c.id}:item:${item.id}`, kind: item.type, taskId: item.id, title: item.name, due: equipmentDate(c, item), assignee: item.claim, group: item.team, status: item.state, done: item.state === 'ready' || item.state === 'handed', mine: item.claim === actor, team: native!.config.groups.some(g => g.id === item.team && g.members.includes(actor)), locked: item.approval === 'pending' ? 'Awaiting approval' : null, document: false });
    }
  }
  return out.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.person.localeCompare(b.person) || a.id.localeCompare(b.id));
}
