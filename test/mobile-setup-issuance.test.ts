/**
 * ADR-0161 — automatic mobile workplace setup issuance, the customer administrator's view and the
 * on-premise import, against the real database, RLS and the real provisioning tick.
 *
 * The repository's trust anchor has no private key in the tree, so the anchors module is replaced by a
 * throwaway anchor whose key this file generates. Every stored setup is judged by the INSTALLED APP's
 * verifier (mobile/lib/company-profile.ts) against that anchor, not by the server code under test.
 */
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, like } from 'drizzle-orm';
vi.mock('../lib/mobile-trust-anchors', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const pair = generateKeyPairSync('ed25519');
  return {
    INSTALLED_APP_TRUST: Object.freeze([Object.freeze({ keyId: 'test-issuance', publicKey: pair.publicKey.export({ format: 'jwk' }).x! })]),
    TEST_SIGNING_PRIVATE_KEY: pair.privateKey,
  };
});
import * as anchors from '../lib/mobile-trust-anchors';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createProvisionRequest, listProvisionRequests } from '../core/operator';
import { readMobileSetupForAdmin } from '../core/mobile-workplace-setup';
import { runProvisionTick } from '../scripts/provision-runner';
import { importMobileSetup, issueMobileSetup, mobileSetupPass, MOBILE_SETUP_RETRY_SECONDS } from '../scripts/mobile-setup-issuance';
import { provisionInternalOrganization } from '../lib/internal-auth/provision-organization';
import { signCompanyProfile, workplaceProfile, type SignedEnvelope, type TrustAnchor } from '../lib/mobile-workplace-setup-signer';
import { readWorkplaceSetupLink } from '../lib/mobile-workplace-setup';
import { verifyCompanyProfile } from '../mobile/lib/company-profile';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const TRUST = anchors.INSTALLED_APP_TRUST as TrustAnchor[];
const PRIVATE_KEY = (anchors as unknown as { TEST_SIGNING_PRIVATE_KEY: KeyObject }).TEST_SIGNING_PRIVATE_KEY;
const KEY = 'mobile.workplace_setup';
const ORIGIN = 'https://hr.test';
const DAY = 86400;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Keys live outside the repository (the signer refuses anything inside the application directory).
const keys = mkdtempSync(join(tmpdir(), 'aihr-issuance-keys-'));
const goodKey = join(keys, 'signing.pem'), looseKey = join(keys, 'loose.pem'), foreignKey = join(keys, 'foreign.pem');
writeFileSync(goodKey, PRIVATE_KEY.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
writeFileSync(looseKey, PRIVATE_KEY.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
chmodSync(looseKey, 0o644);

let base: Base, operator: SessionContext;
writeFileSync(foreignKey, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const stranger = generateKeyPairSync('ed25519');
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  const [user] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: randomUUID() }).returning();
  await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: user.id, role: 'operator', companyId: null });
  operator = { tenantId: base.tenantId, userId: user.id, roles: ['operator'], grants: [{ role: 'operator', companyId: null }] };
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { rmSync(keys, { recursive: true, force: true }); await closeAll(); });

const internal = (origin = ORIGIN) => {
  vi.stubEnv('AUTH_PROVIDER', 'internal'); vi.stubEnv('AUTH_PUBLIC_ORIGIN', origin);
  vi.stubEnv('AUTH_SESSION_KEY', '8'.repeat(64)); vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
  // /login/mobile-connection answers unavailable on a demo session, so issuance and display stand down there.
  vi.stubEnv('ALLOW_DEMO_SESSION', 'false');
};
const signing = (path = goodKey) => vi.stubEnv('AIHR_MOBILE_SETUP_SIGNING_KEY', path);

