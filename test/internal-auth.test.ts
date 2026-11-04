import {manageAccount,readManagedAccount} from '../core/account-management';
import { pgSqlState } from '../lib/db-error';
import { readRememberedMfaPolicyEditor, saveRememberedMfaPolicy } from '../core/remembered-mfa-policy';
import { rememberedFactorValid } from '../lib/internal-auth/remembered-mfa';
import {NEW_PASSWORD_REQUIREMENTS} from '../lib/password-policy';
import { readPasswordPolicy, savePasswordPolicy, unlockPasswordAccount } from '../core/password-policy';
import {saveEmailDesign} from '../core/email-design/service';
import {defaultEmailDocument} from '../lib/email-design/model';
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
import { requestRecovery, completeRecovery, sendInternalRecovery } from '../lib/internal-auth/recovery';
import { sendInternalInvitation,startInvitation, acceptInternalInvitation } from '../lib/internal-auth/invitations';
import { createManualAccount, resumeManualAccount } from '../core/manual-identity';
import { readAccountEmailDeliveries } from '../core/account-email';
import { withInternalRecoveryLabels } from '../lib/internal-auth/account-email-view';
import { inviteUser, retryAccountEmail, type AuthProvider } from '../core/auth';
import { provisionTenant } from '../db/provision';
import { withTenant } from '../db/client';
import { sql } from 'drizzle-orm';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { getMobileSession } from '../lib/session';
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
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }); afterAll(closeAll);
function challenge(value: AuthReply) { if (!('challenge' in value)) throw new Error('Expected challenge'); return value.challenge; }
function completed(value: AuthReply) { if (value.step !== 'complete') throw new Error('Expected full session'); return value; }
async function enroll(native = false, rememberDevice = false) {
  const login = await startLogin({ organization: 'ALPHA', username: 'OWNER', password: temp, native });
  expect(login.step).toBe('password');
  const setup = await changeInitialPassword(challenge(login), final, native);
  if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected MFA setup');
  const signedIn = completed(await verifyMfa(challenge(setup), await generate({ secret: setup.secret }), native, rememberDevice));
  return { signedIn, setup };
}
async function nextCode(c: Credential) { return generate({ secret: c.totpSecret!, epoch: (c.lastStep + 1) * 30 }); }

