import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closeAll, migrateTestDb, owner, resetDb, seedBase } from './harness';
import { kbDocument, tenant } from '../db/schema';
import { loadGuides, refreshSystemGuides, seedGuides } from '../db/seed-guides';
import { SYSTEM_TENANT_ID } from '../core/sweep-scope';

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(resetDb);

describe('system guide refresh', () => {
  it('refreshes stale system text/translations in place and preserves customer slug collisions and uploads', async () => {
    const b = await seedBase();
    const guides = loadGuides();
    const source = guides.find(g => g.meta.slug === 'employee-overview')!;
    const collision = guides.find(g => g.meta.slug === 'employee-leave')!;
    const [old] = await owner.db.insert(kbDocument).values({ tenantId: b.tenantId, kind: 'article', slug: source.meta.slug, title: 'Old system guide', body: 'Old instructions', audience: 'employee', isSystem: true, i18n: { ms: { title: 'Old translation', body: 'Obsolete instructions' } } }).returning();
    const [custom] = await owner.db.insert(kbDocument).values({ tenantId: b.tenantId, kind: 'article', slug: collision.meta.slug, title: 'Company policy', body: 'Keep this policy', audience: 'employee', isSystem: false }).returning();
    const [upload] = await owner.db.insert(kbDocument).values({ tenantId: b.tenantId, kind: 'file', title: 'Company attachment', audience: 'all', isSystem: false, fileName: 'policy.txt', mimeType: 'text/plain', sizeBytes: 4, content: Buffer.from('keep') }).returning();
    await refreshSystemGuides(owner.db, b.tenantId);
    await refreshSystemGuides(owner.db, b.tenantId);
    const rows = await owner.db.select().from(kbDocument).where(eq(kbDocument.tenantId, b.tenantId));
    expect(rows).toHaveLength(guides.length + 1);
    expect(rows.find(r => r.id === old.id)).toMatchObject({ body: source.body, title: source.meta.title, i18n: null });
    expect(rows.find(r => r.id === custom.id)).toMatchObject({ body: 'Keep this policy', title: 'Company policy', isSystem: false });
    expect(rows.find(r => r.id === upload.id)?.content).toEqual(Buffer.from('keep'));
    expect(rows.some(r => r.slug?.startsWith('operator-'))).toBe(false);
  });

  it('refreshes all eligible tenants, skips reserved/suspended/closed tenants and honours an explicit target', async () => {
    const a = await seedBase();
    const b = await seedBase();
    const [suspended, closed] = await owner.db.insert(tenant).values([
      { name: 'Suspended', workosOrgId: randomUUID(), status: 'suspended' },
      { name: 'Closed', workosOrgId: randomUUID(), status: 'closed' },
    ]).returning();
    await refreshSystemGuides(owner.db, a.tenantId);
    expect(await owner.db.select().from(kbDocument).where(eq(kbDocument.tenantId, b.tenantId))).toHaveLength(0);
    const results = await refreshSystemGuides(owner.db);
    expect(results.find(r => r.tenantId === b.tenantId)?.refreshed).toBe(loadGuides().length);
    expect(results.find(r => r.tenantId === suspended.id)?.skipped).toContain('suspended');
    expect(results.find(r => r.tenantId === closed.id)?.skipped).toContain('closed');
    for (const id of [SYSTEM_TENANT_ID, suspended.id, closed.id]) {
      expect(await owner.db.select().from(kbDocument).where(eq(kbDocument.tenantId, id))).toHaveLength(0);
    }
    await expect(refreshSystemGuides(owner.db, randomUUID())).rejects.toThrow('does not exist');
  });

  it('participates in provisioning rollback rather than leaving partial guides behind', async () => {
    const b = await seedBase();
    await expect(owner.db.transaction(async tx => { await seedGuides(tx, b.tenantId); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await owner.db.select().from(kbDocument).where(and(eq(kbDocument.tenantId, b.tenantId), eq(kbDocument.isSystem, true)))).toHaveLength(0);
  });
});
