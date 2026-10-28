/**
 * M12 (D13) — the v2 own-attendance endpoints through the REAL route handlers, core and RLS. Only bearer session
 * resolution is injected (as test/mobile-v2-leave.test.ts does).
 *
 * Pinned: own-selected-employment scoping (a manager cannot read or withdraw a subordinate's application through
 * the OWN endpoints although RLS shows it to them; naming another employment is a 400); records keep schedule,
 * punches in force, outcome and exception apart and agree with the web's own owners, across an overnight shift,
 * a multi-punch day, a corrected day and a day whose clockings were all voided; the roster marks the overnight
 * shift as crossing midnight; window bounds refuse rather than truncate; application history keyset paging that
 * neither repeats nor skips across same-date rows and an insert mid-walk, the status filter and the counts; the
 * routing shown is the snapshot recorded at submission, not the template edited afterwards; withdraw and the
 * correction request replay under one requestId, conflict under a different command, and record nothing for a
 * refusal; a closed payroll is refused where the kernel refuses it (the decision), not invented at submission;
 * replacement leave answers the kernel's availability reason and refuses an ineligible request.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  attendanceForEmploymentRange, attendancePunchesForRange, cancelOwnAttendanceCorrection, checkIn, checkOut,
  decideAttendanceCorrection, myAttendanceCorrections, requestAttendanceCorrection,
} from '../core/attendance';
import { flagOf, personalAttendanceStatus } from '../core/attendance-derive';
import { attendanceClockData } from '../core/attendance-clock-data';
import { AttendancePayrollClosedError, ClockDataChangedError } from '../core/attendance-punch-change';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled } from '../core/attendance-workflow';
import { assignShift, createShift, setRestDay } from '../core/roster';
import { setCompensation } from '../core/comp';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import { createBatch, generatePayslips } from '../packs/payroll/service';
import { attendanceCommandRefusal, replacementLeaveRefusal } from '../core/mobile-attendance';
import { decodeCursor } from '../lib/mobile-api/v2/common';
import { ATTENDANCE_APPLICATIONS_CURSOR, AttendanceApplicationsCursor } from '../lib/mobile-api/v2/attendance';
import { AuthRequiredError } from '../lib/auth-errors';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let caller: SessionContext;
let blocked = false;
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getMobileSession: async () => { if (blocked) throw new AuthRequiredError('revoked'); return caller; } }));
const records = await import('../app/api/mobile/v2/attendance/records/route');
const roster = await import('../app/api/mobile/v2/attendance/roster/route');
const dayRoute = await import('../app/api/mobile/v2/attendance/day/route');
const apps = await import('../app/api/mobile/v2/attendance/applications/route');
const app = await import('../app/api/mobile/v2/attendance/applications/[id]/route');
const withdraw = await import('../app/api/mobile/v2/attendance/applications/[id]/withdraw/route');
const corrections = await import('../app/api/mobile/v2/attendance/corrections/route');
const rl = await import('../app/api/mobile/v2/attendance/replacement-leave/route');
const rlDay = await import('../app/api/mobile/v2/attendance/replacement-leave/day/route');

const BASE = 'https://hr.example.com/api/mobile/v2/attendance';
const TODAY = todayInKualaLumpur();
/** The server's `today` is read when it answers, so a run crossing midnight in Kuala Lumpur sees a later day than TODAY:
 *  pin "the tenant's day at answer time" (from the suite's start up to now), not the day the file loaded. */
const CURRENT_DAY = { asymmetricMatch: (v: unknown) => typeof v === 'string' && v >= TODAY && v <= todayInKualaLumpur(), toString: () => 'CurrentKualaLumpurDay' };
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// Fixed past dates in one month (all before today), so a window and a payroll period can name them.
const JULY = { from: '2026-07-01', to: '2026-07-31' };
const MULTI = '2026-07-06', NIGHT = '2026-07-07', CORRECTED = '2026-07-08', VOIDED = '2026-07-09', DAYSHIFT = '2026-07-10';

let base: Base;
const call = async (handler: (r: Request) => Promise<Response>, path: string, init?: RequestInit) => {
  const r = await handler(new Request(BASE + path, init));
  return { status: r.status, body: await r.json() };
};
const post = (handler: (r: Request) => Promise<Response>, path: string, body: unknown) =>
  call(handler, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const receipts = () => owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'mobile.command.recorded'));
const correctionRow = async (id: string) => (await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id, id)))[0];

