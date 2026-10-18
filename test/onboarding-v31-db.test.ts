import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { saveEmployeeDraft, discardEmployeeDraft } from '../core/employee-draft';
import { hireEmployee } from '../core/org';
import { onboardingSetup, onboardingContext, onboardingList, onboardingDetail, onboardingCommand, onboardingSaveConfig, onboardingTasks, onboardingNote, sweepOnboarding, onboardingNotices, onboardingReadNotice, createOnboardingCase, caseHistory } from '../packs/lifecycle/service';
import { closeAll, resetDb, seedBase, setModule, entitledCtx, owner, createAppUser, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import { dayDate } from '../lib/onboarding-model';
describe('V3.1 onboarding database and authorization', () => {
    let b: Base, admin: SessionContext, tech: SessionContext, other: SessionContext;
    beforeEach(async () => {
        await resetDb();
        b = await seedBase();
        await setModule(b.tenantId, 'lifecycle', 'active');
        admin = await entitledCtx(b);
        const hired = await hireEmployee(admin, { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: dayDate(todayInKualaLumpur(), -30), person: { fullName: 'Kevin Tech', primaryEmail: 'kevin@test.invalid' } });
        const user = await createAppUser(b.tenantId, hired.personId, 'employee');
        tech = { ...admin, userId: user, personId: hired.personId, roles: ['employee'], grants: undefined };
        const hired2 = await hireEmployee(admin, { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: dayDate(todayInKualaLumpur(), -30), person: { fullName: 'Other Employee', primaryEmail: 'other@test.invalid' } });
        other = { ...tech, userId: await createAppUser(b.tenantId, hired2.personId, 'employee'), personId: hired2.personId };
        await onboardingSetup(admin);
        const context = await onboardingContext(admin), config = structuredClone(context.config);
        config.groups.find(g => g.id === 'group-tech')!.members = [user];
        config.groups.find(g => g.id === 'people-gbs')!.members = [user];
        config.groups.find(g => g.id === 'tech-bp')!.members = [user];
        config.checklists[0]!.tasks = [{ id: 'welcome', name: 'Prepare welcome pack', by: 'group', group: 'people-gbs', method: 'rr', opens: null, due: 1, gate: false }];
        config.catalogue = [{ id: 'm365', name: 'M365', type: 'system', active: true, rules: {}, workflow: null, team: 'group-tech', card: false }];
        await onboardingSaveConfig(admin, context.revision, config);
    });
    afterAll(closeAll);
    const draft = () => saveEmployeeDraft(admin, { data: { profile: { fullName: 'New Hire', primaryEmail: 'new@test.invalid', icNumber: 'PRIVATE-IC' }, employment: { companyId: b.companyId, departmentId: b.deptA, positionId: b.positionId, hiredOn: dayDate(todayInKualaLumpur(), 8) } }, currentStep: 1 });
    async function prepared() {
        await draft();
        let [row] = await onboardingList(admin);
        await onboardingCommand(admin, row!.case.id, row!.revision, { type: 'save', patch: { hiring: 'new_hire', local: { supervisor: 'Manager' }, selected: ['m365'] } });
        [row] = await onboardingList(admin);
        await onboardingCommand(admin, row!.case.id, row!.revision, { type: 'submit' });
        return (await onboardingList(admin))[0]!;
    }
    it('automatically creates one pending case, saves incomplete data and protects source identity', async () => {
        const d = await draft();
        const rows = await onboardingList(admin);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.case).toMatchObject({ sourceDraftId: d.id, state: 'pending', requisitions: [] });
        await saveEmployeeDraft(admin, { id: d.id, data: { profile: { fullName: 'Updated Hire', primaryEmail: 'new@test.invalid' }, employment: { companyId: b.companyId } }, currentStep: 1 });
        expect(await onboardingList(admin)).toHaveLength(1);
        expect((await onboardingList(admin))[0]!.case.source.fullName).toBe('Updated Hire');
    });
    it('keeps HR-only data in a separate RLS-protected record', async () => {
        const row = await prepared();
        const visible = await onboardingDetail(tech, row.case.id, 'task');
        expect(JSON.stringify(visible)).not.toContain('PRIVATE-IC');
        expect(await withTenant(tech, tx => tx.select().from(schema.lcOnboardingPrivate))).toHaveLength(0);
        expect((await onboardingDetail(admin, row.case.id)).case.source.ic).toBe('PRIVATE-IC');
        const publicRows = await owner.db.select().from(schema.lcOnboardingCase);
        expect(JSON.stringify(publicRows)).not.toContain('PRIVATE-IC');
    });
    it('allows assigned staff without module access to act but denies full onboarding pages', async () => {
        const row = await prepared();
        await expect(onboardingDetail(tech, row.case.id)).rejects.toThrow('access');
        const queue = await onboardingTasks(tech);
        expect(queue.some(i => i.kind === 'checklist')).toBe(true);
        await onboardingCommand(tech, row.case.id, row.revision, { type: 'task', taskId: 'welcome', status: 'done' });
        expect((await onboardingDetail(admin, row.case.id)).case.tasks[0]!.status).toBe('done');
    });
    it('RLS hides an unrelated case and service actions refuse an unrelated user', async () => {
        const row = await prepared();
        expect(await withTenant(other, tx => tx.select().from(schema.lcOnboardingCase))).toHaveLength(0);
        await expect(onboardingDetail(other, row.case.id, 'task')).rejects.toThrow('not found');
        await expect(onboardingCommand(other, row.case.id, row.revision, { type: 'handover' })).rejects.toThrow();
    });
    it('rejects stale writes, and two claims cannot overwrite one another', async () => {
        const row = await prepared(), item = row.case.requisitions[0]!.items[0]!;
        await onboardingCommand(tech, row.case.id, row.revision, { type: 'fulfil', itemId: item.id, status: 'progress' });
        await expect(onboardingCommand(tech, row.case.id, row.revision, { type: 'fulfil', itemId: item.id, status: 'done' })).rejects.toThrow('changed');
    });
    it('keeps old task/requisition history after cancel, reopen and resubmit', async () => {
        let row = await prepared();
        const old = row.case.requisitions[0]!.number;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'cancel', reason: 'Candidate declined' });
        expect(await onboardingTasks(tech)).toHaveLength(0);
        row = (await onboardingList(admin))[0]!;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'reopen' });
        row = (await onboardingList(admin))[0]!;
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'submit' });
        const result = (await onboardingDetail(admin, row.case.id)).case;
        expect(result.requisitions).toHaveLength(2);
        expect(result.requisitions[0]!.cancelledAt).toBeTruthy();
        expect(result.requisitions[1]!.number).not.toBe(old);
        expect(result.taskHistory).toHaveLength(1);
    });
    it('does not change or delete any legacy case on new-model cancellation', async () => {
        const legacy = await createOnboardingCase(admin, { companyId: b.companyId, fullName: 'Legacy Hire', employeeNo: 'OLD-1', joinDate: todayInKualaLumpur(), jobTitle: 'Analyst', department: 'Finance', supervisor: 'Boss', laptopRequired: true, carparkRequired: false });
        const history = await caseHistory(admin, 'onboarding', legacy.number);
        const row = await prepared();
        const before = await owner.db.select().from(schema.lcCase);
        expect(before).toHaveLength(1);
        await onboardingCommand(admin, row.case.id, row.revision, { type: 'cancel', reason: 'Withdrawn' });
        expect(await owner.db.select().from(schema.lcCase)).toEqual(before);
        expect(await caseHistory(admin, 'onboarding', legacy.number)).toEqual(history);
    });
    it('cancels submitted work on Personnel draft discard while preserving source UUID/history', async () => {
        const row = await prepared();
        await discardEmployeeDraft(admin, row.case.sourceDraftId!);
        const after = (await onboardingDetail(admin, row.case.id)).case;
        expect(after.state).toBe('cancelled');
        expect(after.sourceDraftId).toBe(row.case.sourceDraftId);
        expect(after.requisitions).toHaveLength(1);
    });
    it('validates module access changes separately from group membership', async () => {
        const row = await prepared(), ctx = await onboardingContext(admin), config = structuredClone(ctx.config);
        config.access.onboarding.push(tech.userId!);
        await onboardingSaveConfig(admin, ctx.revision, config);
        const next = await onboardingContext(tech);
        expect(next.actor.module).toBe(true);
        config.access.onboarding.push(other.userId!);
        await expect(onboardingSaveConfig(tech, next.revision, config)).rejects.toThrow('Master Admin');
    });
    it('tags, resolves on reply and stores login-based notification reads independently', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Please confirm', mentions: [tech.userId!] });
        expect((await onboardingTasks(tech)).some(x => x.kind === 'mention')).toBe(true);
        await onboardingNote(tech, row.case.id, { context: 'requisition', body: 'Confirmed', mentions: [] });
        expect((await onboardingTasks(tech)).some(x => x.kind === 'mention')).toBe(false);
        await sweepOnboarding(admin);
        const notices = await onboardingNotices(admin);
        expect(notices.length).toBeGreaterThan(0);
        await onboardingReadNotice(admin);
        expect(await onboardingNotices(admin)).toHaveLength(0);
    });
    it('retains note bodies through edits and deletion', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'First version', mentions: [] });
        const [note] = await owner.db.select().from(schema.lcOnboardingNote);
        await onboardingNote(admin, row.case.id, { id: note!.id, context: 'requisition', body: 'Second version', mentions: [] });
        await onboardingNote(admin, row.case.id, { id: note!.id, context: 'requisition', body: '', mentions: [], deleted: true });
        const [after] = await owner.db.select().from(schema.lcOnboardingNote);
        expect(after!.data).toMatchObject({ body: 'Second version', deleted: true, revisions: [{ body: 'First version' }, { body: 'Second version' }] });
    });
    it('prevents a nonauthor from editing note content even through direct SQL', async () => {
        const row = await prepared();
        await onboardingNote(admin, row.case.id, { context: 'requisition', body: 'Original', mentions: [tech.userId!] });
        const [n] = await owner.db.select().from(schema.lcOnboardingNote);
        await expect(withTenant(tech, tx => tx.execute(sql `update lc_onboarding_note set data=jsonb_set(data,'{body}','"Changed"') where id=${n!.id}::uuid`))).rejects.toThrow();
    });
});
