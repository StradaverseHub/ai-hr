/**
 * System Labels relocation — the org catalogs (department / position / cost_center / business_unit) moved
 * off the Organization page onto the new Settings → System Labels admin page, gaining an optional
 * `description` field (migration 0145). This suite covers, mirroring test/business-unit-master.test.ts:
 *   - description persists on create + update for all four entity types, trims, and stores null when blank;
 *   - the DomainEvent substrate carries description in the .updated payload (and .created);
 *   - RLS/authz unchanged: a company-scoped hr_admin can only WRITE its own company's rows; a non-admin
 *     employee can still READ (list) — the tenant-wide read the hire form + People filters depend on;
 *   - the redirect-target guard: every System Labels server action redirects to the System Labels path
 *     (NOT /admin/organization) on both success and validation-failure — directly guarding the copy-paste
 *     bug the plan flags (both ok()/fail() would otherwise send the admin back to the old page).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

// The server actions call getSession() + redirect(). Stub getSession to a per-test admin ctx. redirect() in
// real Next.js THROWS to abort the request, which is what makes ok()/fail() typed `never`; the mock must
// throw too, or execution falls through fail() into ok() and redirect fires twice. We throw a sentinel
// carrying the target path so the test can assert the redirect TARGET (the copy-paste guard).
let actionCtx: import('../db/client').SessionContext | null = null;
class RedirectError extends Error {
  constructor(public path: string) {
    super(`NEXT_REDIRECT:${path}`);
  }
}
const redirectSpy = vi.fn((path: string): never => {
  throw new RedirectError(path);
});
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => actionCtx) }));
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectSpy(p), notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));

/** Run a server action that ends in redirect() (which now throws RedirectError) and return the target path. */
async function captureRedirect(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectError) return e.path;
    throw e;
  }
  throw new Error('expected the action to redirect, but it did not');
}

import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { type SessionContext } from '../db/client';
import {
  createDepartment,
  updateDepartment,
  createPosition,
  updatePosition,
  createCostCenter,
  updateCostCenter,
  createBusinessUnit,
  updateBusinessUnit,
  listDepartmentsForLabels,
  listPositionsForLabels,
  listCostCentersForLabels,
  listBusinessUnitsForLabels,
} from '../core/admin';
import {
  createDepartmentAction,
  createPositionAction,
  createCostCenterAction,
  createBusinessUnitAction,
} from '../app/admin/settings/actions';
// fbdeee87: Profile Options relocated into the System Labels surface as a tab. Its five server actions now
// live under the System Labels sub-route and must redirect to the Profile Options tab (NOT the old
// standalone /admin/settings/profile-options path) — the same redirect-target guard as the org catalogs.
import {
  createProfileOptionAction,
  updateProfileOptionAction,
  setProfileOptionActiveAction,
  deleteProfileOptionAction,
  seedProfileOptionsAction,
} from '../app/admin/settings/system-labels/profile-options/actions';
import { listAllProfileOptions } from '../core/profile-options';

let b: Base;

/** A company-scoped hr_admin SessionContext (carries the grant so authz + RLS see it), as a real app role. */
async function adminFor(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

/** A non-admin (employee) SessionContext — proves the tenant-wide READ path works for non-admins. */
async function employeeCtx(): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'employee', companyId: null }] };
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  actionCtx = null;
  redirectSpy.mockClear();
});

