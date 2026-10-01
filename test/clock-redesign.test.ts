/**
 * af552c5d legacy display derivations and per-punch site metadata remain covered.
 * r378 replaces the circular control/shared form with mandatory camera review and a single private
 * capture endpoint. Source guards retain double-submit, server-clock, shift-count, device/location and
 * legacy entry-point authority checks against that approved replacement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { attendancePunchesForRange, checkIn, checkOut } from '../core/attendance';
import {
  createClockingLocation,
  setEmployeeClockingLocations,
  setGeofencing,
} from '../core/clocking-location';
import { createLocation } from '../core/location';
import {
  RING_CLASSES,
  completedSessions,
  cumulativeWorkedSeconds,
  elapsedDisplaySeconds,
  formatElapsed,
  latestSessionStart,
  ringState,
  secondsOf,
  showShiftSwitch,
  type ClockPunch,
} from '../app/attendance/clock/clock-display';

// ─── Pure display derivations ────────────────────────────────────────────────────────────────────────

const IN = (time: string): ClockPunch => ({ time, direction: 'in' });
const OUT = (time: string): ClockPunch => ({ time, direction: 'out' });

describe('ringState — the three-state circle (idle / in / out)', () => {
  it('is grey/idle before the first clock-in of the day', () => {
    expect(ringState([])).toBe('idle');
  });
  it('is red/in while clocked in (action = Clock Out)', () => {
    expect(ringState([IN('09:00')])).toBe('in');
    expect(ringState([IN('09:00'), OUT('12:00'), IN('13:00')])).toBe('in');
  });
  it('is green/out between sessions (action = Clock In)', () => {
    expect(ringState([IN('09:00'), OUT('12:00')])).toBe('out');
  });
});

describe('RING_CLASSES — state-driven gradient drift guard', () => {
  it('keeps the reporter’s color mapping: grey idle, red clocked-in, green clocked-out', () => {
    expect(RING_CLASSES.idle).toMatch(/slate/);
    expect(RING_CLASSES.idle).not.toMatch(/red|emerald/);
    expect(RING_CLASSES.in).toMatch(/red/);
    expect(RING_CLASSES.in).not.toMatch(/emerald|slate/);
    expect(RING_CLASSES.out).toMatch(/emerald/);
    expect(RING_CLASSES.out).not.toMatch(/red-|slate/);
  });
  it('every state carries a gradient, an outer glow ring, and dark-mode variants', () => {
    for (const cls of Object.values(RING_CLASSES)) {
      expect(cls).toContain('bg-gradient-to-br');
      expect(cls).toMatch(/ring-8/);
      expect(cls).toMatch(/shadow-/);
      expect(cls).toMatch(/dark:/);
    }
  });
  it('the three states are visually distinct', () => {
    expect(new Set(Object.values(RING_CLASSES)).size).toBe(3);
  });
});

describe('cumulativeWorkedSeconds — the timer shows cumulative hours worked today', () => {
  it('is zero before the first clock-in', () => {
    expect(cumulativeWorkedSeconds([], secondsOf('10:00'))).toBe(0);
  });
  it('counts an open session from the SERVER clock-in time to the server now', () => {
    // Clocked in at 08:36, server renders at 15:56:29 → 7h20m29s — the screenshot’s counter.
    const s = cumulativeWorkedSeconds([IN('08:36')], secondsOf('15:56:29'));
    expect(s).toBe(7 * 3600 + 20 * 60 + 29);
    expect(formatElapsed(s)).toBe('07h 20m 29s');
  });
  it('a refresh never resets it — the base depends only on server punches + server now', () => {
    const events = [IN('08:36')];
    const atRender = cumulativeWorkedSeconds(events, secondsOf('12:00'));
    const afterRefresh = cumulativeWorkedSeconds(events, secondsOf('12:00'));
    expect(afterRefresh).toBe(atRender);
  });
  it('sums completed pairs and freezes between sessions (lunch pattern)', () => {
    const lunch = [IN('09:00'), OUT('12:00'), IN('13:00'), OUT('15:30')];
    expect(cumulativeWorkedSeconds(lunch, secondsOf('16:00'))).toBe((3 + 2.5) * 3600);
    // Between sessions the server now does not accrue.
    const atLunch = [IN('09:00'), OUT('12:00')];
    expect(cumulativeWorkedSeconds(atLunch, secondsOf('12:45'))).toBe(3 * 3600);
  });
  it('an open second session adds its running span on top of the completed pair', () => {
    const events = [IN('09:00'), OUT('12:00'), IN('13:00')];
    expect(cumulativeWorkedSeconds(events, secondsOf('14:00'))).toBe(4 * 3600);
  });
  it('tolerates stray punches and clamps negatives (cross-midnight open session)', () => {
    expect(cumulativeWorkedSeconds([OUT('09:00')], secondsOf('10:00'))).toBe(0); // stray out
    expect(cumulativeWorkedSeconds([IN('09:00'), IN('09:30'), OUT('10:00')], secondsOf('11:00'))).toBe(3600); // dup in
    expect(cumulativeWorkedSeconds([IN('22:00')], secondsOf('01:00'))).toBe(0); // next-day render clamps
  });
});

describe('elapsedDisplaySeconds — client tick is skew-tolerant and display-only', () => {
  it('adds only the client-clock DELTA while clocked in, so absolute skew cannot shift it', () => {
    const base = 1000;
    // Two clients whose absolute clocks differ by 6 hours see the SAME counter after 5 ticking seconds.
    const onTime = elapsedDisplaySeconds(base, true, 1_000_000, 1_005_000);
    const skewed = elapsedDisplaySeconds(base, true, 21_601_000_000, 21_601_005_000);
    expect(onTime).toBe(base + 5);
    expect(skewed).toBe(onTime);
  });
  it('does not tick while clocked out (frozen at the server base)', () => {
    expect(elapsedDisplaySeconds(500, false, 0, 60_000)).toBe(500);
  });
  it('never runs backwards even if the client clock jumps behind the mount instant', () => {
    expect(elapsedDisplaySeconds(500, true, 10_000, 4_000)).toBe(500);
  });
});

describe('session derivations for the status row', () => {
  it('counts completed in→out pairs for the numbered badge', () => {
    expect(completedSessions([])).toBe(0);
    expect(completedSessions([IN('09:00')])).toBe(0); // open session not yet completed
    expect(completedSessions([IN('09:00'), OUT('12:00')])).toBe(1);
    expect(completedSessions([IN('09:00'), OUT('12:00'), IN('13:00'), OUT('18:00')])).toBe(2);
  });
  it('surfaces the most recent session’s clock-in time', () => {
    expect(latestSessionStart([])).toBeNull();
    expect(latestSessionStart([IN('08:36:00')])).toBe('08:36');
    expect(latestSessionStart([IN('09:00'), OUT('12:00'), IN('13:05')])).toBe('13:05');
  });
});

describe('formatElapsed', () => {
  it('renders the zero-padded h/m/s form', () => {
    expect(formatElapsed(0)).toBe('00h 00m 00s');
    expect(formatElapsed(59)).toBe('00h 00m 59s');
    expect(formatElapsed(3661)).toBe('01h 01m 01s');
    expect(formatElapsed(-5)).toBe('00h 00m 00s'); // defensive clamp
  });
});

describe('showShiftSwitch — the Switch link is hidden rather than dead', () => {
  it('renders only when there is more than one option', () => {
    expect(showShiftSwitch(0)).toBe(false);
    expect(showShiftSwitch(1)).toBe(false);
    expect(showShiftSwitch(2)).toBe(true);
  });
});

// ─── Source guards on the client island ('use client' — not renderable in a node test) ───────────────

const ISLAND = fs.readFileSync(path.resolve(__dirname, '../app/attendance/clock/clock-client.tsx'), 'utf8');
const CAPTURE = fs.readFileSync(path.resolve(__dirname, '../components/attendance-clock-button.tsx'), 'utf8');

describe('clock-client source guards (r378 approved camera replacement for af552c5d)', () => {
  it('blocks both clock actions during capture/request and guards duplicate confirmation', () => {
    expect(ISLAND).toMatch(/const blocked=busy\|\|camera\|\|!!action\|\|!synced\|\|!today\.deviceValid\|\|!today\.locationValid/);
    expect(ISLAND).toContain('disabled={blocked||today.clockedIn}');
    expect(ISLAND).toContain('disabled={blocked||!today.clockedIn}');
    expect(ISLAND).toContain('if(!photo||!action||busy)return;setBusy(true)');
    expect(ISLAND).toContain('disabled={busy} onClick={confirm}');
    expect(ISLAND).toContain('body:command.current.body');
  });
  it('hides Switch unless there is more than one assignable shift', () => {
    expect(ISLAND).toMatch(/shiftOptions\.length>1&&<button/);
    expect(ISLAND).toContain('setShiftIdx(i=>(i+1)%shiftOptions.length)');
  });
  it('anchors the clock and worked duration to authenticated server values plus a monotonic delta', () => {
    expect(ISLAND).toContain("fetch('/api/time',{cache:'no-store'})");
    expect(ISLAND).toContain('Date.parse(clockValue.serverNow)+(end-clockStart)/2');
    expect(ISLAND).toContain('base.current.server+performance.now()-base.current.mono');
    expect(ISLAND).toContain('today.workedSeconds+(today.clockedIn&&now!=null?');
    expect(ISLAND).toContain('now-Date.parse(today.serverNow)');
    expect(ISLAND).not.toContain('Date.now()');
  });
  it('renders separate accessible green IN and red OUT controls with state-specific disabling', () => {
    expect(ISLAND).toContain("onClick={()=>openCamera('in')}");
    expect(ISLAND).toContain("onClick={()=>openCamera('out')}");
    expect(ISLAND).toContain('bg-[#12795A]');
    expect(ISLAND).toContain('bg-[#B3402A]');
    expect(ISLAND).toContain('min-h-14');
    expect(ISLAND).toContain('disabled:opacity-[.35]');
  });
  it('keeps one mandatory photo/device/location writer and redirects legacy self-service entry points', () => {
    expect(ISLAND).toContain('navigator.geolocation.getCurrentPosition');
    expect(ISLAND).toContain("navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false})");
    expect(ISLAND).toContain('deviceToken:getStoredDeviceToken()');
    expect(ISLAND).toContain("body.set('photo',photo,'attendance.jpg')");
    expect(ISLAND).toContain("fetch('/api/attendance/clock',{method:'POST'");
    expect(ISLAND).toContain('stream.current?.getTracks().forEach(track=>track.stop())');
    for (const [file, names] of [
      ['../app/me/actions.ts', ['myCheckIn', 'myCheckOut']],
      ['../app/attendance/clock/actions.ts', ['clockInAction', 'clockOutAction']],
    ] as const) {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      for (const name of names) {
        const body = source.slice(source.indexOf(`export async function ${name}`)).split('\n}')[0];
        expect(body).toContain('await getSession()');
        expect(body).toContain("redirect('/attendance/clock')");
        expect(body).not.toMatch(/await check(?:In|Out)\(/);
      }
    }
    // The existing /me wrapper remains a legacy entry point, never an independent photo writer.
    expect(CAPTURE).toContain('export function AttendanceClockButton');
    expect(CAPTURE).not.toContain('/api/attendance/clock');
  });
});

// ─── i18n — the new keys exist in all six locales ────────────────────────────────────────────────────

describe('i18n keys (attendance.clock)', () => {
  const KEYS = ['switchShift', 'shiftEndsAt', 'clockedInAt', 'sessionsToday', 'locationUnknown'];
  for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
    it(`${locale}.json carries the redesign keys`, () => {
      const messages = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../messages/${locale}.json`), 'utf8'),
      );
      const clock = messages.attendance?.clock ?? {};
      for (const key of KEYS) {
        expect(clock[key], `${locale}: attendance.clock.${key}`).toBeTypeOf('string');
      }
      expect(clock.shiftEndsAt).toContain('{time}');
      expect(clock.clockedInAt).toContain('{time}');
      expect(clock.sessionsToday).toContain('{count');
    });
  }
});

// ─── attendancePunchesForRange now carries the matched site + coordinates (integration) ──────────────

let b: Base;
const uniqEmail = () => `clockui_${randomUUID().slice(0, 8)}@t.local`;
const HQ = { lat: 3.139, lng: 101.6869 };
const MON = '2026-07-06';

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

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Clock UI Emp', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

describe('attendancePunchesForRange — per-punch matched site + coordinates (af552c5d)', () => {
  it('carries the geofence-matched clocking-location name and captured coordinates on each punch', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    // 1fff489c — a clocking point now REQUIRES its own radius and a link to a `location` in the same
    // company. Neither is what this test is about; both are supplied so the punch path still runs.
    const { id: locationId } = await createLocation(a, { companyId: b.companyId, code: 'MCH', name: 'Menara Chin Hin' });
    const { id: site } = await createClockingLocation(a, {
      name: 'MENARA CHIN HIN',
      lat: HQ.lat,
      lng: HQ.lng,
      radiusM: 500,
      locationId,
    });
    await setEmployeeClockingLocations(a, { employmentId, clockingLocationIds: [site] });
    await setGeofencing(a, { employmentId, enabled: true, radiusM: 500 });

    await checkIn(a, { employmentId, date: MON, time: '08:36', geo: HQ });
    await checkOut(a, { employmentId, date: MON, time: '12:00', geo: HQ });

    const [dayRow] = await owner.db
      .select({ id: schema.attendance.id })
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, employmentId));
    const trail = (await attendancePunchesForRange(a, employmentId, MON, MON)).get(dayRow.id)!;
    expect(trail).toHaveLength(2);
    for (const punch of trail) {
      expect(punch.locationName).toBe('MENARA CHIN HIN');
      expect(punch.lat).toBeCloseTo(HQ.lat, 6);
      expect(punch.lng).toBeCloseTo(HQ.lng, 6);
    }
    // The pure derivations consume this trail directly (page → island contract).
    expect(ringState(trail.map((p) => ({ time: p.punchAt, direction: p.direction })))).toBe('out');
    expect(completedSessions(trail.map((p) => ({ time: p.punchAt, direction: p.direction })))).toBe(1);
  });

  it('leaves site + coordinates null when geofencing is off and no geo was sent (unchanged behaviour)', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire();
    await checkIn(a, { employmentId, date: MON, time: '09:00' });

    const [dayRow] = await owner.db
      .select({ id: schema.attendance.id })
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, employmentId));
    const trail = (await attendancePunchesForRange(a, employmentId, MON, MON)).get(dayRow.id)!;
    expect(trail).toHaveLength(1);
    expect(trail[0].locationName).toBeNull();
    expect(trail[0].lat).toBeNull();
    expect(trail[0].lng).toBeNull();
  });
});
