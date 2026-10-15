import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { eq } from 'drizzle-orm';
import { client } from '../db/client';
import * as schema from '../db/schema';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { internalIssuer } from '../lib/internal-auth/config';
import { digest } from '../lib/internal-auth/crypto';
import { readRecord, writeRecord } from '../lib/internal-auth/store';
import { changeInitialPassword, credentialByLogin, readSession, revokeSession, rotateRefresh, startLogin, verifyMfa, type AuthReply, type Credential } from '../lib/internal-auth/service';
import { requestRecovery, completeRecovery } from '../lib/internal-auth/recovery';
import { startInvitation } from '../lib/internal-auth/invitations';
import { createManualAccount, resumeManualAccount } from '../core/manual-identity';
import { inviteUser, type AuthProvider } from '../core/auth';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let base: Base;
const temp = 'Temporary private passphrase 722!';
const final = 'A brand new secret phrase 933!';
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', '9'.repeat(64));
  vi.stubEnv('AUTH_DEFAULT_ORGANIZATION', 'alpha');
  await bootstrapInternalOwner(owner.client, { appUserId: base.adminUserId, organization: 'alpha', username: 'owner', email: 'owner@example.test', password: temp, installationOperator: true });
});
afterEach(() => vi.unstubAllEnvs()); afterAll(closeAll);
function challenge(value: AuthReply) { if (!('challenge' in value)) throw new Error('Expected challenge'); return value.challenge; }
function completed(value: AuthReply) { if (value.step !== 'complete') throw new Error('Expected full session'); return value; }
async function enroll(native = false) {
  const login = await startLogin({ organization: 'ALPHA', username: 'OWNER', password: temp, native });
  expect(login.step).toBe('password');
  const setup = await changeInitialPassword(challenge(login), final, native);
  if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected MFA setup');
  const signedIn = completed(await verifyMfa(challenge(setup), await generate({ secret: setup.secret }), native));
  return { signedIn, setup };
}
async function nextCode(c: Credential) { return generate({ secret: c.totpSecret!, epoch: (c.lastStep + 1) * 30 }); }

