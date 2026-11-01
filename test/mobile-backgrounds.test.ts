import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { mobileDesignAsset, domainEvent } from '../db/schema';
import { normalizeMobileBackground, uploadMobileBackground, readMobileBackground } from '../core/mobile-backgrounds';
import { changeMobileDesign, mobileBuilderState, publishedMobileDesign } from '../core/mobile-design';
import { composeMobileDesign, DEFAULT_MOBILE_DESIGN, mobileArtworkValid } from '../lib/mobile-design';
import { MobileDesignResponse } from '../lib/mobile-api/contract';
import { AuthRequiredError } from '../lib/auth-errors';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
const resolver = vi.hoisted(() => vi.fn());
vi.mock('../lib/session', () => ({ getMobileSession: resolver, getSession: resolver }));
import { uploadMobileBackgroundAction } from '../app/mobile-preview/actions';
import { GET as designGET } from '../app/api/mobile/v1/design/route';
import { GET as artworkGET } from '../app/mobile-preview/artwork/[id]/route';

let a: Base, b: Base;
const admin = (base: Base): SessionContext => ({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] });
const employee = (base: Base): SessionContext => ({ ...adminCtx(base), roles: ['employee'], grants: [{ role: 'employee', companyId: base.companyId }] });
const photo = (color = '#183b4c') => sharp({ create: { width: 64, height: 96, channels: 3, background: color } }).png().toBuffer();
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); a = await seedBase(); b = await seedBase(); resolver.mockReset(); });
afterAll(closeAll);

