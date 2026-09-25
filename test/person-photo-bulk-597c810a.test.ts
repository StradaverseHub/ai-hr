/**
 * 597c810a — THE BULK PHOTO-EXISTENCE READ THE PERSONNEL LISTINGS RENDER FROM.
 *
 * The list avatar can only show a photo for people who HAVE one, and it must find out who those are
 * without asking the browser: production holds 89 persons and 2 photos, so an <img> on every row is 89
 * requests, 87 of them 404s that each cost a session read and an RLS query. `personsWithPhotos` /
 * `employmentPhotoIds` are the one query per page render that replaces that.
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
import { hireEmployee } from '../core/org';
import { employmentPhotoIds, personsWithPhotos, setPersonPhoto } from '../core/person-photo';

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

describe('personsWithPhotos — which of these people have a photo', () => {
  it('returns exactly the ids that have one, and leaves the others out', async () => {
    const withPhoto = await hire('Haspix');
    const without = await hire('Nopix');
    await givePhoto(withPhoto.personId);

    const seen = await personsWithPhotos(adminCtx(base), [withPhoto.personId, without.personId]);
    expect(seen.has(withPhoto.personId)).toBe(true);
    expect(seen.has(without.personId), 'a person with no photo must not be in the set').toBe(false);
    expect(seen.size).toBe(1);
  });

  it('an empty id list is an empty set (and never a query)', async () => {
    expect((await personsWithPhotos(adminCtx(base), [])).size).toBe(0);
  });

  it('duplicate and blank ids do not change the answer', async () => {
    const e = await hire('Dupe');
    await givePhoto(e.personId);
    const seen = await personsWithPhotos(adminCtx(base), [e.personId, e.personId, '']);
    expect([...seen]).toEqual([e.personId]);
  });

  it('SECURITY — a non-admin asking about a STRANGER who has a photo gets nothing, and about themselves gets an answer', async () => {
    const stranger = await hire('StrangerWithFace');
    const self = await hire('SelfWithFace');
    await givePhoto(stranger.personId);
    await givePhoto(self.personId);
    // Both really do have photos, read as admin. Without this the next assertion could pass vacuously.
    const asAdmin = await personsWithPhotos(adminCtx(base), [stranger.personId, self.personId]);
    expect(asAdmin.size).toBe(2);

    const s = await employeeSession(self.personId);
    const asEmployee = await personsWithPhotos(s, [stranger.personId, self.personId]);
    expect(
      asEmployee.has(stranger.personId),
      'a bulk existence read must not become a way to enumerate photos outside can_see_person',
    ).toBe(false);
    expect(asEmployee.has(self.personId), 'the fence is can_see_person, not deny-all').toBe(true);
  });

  it('cross-tenant ids are absent (tenant isolation holds through the bulk read too)', async () => {
    const mine = await hire('Mine');
    await givePhoto(mine.personId);
    const other = await seedBase();
    const seen = await personsWithPhotos(adminCtx(other), [mine.personId]);
    expect(seen.size).toBe(0);
  });
});

describe('employmentPhotoIds — the same answer keyed the way the listing holds it', () => {
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
});
