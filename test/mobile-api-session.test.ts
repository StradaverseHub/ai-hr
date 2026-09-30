/**
 * ADR-0088 §1 — `getMobileSession()`: the bearer carrier into the SAME resolver the production web path
 * uses. Driven end to end against the database: a locally generated RSA key signs a token whose `sub` is a
 * real harness user's WorkOS subject, and the real `app.principal_by_subject` (with 0279's login-block
 * filter) resolves it. Only the JWKS is local.
 */
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { AuthRequiredError } from '../lib/auth-errors';
import type { Jwk, JwksSource } from '../lib/mobile-api/jwt';
import { getMobileSession } from '../lib/session';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks: JwksSource = async () => [{ ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'test-k1', alg: 'RS256' }];
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function bearer(sub: string, ttlSeconds = 300): string {
  const input = `${b64({ alg: 'RS256', kid: 'test-k1', typ: 'JWT' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + ttlSeconds })}`;
  return `Bearer ${input}.${cryptoSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** Guards read CODE, not prose: a comment quoting a string must not satisfy (or trip) an assertion. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*$/gm, '$1');

let base: Base;
const lastYear = () => `${Number(todayInKualaLumpur().slice(0, 4)) - 1}-01-01`;

async function employeeLogin(name: string) {
  const e = await hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: lastYear(),
  });
  const userId = await createAppUser(base.tenantId, e.personId, 'employee');
  const [u] = await owner.db
    .select({ subject: schema.appUser.workosUserId })
    .from(schema.appUser)
    .where(eq(schema.appUser.id, userId));
  return { ...e, userId, subject: u.subject as string };
}

async function refusal(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeAll();
});

describe('getMobileSession — a verified token resolves through principal_by_subject', () => {
  it('yields the same SessionContext shape the web path builds, entitlements included', async () => {
    const a = await employeeLogin('Mobile Aina');
    const s = await getMobileSession({ authorization: bearer(a.subject), jwks });
    expect(s.userId).toBe(a.userId); // the INTERNAL app_user id, not the WorkOS subject
    expect(s.personId).toBe(a.personId);
    expect(s.tenantId).toBe(base.tenantId);
    expect(s.roles).toEqual(['employee']);
    // withEntitlements ran: the snapshot (or its recorded failure) is on the session, as on the web.
    expect(s.entitlements ?? s.entitlementsError).toBeDefined();
  });

  it('refuses a correctly signed token whose subject is linked to no login', async () => {
    const e = await refusal(getMobileSession({ authorization: bearer('user_NOT_A_REAL_SUBJECT'), jwks }));
    expect(e).toBeInstanceOf(AuthRequiredError);
  });

  it('refuses an ARCHIVED login although its token is still valid (0279 login block)', async () => {
    const a = await employeeLogin('Mobile Badrul');
    const token = bearer(a.subject);
    // Non-vacuity: this exact token resolves before the archive.
    expect((await getMobileSession({ authorization: token, jwks })).userId).toBe(a.userId);
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, a.userId));
    expect(await refusal(getMobileSession({ authorization: token, jwks }))).toBeInstanceOf(AuthRequiredError);
  });

  it('refuses a LEAVER: every employment ended, token still valid (offboarding needs no WorkOS revoke)', async () => {
    const a = await employeeLogin('Mobile Chandra');
    const token = bearer(a.subject);
    expect((await getMobileSession({ authorization: token, jwks })).userId).toBe(a.userId);
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: sql`current_date - 7` })
      .where(eq(schema.employment.id, a.employmentId));
    expect(await refusal(getMobileSession({ authorization: token, jwks }))).toBeInstanceOf(AuthRequiredError);
  });

  it('refuses an expired token for a live login', async () => {
    const a = await employeeLogin('Mobile Devi');
    const e = await refusal(getMobileSession({ authorization: bearer(a.subject, -120), jwks }));
    expect(e).toBeInstanceOf(AuthRequiredError);
  });
});

describe('getMobileSession — bearer only, fail closed', () => {
  it.each([
    ['no Authorization header', null],
    ['an empty header', ''],
    ['the share gate’s Basic credentials', 'Basic ZGVtbzpzZWtyZXQ='],
    ['a bare token without the Bearer scheme', 'aaa.bbb.ccc'],
  ])('refuses %s', async (_n, header) => {
    expect(await refusal(getMobileSession({ authorization: header, jwks }))).toBeInstanceOf(AuthRequiredError);
  });

  it('refuses everything while WORKOS_CLIENT_ID is unset — even a token that would verify', async () => {
    const a = await employeeLogin('Mobile Eng');
    vi.stubEnv('WORKOS_CLIENT_ID', '');
    // No injected jwks: this is the production path, which must not reach the network without a client id.
    const e = await refusal(getMobileSession({ authorization: bearer(a.subject) }));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect((e as Error).message).toMatch(/not configured/);
  });

  it('never reads the demo cookie or the dev switcher (the share-gate bypass depends on it)', () => {
    const src = stripComments(readFileSync(new URL('../lib/session.ts', import.meta.url), 'utf8'));
    const start = src.indexOf('export async function getMobileSession');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    for (const forbidden of ['cookies(', 'DEV_COOKIE', 'demoSwitcherEnabled', 'resolveDevPrincipal', 'DEV_USER_ID']) {
      expect(body, `getMobileSession must not use ${forbidden}`).not.toContain(forbidden);
    }
    // And it resolves through the shared resolver, not a copy of it.
    expect(body).toContain('resolveWorkosPrincipal(');
    expect(body).toContain('withEntitlements(');
    expect(body).toContain('app.principal_by_subject(');
  });
});