describe('System Labels — description on the four org catalogs', () => {
  it('department: description persists on create + update, trims, stores null when blank', async () => {
    const a = adminCtx(b);
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Legal', description: '  Handles contracts  ' });
    let [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, id));
    expect(row.description).toBe('Handles contracts'); // trimmed

    await updateDepartment(a, { id, name: 'Legal', description: 'Now compliance too' });
    [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, id));
    expect(row.description).toBe('Now compliance too');

    // Blank on update clears it (description always overwrites — no tri-state).
    await updateDepartment(a, { id, name: 'Legal', description: '   ' });
    [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, id));
    expect(row.description).toBeNull();

    // Blank / omitted on create stores null.
    const { id: id2 } = await createDepartment(a, { companyId: b.companyId, name: 'Ops2' });
    const [row2] = await owner.db.select().from(schema.department).where(eq(schema.department.id, id2));
    expect(row2.description).toBeNull();
  });

  it('position: description persists on create + update, trims, stores null when blank', async () => {
    const a = adminCtx(b);
    const { id } = await createPosition(a, { companyId: b.companyId, title: 'Analyst', description: '  Junior  ' });
    let [row] = await owner.db.select().from(schema.position).where(eq(schema.position.id, id));
    expect(row.description).toBe('Junior');
    await updatePosition(a, { id, title: 'Analyst', description: 'Senior IC' });
    [row] = await owner.db.select().from(schema.position).where(eq(schema.position.id, id));
    expect(row.description).toBe('Senior IC');
    await updatePosition(a, { id, title: 'Analyst', description: '' });
    [row] = await owner.db.select().from(schema.position).where(eq(schema.position.id, id));
    expect(row.description).toBeNull();
  });

  it('cost center: description persists on create + update, trims, stores null when blank', async () => {
    const a = adminCtx(b);
    const { id } = await createCostCenter(a, { companyId: b.companyId, code: 'CX', name: 'Cx', description: '  Ad hoc  ' });
    let [row] = await owner.db.select().from(schema.costCenter).where(eq(schema.costCenter.id, id));
    expect(row.description).toBe('Ad hoc');
    await updateCostCenter(a, { id, code: 'CX', name: 'Cx', description: 'Marketing spend' });
    [row] = await owner.db.select().from(schema.costCenter).where(eq(schema.costCenter.id, id));
    expect(row.description).toBe('Marketing spend');
    await updateCostCenter(a, { id, code: 'CX', name: 'Cx' });
    [row] = await owner.db.select().from(schema.costCenter).where(eq(schema.costCenter.id, id));
    expect(row.description).toBeNull();
  });

  it('business unit: description persists on create + update, trims, stores null when blank', async () => {
    const a = adminCtx(b);
    const { id } = await createBusinessUnit(a, { companyId: b.companyId, code: 'BX', name: 'Bx', description: '  Retail arm  ' });
    let [row] = await owner.db.select().from(schema.businessUnit).where(eq(schema.businessUnit.id, id));
    expect(row.description).toBe('Retail arm');
    await updateBusinessUnit(a, { id, code: 'BX', name: 'Bx', description: 'Wholesale arm' });
    [row] = await owner.db.select().from(schema.businessUnit).where(eq(schema.businessUnit.id, id));
    expect(row.description).toBe('Wholesale arm');
    await updateBusinessUnit(a, { id, code: 'BX', name: 'Bx', description: '' });
    [row] = await owner.db.select().from(schema.businessUnit).where(eq(schema.businessUnit.id, id));
    expect(row.description).toBeNull();
  });

  it('the System-Labels read queries surface description; the general-purpose lists are untouched', async () => {
    const a = adminCtx(b);
    await createDepartment(a, { companyId: b.companyId, name: 'Support', description: 'Tickets' });
    await createPosition(a, { companyId: b.companyId, title: 'Rep', description: 'Front line' });
    await createCostCenter(a, { companyId: b.companyId, code: 'SP', name: 'Support', description: 'Cost of care' });
    await createBusinessUnit(a, { companyId: b.companyId, code: 'SB', name: 'ServiceBU', description: 'Services' });

    const deps = await listDepartmentsForLabels(a, { companyIds: [b.companyId] });
    expect(deps.find((d) => d.name === 'Support')?.description).toBe('Tickets');
    const pos = await listPositionsForLabels(a, { companyIds: [b.companyId] });
    expect(pos.find((p) => p.title === 'Rep')?.description).toBe('Front line');
    const ccs = await listCostCentersForLabels(a, { companyIds: [b.companyId] });
    expect(ccs.find((c) => c.code === 'SP')?.description).toBe('Cost of care');
    const bus = await listBusinessUnitsForLabels(a, { companyIds: [b.companyId] });
    expect(bus.find((x) => x.code === 'SB')?.description).toBe('Services');
  });
});

