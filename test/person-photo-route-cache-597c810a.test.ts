/**
 * 597c810a — CACHING ON THE PHOTO SERVE ROUTE.
 *
 * The list now renders this URL once per person who has a photo, so the same bytes are re-fetched on every
 * page of the listing and every navigation back to it. The route set no cache headers at all, and the two
 * obvious "fixes" are both wrong in ways that matter:
 *
 *   · a PUBLIC cache header would let a shared/proxy cache hold a FACE PHOTO that is fenced by
 *     app.can_see_person, and hand one viewer's scope to another. `private` is therefore not optional.
 *   · a long `max-age` would serve a stale face after an admin replaces a photo, because the URL carries no
 *     version and no content hash — it is `/personnel/photo/<personId>` forever.
 *
 * So: revalidate every time, and make revalidating cheap with a CONTENT-derived ETag. That combination is
 * what this file pins, together with the 304 path actually working (an ETag nobody honours is a header, not
 * a saving) and the weak-tag / multi-tag forms of `If-None-Match` that a real client sends.
 *
 * ACCESS IS NOT TESTED HERE and must not be read as tested here: `getPersonPhoto` is stubbed, and the real
 * RLS fence is proved by test/person-photo.test.ts against live policies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted above the route import below, so the route gets these stubs rather than a session and a database.
const photo = vi.hoisted(() => ({
  current: null as { content: Buffer; fileName: string; mimeType: string } | null,
}));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ tenantId: 't', userId: 'u', roles: ['hr_admin'] }) }));
vi.mock('@/core/person-photo', () => ({ getPersonPhoto: async () => photo.current }));

import { GET } from '../app/personnel/photo/[personId]/route';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

const params = Promise.resolve({ personId: 'person-9' });
const get = (headers: Record<string, string> = {}) =>
  GET(new Request('http://localhost/personnel/photo/person-9', { headers }), { params });

beforeEach(() => {
  photo.current = { content: PNG, fileName: 'face.png', mimeType: 'image/png' };
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('photo serve route — cache headers', () => {
  it('serves the bytes with a PRIVATE, must-revalidate policy and an ETag', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc, 'a face photo behind can_see_person must never land in a shared cache').toContain('private');
    expect(cc).toContain('must-revalidate');
    expect(res.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });

  it('sets NO max-age — the URL carries no version, so a replaced photo would otherwise serve stale', async () => {
    const cc = (await get()).headers.get('cache-control') ?? '';
    expect(cc).not.toMatch(/max-age/);
    expect(cc).not.toContain('public');
    expect(cc).not.toContain('immutable');
  });

  it('keeps everything the route already guaranteed: inline disposition, nosniff, the stored mime, the length', async () => {
    const res = await get();
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="face.png"');
    expect(res.headers.get('x-content-type-options'), 'nosniff is what makes inline serving safe').toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String(PNG.byteLength));
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('a missing photo is still a 404 and carries no cache policy to remember it by', async () => {
    photo.current = null;
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get('etag')).toBeNull();
  });
});

describe('photo serve route — the ETag is derived from the CONTENT', () => {
  it('the same bytes give the same tag; DIFFERENT bytes give a different one', async () => {
    const a = (await get()).headers.get('etag');
    const again = (await get()).headers.get('etag');
    expect(again).toBe(a);
    photo.current = { content: JPG, fileName: 'face.jpg', mimeType: 'image/jpeg' };
    expect(
      (await get()).headers.get('etag'),
      'a replace that lands in the same clock tick still changes the bytes — which is why this is not updated_at',
    ).not.toBe(a);
  });

  it('a conditional request holding the current tag gets 304 and NO body, with the policy repeated', async () => {
    const etag = (await get()).headers.get('etag')!;
    const res = await get({ 'if-none-match': etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toContain('private');
    expect((await res.arrayBuffer()).byteLength, 'the saving IS the absent body').toBe(0);
  });

  it('a WEAK tag and a tag LIST both match — those are the forms a real client sends', async () => {
    const etag = (await get()).headers.get('etag')!;
    expect((await get({ 'if-none-match': `W/${etag}` })).status).toBe(304);
    expect((await get({ 'if-none-match': `"other", ${etag}` })).status).toBe(304);
    expect((await get({ 'if-none-match': '*' })).status).toBe(304);
  });

  it('a STALE tag gets the new bytes, not a 304 — this is what stops a replaced photo serving the old face', async () => {
    const stale = (await get()).headers.get('etag')!;
    photo.current = { content: JPG, fileName: 'face.jpg', mimeType: 'image/jpeg' };
    const res = await get({ 'if-none-match': stale });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(JPG)).toBe(true);
  });
});
