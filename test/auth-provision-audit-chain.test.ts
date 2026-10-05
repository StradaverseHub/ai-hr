import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { AUTH_SYSTEM_TENANT_ID } from '../db/audit-transaction';
import { acceptInvitation, recordLoginBlocked, recordLoginFailed, recordLoginSucceeded } from '../core/auth';
import { runProvisionTick } from '../scripts/provision-runner';
import { closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';

beforeAll(migrateTestDb);
beforeEach(async () => {
  vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'false');
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(closeAll);

async function setChain(tenantId: string, value: boolean) {
  await owner.db.insert(schema.tenantSetting).values({
    tenantId, key: 'audit.hash_chain_enabled', value, source: 'platform',
  }).onConflictDoUpdate({ target: [schema.tenantSetting.tenantId, schema.tenantSetting.key], set: { value } });
}

async function events(tenantId: string) {
  return owner.db.select({
    type: schema.domainEvent.eventType, seq: schema.domainEvent.chainSeq,
    hash: schema.domainEvent.hash, prev: schema.domainEvent.prevHash,
  }).from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, tenantId))
    .orderBy(schema.domainEvent.chainSeq, schema.domainEvent.id);
}

function expectChain(rows: Awaited<ReturnType<typeof events>>) {
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map((row) => row.seq)).toEqual(rows.map((_, index) => index + 1));
  for (const [index, row] of rows.entries()) {
    expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.prev).toBe(index === 0 ? 'GENESIS' : rows[index - 1].hash);
  }
}

async function pendingInvite(tenantId: string) {
  const raw = randomBytes(32).toString('base64url');
  const [invitation] = await owner.db.insert(schema.appInvitation).values({
    tenantId, email: 'first-admin@audit.test', role: 'hr_admin',
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    status: 'pending', expiresAt: sql`now() + interval '1 day'`,
  }).returning({ id: schema.appInvitation.id });
  return { raw, id: invitation.id };
}

async function queueCustomer() {
  const [request] = await owner.db.insert(schema.tenantProvisionRequest).values({
    customerName: 'Audit Customer', adminEmail: 'admin@audit-customer.test',
  }).returning({ id: schema.tenantProvisionRequest.id });
  await runProvisionTick(owner);
  const [result] = await owner.db.select().from(schema.tenantProvisionRequest)
    .where(eq(schema.tenantProvisionRequest.id, request.id));
  expect(result.status).toBe('done');
  expect(result.tenantId).not.toBeNull();
  return result;
}

