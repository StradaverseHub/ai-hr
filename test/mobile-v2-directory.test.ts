/**
 * The staff directory in the app (GET /api/mobile/v2/directory) through the REAL route handler, core and RLS. Only
 * bearer session resolution is injected (as test/mobile-v2-attendance.test.ts does).
 *
 * Pinned: a company-scoped HR viewer sees exactly the active employments of their company, by name, with the fields
 * the web directory shows them (name, position, department, company, email from the list, phone from the profile
 * page) and nothing else (no employee ID, no lifecycle date); another company of the tenant and another tenant are
 * absent; terminated staff are excluded; `q` filters (trimmed) as the web search does; offset paging and `total`;
 * an ordinary employee gets exactly what the web's own read gives them under RLS; malformed paging/search is a 400;
 * a revoked session is a 401.
 *
 * `enabled:false` is not reachable today: the web gates nothing for the `people` screen (lib/permissions.ts
 * rolesForGuard('scopedSession') is every role), so the directory answers `enabled:true` to every caller — pinned.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, terminateEmployment } from '../core/org';
import { allowedCompanies, listEmployeesPage } from '../core/read';
import { AuthRequiredError } from '../lib/auth-errors';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const directory = await import('../app/api/mobile/v2/directory/route');

const URL_BASE = 'https://hr.example.com/api/mobile/v2/directory';
const KEYS = ['company', 'department', 'email', 'employmentId', 'name', 'phone', 'position'];
let base: Base;
const get = async (query = '') => {
  const r = await directory.GET(new Request(URL_BASE + query));
  return { status: r.status, body: await r.json() };
};

type Hired = Awaited<ReturnType<typeof hireEmployee>> & { email: string };
async function hire(name: string, o: { b?: Base; companyId?: string; departmentId?: string; phone?: string; positionId?: string } = {}): Promise<Hired> {
  const b = o.b ?? base, email = `${name.split(' ')[0].toLowerCase()}.${randomUUID().slice(0, 8)}@dir.test`;
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: email, ...(o.phone ? { phone: o.phone } : {}) },
    companyId: o.companyId ?? b.companyId, departmentId: o.departmentId ?? b.deptA, ...(o.positionId ? { positionId: o.positionId } : {}),
    employmentType: 'full_time', hiredOn: '2024-01-01',
  });
  return { ...e, email };
}
/** A real login for `who`, with `role` granted on `companyId` (null = tenant-wide), as the session would carry it. */
async function login(who: Hired, role: 'employee' | 'hr_admin', companyId: string | null, b: Base = base): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, who.personId, 'employee');
  if (role !== 'employee') await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: userId, companyId, role });
  return { tenantId: b.tenantId, userId, personId: who.personId, roles: [role], grants: [{ role, companyId: companyId ?? b.companyId }], entitlements: harnessSnapshot(b.tenantId) };
}
const names = (body: { items: { name: string }[] }) => body.items.map((i) => i.name);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); base = await seedBase(); blocked = false; });

