/**
 * ADR-0161 — operator console status, Issue/Reissue and import intents, executed by the provisioning
 * runner. REQUIRES the mobile setup intent migration (db/migrations/*_mobile_workplace_setup_issuance.sql)
 * to be journaled; until then app.operator_mobile_setup does not exist and this file cannot pass.
 *
 * The repository anchor's private key is not in the tree, so the anchors module is replaced by a throwaway
 * anchor (as in test/mobile-setup-issuance.test.ts). Stored setups are judged by the installed app's verifier.
 */
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, like, sql } from 'drizzle-orm';
vi.mock('../lib/mobile-trust-anchors', async () => {
  const { generateKeyPairSync: pairOf } = await import('node:crypto');
  const pair = pairOf('ed25519');
  return {
    INSTALLED_APP_TRUST: Object.freeze([Object.freeze({ keyId: 'test-console', publicKey: pair.publicKey.export({ format: 'jwk' }).x! })]),
    TEST_SIGNING_PRIVATE_KEY: pair.privateKey,
  };
});
import * as anchors from '../lib/mobile-trust-anchors';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  readOperatorMobileSetup, requestOperatorMobileSetupImport, requestOperatorMobileSetupIssue,
} from '../core/operator-mobile-setup';
import { readMobileSetupForAdmin } from '../core/mobile-workplace-setup';
import { runProvisionTick } from '../scripts/provision-runner';
import { MOBILE_SETUP_REQUEST_STALE_MINUTES, issueMobileSetup, runMobileSetupRequestTick } from '../scripts/mobile-setup-issuance';
import { provisionInternalOrganization } from '../lib/internal-auth/provision-organization';
import { signCompanyProfile, workplaceProfile, type TrustAnchor } from '../lib/mobile-workplace-setup-signer';
import { verifyCompanyProfile } from '../mobile/lib/company-profile';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const TRUST = anchors.INSTALLED_APP_TRUST as TrustAnchor[];
const PRIVATE_KEY = (anchors as unknown as { TEST_SIGNING_PRIVATE_KEY: KeyObject }).TEST_SIGNING_PRIVATE_KEY;
const ORIGIN = 'https://hr.test';
const DAY = 86400;
const nowSeconds = () => Math.floor(Date.now() / 1000);
const keys = mkdtempSync(join(tmpdir(), 'aihr-console-keys-'));
const goodKey = join(keys, 'signing.pem');
writeFileSync(goodKey, PRIVATE_KEY.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const stranger = generateKeyPairSync('ed25519');

let base: Base, operator: SessionContext;
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
  vi.stubEnv('AUTH_SESSION_KEY', '8'.repeat(64)); vi.stubEnv('NEXT_PUBLIC_APP_URL', origin); vi.stubEnv('ALLOW_DEMO_SESSION', 'false');
};
const signing = () => vi.stubEnv('AIHR_MOBILE_SETUP_SIGNING_KEY', goodKey);
async function customer(code: string | null) {
  const b = await seedBase();
  if (code) await owner.db.transaction(tx => provisionInternalOrganization(tx, { tenantId: b.tenantId, code, name: 'Snapshot' }));
  return b;
}
function file(organization: string, options: { origin?: string; at?: number; key?: KeyObject; trust?: TrustAnchor[] } = {}) {
  const at = options.at ?? nowSeconds();
  const profile = workplaceProfile({ origin: options.origin ?? ORIGIN, organization, name: 'Signed by Stradaverse', hosting: 'on-premise' }, { now: at });
  return JSON.stringify(signCompanyProfile(profile, options.key ?? PRIVATE_KEY, options.trust ?? TRUST, at), null, 2) + '\n';
}
async function requests(tenantId: string) {
  return owner.db.select().from(schema.mobileSetupRequest).where(eq(schema.mobileSetupRequest.tenantId, tenantId))
    .orderBy(asc(schema.mobileSetupRequest.createdAt), asc(schema.mobileSetupRequest.id));
}
async function events(tenantId: string) {
  return owner.db.select({ type: schema.domainEvent.eventType, actorType: schema.domainEvent.actorType, actorId: schema.domainEvent.actorId, payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, tenantId), like(schema.domainEvent.eventType, 'mobile.workplace-setup.%')))
    .orderBy(asc(schema.domainEvent.sequence));
}
async function setting(tenantId: string) {
  const [row] = await owner.db.select().from(schema.tenantSetting)
    .where(and(eq(schema.tenantSetting.tenantId, tenantId), eq(schema.tenantSetting.key, 'mobile.workplace_setup')));
  return row ?? null;
}

