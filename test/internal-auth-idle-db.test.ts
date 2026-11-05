/**
 * ADR-0171: the embedded sign-in service ends a web session after the organization's idle limit. Only reported
 * user activity (touchSession) moves the idle clock; reading the session for an ordinary request does not, so
 * background polling and link prefetching can never keep an unattended session alive.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { AuthRecordExpiredError, decryptRecord, digest } from '../lib/internal-auth/crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecord, writeRecord } from '../lib/internal-auth/store';
import { client } from '../db/client';
import { changeInitialPassword, readSession, revokeSession, startLogin, touchSession, verifyMfa, type AuthReply } from '../lib/internal-auth/service';
import { saveSessionPolicy } from '../core/session-policy';
import { forgetIdleTimeout } from '../lib/session-policy-server';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
const temp = 'Temporary private passphrase 722!';
const final = 'A brand new secret phrase 933!';
const MINUTE = 60_000;
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); base = await seedBase(); forgetIdleTimeout(base.tenantId);
  vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_PUBLIC_ORIGIN', 'https://hr.test'); vi.stubEnv('AUTH_SESSION_KEY', '9'.repeat(64));
  vi.stubEnv('AUTH_DEFAULT_ORGANIZATION', 'alpha');
  await bootstrapInternalOwner(owner.client, { appUserId: base.adminUserId, organization: 'alpha', username: 'owner', email: 'owner@example.test', password: temp, installationOperator: true });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); }); afterAll(closeAll);

function challenge(value: AuthReply) { if (!('challenge' in value)) throw new Error('Expected challenge'); return value.challenge; }
async function signIn(native = false) {
  const login = await startLogin({ organization: 'ALPHA', username: 'OWNER', password: temp, native });
  const setup = await changeInitialPassword(challenge(login), final, native);
  if (setup.step !== 'enroll' || !setup.secret) throw new Error('Expected MFA setup');
  const done = await verifyMfa(challenge(setup), await generate({ secret: setup.secret }), native);
  if (done.step !== 'complete') throw new Error('Expected full session');
  return done.access_token;
}
/** Sign in on the real clock, then drive time explicitly. */
async function signedInWithClock(native = false) {
  const token = await signIn(native);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { token, advance: (ms: number) => { now += ms; } };
}
const idleEvents = () => owner.db.select().from(schema.domainEvent)
  .where(and(eq(schema.domainEvent.tenantId, base.tenantId), eq(schema.domainEvent.eventType, 'app-user.session-idle-expired')));

describe('ADR-0171 idle sign-out in the embedded sign-in service', () => {
  it('ends a web session after 15 idle minutes by default, revokes it and audits a system sign-out', async () => {
    const { token, advance } = await signedInWithClock();
    advance(14 * MINUTE);
    expect(await readSession(token)).not.toBeNull();
    // Reading the session is not activity: polling and prefetching must not keep it alive.
    advance(2 * MINUTE);
    expect(await readSession(token)).toBeNull();
    expect(await readRecord(client, `session:${digest(token)}`)).toBeNull();
    const [event] = await idleEvents();
    expect(event).toMatchObject({ actorType: 'system', actorId: null });
    // Activity after expiry cannot revive it.
    expect(await touchSession(token)).toBeNull();
  });

  it('moves the idle clock only on reported activity, at most every 30 seconds', async () => {
    const { token, advance } = await signedInWithClock();
    advance(10 * MINUTE);
    expect(await touchSession(token)).toEqual({ idleTimeoutSeconds: 900, remainingSeconds: 900 });
    advance(10_000);
    expect(await touchSession(token)).toEqual({ idleTimeoutSeconds: 900, remainingSeconds: 890 });
    advance(14 * MINUTE);
    expect(await readSession(token)).not.toBeNull();
    advance(2 * MINUTE);
    expect(await readSession(token)).toBeNull();
  });

  it("applies the organization's own limit", async () => {
    await saveSessionPolicy({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] }, 30, 0);
    forgetIdleTimeout(base.tenantId);
    const { token, advance } = await signedInWithClock();
    advance(25 * MINUTE);
    expect((await touchSession(token))?.idleTimeoutSeconds).toBe(1800);
    advance(29 * MINUTE);
    expect(await readSession(token)).not.toBeNull();
    advance(2 * MINUTE);
    expect(await readSession(token)).toBeNull();
  });

  it('starts the idle clock of a session created before idle sign-out instead of ending it on deployment', async () => {
    const { token, advance } = await signedInWithClock();
    const key = `session:${digest(token)}`;
    const stored = await readRecord<Record<string, unknown>>(client, key);
    const { lastActivity: _dropped, ...legacy } = stored!;
    await writeRecord(client, key, legacy, legacy.subject as string, legacy.absoluteExpiry as number);
    advance(100 * MINUTE);
    expect(await readSession(token)).not.toBeNull();
    advance(16 * MINUTE);
    expect(await readSession(token)).toBeNull();
  });

  it('leaves app (native) sessions to their own short-lived tokens', async () => {
    const { token, advance } = await signedInWithClock(true);
    expect(await touchSession(token)).toBeNull();
    advance(14 * MINUTE);
    expect(await readSession(token, true)).not.toBeNull();
    expect(await idleEvents()).toEqual([]);
  });
});


