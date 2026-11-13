/** d1e26f81 — Return and revoke presets, round robin without the leaver, Day -1/0 dates and "Set for all items". */
import { describe, expect, it } from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import { offeredToCompany, plannedDue, returnRows, type ReturnSources } from '../lib/lifecycle-v9-return-presets';
import { bulkAssignmentProblem, EQUIPMENT_BULK_LABELS, RETURN_BULK_LABELS } from '../lib/lifecycle-bulk-assignment';

function fixture() {
  let sequence = 0;
  const loads: Record<string, number> = {};
  const env: M.Environment = { today: '2026-12-01', now: '2026-12-01T00:00:00Z', actor: { id: 'hr', name: 'People Ops' }, nextId: () => `id-${++sequence}`, onLeave: () => false, openLoad: id => loads[id] ?? 0, lastAssigned: () => 0, eligibleUser: () => true, userName: id => 'Name of ' + id, mergeValues: {} };
  const c = { version: 9, id: 'case', number: 'OFB-1', module: 'off', revision: 1, state: 'submitted', facts: { name: 'Leaver', employeeNo: 'EMP-1', employmentId: 'employment', personId: 'person', joinDate: '2024-01-01', lastDay: '2026-12-10', noticeDate: '2026-11-10', employeeUserId: 'leaver', supervisorUserId: 'manager', pbpUserId: null, taUserId: null, businessGroup: 'bg', company: 'company-a', department: 'dept', grade: 'g', employmentType: 'permanent', title: 't', caseType: 'Resignation' }, checklistId: null, checklistName: '', override: 'automatic', tasks: [], items: [], documents: [], runs: [], mails: [], files: [], pmChanges: [], log: [], sourceRevision: 'r', submittedAt: env.now, closedAt: null, closedBy: null, closeReason: '', cancelReason: '', revokeDate: '2026-12-10', finalFigures: null, review: null } as unknown as M.Case;
  const config = { version: 9, revision: 1, checklists: [], templates: [], emails: [], workflows: [], peopleOpsGroup: null, bpRules: [], groups: [{ id: 'group-tech', name: 'Group Tech', members: ['leaver', 'alex', 'bea'], limit: 2 }, { id: 'facility', name: 'Facility', members: ['fay'], limit: 4 }] } as unknown as M.Config;
  const sources: ReturnSources = {
    techGroup: 'group-tech',
    assets: [{ id: 'asset-1', code: 'LT-1', model: 'Fictional laptop', assetType: 'laptop' }],
    holdings: [
      { caseId: 'onb', requestId: 'req', requestNumber: 'IT-REQ-0006', itemId: 'm365-item', catalogueId: 'm365', name: 'Microsoft 365', kind: 'system', group: 'old-team', claim: 'alex', handedAt: '2026-10-11T03:00:00Z', card: false },
      { caseId: 'onb', requestId: 'req', requestNumber: 'IT-REQ-0006', itemId: 'card-item', catalogueId: 'card', name: 'Access Card', kind: 'device', group: 'group-tech', claim: 'fay', handedAt: '2026-10-11T03:00:00Z', card: true },
      { caseId: 'onb', requestId: 'req', requestNumber: 'IT-REQ-0006', itemId: 'retired-item', catalogueId: 'retired', name: 'Retired tool', kind: 'system', group: 'group-tech', claim: null, handedAt: null, card: false },
      { caseId: 'onb', requestId: 'req', requestNumber: 'IT-REQ-0006', itemId: 'gone-item', catalogueId: 'gone', name: 'Deleted-team item', kind: 'device', group: 'deleted-team', claim: null, handedAt: null, card: false },
    ],
    catalogue: [
      { id: 'm365', name: 'Microsoft 365', kind: 'system', group: 'group-tech', active: true, card: false, companies: [] },
      { id: 'card', name: 'Access Card', kind: 'device', group: 'facility', active: true, card: true, companies: [] },
      { id: 'retired', name: 'Retired tool', kind: 'system', group: 'facility', active: false, card: false, companies: [] },
      { id: 'gone', name: 'Deleted-team item', kind: 'device', group: 'deleted-team', active: true, card: false, companies: [] },
      { id: 'kingdee', name: 'Kingdee', kind: 'device', group: 'group-tech', active: true, card: false, companies: ['company-b'] },
    ],
    selections: [],
  };
  return { c, config, env, sources, loads };
}

