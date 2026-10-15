import { randomBytes, randomUUID } from 'node:crypto';
import { generateSecret, verify } from 'otplib';
import { client } from '../../db/client';
import { internalConfig, internalIssuer } from './config';
import { digest, opaque, validOpaque, passwordHash, passwordMatches, validatePassword, DUMMY_PASSWORD_HASH } from './crypto';
import { authTransaction, readRecord, writeRecord, deleteRecord, revokeCredentialsSessions, type AuthSql } from './store';

export class InternalAuthError extends Error {
  constructor(public code: 'invalidLogin' | 'invalidChallenge' | 'invalidCode' | 'passwordPolicy' | 'rateLimited' | 'unavailable' | 'conflict') { super(code); }
}
export type Credential = { subject: string; tenantId: string; issuer: string; organization: string; username: string; email: string;
  emailVerified: boolean; enabled: boolean; password: string | null; mustChange: boolean; version: string;
  totpSecret: string | null; lastStep: number; recoveryHashes: string[]; enrollmentId?: string };
type Challenge = { subject: string; version: string; phase: 'password' | 'enroll' | 'mfa'; attempts: number; native: boolean; expiresAt: number;
  secret?: string; mfaPassed?: boolean; invitation?: string };
type Session = { subject: string; version: string; family: string; native: boolean; absoluteExpiry: number };
type Refresh = Session & { used: boolean };
export type Organization = { code: string; tenantId: string; name: string };
export type AuthReply = { step: 'password' | 'enroll' | 'mfa'; challenge: string; secret?: string; account?: string } |
  { step: 'complete'; access_token: string; refresh_token?: string; expires_in: number; recoveryCodes?: string[] };