async function stored(tenantId: string) {
  const rows = await owner.db.select().from(schema.tenantSetting)
    .where(and(eq(schema.tenantSetting.tenantId, tenantId), eq(schema.tenantSetting.key, KEY)));
  return rows[0] ?? null;
}
type Value = { version: number; setup: SignedEnvelope | null; method: string | null; recordedAt: string | null; failure: { reason: string; at: string } | null };
const valueOf = async (tenantId: string) => (await stored(tenantId))?.value as Value | undefined;
async function events(tenantId: string) {
  return owner.db.select({ type: schema.domainEvent.eventType, actorType: schema.domainEvent.actorType, payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, tenantId), like(schema.domainEvent.eventType, 'mobile.workplace-setup.%')))
    .orderBy(asc(schema.domainEvent.sequence));
}
async function customer(code: string | null) {
  const b = await seedBase();
  if (code) await owner.db.transaction(tx => provisionInternalOrganization(tx, { tenantId: b.tenantId, code, name: 'Snapshot name' }));
  return b;
}
function sign(organization: string, options: { at?: number; origin?: string; key?: KeyObject; trust?: TrustAnchor[] } = {}) {
  const at = options.at ?? nowSeconds();
  const profile = workplaceProfile({ origin: options.origin ?? ORIGIN, organization, name: 'Signed elsewhere', hosting: 'on-premise' }, { now: at });
  return signCompanyProfile(profile, options.key ?? PRIVATE_KEY, options.trust ?? TRUST, at);
}
async function storeDirect(tenantId: string, setup: SignedEnvelope, source = 'platform') {
  const value = { version: 1, setup, method: 'issued', recordedAt: new Date().toISOString(), failure: null };
  await owner.db.insert(schema.tenantSetting).values({ tenantId, key: KEY, value, source })
    .onConflictDoUpdate({ target: [schema.tenantSetting.tenantId, schema.tenantSetting.key], set: { value, source } });
}
async function provision(code: string, name = 'Automatic Customer') {
  const { id } = await createProvisionRequest(operator, { customerName: name, adminEmail: `${code}@example.test`, organizationCode: code, modules: [] });
  await runProvisionTick(owner);
  const request = (await listProvisionRequests(operator)).find(r => r.id === id)!;
  return request;
}

describe('automatic issuance when provisioning completes', () => {
  it('issues and records nothing on an installation without a signing key', async () => {
    internal();
    const request = await provision('no-key-co');
    expect(request.status).toBe('done');
    expect(await stored(request.tenantId!)).toBeNull();
    expect(await events(request.tenantId!)).toEqual([]);
  });

  it('signs and stores the new customer setup once provisioning commits, and the app accepts it', async () => {
    internal(); signing();
    const request = await provision('auto-co', 'Auto Customer Sdn Bhd');
    expect(request.status).toBe('done');
    const row = await stored(request.tenantId!);
    expect(row).toMatchObject({ source: 'platform', updatedBy: null });
    const value = row!.value as Value;
    expect(value).toMatchObject({ version: 1, method: 'issued', failure: null });
    const profile = verifyCompanyProfile(JSON.stringify(value.setup), TRUST);
    expect(profile).toMatchObject({
      authProvider: 'internal', apiOrigin: ORIGIN, issuer: ORIGIN + '/auth', clientId: 'aihr-mobile', audience: 'aihr-api',
      organization: 'auto-co', id: 'auto-co', name: 'Auto Customer Sdn Bhd', hosting: 'cloud',
    });
    expect(profile.expiresAt - nowSeconds()).toBeGreaterThan(364 * DAY);
    const ledger = await events(request.tenantId!);
    expect(ledger.map(e => e.type)).toEqual(['mobile.workplace-setup.issued']);
    expect(ledger[0].actorType).toBe('system');
    expect(Object.keys(ledger[0].payload as object).sort()).toEqual(['expiresAt', 'keyId', 'method', 'trigger']);
    expect(ledger[0].payload).toMatchObject({ keyId: 'test-issuance', method: 'issued', trigger: 'provisioned' });
    // Never the signed payload or signature in the audit record.
    expect(JSON.stringify(ledger)).not.toContain(value.setup!.payload);
    expect(JSON.stringify(ledger)).not.toContain(value.setup!.signature);
    // A further tick finds it current and writes nothing.
    await runProvisionTick(owner);
    expect((await events(request.tenantId!)).length).toBe(1);
  });

  it('a signing failure never fails provisioning: the reason is recorded once, and retried after the window', async () => {
    internal(); signing(looseKey);
    const request = await provision('loose-key-co');
    expect(request.status).toBe('done');
    expect(request.tenantId).toBeTruthy();
    expect(await owner.db.select({ id: schema.tenant.id }).from(schema.tenant).where(eq(schema.tenant.id, request.tenantId!))).toHaveLength(1);
    const failed = (await valueOf(request.tenantId!))!;
    expect(failed).toMatchObject({ setup: null, method: null, failure: { reason: 'key_permissions' } });
    expect((await events(request.tenantId!)).map(e => [e.type, (e.payload as { reason?: string }).reason])).toEqual([['mobile.workplace-setup.issue-failed', 'key_permissions']]);
    // Inside the retry window nothing is attempted, even once the key is fixed.
    signing(goodKey);
    await runProvisionTick(owner);
    expect((await valueOf(request.tenantId!))!.failure).toEqual(failed.failure);
    // Age the failure past the window: the next tick retries and clears it.
    const aged = { ...failed, failure: { ...failed.failure!, at: new Date((nowSeconds() - MOBILE_SETUP_RETRY_SECONDS - 60) * 1000).toISOString() } };
    await owner.db.update(schema.tenantSetting).set({ value: aged })
      .where(and(eq(schema.tenantSetting.tenantId, request.tenantId!), eq(schema.tenantSetting.key, KEY)));
    await runProvisionTick(owner);
    const after = (await valueOf(request.tenantId!))!;
    expect(after).toMatchObject({ method: 'issued', failure: null });
    expect(verifyCompanyProfile(JSON.stringify(after.setup), TRUST).organization).toBe('loose-key-co');
    expect((await events(request.tenantId!)).map(e => [e.type, (e.payload as { trigger?: string }).trigger]))
      .toEqual([['mobile.workplace-setup.issue-failed', 'provisioned'], ['mobile.workplace-setup.issued', 'retry']]);
  });

  it('refuses to sign with a key the installed app does not trust', async () => {
    internal(); signing(foreignKey);
    const request = await provision('foreign-key-co');
    expect(request.status).toBe('done');
    expect(await valueOf(request.tenantId!)).toMatchObject({ setup: null, failure: { reason: 'key_untrusted' } });
  });
});

