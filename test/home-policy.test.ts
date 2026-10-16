/** Actual app-role owner/RLS/trigger tests with fictional identities. Not human/browser acceptance. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { adminCtx, createAppUser, migrateTestDb, resetDb, seedBase, owner, closeAll, type Base } from './harness';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee, updatePerson } from '../core/org';
import { saveHomePolicy, homeOwnPreferences, saveHomeSharing, requestHomeWorking, decideHomeWorking, homeWorkingRequests, homeMoments, homeAvailability, sendHomeGreeting, homeReceivedGreetings } from '../core/home-policy';
import { todayInKualaLumpur } from '../lib/hr-date';
let b: Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
async function employee(name: string, departmentId = b.deptA) { const e = await hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: `${randomUUID()}@home.invalid` }, companyId: b.companyId, departmentId, employmentType: 'full_time', hiredOn: '2020-01-01' }); const userId = await createAppUser(b.tenantId, e.personId, 'employee'); const ctx: SessionContext = { ...adminCtx(b), userId, personId: e.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] }; return { ...e, ctx }; }
const policy = (revision = 0) => ({ companyId: b.companyId, expectedRevision: revision, wfhEnabled: true, wfhApprovalRequired: true, availabilityEnabled: true, birthdaysEnabled: true, anniversariesEnabled: true });
const sharing = (employmentId: string, revision = 0) => ({ employmentId, expectedRevision: revision, availability: true, birthday: true, anniversary: true, weekStartsOn: 1 as const });
describe('explicit Home policy/sharing and home-working lifecycle', () => {
    it('begins disabled/private, requires exact own subject and company administrator, retains immutable versions', async () => {
        const self = await employee('Home self');
        expect(await homeOwnPreferences(self.ctx, self.employmentId)).toMatchObject({ policy: null, sharing: { revision: 0, availability: false, birthday: false, anniversary: false } });
        await expect(saveHomePolicy(self.ctx, policy())).rejects.toThrow();
        const first = await saveHomePolicy(adminCtx(b), policy());
        await expect(saveHomePolicy(adminCtx(b), policy())).rejects.toThrow();
        const next = await saveHomePolicy(adminCtx(b), { ...policy(first.revision), birthdaysEnabled: false });
        expect(next.revision).toBe(2);
        const rows = await owner.db.select().from(s.homeCompanyPolicy).orderBy(s.homeCompanyPolicy.revision);
        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.id === first.id)?.supersededAt).not.toBeNull();
        await expect(withTenant(adminCtx(b), tx => tx.update(s.homeCompanyPolicy).set({ wfhEnabled: false }).where(eq(s.homeCompanyPolicy.id, next.id)))).rejects.toThrow(/immutable/);
        const peer = await employee('Home peer');
        await expect(saveHomeSharing(self.ctx, sharing(peer.employmentId))).rejects.toThrow();
    });
    it('does not let self approve, rejects policy-stale decisions, and serializes overlap/replay without replacing history', async () => {
        const self = await employee('WFH self'), active = await saveHomePolicy(adminCtx(b), policy()), today = todayInKualaLumpur(), input = { employmentId: self.employmentId, policyId: active.id, requestId: randomUUID(), from: today, to: today };
        const requested = await requestHomeWorking(self.ctx, input);
        expect(requested.status).toBe('pending');
        expect(await requestHomeWorking(self.ctx, input)).toEqual(requested);
        await expect(decideHomeWorking(self.ctx, { id: requested.id, expectedRevision: 1, decision: 'approved' })).rejects.toThrow();
        const settled = await Promise.allSettled([requestHomeWorking(self.ctx, { ...input, requestId: randomUUID() }), requestHomeWorking(self.ctx, { ...input, requestId: randomUUID() })]);
        expect(settled.every(result => result.status === 'rejected')).toBe(true);
        await saveHomePolicy(adminCtx(b), { ...policy(1), wfhEnabled: false });
        await expect(decideHomeWorking(adminCtx(b), { id: requested.id, expectedRevision: 1, decision: 'approved' })).rejects.toThrow();
        expect((await homeWorkingRequests(self.ctx, { employmentId: self.employmentId })).items.find(row => row.id === requested.id)?.status).toBe('pending');
        await decideHomeWorking(self.ctx, { id: requested.id, expectedRevision: 1, decision: 'cancelled' });
        expect((await owner.db.select().from(s.homeWfhRequest))[0].status).toBe('cancelled');
    });
    it('uses explicit opt-in and a minimal peer audience, with fresh withdrawal refusal and an actual received greeting', async () => {
        const sender = await employee('Fictional sender'), recipient = await employee('Fictional birthday'), outside = await employee('Other department', b.deptB), today = todayInKualaLumpur();
        await updatePerson(adminCtx(b), { personId: recipient.personId, fullName: 'Fictional birthday', primaryEmail: 'birthday@home.invalid', dateOfBirth: '2000' + today.slice(4) });
        await saveHomePolicy(adminCtx(b), policy());
        expect((await homeMoments(sender.ctx, sender.employmentId, today, today)).items).toEqual([]);
        await saveHomeSharing(recipient.ctx, sharing(recipient.employmentId));
        const moments = await homeMoments(sender.ctx, sender.employmentId, today, today);
        expect(moments.items).toContainEqual({ employmentId: recipient.employmentId, name: 'Fictional birthday', date: today, kind: 'birthday' });
        expect(JSON.stringify(moments)).not.toContain('2000');
        expect((await homeMoments(outside.ctx, outside.employmentId, today, today)).items).toEqual([]);
        const input = { employmentId: sender.employmentId, recipientEmploymentId: recipient.employmentId, requestId: randomUUID(), kind: 'birthday' as const, date: today, message: 'Happy birthday!' };
        const greeting = await sendHomeGreeting(sender.ctx, input);
        expect(await sendHomeGreeting(sender.ctx, input)).toEqual(greeting);
        expect((await homeReceivedGreetings(recipient.ctx, recipient.employmentId)).items).toContainEqual(expect.objectContaining({ id: greeting.id, sender: 'Fictional sender', message: 'Happy birthday!' }));
        await saveHomeSharing(recipient.ctx, { ...sharing(recipient.employmentId, 1), birthday: false, availability: false });
        await expect(sendHomeGreeting(sender.ctx, { ...input, requestId: randomUUID() })).rejects.toThrow();
        expect((await homeAvailability(sender.ctx, sender.employmentId)).items).toEqual([]);
        const foreign = await seedBase();
        expect(await withTenant({ ...sender.ctx, tenantId: foreign.tenantId }, tx => tx.select().from(s.homeGreeting))).toEqual([]);
    });
    it('refuses direct app-role bypasses of policy, identity, approval and immutable greeting evidence', async () => {
        const self = await employee('Direct SQL self'), peer = await employee('Direct SQL peer'), active = await saveHomePolicy(adminCtx(b), policy()), today = todayInKualaLumpur();
        await expect(withTenant(self.ctx, tx => tx.insert(s.homeWfhRequest).values({ tenantId: b.tenantId, employmentId: self.employmentId, companyId: b.companyId, policyId: active.id, from: today, to: today, status: 'approved', requestedBy: self.ctx.userId! }))).rejects.toThrow();
        await expect(withTenant(self.ctx, tx => tx.insert(s.homeSharing).values({ tenantId: b.tenantId, employmentId: peer.employmentId, updatedBy: self.ctx.userId!, availability: true }))).rejects.toThrow();
        await expect(withTenant(self.ctx, tx => tx.insert(s.homeGreeting).values({ tenantId: b.tenantId, senderEmploymentId: self.employmentId, recipientEmploymentId: peer.employmentId, senderUserId: self.ctx.userId!, kind: 'birthday', date: today, message: 'Forged eligibility' }))).rejects.toThrow();
        await expect(withTenant(self.ctx, tx => tx.execute(sql `select app.home_company_on(${peer.employmentId}::uuid,${today}::date)`))).rejects.toThrow();
    });
});