it('profiles a paired native credential and family read without changing session handling',async()=>{
  const token=await signIn();
  const admitted=await readSession(token);
  expect(admitted).not.toBeNull();
  const credentialKey='credential:'+admitted!.subject,familyKey='family:'+admitted!.family;
  const sequential=async()=>[await readRecord(client,credentialKey),await readRecord(client,familyKey)];
  const decode=(sealed:unknown,key:string)=>{
    if(sealed===null||sealed===undefined)return null;
    if(typeof sealed!=='string')throw Error('Invalid fixture record');
    try{return decryptRecord(sealed,key);}catch(error){if(error instanceof AuthRecordExpiredError)return null;throw error;}
  };
  const paired=async()=>{
    const [row]=await client.unsafe(`select
      (select sealed from app.internal_auth_read($1,false)) as credential,
      (select sealed from app.internal_auth_read($2,false)) as family`,[credentialKey,familyKey]);
    return [decode(row.credential,credentialKey),decode(row.family,familyKey)];
  };
  const expected=await sequential();
  expect(expected.every(Boolean)).toBe(true);
  expect(await paired()).toEqual(expected);
  const measure=async(read:typeof paired)=>{
    const start=performance.now();
    const rows=await Promise.all(Array.from({length:40},()=>read()));
    const elapsedMs=performance.now()-start;
    expect(rows.every(row=>row[1]!==null)).toBe(true);
    return elapsedMs;
  };
  const before=await measure(sequential),candidate=await measure(paired),warm=await measure(paired),restored=await measure(sequential);
  await revokeSession(token);
  expect(await readSession(token)).toBeNull();
  expect(await paired()).toEqual(await sequential());
  expect((await paired())[1]).toBeNull();
  // A storage expiry must be invisible to both query shapes; no new persistence or cache.
  const expired=Date.now()-1000;
  await writeRecord(owner.client,familyKey,{expired:true},admitted!.subject,expired);
  expect((await paired())[1]).toBeNull();
  expect(await paired()).toEqual(await sequential());
  const directory=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if(directory)writeFileSync(join(directory,'internal-auth-record-pair-prototype.json'),JSON.stringify({
    kind:'NATIVE_AUTH_RECORD_LOOKUP_PROTOTYPE',releaseEligible:false,concurrentReads:40,
    originalRoundTrips:80,pairedRoundTrips:40,before,candidate,warm,restored,realPasswordMfa:true,revocationAndExpiryPreserved:true,
    scope:'Read pair only. Session handling, login, identity checks and all writes remain outside the prototype.',
  },null,2));
});
