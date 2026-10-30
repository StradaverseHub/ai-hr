/**
 * The self overtime plan in the app (GET /api/mobile/v2/attendance/overtime-plans/offer, POST .../overtime-plans)
 * through the REAL route handlers, core and RLS. Only bearer session resolution is injected (as
 * test/mobile-v2-attendance.test.ts does).
 *
 * Pinned: the offer mirrors the web's Apply OT Plan gating (the Attendance module, an own employment) and nothing
 * else; a plan files through requestAttendanceCorrection exactly as myRequestOvertime files it (the minutes derived
 * from the window, an overnight window into the next day, `self_overtime`, the window, the reason and the remark);
 * the same requestId replays the first answer and a different command under it conflicts; an equal window is
 * refused before anything is written; the kernel's dated refusal (an approved plan already waiting) maps to
 * `invalid` with its sentence; the plan then appears in the own applications list as `overtime`; another person's
 * or another tenant's employment is never writable; a revoked session is a 401.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, terminateEmployment } from '../core/org';
import { decideAttendanceCorrection, OvertimeAlreadyCountedError, OvertimePlanAlreadyApprovedError } from '../core/attendance';
import { attendanceCommandRefusal } from '../core/mobile-attendance';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const offer = await import('../app/api/mobile/v2/attendance/overtime-plans/offer/route');
const plans = await import('../app/api/mobile/v2/attendance/overtime-plans/route');
const apps = await import('../app/api/mobile/v2/attendance/applications/route');
const app = await import('../app/api/mobile/v2/attendance/applications/[id]/route');

const BASE = 'https://hr.example.com/api/mobile/v2/attendance';
const TODAY = todayInKualaLumpur();
const CURRENT_DAY = { asymmetricMatch: (v: unknown) => typeof v === 'string' && v >= TODAY && v <= todayInKualaLumpur(), toString: () => 'CurrentKualaLumpurDay' };
// Fixed FUTURE dates (test/plan-ot.test.ts's reason): a plan agreed before the day, never drifting into the past.
const PLAN_DAY = '2027-03-10', NIGHT_DAY = '2027-03-11', OTHER_DAY = '2027-03-12';

let base: Base;
const call = async (handler: (r: Request) => Promise<Response>, path: string, init?: RequestInit) => {
  const r = await handler(new Request(BASE + path, init));
  return { status: r.status, body: await r.json() };
};
const post = (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  call(handler, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const receipts = () => owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded'));
const rowsFor = (employmentId: string, date?: string) => owner.db.select().from(schema.attendanceCorrection)
  .where(date ? and(eq(schema.attendanceCorrection.employmentId, employmentId), eq(schema.attendanceCorrection.attendanceDate, date)) : eq(schema.attendanceCorrection.employmentId, employmentId));

async function hire(name: string, b: Base = base) {
  const e = await hireEmployee(adminCtx(b), { person: { fullName: name, primaryEmail: randomUUID() + '@ot.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: b.companyId }], entitlements: harnessSnapshot(b.tenantId) };
  return { ...e, ctx };
}
const refreshed = (ctx: SessionContext): SessionContext => ({ ...ctx, entitlements: harnessSnapshot(ctx.tenantId) });

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); base = await seedBase(); blocked = false; });

describe('offer', () => {
  it('offers the form to an own employment while Attendance is on, as the web apply page does', async () => {
    const employee = await hire('Olivia Offer');
    caller = employee.ctx;
    const got = await call(offer.GET, '/overtime-plans/offer');
    expect(got).toEqual({ status: 200, body: { enabled: true, employmentId: employee.employmentId, allowed: true, reason: null, timeZone: 'Asia/Kuala_Lumpur', today: CURRENT_DAY } });
    // Naming an employment that is not the caller's own is a 400, never an offer under it.
    const colleague = await hire('Colin Colleague');
    expect((await call(offer.GET, `/overtime-plans/offer?employmentId=${colleague.employmentId}`)).status).toBe(400);
    blocked = true;
    expect((await call(offer.GET, '/overtime-plans/offer')).status).toBe(401);
  });

  it('answers module_off with the module off, and no_employment for a login without an active employment', async () => {
    const employee = await hire('Module Off');
    await setModule(base.tenantId, 'attendance', null);
    caller = refreshed(employee.ctx);
    expect((await call(offer.GET, '/overtime-plans/offer')).body).toMatchObject({ enabled: false, employmentId: null, allowed: false, reason: 'module_off' });
    const refused = await post(plans.POST, '/overtime-plans', { requestId: randomUUID(), date: PLAN_DAY, plannedStart: '18:00', plannedEnd: '20:00', reason: 'Stock take' });
    expect(refused).toEqual({ status: 200, body: { outcome: 'refused', code: 'module_off' } });
    expect(await rowsFor(employee.employmentId)).toEqual([]);
    expect(await receipts()).toEqual([]);

    await setModule(base.tenantId, 'attendance', 'active');
    const leaver = await hire('Lena Leaver');
    await terminateEmployment(adminCtx(base), { employmentId: leaver.employmentId, terminationDate: '2025-12-31' });
    caller = refreshed(leaver.ctx);
    expect((await call(offer.GET, '/overtime-plans/offer')).body).toMatchObject({ enabled: true, employmentId: null, allowed: false, reason: 'no_employment' });
    expect((await post(plans.POST, '/overtime-plans', { requestId: randomUUID(), date: PLAN_DAY, plannedStart: '18:00', plannedEnd: '20:00', reason: 'r' })).status).toBe(400);
  });
});

describe('submit', () => {
  it('files through the kernel as myRequestOvertime does, replays under one requestId, and then appears in applications', async () => {
    const employee = await hire('Peter Planner');
    caller = employee.ctx;
    const body = { requestId: randomUUID(), date: PLAN_DAY, plannedStart: '18:00', plannedEnd: '20:30', reason: 'Quarter-end stock take', remark: 'Agreed with supervisor' };
    const sent = await post(plans.POST, '/overtime-plans', body);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ outcome: 'submitted', date: PLAN_DAY, minutes: 150 });
    const [row] = await rowsFor(employee.employmentId, PLAN_DAY);
    expect(row).toMatchObject({
      id: sent.body.id, status: 'pending', requestKind: 'self_overtime', requestedOtMinutes: 150, plannedStartTime: '18:00:00', plannedEndTime: '20:30:00',
      reason: 'Quarter-end stock take', remark: 'Agreed with supervisor', proposedCheckIn: null, proposedCheckOut: null,
    });

    expect((await post(plans.POST, '/overtime-plans', body)).body, 'a lost answer replays').toEqual(sent.body);
    expect(await rowsFor(employee.employmentId, PLAN_DAY)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    expect((await post(plans.POST, '/overtime-plans', { ...body, plannedEnd: '21:00' })).body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    // The kernel's pending fence for the date, as on the web.
    expect((await post(plans.POST, '/overtime-plans', { ...body, requestId: randomUUID() })).body).toMatchObject({ outcome: 'refused', code: 'pending_exists' });

    // An overnight window runs into the next day (plannedOvertimeMinutes, the web form's rule).
    const night = await post(plans.POST, '/overtime-plans', { requestId: randomUUID(), date: NIGHT_DAY, plannedStart: '22:00', plannedEnd: '02:00', reason: 'Night shipment' });
    expect(night.body).toMatchObject({ outcome: 'submitted', date: NIGHT_DAY, minutes: 240 });
    expect((await rowsFor(employee.employmentId, NIGHT_DAY))[0]).toMatchObject({ requestedOtMinutes: 240, remark: null, requestKind: 'self_overtime' });

    // The plan is an application of kind `overtime` in the existing own list and detail.
    const listed = await call(apps.GET, '/applications');
    expect(listed.status).toBe(200);
    const mine = listed.body.items.find((x: { id: string }) => x.id === sent.body.id);
    expect(mine).toMatchObject({ date: PLAN_DAY, application: 'overtime', requestKind: 'self_overtime', status: 'pending', displayStatus: 'pending',
      asked: { checkIn: null, checkOut: null, requestedOtMinutes: 150, plannedStart: '18:00', plannedEnd: '20:30', clockEntries: null } });
    expect(listed.body.counts.pending).toBe(2);
    const detail = await call(app.GET, `/applications/${sent.body.id}`);
    expect(detail.body.application).toMatchObject({ application: 'overtime', reason: 'Quarter-end stock take', remark: 'Agreed with supervisor', hasAttachment: false, actions: { withdraw: false } });
  });

  it('refuses an equal window before writing anything, and a malformed command as a 400', async () => {
    const employee = await hire('Wanda Window');
    caller = employee.ctx;
    const equal = await post(plans.POST, '/overtime-plans', { requestId: randomUUID(), date: PLAN_DAY, plannedStart: '18:00', plannedEnd: '18:00', reason: 'r' });
    expect(equal).toEqual({ status: 200, body: { outcome: 'refused', code: 'invalid', message: 'Enter different valid start and end times.' } });
    expect(await rowsFor(employee.employmentId)).toEqual([]);
    expect(await receipts(), 'no refusal is recorded').toEqual([]);
    const ok = { requestId: randomUUID(), date: PLAN_DAY, plannedStart: '18:00', plannedEnd: '20:00', reason: 'r' };
    for (const bad of [{ ...ok, plannedStart: '25:00' }, { ...ok, plannedEnd: '8:00' }, { ...ok, plannedEnd: undefined }, { ...ok, reason: '   ' }, { ...ok, reason: 'x'.repeat(501) },
      { ...ok, date: '2027-02-30' }, { ...ok, requestId: 'nope' }, { ...ok, requestedOtMinutes: 600 }, { ...ok, employmentId: employee.employmentId }])
      expect((await post(plans.POST, '/overtime-plans', bad)).status, JSON.stringify(bad)).toBe(400);
    expect(await rowsFor(employee.employmentId)).toEqual([]);
  });

  it('maps the kernel’s “approved plan already waiting” refusal to invalid with its sentence, recording nothing', async () => {
    const employee = await hire('Andy Approved');
    caller = employee.ctx;
    const first = await post(plans.POST, '/overtime-plans', { requestId: randomUUID(), date: OTHER_DAY, plannedStart: '18:00', plannedEnd: '21:00', reason: 'Audit' });
    expect(first.body.outcome).toBe('submitted');
    await decideAttendanceCorrection(adminCtx(base), { correctionId: first.body.id, decision: 'approved' });
    const second = await post(plans.POST, '/overtime-plans', { requestId: randomUUID(), date: OTHER_DAY, plannedStart: '21:00', plannedEnd: '22:00', reason: 'Audit again' });
    expect(second.body).toMatchObject({ outcome: 'refused', code: 'invalid' });
    expect(second.body.message).toMatch(/already have an approved overtime plan/i);
    expect(await rowsFor(employee.employmentId, OTHER_DAY)).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    // Both dated refusals are typed subclasses; without the mapping they would be a 500.
    expect(attendanceCommandRefusal(new OvertimePlanAlreadyApprovedError('2027-01-01'))).toMatchObject({ outcome: 'refused', code: 'invalid' });
    expect(attendanceCommandRefusal(new OvertimeAlreadyCountedError('2027-01-01'))).toMatchObject({ outcome: 'refused', code: 'invalid' });
  });

  it('never writes under another person’s or another tenant’s employment, and refuses a revoked session', async () => {
    const employee = await hire('Ian Inside'), colleague = await hire('Carla Colleague');
    const other = await seedBase();
    const foreigner = await hire('Farah Foreign', other);
    caller = employee.ctx;
    const body = { requestId: randomUUID(), date: PLAN_DAY, plannedStart: '18:00', plannedEnd: '20:00', reason: 'r' };
    for (const target of [colleague.employmentId, foreigner.employmentId, randomUUID(), 'not-a-uuid'])
      expect((await post(plans.POST, `/overtime-plans?employmentId=${target}`, { ...body, requestId: randomUUID() })).status, target).toBe(400);
    expect(await rowsFor(colleague.employmentId)).toEqual([]);
    expect(await rowsFor(foreigner.employmentId)).toEqual([]);
    expect(await receipts()).toEqual([]);
    // The other tenant's own employee files only under their own tenant and employment.
    caller = foreigner.ctx;
    const theirs = await post(plans.POST, '/overtime-plans', body);
    expect(theirs.body.outcome).toBe('submitted');
    expect((await rowsFor(foreigner.employmentId, PLAN_DAY))[0]).toMatchObject({ tenantId: other.tenantId });
    caller = employee.ctx;
    expect((await call(apps.GET, '/applications')).body.items).toEqual([]);
    expect((await call(app.GET, `/applications/${theirs.body.id}`)).body).toEqual({ outcome: 'refused', code: 'not_found' });
    blocked = true;
    expect((await post(plans.POST, '/overtime-plans', { ...body, requestId: randomUUID() })).status).toBe(401);
    expect(await rowsFor(employee.employmentId)).toEqual([]);
  });
});
