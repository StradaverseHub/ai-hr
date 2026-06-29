/**
 * Hourly-leave time window (0129) — From/To time selection for hourly leave.
 *
 * For a duration_type='hourly' request the applicant now picks a From time + To time (both mandatory). The
 * service derives `hours` from the elapsed span (hoursBetween), persists from_time/to_time, and surfaces the
 * window on the approvals inbox + history. Covers: hoursBetween arithmetic + the seconds-format round-trip,
 * the mandatory gate, the elapsed-window upper bound (no net-<=8 cap), the persisted window + read-back, the
 * raw-hours back-compat path, and the pinned same-date hourly-vs-hourly conflict (out-of-scope, unchanged).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  hoursBetween,
  HourlyLeaveTimeRangeError,
  requestLeave,
  type LeaveDurationType,
} from '../core/leave';
import { listLeaveRequests } from '../core/read';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let employmentId: string;

const ALL: LeaveDurationType[] = ['half_day_am', 'half_day_pm', 'hourly'];

async function hire() {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Win', primaryEmail: `win_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
}

async function leaveType(opts: { durations: LeaveDurationType[] | null }) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `WIN_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Win',
      paid: true,
      counting: 'calendar_days',
      durations: opts.durations,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function grant(leaveTypeId: string, days = '30.00') {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

/** Read the persisted row including the new window columns. */
const rowOf = async (leaveRequestId: string) => {
  const [r] = await owner.db
    .select({
      days: schema.leaveRequest.days,
      durationType: schema.leaveRequest.durationType,
      hours: schema.leaveRequest.hours,
      fromTime: schema.leaveRequest.fromTime,
      toTime: schema.leaveRequest.toTime,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, leaveRequestId));
  return r;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  employmentId = await hire();
});
afterAll(async () => {
  await closeAll();
});

describe('0129 — hoursBetween (pure helper)', () => {
  it('computes elapsed hours from an HH:MM window', () => {
    expect(hoursBetween('09:00', '11:00')).toBe(2);
    expect(hoursBetween('09:30', '10:00')).toBe(0.5);
    expect(hoursBetween('09:00', '09:25')).toBe(0.42); // 25 min → 0.4166… → 0.42
  });

  it('normalizes the Postgres seconds format (HH:MM:SS) identically to HH:MM — the headline bug', () => {
    expect(hoursBetween('09:00:00', '11:00:00')).toBe(2);
    expect(hoursBetween('09:00:00', '11:00')).toBe(2);
    expect(hoursBetween('09:00', '11:00:00')).toBe(2);
  });

  it('throws HourlyLeaveTimeRangeError on an empty input or a non-positive span', () => {
    expect(() => hoursBetween('', '11:00')).toThrow(HourlyLeaveTimeRangeError);
    expect(() => hoursBetween('11:00', '')).toThrow(HourlyLeaveTimeRangeError);
    expect(() => hoursBetween('11:00', '09:00')).toThrow(HourlyLeaveTimeRangeError); // to < from
    expect(() => hoursBetween('09:00', '09:00')).toThrow(HourlyLeaveTimeRangeError); // to == from
  });
});