describe('pre-auth audit transaction chaining', () => {
  it('chains successful login and invitation activation from the persisted tenant setting with env off', async () => {
    const base = await seedBase();
    await setChain(base.tenantId, true);
    await recordLoginSucceeded({ tenantId: base.tenantId, userId: base.adminUserId });
    const invitation = await pendingInvite(base.tenantId);
    const activated = await acceptInvitation({ token: invitation.raw, subject: 'workos_audit_first_admin' });
    expect(activated.tenantId).toBe(base.tenantId);
    const rows = await events(base.tenantId);
    expect(rows.map((row) => row.type)).toEqual(['app-user.logged-in', 'app-user.invitation.accepted']);
    expectChain(rows);
  });

  it('chains unknown/blocked logins in the reserved system tenant from the deployment flag', async () => {
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'true');
    await recordLoginFailed({ email: 'unknown@audit.test' });
    await recordLoginBlocked({ subject: 'workos_not_linked' });
    expectChain(await events(AUTH_SYSTEM_TENANT_ID));
  });

  it('uses the deployment fallback for a known tenant without an explicit setting', async () => {
    const base = await seedBase();
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'true');
    await recordLoginSucceeded({ tenantId: base.tenantId, userId: base.adminUserId });
    expectChain(await events(base.tenantId));
  });

  it('keeps an explicitly disabled tenant and the demo/off path unchained', async () => {
    const base = await seedBase();
    await recordLoginFailed({ email: 'demo@audit.test' });
    expect((await events(AUTH_SYSTEM_TENANT_ID)).map((row) => row.seq)).toEqual([null]);
    await setChain(base.tenantId, false);
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'true');
    await recordLoginSucceeded({ tenantId: base.tenantId, userId: base.adminUserId });
    expect(await events(base.tenantId)).toEqual([
      { type: 'app-user.logged-in', seq: null, hash: null, prev: null },
    ]);
  });

  it('ignores customer-sourced overrides of the platform-controlled setting', async () => {
    const base = await seedBase();
    // Owner injects a legacy/corrupt row; current app RLS cannot create this platform-scoped value.
    await owner.db.insert(schema.tenantSetting).values({
      tenantId: base.tenantId, key: 'audit.hash_chain_enabled', value: false, source: 'customer',
    });
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'true');
    await recordLoginSucceeded({ tenantId: base.tenantId, userId: base.adminUserId });
    expectChain(await events(base.tenantId));
  });

  it('rolls back invitation consumption and the new principal if the audit write fails', async () => {
    const base = await seedBase();
    await setChain(base.tenantId, true);
    const invitation = await pendingInvite(base.tenantId);
    const subject = 'workos_audit_failure';
    await owner.db.execute(sql`alter table domain_event add constraint test_auth_audit_failure
      check (event_type <> 'app-user.invitation.accepted') not valid`);
    try {
      await expect(acceptInvitation({ token: invitation.raw, subject })).rejects.toThrow();
      const [unchanged] = await owner.db.select({ status: schema.appInvitation.status })
        .from(schema.appInvitation).where(eq(schema.appInvitation.id, invitation.id));
      expect(unchanged.status).toBe('pending');
      expect(await owner.db.select({ id: schema.appUser.id }).from(schema.appUser)
        .where(eq(schema.appUser.workosUserId, subject))).toHaveLength(0);
      expect(await events(base.tenantId)).toHaveLength(0);
    } finally {
      await owner.db.execute(sql`alter table domain_event drop constraint test_auth_audit_failure`);
    }
    // The very same one-time token is still usable after the failed audit transaction.
    await acceptInvitation({ token: invitation.raw, subject });
    expectChain(await events(base.tenantId));
  });

  it('does not expose a still-usable invitation token through SQL error parameters or causes', async () => {
    const base = await seedBase();
    const invitation = await pendingInvite(base.tenantId);
    const subject = 'workos_audit_secret_failure';
    await owner.db.execute(sql`alter table app_user add constraint test_auth_consume_failure
      check (workos_user_id <> 'workos_audit_secret_failure') not valid`);
    try {
      const error = await acceptInvitation({ token: invitation.raw, subject }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Invitation activation could not be completed. Please try again.');
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error as Error))).not.toContain(invitation.raw);
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(subject);
      const [unchanged] = await owner.db.select({ status: schema.appInvitation.status })
        .from(schema.appInvitation).where(eq(schema.appInvitation.id, invitation.id));
      expect(unchanged.status).toBe('pending');
    } finally {
      await owner.db.execute(sql`alter table app_user drop constraint test_auth_consume_failure`);
    }
    await acceptInvitation({ token: invitation.raw, subject });
  });
});