describe('System Labels — DomainEvent substrate carries description', () => {
  it('.created and .updated events include description in the payload for all four entities', async () => {
    const a = adminCtx(b);
    const { id: dep } = await createDepartment(a, { companyId: b.companyId, name: 'D', description: 'dep-note' });
    await updateDepartment(a, { id: dep, name: 'D', description: 'dep-note-2' });
    const depUpd = await latestEventPayload(b.tenantId, dep, 'department.updated');
    expect(depUpd?.description).toBe('dep-note-2');

    const { id: pos } = await createPosition(a, { companyId: b.companyId, title: 'P', description: 'pos-note' });
    await updatePosition(a, { id: pos, title: 'P', description: 'pos-note-2' });
    expect((await latestEventPayload(b.tenantId, pos, 'position.updated'))?.description).toBe('pos-note-2');

    const { id: cc } = await createCostCenter(a, { companyId: b.companyId, code: 'C', name: 'C', description: 'cc-note' });
    await updateCostCenter(a, { id: cc, code: 'C', name: 'C', description: 'cc-note-2' });
    expect((await latestEventPayload(b.tenantId, cc, 'cost-center.updated'))?.description).toBe('cc-note-2');

    const { id: bu } = await createBusinessUnit(a, { companyId: b.companyId, code: 'B', name: 'B', description: 'bu-note' });
    await updateBusinessUnit(a, { id: bu, code: 'B', name: 'B', description: 'bu-note-2' });
    expect((await latestEventPayload(b.tenantId, bu, 'business-unit.updated'))?.description).toBe('bu-note-2');

    // Substrate coverage sanity: created events also fired.
    const types = await eventTypesFor(b.tenantId, dep);
    expect(types).toEqual(expect.arrayContaining(['department.created', 'department.updated']));
  });
});

describe('System Labels — RLS/authz unchanged after the move', () => {
  it('read is tenant-wide (a non-admin employee lists), write is admin-for-company only', async () => {
    const a = adminCtx(b);
    const { id: dep } = await createDepartment(a, { companyId: b.companyId, name: 'Guarded', description: 'x' });

    // Tenant-wide read: a plain employee can SEE the department via the System-Labels read query.
    const emp = await employeeCtx();
    const seen = await listDepartmentsForLabels(emp, { companyIds: [b.companyId] });
    expect(seen.map((d) => d.id)).toContain(dep);

    // Write scoping: an admin scoped to ANOTHER company cannot update company A's department — the
    // is_admin_for WITH CHECK blocks it (row is visible via tenant-wide read, but the write is a no-op).
    const [coB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'SL Co B Sdn Bhd', country: 'MY', currency: 'MYR' })
      .returning({ id: schema.company.id });
    const adminB = await adminFor(coB.id);
    await updateDepartment(adminB, { id: dep, name: 'Hacked', description: 'nope' }).catch(() => {});
    const [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, dep));
    expect(row.name).toBe('Guarded');
    expect(row.description).toBe('x');
  });
});

