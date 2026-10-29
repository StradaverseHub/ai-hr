import {previewRewardAccessBatch,saveRewardAccessBatch} from './rewards-access-fixture';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { createRewardUnit, getRewardConfiguration, previewRewardAccessCopy, rewardAccessAdministration, type RewardAccessChange } from '../packs/rewards/service';
import type { RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
/** f38e5d8e — multi-review access batches and copying access from an earlier cycle. */
describe('Rewards access batches', () => {
    let b: Base, admin: SessionContext, ops: string, fin: string, first: string, cycle: string;
    const revision = async (unitId: string) => (await getRewardConfiguration(admin, unitId)).unit.revision;
    const change = async (unitId: string, userId: string, role: RewardRole): Promise<RewardAccessChange> => ({ unitId, revision: await revision(unitId), before: null, after: { userId, role } });
    const members = (unitIds: string[]) => owner.db.select({ unitId: s.rewardMember.unitId, userId: s.rewardMember.userId, role: s.rewardMember.role }).from(s.rewardMember).where(inArray(s.rewardMember.unitId, unitIds)).orderBy(asc(s.rewardMember.unitId), asc(s.rewardMember.role), asc(s.rewardMember.userId));
    const events = (unitIds: string[]) => owner.db.select().from(s.domainEvent).where(and(inArray(s.domainEvent.aggregateId, unitIds), eq(s.domainEvent.eventType, 'reward-unit.access-changed'))).orderBy(asc(s.domainEvent.sequence));
    async function account(fullName: string) {
        const [p] = await owner.db.insert(s.person).values({ tenantId: b.tenantId, fullName, primaryEmail: `${randomUUID()}@rewards.test` }).returning();
        return createAppUser(b.tenantId, p.id, 'employee');
    }
    beforeEach(async () => {
        await resetDb();
        b = await seedBase();
        await setModule(b.tenantId, 'rewards', 'active');
        admin = await entitledCtx(b);
        const [adminPerson] = await owner.db.insert(s.person).values({ tenantId: b.tenantId, fullName: 'Rewards administrator', primaryEmail: 'administrator@batch.test' }).returning();
        await owner.db.update(s.appUser).set({ personId: adminPerson.id }).where(eq(s.appUser.id, admin.userId!));
        admin = { ...admin, personId: adminPerson.id };
        const [o] = await owner.db.insert(s.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'OPS', name: 'Operations' }).returning();
        const [f] = await owner.db.insert(s.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'FIN', name: 'Finance' }).returning();
        ops = o.id; fin = f.id;
        first = await createRewardUnit(admin, { name: 'Earlier cycle', year, companyId: b.companyId, businessUnitId: ops, snapshotDate: today });
        cycle = (await getRewardConfiguration(admin, first)).unit.cycleId;
    });
    afterAll(closeAll);
    it('refuses a whole batch that touches one locked review and saves a valid batch once, reporting existing rows', async () => {
        const second = await createRewardUnit(admin, { name: 'Second', cycleId: cycle, year, companyId: b.companyId, businessUnitId: fin, snapshotDate: today });
        const [lockedBu] = await owner.db.insert(s.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'LCK', name: 'Locked' }).returning();
        const locked = await createRewardUnit(admin, { name: 'Locked', cycleId: cycle, year, companyId: b.companyId, businessUnitId: lockedBu.id, snapshotDate: today });
        const ctro = await account('Group CTRO');
        const all = [await change(first, ctro, 'ctro'), await change(second, ctro, 'ctro'), await change(locked, ctro, 'ctro')];
        await owner.db.update(s.rewardUnit).set({ status: 'bg' }).where(eq(s.rewardUnit.id, locked));
        const before = await members([first, second, locked]), revisions = [await revision(first), await revision(second)];
        await expect(previewRewardAccessBatch(admin, { changes: all })).rejects.toMatchObject({ code: 'locked' });
        await expect(saveRewardAccessBatch(admin, { changes: all }, 'a'.repeat(64))).rejects.toMatchObject({ code: 'locked' });
        expect(await members([first, second, locked])).toEqual(before);
        expect([await revision(first), await revision(second)]).toEqual(revisions);
        expect(await events([first, second, locked])).toHaveLength(0);
        // The creator already holds Group Rewards on the first review: reported, not refused, and not rewritten.
        const batch = { changes: [all[0], all[1], await change(first, admin.userId!, 'gr')] };
        const preview = await previewRewardAccessBatch(admin, batch);
        expect(preview.changes).toEqual([all[0], all[1]]);
        expect(preview.alreadyPresent).toEqual([batch.changes[2]]);
        const result = await saveRewardAccessBatch(admin, batch, preview.digest);
        expect(result).toMatchObject({ reviews: 2, applied: 2, alreadyPresent: 1 });
        expect((await members([first, second])).filter(m => m.role === 'ctro').map(m => m.unitId).sort()).toEqual([first, second].sort());
        expect([await revision(first), await revision(second)]).toEqual(revisions.map(r => r + 1));
        const written = await events([first, second]);
        expect(written.map(e => e.aggregateId).sort()).toEqual([first, second].sort());
        for (const e of written)
            expect(e.payload).toMatchObject({ before: null, after: { userId: ctro, role: 'ctro' }, revision: revisions[0] + 1, batchId: result.batchId });
        // A replayed preview is stale once the reviews moved on.
        await expect(saveRewardAccessBatch(admin, batch, preview.digest)).rejects.toMatchObject({ code: 'changed' });
    });
    it('refuses a forged digest, a mixed revision for one review and more than 500 changes', async () => {
        const reviewer = await account('Batch reviewer');
        const ok = await change(first, reviewer, 'bu');
        await expect(saveRewardAccessBatch(admin, { changes: [ok] }, 'f'.repeat(64))).rejects.toMatchObject({ code: 'preview' });
        await expect(previewRewardAccessBatch(admin, { changes: [ok, { ...ok, revision: ok.revision + 1, after: { userId: reviewer, role: 'bg' } }] })).rejects.toMatchObject({ code: 'changed' });
        await expect(previewRewardAccessBatch(admin, { changes: Array.from({ length: 501 }, () => ok) })).rejects.toThrow();
        expect(await members([first])).toEqual([{ unitId: first, userId: admin.userId, role: 'gr' }]);
    });
    it('copies an earlier cycle onto matching Draft reviews, skipping inactive logins and never applying a BU-head suggestion', async () => {
        const reviewer = await account('Copied BU CEO'), departed = await account('Departed CTRO');
        const finFirst = await createRewardUnit(admin, { name: 'Earlier finance', cycleId: cycle, year, companyId: b.companyId, businessUnitId: fin, snapshotDate: today });
        // Each change reads the review's current revision, so build it only after the previous save.
        for (const [user, role] of [[reviewer, 'bu'], [departed, 'ctro']] as const) {
            const c = await change(first, user, role);
            const p = await previewRewardAccessBatch(admin, { changes: [c] });
            await saveRewardAccessBatch(admin, { changes: [c] }, p.digest);
        }
        await owner.db.update(s.appUser).set({ archivedAt: new Date() }).where(eq(s.appUser.id, departed));
        // The Finance head is an employee with their own login. A different person sharing the email never matches.
        const head = await hireEmployee(admin, { person: { fullName: 'Finance Head', primaryEmail: 'finance.head@batch.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
        const headUser = await createAppUser(b.tenantId, head.personId, 'employee');
        const [twin] = await owner.db.insert(s.person).values({ tenantId: b.tenantId, fullName: 'Email twin', primaryEmail: 'finance.head@batch.test' }).returning();
        const twinUser = await createAppUser(b.tenantId, twin.id, 'employee');
        await owner.db.update(s.businessUnit).set({ headEmploymentId: head.employmentId }).where(eq(s.businessUnit.id, fin));
        const nextOps = await createRewardUnit(admin, { name: 'Next cycle', year, companyId: b.companyId, businessUnitId: ops, snapshotDate: today });
        const nextCycle = (await getRewardConfiguration(admin, nextOps)).unit.cycleId;
        const nextFin = await createRewardUnit(admin, { name: 'Next finance', cycleId: nextCycle, year, companyId: b.companyId, businessUnitId: fin, snapshotDate: today });
        const copy = await previewRewardAccessCopy(admin, { fromCycleId: cycle, toCycleId: nextCycle, companyIds: [b.companyId] });
        expect(copy.proposals.filter(p => !p.suggested).map(p => p.change)).toEqual([{ unitId: nextOps, revision: await revision(nextOps), before: null, after: { userId: reviewer, role: 'bu' } }]);
        expect(copy.skipped).toEqual([{ unitId: nextOps, role: 'ctro', name: 'Departed CTRO', email: expect.any(String) }]);
        expect(copy.alreadyPresent.map(c => c.unitId).sort()).toEqual([nextOps, nextFin].sort()); // the creator's Group Rewards seat
        expect(copy.proposals.filter(p => p.suggested)).toEqual([{ suggested: true, change: { unitId: nextFin, revision: await revision(nextFin), before: null, after: { userId: headUser, role: 'bu' } } }]);
        expect(JSON.stringify(copy)).not.toContain(twinUser);
        expect((await rewardAccessAdministration(admin, [b.companyId])).suggestions).toContainEqual({ unitId: nextFin, userId: headUser });
        // Previewing proposed nothing; saving only the copied seats leaves the suggestion unapplied.
        expect((await members([nextOps, nextFin])).filter(m => m.role === 'bu')).toEqual([]);
        const changes = copy.proposals.filter(p => !p.suggested).map(p => p.change);
        const p = await previewRewardAccessBatch(admin, { changes });
        await saveRewardAccessBatch(admin, { changes }, p.digest);
        expect((await members([nextOps, nextFin])).filter(m => m.role === 'bu')).toEqual([{ unitId: nextOps, userId: reviewer, role: 'bu' }]);
        // A non-draft target receives nothing.
        await owner.db.update(s.rewardUnit).set({ status: 'bg' }).where(eq(s.rewardUnit.id, nextFin));
        const again = await previewRewardAccessCopy(admin, { fromCycleId: cycle, toCycleId: nextCycle, companyIds: [b.companyId] });
        expect([...again.proposals.map(x => x.change.unitId), ...again.alreadyPresent.map(x => x.unitId)].every(id => id === nextOps)).toBe(true);
        expect(finFirst).toBeTruthy();
    });
});
