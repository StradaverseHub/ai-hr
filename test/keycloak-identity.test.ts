import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { client } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { inviteUser, acceptInvitation, type AuthProvider } from '../core/auth';
import { hireEmployee } from '../core/org';
import { createIdentitySession, readIdentitySession, deleteIdentitySession, sessionHash } from '../lib/identity/session';
import { seal } from '../lib/identity/seal';
import { AuthRequiredError } from '../lib/auth-errors';
import { JwksUnavailableError } from '../lib/mobile-api/jwt';
import { todayInKualaLumpur } from '../lib/hr-date';

const issuer = 'https://identity.test/identity/realms/hr';
const provider: AuthProvider = {sendInvitation:async()=>({invitationId:'test'}),revokeInvitation:async()=>{},sendPasswordReset:async()=>{},endSession:async()=>{}};
const mocks = vi.hoisted(()=>({refresh:vi.fn(),verify:vi.fn(),provider:vi.fn()}));
vi.mock('../lib/identity/oidc',()=>({oidcClient:mocks.provider,verifyKeycloakAccessToken:mocks.verify,
  oidc:{ refreshTokenGrant:mocks.refresh, ResponseBodyError:class extends Error { error='invalid_grant'; } }}));
let base: Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{
  await resetDb(); base=await seedBase();
  for (const [k,v] of Object.entries({AUTH_PROVIDER:'keycloak',AUTH_PUBLIC_ORIGIN:'https://hr.test',KEYCLOAK_ISSUER:issuer,
    KEYCLOAK_WEB_CLIENT_ID:'web',KEYCLOAK_WEB_CLIENT_SECRET:'secret',KEYCLOAK_MOBILE_CLIENT_ID:'mobile',KEYCLOAK_API_AUDIENCE:'api',AUTH_SESSION_KEY:'b'.repeat(64)})) vi.stubEnv(k,v);
  mocks.refresh.mockReset(); mocks.verify.mockReset(); mocks.provider.mockResolvedValue({});
  mocks.verify.mockImplementation(async()=>({issuer,subject:'subject',expiresAt:Math.floor(Date.now()/1000)+300}));
});
afterEach(()=>vi.unstubAllEnvs()); afterAll(closeAll);
const lookup=(iss=issuer,sub='subject')=>client`select * from app.principal_by_identity(${iss},${sub})`;
async function enroll(userId:string,subject='subject',iss=issuer) {
  await owner.db.insert(schema.appExternalIdentity).values({issuer:iss,subject,appUserId:userId});
}
async function employee() {
  const e=await hireEmployee(adminCtx(base),{person:{fullName:'Enrolled Employee',primaryEmail:'employee@example.test'},companyId:base.companyId,
    departmentId:base.deptA,employmentType:'full_time',hiredOn:`${Number(todayInKualaLumpur().slice(0,4))-1}-01-01`});
  const userId=await createAppUser(base.tenantId,e.personId,'employee');
  await owner.db.update(schema.appUser).set({workosUserId:`seed:${userId}`}).where(eq(schema.appUser.id,userId));
  return {...e,userId};
}