async function hire(name: string, role: 'employee' | 'manager' = 'employee', departmentId = base.deptA) {
  const e = await hireEmployee(adminCtx(base), { person: { fullName: name, primaryEmail: randomUUID() + '@m12.test' }, companyId: base.companyId, departmentId, employmentType: 'full_time', hiredOn: '2024-01-01' });
  const userId = await createAppUser(base.tenantId, e.personId, role);
  const ctx: SessionContext = { tenantId: base.tenantId, userId, personId: e.personId, roles: [role], grants: [{ role, companyId: base.companyId }], entitlements: harnessSnapshot(base.tenantId) };
  return { ...e, ctx };
}
/** A context re-resolved after a module change (the snapshot is point-in-time, like a real session). */
const refreshed = (ctx: SessionContext): SessionContext => ({ ...ctx, entitlements: harnessSnapshot(base.tenantId) });

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => { await resetDb(); base = await seedBase(); blocked = false; });

describe('own selected employment only', () => {
  it('a manager cannot read or withdraw a subordinate’s application through the own endpoints, although RLS shows it to them', async () => {
    const employee = await hire('Aisyah Employee'), manager = await hire('Marcus Manager', 'manager', base.deptB);
    await setReportingLine(adminCtx(base), { subordinateEmploymentId: employee.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
    const theirs = (await requestAttendanceCorrection(employee.ctx, { employmentId: employee.employmentId, date: MULTI, checkIn: '09:00', checkOut: '18:00', reason: 'Forgot to clock' })).correctionId;
    // Non-vacuity: the canonical read admits the manager to the subordinate's request.
    expect((await myAttendanceCorrections(manager.ctx, employee.employmentId)).map((r) => r.id)).toContain(theirs);

    caller = manager.ctx;
    const listed = await call(apps.GET, '/applications');
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ enabled: true, employmentId: manager.employmentId, items: [], nextCursor: null, counts: { pending: 0, approved: 0, rejected: 0, cancelled: 0 } });
    expect(await call(app.GET, `/applications/${theirs}`)).toEqual({ status: 200, body: { outcome: 'refused', code: 'not_found' } });
    expect((await post(withdraw.POST, `/applications/${theirs}/withdraw`, { requestId: randomUUID() })).body).toEqual({ outcome: 'refused', code: 'not_found' });
    expect((await correctionRow(theirs)).status).toBe('pending');
    expect(await receipts()).toEqual([]);
    // The manager's own day for that date carries none of the subordinate's applications.
    const own = await call(dayRoute.GET, `/day?date=${MULTI}`);
    expect(own.body.outcome).toBe('found');
    expect(own.body.applications).toEqual([]);
    // Naming the subordinate's employment is a 400, never a read under it.
    for (const path of [`/applications?employmentId=${employee.employmentId}`, `/applications/${theirs}?employmentId=${employee.employmentId}`,
      `/day?date=${MULTI}&employmentId=${employee.employmentId}`, `/records?from=${JULY.from}&to=${JULY.to}&employmentId=${employee.employmentId}`]) {
      const handler = path.startsWith('/applications/') ? app.GET : path.startsWith('/applications') ? apps.GET : path.startsWith('/day') ? dayRoute.GET : records.GET;
      expect((await call(handler, path)).status, path).toBe(400);
    }
    expect((await call(app.GET, '/applications/not-a-uuid')).status).toBe(400);

    caller = employee.ctx;
    expect((await call(app.GET, `/applications/${theirs}`)).body.outcome, 'the owner does see it').toBe('found');
    blocked = true;
    expect((await call(apps.GET, '/applications')).status).toBe(401);
  });
});