describe('the database boundary', () => {
  it('only an operator reaches the status read and the intent writer, including by direct SQL', async () => {
    internal();
    const c = await customer('boundary-co');
    await expect(readOperatorMobileSetup(adminCtx(c), c.tenantId)).rejects.toThrow(/operator/);
    await expect(requestOperatorMobileSetupIssue(adminCtx(c), c.tenantId)).rejects.toThrow(/operator/);
    for (const query of [sql`select * from app.operator_mobile_setup(${c.tenantId}::uuid)`,
      sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'issue',NULL)`]) {
      await expect(withTenant(adminCtx(c), tx => tx.execute(query))).rejects.toThrow();
    }
    const forged = { ...adminCtx(c), grants: [{ role: 'operator', companyId: null }] } as SessionContext;
    await expect(withTenant(forged, tx => tx.execute(sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'issue',NULL)`))).rejects.toThrow();
    expect(await requests(c.tenantId)).toEqual([]);
  });
  it('the application role may only SELECT its own tenant intents: no direct write, RLS on', async () => {
    const [privileges] = await owner.db.execute<Record<string, boolean>>(sql`select
      has_table_privilege('ai_hr_app','public.mobile_setup_request','SELECT') as read,
      has_table_privilege('ai_hr_app','public.mobile_setup_request','INSERT') as insert,
      has_table_privilege('ai_hr_app','public.mobile_setup_request','UPDATE') as update,
      has_table_privilege('ai_hr_app','public.mobile_setup_request','DELETE') as delete,
      (select relrowsecurity from pg_class where oid='public.mobile_setup_request'::regclass) as rls`);
    expect(privileges).toEqual({ read: true, insert: false, update: false, delete: false, rls: true });
    const functions = await owner.db.execute<{ name: string; definer: boolean; app: boolean; public: boolean }>(sql`select p.proname as name, p.prosecdef as definer,
      has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') as public
      from pg_proc p where p.oid in ('app.operator_mobile_setup(uuid)'::regprocedure,'app.operator_request_mobile_setup(uuid,text,jsonb)'::regprocedure)
      order by p.proname`);
    expect([...functions]).toEqual([
      { name: 'operator_mobile_setup', definer: true, app: true, public: false },
      { name: 'operator_request_mobile_setup', definer: true, app: true, public: false },
    ]);
    internal();
    const c = await customer('own-co'), other = await customer('other-co');
    await withTenant(operator, tx => tx.execute(sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'issue',NULL)`));
    expect(await withTenant(adminCtx(other), tx => tx.select().from(schema.mobileSetupRequest))).toEqual([]);
    expect(await withTenant(adminCtx(c), tx => tx.select({ id: schema.mobileSetupRequest.id }).from(schema.mobileSetupRequest))).toHaveLength(1);
    await expect(withTenant(adminCtx(c), tx => tx.update(schema.mobileSetupRequest).set({ status: 'done' }))).rejects.toThrow();
  });
});

describe('Issue / Reissue', () => {
  it('records an intent the runner executes with this installation key, audited with the operator as requester', async () => {
    internal(); signing();
    const c = await customer('console-co');
    expect(await readOperatorMobileSetup(operator, c.tenantId)).toMatchObject({ signs: true, state: 'none', pending: false, link: null });
    await requestOperatorMobileSetupIssue(operator, c.tenantId);
    expect(await readOperatorMobileSetup(operator, c.tenantId)).toMatchObject({ pending: true, requests: [{ action: 'issue', status: 'pending', error: null }] });
    expect(await runMobileSetupRequestTick(owner)).toBe('done');
    const status = (await readOperatorMobileSetup(operator, c.tenantId))!;
    expect(status).toMatchObject({ state: 'issued', origin: ORIGIN, organization: 'console-co', keyId: 'test-console', pending: false, expiresSoon: false });
    expect(status.link?.startsWith(ORIGIN + '/login/mobile-setup#setup=')).toBe(true);
    expect(status.requests.map(r => [r.action, r.status])).toEqual([['issue', 'done']]);
    const ledger = await events(c.tenantId);
    expect(ledger.map(e => [e.type, e.actorType])).toEqual([['mobile.workplace-setup.requested', 'user'], ['mobile.workplace-setup.issued', 'system']]);
    expect(ledger[0].actorId).toBe(operator.userId);
    const [request] = await requests(c.tenantId);
    expect(ledger[1].payload).toMatchObject({ trigger: 'requested', requestId: request.id, requestedBy: operator.userId, keyId: 'test-console' });
    expect(JSON.stringify(ledger)).not.toContain(((await setting(c.tenantId))!.value as { setup: { payload: string } }).setup.payload);
    // The customer administrator sees the same link the operator console shows.
    expect(await readMobileSetupForAdmin(adminCtx(c))).toMatchObject({ state: 'ready', link: status.link });
  });
  it('reissues even when the current setup is still valid, and keeps one open intent per customer', async () => {
    internal(); signing();
    const c = await customer('reissue-co');
    // Signed a minute earlier: Ed25519 is deterministic, so a same-second reissue would be byte-identical.
    await issueMobileSetup(owner, c.tenantId, 'missing', { now: nowSeconds() - 60 });
    const first = ((await setting(c.tenantId))!.value as { setup: { signature: string } }).setup.signature;
    await requestOperatorMobileSetupIssue(operator, c.tenantId);
    await expect(requestOperatorMobileSetupIssue(operator, c.tenantId)).rejects.toThrow(/already in progress/);
    await expect(requestOperatorMobileSetupImport(operator, c.tenantId, file('reissue-co'))).rejects.toThrow(/already in progress/);
    expect(await requests(c.tenantId)).toHaveLength(1);
    await runMobileSetupRequestTick(owner);
    const second = ((await setting(c.tenantId))!.value as { setup: { signature: string } }).setup.signature;
    expect(second).not.toBe(first);
    expect((await events(c.tenantId)).map(e => e.type)).toEqual([
      'mobile.workplace-setup.issued', 'mobile.workplace-setup.requested', 'mobile.workplace-setup.reissued',
    ]);
    // A closed intent no longer blocks the next one.
    await requestOperatorMobileSetupIssue(operator, c.tenantId);
    expect((await requests(c.tenantId)).map(r => r.status)).toEqual(['done', 'pending']);
  });
  it('refuses Issue on an installation without the key — in the console, and in the runner if an intent arrives anyway', async () => {
    internal();
    const c = await customer('no-key-co');
    expect((await readOperatorMobileSetup(operator, c.tenantId))!.signs).toBe(false);
    await expect(requestOperatorMobileSetupIssue(operator, c.tenantId)).rejects.toThrow(/signing key/);
    expect(await requests(c.tenantId)).toEqual([]);
    await withTenant(operator, tx => tx.execute(sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'issue',NULL)`));
    expect(await runMobileSetupRequestTick(owner)).toBe('failed');
    expect((await requests(c.tenantId)).map(r => [r.status, r.error])).toEqual([['failed', 'key_not_configured']]);
    expect(await setting(c.tenantId)).toBeNull();
  });
  it('refuses a customer without an embedded sign-in organization before recording anything', async () => {
    internal(); signing();
    const c = await customer(null);
    await expect(requestOperatorMobileSetupIssue(operator, c.tenantId)).rejects.toThrow(/organization code/);
    expect(await requests(c.tenantId)).toEqual([]);
  });
  it('the provisioning tick executes the intent and a stale claim returns to the queue', async () => {
    internal(); signing();
    const c = await customer('tick-co');
    await requestOperatorMobileSetupIssue(operator, c.tenantId);
    await owner.db.update(schema.mobileSetupRequest)
      .set({ status: 'running', claimedAt: new Date(Date.now() - (MOBILE_SETUP_REQUEST_STALE_MINUTES + 1) * 60_000) })
      .where(eq(schema.mobileSetupRequest.tenantId, c.tenantId));
    await runProvisionTick(owner);
    expect((await requests(c.tenantId)).map(r => r.status)).toEqual(['done']);
    expect((await readOperatorMobileSetup(operator, c.tenantId))!.state).toBe('issued');
  });
});

