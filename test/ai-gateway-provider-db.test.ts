/** General AI gateway provider (0661) against the real database: storage, read-back and the check. */
process.env.AI_CONFIG_SECRET = 'ai-hr-test-master-passphrase-0123456789';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { AiConfigError, resolveActiveAiConfig, saveAiProviderConfig } from '../core/ai-config';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('general AI gateway provider (0661)', () => {
  let base: Base;
  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => { await resetDb(); base = await seedBase(); });
  afterAll(async () => { await closeAll(); });
  it('stores a public https gateway address, reads it back, and refuses internal or malformed ones', async () => {
    const a = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] } as SessionContext;
    await saveAiProviderConfig(a, { provider: 'ai_gateway', model: 'gpt-5.5', apiKey: 'sk-gateway-1234', makeActive: true, providerOptions: { version: 1, baseUrl: 'https://router.flatkey.ai/v1' } });
    const [row] = await owner.db.select().from(schema.aiProviderConfig).where(eq(schema.aiProviderConfig.tenantId, base.tenantId));
    expect(row).toMatchObject({ provider: 'ai_gateway', model: 'gpt-5.5', providerOptions: { version: 1, baseUrl: 'https://router.flatkey.ai/v1' } });
    const resolved = await withTenant(a, tx => resolveActiveAiConfig(tx, a));
    expect(resolved).toMatchObject({ provider: 'ai_gateway', gatewayBaseUrl: 'https://router.flatkey.ai/v1' });
    for (const baseUrl of ['http://router.flatkey.ai/v1', 'https://10.0.0.5/v1', 'https://ai.internal/v1'])
      await expect(saveAiProviderConfig(a, { provider: 'ai_gateway', model: 'gpt-5.5', providerOptions: { version: 1, baseUrl } })).rejects.toBeInstanceOf(AiConfigError);
    // The database check refuses what the application would refuse, and keeps options off direct providers.
    await expect(owner.db.update(schema.aiProviderConfig).set({ providerOptions: { version: 1, baseUrl: 'https://127.0.0.1/v1' } }).where(eq(schema.aiProviderConfig.id, row.id))).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(owner.db.execute(sql`update ai_provider_config set provider='openai' where id=${row.id}::uuid`)).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