describe('first-party authentication with real private storage and existing HR bindings', () => {
  it('requires password change and confirmed MFA before granting any browser or API session', async () => {
    const { signedIn } = await enroll();
    const identity = await readSession(signedIn.access_token); expect(identity?.issuer).toBe(internalIssuer(base.tenantId));
    expect(identity?.credential.tenantId).toBe(base.tenantId); expect(await readSession(signedIn.access_token, true)).toBeNull();
    expect(signedIn.recoveryCodes).toHaveLength(8);
    const [p] = await client`select * from app.principal_by_identity(${identity!.issuer},${identity!.subject})`;
    expect(p.app_user_id).toBe(base.adminUserId); expect(p.grants).toContainEqual(expect.objectContaining({ role: 'hr_admin' }));
    const raw = JSON.stringify(await owner.client`select * from app_internal_auth_record`);
    for (const secret of [temp, final, signedIn.access_token, signedIn.recoveryCodes![0]]) expect(raw).not.toContain(secret);
    await expect(client`select * from app_internal_auth_record`).rejects.toThrow(/permission denied/);
  });
  it('blocks wrong passwords, unknown users, partial and forged handles and cross-carrier challenge completion', async () => {
    for (const username of ['owner', 'missing']) await expect(startLogin({ organization: 'alpha', username, password: 'Wrong private passphrase 999!', native: false })).rejects.toMatchObject({ code: 'invalidLogin' });
    const login = await startLogin({ organization: 'alpha', username: 'owner', password: temp, native: false });
    expect(await readSession(challenge(login))).toBeNull(); expect(await readSession('A'.repeat(43))).toBeNull();
    await expect(changeInitialPassword(challenge(login), final, true)).rejects.toMatchObject({ code: 'invalidChallenge' });
    await expect(verifyMfa(challenge(login), '000000')).rejects.toMatchObject({ code: 'invalidChallenge' });
  });
  it('consumes a TOTP step and challenge once under concurrent requests', async () => {
    await enroll(); const c = (await credentialByLogin('alpha', 'owner'))!;
    const login = await startLogin({ organization: 'alpha', username: 'owner', password: final, native: false });
    const code = await nextCode(c);
    const results = await Promise.allSettled([verifyMfa(challenge(login), code), verifyMfa(challenge(login), code)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const other = await startLogin({ organization: 'alpha', username: 'owner', password: final, native: false });
    await expect(verifyMfa(challenge(other), code)).rejects.toMatchObject({ code: 'invalidCode' });
  });
  it('caps failed MFA attempts and does not allow an old challenge to create a session', async () => {
    await enroll(); const login = await startLogin({ organization: 'alpha', username: 'owner', password: final, native: false });
    for (let i = 0; i < 5; i++) await expect(verifyMfa(challenge(login), 'bad-code')).rejects.toMatchObject({ code: 'invalidCode' });
    const c = (await credentialByLogin('alpha', 'owner'))!;
    await expect(verifyMfa(challenge(login), await nextCode(c))).rejects.toMatchObject({ code: 'invalidChallenge' });
  });
  it('uses each recovery code once and revokes browser sessions on logout and HR archive', async () => {
    const { signedIn } = await enroll(); const code = signedIn.recoveryCodes![0];
    const login = await startLogin({ organization: 'alpha', username: 'owner', password: final, native: false });
    const second = completed(await verifyMfa(challenge(login), code));
    const again = await startLogin({ organization: 'alpha', username: 'owner', password: final, native: false });
    await expect(verifyMfa(challenge(again), code)).rejects.toMatchObject({ code: 'invalidCode' });
    await revokeSession(second.access_token); expect(await readSession(second.access_token)).toBeNull();
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, base.adminUserId));
    expect(await readSession(signedIn.access_token)).toBeNull();
  });
  it('rotates native refresh handles and revokes the entire family on reuse, without accepting a browser cookie', async () => {
    const { signedIn } = await enroll(true);
    expect(await readSession(signedIn.access_token, true)).not.toBeNull(); expect(await readSession(signedIn.access_token)).toBeNull();
    const next = completed(await rotateRefresh(signedIn.refresh_token!));
    expect(next.refresh_token).not.toBe(signedIn.refresh_token); expect(await readSession(next.access_token, true)).not.toBeNull();
    await expect(rotateRefresh(signedIn.refresh_token!)).rejects.toMatchObject({ code: 'invalidLogin' });
    expect(await readSession(next.access_token, true)).toBeNull();
    await expect(rotateRefresh(next.refresh_token!)).rejects.toMatchObject({ code: 'invalidLogin' });
  });
  it('namespaces identical usernames in different organizations and never adopts an account by shared email', async () => {
    const other = await seedBase();
    await bootstrapInternalOwner(owner.client, { appUserId: other.adminUserId, organization: 'beta', username: 'owner', email: 'owner@example.test', password: 'Different private passphrase 555!', installationOperator: false });
    const a = (await credentialByLogin('alpha', 'owner'))!, b = (await credentialByLogin('beta', 'owner'))!;
    expect(a.subject).not.toBe(b.subject); expect(a.tenantId).toBe(base.tenantId); expect(b.tenantId).toBe(other.tenantId);
    await expect(startLogin({ organization: 'beta', username: 'owner', password: temp, native: false })).rejects.toMatchObject({ code: 'invalidLogin' });
    await expect(bootstrapInternalOwner(owner.client, { appUserId: other.adminUserId, organization: 'alpha', username: 'other', email: 'other@example.test', password: temp, installationOperator: false })).rejects.toThrow(/namespace|bound/);
  });
  it('bootstrap is idempotent for the exact existing user and never resets an enrolled password', async () => {
    await enroll();
    const before = await credentialByLogin('alpha', 'owner');
    const result = await bootstrapInternalOwner(owner.client, { appUserId: base.adminUserId, organization: 'alpha', username: 'owner', email: 'owner@example.test', password: 'Another different phrase 888!', installationOperator: true });
    expect(result.alreadyEnrolled).toBe(true); expect(await credentialByLogin('alpha', 'owner')).toEqual(before);
    await expect(bootstrapInternalOwner(client, { appUserId: base.adminUserId, organization: 'alpha', username: 'intruder', email: 'intruder@example.test', password: temp, installationOperator: true })).rejects.toThrow(/owner connection/);
  });
  it('local manual enrollment preserves the employee ID, requires MFA and never resets an active password on resume', async () => {
    await enroll(); const ctx = adminCtx(base);
    const employee = await hireEmployee(ctx, { person: { fullName: 'Local Account', primaryEmail: 'local@example.test' }, companyId: base.companyId,
      departmentId: base.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    const input = { id: randomUUID(), personId: employee.personId, username: 'local.user', email: 'local@example.test', role: 'employee', companyId: null, password: temp, ownershipAttested: true };
    const id = await createManualAccount(ctx, input);
    const c = await credentialByLogin('alpha', 'local.user'); expect(c?.enabled).toBe(true); expect(c?.mustChange).toBe(true);
    expect(await resumeManualAccount(ctx, input.id, 'Changed by replay 111111!')).toBe(id);
    expect((await credentialByLogin('alpha', 'local.user'))?.password).toBe(c?.password);
    const [person] = await owner.client`select person_id from app_user where id=${id}::uuid`; expect(person.person_id).toBe(employee.personId);
  });
  it('recovery keeps MFA, consumes its link once and invalidates every prior session', async () => {
    const { signedIn } = await enroll(); const c = (await credentialByLogin('alpha', 'owner'))!;
    await writeRecord(client, 'email-state', { active: { config: { host: 'smtp.invalid' } }, revision: 'test', drafts: {} }, null);
    await requestRecovery('alpha', 'owner');
    const rows = await owner.client`select record_key,sealed from app_internal_auth_record where record_key like 'mail:%'`;
    expect(rows).toHaveLength(1);
    const mail = await readRecord<{ text: string }>(client, rows[0].record_key); const token = mail!.text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
    await expect(completeRecovery(token, 'A replacement secure phrase 556!', 'bad-code')).rejects.toMatchObject({ code: 'invalidCode' });
    expect(await readSession(signedIn.access_token)).not.toBeNull();
    await completeRecovery(token, 'A replacement secure phrase 556!', signedIn.recoveryCodes![0]);
    expect(await readSession(signedIn.access_token)).toBeNull(); expect((await credentialByLogin('alpha', 'owner'))?.totpSecret).toBe(c.totpSecret);
    await expect(completeRecovery(token, 'Yet another secure phrase 337!', signedIn.recoveryCodes![1])).rejects.toMatchObject({ code: 'invalidChallenge' });
    const login = await startLogin({ organization: 'alpha', username: 'owner', password: 'A replacement secure phrase 556!', native: false }); expect(login.step).toBe('mfa');
    expect(await readRecord(client, `recovery:${digest(token)}`)).toBeNull();
  });
  it('invitation enrollment cannot grant HR access before MFA and cannot bind twice', async () => {
    const provider: AuthProvider = { sendInvitation: async () => ({ invitationId: 'test' }), revokeInvitation: async () => {}, sendPasswordReset: async () => {}, endSession: async () => {} };
    const invite = await inviteUser(adminCtx(base), { email: 'invited@example.test', role: 'employee' }, provider);
    const setup = await startInvitation(invite.token, 'invited', final);
    if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected setup');
    expect(await credentialByLogin('alpha', 'invited')).toBeNull(); expect(await readSession(challenge(setup))).toBeNull();
    const result = completed(await verifyMfa(challenge(setup), await generate({ secret: setup.secret })));
    expect((await readSession(result.access_token))?.credential.email).toBe('invited@example.test');
    await expect(startInvitation(invite.token, 'another', final)).rejects.toMatchObject({ code: 'invalidChallenge' });
  });
});