describe('the per-tick pass over existing customers', () => {
  it('issues for an existing embedded-sign-in customer, skips a tenant without a namespace, and leaves a current setup alone', async () => {
    internal(); signing();
    const existing = await customer('legacy-co'), unbound = await customer(null);
    expect(await mobileSetupPass(owner)).toEqual({ issued: 1, failed: 0 });
    expect(verifyCompanyProfile(JSON.stringify((await valueOf(existing.tenantId))!.setup), TRUST).organization).toBe('legacy-co');
    expect(await stored(unbound.tenantId)).toBeNull();
    expect(await mobileSetupPass(owner)).toEqual({ issued: 0, failed: 0 });
    expect((await events(existing.tenantId)).map(e => e.type)).toEqual(['mobile.workplace-setup.issued']);
  });

  it('renews inside the 30-day window and reissues after the sign-in origin changes', async () => {
    internal(); signing();
    const c = await customer('renew-co');
    expect(await issueMobileSetup(owner, c.tenantId, 'missing', { now: nowSeconds() - 340 * DAY })).toMatchObject({ outcome: 'issued' });
    expect(await mobileSetupPass(owner)).toEqual({ issued: 1, failed: 0 });
    const renewed = verifyCompanyProfile(JSON.stringify((await valueOf(c.tenantId))!.setup), TRUST);
    expect(renewed.expiresAt - nowSeconds()).toBeGreaterThan(364 * DAY);
    internal('https://hr-new.test');
    expect(await mobileSetupPass(owner)).toEqual({ issued: 1, failed: 0 });
    expect(verifyCompanyProfile(JSON.stringify((await valueOf(c.tenantId))!.setup), TRUST)).toMatchObject({ apiOrigin: 'https://hr-new.test', issuer: 'https://hr-new.test/auth' });
    expect((await events(c.tenantId)).map(e => [e.type, (e.payload as { trigger: string }).trigger])).toEqual([
      ['mobile.workplace-setup.issued', 'missing'], ['mobile.workplace-setup.reissued', 'renewal'], ['mobile.workplace-setup.reissued', 'origin_changed'],
    ]);
  });

  it('is bounded per tick and reaches every customer across ticks', async () => {
    internal(); signing();
    const tenants = [await customer('bound-a'), await customer('bound-b'), await customer('bound-c')];
    expect(await mobileSetupPass(owner, { limit: 2 })).toEqual({ issued: 2, failed: 0 });
    expect(await mobileSetupPass(owner, { limit: 2 })).toEqual({ issued: 1, failed: 0 });
    for (const t of tenants) expect((await valueOf(t.tenantId))!.method).toBe('issued');
  });

  it('does nothing without the key, when embedded sign-in is not selected, or on a demo session', async () => {
    internal();
    const c = await customer('idle-co');
    expect(await mobileSetupPass(owner)).toEqual({ issued: 0, failed: 0 });
    signing(); vi.stubEnv('AUTH_PROVIDER', 'workos');
    expect(await mobileSetupPass(owner)).toEqual({ issued: 0, failed: 0 });
    internal(); signing(); vi.stubEnv('ALLOW_DEMO_SESSION', 'true');
    expect(await mobileSetupPass(owner)).toEqual({ issued: 0, failed: 0 });
    expect(await issueMobileSetup(owner, c.tenantId, 'missing')).toEqual({ outcome: 'skipped', reason: 'not_issuing' });
    expect(await stored(c.tenantId)).toBeNull();
    expect(await events(c.tenantId)).toEqual([]);
  });
});

