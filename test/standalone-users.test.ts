import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { client, withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createManualAccount, resumeManualAccount, cancelManualAccount } from '../core/manual-identity';
import { inviteUser, acceptInvitation, revokeInvitation, setAppUserArchived, type AuthProvider } from '../core/auth';
import { listUsers } from '../core/admin';
import { listEmployeeActivationCandidates } from '../core/employee-user-activation';
import { hireEmployee } from '../core/org';
import { myEmployment } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { ManualAccountProvider } from '../lib/identity/manual-provider';

const issuer = 'https://hr.test/identity/realms/ai-hr';
const password = 'Private-temporary-password-827';
const emailProvider: AuthProvider = { sendInvitation: async () => ({ invitationId: 'fake' }), revokeInvitation: async () => {}, sendPasswordReset: async () => {}, endSession: async () => {} };
let base: Base, ctx: SessionContext;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); ctx = adminCtx(base);
  await owner.db.insert(schema.appExternalIdentity).values({ issuer, subject: 'admin', appUserId: base.adminUserId });
  for (const [key, value] of Object.entries({ AUTH_PROVIDER: 'keycloak', AUTH_PUBLIC_ORIGIN: 'https://hr.test', KEYCLOAK_ISSUER: issuer,
    KEYCLOAK_WEB_CLIENT_ID: 'web', KEYCLOAK_WEB_CLIENT_SECRET: 'secret', KEYCLOAK_MOBILE_CLIENT_ID: 'mobile', KEYCLOAK_API_AUDIENCE: 'api', AUTH_SESSION_KEY: 'f'.repeat(64) })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs()); afterAll(closeAll);
