/**
 * b4682879 — employee profile photo in the person_photo bytea SIDE TABLE. Mirrors company-logo but with a
 * NARROWER read: person_photo_rls read = app.can_see_person(person_id), so a face photo is visible exactly
 * where the employee's name already is (self / admin), NOT tenant-wide. Pins:
 *  - set stores content+mime+size and appends person.photo.set (no bytes / no raw fileName in the payload);
 *  - upsert on person_id (replace, not duplicate);
 *  - read: admin sees; the subject sees their own; an UNRELATED same-tenant employee does NOT;
 *  - write is admin-only (a non-admin self session is rejected by the WITH CHECK gate);
 *  - mime/size fail-closed; remove deletes + appends person.photo.removed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee } from '../core/org';
import { getPersonPhoto, hasPersonPhoto, removePersonPhoto, setPersonPhoto } from '../core/person-photo';
import { randomUUID } from 'node:crypto';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function hire(name: string) {
  return hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

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

describe('person photo — storage, events, and can_see_person read scope', () => {
  it('setPersonPhoto stores content+mime+size and appends person.photo.set (no bytes / no fileName in payload)', async () => {
    const E = await hire('Photog');
    await setPersonPhoto(adminCtx(base), {
      personId: E.personId,
      content: PNG,
      fileName: 'face.png',
      mimeType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    const stored = await getPersonPhoto(adminCtx(base), E.personId);
    expect(stored).not.toBeNull();
    expect(stored!.mimeType).toBe('image/png');
    expect(Buffer.from(stored!.content).equals(PNG)).toBe(true);
    expect(await hasPersonPhoto(adminCtx(base), E.personId)).toBe(true);

    expect(await eventTypesFor(base.tenantId, E.personId)).toContain('person.photo.set');
    const payload = await latestEventPayload(base.tenantId, E.personId, 'person.photo.set');
    expect(payload).toEqual({ mimeType: 'image/png', sizeBytes: PNG.byteLength });
    expect(payload).not.toHaveProperty('content');
    expect(payload).not.toHaveProperty('fileName');
  });

  it('upserts on person_id (a second set REPLACES, not duplicates)', async () => {
    const E = await hire('Replacer');
    const a = adminCtx(base);
    await setPersonPhoto(a, { personId: E.personId, content: PNG, fileName: 'v1.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    await setPersonPhoto(a, { personId: E.personId, content: JPG, fileName: 'v2.jpg', mimeType: 'image/jpeg', sizeBytes: JPG.byteLength });
    const rows = await withTenant(a, (tx) =>
      tx.select().from(schema.personPhoto).where(eq(schema.personPhoto.personId, E.personId)),
    );
    expect(rows.length).toBe(1);
    expect((await getPersonPhoto(a, E.personId))!.mimeType).toBe('image/jpeg');
  });

  it('read scope: admin sees; the SUBJECT sees their own; an UNRELATED employee does NOT', async () => {
    const Subject = await hire('Subject');
    const Stranger = await hire('Stranger');
    await setPersonPhoto(adminCtx(base), { personId: Subject.personId, content: PNG, fileName: 'face.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });

    const uSub = await createAppUser(base.tenantId, Subject.personId, 'employee');
    const subCtx: SessionContext = { tenantId: base.tenantId, userId: uSub, personId: Subject.personId, roles: ['employee'] };
    const uStr = await createAppUser(base.tenantId, Stranger.personId, 'employee');
    const strCtx: SessionContext = { tenantId: base.tenantId, userId: uStr, personId: Stranger.personId, roles: ['employee'] };

    expect(await getPersonPhoto(adminCtx(base), Subject.personId)).not.toBeNull();
    expect(await getPersonPhoto(subCtx, Subject.personId)).not.toBeNull(); // self sees own
    expect(await getPersonPhoto(strCtx, Subject.personId)).toBeNull(); // unrelated employee cannot
  });

  it('cross-tenant read is NULL (tenant isolation holds)', async () => {
    const E = await hire('Isolated');
    await setPersonPhoto(adminCtx(base), { personId: E.personId, content: PNG, fileName: 'face.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    const other = await seedBase();
    expect(await getPersonPhoto(adminCtx(other), E.personId)).toBeNull();
  });

  it('write from a NON-ADMIN session (even the subject) is rejected by the WITH CHECK gate', async () => {
    const E = await hire('SelfUploader');
    const uid = await createAppUser(base.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uid, personId: E.personId, roles: ['employee'] };
    await expect(
      setPersonPhoto(empCtx, { personId: E.personId, content: PNG, fileName: 'x.png', mimeType: 'image/png', sizeBytes: PNG.byteLength }),
    ).rejects.toThrow();
    expect(await getPersonPhoto(adminCtx(base), E.personId)).toBeNull();
  });

  it('oversized (>2MB) / non-image / empty all throw fail-closed', async () => {
    const E = await hire('Guarded');
    const a = adminCtx(base);
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    await expect(
      setPersonPhoto(a, { personId: E.personId, content: big, fileName: 'big.png', mimeType: 'image/png', sizeBytes: big.byteLength }),
    ).rejects.toThrow(/2 MB/);
    await expect(
      setPersonPhoto(a, { personId: E.personId, content: PNG, fileName: 'doc.pdf', mimeType: 'application/pdf', sizeBytes: PNG.byteLength }),
    ).rejects.toThrow(/PNG or JPG/);
    await expect(
      setPersonPhoto(a, { personId: E.personId, content: Buffer.alloc(0), fileName: 'empty.png', mimeType: 'image/png', sizeBytes: 0 }),
    ).rejects.toThrow(/Empty/);
  });

  it('removePersonPhoto deletes the row and appends person.photo.removed', async () => {
    const E = await hire('Remover');
    const a = adminCtx(base);
    await setPersonPhoto(a, { personId: E.personId, content: PNG, fileName: 'face.png', mimeType: 'image/png', sizeBytes: PNG.byteLength });
    expect(await getPersonPhoto(a, E.personId)).not.toBeNull();
    await removePersonPhoto(a, { personId: E.personId });
    expect(await getPersonPhoto(a, E.personId)).toBeNull();
    expect(await hasPersonPhoto(a, E.personId)).toBe(false);
    expect(await eventTypesFor(base.tenantId, E.personId)).toContain('person.photo.removed');
  });
});
