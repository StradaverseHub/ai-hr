/**
 * r430 — app/api/attendance/clock/route.ts's own FormData contract: deviceToken is REMOVED from the
 * allow-list entirely (a posted one is now an unrecognised key, refused), and 'photo' is OPTIONAL (0 or 1)
 * where every other key is still required exactly once. Exercised against the real route handler and a
 * real database, the session mocked the same way test/mobile-api-routes.test.ts mocks getMobileSession.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { adminCtx, harnessSnapshot, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';

let b: Base;
let CALLER: SessionContext;
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => CALLER,
}));

const { POST, GET } = await import('../app/api/attendance/clock/route');

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Route Fixture', primaryEmail: `${randomUUID()}@test.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: e.personId })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  CALLER = { tenantId: b.tenantId, userId: u.id, personId: e.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId), grants: [{ role: 'employee', companyId: null }] };
  return e.employmentId;
}

const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return POST(new Request('http://localhost/api/attendance/clock', { method: 'POST', headers: { origin: 'http://localhost' }, body }));
};

describe('r430 — POST /api/attendance/clock contract', () => {
  it('a posted deviceToken is an UNRECOGNISED key now — refused (400), nothing written', async () => {
    const employmentId = await hire();
    const res = await post({ action: 'in', requestId: randomUUID(), deviceToken: randomUUID(), lat: '3', lng: '101', accuracy: '10' });
    expect(res.status).toBe(400);
    const row = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, employmentId));
    expect(row).toHaveLength(0);
  });

  it('tolerates a MISSING photo field for an employee whose setting is Not Required (the default)', async () => {
    const employmentId = await hire();
    const res = await post({ action: 'in', requestId: randomUUID(), lat: '3', lng: '101', accuracy: '10' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt.direction).toBe('in');
    const row = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, employmentId));
    expect(row).toHaveLength(1);
  });

  it('every OTHER key still refuses when posted more than once', async () => {
    await hire();
    const body = new FormData();
    body.set('action', 'in');
    body.append('action', 'out'); // duplicate — refused
    body.set('requestId', randomUUID());
    body.set('lat', '3');
    body.set('lng', '101');
    body.set('accuracy', '10');
    const res = await POST(new Request('http://localhost/api/attendance/clock', { method: 'POST', headers: { origin: 'http://localhost' }, body }));
    expect(res.status).toBe(400);
  });
});

// Receipt lookup accepts only a request ID, and scopes it to the current employee.
it('confirms own accepted request and refuses a supplied subject or another employee receipt',async()=>{
  await hire();const requestId=randomUUID();const accepted=await post({action:'in',requestId,lat:'3',lng:'101',accuracy:'10'});expect(accepted.status).toBe(200);
  const own=await GET(new Request(`http://localhost/api/attendance/clock?requestId=${requestId}`));expect(own.status).toBe(200);expect((await own.json()).receipt).toEqual((await accepted.json()).receipt);
  const invalid=await GET(new Request(`http://localhost/api/attendance/clock?requestId=${requestId}&employmentId=${randomUUID()}`));expect(invalid.status).toBe(400);
  await hire();const other=await GET(new Request(`http://localhost/api/attendance/clock?requestId=${requestId}`));expect(other.status).toBe(404);
});