describe("the customer administrator's Mobile app page", () => {
  it("shows a re-verified link for the administrator's own tenant only", async () => {
    internal(); signing();
    const own = await customer('view-co'), other = await customer('other-co');
    await issueMobileSetup(owner, own.tenantId, 'missing');
    const view = await readMobileSetupForAdmin(adminCtx(own));
    if (view.state !== 'ready') throw new Error('expected a ready setup');
    expect(view).toMatchObject({ organization: 'view-co', hosting: 'cloud', expiresSoon: false });
    expect(view.link.startsWith(ORIGIN + '/login/mobile-setup#setup=')).toBe(true);
    expect(JSON.parse(readWorkplaceSetupLink(view.link))).toEqual((await valueOf(own.tenantId))!.setup);
    // The other customer has no setup, and cannot read this one even with a direct query (RLS).
    expect(await readMobileSetupForAdmin(adminCtx(other))).toEqual({ state: 'unavailable' });
    const leaked = await withTenant(adminCtx(other), tx => tx.select({ key: schema.tenantSetting.key }).from(schema.tenantSetting)
      .where(eq(schema.tenantSetting.tenantId, own.tenantId)));
    expect(leaked).toEqual([]);
    // The operator role does not imply customer administration (ADR-0140).
    await expect(readMobileSetupForAdmin({ ...operator, tenantId: own.tenantId })).rejects.toThrow(/administrator/);
  });

  it('falls back to the plain state whenever the stored setup no longer verifies for this server and tenant', async () => {
    internal();
    const c = await customer('check-co');
    const ctx = adminCtx(c);
    expect(await readMobileSetupForAdmin(ctx)).toEqual({ state: 'unavailable' });
    await storeDirect(c.tenantId, sign('check-co'));
    expect((await readMobileSetupForAdmin(ctx)).state).toBe('ready');
    for (const [label, setup] of [
      ['another organization', sign('someone-else')],
      ['another server', sign('check-co', { origin: 'https://elsewhere.test' })],
      ['expired', sign('check-co', { at: nowSeconds() - 400 * DAY })],
    ] as const) {
      await storeDirect(c.tenantId, setup);
      expect(await readMobileSetupForAdmin(ctx), label).toEqual({ state: 'unavailable' });
    }
    // Provenance: only the platform writes this key.
    await storeDirect(c.tenantId, sign('check-co'), 'customer');
    expect(await readMobileSetupForAdmin(ctx)).toEqual({ state: 'unavailable' });
    await storeDirect(c.tenantId, sign('check-co'));
    internal('https://moved.test');
    expect(await readMobileSetupForAdmin(ctx)).toEqual({ state: 'unavailable' });
    internal(); vi.stubEnv('AUTH_PROVIDER', 'workos');
    expect(await readMobileSetupForAdmin(ctx)).toEqual({ state: 'unavailable' });
    internal();
    await storeDirect(c.tenantId, sign('check-co', { at: nowSeconds() - 340 * DAY }));
    expect(await readMobileSetupForAdmin(ctx)).toMatchObject({ state: 'ready', expiresSoon: true });
  });

  it('a customer administrator cannot write the platform-managed setup, whatever provenance it claims', async () => {
    internal();
    const c = await customer('write-co');
    const groupAdmin: SessionContext = { ...adminCtx(c), grants: [{ role: 'hr_admin', companyId: null }] };
    for (const source of ['customer', 'platform']) {
      const error = await withTenant(groupAdmin, tx => tx.insert(schema.tenantSetting)
        .values({ tenantId: c.tenantId, key: KEY, value: { version: 1, setup: sign('write-co'), method: 'issued', recordedAt: null, failure: null }, source }))
        .catch((e: unknown) => e);
      expect(error, source).toBeInstanceOf(Error);
    }
    expect(await stored(c.tenantId)).toBeNull();
  });
});

