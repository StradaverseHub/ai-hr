import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { createRewardUnit, deleteRewardReview, getRewardConfiguration, getRewardUnit, listRewardUnits, previewRewardAccessChange, rewardAccessAdministration, rewardDeletionEligibility, saveRewardAccessChange, setRewardMember, saveRewardEntry, saveRewardPolicy } from '../packs/rewards/service';
import { emptyFacts, emptyRecommendation, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
describe('Rewards review maintenance and canonical scoped access', () => {
    let b: Base, admin: SessionContext, id: string, bu: string, reviewer: SessionContext;
    const revision = async () => (await getRewardConfiguration(admin, id)).unit.revision;
    async function user(role = 'employee') {
        const [p] = await owner.db.insert(s.person).values({ tenantId: b.tenantId, fullName: `Reviewer ${randomUUID()}`, primaryEmail: `${randomUUID()}@reward.test` }).returning();
        const userId = await createAppUser(b.tenantId, p.id, role as 'employee');
        return { ...admin, userId, personId: p.id, roles: [role], grants: undefined } as SessionContext;
    }
    async function preview(after: {
        userId: string;
        role: RewardRole;
    } | null, before: {
        userId: string;
        role: RewardRole;
    } | null = null) { return previewRewardAccessChange(admin, { unitId: id, revision: await revision(), before, after }); }
    const save = async (p: Awaited<ReturnType<typeof previewRewardAccessChange>>) => { const { digest, ...input } = p; return saveRewardAccessChange(admin, input, digest); };
    beforeEach(async () => {
        await resetDb();
        b = await seedBase();
        await setModule(b.tenantId, 'rewards', 'active');
        admin = await entitledCtx(b);
        const [u] = await owner.db.insert(s.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'OPS', name: 'Legacy name', label: 'Operations' }).returning();
        bu = u.id;
        id = await createRewardUnit(admin, { name: 'Annual maintenance', year, companyId: b.companyId, businessUnitId: bu, snapshotDate: today });
        reviewer = await user();
    });
    afterAll(closeAll);
    it('previews, saves, replaces and removes exact scoped memberships while retaining other roles and audit', async () => {
        const p = await preview({ userId: reviewer.userId!, role: 'bu' });
        expect((await rewardAccessAdministration(admin, [b.companyId])).members.some(m => m.userId === reviewer.userId)).toBe(false);
        await save(p);
        await save(await preview({ userId: reviewer.userId!, role: 'pbp' }));
        await save(await preview({ userId: reviewer.userId!, role: 'bg' }, { userId: reviewer.userId!, role: 'bu' }));
        let state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.filter(m => m.userId === reviewer.userId).map(m => m.role).sort()).toEqual(['bg', 'pbp']);
        await save(await preview(null, { userId: reviewer.userId!, role: 'bg' }));
        state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.filter(m => m.userId === reviewer.userId).map(m => m.role)).toEqual(['pbp']);
        expect((await getRewardUnit(reviewer, id)).roles).toEqual(['pbp']);
        const events = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, id), eq(s.domainEvent.eventType, 'reward-unit.access-changed'))).orderBy(asc(s.domainEvent.sequence));
        expect(events).toHaveLength(4);
        expect(events[2].payload).toMatchObject({ before: { role: 'bu' }, after: { role: 'bg' } });
        for (const privateKey of ['basicCents', 'compensationId', 'recommendation', 'budget'])
            expect(JSON.stringify(state)).not.toContain(privateKey);
    });
    it('binds previews to their actor, selected scope, account eligibility and current revision', async () => {
        const p = await preview({ userId: reviewer.userId!, role: 'bu' });
        const { digest, ...input } = p;
        await expect(saveRewardAccessChange(admin, { ...input, after: { userId: reviewer.userId!, role: 'gr' } }, digest)).rejects.toThrow(/Preview.*again/i);
        const otherAdmin = await user('hr_admin');
        await expect(saveRewardAccessChange(otherAdmin, input, digest)).rejects.toThrow(/Preview.*again/i);
        await owner.db.update(s.appUser).set({ archivedAt: new Date() }).where(eq(s.appUser.id, reviewer.userId!));
        await expect(save(p)).rejects.toThrow(/active existing/);
        expect(await revision()).toBe(input.revision);
    });
    it('serializes concurrent edits, refuses stale previews and keeps one atomic winner', async () => {
        const p = await preview({ userId: reviewer.userId!, role: 'bu' });
        const q = await preview({ userId: reviewer.userId!, role: 'bg' });
        const results = await Promise.allSettled([save(p), save(q)]);
        expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
        expect((await rewardAccessAdministration(admin, [b.companyId])).members.filter(m => m.userId === reviewer.userId)).toHaveLength(1);
        expect(await revision()).toBe(p.revision + 1);
    });
    it('retains active Group Rewards coverage and allows a replacement within one edit', async () => {
        await expect(preview(null, { userId: admin.userId!, role: 'gr' })).rejects.toThrow(/at least one active Group Rewards/);
        const replacement = await preview({ userId: reviewer.userId!, role: 'gr' }, { userId: admin.userId!, role: 'gr' });
        await save(replacement);
        const state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.filter(m => m.role === 'gr')).toMatchObject([{ userId: reviewer.userId }]);
        await expect(getRewardUnit(admin, id)).rejects.toThrow(/assign your Reward Desk role/);
        expect((await getRewardConfiguration(admin, id)).canManageMembers).toBe(true);
    });
    it('rechecks revocation for detail, configuration, entry actions and previously open previews', async () => {
        await setRewardMember(admin, id, await revision(), reviewer.userId!, 'gr');
        const open = await getRewardUnit(reviewer, id);
        await setRewardMember(admin, id, open.unit.revision, reviewer.userId!, 'gr', true);
        await expect(getRewardUnit(reviewer, id)).rejects.toThrow();
        await expect(getRewardConfiguration(reviewer, id)).rejects.toThrow();
        await expect(saveRewardPolicy(reviewer, id, open.unit.revision, open.unit.policy)).rejects.toThrow();
        await expect(previewRewardAccessChange(reviewer, { unitId: id, revision: await revision(), before: null, after: { userId: reviewer.userId!, role: 'payroll' } })).rejects.toThrow();
    });
    it('refuses PBP and delegated GR administration and filters non-admin company enumeration', async () => {
        await setRewardMember(admin, id, await revision(), reviewer.userId!, 'gr');
        expect((await rewardAccessAdministration(reviewer, [b.companyId])).reviews).toEqual([]);
        await expect(previewRewardAccessChange(reviewer, { unitId: id, revision: await revision(), before: null, after: { userId: reviewer.userId!, role: 'payroll' } })).rejects.toThrow(/administrator/);
        await expect(deleteRewardReview(reviewer, id, await revision(), id)).rejects.toThrow(/administrator/);
        await setRewardMember(admin, id, await revision(), reviewer.userId!, 'gr', true);
        await setRewardMember(admin, id, await revision(), reviewer.userId!, 'pbp');
        const v = await getRewardUnit(reviewer, id);
        expect(v.canEdit).toBe(false);
        await expect(saveRewardPolicy(reviewer, id, v.unit.revision, v.unit.policy)).rejects.toThrow(/Group Rewards/);
    });
    it('refuses unknown and cross-tenant login accounts without altering the review', async () => {
        const v = await revision();
        await expect(preview({ userId: randomUUID(), role: 'bu' })).rejects.toThrow(/active existing/);
        const other = await seedBase();
        const [p] = await owner.db.insert(s.person).values({ tenantId: other.tenantId, fullName: 'Foreign account' }).returning();
        const foreign = await createAppUser(other.tenantId, p.id, 'employee');
        await expect(preview({ userId: foreign, role: 'bu' })).rejects.toThrow(/active existing/);
        expect(await revision()).toBe(v);
    });
    it('uses current workforce visibility for candidates, legacy writes and masked retained memberships', async () => {
        const [foreignCompany] = await owner.db.insert(s.company).values({ tenantId: b.tenantId, legalName: 'Foreign Company' }).returning();
        const [foreignDept] = await owner.db.insert(s.department).values({ tenantId: b.tenantId, companyId: foreignCompany.id, name: 'Foreign Department' }).returning();
        const foreignHire = await hireEmployee(admin, { person: { fullName: 'Hidden Foreign Reviewer', primaryEmail: 'hidden@foreign.test' }, companyId: foreignCompany.id, departmentId: foreignDept.id, employmentType: 'full_time', hiredOn: `${year - 1}-01-01` });
        const [foreignEmployee] = await owner.db.select().from(s.employment).where(eq(s.employment.id, foreignHire.employmentId)).orderBy(asc(s.employment.id));
        const foreignUser = await createAppUser(b.tenantId, foreignEmployee.personId, 'employee');
        const scoped = await user('hr_admin');
        await owner.db.update(s.roleAssignment).set({ companyId: b.companyId }).where(eq(s.roleAssignment.appUserId, scoped.userId!));
        const companyAdmin = { ...scoped, grants: [{ role: 'hr_admin', companyId: b.companyId }] };
        await owner.db.insert(s.rewardMember).values({ tenantId: b.tenantId, unitId: id, userId: foreignUser, role: 'pbp' });
        const summary = await rewardAccessAdministration(companyAdmin, [b.companyId, foreignCompany.id]);
        expect(summary.users.some(u => u.id === foreignUser)).toBe(false);
        expect(summary.members.find(m => m.userId === foreignUser)).toMatchObject({ name: null, email: null });
        expect(JSON.stringify(summary)).not.toMatch(/Hidden Foreign Reviewer|hidden@foreign.test|Foreign Company/);
        const change = { unitId: id, revision: await revision(), before: null, after: { userId: foreignUser, role: 'bu' } };
        await expect(previewRewardAccessChange(companyAdmin, change)).rejects.toThrow(/active existing/);
        await expect(setRewardMember(companyAdmin, id, await revision(), foreignUser, 'bu')).rejects.toThrow(/active existing/);
        const removal = await previewRewardAccessChange(companyAdmin, { ...change, before: { userId: foreignUser, role: 'pbp' }, after: null });
        const { digest, ...input } = removal;
        await saveRewardAccessChange(companyAdmin, input, digest);
        expect((await rewardAccessAdministration(companyAdmin, [b.companyId])).members.some(m => m.userId === foreignUser)).toBe(false);
    });
    it('permits a readable group reviewer without employment while rejecting a personless new grant', async () => {
        const summary = await rewardAccessAdministration(admin, [b.companyId]);
        expect(summary.users.some(u => u.id === reviewer.userId)).toBe(true);
        await save(await preview({ userId: reviewer.userId!, role: 'gr' }));
        await expect(preview({ userId: admin.userId!, role: 'payroll' })).rejects.toThrow(/active existing/);
    });
    it('shows disabled accounts and locked assignments without permitting changes', async () => {
        await setRewardMember(admin, id, await revision(), reviewer.userId!, 'pbp');
        await owner.db.update(s.appUser).set({ archivedAt: new Date() }).where(eq(s.appUser.id, reviewer.userId!));
        await owner.db.update(s.rewardUnit).set({ status: 'bg' }).where(eq(s.rewardUnit.id, id));
        const state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.find(m => m.userId === reviewer.userId)?.disabled).toBe(true);
        expect(state.reviews[0].status).toBe('bg');
        await expect(preview(null, { userId: reviewer.userId!, role: 'pbp' })).rejects.toThrow(/draft/i);
    });
    it('removes only an unused draft, retains its cycle and immutable evidence, and permits repeat requests', async () => {
        const before = await getRewardConfiguration(admin, id), rev = before.unit.revision;
        expect(await rewardDeletionEligibility(admin, id)).toBeNull();
        await expect(deleteRewardReview(admin, id, rev, 'wrong')).rejects.toThrow(/Confirm/);
        await deleteRewardReview(admin, id, rev, id);
        expect(await listRewardUnits(admin, [b.companyId])).toEqual([]);
        expect((await rewardAccessAdministration(admin, [b.companyId])).members).toEqual([]);
        await expect(getRewardConfiguration(admin, id)).rejects.toThrow();
        await expect(getRewardUnit(admin, id)).rejects.toThrow();
        const [tombstone] = await owner.db.select().from(s.rewardUnit).where(eq(s.rewardUnit.id, id)).orderBy(asc(s.rewardUnit.id));
        expect(tombstone.deletedBy).toBe(admin.userId);
        expect(tombstone.deletedAt).toBeTruthy();
        expect((await owner.db.select().from(s.rewardCycle).where(eq(s.rewardCycle.id, before.unit.cycleId)))).toHaveLength(1);
        expect((await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.unitId, id)))).toHaveLength(1);
        expect((await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, id), eq(s.domainEvent.eventType, 'reward-unit.deleted'))))).toHaveLength(1);
        expect(await deleteRewardReview(admin, id, rev, id)).toEqual({ alreadyDeleted: true });
        await expect(withTenant(admin, tx => tx.update(s.rewardUnit).set({ deletedAt: null, deletedBy: null }).where(eq(s.rewardUnit.id, id)))).rejects.toThrow();
        await expect(withTenant(admin, tx => tx.insert(s.rewardMember).values({ tenantId: b.tenantId, unitId: id, userId: reviewer.userId!, role: 'bu' }))).rejects.toThrow();
    });
    it('retains owned source snapshots on removal but refuses changed facts and recommendations', async () => {
        const hire = await hireEmployee(admin, { person: { fullName: 'Snapshot employee' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 1}-01-01` });
        await owner.db.update(s.assignment).set({ businessUnitId: bu }).where(eq(s.assignment.employmentId, hire.employmentId));
        // A second review sees the real immutable source snapshot; no employee award has been entered.
        const create = async (name: string) => createRewardUnit(admin, { name, year, companyId: b.companyId, businessUnitId: bu, snapshotDate: today });
        const snapshotId = await create('Snapshot only');
        expect((await getRewardUnit(admin, snapshotId)).rows).toHaveLength(1);
        await deleteRewardReview(admin, snapshotId, (await getRewardConfiguration(admin, snapshotId)).unit.revision, snapshotId);
        expect((await owner.db.select().from(s.rewardEntry).where(eq(s.rewardEntry.unitId, snapshotId)))).toHaveLength(1);
        const usedId = await create('Used facts');
        let v = await getRewardUnit(admin, usedId);
        await saveRewardEntry(admin, usedId, v.unit.revision, v.rows[0].id, emptyRecommendation(), { ...emptyFacts(), reviewed: true });
        expect(await rewardDeletionEligibility(admin, usedId)).toBe('recommendations');
        await expect(deleteRewardReview(admin, usedId, (await getRewardConfiguration(admin, usedId)).unit.revision, usedId)).rejects.toThrow(/in use/);
    });
    it('refuses stale deletion and deletion racing a real access edit without losing the winning change', async () => {
        const rev = await revision();
        const p = await preview({ userId: reviewer.userId!, role: 'pbp' });
        await save(p);
        await expect(deleteRewardReview(admin, id, rev, id)).rejects.toThrow(/another session/);
        const fresh = await preview({ userId: reviewer.userId!, role: 'bu' });
        const result = await Promise.allSettled([save(fresh), deleteRewardReview(admin, id, fresh.revision, id)]);
        expect(result.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    });
    it.each(['bg', 'approved', 'posted'] as const)('retains a %s review', async (status) => { await owner.db.update(s.rewardUnit).set({ status }).where(eq(s.rewardUnit.id, id)); expect(await rewardDeletionEligibility(admin, id)).toBe('locked'); await expect(deleteRewardReview(admin, id, await revision(), id)).rejects.toThrow(/in use/); });
    it('retains returned drafts with decisions and shared cycles with another unit', async () => {
        await owner.db.insert(s.rewardDecision).values({ tenantId: b.tenantId, unitId: id, actorId: admin.userId!, revision: 1, action: 'return', fromStage: 'bg', toStage: 'draft', reason: 'Retain human decision', digest: 'fictional' });
        expect(await rewardDeletionEligibility(admin, id)).toBe('decisions');
        const before = await getRewardConfiguration(admin, id);
        const [u] = await owner.db.insert(s.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'FIN', name: 'Finance' }).returning();
        const other = await createRewardUnit(admin, { name: 'Same cycle', cycleId: before.unit.cycleId, year, companyId: b.companyId, businessUnitId: u.id, snapshotDate: today });
        await deleteRewardReview(admin, other, (await getRewardConfiguration(admin, other)).unit.revision, other);
        expect((await getRewardConfiguration(admin, id)).cycle?.name).toBe('Annual maintenance');
    });
});
