import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee, setEmploymentBlacklist } from '../core/org';
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
        // cd72f915: a required seat may not lose its last active holder, so another person keeps BU and BG.
        const keep = await user();
        await save(await preview({ userId: keep.userId!, role: 'bu' }));
        await save(await preview({ userId: keep.userId!, role: 'bg' }));
        await save(await preview({ userId: reviewer.userId!, role: 'bg' }, { userId: reviewer.userId!, role: 'bu' }));
        let state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.filter(m => m.userId === reviewer.userId).map(m => m.role).sort()).toEqual(['bg', 'pbp']);
        await save(await preview(null, { userId: reviewer.userId!, role: 'bg' }));
        state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.filter(m => m.userId === reviewer.userId).map(m => m.role)).toEqual(['pbp']);
        expect((await getRewardUnit(reviewer, id)).roles).toEqual(['pbp']);
        const events = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, id), eq(s.domainEvent.eventType, 'reward-unit.access-changed'))).orderBy(asc(s.domainEvent.sequence));
        expect(events).toHaveLength(6);
        expect(events[4].payload).toMatchObject({ before: { role: 'bu' }, after: { role: 'bg' } });
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
    it.each(['previewed', 'legacy'] as const)('serializes the %s membership writer behind a real employment suspension before checking replacement eligibility', async (writer) => {
        const hire = await hireEmployee(admin, { person: { fullName: 'Concurrent suspended reviewer', primaryEmail: 'suspended@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 1}-01-01` });
        const [employee] = await owner.db.select().from(s.employment).where(eq(s.employment.id, hire.employmentId));
        const target = await createAppUser(b.tenantId, employee.personId, 'employee');
        const p = await preview({ userId: target, role: 'gr' }, { userId: admin.userId!, role: 'gr' });
        const originalRevision = p.revision;
        let release!: () => void, ready!: (pid: number) => void, failed!: (error: unknown) => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<number>((resolve, reject) => { ready = resolve; failed = reject; });
        // Use the actual restricted-role canonical writer, not raw SQL or a mocked policy check.
        // Its employment UPDATE deliberately stays uncommitted while Rewards attempts its save.
        const revocation = withTenant(admin, async tx => {
            const [backend] = await tx.execute<{ pid: number }>(sql `select pg_backend_pid() as pid`);
            await setEmploymentBlacklist(admin, { employmentId: hire.employmentId, blacklisted: true, reason: 'Concurrent suspension fixture' }, tx);
            ready(backend.pid);
            await held;
        }).then(() => ({ ok: true as const }), error => { failed(error); return { ok: false as const, error }; });
        let pending: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
        try {
            const blocker = await started;
            let settled = false;
            // The legacy add path also has to reject. It cannot remove the existing GR, but must
            // not create an unusable replacement membership while suspension is in flight.
            pending = (writer === 'previewed' ? save(p) : setRewardMember(admin, id, originalRevision, target, 'gr'))
                .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
                .finally(() => { settled = true; });
            let blocked = false;
            const deadline = Date.now() + 3000;
            while (!settled && Date.now() < deadline) {
                const [wait] = await owner.db.execute<{ blocked: boolean }>(sql `select exists (
                    select 1 from pg_locks l where l.locktype='advisory' and not l.granted
                    and ${blocker}::integer = any(pg_blocking_pids(l.pid))
                ) as blocked`);
                if (wait.blocked) { blocked = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            // This pins the intended synchronization guard. Without it, MVCC sees the old
            // active employment and the save succeeds; incidental membership RLS allows it.
            expect(blocked).toBe(true);
            expect(settled).toBe(false);
            release();
            expect(await revocation).toEqual({ ok: true });
            expect(await pending).toMatchObject({ ok: false, error: { code: 'account' } });
            expect(await revision()).toBe(originalRevision);
            const state = await rewardAccessAdministration(admin, [b.companyId]);
            expect(state.reviews.some(review => review.id === id)).toBe(true); // Actor remains authorized.
            expect(state.members.filter(member => member.role === 'gr')).toMatchObject([{ userId: admin.userId }]);
            expect(state.members.some(member => member.userId === target)).toBe(false);
            expect(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId, id), eq(s.domainEvent.eventType, 'reward-unit.access-changed')))).toHaveLength(0);
        } finally {
            release();
            await revocation;
            await pending;
        }
    }, 15000);
    it('retains active Group Rewards coverage and allows a replacement within one edit', async () => {
        await expect(preview(null, { userId: admin.userId!, role: 'gr' })).rejects.toThrow(/at least one active Group Rewards/);
        const replacement = await preview({ userId: reviewer.userId!, role: 'gr' }, { userId: admin.userId!, role: 'gr' });
        await save(replacement);
        const state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.filter(m => m.role === 'gr')).toMatchObject([{ userId: reviewer.userId }]);
        await expect(getRewardUnit(admin, id)).rejects.toThrow(/assign your Reward Desk role/);
        expect((await getRewardConfiguration(admin, id)).canManageMembers).toBe(true);
    });
    it('cd72f915: projects required-seat coverage with the submit login predicate and refuses losing the last active holder', async () => {
        let state = await rewardAccessAdministration(admin, [b.companyId]);
        let coverage = state.reviews.find(r => r.id === id)!.coverage;
        // A new review starts with only its creator as Group Rewards; the rest of the route is missing.
        expect(coverage.missing).toEqual(['bu', 'bg', 'ctro', 'ec', 'payroll']);
        expect(coverage.roles.find(r => r.role === 'pbp')).toMatchObject({ required: false, activeHolders: [] });
        expect(coverage.roles.find(r => r.role === 'gr')!.activeHolders.map(h => h.userId)).toEqual([admin.userId]);
        const ctro = reviewer, spare = await user(), departed = await user();
        await save(await preview({ userId: ctro.userId!, role: 'ctro' }));
        await save(await preview({ userId: departed.userId!, role: 'ec' }));
        await owner.db.update(s.appUser).set({ archivedAt: new Date() }).where(eq(s.appUser.id, departed.userId!));
        coverage = (await rewardAccessAdministration(admin, [b.companyId])).reviews.find(r => r.id === id)!.coverage;
        expect(coverage.missing).toEqual(['bu', 'bg', 'ec', 'payroll']);
        expect(coverage.roles.find(r => r.role === 'ec')!.activeHolders).toEqual([]);
        expect(coverage.roles.find(r => r.role === 'ctro')!.activeHolders.map(h => h.userId)).toEqual([ctro.userId]);
        // Removing the last active CTRO is refused and names the role; nothing changes.
        const rev = await revision();
        await expect(preview(null, { userId: ctro.userId!, role: 'ctro' })).rejects.toMatchObject({ code: 'lastRequired', role: 'ctro', message: expect.stringMatching(/active CTRO/) });
        await expect(setRewardMember(admin, id, rev, ctro.userId!, 'ctro', true)).rejects.toMatchObject({ code: 'lastRequired' });
        expect(await revision()).toBe(rev);
        // A disabled holder never was coverage, so removing it loses nothing; an Edit replacement passes (add first).
        await save(await preview(null, { userId: departed.userId!, role: 'ec' }));
        await save(await preview({ userId: spare.userId!, role: 'ctro' }, { userId: ctro.userId!, role: 'ctro' }));
        state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.members.filter(m => m.role === 'ctro').map(m => m.userId)).toEqual([spare.userId]);
        expect(state.members.some(m => m.role === 'ec')).toBe(false);
    });
    it('68c84963: offers active logins with employment facts and lists active employees without a login as not grantable', async () => {
        const [title] = await owner.db.insert(s.position).values({ tenantId: b.tenantId, companyId: b.companyId, title: 'Regional Sales Head' }).returning();
        const [own] = await owner.db.select().from(s.company).where(eq(s.company.id, b.companyId));
        const hire = async (fullName: string) => hireEmployee(admin, { person: { fullName, primaryEmail: `${randomUUID()}@rewards.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 1}-01-01` });
        const linked = await hire('Facts Reviewer');
        await owner.db.update(s.employment).set({ employeeCode: 'RW-0042' }).where(eq(s.employment.id, linked.employmentId));
        await owner.db.update(s.assignment).set({ businessUnitId: bu, positionId: title.id }).where(eq(s.assignment.employmentId, linked.employmentId));
        const login = await createAppUser(b.tenantId, linked.personId, 'employee');
        const unlinked = await hire('Unlinked Employee');
        const departed = await hire('Departed Employee'), departedUnlinked = await hire('Departed Unlinked');
        for (const e of [departed, departedUnlinked])
            await owner.db.update(s.employment).set({ terminatedOn: `${year - 1}-06-30` }).where(eq(s.employment.id, e.employmentId));
        const departedLogin = await createAppUser(b.tenantId, departed.personId, 'employee');
        const state = await rewardAccessAdministration(admin, [b.companyId]);
        expect(state.users.find(u => u.id === login)).toMatchObject({ name: 'Facts Reviewer', employeeCode: 'RW-0042', jobTitle: 'Regional Sales Head', companyName: own.legalName, businessUnitName: 'Operations' });
        expect(state.users.some(u => u.id === departedLogin)).toBe(false);
        expect(state.candidates.map(c => c.name)).toContain('Unlinked Employee');
        expect(state.candidates.map(c => c.name)).not.toContain('Departed Unlinked');
        expect(state.candidates.map(c => c.name)).not.toContain('Facts Reviewer');
        expect(JSON.stringify(state)).not.toMatch(/basic|salary|Cents|personId/i);
        // Being listed grants nothing: neither a person id nor a blocked login is an active login account.
        await expect(preview({ userId: unlinked.personId, role: 'bu' })).rejects.toMatchObject({ code: 'account' });
        await expect(preview({ userId: departedLogin, role: 'bu' })).rejects.toMatchObject({ code: 'account' });
        // Members carry the same identification, so the assignment search can match an employee number.
        await save(await preview({ userId: login, role: 'pbp' }));
        expect((await rewardAccessAdministration(admin, [b.companyId])).members.find(m => m.userId === login)).toMatchObject({ employeeCode: 'RW-0042' });
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
        await expect(saveRewardPolicy(reviewer, id, v.unit.revision, v.unit.policy)).rejects.toThrow('Reward unit not found or access has been removed.');
        expect(await revision()).toBe(v.unit.revision);
    });
    it('refuses unknown and cross-tenant login accounts without altering the review', async () => {
        const v = await revision();
        await expect(preview({ userId: randomUUID(), role: 'bu' })).rejects.toThrow(/active existing/);
        const other = await seedBase();
        const [p] = await owner.db.insert(s.person).values({ tenantId: other.tenantId, fullName: 'Foreign account', primaryEmail: 'foreign@rewards.test' }).returning();
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
    it('refuses moving retained membership out of a removed review through the actual app role', async () => {
        await setRewardMember(admin,id,await revision(),reviewer.userId!,'pbp');
        const before=await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.unitId,id)).orderBy(asc(s.rewardMember.id));
        expect(before).toHaveLength(2);
        const retainedMember=before.find(member=>member.userId===reviewer.userId)!;
        expect(retainedMember.role).toBe('pbp');
        await deleteRewardReview(admin,id,await revision(),id);
        const replacement=await createRewardUnit(admin,{name:'Replacement review',year,companyId:b.companyId,businessUnitId:bu,snapshotDate:today});
        await expect(withTenant(admin,tx=>tx.update(s.rewardMember).set({unitId:replacement}).where(eq(s.rewardMember.id,retainedMember.id)))).rejects.toMatchObject({cause:expect.objectContaining({message:'Reward evidence cannot move between reviews',code:'23514'})});
        const retained=await owner.db.select().from(s.rewardMember).where(eq(s.rewardMember.unitId,id)).orderBy(asc(s.rewardMember.id));
        expect(retained).toEqual(before);
    });
    it('retains owned source snapshots on removal but refuses changed facts and recommendations', async () => {
        const hire = await hireEmployee(admin, { person: { fullName: 'Snapshot employee', primaryEmail: 'snapshot@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 1}-01-01` });
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