describe('first-party authentication with real private storage and existing HR bindings', () => {
  it('suspends account-wide access and rejects expired reactivation for browser and native',async()=>{
    const {signedIn}=await enroll(true),ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await manageAccount(ctx,base.adminUserId,{type:'suspend',reason:'Reported lost device'});
    expect((await readManagedAccount(ctx,base.adminUserId)).status).toBe('suspended');
    expect(await readSession(signedIn.access_token,true)).toBeNull();
    await expect(rotateRefresh(signedIn.refresh_token!)).rejects.toMatchObject({code:'invalidLogin'});
    await expect(startLogin({organization:'alpha',username:'owner',password:final,native:false})).rejects.toMatchObject({code:'invalidLogin'});
    await manageAccount(ctx,base.adminUserId,{type:'expiry',reason:'Contract access end',activeUntil:'2000-01-01'});
    await expect(manageAccount(ctx,base.adminUserId,{type:'reactivate',reason:'Reviewed restoration'})).rejects.toThrow('expired');
    await manageAccount(ctx,base.adminUserId,{type:'expiry',reason:'Approved extension',activeUntil:null});
    await manageAccount(ctx,base.adminUserId,{type:'reactivate',reason:'Reviewed restoration'});
    expect((await readManagedAccount(ctx,base.adminUserId)).status).toBe('active');
    expect(await readSession(signedIn.access_token,true)).toBeNull();
  });
  it('admits a temporary password once and never exposes it in audit or summary',async()=>{
    await enroll();const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]},password='A new single use password 529!';
    await manageAccount(ctx,base.adminUserId,{type:'temporary-password',reason:'Verified account recovery',password,minutes:30});
    const login=await startLogin({organization:'alpha',username:'owner',password,native:false});
    expect(login.step).toBe('mfa');
    await expect(startLogin({organization:'alpha',username:'owner',password,native:false})).rejects.toMatchObject({code:'invalidLogin'});
    expect(JSON.stringify(await readManagedAccount(ctx,base.adminUserId))).not.toContain(password);
    expect(JSON.stringify(await owner.client`select payload from domain_event where aggregate_id=${base.adminUserId}::uuid`)).not.toContain(password);
  });
  it('enforces account expiry on existing web/native sessions without relying on a scheduler',async()=>{
    const {signedIn}=await enroll(true),c=(await credentialByLogin('alpha','owner'))!;
    c.accountActiveUntil='2000-01-01';await writeRecord(client,`credential:${c.subject}`,c,c.subject);
    expect(await readSession(signedIn.access_token,true)).toBeNull();
    await expect(rotateRefresh(signedIn.refresh_token!)).rejects.toMatchObject({code:'invalidLogin'});
    await expect(startLogin({organization:'alpha',username:'owner',password:final,native:false})).rejects.toMatchObject({code:'invalidLogin'});
  });
  it('consumes a bounded exemption only for password recovery and requires MFA for subsequent HR access',async()=>{
    await enroll();const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await manageAccount(ctx,base.adminUserId,{type:'recovery-exemption',reason:'Verified offline recovery',minutes:5});
    await writeRecord(client,'email-state',{active:{config:{host:'smtp.invalid'}},revision:'test',drafts:{}},null);
    let text='';await requestRecovery('alpha','owner',async(_relay,mail)=>{text=mail.text;});
    const token=text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
    await completeRecovery(token,'Recovered new private passphrase 636!','');
    const c=(await credentialByLogin('alpha','owner'))!;
    expect(await readRecord(client,`recovery-exemption:${c.subject}`)).toBeNull();
    await expect(completeRecovery(token,'Another unused private passphrase 637!','')).rejects.toMatchObject({code:'invalidChallenge'});
    expect((await startLogin({organization:'alpha',username:'owner',password:'Recovered new private passphrase 636!',native:false})).step).toBe('mfa');
  });
  it('denies unlinked account management to company HR and rejects cross-tenant targets',async()=>{
    await enroll();const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:base.companyId}]};
    await expect(manageAccount(ctx,base.adminUserId,{type:'suspend',reason:'Unauthorized scoped action'})).rejects.toThrow();
    const group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await expect(manageAccount(group,randomUUID(),{type:'suspend',reason:'Unknown target account'})).rejects.toThrow('forbidden');
    expect((await credentialByLogin('alpha','owner'))?.suspended).not.toBe(true);
  });
  it('requires password change and confirmed MFA before granting any browser or API session', async () => {
    const externalHttp = vi.fn(async () => { throw new Error('External HTTP is blocked in this on-prem fixture.'); });
    vi.stubGlobal('fetch', externalHttp);
    const { signedIn } = await enroll();
    const identity = await readSession(signedIn.access_token); expect(identity?.issuer).toBe(internalIssuer(base.tenantId));
    expect(identity?.credential.tenantId).toBe(base.tenantId); expect(await readSession(signedIn.access_token, true)).toBeNull();
    expect(signedIn.recoveryCodes).toHaveLength(8);
    const [p] = await client`select * from app.principal_by_identity(${identity!.issuer},${identity!.subject})`;
    expect(p.app_user_id).toBe(base.adminUserId); expect(p.grants).toContainEqual(expect.objectContaining({ role: 'hr_admin' }));
    const raw = JSON.stringify(await owner.client`select * from app_internal_auth_record`);
    for (const secret of [temp, final, signedIn.access_token, signedIn.recoveryCodes![0]]) expect(raw).not.toContain(secret);
    await expect(client`select * from app_internal_auth_record`).rejects.toThrow(/permission denied/);
    expect(externalHttp).not.toHaveBeenCalled();
  });
  it('enforces tenant expiry after MFA for browser/native sessions and refuses historical passwords', async () => {
    const { signedIn } = await enroll(true);
    const ctx = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
    expect(await readPasswordPolicy(ctx)).toMatchObject({ revision: 0, policy: { enabled: false } });
    await savePasswordPolicy(ctx, { enabled: true, interval: 1, unit: 'months' }, 0);
    const c = (await credentialByLogin('alpha', 'owner'))!;
    // A real expired credential, with existing session and refresh records still present.
    c.passwordChangedAt = Date.now() - 40 * 86_400_000;
    await writeRecord(client, `credential:${c.subject}`, c, c.subject);
    expect(await readSession(signedIn.access_token, true)).toBeNull();
    await expect(rotateRefresh(signedIn.refresh_token!)).rejects.toMatchObject({ code: 'invalidLogin' });
    const login = await startLogin({ organization: 'alpha', username: 'owner', password: final, native: true });
    expect(login.step).toBe('mfa');
    await expect(changeInitialPassword(challenge(login), 'Unused secure replacement 901!', true)).rejects.toMatchObject({ code: 'invalidChallenge' });
    const required = await verifyMfa(challenge(login), signedIn.recoveryCodes![0], true);
    expect(required.step).toBe('password');
    for (const previous of [temp, final]) await expect(changeInitialPassword(challenge(required), previous, true)).rejects.toMatchObject({ code: 'passwordPolicy' });
    const replacement = 'Unused secure replacement 901!';
    const next = completed(await changeInitialPassword(challenge(required), replacement, true));
    expect(await readSession(next.access_token, true)).not.toBeNull();
    expect(await readSession(signedIn.access_token, true)).toBeNull();
    await savePasswordPolicy(ctx, { enabled: true, interval: 1, unit: 'days' }, 1);
    const current = (await credentialByLogin('alpha', 'owner'))!;
    current.passwordChangedAt = Date.now() - 2 * 86_400_000;
    await writeRecord(client, `credential:${c.subject}`, current, c.subject);
    const web = await startLogin({ organization: 'alpha', username: 'owner', password: replacement, native: false });
    const again = await verifyMfa(challenge(web), signedIn.recoveryCodes![1]);
    expect(again.step).toBe('password');
    await expect(changeInitialPassword(challenge(again), final)).rejects.toMatchObject({ code: 'passwordPolicy' });
    const done = completed(await changeInitialPassword(challenge(again), 'Another unused secret phrase 902!'));
    expect(await readSession(done.access_token)).not.toBeNull();
  });
  it('enforces configured failures, generic refusal and tenant-guarded audited unlock',async()=>{
    const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await savePasswordPolicy(ctx,{enabled:false,interval:90,unit:'days',requirements:{...NEW_PASSWORD_REQUIREMENTS,lockoutEnabled:true,failedAttempts:2}},0);
    for(let i=0;i<2;i++)await expect(startLogin({organization:'alpha',username:'owner',password:'wrong',native:false})).rejects.toMatchObject({code:'invalidLogin'});
    await expect(startLogin({organization:'alpha',username:'owner',password:temp,native:false})).rejects.toMatchObject({code:'invalidLogin'});
    await expect(unlockPasswordAccount({...ctx,tenantId:randomUUID()},base.adminUserId)).rejects.toThrow();
    await expect(unlockPasswordAccount({...ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]},base.adminUserId)).rejects.toThrow();
    await unlockPasswordAccount(ctx,base.adminUserId);
    expect((await startLogin({organization:'alpha',username:'owner',password:temp,native:false})).step).toBe('password');
    const events=await owner.client`select id from domain_event where tenant_id=${base.tenantId}::uuid and event_type='app-user.password-unlocked'`;
    expect(events).toHaveLength(1);
  });
  it('verifies first-login enrollment before replacing a password and retains recovery codes',async()=>{
    const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await savePasswordPolicy(ctx,{enabled:false,interval:90,unit:'days',requirements:{...NEW_PASSWORD_REQUIREMENTS,firstResetVerification:true}},0);
    const setup=await startLogin({organization:'alpha',username:'owner',password:temp,native:true});
    if(setup.step!=='enroll'||!setup.secret)throw Error('Expected verified first-time setup');
    const change=await verifyMfa(challenge(setup),await generate({secret:setup.secret}),true,true);
    expect(change.step).toBe('password');
    await expect(changeInitialPassword(challenge(change),'short',true)).rejects.toMatchObject({code:'passwordPolicy'});
    const session=completed(await changeInitialPassword(challenge(change),'Valid changed secret 5!',true));
    expect(session.recoveryCodes).toHaveLength(8);expect(session.remembered_device_token).toBeUndefined();expect(await readSession(session.access_token,true)).not.toBeNull();
    expect((await startLogin({organization:'alpha',username:'owner',password:'Valid changed secret 5!',native:false})).step).toBe('mfa');
  });
  it('guards policy edits, revisions and tenant boundaries, with an audit event', async () => {
    const ctx = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
    for (const refused of [{ ...ctx, userId: undefined }, { ...ctx, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] }, { ...ctx, grants: [{ role: 'hr_admin', companyId: base.companyId }] }]) {
      await expect(savePasswordPolicy(refused, { enabled: true, interval: 90, unit: 'days' }, 0)).rejects.toThrow('forbidden');
    }
    // A forged/stale grant set must fail the current database principal snapshot.
    await expect(savePasswordPolicy({ ...ctx, userId: randomUUID() }, { enabled: true, interval: 90, unit: 'days' }, 0)).rejects.toThrow();
    await savePasswordPolicy(ctx, { enabled: true, interval: 90, unit: 'days' }, 0);
    await expect(savePasswordPolicy(ctx, { enabled: false, interval: 90, unit: 'days' }, 0)).rejects.toThrow('conflict');
    await expect(readPasswordPolicy({ ...ctx, tenantId: randomUUID() })).rejects.toThrow();
    expect(await readPasswordPolicy(ctx)).toMatchObject({ revision: 1, policy: { enabled: true, interval: 90, unit: 'days' } });
    const rows = await owner.client`select payload from domain_event where tenant_id=${base.tenantId} and event_type='password-policy.updated'`;
    expect(rows).toHaveLength(1); expect(rows[0].payload).toMatchObject({ revision: 1, interval: 90, unit: 'days' });
    await owner.client`delete from role_assignment where app_user_id=${base.adminUserId}`;
    await expect(savePasswordPolicy(ctx, { enabled: false, interval: 90, unit: 'days' }, 1)).rejects.toThrow('forbidden');
  });
  it('retains account guessing limits while verified-source traffic is independent of a spent global ceiling',async()=>{
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now());
    const now=Date.now(),window=60_000,start=Math.floor(now/window)*window;
    await writeRecord(client,`rate:${digest(`login-global:${start}`)}`,{count:120},null,start+2*window);
    await expect(startLogin({organization:'alpha',username:'owner',password:temp,native:true})).rejects.toMatchObject({code:'rateLimited'});
    const input={organization:'alpha',username:'owner',password:temp,native:true,sourceBudgeted:true};
    await expect(startLogin(input)).resolves.toMatchObject({step:'password'});
    for(let n=1;n<10;n++)await expect(startLogin({...input,password:'invalid phrase'})).rejects.toMatchObject({code:'invalidLogin'});
    await expect(startLogin(input)).rejects.toMatchObject({code:'rateLimited'});clock.mockRestore();
  });
  it('blocks wrong passwords, unknown users, partial and forged handles and cross-carrier challenge completion' , async () => {
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
    expect(await getMobileSession({ authorization: `Bearer ${signedIn.access_token}` })).toMatchObject({ userId: base.adminUserId, tenantId: base.tenantId, roles: ['hr_admin'] });
    await expect(getMobileSession({ authorization: `Bearer ${signedIn.refresh_token}` })).rejects.toMatchObject({name:'AuthRequiredError'});
    const next = completed(await rotateRefresh(signedIn.refresh_token!));
    expect(next.refresh_token).not.toBe(signedIn.refresh_token); expect(await readSession(next.access_token, true)).not.toBeNull();
    await expect(rotateRefresh(signedIn.refresh_token!)).rejects.toMatchObject({ code: 'invalidLogin' });
    expect(await readSession(next.access_token, true)).toBeNull();
    await expect(getMobileSession({ authorization: `Bearer ${next.access_token}` })).rejects.toMatchObject({name:'AuthRequiredError'});
    await expect(rotateRefresh(next.refresh_token!)).rejects.toMatchObject({ code: 'invalidLogin' });
  });
  it('revokes a native family using only its refresh handle during cold-start logout', async () => {
    const { signedIn } = await enroll(true);
    expect(await readSession(signedIn.access_token, true)).not.toBeNull();
    await revokeSession(undefined, true, signedIn.refresh_token);
    expect(await readSession(signedIn.access_token, true)).toBeNull();
    await expect(rotateRefresh(signedIn.refresh_token!)).rejects.toMatchObject({ code: 'invalidLogin' });
    await expect(getMobileSession({ authorization: `Bearer ${signedIn.access_token}` })).rejects.toMatchObject({ name: 'AuthRequiredError' });
  });
  it('namespaces identical usernames in different organizations and never adopts an account by shared email', async () => {
    const other = await seedBase();
    await bootstrapInternalOwner(owner.client, { appUserId: other.adminUserId, organization: 'beta', username: 'owner', email: 'owner@example.test', password: 'Different private passphrase 555!', installationOperator: false });
    const a = (await credentialByLogin('alpha', 'owner'))!, b = (await credentialByLogin('beta', 'owner'))!;
    expect(a.subject).not.toBe(b.subject); expect(a.tenantId).toBe(base.tenantId); expect(b.tenantId).toBe(other.tenantId);
    await expect(startLogin({ organization: 'beta', username: 'owner', password: temp, native: false })).rejects.toMatchObject({ code: 'invalidLogin' });
    await expect(bootstrapInternalOwner(owner.client, { appUserId: other.adminUserId, organization: 'alpha', username: 'other', email: 'other@example.test', password: temp, installationOperator: false })).rejects.toThrow(/namespace|bound/);
  });
  it('refuses an otherwise valid session after credential version change without relying on bulk deletion', async () => {
    const { signedIn } = await enroll(); const c = (await credentialByLogin('alpha', 'owner'))!;
    expect(await readSession(signedIn.access_token)).not.toBeNull();
    await writeRecord(client, `credential:${c.subject}`, { ...c, version: randomUUID() }, c.subject);
    expect((await owner.client`select count(*)::int n from app_internal_auth_record where record_key=${'session:' + digest(signedIn.access_token)}`)[0].n).toBe(1);
    expect(await readSession(signedIn.access_token)).toBeNull();
  });
  it('bootstrap is idempotent for the exact existing user and never resets an enrolled password', async () => {
    await enroll();
    const before = await credentialByLogin('alpha', 'owner');
    const result = await bootstrapInternalOwner(owner.client, { appUserId: base.adminUserId, organization: 'alpha', username: 'owner', email: 'owner@example.test', password: 'Another different phrase 888!', installationOperator: true });
    expect(result.alreadyEnrolled).toBe(true); expect(await credentialByLogin('alpha', 'owner')).toEqual(before);
    await expect(bootstrapInternalOwner(client, { appUserId: base.adminUserId, organization: 'alpha', username: 'intruder', email: 'intruder@example.test', password: temp, installationOperator: true })).rejects.toThrow(/owner connection/);
  });
  it('serializes concurrent claims of a new organization code across different tenants and usernames', async () => {
    const first = await seedBase(), second = await seedBase();
    const outcomes = await Promise.allSettled([
      bootstrapInternalOwner(owner.client, { appUserId: first.adminUserId, organization: 'shared-new', username: 'first.user', email: 'first@example.test', password: temp, installationOperator: false }),
      bootstrapInternalOwner(owner.client, { appUserId: second.adminUserId, organization: 'shared-new', username: 'second.user', email: 'second@example.test', password: temp, installationOperator: false }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    const organization = await readRecord<{ tenantId: string }>(client, 'org:shared-new');
    const candidates = await Promise.all(['first.user', 'second.user'].map(username => credentialByLogin('shared-new', username)));
    const accounts = candidates.filter(account => account !== null);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.tenantId).toBe(organization?.tenantId);
    const loser = organization?.tenantId === first.tenantId ? second : first;
    expect(await readRecord(client, `tenant:${loser.tenantId}`)).toBeNull();
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
    const login = await startLogin({organization:'alpha',username:'local.user',password:temp,native:true});
    const setup = await changeInitialPassword(challenge(login),final,true);
    if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected employee authenticator enrollment.');
    const signedIn = completed(await verifyMfa(challenge(setup),await generate({secret:setup.secret}),true));
    expect(await getMobileSession({authorization:`Bearer ${signedIn.access_token}`})).toMatchObject({userId:id,tenantId:base.tenantId,personId:employee.personId,roles:['employee']});
  });
  it('applies configured eight-character manual credentials and prospective force-change off',async()=>{
    const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await savePasswordPolicy(ctx,{enabled:false,interval:90,unit:'days',requirements:{...NEW_PASSWORD_REQUIREMENTS,forceFirstChange:false}},0);
    const id=await createManualAccount(ctx,{id:randomUUID(),personId:null,fullName:'Configured credential',username:'short.user',email:'short@example.test',role:'employee',companyId:null,password:'Short!42',ownershipAttested:true});
    expect(id).toBeTruthy();const credential=(await credentialByLogin('alpha','short.user'))!;
    expect(credential.enabled).toBe(true);expect(credential.mustChange).toBe(false);
    const login=await startLogin({organization:'alpha',username:'short.user',password:'Short!42',native:false});expect(login.step).toBe('enroll');
    expect((await credentialByLogin('alpha','owner'))!.mustChange).toBe(true);
  });
  it('a user without employment signs in through the real internal password-change and MFA flow', async () => {
    const ctx=adminCtx(base);
    const input={id:randomUUID(),personId:null,fullName:'External administrator',username:'external.admin',email:'external.admin@example.test',role:'hr_admin',companyId:base.companyId,password:temp,ownershipAttested:true};
    const id=await createManualAccount(ctx,input);
    const c=(await credentialByLogin('alpha','external.admin'))!;
    expect(c.enabled).toBe(true);expect(c.mustChange).toBe(true);
    const [user]=await owner.db.select().from(schema.appUser).where(eq(schema.appUser.id,id));
    expect(user.personId).toBeTruthy();
    expect(await owner.db.select().from(schema.employment).where(eq(schema.employment.personId,user.personId!))).toHaveLength(0);
    const login=await startLogin({organization:'alpha',username:'external.admin',password:temp,native:true});
    expect(login.step).toBe('password');expect(await readSession(challenge(login),true)).toBeNull();
    const setup=await changeInitialPassword(challenge(login),final,true);
    if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected authenticator enrollment.');
    const signedIn=completed(await verifyMfa(challenge(setup),await generate({secret:setup.secret}),true));
    expect(await getMobileSession({authorization:`Bearer ${signedIn.access_token}`})).toMatchObject({userId:id,tenantId:base.tenantId,personId:user.personId,grants:[{role:'hr_admin',companyId:base.companyId}]});
    const changed=(await credentialByLogin('alpha','external.admin'))!.password;
    expect(changed).not.toBe(c.password);
    expect(await resumeManualAccount(ctx,input.id,'Unused replay passphrase 111!')).toBe(id);
    expect((await credentialByLogin('alpha','external.admin'))?.password).toBe(changed);
  });
  it.each([false,true])('an invited user without employment activates once and follows the browser/native sign-in policy (native=%s)',async native=>{
    const provider:AuthProvider={sendInvitation:async()=>({invitationId:'test'}),revokeInvitation:async()=>{},sendPasswordReset:async()=>{},endSession:async()=>{}};
    const invite=await inviteUser(adminCtx(base),{fullName:'External payroll partner',email:'external.payroll@example.test',role:'payroll_partner',companyId:base.companyId},provider);
    const setup=await startInvitation(invite.token,'external.payroll',final,native);
    if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected authenticator enrollment.');
    const activated=await verifyMfa(challenge(setup),await generate({secret:setup.secret}),native);
    const session=await (async()=>{
      if(native)return getMobileSession({authorization:`Bearer ${completed(activated).access_token}`});
      expect(activated).toMatchObject({step:'activated',organization:'alpha'});
      expect(activated).not.toHaveProperty('access_token');
      if(activated.step!=='activated')throw new Error('Expected activation without a browser session.');
      const login=await startLogin({organization:'alpha',username:'external.payroll',password:final,native:false});
      expect(login.step).toBe('mfa');
      const signedIn=completed(await verifyMfa(challenge(login),activated.recoveryCodes![0]));
      const identity=await readSession(signedIn.access_token);
      expect(identity).not.toBeNull();
      const [principal]=await client`select * from app.principal_by_identity(${identity!.issuer},${identity!.subject})`;
      return {tenantId:principal.tenant_id,personId:principal.person_id,grants:principal.grants};
    })();
    expect(session).toMatchObject({tenantId:base.tenantId,grants:[{role:'payroll_partner',companyId:base.companyId}]});
    expect(await owner.db.select().from(schema.employment).where(eq(schema.employment.personId,session.personId!))).toHaveLength(0);
    await expect(startInvitation(invite.token,'another.username',final,native)).rejects.toBeDefined();
  });
  it('sends invitations in the inviter-selected language and preserves it on explicit retry',async()=>{
    const design=defaultEmailDocument('invitation');design.blocks[0]={...design.blocks[0],type:'header',label:'Fictional Bahasa invitation',style:{}};
    await saveEmailDesign(adminCtx(base),'invitation','ms',design,0);
    await writeRecord(client,'email-state',{active:{config:{host:'smtp.invalid'}},revision:'test',drafts:{}},null);
    const messages:string[]=[];
    const provider:AuthProvider={sendInvitation:(email,path,context)=>sendInternalInvitation(email,path??'',context,async(_relay,mail)=>{messages.push(mail.text);}),revokeInvitation:async()=>{},sendPasswordReset:async()=>{},endSession:async()=>{},emailReadiness:async()=>null};
    await inviteUser(adminCtx(base),{fullName:'Fictional invited colleague',email:'invited@example.test',role:'employee',emailLocale:'ms'},provider);
    expect(messages).toHaveLength(1);expect(messages[0]).toContain('Fictional Bahasa invitation');
    const jobs=await owner.db.select().from(schema.accountEmailDelivery);expect(jobs).toHaveLength(1);
    await retryAccountEmail(adminCtx(base),jobs[0].id,true,undefined,provider);expect(messages).toHaveLength(2);expect(messages[1]).toContain('Fictional Bahasa invitation');
    expect((await owner.db.select().from(schema.appInvitation)).every(row=>row.emailLocale==='ms')).toBe(true);
  });
  it('preserves the public recovery request language in its exact encrypted request context',async()=>{
    await enroll();
    const english=defaultEmailDocument('recovery'),malay=defaultEmailDocument('recovery');english.blocks[0]={...english.blocks[0],type:'header',label:'Fictional English recovery',style:{}};malay.blocks[0]={...malay.blocks[0],type:'header',label:'Fictional Bahasa recovery',style:{}};
    await saveEmailDesign(adminCtx(base),'recovery','en',english,0);await saveEmailDesign(adminCtx(base),'recovery','ms',malay,0);
    await writeRecord(client,'email-state',{active:{config:{host:'smtp.invalid'}},revision:'test',drafts:{}},null);
    let text='';await requestRecovery('alpha','owner',async(_relay,mail)=>{text=mail.text;},attempt=>attempt(),false,'ms');
    expect(text).toContain('Fictional Bahasa recovery');expect(text).not.toContain('Fictional English recovery');expect(text).toMatch(/#token=[A-Za-z0-9_-]{43}/);
  });
  it('recovery keeps MFA, consumes its link once and invalidates every prior session', async () => {
    const { signedIn } = await enroll(false, true);
    expect(signedIn.remembered_device_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const c = (await credentialByLogin('alpha', 'owner'))!;
    await writeRecord(client, 'email-state', { active: { config: { host: 'smtp.invalid' } }, revision: 'test', drafts: {} }, null);
    const design=defaultEmailDocument('recovery');design.blocks[0]={...design.blocks[0],type:'header',label:'Fictional account-tenant design',style:{}};
    await saveEmailDesign(adminCtx(base),'recovery','en',design,0);
    let sentText = '',sentHtml='';
    await requestRecovery('alpha', 'owner', async (_relay, mail) => { sentText = mail.text;sentHtml=mail.html??''; });
    expect(sentText).toContain('Fictional account-tenant design');expect(sentHtml).toContain('Fictional account-tenant design');
    expect(sentText).toContain('Your authenticator or a recovery code is still required');
    const rows = await owner.client`select id,status from account_email_delivery where kind='recovery'`;
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe('sent');
    const token = sentText.match(/#token=([A-Za-z0-9_-]{43})/)![1];
    const ledger = JSON.stringify(await owner.client`select * from account_email_delivery`);
    expect(ledger).not.toContain(token);
    expect((await owner.client`select count(*)::int n from app_internal_auth_record where record_key like 'mail:%'`)[0].n).toBe(0);
    await expect(completeRecovery(token, 'A replacement secure phrase 556!', 'bad-code')).rejects.toMatchObject({ code: 'invalidCode' });
    expect(await readSession(signedIn.access_token)).not.toBeNull();
    for (const previous of [temp, final]) await expect(completeRecovery(token, previous, signedIn.recoveryCodes![0])).rejects.toMatchObject({ code: 'passwordPolicy' });
    const ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
    await savePasswordPolicy(ctx,{enabled:false,interval:90,unit:'days',requirements:{...NEW_PASSWORD_REQUIREMENTS,lockoutEnabled:true,failedAttempts:1}},0);
    await expect(startLogin({organization:'alpha',username:'owner',password:'wrong',native:false})).rejects.toMatchObject({code:'invalidLogin'});
    await completeRecovery(token, 'A replacement secure phrase 556!', signedIn.recoveryCodes![0]);
    expect(await readSession(signedIn.access_token)).toBeNull(); expect((await credentialByLogin('alpha', 'owner'))?.totpSecret).toBe(c.totpSecret);
    await expect(completeRecovery(token, 'Yet another secure phrase 337!', signedIn.recoveryCodes![1])).rejects.toMatchObject({ code: 'invalidChallenge' });
    await expect(startLogin({organization:'alpha',username:'owner',password:'A replacement secure phrase 556!',native:false,rememberedDevice:signedIn.remembered_device_token})).rejects.toMatchObject({code:'invalidLogin'});
    await unlockPasswordAccount(ctx,base.adminUserId);
    const login = await startLogin({ organization: 'alpha', username: 'owner', password: 'A replacement secure phrase 556!', native: false, rememberedDevice: signedIn.remembered_device_token }); expect(login.step).toBe('mfa');
    expect(await readRecord(client, `recovery:${digest(token)}`)).toBeNull();
  });
  it('shares the recovery limit between explicit and default organization codes', async () => {
    await enroll();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      for (const organization of ['alpha', '', 'ALPHA']) await requestRecovery(organization, ' OWNER ');
      for (const organization of ['', 'alpha']) await expect(requestRecovery(organization, 'owner')).rejects.toMatchObject({ code: 'rateLimited' });
    } finally { clock.mockRestore(); }
  });
  it('commits exact recovery context before acknowledging a deferred single delivery attempt', async () => {
    await enroll();
    await writeRecord(client, 'email-state', { active: { config: { host: 'smtp.invalid' } }, revision: 'test', drafts: {} }, null);
    const send = vi.fn(async () => {}), scheduled: (() => Promise<void>)[] = [];
    await requestRecovery('alpha', 'owner', send, attempt => { scheduled.push(attempt); });
    const rows = await owner.client`select id,status,started_at from account_email_delivery where kind='recovery' order by created_at,id`;
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:'pending',started_at:null});
    expect(await readRecord(client, `recovery-mail:${rows[0].id}`)).toMatchObject({organization:'alpha',username:'owner'});
    expect(scheduled).toHaveLength(1);expect(send).not.toHaveBeenCalled();
    await scheduled[0]();expect(send).toHaveBeenCalledOnce();
    expect((await owner.client`select status from account_email_delivery where id=${rows[0].id}::uuid`)[0].status).toBe('sent');
  });
  it('fresh-customer owner enrollment consumes only its exact private invitation and preserves the provisioned IDs', async () => {
    const created = await owner.db.transaction(tx => provisionTenant(tx, { name: 'Private Customer', adminEmail: 'customer@example.test', baseUrl: 'https://hr.test' }));
    const token = new URL(created.activationUrl).pathname.match(/^\/invite\/([A-Za-z0-9_-]{43})$/)![1];
    const input = { appUserId: created.appUserId, organization: 'private-customer', username: 'customer.owner', email: 'customer@example.test', password: temp, installationOperator: true };
    await expect(bootstrapInternalOwner(owner.client, input)).rejects.toThrow(/private first-administrator invitation/);
    await expect(bootstrapInternalOwner(owner.client, { ...input, invitationToken: 'x'.repeat(43) })).rejects.toThrow(/exact provisioned/);
    await bootstrapInternalOwner(owner.client, { ...input, invitationToken: token });
    const credential = (await credentialByLogin('private-customer', 'customer.owner'))!;
    const rows = await client`select * from app.principal_by_identity(${credential.issuer},${credential.subject})`;
    expect(rows[0].app_user_id).toBe(created.appUserId); expect(rows[0].person_id).toBe(created.personId);
    expect(rows[0].grants).toHaveLength(1); expect(rows[0].grants[0].role).toBe('hr_admin');
    const [invitation] = await owner.client`select status from app_invitation where token_hash=${digest(token)}`;
    expect(invitation.status).toBe('accepted');
  });
  it('missing SMTP records a held failure, and a selected retry stays bound to the original organization despite shared email', async () => {
    const { signedIn } = await enroll(); const first = (await credentialByLogin('alpha', 'owner'))!;
    const other = await seedBase();
    await bootstrapInternalOwner(owner.client, { appUserId: other.adminUserId, organization: 'beta', username: 'owner', email: first.email, password: temp, installationOperator: false });
    await expect(requestRecovery('alpha', 'owner')).resolves.toBeUndefined();
    const [job] = await owner.client`select id,status,last_error from account_email_delivery where kind='recovery' order by created_at,id`;
    expect(job).toMatchObject({ status: 'failed', last_error: 'relayUnavailable' });
    expect((await owner.client`select count(*)::int n from app_internal_auth_record where record_key like 'recovery:%'`)[0].n).toBe(0);
    await writeRecord(client, 'email-state', { active: { config: { host: 'smtp.invalid' } }, revision: 'test', drafts: {} }, null);
    expect((await owner.client`select status from account_email_delivery where id=${job.id}`)[0].status).toBe('failed');
    let text = '';
    const provider: AuthProvider = { sendInvitation: async () => ({ invitationId: 'unused' }), revokeInvitation: async () => {}, endSession: async () => {},
      emailReadiness: async () => null, sendPasswordReset: (email, context) => sendInternalRecovery(email, context, async (_relay, mail) => { text = mail.text; }) };
    const actor = { userId: base.adminUserId, tenantId: base.tenantId, issuer: first.issuer, subject: first.subject };
    await expect(retryAccountEmail(adminCtx(base), job.id, true, { ...actor, subject: (await credentialByLogin('beta', 'owner'))!.subject }, provider)).rejects.toThrow();
    const history = await withInternalRecoveryLabels(adminCtx(base), actor, await readAccountEmailDeliveries(adminCtx(base), actor));
    expect(history.find(item => item.id === job.id)?.account).toEqual({ organization: 'alpha', username: 'owner' });
    const serializedView = JSON.stringify(history);
    for (const secret of ['totpSecret', 'password', 'recoveryHashes', 'recovery-mail:', first.subject]) expect(serializedView).not.toContain(secret);
    expect(await readAccountEmailDeliveries(adminCtx(base))).toEqual([]);
    await retryAccountEmail(adminCtx(base), job.id, true, actor, provider);
    const token = text.match(/#token=([A-Za-z0-9_-]{43})/)![1];
    expect(await readRecord(client, `recovery:${digest(token)}`)).toMatchObject({ subject: first.subject });
    await completeRecovery(token, 'Another private safe phrase 993!', signedIn.recoveryCodes![0]);
    expect((await credentialByLogin('beta', 'owner'))?.mustChange).toBe(true);
    const serialized = JSON.stringify(await owner.client`select * from account_email_delivery order by created_at,id`);
    expect(serialized).not.toContain(token); expect(serialized).not.toContain('#token=');
  });
  it('SMTP authority cannot be inherited from a different identity attached to the same HR administrator', async () => {
    const c = (await credentialByLogin('alpha', 'owner'))!;
    const allowed = (issuer: string, subject: string, email: string) => withTenant(adminCtx(base), async tx =>
      (await tx.execute(sql`select app.internal_auth_email_operator(${issuer},${subject},${email}) allowed`))[0].allowed);
    expect(await allowed(c.issuer, c.subject, c.email)).toBe(true);
    expect(await allowed(c.issuer, c.subject, 'changed@example.test')).toBe(false);
    const foreign = randomUUID();
    await owner.client`insert into app_external_identity(issuer,subject,app_user_id) values('https://other.test/issuer',${foreign},${base.adminUserId}::uuid)`;
    expect(await allowed('https://other.test/issuer', foreign, c.email)).toBe(false);
  });
  it('refuses an invitation for another organization before consuming it even when the email address matches', async () => {
    await enroll(); const c = (await credentialByLogin('alpha', 'owner'))!;
    const other = await seedBase();
    const provider: AuthProvider = { sendInvitation: async () => ({ invitationId: 'test' }), revokeInvitation: async () => {}, sendPasswordReset: async () => {}, endSession: async () => {} };
    const invite = await inviteUser(adminCtx(other), { email: c.email, role: 'employee' }, provider);
    await expect(acceptInternalInvitation(invite.token, { issuer: c.issuer, subject: c.subject, email: c.email, emailVerified: true })).rejects.toMatchObject({ code: 'invalidChallenge' });
    expect((await owner.client`select status from app_invitation where id=${invite.invitationId}::uuid`)[0].status).toBe('pending');
    expect((await owner.client`select count(*)::int n from app_external_identity where issuer=${c.issuer} and subject=${c.subject}`)[0].n).toBe(1);
  });
  it.each([false, true])('invitation enrollment is single-use and browser activation requires a fresh login (native=%s)', async native => {
    const provider: AuthProvider = { sendInvitation: async () => ({ invitationId: 'test' }), revokeInvitation: async () => {}, sendPasswordReset: async () => {}, endSession: async () => {} };
    const invite = await inviteUser(adminCtx(base), { email: 'invited@example.test', role: 'employee' }, provider);
    const setup = await startInvitation(invite.token, 'invited', final, native);
    if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected setup');
    expect(await credentialByLogin('alpha', 'invited')).toBeNull(); expect(await readSession(challenge(setup))).toBeNull();
    const result = await verifyMfa(challenge(setup), await generate({ secret: setup.secret }), native);
    if (native) {
      const session = completed(result);
      expect((await readSession(session.access_token, true))?.credential.email).toBe('invited@example.test');
    } else {
      expect(result).toMatchObject({ step: 'activated', organization: 'alpha', recoveryCodes: expect.any(Array) });
      expect(result).not.toHaveProperty('access_token');
      if (result.step !== 'activated') throw new Error('Expected activation without a session');
      const credential = (await credentialByLogin('alpha', 'invited'))!;
      const sessions = await owner.client`select count(*)::int n from app_internal_auth_record
        where owner_id=${credential.subject}::uuid and (record_key like 'session:%' or record_key like 'family:%')`;
      expect(sessions[0].n).toBe(0);
      const login = await startLogin({ organization: 'alpha', username: 'invited', password: final, native: false });
      expect(login.step).toBe('mfa');
      const signedIn = completed(await verifyMfa(challenge(login), result.recoveryCodes![0]));
      expect((await readSession(signedIn.access_token))?.credential.email).toBe('invited@example.test');
    }
    await expect(verifyMfa(challenge(setup), '123456', native)).rejects.toMatchObject({ code: 'invalidChallenge' });
    await expect(startInvitation(invite.token, 'another', final)).rejects.toMatchObject({ code: 'invalidChallenge' });
  });
});


describe('remembered authenticator verification — server-owned device proofs', () => {
  const ctx = () => ({ ...adminCtx(base), grants: [{ role: 'hr_admin' as const, companyId: null }] });
  it.each([false, true])('remembers only an opted-in verified device and keeps the normal session lifetime (native=%s)', async native => {
    const { signedIn } = await enroll(native, true);
    expect(signedIn.remembered_device_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signedIn.remembered_device_expires_in).toBe(30 * 86400);
    await revokeSession(signedIn.access_token, native, signedIn.refresh_token);
    const input = { organization: 'alpha', username: 'owner', password: final, native, rememberedDevice: signedIn.remembered_device_token };
    const again = completed(await startLogin(input));
    expect(again.expires_in).toBe(native ? 900 : 28800);
    expect(again.remembered_device_token).toBeUndefined(); // Signing in cannot slide the factor window.
    await expect(startLogin({ ...input, password: 'Wrong password with a real remembered proof' })).rejects.toMatchObject({ code: 'invalidLogin' });
    expect((await startLogin({ ...input, native: !native })).step).toBe('mfa');
    const credential = (await credentialByLogin('alpha', 'owner'))!;
    expect(await rememberedFactorValid(client, { ...credential, subject: randomUUID() }, native, signedIn.remembered_device_token)).toBe(false);
    expect(await rememberedFactorValid(client, { ...credential, tenantId: randomUUID() }, native, signedIn.remembered_device_token)).toBe(false);
    const raw = JSON.stringify(await owner.client`select * from app_internal_auth_record`);
    expect(raw).not.toContain(signedIn.remembered_device_token);
  });
  it('asks for MFA without opt-in, after fixed expiry, and after credential-version revocation', async () => {
    const first = await enroll(); expect(first.signedIn.remembered_device_token).toBeUndefined();
    const input = { organization: 'alpha', username: 'owner', password: final, native: false };
    const ch = await startLogin(input), c = (await credentialByLogin('alpha', 'owner'))!;
    const remembered = completed(await verifyMfa(challenge(ch), await nextCode(c), false, true));
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 86400_000);
    expect((await startLogin({ ...input, rememberedDevice: remembered.remembered_device_token })).step).toBe('mfa');
    clock.mockRestore();
    const current = (await credentialByLogin('alpha', 'owner'))!; current.version = randomUUID();
    await writeRecord(client, `credential:${current.subject}`, current, current.subject);
    expect((await startLogin({ ...input, rememberedDevice: remembered.remembered_device_token })).step).toBe('mfa');
  });
  it('invalidates all older device proofs on any administrator policy change, including disable and re-enable', async () => {
    const { signedIn } = await enroll(false, true);
    const input = { organization: 'alpha', username: 'owner', password: final, native: false, rememberedDevice: signedIn.remembered_device_token };
    expect(await readRememberedMfaPolicyEditor(ctx())).toEqual({ policy: { rememberDays: 30 }, revision: 0 });
    await saveRememberedMfaPolicy(ctx(), { rememberDays: 7 }, 0);
    expect((await startLogin(input)).step).toBe('mfa');
    await expect(saveRememberedMfaPolicy(ctx(), { rememberDays: 30 }, 0)).rejects.toThrow('conflict');
    await saveRememberedMfaPolicy(ctx(), { rememberDays: 0 }, 1);
    const next = await startLogin(input), c = (await credentialByLogin('alpha', 'owner'))!;
    const result = completed(await verifyMfa(challenge(next), await nextCode(c), false, true));
    expect(result.remembered_device_token).toBeUndefined();
    await saveRememberedMfaPolicy(ctx(), { rememberDays: 30 }, 2);
    expect((await startLogin(input)).step).toBe('mfa');
    await expect(saveRememberedMfaPolicy({ ...ctx(), grants: [] }, { rememberDays: 30 }, 3)).rejects.toThrow('forbidden');
  });
  it.each([false, true])('enforces current password lockout before an otherwise valid remembered proof (native=%s)', async native => {
    const { signedIn } = await enroll(native, true);
    const input = { organization: 'alpha', username: 'owner', password: final, native, rememberedDevice: signedIn.remembered_device_token };
    await savePasswordPolicy(ctx(), { enabled: false, interval: 90, unit: 'days', requirements: { ...NEW_PASSWORD_REQUIREMENTS, lockoutEnabled: true, failedAttempts: 2 } }, 0);
    for (let i = 0; i < 2; i++) await expect(startLogin({ ...input, password: 'Wrong password despite remembered proof' })).rejects.toMatchObject({ code: 'invalidLogin' });
    await expect(startLogin(input)).rejects.toMatchObject({ code: 'invalidLogin' });
    await unlockPasswordAccount(ctx(), base.adminUserId);
    expect((await startLogin(input)).step).toBe('complete');
  });
  it.each([false, true])('requires fresh MFA and password replacement when a remembered credential must change (native=%s)', async native => {
    const { signedIn } = await enroll(native, true);
    const credential = (await credentialByLogin('alpha', 'owner'))!;
    credential.mustChange = true;
    await writeRecord(client, `credential:${credential.subject}`, credential, credential.subject);
    const input = { organization: 'alpha', username: 'owner', password: final, native, rememberedDevice: signedIn.remembered_device_token };
    const login = await startLogin(input); expect(login.step).toBe('mfa');
    const required = await verifyMfa(challenge(login), await nextCode(credential), native, true);
    expect(required.step).toBe('password');
    const session = completed(await changeInitialPassword(challenge(required), 'Another changed secure phrase 928!', native));
    expect(session.remembered_device_token).toBeUndefined();
    expect((await startLogin({ ...input, password: 'Another changed secure phrase 928!' })).step).toBe('mfa');
  });
  it('never remembers a recovery code and cannot use remembered trust to avoid expired-password MFA', async () => {
    const { signedIn } = await enroll(false, true);
    const input = { organization: 'alpha', username: 'owner', password: final, native: false };
    const recovered = completed(await verifyMfa(challenge(await startLogin(input)), signedIn.recoveryCodes![0], false, true));
    expect(recovered.remembered_device_token).toBeUndefined();
    await savePasswordPolicy(ctx(), { enabled: true, interval: 1, unit: 'days' }, 0);
    const c = (await credentialByLogin('alpha', 'owner'))!; c.passwordChangedAt = Date.now() - 2 * 86400_000;
    await writeRecord(client, `credential:${c.subject}`, c, c.subject);
    expect((await startLogin({ ...input, rememberedDevice: signedIn.remembered_device_token })).step).toBe('mfa');
  });
});