const SESSION_LIFE = 8 * 3600_000, ACCESS_LIFE = 15 * 60_000, CHALLENGE_LIFE = 10 * 60_000;
const credentialKey = (subject: string) => `credential:${subject}`;
export const loginKey = (organization: string, username: string) => `login:${digest(`${organization}\0${username}`)}`;
const canonicalOrg = (value: string) => (value || internalConfig().organization).trim().toLowerCase();
const canonicalUsername = (value: string) => value.trim().toLowerCase();
export async function credentialByLogin(organization: string, username: string) {
  const index = await readRecord<{ subject: string }>(client, loginKey(canonicalOrg(organization), canonicalUsername(username)));
  return index ? readRecord<Credential>(client, credentialKey(index.subject)) : null;
}
export async function takeRate(scope: string, limit: number, window = 15 * 60_000) {
  const now = Date.now(), start = Math.floor(now / window) * window;
  const key = `rate:${digest(`${scope}:${start}`)}`;
  const ok = await authTransaction(key, async tx => {
    const count = (await readRecord<{ count: number }>(tx, key, true))?.count || 0;
    if (count >= limit) return false;
    await writeRecord(tx, key, { count: count + 1 }, null, start + 2 * window); return true;
  });
  if (!ok) throw new InternalAuthError('rateLimited');
}
export async function assertActiveCredential(tx: AuthSql, c: Credential) {
  if (!c.enabled || !c.password || c.mustChange || !c.totpSecret || !c.emailVerified) throw new InternalAuthError('invalidLogin');
  const rows = await tx.unsafe('select app_user_id,tenant_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
  if (!rows[0] || rows[0].tenant_id !== c.tenantId) throw new InternalAuthError('invalidLogin');
  return rows[0] as { app_user_id: string; tenant_id: string };
}
async function audit(tx: AuthSql, c: Credential, event: string) {
  const rows = await tx.unsafe('select app_user_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
  if (rows[0]) await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,$3,'user',$2::uuid,NULL)", [c.tenantId, rows[0].app_user_id, event]);
}
async function makeSession(tx: AuthSql, c: Credential, native: boolean, recoveryCodes?: string[]): Promise<AuthReply> {
  await assertActiveCredential(tx, c);
  const raw = opaque(), family = randomUUID(), expiry = Date.now() + SESSION_LIFE;
  const value: Session = { subject: c.subject, version: c.version, family, native, absoluteExpiry: expiry };
  await writeRecord(tx, `family:${family}`, { subject: c.subject }, c.subject, expiry);
  await writeRecord(tx, `session:${digest(raw)}`, value, c.subject, native ? Date.now() + ACCESS_LIFE : expiry);
  let refresh: string | undefined;
  if (native) {
    refresh = opaque(); await writeRecord(tx, `refresh:${digest(refresh)}`, { ...value, used: false }, c.subject, expiry);
  }
  await audit(tx, c, 'app-user.logged-in');
  return { step: 'complete', access_token: native ? `aihr_${raw}` : raw,
    ...(refresh ? { refresh_token: `aihr_refresh_${refresh}` } : {}), expires_in: native ? ACCESS_LIFE / 1000 : SESSION_LIFE / 1000,
    ...(recoveryCodes ? { recoveryCodes } : {}) };
}
function reply(raw: string, c: Credential, challenge: Challenge): AuthReply {
  return { step: challenge.phase, challenge: raw, ...(challenge.phase === 'enroll' ? { secret: challenge.secret, account: `${c.organization}:${c.username}` } : {}) };
}
export async function startLogin(input: { organization: string; username: string; password: string; native: boolean }): Promise<AuthReply> {
  const org = canonicalOrg(input.organization), username = canonicalUsername(input.username);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(org) || !/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username)) throw new InternalAuthError('invalidLogin');
  await takeRate('login-global', 120, 60_000);
  await takeRate(`login:${org}:${username}`, 10);
  const c = await credentialByLogin(org, username);
  const matched = await passwordMatches(input.password, c?.password || DUMMY_PASSWORD_HASH);
  if (!c?.enabled || !matched) throw new InternalAuthError('invalidLogin');
  return authTransaction(c.subject, async tx => {
    const current = await readRecord<Credential>(tx, credentialKey(c.subject), true);
    if (!current?.enabled || current.version !== c.version || current.password !== c.password) throw new InternalAuthError('invalidLogin');
    const principal = await tx.unsafe('select tenant_id from app.principal_by_identity($1,$2)', [current.issuer, current.subject]);
    if (!principal[0] || principal[0].tenant_id !== current.tenantId) throw new InternalAuthError('invalidLogin');
    const raw = opaque();
    const phase = current.totpSecret ? 'mfa' : current.mustChange ? 'password' : 'enroll';
    const challenge: Challenge = { subject: c.subject, version: c.version, phase, attempts: 0, native: input.native, expiresAt: Date.now() + CHALLENGE_LIFE,
      ...(phase === 'enroll' ? { secret: generateSecret() } : {}) };
    await writeRecord(tx, `challenge:${digest(raw)}`, challenge, c.subject, challenge.expiresAt);
    return reply(raw, current, challenge);
  });
}
async function withChallenge(raw: string, native: boolean, operation: (tx: AuthSql, c: Credential, challenge: Challenge, key: string) => Promise<AuthReply | { failure: true }>) {
  if (!validOpaque(raw)) throw new InternalAuthError('invalidChallenge');
  const key = `challenge:${digest(raw)}`, initial = await readRecord<Challenge>(client, key);
  if (!initial) throw new InternalAuthError('invalidChallenge');
  const result = await authTransaction(initial.subject, async tx => {
    const challenge = await readRecord<Challenge>(tx, key, true);
    const c = await readRecord<Credential>(tx, credentialKey(initial.subject), true);
    if (!challenge || challenge.native !== native || !c || c.version !== challenge.version || challenge.attempts >= 5 || challenge.subject !== c.subject || (!c.enabled && !challenge.invitation)) throw new InternalAuthError('invalidChallenge');
    const outcome = await operation(tx, c, challenge, key);
    if ('failure' in outcome) {
      challenge.attempts++;
      await writeRecord(tx, key, challenge, c.subject, challenge.expiresAt);
    }
    return outcome;
  });
  if ('failure' in result) throw new InternalAuthError('invalidCode');
  return result;
}
export async function changeInitialPassword(raw: string, password: string, native = false): Promise<AuthReply> {
  return withChallenge(raw, native, async (tx, c, ch, key) => {
    if (ch.phase !== 'password' || (c.totpSecret && !ch.mfaPassed)) throw new InternalAuthError('invalidChallenge');
    try { validatePassword(password, c.username, c.email); } catch { throw new InternalAuthError('passwordPolicy'); }
    if (c.password && await passwordMatches(password, c.password)) throw new InternalAuthError('passwordPolicy');
    c.password = await passwordHash(password); c.mustChange = false; c.version = randomUUID();
    await revokeCredentialsSessions(tx, c.subject);
    await writeRecord(tx, credentialKey(c.subject), c, c.subject);
    await audit(tx, c, 'app-user.password-reset');
    if (c.totpSecret && ch.mfaPassed) return makeSession(tx, c, ch.native);
    ch.version = c.version; ch.phase = 'enroll'; ch.secret = generateSecret();
    await writeRecord(tx, key, ch, c.subject, ch.expiresAt);
    return reply(raw, c, ch);
  });
}
async function checkFactor(c: Credential, code: string, secret = c.totpSecret): Promise<{ step?: number; recovery?: number } | null> {
  if (!secret) return null;
  if (/^\d{6}$/.test(code)) {
    const match = await verify({ secret, token: code, epochTolerance: 30 });
    if (!match.valid) return null;
    const step = Math.floor(match.epoch / 30);
    return step > c.lastStep ? { step } : null;
  }
  const cleaned = code.replace(/[-\s]/g, '').toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(cleaned)) return null;
  const index = c.recoveryHashes.indexOf(digest(`${c.subject}:${cleaned}`));
  return index >= 0 ? { recovery: index } : null;
}
function consumeFactor(c: Credential, factor: { step?: number; recovery?: number }) {
  if (factor.step !== undefined) c.lastStep = factor.step;
  if (factor.recovery !== undefined) c.recoveryHashes.splice(factor.recovery, 1);
}
export async function verifyMfa(raw: string, code: string, native = false): Promise<AuthReply> {
  const initial = validOpaque(raw) ? await readRecord<Challenge>(client, `challenge:${digest(raw)}`) : null;
  if (initial) await takeRate(`mfa:${initial.subject}`, 15);
  return withChallenge(raw, native, async (tx, c, ch, key) => {
    if (!['enroll', 'mfa'].includes(ch.phase)) throw new InternalAuthError('invalidChallenge');
    const factor = await checkFactor(c, code, ch.phase === 'enroll' ? ch.secret : c.totpSecret);
    if (!factor || (ch.phase === 'enroll' && factor.recovery !== undefined)) return { failure: true };
    consumeFactor(c, factor);
    let codes: string[] | undefined;
    if (ch.phase === 'enroll') {
      c.totpSecret = ch.secret!;
      codes = Array.from({ length: 8 }, () => randomBytes(16).toString('hex').toUpperCase());
      c.recoveryHashes = codes.map(value => digest(`${c.subject}:${value}`));
      codes = codes.map(value => value.match(/.{8}/g)!.join('-'));
      if (ch.invitation) {
        const usernameKey = loginKey(c.organization, c.username);
        await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))", [usernameKey]);
        if (await readRecord(tx, usernameKey, true)) throw new InternalAuthError('conflict');
        const accepted = await tx.unsafe('select * from app.consume_identity_invitation($1,$2,$3,$4)', [ch.invitation, c.issuer, c.subject, c.email]);
        if (!accepted[0] || accepted[0].tenant_id !== c.tenantId) throw new InternalAuthError('invalidChallenge');
        c.enabled = true; c.emailVerified = true;
        await writeRecord(tx, usernameKey, { subject: c.subject }, c.subject);
        await audit(tx, c, 'app-user.invitation.accepted');
      }
      await audit(tx, c, 'app-user.mfa-enrolled');
    }
    await writeRecord(tx, credentialKey(c.subject), c, c.subject);
    if (c.mustChange) {
      ch.phase = 'password'; ch.mfaPassed = true;
      await writeRecord(tx, key, ch, c.subject, ch.expiresAt);
      return reply(raw, c, ch);
    }
    await deleteRecord(tx, key);
    return makeSession(tx, c, ch.native, codes);
  });
}
export async function readSession(token: string | undefined, native = false) {
  if (native && !token?.startsWith('aihr_')) return null;
  const raw = native ? token!.slice(5) : token;
  if (!validOpaque(raw)) return null;
  const key = `session:${digest(raw)}`, session = await readRecord<Session>(client, key);
  if (!session || session.native !== native || session.absoluteExpiry <= Date.now()) return null;
  const c = await readRecord<Credential>(client, credentialKey(session.subject));
  if (!c || c.version !== session.version || !await readRecord(client, `family:${session.family}`)) return null;
  try { await assertActiveCredential(client, c); } catch (e) { if (e instanceof InternalAuthError) return null; throw e; }
  return { subject: c.subject, issuer: c.issuer, email: c.email, emailVerified: c.emailVerified, family: session.family,
    credential: c, sessionKey: key };
}
export async function rotateRefresh(token: string): Promise<AuthReply> {
  const raw = token.startsWith('aihr_refresh_') ? token.slice(13) : '';
  if (!validOpaque(raw)) throw new InternalAuthError('invalidLogin');
  const key = `refresh:${digest(raw)}`, initial = await readRecord<Refresh>(client, key);
  if (!initial) throw new InternalAuthError('invalidLogin');
  const result = await authTransaction(initial.subject, async tx => {
    const value = await readRecord<Refresh>(tx, key, true);
    if (!value) return null;
    if (value.used) { await deleteRecord(tx, `family:${value.family}`); return null; }
    const c = await readRecord<Credential>(tx, credentialKey(value.subject), true);
    if (!c || c.version !== value.version || !value.native || value.absoluteExpiry <= Date.now() || !await readRecord(tx, `family:${value.family}`)) return null;
    await assertActiveCredential(tx, c);
    await writeRecord(tx, key, { ...value, used: true }, c.subject, value.absoluteExpiry);
    const next = opaque(), access = opaque();
    await writeRecord(tx, `refresh:${digest(next)}`, { ...value, used: false }, c.subject, value.absoluteExpiry);
    await writeRecord(tx, `session:${digest(access)}`, value, c.subject, Math.min(Date.now() + ACCESS_LIFE, value.absoluteExpiry));
    return { step: 'complete' as const, access_token: `aihr_${access}`, refresh_token: `aihr_refresh_${next}`, expires_in: Math.min(ACCESS_LIFE, value.absoluteExpiry - Date.now()) / 1000 };
  });
  if (!result) throw new InternalAuthError('invalidLogin');
  return result;
}
export async function revokeSession(token: string | undefined, native = false, refresh?: string) {
  const session = await readSession(token, native);
  let family = session?.family;
  if (!family && refresh?.startsWith('aihr_refresh_') && validOpaque(refresh.slice(13))) family = (await readRecord<Refresh>(client, `refresh:${digest(refresh.slice(13))}`))?.family;
  if (family) await authTransaction(`family:${family}`, async tx => {
    await deleteRecord(tx, `family:${family}`);
    if (session) { await deleteRecord(tx, session.sessionKey); await audit(tx, session.credential, 'app-user.logged-out'); }
  });
}
/** Called only after an operator or the audited manual-enrollment flow chooses a tenant/person. */
export async function createDisabledCredential(input: { tenantId: string; username: string; email: string; enrollmentId?: string }) {
  const organization = await readRecord<Organization>(client, `tenant:${input.tenantId}`);
  if (!organization) throw new InternalAuthError('unavailable');
  const username = canonicalUsername(input.username), email = input.email.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@+-]{2,63}$/.test(username) || !/^\S+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) throw new InternalAuthError('conflict');
  const key = loginKey(organization.code, username);
  return authTransaction(key, async tx => {
    const previous = await readRecord<{ subject: string }>(tx, key, true);
    if (previous) {
      const existing = await readRecord<Credential>(tx, credentialKey(previous.subject));
      if (input.enrollmentId && existing?.enrollmentId === input.enrollmentId && !existing.enabled && existing.tenantId === input.tenantId && existing.username === username && existing.email === email) return existing.subject;
      throw new InternalAuthError('conflict');
    }
    const subject = randomUUID();
    const c: Credential = { subject, tenantId: input.tenantId, issuer: internalIssuer(input.tenantId), organization: organization.code,
      username, email, emailVerified: true, enabled: false, password: null, mustChange: true, version: randomUUID(), totpSecret: null, lastStep: -1, recoveryHashes: [], ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}) };
    if (input.enrollmentId) await writeRecord(tx, `manual-intent:${input.enrollmentId}`, { subject }, subject);
    await writeRecord(tx, credentialKey(subject), c, subject); await writeRecord(tx, key, { subject }, subject);
    return subject;
  });
}
export async function updateDisabledCredential(subject: string, operation: 'password' | 'enable' | 'cancel', password?: string) {
  return authTransaction(subject, async tx => {
    const key = credentialKey(subject), c = await readRecord<Credential>(tx, key, true);
    if (!c) { if (operation === 'cancel') return; throw new InternalAuthError('conflict'); }
    if (operation === 'enable' && c.enabled) return;
    if (c.enabled) throw new InternalAuthError('conflict');
    if (operation === 'password') {
      validatePassword(password || '', c.username, c.email); c.password = await passwordHash(password!); c.version = randomUUID();
    } else if (operation === 'enable') {
      const p = await tx.unsafe('select tenant_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]);
      if (!c.password || !p[0] || p[0].tenant_id !== c.tenantId || !c.mustChange) throw new InternalAuthError('conflict');
      c.enabled = true;
    } else {
      await deleteRecord(tx, loginKey(c.organization, c.username)); await deleteRecord(tx, key); return;
    }
    await writeRecord(tx, key, c, c.subject);
  });
}

/** Consumes the verified factor on the locked credential; callers persist it in the same transaction. */
export async function verifyCredentialFactor(c: Credential, code: string) {
 const factor = await checkFactor(c, code); if (!factor) return false; consumeFactor(c, factor); return true;
}