describe('Return and revoke presets', () => {
  it('takes the team from settings, keeps a retired entry\'s last team and leaves a deleted group unassigned', () => {
    const { c, config, sources } = fixture();
    const rows = returnRows(c, config, sources);
    expect(rows.map(r => [r.name, r.kind, r.group, r.dueDay, r.cardStep ?? null])).toEqual([
      ['LT-1 · Fictional laptop', 'device', 'group-tech', -1, null],
      ['Microsoft 365', 'system', 'group-tech', 0, null],
      ['Access Card', 'device', 'facility', -1, 'collect'],
      ['Access Card', 'system', 'group-tech', 0, 'deactivate'],
      ['Retired tool', 'system', 'facility', 0, null],
      ['Deleted-team item', 'device', null, -1, null],
    ]);
    expect(rows[1]).toMatchObject({ catalogueId: 'm365', providedBy: { group: 'old-team', userId: 'alex', at: '2026-10-11T03:00:00Z' }, nativeSource: { itemId: 'm365-item' }, method: 'rr' });
    // The collect row carries the issuing record (recovery happens there); the deactivate row has no source.
    expect(rows[2]!.nativeSource).toMatchObject({ itemId: 'card-item' }); expect(rows[3]!.nativeSource).toBeUndefined();
    expect(rows[2]!.pairKey).toBe(rows[3]!.pairKey);
  });
  it('keeps an unticked access card as one row', () => {
    const { c, config, sources } = fixture();
    sources.catalogue.find(e => e.id === 'card')!.card = false;
    expect(returnRows(c, config, sources).filter(r => r.name === 'Access Card')).toHaveLength(1);
  });
  it('applies pending presets by preview id', () => {
    const { c, config, sources } = fixture();
    c.returnPresets = { 'onboarding:m365-item': { group: 'facility', method: 'manual', due: 3 } };
    expect(returnRows(c, config, sources).find(r => r.previewId === 'onboarding:m365-item')).toMatchObject({ group: 'facility', method: 'manual', dueDay: 3 });
  });
  it('dates physical items Day -1 and system access Day 0 from the anchor, or the fixed revoke date', () => {
    const { c } = fixture();
    expect(plannedDue(c, { kind: 'device', dueDay: -1, previewId: 'a' }, '2026-12-10', undefined)).toEqual({ dueOn: '2026-12-09', dueDay: -1 });
    expect(plannedDue(c, { kind: 'system', dueDay: 0, previewId: 'b' }, '2026-12-10', undefined)).toEqual({ dueOn: '2026-12-10', dueDay: 0 });
    c.revokeMode = 'date'; c.revokeDate = '2026-12-05';
    expect(plannedDue(c, { kind: 'system', dueDay: 0, previewId: 'b' }, '2026-12-10', undefined)).toEqual({ dueOn: '2026-12-05', dueDay: null });
    expect(plannedDue(c, { kind: 'device', dueDay: -1, previewId: 'a' }, '2026-12-10', undefined)).toEqual({ dueOn: '2026-12-09', dueDay: -1 });
  });
  it('offers HR search only entries without a Company rule or naming the leaver\'s company', () => {
    const { sources } = fixture();
    expect(sources.catalogue.filter(e => offeredToCompany(e, 'company-a')).map(e => e.id)).toEqual(['m365', 'card', 'retired', 'gone']);
    expect(offeredToCompany(sources.catalogue.find(e => e.id === 'kingdee')!, 'company-b')).toBe(true);
  });
});

describe('Round robin without the leaver', () => {
  it('never picks the leaver, spreads within a case and records the reason when nobody can take an item', () => {
    const { c, config, env, loads } = fixture();
    loads.alex = 1; loads.bea = 1;
    const extra: Record<string, number> = {};
    const items: M.Item[] = ['one', 'two', 'three'].map(id => ({ id, name: id, kind: 'system', sourceId: null, group: 'group-tech', assignee: null, dueOn: '2026-12-10', status: 'todo', reason: '', method: 'rr', dueDay: 0 }));
    for (const item of items) M.assignReturnItem(c, config, item, env, extra);
    expect(items.map(i => i.assignee)).toEqual(['alex', 'bea', null]);
    expect(items[2]!.assignmentFailure).toBe('Everyone available in Group Tech is at their limit of 2 open tasks.');
    expect(c.log.map(l => l.action)).toEqual(['item.assigned', 'item.assigned', 'item.assignment_failed']);
    expect(c.log[0]).toMatchObject({ userId: 'alex', groupId: 'group-tech' });
    // A team of only the leaver has nobody eligible.
    config.groups[0]!.members = ['leaver'];
    const solo: M.Item = { ...items[0]!, id: 'solo', assignee: null };
    M.assignReturnItem(c, config, solo, env, {});
    expect(solo).toMatchObject({ assignee: null, assignmentFailure: 'No eligible members in Group Tech.' });
  });
  it('leaves the leaver out of offboarding group tasks at submission', () => {
    const { c, config, env } = fixture();
    c.state = 'pending'; config.groups[0]!.limit = 0;
    config.checklists = [{ id: 'exit', name: 'Exit', module: 'off', rules: {}, tasks: [{ id: 'wipe', name: 'Wipe laptop', by: 'group', group: 'group-tech', mode: 'rr', opens: null, due: 0, required: false, documentTemplate: null, documentAction: 'completed' }] }];
    M.submit(c, config, env);
    expect(c.tasks[0]!.assignee).toBe('alex');
  });
});

