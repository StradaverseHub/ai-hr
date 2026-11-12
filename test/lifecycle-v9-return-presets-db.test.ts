/**
 * d1e26f81 — Return and revoke items auto-assigned to fulfilling teams: presets at submission, round robin across
 * leavers (open offboarding items count toward the limit, migration 5480), the leaver never owning their own items,
 * Day -1/0 dates from the effective last working day, "Set for all items", HR search by company, the release
 * back-fill and authorization. Fictional fixtures only.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { resolveEntitlementsTx } from '../core/entitlements';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addDays, type Case } from '../lib/lifecycle-v9-model';
import { v9Setup, v9Workspace, v9SaveConfig, v9CreateOffboarding, v9Command, v9CaseDetail, v9BackfillReturnPresets, registerAsset, onboardingContext, onboardingSaveConfig, onboardingAssignmentLoadsTx } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';

let base: Base, admin: SessionContext, alex: string, bea: string, otherCompany: string;
const today = todayInKualaLumpur();
async function leaver(name: string) {
  const hired = await hireEmployee(admin, { companyId: base.companyId, departmentId: base.deptA, positionId: base.positionId, employmentType: 'full_time', hiredOn: '2025-01-01', person: { fullName: name, primaryEmail: name.replace(/\W/g, '').toLowerCase() + '@test.invalid' } });
  return { employmentId: hired.employmentId, userId: await createAppUser(base.tenantId, hired.personId, 'employee') };
}
async function staff(name: string) { return (await leaver(name)).userId; }
async function openCase(subject: { employmentId: string }, asset = true) {
  const id = await v9CreateOffboarding(admin, { employmentId: subject.employmentId, type: 'Resignation', noticeDate: today, lastDay: addDays(today, 30) });
  const c = (await v9CaseDetail(admin, id)).case;
  if (asset) await registerAsset(admin, { companyId: base.companyId, assetType: 'laptop', status: 'issued', userName: c.facts.name, userEmployeeNo: c.facts.employeeNo });
  return id;
}
const detail = (id: string) => v9CaseDetail(admin, id);
async function command(id: string, value: Parameters<typeof v9Command>[3], ctx = admin) { await v9Command(ctx, id, (await detail(id)).case.revision, value); return (await detail(id)).case; }

afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); await setModule(base.tenantId, 'lifecycle', 'active'); admin = await entitledCtx(base); await v9Setup(admin);
  alex = await staff('Fictional Alex'); bea = await staff('Fictional Bea');
  otherCompany = randomUUID();
  await owner.client`insert into company(id,tenant_id,legal_name,country,currency) values(${otherCompany}::uuid,${base.tenantId}::uuid,'Fictional other company','MY','MYR')`;
  const config = (await v9Workspace(admin)).config!; for (const workflow of config.workflows) workflow.status = 'draft'; await v9SaveConfig(admin, config.revision, config);
});
async function settings(members: string[], limit = 0) {
  const context = await onboardingContext(admin), native = structuredClone(context.config);
  native.groups.find(group => group.id === native.techGroup)!.members = members; native.groups.find(group => group.id === native.techGroup)!.limit = limit;
  native.catalogue = [
    { id: 'vpn', name: 'Fictional VPN', type: 'system', active: true, rules: {}, workflow: null, team: native.techGroup, card: false },
    { id: 'elsewhere', name: 'Fictional other-company badge', type: 'device', active: true, rules: { company: [otherCompany] }, workflow: null, team: native.techGroup, card: false },
  ];
  await onboardingSaveConfig(admin, context.revision, native);
  return native.techGroup;
}

describe('Return and revoke presets at submission', () => {
  it('assigns by round robin within the team, never the leaver, and takes turns across leavers', async () => {
    const first = await leaver('Fictional First Leaver'), second = await leaver('Fictional Second Leaver');
    const team = await settings([first.userId, alex, bea]);
    const one = await openCase(first);
    await command(one, { type: 'returnSelections', ids: ['vpn'] });
    const submitted = await command(one, { type: 'submit' }), anchor = (await detail(one)).calculation!.lastDay;
    expect(submitted.returnAnchor).toBe(anchor);
    expect(submitted.items.map(i => ({ kind: i.kind, group: i.group, assignee: i.assignee, method: i.method, dueDay: i.dueDay, dueOn: i.dueOn }))).toEqual([
      { kind: 'device', group: team, assignee: alex, method: 'rr', dueDay: -1, dueOn: addDays(anchor, -1) },
      { kind: 'system', group: team, assignee: bea, method: 'rr', dueDay: 0, dueOn: anchor },
    ]);
    expect(submitted.log.filter(l => l.action === 'item.assigned').map(l => [l.userId, l.groupId])).toEqual([[alex, team], [bea, team]]);
    // Open offboarding items now count toward each person's open-task load (migration 5480).
    const loads = await withTenant(admin, onboardingAssignmentLoadsTx);
    expect(Number(loads.find(l => l.user_id === alex)?.task_load)).toBe(1);
    expect(Number(loads.find(l => l.user_id === first.userId)?.task_load)).toBe(0);
    // HR cannot hand the leaver their own item.
    await expect(v9Command(admin, one, (await detail(one)).case.revision, { type: 'assignItem', id: submitted.items[0]!.id, userId: first.userId })).rejects.toThrow('The leaver cannot own their own return and revoke items.');
    // Across leavers: with the first leaver's items open, the next leaver's item goes to the member with fewer.
    await settings([alex, bea]);
    const loaded = await withTenant(admin, onboardingAssignmentLoadsTx);
    expect([alex, bea].map(id => Number(loaded.find(l => l.user_id === id)?.task_load))).toEqual([1, 1]);
    const two = await openCase(second);
    await command(two, { type: 'returnSelections', ids: ['vpn'] });
    expect((await command(two, { type: 'submit' })).items.map(i => i.assignee)).toEqual([alex, bea]);
    const third = await leaver('Fictional Third Leaver'), three = await openCase(third);
    expect((await command(three, { type: 'submit' })).items.map(i => i.assignee)).toEqual([alex]);
    const fourth = await leaver('Fictional Fourth Leaver'), four = await openCase(fourth);
    expect((await command(four, { type: 'submit' })).items.map(i => i.assignee)).toEqual([bea]);
  });

  it('shows why nobody was assigned when everyone is at the limit', async () => {
    const subject = await leaver('Fictional Limited Leaver');
    await settings([alex], 1);
    const busy = await leaver('Fictional Busy Leaver'), busyCase = await openCase(busy);
    await command(busyCase, { type: 'submit' });
    const id = await openCase(subject), c = await command(id, { type: 'submit' });
    expect(c.items[0]).toMatchObject({ assignee: null, assignmentFailure: expect.stringContaining('is at their limit of 1 open tasks.') });
    expect(c.log.find(l => l.action === 'item.assignment_failed')?.detail).toContain('at their limit');
  });

  it('applies pending "Set for all items" at submission and filters HR search to the leaver\'s company', async () => {
    const subject = await leaver('Fictional Preset Leaver'), team = await settings([alex, bea]);
    const facility = 'fictional-facility', context = await onboardingContext(admin), native = structuredClone(context.config);
    native.groups.push({ id: facility, name: 'Fictional Facility', members: [bea], limit: 0 }); await onboardingSaveConfig(admin, context.revision, native);
    const id = await openCase(subject);
    const preview = (await detail(id)).returns!;
    expect(preview.catalogue.map(e => e.id)).toEqual(['vpn']);
    await expect(command(id, { type: 'returnSelections', ids: ['elsewhere'] })).rejects.toThrow('Choose an active item from the existing catalogue.');
    await command(id, { type: 'returnSelections', ids: ['vpn'] });
    expect((await detail(id)).returns!.rows.map(r => [r.kind, r.group, r.method, r.dueDay])).toEqual([['device', team, 'rr', -1], ['system', team, 'rr', 0]]);
    await expect(command(id, { type: 'returnPresets', group: 'missing-group' })).rejects.toThrow('Choose an existing assignment group.');
    await command(id, { type: 'returnPresets', group: facility, due: 2 });
    expect((await detail(id)).returns!.rows.map(r => [r.group, r.dueDay])).toEqual([[facility, 2], [facility, 2]]);
    const c = await command(id, { type: 'submit' }), anchor = (await detail(id)).calculation!.lastDay;
    expect(c.items.map(i => [i.group, i.assignee, i.dueDay, i.dueOn])).toEqual([[facility, bea, 2, addDays(anchor, 2)], [facility, bea, 2, addDays(anchor, 2)]]);
    expect(c.returnPresets).toBeUndefined();
    await expect(command(id, { type: 'returnPresets', due: 1 })).rejects.toThrow('Return presets can change only before submission.');
  });

  it('moves default dates with the effective last working day and keeps fixed dates; Set for all items skips done items', async () => {
    const subject = await leaver('Fictional Moving Leaver'); await settings([alex, bea]);
    const id = await openCase(subject);
    await command(id, { type: 'returnSelections', ids: ['vpn'] });
    let c = await command(id, { type: 'submit' });
    const fixed = addDays(today, 10);
    c = await command(id, { type: 'caseFormSave', values: { revokeMode: 'date', revokeDate: fixed }, reason: 'Fictional early revoke', submit: false });
    expect(c.items.find(i => i.kind === 'system')).toMatchObject({ dueOn: fixed, dueDay: null });
    const override = addDays(today, 20);
    c = await command(id, { type: 'settlementOptions', reason: 'Fictional early release', options: { keepSourceDate: false, offsetLeave: false, override: { date: override, reason: 'Fictional early release', kind: 'earlyRelease' }, reduceEncashment: null } });
    expect(c.returnAnchor).toBe(override);
    expect(c.items.find(i => i.kind === 'device')).toMatchObject({ dueOn: addDays(override, -1), dueDay: -1 });
    expect(c.items.find(i => i.kind === 'system')).toMatchObject({ dueOn: fixed, dueDay: null });
    c = await command(id, { type: 'item', id: c.items.find(i => i.kind === 'system')!.id, status: 'done', reason: 'Fictional revoked' });
    const done = c.items.find(i => i.kind === 'system')!;
    expect(done.status).toBe('done');
    const bulk = await command(id, { type: 'itemsBulk', ids: c.items.map(i => i.id), due: 3 });
    expect(bulk.items.find(i => i.kind === 'device')).toMatchObject({ dueDay: 3, dueOn: addDays(override, 3) });
    expect(bulk.items.find(i => i.id === done.id)).toEqual(done);
    expect(bulk.log.at(-1)).toMatchObject({ action: 'items.bulkUpdated', detail: '1 items · due Day 3' });
  });

  it('refuses the new commands outside the case company HR scope', async () => {
    const subject = await leaver('Fictional Scoped Leaver'); await settings([alex]);
    const id = await openCase(subject), c = (await detail(id)).case;
    const employee: SessionContext = { ...admin, userId: alex, roles: ['employee'], grants: undefined };
    const elsewhere: SessionContext = { ...admin, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: otherCompany }] };
    for (const ctx of [employee, elsewhere]) await expect(v9Command(ctx, id, c.revision, { type: 'returnPresets', due: 1 })).rejects.toThrow();
    const submitted = await command(id, { type: 'submit' });
    for (const ctx of [employee, elsewhere]) await expect(v9Command(ctx, id, submitted.revision, { type: 'itemsBulk', ids: submitted.items.map(i => i.id), due: 1 })).rejects.toThrow();
    expect((await detail(id)).case.revision).toBe(submitted.revision);
  });
});

describe('release back-fill', () => {
  it('fills only Unassigned, not-done items without presets, leaves chosen owners and done items, and is safe to re-run', async () => {
    const subject = await leaver('Fictional Legacy Leaver'), team = await settings([alex, bea]);
    const id = await openCase(subject);
    await command(id, { type: 'returnSelections', ids: ['vpn'] });
    const c = await command(id, { type: 'submit' });
    // Recreate the pre-release shape: no presets, everything due on the revoke date.
    const legacy = structuredClone(c) as Case;
    legacy.items = [
      { ...c.items[0]!, assignee: null, dueOn: c.revokeDate },
      { ...c.items[1]!, assignee: bea, dueOn: c.revokeDate },
      { ...c.items[0]!, id: 'legacy-done', status: 'done', assignee: null, dueOn: c.revokeDate },
      { ...c.items[1]!, id: 'legacy-moved', assignee: null, dueOn: addDays(today, 5) },
    ].map(item => { const copy: Record<string, unknown> = { ...item }; for (const key of ['method', 'dueDay', 'assignmentFailure', 'catalogueId', 'providedBy']) delete copy[key]; return copy as unknown as Case['items'][number]; });
    delete legacy.returnAnchor;
    await owner.client`update lc_v9_case set data=${JSON.stringify(legacy)}::jsonb where id=${id}::uuid`;
    const ctx: SessionContext = { tenantId: base.tenantId, roles: ['hr_admin'], entitlements: await owner.db.transaction(tx => resolveEntitlementsTx(tx, base.tenantId)) };
    const dry = await v9BackfillReturnPresets(ctx, owner, { apply: false });
    expect(dry).toEqual({ cases: 1, items: 2, assigned: 2, updated: 0, failed: 0 });
    expect((await detail(id)).case.items).toEqual(legacy.items);
    const applied = await v9BackfillReturnPresets(ctx, owner, { apply: true });
    expect(applied).toEqual({ cases: 1, items: 2, assigned: 2, updated: 1, failed: 0 });
    const after = (await detail(id)).case, anchor = (await detail(id)).calculation!.lastDay;
    expect(after.items[0]).toMatchObject({ group: team, method: 'rr', dueDay: -1, dueOn: addDays(anchor, -1), assignee: expect.any(String) });
    expect(after.items[1]).toEqual(legacy.items[1]);
    expect(after.items[2]).toEqual(legacy.items[2]);
    expect(after.items[3]).toMatchObject({ method: 'rr', dueDay: null, dueOn: addDays(today, 5) });
    expect(after.log.at(-1)).toMatchObject({ action: 'returns.presetsApplied', actor: { id: 'system', name: 'System' } });
    const events = await owner.client`select event_type from domain_event where tenant_id=${base.tenantId}::uuid and aggregate_id=${id}::uuid and event_type='lifecycle-v9.returnsPresetsApplied'`;
    expect(events).toHaveLength(1);
    expect(await v9BackfillReturnPresets(ctx, owner, { apply: true })).toEqual({ cases: 0, items: 0, assigned: 0, updated: 0, failed: 0 });
    expect((await detail(id)).case.revision).toBe(after.revision);
    await expect(v9BackfillReturnPresets(admin, owner, { apply: true })).rejects.toThrow('storage owner');
  });
});