describe('staff directory', () => {
  it('shows a company-scoped viewer the active staff of their company, by name, with directory fields only', async () => {
    const [second] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Second Sdn Bhd' }).returning({ id: schema.company.id });
    const [logistics] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: second.id, name: 'Logistics' }).returning({ id: schema.department.id });
    const alice = await hire('Alice Able', { phone: '+60 12-345 6789', positionId: base.positionId });
    const bob = await hire('Bob Baker', { departmentId: base.deptB });
    const charlie = await hire('Charlie Chan', { phone: '+60 13-000 1111' });
    const hr = await hire('Hana Hr');
    const terry = await hire('Terry Terminated');
    await terminateEmployment(adminCtx(base), { employmentId: terry.employmentId, terminationDate: '2025-12-31' });
    const brenda = await hire('Brenda Beyond', { companyId: second.id, departmentId: logistics.id });
    const otherTenant = await seedBase();
    const otto = await hire('Otto Other', { b: otherTenant });

    caller = await login(hr, 'hr_admin', base.companyId);
    // Independent expectation: every active employment of the first company of this tenant (fixture rows included).
    const expected = await owner.db.select({ id: schema.employment.id }).from(schema.employment)
      .where(and(eq(schema.employment.tenantId, base.tenantId), eq(schema.employment.companyId, base.companyId), isNull(schema.employment.terminatedOn)));
    expect(expected.length).toBeGreaterThanOrEqual(4);

    const all = await get('?limit=50');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ enabled: true, total: expected.length, offset: 0, limit: 50 });
    expect(new Set(all.body.items.map((i: { employmentId: string }) => i.employmentId))).toEqual(new Set(expected.map((r) => r.id)));
    for (const absent of [terry, brenda, otto]) expect(all.body.items.map((i: { employmentId: string }) => i.employmentId)).not.toContain(absent.employmentId);
    // Name ascending, as the web list orders it.
    const mine = names(all.body).filter((n) => ['Alice Able', 'Bob Baker', 'Charlie Chan', 'Hana Hr'].includes(n));
    expect(mine).toEqual(['Alice Able', 'Bob Baker', 'Charlie Chan', 'Hana Hr']);

    const [position] = await owner.db.select().from(schema.position).where(eq(schema.position.id, base.positionId));
    const byId = (id: string) => all.body.items.find((i: { employmentId: string }) => i.employmentId === id);
    expect(byId(alice.employmentId)).toEqual({ employmentId: alice.employmentId, name: 'Alice Able', position: position.title, department: 'Finance', company: 'Acme Sdn Bhd', email: alice.email, phone: '+60 12-345 6789' });
    expect(byId(bob.employmentId)).toMatchObject({ department: 'Operations', position: null, phone: null, email: bob.email });
    expect(byId(charlie.employmentId)).toMatchObject({ phone: '+60 13-000 1111' });
    for (const item of all.body.items) expect(Object.keys(item).sort()).toEqual(KEYS);
    // No employee ID travels, although the listing row carries one.
    const codes = (await owner.db.select({ code: schema.employment.employeeCode }).from(schema.employment)
      .where(inArray(schema.employment.id, [alice.employmentId, bob.employmentId, charlie.employmentId]))).map((r) => r.code).filter((c): c is string => !!c);
    for (const code of codes) expect(JSON.stringify(all.body)).not.toContain(`"${code}"`);

    // Paging over the same order, and the total stays the whole match.
    const page = await get('?limit=2&offset=1');
    expect(page.body).toMatchObject({ enabled: true, total: expected.length, offset: 1, limit: 2 });
    expect(names(page.body)).toEqual(names(all.body).slice(1, 3));
    expect((await get()).body.limit, 'default page size').toBe(30);

    // Search: trimmed, over the web's search columns; terminated staff stay excluded.
    expect((await get('?q=charlie')).body).toMatchObject({ total: 1, items: [{ employmentId: charlie.employmentId }] });
    expect((await get(`?q=${encodeURIComponent('  bob baker  ')}`)).body).toMatchObject({ total: 1, items: [{ employmentId: bob.employmentId }] });
    expect((await get('?q=terry')).body).toMatchObject({ enabled: true, total: 0, items: [] });
    expect((await get('?q=brenda')).body).toMatchObject({ total: 0, items: [] });
    expect((await get('?q=otto')).body).toMatchObject({ total: 0, items: [] });
  });

  it('a tenant-wide HR viewer sees both companies of the tenant and never another tenant', async () => {
    const [second] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Second Sdn Bhd' }).returning({ id: schema.company.id });
    const [logistics] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: second.id, name: 'Logistics' }).returning({ id: schema.department.id });
    const hr = await hire('Hana Group');
    const brenda = await hire('Brenda Beyond', { companyId: second.id, departmentId: logistics.id });
    const otherTenant = await seedBase();
    const otto = await hire('Otto Other', { b: otherTenant });
    caller = { ...(await login(hr, 'hr_admin', null)), grants: [{ role: 'hr_admin', companyId: null }] };
    const all = await get('?limit=50');
    const ids = all.body.items.map((i: { employmentId: string }) => i.employmentId);
    expect(ids).toContain(brenda.employmentId);
    expect(ids).toContain(hr.employmentId);
    expect(ids).not.toContain(otto.employmentId);
    expect(all.body.items.find((i: { employmentId: string }) => i.employmentId === brenda.employmentId)).toMatchObject({ company: 'Second Sdn Bhd', department: 'Logistics' });
  });

  it('gives an ordinary employee exactly what the web’s own read gives them, enabled, and refuses bad input and a revoked session', async () => {
    const employee = await hire('Eve Employee');
    await hire('Frank Colleague');
    const otherTenant = await seedBase();
    const otto = await hire('Otto Other', { b: otherTenant });
    caller = await login(employee, 'employee', null);
    const got = await get('?limit=50');
    expect(got.status).toBe(200);
    expect(got.body.enabled).toBe(true);
    // The web page's own call for this viewer (scopedSession with no switcher cookie = every allowed company).
    const scopeIds = (await allowedCompanies(caller)).map((c) => c.id);
    const web = await listEmployeesPage(caller, { companyIds: scopeIds, status: 'active', limit: 50, offset: 0 });
    expect(web.rows.length).toBeGreaterThan(0);
    expect(got.body.items.map((i: { employmentId: string }) => i.employmentId)).toEqual(web.rows.map((r) => r.employmentId));
    expect(got.body.total).toBe(web.total);
    expect(got.body.items.map((i: { employmentId: string }) => i.employmentId)).toContain(employee.employmentId);
    expect(got.body.items.map((i: { employmentId: string }) => i.employmentId)).not.toContain(otto.employmentId);

    for (const q of ['?limit=0', '?limit=51', '?limit=abc', '?offset=-1', '?offset=1.5', '?offset=9999999', `?q=${'a'.repeat(101)}`, '?q=a&q=b', '?limit=5&limit=6'])
      expect((await get(q)).status, q).toBe(400);
    expect((await get(`?q=${'a'.repeat(100)}`)).status).toBe(200);
    blocked = true;
    expect((await get()).status).toBe(401);
  });
});