describe('System Labels — server actions redirect to the System Labels path (redirect-target guard)', () => {
  it('a successful create redirects to /admin/settings/system-labels, NOT /admin/organization', async () => {
    actionCtx = adminCtx(b);
    const fd = new FormData();
    fd.set('companyId', b.companyId);
    fd.set('name', 'ActionDept');
    fd.set('description', 'via action');
    const target = await captureRedirect(() => createDepartmentAction(fd));
    expect(target).toBe('/admin/settings/system-labels');
    expect(target).not.toContain('/admin/organization');

    // The description reached the DB through the action's FormData mapping.
    const rows = await listDepartmentsForLabels(actionCtx, { companyIds: [b.companyId] });
    expect(rows.find((d) => d.name === 'ActionDept')?.description).toBe('via action');
  });

  it('a validation failure redirects to the System Labels path with an error, NOT /admin/organization', async () => {
    actionCtx = adminCtx(b);
    const fd = new FormData();
    fd.set('companyId', b.companyId);
    fd.set('name', '   '); // blank name → createDepartment throws "Department name is required"
    const target = await captureRedirect(() => createDepartmentAction(fd));
    expect(target.startsWith('/admin/settings/system-labels?error=')).toBe(true);
    expect(target).not.toContain('/admin/organization');
  });

  it('each catalog action (position, cost center, business unit) redirects to System Labels on success', async () => {
    for (const setup of [
      (fd: FormData) => {
        fd.set('companyId', b.companyId);
        fd.set('title', `T${randomUUID().slice(0, 6)}`);
        return createPositionAction(fd);
      },
      (fd: FormData) => {
        fd.set('companyId', b.companyId);
        fd.set('code', `C${randomUUID().slice(0, 4)}`);
        fd.set('name', 'Cc');
        return createCostCenterAction(fd);
      },
      (fd: FormData) => {
        fd.set('companyId', b.companyId);
        fd.set('code', `B${randomUUID().slice(0, 4)}`);
        fd.set('name', 'Bu');
        return createBusinessUnitAction(fd);
      },
    ]) {
      actionCtx = adminCtx(b);
      const target = await captureRedirect(() => setup(new FormData()));
      expect(target).toBe('/admin/settings/system-labels');
    }
  });
});

describe('Profile Options — relocated actions redirect to the System Labels tab (fbdeee87)', () => {
  const PO_TAB = '/admin/settings/system-labels/profile-options';
  const OLD = '/admin/settings/profile-options';

  it('create redirects to the Profile Options tab on success, NOT the old standalone path', async () => {
    actionCtx = adminCtx(b);
    const fd = new FormData();
    fd.set('category', 'religion');
    fd.set('value', 'Buddhism');
    fd.set('label', 'Buddhist');
    const target = await captureRedirect(() => createProfileOptionAction(fd));
    expect(target.startsWith(`${PO_TAB}?`)).toBe(true);
    expect(target).not.toBe(OLD);
    expect(target.startsWith(`${OLD}?`)).toBe(false);

    // The option actually persisted through the relocated action → core path (data model unchanged).
    const all = await listAllProfileOptions(actionCtx, { activeOnly: false });
    expect(all.religion.find((o) => o.value === 'Buddhism')?.label).toBe('Buddhist');
  });

  it('a create validation failure redirects to the Profile Options tab with an error, NOT the old path', async () => {
    actionCtx = adminCtx(b);
    const fd = new FormData();
    fd.set('category', 'religion');
    fd.set('value', '   '); // blank value → createProfileOption throws
    const target = await captureRedirect(() => createProfileOptionAction(fd));
    expect(target.startsWith(`${PO_TAB}?error=`)).toBe(true);
    expect(target.startsWith(OLD)).toBe(false);
  });

  it('update / activate / delete / seed all redirect to the Profile Options tab', async () => {
    // Seed the default catalog, then exercise update/activate/delete against a real row.
    actionCtx = adminCtx(b);
    expect((await captureRedirect(() => seedProfileOptionsAction())).startsWith(`${PO_TAB}?`)).toBe(true);

    const all = await listAllProfileOptions(adminCtx(b), { activeOnly: false });
    const row = all.religion[0];
    expect(row).toBeTruthy();

    actionCtx = adminCtx(b);
    const upd = new FormData();
    upd.set('id', row.id);
    upd.set('label', 'Renamed');
    upd.set('sortOrder', '3');
    expect((await captureRedirect(() => updateProfileOptionAction(upd))).startsWith(`${PO_TAB}?`)).toBe(true);

    actionCtx = adminCtx(b);
    const act = new FormData();
    act.set('id', row.id);
    act.set('isActive', 'false');
    expect((await captureRedirect(() => setProfileOptionActiveAction(act))).startsWith(`${PO_TAB}?`)).toBe(true);

    actionCtx = adminCtx(b);
    const del = new FormData();
    del.set('id', row.id);
    expect((await captureRedirect(() => deleteProfileOptionAction(del))).startsWith(`${PO_TAB}?`)).toBe(true);
  });
});
