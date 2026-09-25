/**
 * 597c810a — THE BULK PHOTO-EXISTENCE READ THE PERSONNEL LISTINGS RENDER FROM.
 *
 * The list avatar can only show a photo for people who HAVE one, and it must find out who those are
 * without asking the browser: production holds 89 persons and 2 photos, so an <img> on every row is 89
 * requests, 87 of them 404s that each cost a session read and an RLS query. `employmentPhotoIds` is the one
 * query per page render that replaces that.
 *
 * r340 fix pass — every case below now drives `employmentPhotoIds`, the function the two listings actually
 * call. They used to be split across it and `personsWithPhotos`, a person-keyed twin that shipped with no
 * caller anywhere in app/, components/ or lib/: the scope cases lived on the DEAD function while the live one
 * carried only the non-admin case. The twin is gone and its cases are here.
 *
 * WHAT THIS FILE IS REALLY GUARDING IS NOT THE COUNT, IT IS THE SCOPE. A bulk existence read is exactly
 * the shape that turns into an oracle: hand it a list of ids and it tells you which ones exist. If it
 * answered outside app.can_see_person, a non-admin could enumerate who has a face photo on file — people
 * whose names they cannot even see. So the load-bearing cases here are the negative ones:
 *   · a non-admin employee asking about a stranger who HAS a photo gets nothing back, and that answer is
 *     indistinguishable from "that person has no photo";
 *   · the same call for THEMSELVES does come back, so the fence is can_see_person and not "deny all";
 *   · another tenant's person is absent.
 * The predicate is RLS's, not a filter in the function — which is why the test drives it through real
 * sessions against real policies rather than asserting on a WHERE clause.
 *
 * test/person-photo.test.ts already proves storage, the mime/size rules, the events and the single-person
 * read scope. Nothing here re-proves those.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hireEmployee } from '../core/org';
import { employmentPhotoIds, setPersonPhoto } from '../core/person-photo';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let base: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

const givePhoto = (personId: string) =>
  setPersonPhoto(adminCtx(base), {
    personId,
    content: PNG,
    fileName: 'face.png',
    mimeType: 'image/png',
    sizeBytes: PNG.byteLength,
  });

/** A plain employee session for `personId` — no admin role, so can_see_person narrows to themselves. */
async function employeeSession(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(base.tenantId, personId, 'employee');
  return { tenantId: base.tenantId, userId, personId, roles: ['employee'] };
}

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

describe('employmentPhotoIds — which of these rows may show a photo, in one query', () => {
  it('maps employmentId → personId for the employments whose person has a photo, and omits the rest', async () => {
    const withPhoto = await hire('RowWithFace');
    const without = await hire('RowNoFace');
    await givePhoto(withPhoto.personId);

    const map = await employmentPhotoIds(adminCtx(base), [withPhoto.employmentId, without.employmentId]);
    expect(map.get(withPhoto.employmentId)).toBe(withPhoto.personId);
    expect(
      map.has(without.employmentId),
      'an employment whose person has no photo must not appear — that is what keeps the row on initials',
    ).toBe(false);
    expect(map.size).toBe(1);
  });

  it('empty in, empty out', async () => {
    expect((await employmentPhotoIds(adminCtx(base), [])).size).toBe(0);
  });

  it('SECURITY — a non-admin gets their OWN employment and not a stranger who has a photo', async () => {
    const stranger = await hire('StrangerRow');
    const self = await hire('SelfRow');
    await givePhoto(stranger.personId);
    await givePhoto(self.personId);
    expect((await employmentPhotoIds(adminCtx(base), [stranger.employmentId, self.employmentId])).size).toBe(2);

    const s = await employeeSession(self.personId);
    const map = await employmentPhotoIds(s, [stranger.employmentId, self.employmentId]);
    expect(map.has(stranger.employmentId)).toBe(false);
    expect(map.get(self.employmentId)).toBe(self.personId);
  });

  // ── The two cases that used to guard the person-keyed twin, rehomed onto the live function ─────────
  it('duplicate and blank ids do not change the answer', async () => {
    const e = await hire('Dupe');
    await givePhoto(e.personId);
    const map = await employmentPhotoIds(adminCtx(base), [e.employmentId, e.employmentId, '']);
    expect([...map.entries()]).toEqual([[e.employmentId, e.personId]]);
  });

  it('cross-tenant ids are absent (tenant isolation holds through the bulk read too)', async () => {
    const mine = await hire('Mine');
    await givePhoto(mine.personId);
    // Read as the ADMIN OF ANOTHER TENANT, asking about an employment that really does have a photo — so
    // the assertion cannot pass because the photo is missing.
    expect((await employmentPhotoIds(adminCtx(base), [mine.employmentId])).size).toBe(1);
    const other = await seedBase();
    const seen = await employmentPhotoIds(adminCtx(other), [mine.employmentId]);
    expect(seen.size).toBe(0);
  });
});

/**
 * r340 fix pass — A DOCBLOCK THAT NAMES A TEST FILE MUST NAME ONE THAT EXISTS.
 *
 * core/person-photo.ts said "Pinned by test/person-photo-bulk.test.ts" and no such file was ever written
 * (this one is `-597c810a`). A dead pointer is worse than none: the next reader follows it, finds nothing,
 * and concludes the claim is unpinned. Cheap to check, so it is checked.
 */
describe('the module\'s own pointers resolve', () => {
  it('every test file core/person-photo.ts names actually exists', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const src = readFileSync(`${root}core/person-photo.ts`, 'utf8');
    const named = [...src.matchAll(/test\/[\w.-]+\.test\.tsx?/g)].map((m) => m[0]);
    expect(named.length, 'the module cites its own guards; if it stopped, drop this assertion deliberately').toBeGreaterThan(0);
    for (const rel of named) {
      expect(existsSync(`${root}${rel}`), `core/person-photo.ts points at ${rel}, which does not exist`).toBe(true);
    }
  });
});