describe('Set for all items on a submitted case', () => {
  function submitted() {
    const f = fixture(); f.config.groups[0]!.limit = 0;
    f.c.returnAnchor = '2026-12-10';
    f.c.items = [
      { id: 'open', name: 'Open', kind: 'device', sourceId: null, group: 'group-tech', assignee: 'alex', dueOn: '2026-12-09', status: 'todo', reason: '', method: 'rr', dueDay: -1 },
      { id: 'manual', name: 'Manual', kind: 'system', sourceId: null, group: 'group-tech', assignee: 'bea', dueOn: '2026-12-10', status: 'progress', reason: '', method: 'manual', dueDay: 0 },
      { id: 'done', name: 'Done', kind: 'device', sourceId: null, group: 'group-tech', assignee: 'alex', dueOn: '2026-12-09', status: 'done', reason: '', method: 'rr', dueDay: -1 },
      { id: 'skip', name: 'Not needed', kind: 'device', sourceId: null, group: 'group-tech', assignee: null, dueOn: '2026-12-09', status: 'notNeeded', reason: 'n/a', method: 'rr', dueDay: -1 },
      { id: 'lost', name: 'Not returned', kind: 'device', sourceId: null, group: 'group-tech', assignee: 'alex', dueOn: '2026-12-09', status: 'notReturned', reason: 'lost', method: 'rr', dueDay: -1 },
    ];
    return f;
  }
  it('a team change reassigns round-robin items in the new team and skips done, not needed and not returned', () => {
    const { c, config, env } = submitted(), before = structuredClone(c.items.slice(2));
    expect(M.bulkItems(c, config, { ids: c.items.map(i => i.id), group: 'facility', due: 2 }, env)).toBe(2);
    expect(c.items[0]).toMatchObject({ group: 'facility', assignee: 'fay', dueDay: 2, dueOn: '2026-12-12' });
    expect(c.items[1]).toMatchObject({ group: 'facility', assignee: null, method: 'manual', assignmentFailure: 'Manual assignment is required.', dueOn: '2026-12-12' });
    expect(c.items.slice(2)).toEqual(before);
    expect(c.log.at(-1)).toMatchObject({ action: 'items.bulkUpdated', detail: '2 items · team Facility · due Day 2' });
  });
  it('refuses invalid changes with the shared validation', () => {
    const { c, config, env } = submitted();
    expect(() => M.bulkItems(c, config, { ids: ['open'] }, env)).toThrow('Choose items and at least one return change.');
    expect(() => M.bulkItems(c, config, { ids: ['open'], group: 'missing' }, env)).toThrow('Choose an existing assignment group.');
    expect(() => M.bulkItems(c, config, { ids: ['open'], due: 10000 }, env)).toThrow('Choose a return due day from -999 to 9999.');
    expect(() => M.bulkItems(c, config, { ids: ['done'], due: 1 }, env)).toThrow('No open return items match this change.');
    c.state = 'pending';
    expect(() => M.bulkItems(c, config, { ids: ['open'], due: 1 }, env)).toThrow('This case is not open.');
    expect(bulkAssignmentProblem({ ids: ['a', 'a'], due: 1 }, [], EQUIPMENT_BULK_LABELS)).toBe('Choose items and at least one equipment change.');
    expect(bulkAssignmentProblem({ ids: ['a'], method: 'other' }, [], RETURN_BULK_LABELS)).toBe('Choose Round robin or Manual.');
  });
});
