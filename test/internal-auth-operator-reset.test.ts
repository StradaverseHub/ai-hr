import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { client } from '../db/client';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { digest } from '../lib/internal-auth/crypto';
import { previewSignInReset, resetSignIn } from '../lib/internal-auth/operator-reset';
import { readRecord, writeRecord } from '../lib/internal-auth/store';
import { requestRecovery } from '../lib/internal-auth/recovery';
import { changeInitialPassword, credentialByLogin, readSession, startLogin, verifyMfa, type AuthReply } from '../lib/internal-auth/service';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
const temp = 'Temporary private passphrase 722!';
const final = 'A brand new secret phrase 933!';
const operatorTemp = 'Operator issued phrase 611!';
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase();
  vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', '9'.repeat(64));
  vi.stubEnv('AUTH_DEFAULT_ORGANIZATION', 'alpha');
  await bootstrapInternalOwner(owner.client, { appUserId: base.adminUserId, organization: 'alpha', username: 'owner', email: 'owner@example.test', password: temp, installationOperator: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); }); afterAll(closeAll);
function challenge(value: AuthReply) { if (!('challenge' in value)) throw new Error('Expected challenge'); return value.challenge; }
function completed(value: AuthReply) { if (value.step !== 'complete') throw new Error('Expected full session'); return value; }
async function enroll() {
  const login = await startLogin({ organization: 'alpha', username: 'owner', password: temp, native: false });
  const setup = await changeInitialPassword(challenge(login), final);
  if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected MFA setup');
  return { signedIn: completed(await verifyMfa(challenge(setup), await generate({ secret: setup.secret }))), secret: setup.secret };
}
const login = { organization: 'ALPHA', username: 'Owner' };

describe('operator sign-in reset after a lost authenticator', () => {
  it('replaces the password, removes MFA and every session, and re-enrolls through the normal journey', async () => {
    const { signedIn, secret } = await enroll();
    const before = (await credentialByLogin('alpha', 'owner'))!;
    await writeRecord(client, 'email-state', { active: { config: { host: 'smtp.invalid' } }, revision: 'test', drafts: {} }, null);
    let link = '';
    await requestRecovery('alpha', 'owner', async (_relay, mail) => { link = mail.text.match(/#token=([A-Za-z0-9_-]{43})/)![1]; });
    expect(link).not.toBe('');

    const preview = await previewSignInReset(owner.client, login);
    expect(preview).toMatchObject({ organization: 'alpha', username: 'owner', email: 'owner@example.test' });
    expect(preview.grants).toContainEqual({ role: 'hr_admin', company: null });
    expect(preview.confirmation).toMatch(/^[0-9a-f]{12}$/);
    const result = await resetSignIn(owner.client, { ...login, confirmation: preview.confirmation, password: operatorTemp });
    expect(result).toEqual({ appUserId: base.adminUserId, tenantId: base.tenantId });

    const after = (await credentialByLogin('alpha', 'owner'))!;
    expect(after).toMatchObject({ subject: before.subject, tenantId: before.tenantId, issuer: before.issuer, email: before.email,
      enabled: true, mustChange: true, totpSecret: null, lastStep: -1, recoveryHashes: [] });
    expect(after.version).not.toBe(before.version);
    expect(await readSession(signedIn.access_token)).toBeNull();
    expect(await readRecord(client, `recovery:${digest(link)}`)).toBeNull();
    await expect(startLogin({ organization: 'alpha', username: 'owner', password: final, native: false })).rejects.toMatchObject({ code: 'invalidLogin' });

    const next = await startLogin({ organization: 'alpha', username: 'owner', password: operatorTemp, native: false });
    expect(next.step).toBe('password');
    const setup = await changeInitialPassword(challenge(next), 'Chosen replacement phrase 404!');
    if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected a new authenticator');
    expect(setup.secret).not.toBe(secret);
    await expect(verifyMfa(challenge(setup), signedIn.recoveryCodes![0])).rejects.toMatchObject({ code: 'invalidCode' });
    const session = completed(await verifyMfa(challenge(setup), await generate({ secret: setup.secret })));
    expect(session.recoveryCodes).toHaveLength(8);
    const identity = await readSession(session.access_token);
    expect(identity?.subject).toBe(before.subject);
    const [principal] = await client`select * from app.principal_by_identity(${identity!.issuer},${identity!.subject})`;
    expect(principal.app_user_id).toBe(base.adminUserId); expect(principal.grants).toContainEqual(expect.objectContaining({ role: 'hr_admin' }));

    const events = await owner.client`select actor_type,actor_id,aggregate_id,payload from domain_event
      where tenant_id=${base.tenantId}::uuid and event_type='app-user.operator-sign-in-reset'`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'system', actor_id: null, aggregate_id: base.adminUserId,
      payload: { organization: 'alpha', authenticatorRemoved: true, identityVerifiedOutOfBand: true } });
    const raw = JSON.stringify([events, await owner.client`select * from app_internal_auth_record`]);
    for (const secretValue of [operatorTemp, setup.secret, session.recoveryCodes![0]]) expect(raw).not.toContain(secretValue);
  });

  it('refuses the application role, unknown and archived logins, stale review and reused passwords without changing anything', async () => {
    await enroll();
    const before = (await credentialByLogin('alpha', 'owner'))!;
    await expect(previewSignInReset(client, login)).rejects.toThrow(/owner connection/);
    await expect(resetSignIn(client, { ...login, confirmation: 'x', password: operatorTemp })).rejects.toThrow(/owner connection/);
    await expect(previewSignInReset(owner.client, { organization: 'alpha', username: 'nobody' })).rejects.toThrow(/No sign-in/);
    await expect(previewSignInReset(owner.client, { organization: 'beta', username: 'owner' })).rejects.toThrow(/No sign-in/);
    await expect(previewSignInReset(owner.client, { organization: 'alpha', username: 'x' })).rejects.toThrow(/Invalid/);

    const { confirmation } = await previewSignInReset(owner.client, login);
    await expect(resetSignIn(owner.client, { ...login, confirmation: '000000000000', password: operatorTemp })).rejects.toThrow(/changed after review/);
    for (const previous of [temp, final]) await expect(resetSignIn(owner.client, { ...login, confirmation, password: previous })).rejects.toMatchObject({ code: 'passwordPolicy' });
    await expect(resetSignIn(owner.client, { ...login, confirmation, password: 'short' })).rejects.toMatchObject({ code: 'passwordPolicy' });
    expect(await credentialByLogin('alpha', 'owner')).toEqual(before);

    await writeRecord(client, `credential:${before.subject}`, { ...before, version: randomUUID() }, before.subject);
    await expect(resetSignIn(owner.client, { ...login, confirmation, password: operatorTemp })).rejects.toThrow(/changed after review/);
    await writeRecord(client, `credential:${before.subject}`, before, before.subject);

    await owner.client`update app_user set archived_at=now() where id=${base.adminUserId}::uuid`;
    await expect(previewSignInReset(owner.client, login)).rejects.toThrow(/archived, offboarded/);
    await expect(resetSignIn(owner.client, { ...login, confirmation, password: operatorTemp })).rejects.toThrow(/archived, offboarded/);
    expect(await credentialByLogin('alpha', 'owner')).toEqual(before);
    expect(await owner.client`select 1 from domain_event where event_type='app-user.operator-sign-in-reset'`).toHaveLength(0);
  });
});