describe('deployment identity mapping — actual application role and definer functions',()=>{
  it('keeps internal IDs, grants and tenant ownership and requires both issuer and subject',async()=>{
    await enroll(base.adminUserId);
    const [row]=await lookup(); expect(row.app_user_id).toBe(base.adminUserId); expect(row.tenant_id).toBe(base.tenantId);
    expect(row.grants).toContainEqual({role:'hr_admin',companyId:null});
    expect(await lookup('https://other.test/realms/hr')).toHaveLength(0); expect(await lookup(issuer,base.adminUserId)).toHaveLength(0);
    const other=await seedBase(); await enroll(other.adminUserId,'subject','https://other.test/realms/hr');
    expect((await lookup())[0].tenant_id).toBe(base.tenantId);
  });
  it('blocks an archived login and a revoked binding without deleting grants',async()=>{
    await enroll(base.adminUserId);
    await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));
    expect(await lookup()).toHaveLength(0);
    await owner.db.update(schema.appUser).set({archivedAt:null}).where(eq(schema.appUser.id,base.adminUserId));
    await owner.db.update(schema.appExternalIdentity).set({revokedAt:new Date()}).where(eq(schema.appExternalIdentity.appUserId,base.adminUserId));
    expect(await lookup()).toHaveLength(0);
    expect(await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,base.adminUserId))).toHaveLength(1);
  });
  it('private identity/session tables cannot be read, rebound, truncated or forged by the web role',async()=>{
    for (const table of ['app_external_identity','app_identity_session']) {
      for (const permission of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) {
        const [row]=await owner.client`select has_table_privilege('ai_hr_app',${table},${permission}) allowed`;
        expect(row.allowed,`${table}: ${permission}`).toBe(false);
      }
      await expect(client.unsafe(`select * from ${table}`)).rejects.toThrow(/permission denied/);
    }
    const [prune]=await owner.client`select has_function_privilege('ai_hr_app','app.identity_session_prune()','EXECUTE') allowed`;
    expect(prune.allowed).toBe(false);
  });
});
describe('identity invitation enrollment',()=>{
  it('requires the verified recipient email and consumes once while preserving an existing placeholder user',async()=>{
    const e=await employee();
    const {token}=await inviteUser(adminCtx(base),{email:'employee@example.test',role:'employee',personId:e.personId},provider);
    await expect(acceptInvitation({token,issuer,subject:'subject'})).rejects.toThrow();
    await expect(acceptInvitation({token,issuer,subject:'subject',verifiedEmail:'other@example.test'})).rejects.toThrow();
    const result=await acceptInvitation({token,issuer,subject:'subject',verifiedEmail:'EMPLOYEE@example.test'});
    expect(result.userId).toBe(e.userId); expect((await lookup())[0].app_user_id).toBe(e.userId);
    await expect(acceptInvitation({token,issuer,subject:'subject',verifiedEmail:'employee@example.test'})).rejects.toThrow();
  });
  it('refuses invitation-based takeover of an enrolled person and does not burn the pending token',async()=>{
    const e=await employee(); await enroll(e.userId,'original');
    const {token,invitationId}=await inviteUser(adminCtx(base),{email:'employee@example.test',role:'employee',personId:e.personId},provider);
    await expect(acceptInvitation({token,issuer,subject:'attacker',verifiedEmail:'employee@example.test'})).rejects.toThrow(/enrolled identity/);
    expect((await owner.db.select().from(schema.appInvitation).where(eq(schema.appInvitation.id,invitationId)))[0].status).toBe('pending');
    expect((await lookup(issuer,'original'))[0].app_user_id).toBe(e.userId);
  });
  it('one external identity cannot accept an invitation into another tenant even with the same email',async()=>{
    await enroll(base.adminUserId);
    const other=await seedBase();
    const {token}=await inviteUser(adminCtx(other),{email:'same@example.test',role:'employee'},provider);
    await expect(acceptInvitation({token,issuer,subject:'subject',verifiedEmail:'same@example.test'})).rejects.toThrow(/another tenant/);
    expect((await lookup())[0].tenant_id).toBe(base.tenantId);
  });
  it('two concurrent claims yield one binding and one accepted invitation',async()=>{
    const e=await employee(); const {token}=await inviteUser(adminCtx(base),{email:'employee@example.test',role:'employee',personId:e.personId},provider);
    const attempts=await Promise.allSettled(['a','b'].map(subject=>acceptInvitation({token,issuer,subject,verifiedEmail:'employee@example.test'})));
    expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
    expect(await owner.db.select().from(schema.appExternalIdentity)).toHaveLength(1);
  });
});
const value=()=>({issuer,subject:'subject',email:'owner@example.test',emailVerified:true,accessToken:'access',refreshToken:'refresh',idToken:'id',accessExpiry:Math.floor(Date.now()/1000)+300});
describe('web session storage and rotation — actual transaction lock',()=>{
  it('stores only a random handle hash and ciphertext, refuses malformed handles, and deletes on logout',async()=>{
    const raw=await createIdentitySession(value()); const [row]=await owner.db.select().from(schema.appIdentitySession);
    expect(row.tokenHash).toBe(sessionHash(raw)); expect(row.sealed).not.toContain('refresh'); expect(row.sealed).not.toContain('owner@example');
    expect(await readIdentitySession('forged')).toBeNull(); expect((await readIdentitySession(raw))?.subject).toBe('subject');
    await deleteIdentitySession(raw); expect(await readIdentitySession(raw)).toBeNull();
  });
  it('refreshes once across concurrent requests and keeps the absolute expiry',async()=>{
    const raw=await createIdentitySession({...value(),accessExpiry:0});
    const [before]=await owner.db.select().from(schema.appIdentitySession);
    mocks.refresh.mockImplementation(async()=>{await new Promise(r=>setTimeout(r,15));return {access_token:'rotated-access',refresh_token:'rotated-refresh'};});
    const sessions=await Promise.all([readIdentitySession(raw),readIdentitySession(raw),readIdentitySession(raw)]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1); expect(sessions.every(s=>s?.refreshToken==='rotated-refresh')).toBe(true);
    expect((await owner.db.select().from(schema.appIdentitySession))[0].expiresAt).toEqual(before.expiresAt);
  });
  it('provider outages preserve the refresh credential, while a changed subject destroys the session',async()=>{
    const raw=await createIdentitySession({...value(),accessExpiry:0});
    mocks.refresh.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(readIdentitySession(raw)).rejects.toBeInstanceOf(JwksUnavailableError);
    expect(await owner.db.select().from(schema.appIdentitySession)).toHaveLength(1);
    mocks.refresh.mockResolvedValueOnce({access_token:'changed',refresh_token:'changed-refresh'});
    mocks.verify.mockResolvedValueOnce({issuer,subject:'different-user',expiresAt:Math.floor(Date.now()/1000)+300});
    expect(await readIdentitySession(raw)).toBeNull();
    expect(await owner.db.select().from(schema.appIdentitySession)).toHaveLength(0);
  });
  it('rejects a formerly valid access token after signature/profile refusal without a demo fallback',async()=>{
    const raw=await createIdentitySession(value());
    mocks.verify.mockRejectedValueOnce(new AuthRequiredError());
    expect(await readIdentitySession(raw)).toBeNull();
    expect(await owner.db.select().from(schema.appIdentitySession)).toHaveLength(0);
  });
  it('does not accept ciphertext substituted between otherwise valid session handles',async()=>{
    const first=await createIdentitySession(value()),second=await createIdentitySession(value());
    const [row]=await owner.db.select().from(schema.appIdentitySession).where(eq(schema.appIdentitySession.tokenHash,sessionHash(first)!));
    await owner.db.update(schema.appIdentitySession).set({sealed:row.sealed}).where(eq(schema.appIdentitySession.tokenHash,sessionHash(second)!));
    expect(await readIdentitySession(second)).toBeNull(); expect(await readIdentitySession(first)).not.toBeNull();
  });
  it('does not slide expiry through the app-role function, and refuses expired sessions',async()=>{
    const raw=await createIdentitySession(value()),hash=sessionHash(raw)!;
    const [row]=await owner.db.select().from(schema.appIdentitySession);
    await client`select app.identity_session_write(${hash},${await seal(value(),`session:${hash}`,Math.floor(Date.now()/1000)+99999)},${new Date(Date.now()+999999999).toISOString()}::timestamptz)`;
    expect((await owner.db.select().from(schema.appIdentitySession))[0].expiresAt).toEqual(row.expiresAt);
    await owner.db.update(schema.appIdentitySession).set({expiresAt:new Date(Date.now()-1000)}).where(eq(schema.appIdentitySession.tokenHash,hash));
    expect(await readIdentitySession(raw)).toBeNull();
  });
  it('a forged encrypted record is removed and never falls through to a demo identity',async()=>{
    const raw=randomBytes(32).toString('base64url');
    await client`select app.identity_session_write(${sessionHash(raw)!},'forged',${new Date(Date.now()+60000).toISOString()}::timestamptz)`;
    expect(await readIdentitySession(raw)).toBeNull(); expect(await owner.db.select().from(schema.appIdentitySession)).toHaveLength(0);
  });
});
