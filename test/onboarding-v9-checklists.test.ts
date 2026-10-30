import { expect, it } from 'vitest';
import { onboardingV9Checklists } from '../lib/onboarding-v9-checklists';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';
import { projectNativeCase, nativeDocumentState } from '../lib/lifecycle-v9-native';
import * as Native from '../lib/onboarding-model';

it('projects source definitions in order with their owner, matching rules and linked document semantics', () => {
  const definitions = v9Defaults().checklists.filter(checklist => checklist.module === 'onb');
  const before = structuredClone(definitions);
  const projected = onboardingV9Checklists({ revision: 7, owner: 'real-owner', at: '2026-10-29T03:00:00Z', checklists: definitions });
  expect(projected.map(c => c.id)).toEqual(definitions.map(c => c.id));
  expect(projected[0].owner).toBe('real-owner');
  expect(projected[0].createdAt).toBe('2026-10-29T03:00:00.000Z');
  expect(projected[0].rules).toEqual(definitions[0].rules);
  expect(projected[0].tasks.map(task => ({ by: task.by, due: task.due, opens: task.opens, template: task.documentTemplate, action: task.documentAction, gate: task.gate }))).toEqual(definitions[0].tasks.map(task => ({ by: task.by === 'employee' ? 'joiner' : task.by, due: task.due, opens: task.opens, template: task.documentTemplate, action: task.documentAction, gate: false })));
  projected[0].rules.company = ['changed'];
  expect(definitions).toEqual(before);
});
it('requires an actual recorded owner and refuses offboarding-only matching dimensions', () => {
  const checklist = v9Defaults().checklists.find(checklist => checklist.module === 'onb')!;
  expect(() => onboardingV9Checklists({ revision: 1, owner: null, at: '2026-10-29T03:00:00Z', checklists: [checklist] })).toThrow('owner is unavailable');
  expect(() => onboardingV9Checklists({ revision: 1, owner: 'owner', at: '2026-10-29T03:00:00Z', checklists: [{ ...checklist, rules: { caseType: ['Resignation'] } }] })).toThrow('only available for offboarding');
});
it('prevents manual completion of a document-linked native task while keeping plain native tasks actionable', () => {
  const actor: Native.Actor = { id: 'actual-assignee', name: 'Assignee', module: false, hr: false, master: false };
  const env: Native.Environment = { today: '2026-10-29', now: '2026-10-29T03:00:00Z', id: () => 'event', nextNumber: () => '', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: [actor.id] };
  const c = Native.blankCase('case', 'OB-1', 'draft', { fullName: 'Fictional joiner', joinDate: env.today }, env);
  c.state = 'submitted';
  c.tasks = [{ checklistId: 'source', checklistName: 'Source', assignedAt: env.now, id: 'doc', name: 'Complete form', by: 'joiner', group: '', method: 'manual', opens: null, due: 1, gate: false, documentTemplate: 'form', documentAction: 'completed', assignee: actor.id, status: 'todo', dueOn: env.today, opensOn: null, completedAt: null, completedBy: null, failure: null }];
  expect(() => Native.setTask(Native.defaultConfig('owner'), c, 'doc', 'done', actor, env)).toThrow('linked document');
  expect(c.tasks[0].status).toBe('todo');
  c.tasks[0].documentTemplate = null;
  Native.setTask(Native.defaultConfig('owner'), c, 'doc', 'done', actor, env);
  expect(c.tasks[0]).toMatchObject({ status: 'done', completedBy: actor.id, completedAt: env.now });
});

it('projects the same native identity and tasks without inventing an employment or storing a duplicate case', () => {
  const env: Native.Environment = { today: '2026-10-29', now: '2026-10-29T03:00:00Z', id: () => 'event', nextNumber: () => '', leave: {}, taskLoads: {}, lastTaskAssignment: {}, pendingApprovals: {}, lifetimeApprovals: {}, users: [] };
  const c = Native.blankCase('actual-native-case', 'OB-1', 'actual-draft', { fullName: 'Fictional joiner', joinDate: env.today, supervisor: 'supervisor-employment' }, env);
  const before = structuredClone(c);
  const projection = projectNativeCase(c, 7, null, null, 'linked-supervisor-user');
  expect(projection).toMatchObject({ id: c.id, number: c.number, revision: 7, state: 'pending', facts: { employmentId: '', personId: '', employeeUserId: null, supervisorUserId: 'linked-supervisor-user' } });
  expect(nativeDocumentState(projection)).not.toHaveProperty('facts');
  expect(nativeDocumentState(projection)).not.toHaveProperty('tasks');
  expect(nativeDocumentState(projection)).not.toHaveProperty('id');
  expect(c).toEqual(before);
});
