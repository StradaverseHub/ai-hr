import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { client } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { verifyTenantChain } from '../core/audit-chain';
import { emailServiceDatabaseGrants } from '../deploy/identity-email/database';

let base: Base;
const SYSTEM = '00000000-0000-0000-0000-000000000000';
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);

async function setting(tenantId: string, enabled: boolean) {
  await owner.db.insert(schema.tenantSetting).values({ tenantId, key: 'audit.hash_chain_enabled', value: enabled, source: 'platform' })
    .onConflictDoUpdate({ target: [schema.tenantSetting.tenantId, schema.tenantSetting.key], set: { value: enabled } });
}
const rows = (tenant: string) => owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, tenant)).orderBy(schema.domainEvent.chainSeq);
async function rawAuth(tenant: string | null = base.tenantId) {
  await client.begin(async tx => {
    await tx`select set_config('app.audit_hash_chain','off',true)`;
    await tx`select app.append_auth_event(${tenant}::uuid,'test',${randomUUID()}::uuid,'test.raw-auth','system',null,'{}'::jsonb)`;
    expect((await tx`select current_setting('app.audit_hash_chain') value`)[0].value).toBe('off');
  });
}

describe('persisted audit policy at the database insert boundary', () => {
  it('chains raw app-role authentication calls without tenant context or wrapper arming', async () => {
    await setting(base.tenantId, true);
    await Promise.all([rawAuth(), rawAuth(), rawAuth()]);
    const events = await rows(base.tenantId);
    expect(events.map(e => e.chainSeq)).toEqual([1, 2, 3]);
    expect(events[0].prevHash).toBe('GENESIS');
    expect(events[1].prevHash).toBe(events[0].hash);
    expect(await verifyTenantChain(adminCtx(base))).toMatchObject({ valid: true, checked: 3 });
  });
  it('leaves an unarmed tenant unchanged, then refuses to create a hole after history exists', async () => {
    await setting(base.tenantId, false);
    await rawAuth();
    expect((await rows(base.tenantId))[0].chainSeq).toBeNull();
    await setting(base.tenantId, true);
    await rawAuth();
    await setting(base.tenantId, false);
    await rawAuth();
    const chained = (await rows(base.tenantId)).filter(e => e.chainSeq !== null);
    expect(chained.map(e => e.chainSeq)).toEqual([1, 2]);
    expect(chained[1].prevHash).toBe(chained[0].hash);
    const other = await seedBase();
    await rawAuth(other.tenantId);
    expect((await rows(other.tenantId))[0].chainSeq).toBeNull();
  });
  it('protects pre-auth system events when the installation explicitly arms the system tenant', async () => {
    await setting(SYSTEM, true);
    await rawAuth(null);
    expect((await rows(SYSTEM))[0]).toMatchObject({ chainSeq: 1, prevHash: 'GENESIS' });
  });
  it('chains direct owner/job inserts even with an off session flag', async () => {
    await setting(base.tenantId, true);
    await owner.client.begin(async tx => {
      await tx`select set_config('app.audit_hash_chain','off',true)`;
      await tx`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
        values(${base.tenantId}::uuid,'test',${randomUUID()}::uuid,'test.raw-job','system','{}'::jsonb)`;
    });
    expect((await rows(base.tenantId))[0].chainSeq).toBe(1);
  });
  it('chains private-email events through the narrowly granted service role', async () => {
    await setting(base.tenantId, true);
    const issuer = 'https://hr.fixture-company.com/identity/realms/ai-hr';
    await owner.db.insert(schema.appExternalIdentity).values({ issuer, subject: 'audit-owner', appUserId: base.adminUserId });
    await owner.db.insert(schema.deploymentIdentityOperator).values({ issuer, subject: 'audit-owner', testEmail: 'owner@fixture-company.com' });
    const role = 'test_audit_mail_' + randomUUID().replaceAll('-', '');
    const [{ name }] = await owner.client`select current_database() name`;
    await owner.client.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    try {
      for (const grant of emailServiceDatabaseGrants(name, role)) await owner.client.unsafe(grant);
      await owner.client.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE "${role}"`);
        await tx`select set_config('app.audit_hash_chain','off',true)`;
        expect((await tx`select has_table_privilege(current_user,'tenant_setting','SELECT') allowed`)[0].allowed).toBe(false);
        await tx`select identity_email.record_event(${issuer},'audit-owner',${base.adminUserId}::uuid,${base.tenantId}::uuid,'draft-saved','{}'::jsonb)`;
      });
      expect((await rows(base.tenantId))[0]).toMatchObject({ chainSeq: 1, eventType: 'identity-email.draft-saved' });
    } finally {
      await owner.client.unsafe(`DROP OWNED BY "${role}"`);
      await owner.client.unsafe(`DROP ROLE "${role}"`);
    }
  });
});