describe('records and roster', () => {
  it('keeps schedule, punches, outcome and exception apart and agrees with the web’s owners across overnight, multi-punch, corrected and voided days', async () => {
    const a = adminCtx(base), employee = await hire('Nadia Night');
    const night = await createShift(a, { companyId: base.companyId, name: 'Night', code: 'NIGHT', startTime: '22:00:00', endTime: '06:00:00', breakMinutes: 60 });
    const dayShift = await createShift(a, { companyId: base.companyId, name: 'Day', code: 'DAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 });
    await assignShift(a, { employmentId: employee.employmentId, shiftDate: NIGHT, shiftId: night.id });
    await assignShift(a, { employmentId: employee.employmentId, shiftDate: DAYSHIFT, shiftId: dayShift.id });
    await checkIn(a, { employmentId: employee.employmentId, date: NIGHT, time: '22:00:00' });
    await checkOut(a, { employmentId: employee.employmentId, date: NIGHT, time: '06:00:00' }); // the next calendar morning
    await checkIn(a, { employmentId: employee.employmentId, date: MULTI, time: '08:00:00' });
    await checkOut(a, { employmentId: employee.employmentId, date: MULTI, time: '12:00:00' });
    await checkIn(a, { employmentId: employee.employmentId, date: MULTI, time: '13:00:00' });
    await checkOut(a, { employmentId: employee.employmentId, date: MULTI, time: '19:00:00' });
    for (const date of [CORRECTED, VOIDED]) {
      await checkIn(a, { employmentId: employee.employmentId, date, time: '08:00', manual: true });
      await checkOut(a, { employmentId: employee.employmentId, date, time: '17:00', manual: true });
    }
    const fix = await requestAttendanceCorrection(a, { employmentId: employee.employmentId, date: CORRECTED, checkIn: '09:00', checkOut: '18:00', reason: 'Gate log' });
    await decideAttendanceCorrection(a, { correctionId: fix.correctionId, decision: 'approved' });
    const raw = await attendanceClockData(a, employee.employmentId, VOIDED);
    const voiding = await requestAttendanceCorrection(a, { employmentId: employee.employmentId, date: VOIDED, reason: 'Clocked on the wrong badge', clockChanges: { version: 1, baseline: raw.baseline, entries: [] } });
    await decideAttendanceCorrection(a, { correctionId: voiding.correctionId, decision: 'approved' });

    caller = employee.ctx;
    const got = await call(records.GET, `/records?from=${JULY.from}&to=${JULY.to}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ enabled: true, employmentId: employee.employmentId, timeZone: 'Asia/Kuala_Lumpur', today: CURRENT_DAY, from: JULY.from, to: JULY.to });
    const days = got.body.days as { date: string; schedule: any; punches: { at: string; direction: string }[]; outcome: any; exception: string | null }[];
    expect(days.map((d) => d.date)).toEqual(Array.from({ length: 31 }, (_, i) => addDays(JULY.from, i)));
    const on = (date: string) => days.find((d) => d.date === date)!;

    // The web's owners, read the way the web's list reads them: the statuses, exceptions and figures must agree.
    const rows = await attendanceForEmploymentRange(employee.ctx, employee.employmentId, JULY.from, JULY.to);
    const punches = await attendancePunchesForRange(employee.ctx, employee.employmentId, JULY.from, JULY.to);
    expect(rows.length).toBe(31);
    for (const row of rows) {
      const d = on(row.date);
      expect(d.outcome.status, row.date).toBe(personalAttendanceStatus(row, TODAY));
      expect(d.exception, row.date).toBe(flagOf(row));
      expect([d.outcome.checkIn, d.outcome.checkOut, d.outcome.workedMinutes], row.date).toEqual([row.checkInAt?.slice(0, 5) ?? null, row.checkOutAt?.slice(0, 5) ?? null, row.workedMinutes]);
      expect(d.punches, row.date).toEqual((row.attendanceId ? punches.get(row.attendanceId) ?? [] : []).map((p) => ({ at: p.punchAt.slice(0, 5), direction: p.direction })));
      expect(d.schedule.shiftCode, row.date).toBe(row.shiftCode);
    }

    // Overnight: dated by the shift start, the clock-out after midnight on the same row, the shift crossing midnight.
    expect(on(NIGHT).schedule).toMatchObject({ shiftCode: 'NIGHT', start: '22:00', end: '06:00', crossesMidnight: true });
    expect(on(NIGHT).outcome).toMatchObject({ recorded: true, checkIn: '22:00', checkOut: '06:00' });
    expect(on(NIGHT).punches.map((p) => `${p.at}:${p.direction}`).sort()).toEqual(['06:00:out', '22:00:in']);
    expect(on(DAYSHIFT).schedule).toMatchObject({ shiftCode: 'DAY', start: '08:00', end: '17:00', crossesMidnight: false });
    // Multiple punches: every clocking in force, first to last.
    expect(on(MULTI).punches.map((p) => `${p.at}:${p.direction}`)).toEqual(['08:00:in', '12:00:out', '13:00:in', '19:00:out']);
    expect(on(MULTI).outcome).toMatchObject({ checkIn: '08:00', checkOut: '19:00' });
    // Corrected: the punches the approved correction put in force, and the corrected outcome.
    expect(on(CORRECTED).punches.map((p) => `${p.at}:${p.direction}`)).toEqual(['09:00:in', '18:00:out']);
    expect(on(CORRECTED).outcome).toMatchObject({ checkIn: '09:00', checkOut: '18:00' });
    // Voided: no clocking in force; the day remains recorded and reads absent (the originals are HR's raw data).
    expect(on(VOIDED).punches).toEqual([]);
    expect(on(VOIDED).outcome).toMatchObject({ recorded: true, checkIn: null, checkOut: null, status: 'absent' });

    const corrected = await call(dayRoute.GET, `/day?date=${CORRECTED}`);
    expect(corrected.body).toMatchObject({ outcome: 'found', today: CURRENT_DAY, correction: { offered: true, blockedBy: null } });
    expect(corrected.body.applications.map((x: { id: string; displayStatus: string }) => [x.id, x.displayStatus])).toEqual([[fix.correctionId, 'approved']]);
    expect(corrected.body.day).toEqual(on(CORRECTED));
    const future = await call(dayRoute.GET, `/day?date=${addDays(TODAY, 3)}`);
    expect(future.body.correction).toEqual({ offered: false, blockedBy: 'future' });

    const plan = await call(roster.GET, `/roster?from=${JULY.from}&to=${JULY.to}`);
    expect(plan.status).toBe(200);
    const rosterOn = (date: string) => plan.body.days.find((d: { date: string }) => d.date === date);
    expect(rosterOn(NIGHT)).toMatchObject({ kind: 'shift', shift: { code: 'NIGHT', start: '22:00', end: '06:00', crossesMidnight: true } });
    expect(rosterOn(DAYSHIFT)).toMatchObject({ kind: 'shift', shift: { code: 'DAY', start: '08:00', end: '17:00', crossesMidnight: false } });
    expect(plan.body.totals.rosteredDays).toBe(2);
  });

  it('defaults to this month and refuses a long, inverted, repeated or malformed window rather than truncating', async () => {
    const employee = await hire('Window Worker');
    caller = employee.ctx;
    const month = await call(records.GET, '/records');
    expect(month.status).toBe(200);
    expect(month.body.from).toBe(`${TODAY.slice(0, 7)}-01`);
    expect(month.body.to.slice(0, 7)).toBe(TODAY.slice(0, 7));
    expect(addDays(month.body.to, 1).slice(8), 'the window ends on the month’s last day').toBe('01');
    const span = Math.round((Date.parse(`${month.body.to}T00:00:00Z`) - Date.parse(`${month.body.from}T00:00:00Z`)) / 86_400_000) + 1;
    expect(month.body.days.map((d: { date: string }) => d.date)).toEqual(Array.from({ length: span }, (_, i) => addDays(month.body.from, i)));
    for (const q of ['?from=2026-07-01&to=2026-08-01', '?from=2026-07-31&to=2026-07-01', '?from=2026-07-01', '?from=2026-07-01&from=2026-07-02&to=2026-07-03', '?from=2026-02-30&to=2026-03-01'])
      expect((await call(records.GET, '/records' + q)).status, q).toBe(400);
    expect((await call(roster.GET, '/roster?from=2026-07-01&to=2026-08-15')).status).toBe(400);
    expect((await call(dayRoute.GET, '/day')).status).toBe(400);
  });

  it('answers enabled:false / module_off when the Attendance module is off, and reads nothing', async () => {
    const employee = await hire('Module Off');
    await setModule(base.tenantId, 'attendance', null);
    caller = refreshed(employee.ctx);
    expect((await call(records.GET, '/records')).body).toMatchObject({ enabled: false, employmentId: null, days: [] });
    expect((await call(apps.GET, '/applications')).body).toMatchObject({ enabled: false, items: [] });
    expect((await call(dayRoute.GET, `/day?date=${MULTI}`)).body).toEqual({ outcome: 'refused', code: 'module_off' });
    const refused = await post(corrections.POST, '/corrections', { requestId: randomUUID(), date: MULTI, checkIn: '09:00', reason: 'r' });
    expect(refused.body).toEqual({ outcome: 'refused', code: 'module_off' });
    expect(await receipts()).toEqual([]);
  });
});

describe('own application history', () => {
  it('pages in the kernel’s order without repeats or skips across same-date rows and an insert mid-walk; filter and counts', async () => {
    const a = adminCtx(base), employee = await hire('History Worker');
    const file = (date: string) => requestAttendanceCorrection(employee.ctx, { employmentId: employee.employmentId, date, checkIn: '09:00', checkOut: '18:00', reason: `Fix ${date}` }).then((r) => r.correctionId);
    const d1 = await file('2026-06-01');
    const d2rejected = await file('2026-06-02');
    await decideAttendanceCorrection(a, { correctionId: d2rejected, decision: 'rejected', rejectReason: 'Fixture rejection explanation' });
    const d2pending = await file('2026-06-02'); // same attendance date as the rejected one: the tie is broken by filing order
    const d3 = await file('2026-06-03');
    await cancelOwnAttendanceCorrection(employee.ctx, { correctionId: d3 });
    const d4 = await file('2026-06-04');
    await decideAttendanceCorrection(a, { correctionId: d4, decision: 'approved' });

    caller = employee.ctx;
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0, inserted: string | null = null;
    do {
      const page = await call(apps.GET, '/applications?limit=2' + (cursor ? '&cursor=' + cursor : ''));
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.items.map((i: { id: string }) => i.id));
      cursor = page.body.nextCursor;
      if (cursor) {
        const last = page.body.items.at(-1);
        const tuple = decodeCursor(ATTENDANCE_APPLICATIONS_CURSOR, cursor, AttendanceApplicationsCursor)!;
        expect([tuple[0], tuple[2]]).toEqual([last.date, last.id]);
      }
      if (pages === 0) inserted = await file('2026-06-20'); // later than the cursor: never on a later page
      pages++;
    } while (cursor && pages < 10);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([d4, d3, d2pending, d2rejected, d1]);
    expect(seen).not.toContain(inserted);

    const pending = await call(apps.GET, '/applications?status=pending');
    expect(pending.body.items.map((i: { id: string }) => i.id)).toEqual([inserted, d2pending, d1]);
    expect(pending.body.counts).toEqual({ pending: 3, approved: 1, rejected: 1, cancelled: 1 });
    const statuses = Object.fromEntries((await call(apps.GET, '/applications')).body.items.map((i: { id: string; displayStatus: string }) => [i.id, i.displayStatus]));
    expect(statuses).toMatchObject({ [d3]: 'withdrawn', [d2rejected]: 'rejected', [d4]: 'approved', [d1]: 'pending' });
    expect((await call(apps.GET, '/applications?status=bogus')).status).toBe(400);
    expect((await call(apps.GET, '/applications?cursor=!!garbage')).status).toBe(400);

    const rejected = await call(app.GET, `/applications/${d2rejected}`);
    expect(rejected.body).toMatchObject({ outcome: 'found', application: { id: d2rejected, status: 'rejected', displayStatus: 'rejected', rejectReason: 'Fixture rejection explanation', routing: null, actions: { withdraw: false }, asked: { checkIn: '09:00', checkOut: '18:00' }, reason: 'Fix 2026-06-02' } });
    expect(rejected.body.application.decidedAt).not.toBeNull();
    expect((await call(app.GET, `/applications/${d3}`)).body.application).toMatchObject({ displayStatus: 'withdrawn', actions: { withdraw: false } });
    expect((await call(app.GET, `/applications/${d1}`)).body.application.actions).toEqual({ withdraw: true });
  });

  it('shows the routing recorded at submission after the template is re-versioned, and each decided level', async () => {
    const a = adminCtx(base);
    const worker = await hire('Workflow worker'), manager = await hire('Frozen manager', 'manager', base.deptB);
    await setReportingLine(a, { subordinateEmploymentId: worker.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2024-01-01' });
    await checkIn(a, { employmentId: worker.employmentId, date: MULTI, time: '08:00', manual: true });
    await checkOut(a, { employmentId: worker.employmentId, date: MULTI, time: '17:00', manual: true });
    const input = (name: string) => ({ companyId: base.companyId, code: 'CLOCK', name, description: 'Verified routing', applicationType: 'irregularity' as const, priority: 100,
      // The subject alone (test/mobile-v2-approvals.test.ts): activation resolves every targeted employee's stages.
      criteria: { departmentIds: [base.deptA], employeeIds: [worker.employmentId] }, stages: ['direct_manager', 'hr_admin'].map((kind, i) => ({ name: `Review ${i + 1}`, level: { kind, employmentId: null, alternates: [] } })), active: true });
    const template = await saveAttendanceWorkflow(a, input('Clock review'));
    await setAttendanceWorkflowEnabled(a, base.companyId, 'irregularity', true);

    caller = worker.ctx;
    const sent = await post(corrections.POST, '/corrections', { requestId: randomUUID(), date: MULTI, checkIn: '09:00', checkOut: '18:00', reason: 'Badge reader down' });
    expect(sent.body).toMatchObject({ outcome: 'submitted', date: MULTI });
    const id = sent.body.id as string;
    // The policy changes after submission; the application keeps what was recorded with it.
    await saveAttendanceWorkflow(a, input('Renamed after submission'), template.lineageId);
    await decideAttendanceCorrection(manager.ctx, { correctionId: id, decision: 'approved', expectedStageIndex: 0, remarks: 'Manager checked source' });

    const detail = await call(app.GET, `/applications/${id}`);
    expect(detail.body.outcome).toBe('found');
    const routing = detail.body.application.routing;
    expect(routing).toMatchObject({ templateName: 'Clock review', templateVersion: 1, currentLevel: 2 });
    expect(routing.levels.map((l: { level: number; name: string; status: string }) => [l.level, l.name, l.status])).toEqual([[1, 'Review 1', 'approved'], [2, 'Review 2', 'waiting']]);
    expect(routing.levels[0].decision).toMatchObject({ actorName: 'Frozen manager', actingMode: 'assigned', remarks: 'Manager checked source' });
    expect(routing.levels[0].approvers).toEqual([{ kind: 'person', name: 'Frozen manager' }]);
    expect(routing.levels[1].approvers.some((x: { kind: string }) => x.kind === 'hr')).toBe(true);
    expect(detail.body.application.original).toMatchObject({ checkIn: '08:00', checkOut: '17:00' });
  });

  it('withdraw replays under one requestId, conflicts under another command, and records nothing for a refusal', async () => {
    const a = adminCtx(base), employee = await hire('Withdraw Worker');
    const file = (date: string) => requestAttendanceCorrection(employee.ctx, { employmentId: employee.employmentId, date, checkIn: '09:00', checkOut: '18:00', reason: 'r' }).then((r) => r.correctionId);
    const first = await file('2026-06-01'), second = await file('2026-06-02'), decided = await file('2026-06-03');
    await decideAttendanceCorrection(a, { correctionId: decided, decision: 'approved' });
    const [plan] = await owner.db.insert(schema.attendanceCorrection).values({ tenantId: base.tenantId, employmentId: employee.employmentId, attendanceDate: '2026-06-04', requestedOtMinutes: 60, reason: 'Overtime plan' }).returning({ id: schema.attendanceCorrection.id });

    caller = employee.ctx;
    const requestId = randomUUID();
    const once = await post(withdraw.POST, `/applications/${first}/withdraw`, { requestId });
    expect(once).toEqual({ status: 200, body: { outcome: 'withdrawn', id: first } });
    expect(await correctionRow(first)).toMatchObject({ status: 'cancelled', cancellationKind: 'withdrawn' });
    expect((await post(withdraw.POST, `/applications/${first}/withdraw`, { requestId })).body, 'the lost answer replays').toEqual(once.body);
    expect(await receipts()).toHaveLength(1);
    expect((await post(withdraw.POST, `/applications/${second}/withdraw`, { requestId })).body).toEqual({ outcome: 'refused', code: 'request_conflict' });
    expect((await correctionRow(second)).status).toBe('pending');

    const late = await post(withdraw.POST, `/applications/${decided}/withdraw`, { requestId: randomUUID() });
    expect(late.body).toMatchObject({ outcome: 'refused', code: 'not_withdrawable', message: 'This request is no longer waiting for a decision, so it can no longer be withdrawn.' });
    expect((await call(app.GET, `/applications/${plan.id}`)).body.application).toMatchObject({ application: 'overtime', actions: { withdraw: false } });
    expect((await post(withdraw.POST, `/applications/${plan.id}/withdraw`, { requestId: randomUUID() })).body).toMatchObject({ outcome: 'refused', code: 'not_withdrawable' });
    expect((await correctionRow(plan.id)).status).toBe('pending');
    expect(await receipts()).toHaveLength(1);
    expect((await post(withdraw.POST, `/applications/${second}/withdraw`, { requestId: 'nope' })).status).toBe(400);
  });
});

describe('correction request', () => {
  it('files through the kernel, replays under one requestId, and refuses a conflict, a pending date, a future date and bad times', async () => {
    const employee = await hire('Correction Worker');
    caller = employee.ctx;
    const body = { requestId: randomUUID(), date: CORRECTED, checkIn: '09:00', checkOut: '18:00', reason: 'Badge reader down', remark: 'Gate log 09:02' };
    const sent = await post(corrections.POST, '/corrections', body);
    expect(sent.body).toMatchObject({ outcome: 'submitted', date: CORRECTED });
    const row = await correctionRow(sent.body.id);
    expect(row).toMatchObject({ employmentId: employee.employmentId, status: 'pending', proposedCheckIn: '09:00:00', proposedCheckOut: '18:00:00', reason: 'Badge reader down', remark: 'Gate log 09:02', requestKind: 'other' });
    expect((await post(corrections.POST, '/corrections', body)).body, 'a lost answer replays').toEqual(sent.body);
    expect(await owner.db.select().from(schema.attendanceCorrection).where(and(eq(schema.attendanceCorrection.employmentId, employee.employmentId), eq(schema.attendanceCorrection.attendanceDate, CORRECTED)))).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    expect((await post(corrections.POST, '/corrections', { ...body, reason: 'Something else' })).body).toEqual({ outcome: 'refused', code: 'request_conflict' });

    expect((await post(corrections.POST, '/corrections', { ...body, requestId: randomUUID() })).body).toMatchObject({ outcome: 'refused', code: 'pending_exists' });
    expect((await post(corrections.POST, '/corrections', { ...body, requestId: randomUUID(), date: addDays(TODAY, 2) })).body).toMatchObject({ outcome: 'refused', code: 'future' });
    const inverted = await post(corrections.POST, '/corrections', { requestId: randomUUID(), date: VOIDED, checkIn: '18:00', checkOut: '09:00', reason: 'r' });
    expect(inverted.body).toMatchObject({ outcome: 'refused', code: 'invalid', message: 'Check-out must be after check-in' });
    expect((await post(corrections.POST, '/corrections', { requestId: randomUUID(), date: VOIDED, checkOut: '18:00', reason: 'r' })).body).toMatchObject({ outcome: 'refused', code: 'invalid' });
    expect(await receipts(), 'no refusal is recorded').toHaveLength(1);
    for (const bad of [{ ...body, reason: '' }, { ...body, checkIn: '25:00' }, { ...body, date: '2026-02-30' }, { ...body, requestId: 'x' }, { ...body, employmentId: randomUUID() }])
      expect((await post(corrections.POST, '/corrections', bad)).status).toBe(400);
  });

  it('a closed payroll is refused where the kernel refuses it — the decision — and maps to payroll_closed', async () => {
    const a = adminCtx(base), employee = await hire('Payroll Worker');
    await setCompensation(a, { employmentId: employee.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    await checkIn(a, { employmentId: employee.employmentId, date: MULTI, time: '08:00', manual: true });
    await checkOut(a, { employmentId: employee.employmentId, date: MULTI, time: '17:00', manual: true });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    await owner.db.update(schema.payrollBatch).set({ status: 'closed' }).where(eq(schema.payrollBatch.id, batchId));

    caller = employee.ctx;
    // FACT (core/attendance.ts requestAttendanceCorrection): a clock-time request is not refused at submission for a
    // closed payroll; approval is (lockAttendancePayrollTx). The app shows what the kernel decides, nothing more.
    const sent = await post(corrections.POST, '/corrections', { requestId: randomUUID(), date: MULTI, checkIn: '09:00', checkOut: '18:00', reason: 'Late badge' });
    expect(sent.body.outcome).toBe('submitted');
    await expect(decideAttendanceCorrection(a, { correctionId: sent.body.id, decision: 'approved' })).rejects.toBeInstanceOf(AttendancePayrollClosedError);
    expect((await call(app.GET, `/applications/${sent.body.id}`)).body.application).toMatchObject({ status: 'pending', actions: { withdraw: true } });
    // Where the kernel does throw it (on every path that locks payroll), the command answers the typed code.
    expect(attendanceCommandRefusal(new AttendancePayrollClosedError())).toMatchObject({ outcome: 'refused', code: 'payroll_closed' });
    expect(attendanceCommandRefusal(new ClockDataChangedError())).toMatchObject({ code: 'invalid' });
    expect(() => attendanceCommandRefusal(new TypeError('boom'))).toThrow(TypeError);
  });
});

describe('replacement leave (Leave Credit)', () => {
  const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({ companyId: base.companyId, enabled: true, accrualBasis: 'hours_worked', expiryDays: 90, onExpiry: 'convert_to_pay',
    allowFirstScheduleEligible: false, autoAccrueOnApproval: false, carryForwardAtYearEnd: false, employeeRequestEnabled: true, ...over });

  it('answers the kernel’s availability reason, and refuses an ineligible request without writing anything', async () => {
    const inside = await hire('Inside Worker'), outside = await hire('Outside Worker', 'employee', base.deptB);
    caller = inside.ctx;
    expect((await call(rl.GET, '/replacement-leave')).body).toMatchObject({ allowed: false, reason: 'module_off', employmentId: inside.employmentId, timeZone: 'Asia/Kuala_Lumpur', today: CURRENT_DAY });
    const off = await post(rl.POST, '/replacement-leave', { requestId: randomUUID(), rows: [{ workedDate: MULTI, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }], reason: 'Covered the stock take', firstScheduleConsent: false });
    expect(off.body).toEqual({ outcome: 'refused', code: 'module_off' });

    await setModule(base.tenantId, 'toil', 'active');
    caller = refreshed(inside.ctx);
    expect((await call(rl.GET, '/replacement-leave')).body).toMatchObject({ allowed: false, reason: 'not_enabled' });
    await setToilPolicy(adminCtx(base), policy({ requestEligibility: { departmentIds: [base.deptA] } }));
    // Enabling the policy creates the tenant's Replacement Leave type (core/toil.ts ensureReplacementLeaveType), so the
    // offer opens at once on that type.
    const opened = (await call(rl.GET, '/replacement-leave')).body;
    expect(opened).toMatchObject({ allowed: true, reason: null });
    expect(opened.leaveType).toMatchObject({ name: 'Replacement Leave (in lieu)' });
    // With that type archived there is no type for a credit to land on (My Leave hides the button).
    await owner.db.update(schema.leaveType).set({ archivedAt: new Date() }).where(and(eq(schema.leaveType.tenantId, base.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
    expect((await call(rl.GET, '/replacement-leave')).body).toMatchObject({ allowed: false, reason: 'no_leave_type' });
    await owner.db.insert(schema.leaveType).values({ tenantId: base.tenantId, code: 'REPLACEMENT', name: 'Replacement Leave', paid: true });
    const allowed = (await call(rl.GET, '/replacement-leave')).body;
    expect(allowed).toMatchObject({ allowed: true, reason: null });
    expect(allowed.leaveType).toMatchObject({ name: 'Replacement Leave' });
    expect(allowed.tiers).not.toBeNull();

    caller = refreshed(outside.ctx);
    expect((await call(rl.GET, '/replacement-leave')).body).toMatchObject({ allowed: false, reason: 'not_eligible' });
    await setRestDay(adminCtx(base), { employmentId: outside.employmentId, shiftDate: MULTI });
    const refused = await post(rl.POST, '/replacement-leave', { requestId: randomUUID(), rows: [{ workedDate: MULTI, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }], reason: 'Covered the stock take', firstScheduleConsent: false });
    expect(refused.body).toMatchObject({ outcome: 'refused', code: 'not_eligible' });
    expect(await owner.db.select().from(schema.replacementLeaveRequest).where(eq(schema.replacementLeaveRequest.employmentId, outside.employmentId))).toEqual([]);
    expect(await receipts()).toEqual([]);
    for (const bad of [{ rows: [], reason: 'r', firstScheduleConsent: false }, { rows: [{ workedDate: MULTI, dayType: 'weekday', claimStart: '09:00', claimEnd: '17:00' }], reason: 'r', firstScheduleConsent: false }, { rows: [{ workedDate: MULTI, dayType: 'rest_day', claimStart: '09:00', claimEnd: '17:00' }], reason: '', firstScheduleConsent: false }])
      expect((await post(rl.POST, '/replacement-leave', { requestId: randomUUID(), ...bad })).status).toBe(400);
    expect((await call(rlDay.GET, `/replacement-leave/day?date=${MULTI}&start=09:00`)).status).toBe(400);
    expect(() => replacementLeaveRefusal(new TypeError('boom'))).toThrow(TypeError);
  });
});