describe('importing a setup on an installation without the signing key', () => {
  it('stores a setup signed for this server and customer, audits it, and the pass leaves it alone', async () => {
    internal();
    const c = await customer('import-co');
    const setup = sign('import-co');
    expect(await importMobileSetup(owner, c.tenantId, JSON.stringify(setup))).toMatchObject({ keyId: 'test-issuance', replaced: false });
    expect(await valueOf(c.tenantId)).toMatchObject({ setup, method: 'imported', failure: null });
    expect((await stored(c.tenantId))!.source).toBe('platform');
    const ledger = await events(c.tenantId);
    expect(ledger.map(e => e.type)).toEqual(['mobile.workplace-setup.imported']);
    expect(ledger[0].payload).toMatchObject({ keyId: 'test-issuance', method: 'imported', replaced: false });
    expect(await mobileSetupPass(owner)).toEqual({ issued: 0, failed: 0 });
    expect(await readMobileSetupForAdmin(adminCtx(c))).toMatchObject({ state: 'ready', organization: 'import-co', hosting: 'on-premise' });
  });

  it.each([
    ['another server', () => JSON.stringify(sign('refuse-co', { origin: 'https://elsewhere.test' })), 'origin_mismatch'],
    ['another organization', () => JSON.stringify(sign('someone-else')), 'organization_mismatch'],
    ['an untrusted key', () => JSON.stringify(sign('refuse-co', { key: stranger.privateKey,
      trust: [{ keyId: 'stranger', publicKey: stranger.publicKey.export({ format: 'jwk' }).x! }] })), 'untrusted_key'],
    ['a changed payload', () => JSON.stringify({ ...sign('refuse-co'), payload: sign('someone-else').payload }), 'bad_signature'],
    ['an expired setup', () => JSON.stringify(sign('refuse-co', { at: nowSeconds() - 400 * DAY })), 'expired'],
    ['a setup without an organization', () => {
      const { organization: _organization, ...legacy } = workplaceProfile({ origin: ORIGIN, organization: 'refuse-co', name: 'Legacy', hosting: 'cloud' });
      return JSON.stringify(signCompanyProfile(legacy, PRIVATE_KEY, TRUST));
    }, 'not_workplace'],
    ['a file that is not a setup', () => '{"hello":"world"}', 'malformed'],
  ] as const)('refuses %s and stores nothing', async (_label, file, code) => {
    internal();
    const c = await customer('refuse-co');
    await expect(importMobileSetup(owner, c.tenantId, file())).rejects.toMatchObject({ code });
    expect(await stored(c.tenantId)).toBeNull();
    expect(await events(c.tenantId)).toEqual([]);
  });

  it('refuses a customer that has no embedded sign-in organization on this server', async () => {
    internal();
    const c = await customer(null);
    await expect(importMobileSetup(owner, c.tenantId, JSON.stringify(sign('refuse-co')))).rejects.toMatchObject({ code: 'organization_unavailable' });
    expect(await stored(c.tenantId)).toBeNull();
  });
});
