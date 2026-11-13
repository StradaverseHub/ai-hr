/**
 * 259c6162 — routing rules managed with Assignment groups: delete protection for groups that routing rows point to,
 * delete protection with re-pointing for routing rules used by approval steps, the master-only boundary and the
 * Audit Trail entries. Fictional fixtures only.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, like } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { saveEmployeeDraft } from '../core/employee-draft';
import { hireEmployee } from '../core/org';
import { onboardingSetup, onboardingContext, onboardingList, onboardingCommand, onboardingSaveConfig } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import { dayDate, type Case } from '../lib/onboarding-model';

describe('259c6162 routing rules in Assignment groups', () => {
    let b: Base, admin: SessionContext, approver: string, backup: string;
    afterAll(closeAll);
    beforeEach(async () => {
        await resetDb();
        b = await seedBase();
        await setModule(b.tenantId, 'lifecycle', 'active');
        admin = await entitledCtx(b);
        const hire = async (name: string) => { const h = await hireEmployee(admin, { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: dayDate(todayInKualaLumpur(), -30), person: { fullName: name, primaryEmail: name.replace(/\W/g, '').toLowerCase() + '@test.invalid' } }); return createAppUser(b.tenantId, h.personId, 'employee'); };
        approver = await hire('Fictional Approver'); backup = await hire('Fictional Backup');
        await onboardingSetup(admin);
        const context = await onboardingContext(admin), config = structuredClone(context.config);
        config.groups.find(g => g.id === 'tech-bp')!.members = [approver];
        config.groups.push({ id: 'regional-bp', name: 'Regional BP', members: [backup], limit: 8 });
        config.routings = [
            { id: 'main-routing', name: 'Main routing', rows: [{ id: 'default', rules: {}, group: 'tech-bp' }] },
            { id: 'regional-routing', name: 'Regional routing', rows: [{ id: 'regional-default', rules: {}, group: 'regional-bp' }] },
        ];
        config.workflows[0]!.steps = [{ id: 'route', label: 'Business partner', type: 'routing', target: 'main-routing', method: 'rr' }];
        config.catalogue = [{ id: 'vpn', name: 'VPN', type: 'system', active: true, rules: {}, workflow: 'standard', team: 'group-tech', card: false }];
        await onboardingSaveConfig(admin, context.revision, config);
    });
    const configRow = async () => (await owner.db.select().from(schema.lcOnboardingConfig).where(eq(schema.lcOnboardingConfig.tenantId, b.tenantId)))[0]!;
    const routingEvents = () => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, b.tenantId), like(schema.domainEvent.eventType, 'onboarding.routing.%'))).orderBy(asc(schema.domainEvent.occurredAt), asc(schema.domainEvent.eventType));

    it('refuses to delete a group a routing row points to without a replacement, and re-points rows with one', async () => {
        const before = await onboardingContext(admin), input = structuredClone(before.config);
        input.groups = input.groups.filter(g => g.id !== 'regional-bp');
        await expect(onboardingSaveConfig(admin, before.revision, input)).rejects.toThrow('This group is used by routing rules: Regional routing. Choose a replacement group before deleting it.');
        expect((await configRow()).revision).toBe(before.revision);
        expect((await onboardingContext(admin)).config.groups.some(g => g.id === 'regional-bp')).toBe(true);
        await onboardingSaveConfig(admin, before.revision, input, { 'regional-bp': 'tech-bp' });
        const after = await onboardingContext(admin);
        expect(after.revision).toBe(before.revision + 1);
        expect(after.config.routings.find(r => r.id === 'regional-routing')!.rows).toEqual([{ id: 'regional-default', rules: {}, group: 'tech-bp' }]);
        const updated = (await routingEvents()).filter(e => e.eventType === 'onboarding.routing.updated');
        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ aggregateType: 'onboarding-config', aggregateId: b.tenantId, subjectEmploymentId: null, actorId: admin.userId, payload: { routingId: 'regional-routing', revision: before.revision + 1, rowsChanged: [{ rowId: 'regional-default', before: { group: 'regional-bp' }, after: { group: 'tech-bp' } }] } });
    });

    it('refuses to delete a used routing rule without re-pointing; re-pointing keeps waiting approvals unchanged', async () => {
        await saveEmployeeDraft(admin, { data: { profile: { fullName: 'Fictional Joiner', primaryEmail: 'joiner@test.invalid' }, employment: { companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, hiredOn: dayDate(todayInKualaLumpur(), 8) } }, currentStep: 1 });
        let [row] = await onboardingList(admin);
        await onboardingCommand(admin, row!.case.id, row!.revision, { type: 'save', patch: { hiring: 'new_hire', local: { supervisor: 'Manager' }, selected: ['vpn'] } });
        [row] = await onboardingList(admin);
        await onboardingCommand(admin, row!.case.id, row!.revision, { type: 'submit' });
        const pendingStep = async () => { const [stored] = await owner.db.select().from(schema.lcOnboardingCase).where(eq(schema.lcOnboardingCase.tenantId, b.tenantId)); const c = stored!.data as Case; return c.requisitions.at(-1)!.items[0]!.steps[0]!; };
        expect(await pendingStep()).toMatchObject({ group: 'tech-bp', user: approver, status: 'pending' });

        const before = await onboardingContext(admin), dropped = structuredClone(before.config);
        dropped.routings = dropped.routings.filter(r => r.id !== 'main-routing');
        await expect(onboardingSaveConfig(admin, before.revision, dropped)).rejects.toThrow('This routing rule is used by approval steps: Standard approval · Business partner. Choose a replacement routing rule before deleting it.');
        expect((await configRow()).revision).toBe(before.revision);

        dropped.workflows[0]!.steps[0]!.target = 'regional-routing';
        await onboardingSaveConfig(admin, before.revision, dropped);
        const after = await onboardingContext(admin);
        expect(after.config.routings.map(r => r.id)).toEqual(['regional-routing']);
        expect(after.config.workflows[0]!.steps[0]).toMatchObject({ id: 'route', type: 'routing', target: 'regional-routing' });
        expect(await pendingStep()).toMatchObject({ group: 'tech-bp', user: approver, status: 'pending' });
        const deleted = (await routingEvents()).filter(e => e.eventType === 'onboarding.routing.deleted');
        expect(deleted.map(e => e.payload)).toEqual([{ routingId: 'main-routing', name: 'Main routing', replacementRoutingId: 'regional-routing', repointedSteps: [{ workflowId: 'standard', stepId: 'route' }], revision: before.revision + 1 }]);
    });

    it('records routing creation and edits, and keeps routings out of reach of a master-only actor', async () => {
        // The setup save already recorded the two fixture routings as created.
        const setup = await routingEvents();
        expect(setup.map(e => [e.eventType, (e.payload as { routingId: string }).routingId]).sort()).toEqual([['onboarding.routing.created', 'main-routing'], ['onboarding.routing.created', 'regional-routing']]);
        const fresh = async () => (await routingEvents()).filter(e => !setup.some(s => s.id === e.id));
        const before = await onboardingContext(admin), input = structuredClone(before.config);
        input.routings.push({ id: 'new-routing', name: 'Fictional new routing', rows: [{ id: 'n1', rules: {}, group: 'tech-bp' }] });
        input.routings[0]!.name = 'Main routing renamed';
        await onboardingSaveConfig(admin, before.revision, input);
        const events = await fresh();
        expect(events.map(e => [e.eventType, (e.payload as { routingId: string }).routingId]).sort()).toEqual([['onboarding.routing.created', 'new-routing'], ['onboarding.routing.updated', 'main-routing']]);
        expect(events.find(e => e.eventType === 'onboarding.routing.updated')!.payload).toMatchObject({ name: { before: 'Main routing', after: 'Main routing renamed' }, rowsAdded: [], rowsRemoved: [], rowsChanged: [] });

        // Master Admin without Onboarding module access: groups and access only, as before.
        const current = await onboardingContext(admin), masterOnly = structuredClone(current.config);
        masterOnly.access.onboarding = [approver];
        await onboardingSaveConfig(admin, current.revision, masterOnly);
        const locked = await onboardingContext(admin);
        expect(locked.actor).toMatchObject({ master: true, module: false });
        const edit = structuredClone(locked.config);
        edit.routings[0]!.rows[0]!.group = 'regional-bp';
        await expect(onboardingSaveConfig(admin, locked.revision, edit)).rejects.toThrow('Grant yourself Onboarding access before editing its settings.');
        const removeGroup = structuredClone(locked.config);
        removeGroup.groups = removeGroup.groups.filter(g => g.id !== 'regional-bp');
        await expect(onboardingSaveConfig(admin, locked.revision, removeGroup)).rejects.toThrow('This group is used by routing rules: Regional routing.');
        expect((await configRow()).revision).toBe(locked.revision);
        expect(await fresh()).toHaveLength(2);
    });
});
