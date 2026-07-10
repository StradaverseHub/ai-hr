/**
 * System Labels UI redesign (797e3523) — the one real data change: a nullable short-code `label` on the
 * four label tables. UI-only concerns (collapsible filter, removed Head/Last-updated columns, renamed
 * headers) are not exercised here; this proves the label field round-trips through bulkSaveLabels create +
 * update + clear, surfaces in the list read path, is legacy-safe (absent ⇒ NULL, today's behaviour), and
 * still appends the existing DomainEvents.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import {
  bulkSaveLabels,
  createDepartment,
  listDepartmentsForLabels,
  listCostCentersForLabels,
} from '../core/admin';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('System Labels — short-code label field (797e3523)', () => {
  it('persists label on create and returns it from the list read path', async () => {
    const a = adminCtx(b);
    const res = await bulkSaveLabels(a, 'department', {
      creates: [{ key: 'd1', companyId: b.companyId, name: 'Engineering', label: 'ENG' }],
      updates: [],
    });
    expect(res.created).toBe(1);
    const id = res.createdIds[0].id;

    const [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, id));
    expect(row.label).toBe('ENG');

    const listed = await listDepartmentsForLabels(a);
    expect(listed.find((r) => r.id === id)?.label).toBe('ENG');
    // The create event still fires (substrate unchanged).
    expect(await eventTypesFor(b.tenantId, id)).toContain('department.created');
  });

  it('sets and clears label on update (empty ⇒ NULL)', async () => {
    const a = adminCtx(b);
    // Start with NO label — legacy behaviour: absent ⇒ NULL.
    const dep = await createDepartment(a, { companyId: b.companyId, name: 'Legal797' });
    let [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, dep.id));
    expect(row.label).toBeNull();

    // Update: give it a label.
    await bulkSaveLabels(a, 'department', {
      creates: [],
      updates: [{ key: 'u1', id: dep.id, name: 'Legal797', label: 'FIN' }],
    });
    [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, dep.id));
    expect(row.label).toBe('FIN');

    // Update again with a blank label ⇒ cleared back to NULL (matches description semantics).
    await bulkSaveLabels(a, 'department', {
      creates: [],
      updates: [{ key: 'u2', id: dep.id, name: 'Legal797', label: '   ' }],
    });
    [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, dep.id));
    expect(row.label).toBeNull();
    expect(await eventTypesFor(b.tenantId, dep.id)).toContain('department.updated');
  });

  it('label round-trips for cost centres too (all four tables carry the column)', async () => {
    const a = adminCtx(b);
    const res = await bulkSaveLabels(a, 'cost_center', {
      creates: [{ key: 'c1', companyId: b.companyId, code: 'CC100', name: 'Ops Cost', label: 'OPS' }],
      updates: [],
    });
    const id = res.createdIds[0].id;
    const listed = await listCostCentersForLabels(a);
    expect(listed.find((r) => r.id === id)?.label).toBe('OPS');
  });
});