const input = () => ({ id: randomUUID(), personId: null, fullName: 'External consultant', username: 'external.user', email: 'external@example.test', role: 'hr_admin', companyId: base.companyId, password, ownershipAttested: true });
function provider(): ManualAccountProvider & { create: ReturnType<typeof vi.fn>; setPassword: ReturnType<typeof vi.fn>; enable: ReturnType<typeof vi.fn> } {
  return { create: vi.fn(async () => randomUUID()), setPassword: vi.fn(async () => {}), enable: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
}
async function principal(userId: string) {
  const [user] = await owner.db.select().from(schema.appUser).where(eq(schema.appUser.id, userId));
  const [binding] = await owner.db.select().from(schema.appExternalIdentity).where(eq(schema.appExternalIdentity.appUserId, userId));
  const [resolved] = await client`select * from app.principal_by_identity(${binding.issuer},${binding.subject})`;
  return { user, resolved, binding };
}

describe('named users without employment', () => {
  it('creates a scoped login, resolves its real principal, and creates no employment or payroll facts', async () => {
    const p = provider(), request = input();
    const before = await owner.db.select().from(schema.employment);
    const userId = await createManualAccount(ctx, request, p);
    const { user, resolved } = await principal(userId);
    expect(user.personId).toBeTruthy();
    expect(resolved.person_id).toBe(user.personId);
    expect(resolved.grants).toEqual([{ role: 'hr_admin', companyId: base.companyId }]);
    expect(await owner.db.select().from(schema.employment)).toEqual(before);
    expect(await owner.db.select().from(schema.compensation)).toHaveLength(0);
    const row = (await listUsers(ctx)).users.find(u => u.id === userId);
    expect(row).toMatchObject({ name: request.fullName, email: request.email, hasEmployment: false, blockedByTermination: false });
    const external: SessionContext = { ...ctx, userId, personId: user.personId, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    expect(await myEmployment(external)).toBeNull();
    const foreign = await seedBase();
    const visible = await withTenant(external, tx => tx.select().from(schema.company));
    expect(visible.map(c => c.id)).toContain(base.companyId);
    expect(visible.map(c => c.id)).not.toContain(foreign.companyId);
    expect(await createManualAccount(ctx, request, p)).toBe(userId);
    expect(p.create).toHaveBeenCalledTimes(1); expect(p.setPassword).toHaveBeenCalledTimes(1);
    await setAppUserArchived(ctx, { appUserId: userId, archived: true });
    expect((await principal(userId)).resolved).toBeUndefined();
    await setAppUserArchived(ctx, { appUserId: userId, archived: false });
    expect((await principal(userId)).resolved.app_user_id).toBe(userId);
  });
  it('serializes retries without duplicating the person, and resumes interrupted setup by the same ID', async () => {
    const p = provider(), request = input(); p.enable.mockRejectedValueOnce(new Error('offline'));
    await expect(createManualAccount(ctx, request, p)).rejects.toMatchObject({ code: 'unavailable' });
    const results = await Promise.all([resumeManualAccount(ctx, request.id, '', p), createManualAccount(ctx, request, p)]);
    expect(results[0]).toBe(results[1]);
    expect(p.create).toHaveBeenCalledTimes(1); expect(p.setPassword).toHaveBeenCalledTimes(1);
    expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail, request.email))).toHaveLength(1);
  });
  it('supports invitations, preserves the exact named person, and does not manufacture an employment', async () => {
    const { token, invitationId } = await inviteUser(ctx, { fullName: 'Invited consultant', email: 'invite@example.test', role: 'payroll_partner', companyId: base.companyId }, emailProvider);
    const [inv] = await owner.db.select().from(schema.appInvitation).where(eq(schema.appInvitation.id, invitationId));
    expect((await listEmployeeActivationCandidates(ctx)).find(p => p.id === inv.personId)).toMatchObject({ name: 'Invited consultant', hasEmployment: false });
    const accepted = await acceptInvitation({ token, issuer, subject: randomUUID(), verifiedEmail: inv.email });
    expect(accepted).toBeDefined();
    const users = (await listUsers(ctx)).users.filter(u => u.personId === inv.personId);
    expect(users).toHaveLength(1); expect(users[0]).toMatchObject({ name: 'Invited consultant', hasEmployment: false });
    expect(await owner.db.select().from(schema.employment).where(eq(schema.employment.personId, inv.personId!))).toHaveLength(0);
    await expect(acceptInvitation({ token, issuer, subject: randomUUID(), verifiedEmail: inv.email })).rejects.toThrow();
  });
  it('keeps cancelled setup and revoked invitations recoverable through explicit person selection', async () => {
    const p = provider(), request = input(); p.setPassword.mockRejectedValueOnce(new Error('offline'));
    await expect(createManualAccount(ctx, request, p)).rejects.toBeDefined();
    await cancelManualAccount(ctx, request.id, p);
    const [person] = await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail, request.email));
    expect((await listEmployeeActivationCandidates(ctx)).map(p => p.id)).toContain(person.id);
    const invite = await inviteUser(ctx, { personId: person.id, email: request.email, role: 'employee' }, emailProvider);
    await revokeInvitation(ctx, {invitationId:invite.invitationId}, emailProvider);
    expect((await listEmployeeActivationCandidates(ctx)).map(p => p.id)).toContain(person.id);
    const userId = await createManualAccount(ctx, { ...request, id: randomUUID(), personId: person.id }, provider());
    expect((await principal(userId)).user.personId).toBe(person.id);
  });
  it('refuses duplicate email creation without adopting an existing person, including ended staff', async () => {
    const request = input(), p = provider();
    const employee = await hireEmployee(ctx, { person: { fullName: 'Existing employee', primaryEmail: request.email }, companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01' });
    const yesterday = new Date(`${todayInKualaLumpur()}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await owner.db.update(schema.employment).set({ terminatedOn: yesterday.toISOString().slice(0, 10) }).where(eq(schema.employment.id, employee.employmentId));
    await expect(createManualAccount(ctx, request, p)).rejects.toMatchObject({ code: 'conflict' });
    await expect(createManualAccount(ctx, { ...request, personId: employee.personId }, p)).rejects.toMatchObject({ code: 'target' });
    expect(p.create).not.toHaveBeenCalled();
    await expect(inviteUser(ctx, { fullName: request.fullName, email: request.email, role: 'employee' }, emailProvider)).rejects.toThrow();
    expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail, request.email))).toHaveLength(1);
  });
  it('refuses a direct SQL contact creation when security administration is explicitly denied',async()=>{
    await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,effect) values(${base.tenantId}::uuid,${base.adminUserId}::uuid,'access.configure','deny')`;
    await expect(withTenant(ctx,tx=>tx.execute(sql`select app.create_login_person('Denied contact','denied@example.test')`))).rejects.toThrow();
    await expect(createManualAccount(ctx,input(),provider())).rejects.toBeDefined();
    expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail,'denied@example.test'))).toHaveLength(0);
  });
  it('serializes different new-person requests for the same email without merging identities',async()=>{
    const request=input(),p=provider();
    const results=await Promise.allSettled([createManualAccount(ctx,request,p),createManualAccount(ctx,{...request,id:randomUUID(),username:'another.username'},provider())]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail,request.email))).toHaveLength(1);
  });
  it('enforces live group authority in SQL, foreign company boundaries, validation, and rollback', async () => {
    const request = input(), p = provider(), foreign = await seedBase();
    for (const change of [{ fullName: '' }, { role: '' }, { role: 'operator' }, { companyId: foreign.companyId }, { role: 'super_admin', companyId: base.companyId }, { ownershipAttested: false }]) {
      await expect(createManualAccount(ctx, { ...request, ...change }, p)).rejects.toBeDefined();
    }
    expect(await owner.db.select().from(schema.person).where(eq(schema.person.primaryEmail, request.email))).toHaveLength(0);
    await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, base.adminUserId));
    await expect(withTenant(ctx, tx => tx.execute(sql`select app.create_login_person('Forbidden',${request.email})`))).rejects.toThrow();
    await expect(createManualAccount(ctx, request, p)).rejects.toMatchObject({ code: 'forbidden' });
    expect(p.create).not.toHaveBeenCalled();
  });
});
