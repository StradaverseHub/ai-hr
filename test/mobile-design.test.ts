import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { changeMobileDesign, mobileBuilderState, publishedMobileDesign } from '../core/mobile-design';
import { composeMobileDesign, DEFAULT_MOBILE_DESIGN, legacyMobileDesign } from '../lib/mobile-design';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { AuthRequiredError } from '../lib/auth-errors';
const resolver = vi.hoisted(() => vi.fn());
vi.mock('../lib/session', () => ({ getMobileSession: resolver, getSession: vi.fn() }));
import { GET } from '../app/api/mobile/v1/design/route';

let a: Base, b: Base, admin: SessionContext;
const config = (name: string) => ({ ...DEFAULT_MOBILE_DESIGN, brandName: name });
const groupAdmin = (base: Base): SessionContext => ({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] });
const employee = (base: Base): SessionContext => ({ ...adminCtx(base), roles: ['employee'], grants: [{ role: 'employee', companyId: base.companyId }] });
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); a = await seedBase(); b = await seedBase(); admin = groupAdmin(a); });
afterAll(closeAll);

describe('tenant mobile builder, published snapshots and RLS', () => {
  it('saves a private draft without changing either tenant’s live design, then publishes only its tenant', async () => {
    await changeMobileDesign(admin, 'save', 0, config('Tenant A draft'));
    await changeMobileDesign(groupAdmin(b), 'save', 0, config('Tenant B'));
    await changeMobileDesign(groupAdmin(b), 'publish', 1);
    expect((await publishedMobileDesign(employee(a))).config.brandName).toBe('AIHR');
    await changeMobileDesign(admin, 'publish', 1);
    expect((await publishedMobileDesign(employee(a))).config.brandName).toBe('Tenant A draft');
    expect((await publishedMobileDesign(employee(b))).config.brandName).toBe('Tenant B');
    expect(await withTenant(employee(a), tx => tx.select().from(schema.mobileDesignDraft))).toHaveLength(0);
    expect(await withTenant(employee(a), tx => tx.select().from(schema.mobileDesignRelease))).toHaveLength(1);
    expect(await withTenant(admin, tx => tx.select().from(schema.mobileDesignRelease).where(eq(schema.mobileDesignRelease.tenantId, b.tenantId)))).toHaveLength(0);
    await expect(mobileBuilderState(employee(a))).rejects.toMatchObject({ reason: 'forbidden' });
  });
  it('refuses employees, company administrators, forged tenant writes and non-admin raw SQL', async () => {
    const companyAdmin = { ...admin, grants: [{ role: 'hr_admin', companyId: a.companyId }] };
    for (const ctx of [employee(a), companyAdmin]) {
      await expect(changeMobileDesign(ctx, 'save', 0, config('Forbidden'))).rejects.toMatchObject({ reason: 'forbidden' });
      await expect(withTenant(ctx, tx => tx.insert(schema.mobileDesignDraft).values({ tenantId: a.tenantId, config: config('Forbidden') }))).rejects.toThrow();
    }
    await expect(withTenant(admin, tx => tx.insert(schema.mobileDesignDraft).values({ tenantId: b.tenantId, config: config('Foreign') }))).rejects.toThrow();
    await expect(withTenant(admin, tx => tx.insert(schema.mobileDesignRelease).values({ tenantId: a.tenantId, revision: 1, config: config('Forged'), publishedBy: b.adminUserId }))).rejects.toThrow();
  });
  it('detects concurrent edits and preserves immutable history when restoring', async () => {
    const results = await Promise.allSettled([changeMobileDesign(admin, 'save', 0, config('First')), changeMobileDesign(admin, 'save', 0, config('Second'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const publishes = await Promise.allSettled([changeMobileDesign(admin, 'publish', 1), changeMobileDesign(admin, 'publish', 1)]);
    expect(publishes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(publishes.filter(r => r.status === 'rejected')).toHaveLength(1);
    const first = await publishedMobileDesign(admin);
    await changeMobileDesign(admin, 'save', 2, config('New look')); await changeMobileDesign(admin, 'publish', 3);
    await expect(changeMobileDesign(admin, 'rollback', 3, 1)).rejects.toMatchObject({ reason: 'conflict' });
    await changeMobileDesign(admin, 'rollback', 4, 1);
    const state = await mobileBuilderState(admin);
    expect(state.releases.map(r => r.revision)).toEqual([3, 2, 1]);
    expect(state.releases[0].config).toEqual(first.config);
    expect(state.releases[2].config).toEqual(first.config);
    expect(state.releases[1].config.brandName).toBe('New look');
    await expect(withTenant(admin, tx => tx.update(schema.mobileDesignRelease).set({ config: config('Overwritten') }).where(and(eq(schema.mobileDesignRelease.tenantId, a.tenantId), eq(schema.mobileDesignRelease.revision, 1))))).rejects.toThrow();
    const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId, a.tenantId));
    expect(events.filter(e => e.eventType === 'mobile-design.rollback')).toHaveLength(1);
  });
  it('serves only the authenticated tenant’s published config and never sends drafts or caches', async () => {
    await changeMobileDesign(admin, 'save', 0, config('Published A')); await changeMobileDesign(admin, 'publish', 1);
    await changeMobileDesign(admin, 'save', 2, config('Private unfinished draft'));
    await changeMobileDesign(groupAdmin(b), 'save', 0, config('Published B')); await changeMobileDesign(groupAdmin(b), 'publish', 1);
    resolver.mockResolvedValue(employee(a));
    const response = await GET(new Request(`https://example.test/api/mobile/v1/design?tenantId=${b.tenantId}`));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json(); expect(body.tenantId).toBe(a.tenantId); expect(body.config.brandName).toBe('Published A');
    expect(JSON.stringify(body)).not.toContain('unfinished'); expect(JSON.stringify(body)).not.toContain('Published B');
    resolver.mockRejectedValue(new AuthRequiredError());
    expect((await GET(new Request('https://example.test/api/mobile/v1/design', { headers: { cookie: 'session=not-a-bearer' } }))).status).toBe(401);
  });
});

it('publishes v2 compositions while serving an explicit v1 projection to older installed clients', async () => {
  const d = composeMobileDesign(config('Composer tenant'));
  d.composition.pages.push({ id: 'benefits', title: 'Our benefits', blocks: [] });
  await changeMobileDesign(admin, 'save', 0, d); await changeMobileDesign(admin, 'publish', 1);
  resolver.mockResolvedValue(employee(a));
  const oldClient = await GET(new Request('https://example.test/api/mobile/v1/design'));
  expect((await oldClient.json()).config).toEqual(legacyMobileDesign(d));
  const newClient = await GET(new Request('https://example.test/api/mobile/v1/design?schema=2'));
  expect((await newClient.json()).config).toEqual(d);
  expect((await GET(new Request('https://example.test/api/mobile/v1/design?schema=3'))).status).toBe(400);
  await changeMobileDesign(admin, 'save', 2, config('Legacy rollback target')); await changeMobileDesign(admin, 'publish', 3);
  await changeMobileDesign(admin, 'rollback', 4, 1);
  const state = await mobileBuilderState(admin);
  expect(state.releases.map(r => r.revision)).toEqual([3, 2, 1]);
  expect(state.releases[0].config).toEqual(d); expect(state.releases[2].config).toEqual(d);
  expect((await publishedMobileDesign(employee(b))).config).toEqual(DEFAULT_MOBILE_DESIGN);
});