it('refuses remembered-MFA policy edits from forged tenant context and revoked administrator authority', async () => {
  const ctx = { ...adminCtx(base), grants: [{ role: 'hr_admin' as const, companyId: null }] };
  await expect(saveRememberedMfaPolicy({ ...ctx, tenantId: randomUUID() }, { rememberDays: 7 }, 0)).rejects.toThrow();
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, base.adminUserId));
  await expect(saveRememberedMfaPolicy(ctx, { rememberDays: 7 }, 0)).rejects.toThrow();
  await expect(readRememberedMfaPolicyEditor(ctx)).rejects.toThrow();
  expect(await readRecord(client, `remembered-mfa-policy:${base.tenantId}`)).toBeNull();
});


it('commits authorized remembered-MFA policy and audit together, and rolls policy back when real audit append fails', async () => {
  const ctx = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
  const credential = await credentialByLogin('alpha', 'owner');
  await saveRememberedMfaPolicy(ctx, { rememberDays: 7 }, 0);
  expect(await readRememberedMfaPolicyEditor(ctx)).toEqual({ policy: { rememberDays: 7 }, revision: 1 });
  const before = await owner.client`select payload from domain_event where tenant_id=${base.tenantId}::uuid and event_type='remembered-mfa-policy.updated' order by id`;
  expect(before).toHaveLength(1); expect(before[0].payload).toMatchObject({ rememberDays: 7, revision: 1 });
  await owner.client.unsafe("CREATE FUNCTION app.test_remembered_mfa_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='remembered-mfa-policy.updated' THEN RAISE EXCEPTION 'fictional remembered MFA audit refusal' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$");
  await owner.client.unsafe('CREATE TRIGGER test_remembered_mfa_audit_refusal BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.test_remembered_mfa_audit_refusal()');
  let failure: unknown;
  try { await saveRememberedMfaPolicy(ctx, { rememberDays: 30 }, 1); } catch (error) { failure = error; }
  finally {
    await owner.client.unsafe('DROP TRIGGER test_remembered_mfa_audit_refusal ON domain_event');
    await owner.client.unsafe('DROP FUNCTION app.test_remembered_mfa_audit_refusal()');
  }
  expect(pgSqlState(failure)).toBe('P0001');
  expect(await readRememberedMfaPolicyEditor(ctx)).toEqual({ policy: { rememberDays: 7 }, revision: 1 });
  expect(await credentialByLogin('alpha', 'owner')).toEqual(credential);
  const after = await owner.client`select payload from domain_event where tenant_id=${base.tenantId}::uuid and event_type='remembered-mfa-policy.updated' order by id`;
  expect(after).toEqual(before);
});