describe('owner provisioning audit transaction chaining', () => {
  it('chains the first seed event onward, persists the setting, and chains a later reissue with env off', async () => {
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'true');
    const provisioned = await queueCustomer();
    const tenantId = provisioned.tenantId!;
    const before = await events(tenantId);
    expectChain(before);
    const [setting] = await owner.db.select({ value: schema.tenantSetting.value }).from(schema.tenantSetting)
      .where(and(eq(schema.tenantSetting.tenantId, tenantId), eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')));
    expect(setting.value).toBe(true);
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'false');
    await owner.db.update(schema.tenantProvisionRequest)
      .set({ activationUrl: null, reissueRequestedAt: new Date() })
      .where(eq(schema.tenantProvisionRequest.id, provisioned.id));
    const result = await runProvisionTick(owner);
    expect(result.reissued).toBe(1);
    const after = await events(tenantId);
    expect(after).toHaveLength(before.length + 1);
    expectChain(after);
  });

  it('leaves demo/off provisioning unchanged and does not add an enabled tenant setting', async () => {
    const provisioned = await queueCustomer();
    const rows = await events(provisioned.tenantId!);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.seq === null && row.hash === null && row.prev === null)).toBe(true);
    const settings = await owner.db.select().from(schema.tenantSetting)
      .where(and(eq(schema.tenantSetting.tenantId, provisioned.tenantId!), eq(schema.tenantSetting.key, 'audit.hash_chain_enabled')));
    expect(settings).toHaveLength(0);
  });

  it('does not rewrite unchained history when chaining is enabled for a later reissue', async () => {
    const provisioned = await queueCustomer();
    const tenantId = provisioned.tenantId!;
    const before = await events(tenantId);
    await setChain(tenantId, true);
    await owner.db.update(schema.tenantProvisionRequest)
      .set({ activationUrl: null, reissueRequestedAt: new Date() })
      .where(eq(schema.tenantProvisionRequest.id, provisioned.id));
    await runProvisionTick(owner);
    const after = await events(tenantId);
    expect(after.filter((row) => row.seq === null)).toEqual(before);
    expectChain(after.filter((row) => row.seq !== null));
  });

  it('redacts completion SQL errors and rolls back all customer rows and chained seed events', async () => {
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://sensitive-activation.audit.test');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [request] = await owner.db.insert(schema.tenantProvisionRequest).values({
      customerName: 'Completion Failure', adminEmail: 'completion@audit.test',
    }).returning({ id: schema.tenantProvisionRequest.id });
    await owner.db.execute(sql`alter table tenant_provision_request add constraint test_activation_save_failure
      check (activation_url is null) not valid`);
    try {
      await runProvisionTick(owner);
      const [failed] = await owner.db.select().from(schema.tenantProvisionRequest)
        .where(eq(schema.tenantProvisionRequest.id, request.id));
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/^Provisioning completion failed \(database code 23514\)/);
      expect(failed.tenantId).toBeNull();
      expect(failed.activationUrl).toBeNull();
      expect(await owner.db.select({ id: schema.tenant.id }).from(schema.tenant)
        .where(eq(schema.tenant.name, 'Completion Failure'))).toHaveLength(0);
      expect(await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent)).toHaveLength(0);
      const escaped = JSON.stringify([output.mock.calls, errors.mock.calls, failed.error]);
      expect(escaped).not.toContain('sensitive-activation.audit.test');
      expect(escaped).not.toContain('/invite/');
      expect(escaped).not.toContain('params:');
    } finally {
      await owner.db.execute(sql`alter table tenant_provision_request drop constraint test_activation_save_failure`);
    }
  });

  it('redacts reissue SQL errors while keeping the old invitation and request retryable', async () => {
    vi.stubEnv('AUDIT_HASH_CHAIN_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://sensitive-reissue.audit.test');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const provisioned = await queueCustomer();
    const tenantId = provisioned.tenantId!;
    const before = await events(tenantId);
    await owner.db.update(schema.tenantProvisionRequest)
      .set({ activationUrl: null, reissueRequestedAt: new Date() })
      .where(eq(schema.tenantProvisionRequest.id, provisioned.id));
    await owner.db.execute(sql`alter table tenant_provision_request add constraint test_reissue_save_failure
      check (activation_url is null) not valid`);
    try {
      const failure = await runProvisionTick(owner).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/^Provisioning reissue failed \(database code 23514\)/);
      expect((failure as Error).cause).toBeUndefined();
      const [unchanged] = await owner.db.select().from(schema.tenantProvisionRequest)
        .where(eq(schema.tenantProvisionRequest.id, provisioned.id));
      expect(unchanged.status).toBe('done');
      expect(unchanged.reissueRequestedAt).not.toBeNull();
      expect(unchanged.activationUrl).toBeNull();
      expect(await events(tenantId)).toEqual(before);
      const invitations = await owner.db.select({ status: schema.appInvitation.status })
        .from(schema.appInvitation).where(eq(schema.appInvitation.tenantId, tenantId));
      expect(invitations).toEqual([{ status: 'pending' }]);
      const escaped = JSON.stringify([output.mock.calls, errors.mock.calls, unchanged.error, (failure as Error).message]);
      expect(escaped).not.toContain('sensitive-reissue.audit.test');
      expect(escaped).not.toContain('/invite/');
      expect(escaped).not.toContain('params:');
    } finally {
      await owner.db.execute(sql`alter table tenant_provision_request drop constraint test_reissue_save_failure`);
    }
    expect((await runProvisionTick(owner)).reissued).toBe(1);
  });
});
