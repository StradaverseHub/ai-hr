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
import { createClockingLocation, setClockingControl } from '../core/clocking-location';
import { ownClockToday } from '../core/attendance-clock-read';

let b: Base;
let CALLER: SessionContext;
vi.mock('../lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session')>()),
  getSession: async () => CALLER,
}));

const { POST, GET } = await import('../app/api/attendance/clock/route');
const { GET:todayGET } = await import('../app/api/attendance/today/route');

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
  it('requires a context for a selected command, rejects foreign or duplicate selectors, and recovers only its own selected receipt',async()=>{
    const employmentId=await hire(),requestId=randomUUID();
    const state=await ownClockToday(CALLER,undefined,employmentId);
    expect((await post({action:'in',requestId,employmentId})).status).toBe(400);
    const foreign=await post({action:'in',requestId,employmentId:randomUUID(),clockContext:state.clockContext});
    expect(foreign.status).toBe(409);expect(await foreign.json()).toEqual({error:'accountChanged'});
    const fields={action:'in',requestId,employmentId,clockContext:state.clockContext};
    const duplicate=new FormData();for(const [key,value] of Object.entries(fields))duplicate.set(key,value);duplicate.append('employmentId',employmentId);
    expect((await POST(new Request('http://localhost/api/attendance/clock',{method:'POST',headers:{origin:'http://localhost'},body:duplicate}))).status).toBe(400);
    const accepted=await post(fields);expect(accepted.status).toBe(200);
    const lookup=await GET(new Request(`http://localhost/api/attendance/clock?requestId=${requestId}&employmentId=${employmentId}`));
    expect(lookup.status).toBe(200);expect(await lookup.json()).toEqual(await accepted.json());
    const refreshed=await todayGET(new Request(`http://localhost/api/attendance/today?employmentId=${employmentId}`));
    expect(refreshed.status).toBe(200);expect(await refreshed.json()).toMatchObject({clockContext:state.clockContext,clockedIn:true});
    expect((await todayGET(new Request(`http://localhost/api/attendance/today?employmentId=${randomUUID()}`))).status).toBe(403);
    for(const query of [`employmentId=`,`employmentId=${employmentId}&employmentId=${employmentId}`]){
      expect((await todayGET(new Request('http://localhost/api/attendance/today?'+query))).status).toBe(400);
      expect((await GET(new Request('http://localhost/api/attendance/clock?requestId='+requestId+'&'+query))).status).toBe(400);
    }
  });
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

// An optional subject selector is re-authorized; it cannot widen receipt ownership.
it('confirms own accepted request and refuses a foreign selection or another employee receipt',async()=>{
  await hire();const requestId=randomUUID();const accepted=await post({action:'in',requestId,lat:'3',lng:'101',accuracy:'10'});expect(accepted.status).toBe(200);
  const own=await GET(new Request(`http://localhost/api/attendance/clock?requestId=${requestId}`));expect(own.status).toBe(200);expect((await own.json()).receipt).toEqual((await accepted.json()).receipt);
  const invalid=await GET(new Request(`http://localhost/api/attendance/clock?requestId=${requestId}&employmentId=${randomUUID()}`));expect(invalid.status).toBe(404);
  await hire();const other=await GET(new Request(`http://localhost/api/attendance/clock?requestId=${requestId}`));expect(other.status).toBe(404);
});

// An expired login may be renewed into a different account in another tab. A retry cannot clock that account.
it('binds new web commands to the original authenticated employee context',async()=>{
  const originalId=await hire(),originalCaller=CALLER;
  const originalContext=(await ownClockToday(CALLER)).clockContext;
  const requestId=randomUUID();
  const fields={action:'in',requestId,clockContext:originalContext,lat:'3',lng:'101',accuracy:'10'};
  expect((await post(fields)).status).toBe(200);
  const otherId=await hire();
  const refused=await post(fields);expect(refused.status).toBe(409);expect(await refused.json()).toEqual({error:'accountChanged'});
  expect(await owner.db.select({id:schema.attendance.id}).from(schema.attendance).where(eq(schema.attendance.employmentId,otherId))).toEqual([]);
  CALLER=originalCaller;
  const recovered=await post(fields);expect(recovered.status).toBe(200);
  expect(await owner.db.select({id:schema.attendanceClockCapture.id}).from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.employmentId,originalId))).toHaveLength(1);
});


describe('optional web location is persisted without invented coordinates', () => {
  it.each(['in', 'out'] as const)('accepts %s with no location when geofencing is off, and recovers the exact receipt', async action => {
    const employmentId = await hire();
    const requestId = randomUUID();
    const fields = { action, requestId };
    const accepted = await post(fields);
    expect(accepted.status).toBe(200);
    const receipt = (await accepted.json()).receipt;
    const [capture] = await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.employmentId, employmentId));
    expect(capture).toMatchObject({ lat: null, lng: null, accuracyM: null, clockingLocationId: null, distanceM: null, radiusM: null });
    const [punch] = await owner.db.select().from(schema.attendancePunch).where(eq(schema.attendancePunch.clockCaptureId, capture.id));
    expect(punch).toMatchObject({ lat: null, lng: null, geofenceStatus: 'not_enforced' });
    const replay = await post(fields);
    expect(replay.status).toBe(200);
    expect((await replay.json()).receipt).toEqual(receipt);
    expect(await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.employmentId, employmentId))).toHaveLength(1);
    const changed = await post({ ...fields, lat: '3', lng: '101', accuracy: '10' });
    expect(changed.status).toBe(409);
    await expect(owner.db.insert(schema.attendanceClockCapture).values({ ...capture, id: randomUUID(), requestId: randomUUID(), lat: 3 })).rejects.toThrow();
  });

  it.each(['in', 'out'] as const)('rechecks current geofencing before %s and refuses missing/outside location without attendance writes', async action => {
    const employmentId = await hire();
    const site = await createClockingLocation(adminCtx(b), { name: 'Approved office', lat: 3.0448, lng: 101.4455, radiusM: 100, companyIds: [b.companyId] });
    await setClockingControl(adminCtx(b), { employmentId, enabled: true, clockingLocationIds: [site.id] });
    const missing = await post({ action, requestId: randomUUID() });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'locationRequired' });
    const outside = await post({ action, requestId: randomUUID(), lat: '5', lng: '100', accuracy: '10' });
    expect(outside.status).toBe(400);
    expect(await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.employmentId, employmentId))).toEqual([]);
    expect(await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, employmentId))).toEqual([]);
    const inside = await post({ action, requestId: randomUUID(), lat: '3.0448', lng: '101.4455', accuracy: '8' });
    expect(inside.status).toBe(200);
    const [capture] = await owner.db.select().from(schema.attendanceClockCapture).where(eq(schema.attendanceClockCapture.employmentId, employmentId));
    expect(capture).toMatchObject({ lat: 3.0448, lng: 101.4455, accuracyM: 8, clockingLocationId: site.id, radiusM: 100 });
  });
});