describe('Import signed setup', () => {
  it('queues a verified upload that the runner stores on a server without the key', async () => {
    internal();
    const c = await customer('import-co');
    await requestOperatorMobileSetupImport(operator, c.tenantId, file('import-co'));
    const [request] = await requests(c.tenantId);
    expect(request).toMatchObject({ action: 'import', status: 'pending', requestedBy: operator.userId });
    expect(await runMobileSetupRequestTick(owner)).toBe('done');
    const value = (await setting(c.tenantId))!.value as { setup: unknown; method: string };
    expect(value.method).toBe('imported');
    expect(verifyCompanyProfile(JSON.stringify(value.setup), TRUST)).toMatchObject({ organization: 'import-co', apiOrigin: ORIGIN, hosting: 'on-premise' });
    expect(await readOperatorMobileSetup(operator, c.tenantId)).toMatchObject({ state: 'imported', organization: 'import-co', signs: false });
    expect((await events(c.tenantId)).map(e => e.type)).toEqual(['mobile.workplace-setup.requested', 'mobile.workplace-setup.imported']);
  });
  it.each([
    ['another server', () => file('refuse-co', { origin: 'https://elsewhere.test' }), /another server address/],
    ['another organization', () => file('someone-else'), /another organization/],
    ['an untrusted key', () => file('refuse-co', { key: stranger.privateKey, trust: [{ keyId: 'stranger', publicKey: stranger.publicKey.export({ format: 'jwk' }).x! }] }), /trusts/],
    ['an expired setup', () => file('refuse-co', { at: nowSeconds() - 400 * DAY }), /expired/],
    ['a file that is not a setup', () => '{"hello":"world"}', /not a signed workplace setup/],
    ['an oversized file', () => ' '.repeat(16_385), /16 KB/],
  ] as const)('refuses %s in the console and records nothing', async (_label, upload, message) => {
    internal();
    const c = await customer('refuse-co');
    await expect(requestOperatorMobileSetupImport(operator, c.tenantId, upload())).rejects.toThrow(message);
    expect(await requests(c.tenantId)).toEqual([]);
    expect(await events(c.tenantId)).toEqual([]);
  });
  it('the runner re-verifies: an intent carrying a setup for another organization is refused and stores nothing', async () => {
    internal();
    const c = await customer('reverify-co');
    const wrong = JSON.parse(file('someone-else'));
    await withTenant(operator, tx => tx.execute(sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'import',${JSON.stringify(wrong)}::jsonb)`));
    expect(await runMobileSetupRequestTick(owner)).toBe('failed');
    expect((await requests(c.tenantId)).map(r => [r.status, r.error])).toEqual([['failed', 'organization_mismatch']]);
    expect(await setting(c.tenantId)).toBeNull();
    expect((await readOperatorMobileSetup(operator, c.tenantId))!.requests[0]).toMatchObject({ status: 'failed', error: 'organization_mismatch' });
  });
  it('the database refuses a malformed intent', async () => {
    internal();
    const c = await customer('shape-co');
    for (const query of [
      sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'import',NULL)`,
      sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'issue','{"keyId":"x"}'::jsonb)`,
      sql`select app.operator_request_mobile_setup(${c.tenantId}::uuid,'delete',NULL)`,
      sql`select app.operator_request_mobile_setup(${randomUUID()}::uuid,'issue',NULL)`,
      sql`select app.operator_request_mobile_setup('00000000-0000-0000-0000-000000000000'::uuid,'issue',NULL)`,
    ]) await expect(withTenant(operator, tx => tx.execute(query))).rejects.toThrow();
    expect(await requests(c.tenantId)).toEqual([]);
  });
});

describe('status read', () => {
  it('marks a stored setup unusable for this server, without a link, after the sign-in origin changes', async () => {
    internal(); signing();
    const c = await customer('status-co');
    await issueMobileSetup(owner, c.tenantId, 'missing');
    internal('https://moved.test');
    expect(await readOperatorMobileSetup(operator, c.tenantId)).toMatchObject({ state: 'invalid', reason: 'origin_mismatch', link: null, origin: ORIGIN });
    internal();
    await issueMobileSetup(owner, c.tenantId, 'missing', { now: nowSeconds() - 340 * DAY, force: true });
    expect(await readOperatorMobileSetup(operator, c.tenantId)).toMatchObject({ state: 'issued', expiresSoon: true });
    expect(await readOperatorMobileSetup(operator, randomUUID())).toBeNull();
  });
});
