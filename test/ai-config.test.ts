/**
 * AI provider configuration (ADR-0023). Tests the security-critical surface:
 *   - AES-256-GCM secret-at-rest: round-trips, refuses cross-tenant (AAD) and tampered tokens;
 *   - the app role CANNOT read the ciphertext column (column REVOKE + SECURITY DEFINER resolver);
 *   - the UI view never carries the key; resolveActiveAiConfig decrypts the stored key;
 *   - admin-only writes; one active provider per tenant; remove → drafting off.
 *
 * Deterministic env: set the master secret and clear any provider env keys the dev shell might export,
 * so the env-fallback path is predictable.
 */
process.env.AI_CONFIG_SECRET = 'ai-hr-test-master-passphrase-0123456789';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.AI_DRAFT_MODEL;

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { decryptSecret, encryptSecret, isSecretStorable, keyLast4 } from '../lib/ai/crypto';
import {
  AiConfigError,
  getAiConfigView,
  isAiConfigured,
  removeAiProviderConfig,
  resolveActiveAiConfig,
  saveAiProviderConfig,
} from '../core/ai-config';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('AES-256-GCM secret-at-rest', () => {
  it('round-trips, hides the plaintext, and binds to the tenant (AAD)', () => {
    const tenant = '11111111-1111-1111-1111-111111111111';
    const token = encryptSecret('sk-live-secret-9999', tenant);
    expect(token).not.toContain('sk-live-secret-9999');
    expect(decryptSecret(token, tenant)).toBe('sk-live-secret-9999');
  });

  it('refuses to decrypt under a different tenant', () => {
    const token = encryptSecret('sk-live-secret-9999', 'tenant-A');
    expect(() => decryptSecret(token, 'tenant-B')).toThrow();
  });

  it('refuses a tampered token', () => {
    const token = encryptSecret('sk-live-secret-9999', 'tenant-A');
    const tampered = token.slice(0, 18) + (token[18] === 'A' ? 'B' : 'A') + token.slice(19);
    expect(() => decryptSecret(tampered, 'tenant-A')).toThrow();
  });

  it('isSecretStorable + keyLast4', () => {
    expect(isSecretStorable()).toBe(true);
    expect(keyLast4('sk-abcd6789')).toBe('6789');
  });
});

describe('ai-config service', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  async function nonAdminCtx(): Promise<SessionContext> {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Reg Ular', primaryEmail: 'reg@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const uid = await createAppUser(base.tenantId, e.personId, 'employee');
    return { tenantId: base.tenantId, userId: uid, roles: ['employee'], personId: e.personId };
  }

  const eventTypes = async () => {
    const rows = await owner.db
      .select({ type: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.tenantId, base.tenantId));
    return rows.map((r) => r.type);
  };

  it('admin stores an encrypted key, the view hides it, and resolve decrypts it', async () => {
    const a = adminCtx(base);
    await saveAiProviderConfig(a, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-live-anthropic-xyz', makeActive: true });

    const view = await getAiConfigView(a);
    const anth = view.providers.find((p) => p.provider === 'anthropic')!;
    expect(anth.configured).toBe(true);
    expect(anth.isActive).toBe(true);
    expect(anth.keyLast4).toBe('-xyz');
    // The view object carries NO secret material at all.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('sk-live-anthropic-xyz');
    expect(serialized.toLowerCase()).not.toContain('ciphertext');

    // …but the resolver returns the decrypted key for the gateway.
    const cfg = await withTenant(a, (tx) => resolveActiveAiConfig(tx, a));
    expect(cfg).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-live-anthropic-xyz' });

    expect(await eventTypes()).toContain('ai-provider-config.saved');
  });

  it('the ciphertext column is not readable by the app role', async () => {
    const a = adminCtx(base);
    await saveAiProviderConfig(a, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-x-1234', makeActive: true });
    // The query must fail: ai_hr_app has no column-level SELECT on api_key_ciphertext. drizzle wraps
    // the Postgres error, so assert on the canonical cause (42501 = insufficient_privilege).
    const err = await withTenant(a, (tx) => tx.execute(sql`select api_key_ciphertext from ai_provider_config`)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const text = `${cause?.message ?? ''} ${(err as Error).message}`.toLowerCase();
    expect(cause?.code === '42501' || text.includes('permission denied')).toBe(true);
  });

  it('switching the active provider keeps exactly one active', async () => {
    const a = adminCtx(base);
    await saveAiProviderConfig(a, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-anthropic-aaaa', makeActive: true });
    await saveAiProviderConfig(a, { provider: 'openai', model: 'gpt-5.5', apiKey: 'sk-openai-bbbb', makeActive: true });

    const cfg = await withTenant(a, (tx) => resolveActiveAiConfig(tx, a));
    expect(cfg?.provider).toBe('openai');
    const view = await getAiConfigView(a);
    expect(view.providers.filter((p) => p.isActive).length).toBe(1);
  });

  it('non-admins cannot view or save AI configuration', async () => {
    const e = await nonAdminCtx();
    await expect(getAiConfigView(e)).rejects.toBeInstanceOf(AiConfigError);
    await expect(
      saveAiProviderConfig(e, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-x' }),
    ).rejects.toBeInstanceOf(AiConfigError);
  });

  it('removing the active provider turns drafting off (no tenant config, no env)', async () => {
    const a = adminCtx(base);
    await saveAiProviderConfig(a, { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-z-1234', makeActive: true });
    await removeAiProviderConfig(a, { provider: 'anthropic' });

    const cfg = await withTenant(a, (tx) => resolveActiveAiConfig(tx, a));
    expect(cfg).toBeNull();
    expect(await isAiConfigured(a)).toBe(false);
  });
});