describe('customer mobile artwork — real codecs, publisher, bearer boundary and RLS', () => {
  it('normalizes supported artwork, strips metadata and refuses executable, corrupt and oversized uploads', async () => {
    const source = await sharp(await photo()).withExif({ IFD0: { Artist: 'Synthetic private metadata' } }).jpeg().toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const normalized = await normalizeMobileBackground(source);
    const decoded = Buffer.from(normalized.slice('data:image/jpeg;base64,'.length), 'base64');
    const metadata = await sharp(decoded).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 720, height: 1280 });
    expect(metadata.exif).toBeUndefined(); expect(metadata.xmp).toBeUndefined(); expect(metadata.icc).toBeUndefined();
    expect(decoded.length).toBeLessThanOrEqual(240000);
    expect(mobileArtworkValid({ light: normalized, dark: null })).toBe(true);
    for (const bytes of [Buffer.from('<svg onload="alert(1)"></svg>'), Buffer.from([255,216,255,217]), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
      await expect(uploadMobileBackground(admin(a), bytes)).rejects.toMatchObject({ reason: 'backgroundInvalid' });
    }
    expect(await withTenant(admin(a), tx => tx.select().from(mobileDesignAsset))).toHaveLength(0);
  });
  it('binds upload actions to verified identity, ignoring a forged customer id in the form', async () => {
    const form = new FormData(); form.set('file', new File([new Uint8Array(await photo())], 'synthetic.png', { type: 'image/png' }));
    form.set('tenantId', b.tenantId); form.set('uploadedBy', b.adminUserId);
    resolver.mockResolvedValue(employee(a));
    expect(await uploadMobileBackgroundAction(form)).toMatchObject({ ok: false, error: 'forbidden' });
    resolver.mockResolvedValue(admin(a));
    const result = await uploadMobileBackgroundAction(form);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected an authorized synthetic upload');
    expect(await readMobileBackground(admin(a), result.asset.id)).not.toBeNull();
    expect(await readMobileBackground(admin(b), result.asset.id)).toBeNull();
  });
  it('checks authority before decoding, deduplicates within one customer and keeps drafts private', async () => {
    const companyAdmin = { ...admin(a), grants: [{ role: 'hr_admin', companyId: a.companyId }] };
    for (const ctx of [employee(a), companyAdmin]) await expect(uploadMobileBackground(ctx, Buffer.from('invalid'))).rejects.toMatchObject({ reason: 'forbidden' });
    const source = await photo(), asset = await uploadMobileBackground(admin(a), source);
    expect(await uploadMobileBackground(admin(a), source)).toEqual(asset);
    expect(await readMobileBackground(admin(a), asset.id)).not.toBeNull();
    expect(await readMobileBackground(employee(a), asset.id)).toBeNull();
    expect(await readMobileBackground(admin(b), asset.id)).toBeNull();
    expect(await readMobileBackground(employee(b), asset.id)).toBeNull();
    const content = (await readMobileBackground(admin(a), asset.id))!;
    for (const [ctx, tenantId, uploadedBy] of [[employee(a), a.tenantId, a.adminUserId], [admin(a), b.tenantId, a.adminUserId], [admin(a), a.tenantId, b.adminUserId]] as const) {
      await expect(withTenant(ctx, tx => tx.insert(mobileDesignAsset).values({ tenantId, uploadedBy, content, sha256: 'f'.repeat(64), sizeBytes: content.length }))).rejects.toThrow();
    }
    const events = await owner.db.select().from(domainEvent).where(and(eq(domainEvent.tenantId, a.tenantId), eq(domainEvent.eventType, 'mobile-design.asset-uploaded')));
    expect(events).toHaveLength(1); expect(JSON.stringify(events[0].payload)).not.toContain('base64');
  });
  it('publishes only owned asset references and delivers bytes only to capable clients in that customer', async () => {
    const asset = await uploadMobileBackground(admin(a), await photo());
    const foreign = await uploadMobileBackground(admin(b), await photo('#abcdef'));
    const config = composeMobileDesign(DEFAULT_MOBILE_DESIGN);
    config.backgrounds = { dark: foreign.id, light: null };
    await expect(changeMobileDesign(admin(a), 'save', 0, config)).rejects.toMatchObject({ reason: 'invalid_design' });
    config.backgrounds = { dark: asset.id, light: null };
    await changeMobileDesign(admin(a), 'save', 0, config);
    expect((await publishedMobileDesign(employee(a), true)).artwork).toBeUndefined();
    await changeMobileDesign(admin(a), 'publish', 1);
    resolver.mockResolvedValue(employee(a));
    const response = await designGET(new Request(`https://example.test/api/mobile/v1/design?schema=2&artwork=1&tenantId=${b.tenantId}`));
    const body = await response.json();
    expect(MobileDesignResponse.safeParse(body).success).toBe(true);
    expect(body.tenantId).toBe(a.tenantId); expect(body.config.backgrounds).toEqual({ dark: asset.id, light: null });
    expect(body.artwork.light).toBeNull(); expect(body.artwork.dark).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(body.artwork.dark.split(',')[1], 'base64')).toEqual(await readMobileBackground(employee(a), asset.id));
    for (const query of ['', '?schema=2']) {
      const old = await designGET(new Request('https://example.test/api/mobile/v1/design' + query));
      const projected = await old.json(); expect(projected.config.backgrounds).toBeUndefined(); expect(projected.artwork).toBeUndefined();
    }
    expect((await designGET(new Request('https://example.test/api/mobile/v1/design?schema=2&artwork=0'))).status).toBe(400);
    resolver.mockResolvedValue(employee(b));
    const other = await designGET(new Request('https://example.test/api/mobile/v1/design?schema=2&artwork=1'));
    expect((await other.json()).artwork).toBeUndefined();
    expect(await readMobileBackground(employee(b), asset.id)).toBeNull();
  });
  it('serves protected previews with safe headers and denies anonymous, draft and cross-customer reads', async () => {
    const asset = await uploadMobileBackground(admin(a), await photo());
    const request = () => artworkGET(new Request('https://example.test/mobile-preview/artwork/' + asset.id), { params: Promise.resolve({ id: asset.id }) });
    resolver.mockRejectedValueOnce(new AuthRequiredError()); expect((await request()).status).toBe(401);
    resolver.mockResolvedValue(employee(a)); expect((await request()).status).toBe(404);
    resolver.mockResolvedValue(admin(b)); expect((await request()).status).toBe(404);
    resolver.mockResolvedValue(admin(a)); const response = await request();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readMobileBackground(admin(a), asset.id));
  });
  it('preserves published artwork and revision history on rollback without rewriting assets', async () => {
    const asset = await uploadMobileBackground(admin(a), await photo());
    const config = composeMobileDesign(DEFAULT_MOBILE_DESIGN); config.backgrounds = { light: null, dark: asset.id };
    await changeMobileDesign(admin(a), 'save', 0, config); await changeMobileDesign(admin(a), 'publish', 1);
    await changeMobileDesign(admin(a), 'save', 2, composeMobileDesign(DEFAULT_MOBILE_DESIGN)); await changeMobileDesign(admin(a), 'publish', 3);
    await changeMobileDesign(admin(a), 'rollback', 4, 1);
    const state = await mobileBuilderState(admin(a));
    expect(state.releases.map(r => r.revision)).toEqual([3,2,1]);
    expect(state.releases[0].config).toEqual(state.releases[2].config);
    expect((await publishedMobileDesign(employee(a), true)).artwork?.dark).toMatch(/^data:image\/jpeg;base64,/);
    await expect(withTenant(admin(a), tx => tx.update(mobileDesignAsset).set({ sha256: '0'.repeat(64) }).where(eq(mobileDesignAsset.id, asset.id)))).rejects.toThrow();
    await expect(withTenant(admin(a), tx => tx.delete(mobileDesignAsset).where(eq(mobileDesignAsset.id, asset.id)))).rejects.toThrow();
  });
});