it('refuses remembered-MFA settings when actual administrator authority is revoked while waiting for Access', async () => {
  const ctx = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
  const credentialBefore = await credentialByLogin('alpha', 'owner');
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(yes => { ready = yes; });
  const finish = new Promise<void>(yes => { release = yes; });
  const holder = owner.client.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:' + base.tenantId},0))`;
    ready(); await finish;
    await tx`delete from role_assignment where tenant_id=${base.tenantId}::uuid and app_user_id=${base.adminUserId}::uuid`;
  });
  await started;
  const writing = saveRememberedMfaPolicy(ctx, { rememberDays: 7 }, 0);
  void writing.catch(() => undefined);
  try {
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const [row] = await owner.client`select exists(select 1 from pg_locks where not granted and locktype='advisory'
        and classid=((hashtextextended(${'access-configuration:' + base.tenantId},0)>>32)&4294967295)::oid
        and objid=(hashtextextended(${'access-configuration:' + base.tenantId},0)&4294967295)::oid) as waiting`;
      if (row.waiting) { waiting = true; break; }
      await new Promise(yes => setTimeout(yes, 10));
    }
    expect(waiting, 'the policy writer must wait on the actual Access owner before its policy lock').toBe(true);
    expect(await readRecord(client, `remembered-mfa-policy:${base.tenantId}`)).toBeNull();
  } finally { release(); await holder; }
  await expect(writing).rejects.toThrow('forbidden');
  expect(await credentialByLogin('alpha', 'owner')).toEqual(credentialBefore);
  expect(await readRecord(client, `remembered-mfa-policy:${base.tenantId}`)).toBeNull();
  const events = await owner.client`select id from domain_event where tenant_id=${base.tenantId}::uuid and event_type='remembered-mfa-policy.updated'`;
  expect(events).toHaveLength(0);
});

it.each([7, 90])('never remembers longer than the challenge offered when policy changes to %s days', async rememberDays => {
  await enroll();
  const login = await startLogin({ organization: 'alpha', username: 'owner', password: final, native: false });
  expect(login).toMatchObject({ step: 'mfa', rememberDays: 30 });
  await saveRememberedMfaPolicy({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] }, { rememberDays }, 0);
  const c = (await credentialByLogin('alpha', 'owner'))!;
  const signedIn = completed(await verifyMfa(challenge(login), await nextCode(c), false, true));
  expect(signedIn.remembered_device_expires_in).toBe(Math.min(30, rememberDays) * 86400);
});