describe('0129 — requestLeave with a From/To window', () => {
  it('derives hours from the window, persists from_time/to_time, and days = round(hours/8, 2)', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const before = await ledgerBalance(employmentId, lt);

    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      durationType: 'hourly',
      fromTime: '09:00',
      toTime: '11:00',
    });
    expect(res.days).toBe(0.25); // 2h / 8 = 0.25

    const row = await rowOf(res.leaveRequestId);
    expect(row.hours).toBe('2.00');
    expect(row.days).toBe('0.25');
    expect(row.durationType).toBe('hourly');
    // Window persisted (Postgres returns HH:MM:SS).
    expect(row.fromTime).toBe('09:00:00');
    expect(row.toTime).toBe('11:00:00');
    void before;
  });

  it('a cross-lunch window 09:00–18:00 (9 elapsed h) is accepted — the net-<=8 cap was dropped', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      durationType: 'hourly',
      fromTime: '09:00',
      toTime: '18:00',
    });
    const row = await rowOf(res.leaveRequestId);
    expect(row.hours).toBe('9.00'); // 9 elapsed hours, not rejected
    expect(res.days).toBe(1.13); // 9 / 8 = 1.125 → 1.13
  });

  it('the From/To window is MANDATORY: missing either side throws HourlyLeaveTimeRangeError', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const base = {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      durationType: 'hourly' as const,
    };
    await expect(requestLeave(adminCtx(b), { ...base, fromTime: '09:00' })).rejects.toThrow(
      HourlyLeaveTimeRangeError,
    );
    await expect(requestLeave(adminCtx(b), { ...base, toTime: '11:00' })).rejects.toThrow(
      HourlyLeaveTimeRangeError,
    );
    // Neither a window nor a raw figure ⇒ the mandatory window is missing.
    await expect(requestLeave(adminCtx(b), { ...base })).rejects.toThrow(HourlyLeaveTimeRangeError);
  });

  it('to <= from on the window throws HourlyLeaveTimeRangeError', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: lt,
        startDate: '2026-07-06',
        endDate: '2026-07-06',
        durationType: 'hourly',
        fromTime: '15:00',
        toTime: '14:00',
      }),
    ).rejects.toThrow(HourlyLeaveTimeRangeError);
  });

  it('back-compat: a raw `hours` figure with no window still works and leaves the window null', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      durationType: 'hourly',
      hours: 2,
    });
    expect(res.days).toBe(0.25);
    const row = await rowOf(res.leaveRequestId);
    expect(row.hours).toBe('2.00');
    expect(row.fromTime).toBeNull();
    expect(row.toTime).toBeNull();
  });

  it('full_day / half_day rows leave both window columns null', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    const full = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      durationType: 'full_day',
    });
    const fr = await rowOf(full.leaveRequestId);
    expect(fr.fromTime).toBeNull();
    expect(fr.toTime).toBeNull();

    const half = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-07',
      endDate: '2026-07-07',
      durationType: 'half_day_am',
    });
    const hr = await rowOf(half.leaveRequestId);
    expect(hr.fromTime).toBeNull();
    expect(hr.toTime).toBeNull();
  });
});

describe('0129 — read round-trip (the seconds bug, end-to-end)', () => {
  it('listLeaveRequests surfaces the window, and a .slice(0,5) renders 09:00–11:00 not 09:00:00–11:00:00', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      durationType: 'hourly',
      fromTime: '09:00',
      toTime: '11:00',
    });
    const rows = await listLeaveRequests(adminCtx(b));
    const r = rows.find((x) => x.durationType === 'hourly');
    expect(r).toBeTruthy();
    // The raw column comes back with the Postgres seconds…
    expect(r!.fromTime).toBe('09:00:00');
    expect(r!.toTime).toBe('11:00:00');
    // …but the display-boundary slice(0, 5) normalizes it to HH:MM.
    const rendered = `${r!.fromTime!.slice(0, 5)}–${r!.toTime!.slice(0, 5)}`;
    expect(rendered).toBe('09:00–11:00');
  });
});

describe('0129 — same-date hourly conflict (out-of-scope, pinned)', () => {
  it('two NON-overlapping hourly windows on the same date are still rejected as conflicting', async () => {
    const lt = await leaveType({ durations: ALL });
    await grant(lt);
    await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: lt,
      startDate: '2026-07-06',
      endDate: '2026-07-06',
      durationType: 'hourly',
      fromTime: '09:00',
      toTime: '10:00',
    });
    // 15:00–16:00 does not overlap 09:00–10:00, but the existing logic treats any hourly-vs-hourly same-date
    // as a conflict. This deferral is deliberate (overlap-aware detection is out of scope); pin it so a future
    // change is caught.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: lt,
        startDate: '2026-07-06',
        endDate: '2026-07-06',
        durationType: 'hourly',
        fromTime: '15:00',
        toTime: '16:00',
      }),
    ).rejects.toThrow(/conflicting/);
  });
});
