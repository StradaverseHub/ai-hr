/**
 * 2166ef79 · My Attendance stage one — WHICH section a day lands in, and what the Fix panel opens with.
 *
 * The value of this file is that it pins REUSE, not a second opinion. The four detections the reporter
 * asks for already existed in core/attendance-derive (flagOf: odd / late / under; statusOf: absent) and
 * have been running on HR's Individual Attendance table since bbada39c. What stage one adds is the
 * grouping and the prefill — so what can silently go wrong is (a) somebody quietly re-implementing a
 * detection here, (b) the precedence between the sections drifting, and (c) a prefill that the request
 * service will refuse. All three are pinned below, with no DB and no fixtures: app/attendance/requests/
 * sections.ts imports only the pure derivation module, which is exactly why that module exists.
 *
 * THE PRODUCTION SHAPES ARE THE FIXTURES. Every case below is a real row shape measured on production on
 * 2026-08-12: 56 days with a clock-in and no clock-out (the dominant problem, 22 people), 41 days carrying
 * status 'late' of which only 6 have late_minutes populated (196 of 270 rows predate the engine that
 * stores them), 0 rows stored as 'absent'.
 */
import { describe, expect, it } from 'vitest';
import {
  KIND_OF_SECTION,
  classifyDay,
  defaultSection,
  groupExceptions,
  parseSection,
  type ExceptionDayInput,
} from '../app/attendance/requests/sections';

/** A clean, fully-clocked 09:00–18:00 workday. Every case below is this, with one thing changed. */
const clean = (over: Partial<ExceptionDayInput> = {}): ExceptionDayInput => ({
  date: '2026-08-05',
  attendanceId: 'att-1',
  status: 'present',
  context: null,
  checkInAt: '09:00:00',
  checkOutAt: '18:00:00',
  dayType: 'workday',
  workedMinutes: 480,
  scheduledMinutes: 480,
  lateMinutes: 0,
  earlyOutMinutes: 0,
  shiftStart: '09:00',
  shiftEnd: '18:00',
  isRosterRest: false,
  ...over,
});

describe('2166ef79 — a clean day is not an exception', () => {
  it('a fully clocked, on-time day is in no section at all', () => {
    expect(classifyDay(clean())).toBeNull();
  });

  it('a rest day, a holiday and an approved leave day are NOT absences', () => {
    for (const context of ['rest_day', 'holiday', 'on_leave'] as const) {
      const day = clean({
        attendanceId: null,
        status: null,
        checkInAt: null,
        checkOutAt: null,
        workedMinutes: null,
        lateMinutes: null,
        earlyOutMinutes: null,
        context,
      });
      expect(classifyDay(day), `${context} must not be flagged`).toBeNull();
    }
  });
});

describe('2166ef79 — Incomplete Entry: the 56-day problem', () => {
  // IMIN BIN AZHAR / 100502, 2026-07-27 — the mockup's own subject, verbatim: clocked in at 09:00, never
  // clocked out, worked_minutes NULL. All 56 production rows of this shape carry a null worked_minutes,
  // which is why the day counts nothing until it is fixed.
  const missingOut = clean({
    date: '2026-07-27',
    checkOutAt: null,
    workedMinutes: null,
    lateMinutes: null,
    earlyOutMinutes: null,
  });

  it('a clock-in with no clock-out is an Incomplete Entry', () => {
    const d = classifyDay(missingOut)!;
    expect(d.section).toBe('incomplete');
    expect(d.flag).toBe('odd');
    expect(d.missing).toBe('out');
  });

  it('THE PREFILL CARRIES THE CLOCK-IN IT ALREADY HAS', () => {
    // Load-bearing, not cosmetic: requestAttendanceCorrection REFUSES a clock-out with no clock-in
    // ("A clock-out time also needs a clock-in time") because it has no anchor to derive against. A Fix
    // panel that proposed only the missing half would be refused on submit, every time.
    const d = classifyDay(missingOut)!;
    expect(d.prefillIn).toBe('09:00');
    expect(d.prefillOut).toBe('18:00'); // the scheduled end — the missing half, proposed
  });

  it('a clock-out with no clock-in proposes the scheduled start for the missing half', () => {
    const d = classifyDay(clean({ checkInAt: null, workedMinutes: null }))!;
    expect(d.section).toBe('incomplete');
    expect(d.missing).toBe('in');
    expect(d.prefillIn).toBe('09:00');
    expect(d.prefillOut).toBe('18:00');
  });
});

describe('2166ef79 — Short Hours, and the 196 rows the engine never touched', () => {
  it('a late arrival with STORED minutes shows them', () => {
    // IMIN, 2026-08-05: in 09:16, out 18:00, late_minutes 16 — the mockup's Short Hours row.
    const d = classifyDay(clean({ checkInAt: '09:16:00', status: 'late', lateMinutes: 16, workedMinutes: 464 }))!;
    expect(d.section).toBe('short');
    expect(d.flag).toBe('late');
    expect(d.lateMinutes).toBe(16);
  });

  it('A LATE DAY WITH NO STORED MINUTES IS STILL LISTED, with an unknown duration', () => {
    // IMIN, 2026-07-28: status 'late', late_minutes NULL, a full 480 worked minutes. 41 production rows
    // carry status 'late' and only 6 have the minutes — a section keyed on the COLUMN would show almost
    // nothing, so membership is keyed on the FLAG and only the duration on the column. NULL is "we do not
    // know", never a confident 0, which would read as "on time" under a heading that says Late.
    const d = classifyDay(clean({ date: '2026-07-28', status: 'late', lateMinutes: null, earlyOutMinutes: null }))!;
    expect(d.section).toBe('short');
    expect(d.flag).toBe('late');
    expect(d.lateMinutes).toBeNull();
  });

  it('an early finish falls back to the shortfall the flag itself measured', () => {
    const d = classifyDay(
      clean({ checkOutAt: '17:00:00', workedMinutes: 420, lateMinutes: null, earlyOutMinutes: null, status: 'present' }),
    )!;
    expect(d.section).toBe('short');
    expect(d.flag).toBe('under');
    expect(d.earlyOutMinutes).toBe(60);
  });

  it('the Fix panel opens on WHAT WAS CLOCKED, both ends editable', () => {
    const d = classifyDay(clean({ checkInAt: '09:16:00', status: 'late', lateMinutes: 16, workedMinutes: 464 }))!;
    expect([d.prefillIn, d.prefillOut]).toEqual(['09:16', '18:00']);
  });
});

describe('2166ef79 — Absent', () => {
  it('a working day with no row at all is an absence, and proposes the whole scheduled day', () => {
    const d = classifyDay(
      clean({
        attendanceId: null,
        status: null,
        checkInAt: null,
        checkOutAt: null,
        workedMinutes: null,
        lateMinutes: null,
        earlyOutMinutes: null,
      }),
    )!;
    expect(d.section).toBe('absent');
    expect([d.prefillIn, d.prefillOut]).toEqual(['09:00', '18:00']);
  });

  it('a row STORED as absent lands there too (0 such rows in production today, but the path exists)', () => {
    const d = classifyDay(
      clean({ status: 'absent', checkInAt: null, checkOutAt: null, workedMinutes: null, lateMinutes: null, earlyOutMinutes: null }),
    )!;
    expect(d.section).toBe('absent');
  });
});

describe('2166ef79 — PRECEDENCE: flagOf decides, and this screen does not re-decide', () => {
  it('a day missing a punch AND carrying lateness is an Incomplete Entry ONLY', () => {
    // Verified on production: 2026-08-10 for employee 100814 carries both a missing clock-out and 60 late
    // minutes. It belongs in Incomplete Entry — lateness on a day you only hold one end of cannot be
    // judged, which is exactly why flagOf puts `odd` above `late`. If this ever fails, somebody has
    // reordered the sections rather than the flag, and the employee's screen and HR's now disagree.
    const day = clean({
      date: '2026-08-10',
      status: 'late',
      checkOutAt: null,
      workedMinutes: null,
      lateMinutes: 60,
      earlyOutMinutes: null,
    });
    const grouped = groupExceptions([day]);
    expect(grouped.incomplete.map((d) => d.date)).toEqual(['2026-08-10']);
    expect(grouped.short).toEqual([]);
    expect(grouped.absent).toEqual([]);
  });

  it('every flagged day appears in exactly one section', () => {
    const days = [
      clean({ date: '2026-08-01', checkOutAt: null, workedMinutes: null }),
      clean({ date: '2026-08-02', status: 'late', lateMinutes: 16, checkInAt: '09:16:00', workedMinutes: 464 }),
      clean({ date: '2026-08-03', attendanceId: null, status: null, checkInAt: null, checkOutAt: null, workedMinutes: null }),
      clean({ date: '2026-08-04' }),
    ];
    const g = groupExceptions(days);
    const all = [...g.incomplete, ...g.short, ...g.absent].map((d) => d.date);
    expect(all.sort()).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('2166ef79 — which section opens, and what the request is filed as', () => {
  it('opens on the first section that has something in it, worst first', () => {
    expect(defaultSection({ incomplete: 1, short: 1, absent: 1 })).toBe('incomplete');
    expect(defaultSection({ incomplete: 0, short: 2, absent: 1 })).toBe('short');
    expect(defaultSection({ incomplete: 0, short: 0, absent: 3 })).toBe('absent');
    // Nothing wrong: Self Overtime, the one section that is never an exception — it is a thing you ask for.
    expect(defaultSection({ incomplete: 0, short: 0, absent: 0 })).toBe('overtime');
  });

  it('each section files under its own stored request_kind', () => {
    expect(KIND_OF_SECTION).toEqual({
      overtime: 'self_overtime',
      short: 'short_hours',
      incomplete: 'incomplete_entry',
      absent: 'absent',
    });
  });

  it('a section is never built out of raw query text', () => {
    expect(parseSection('short')).toBe('short');
    for (const junk of ['', undefined, 'SHORT', '../admin', 'overtime; drop']) {
      expect(parseSection(junk as string | undefined), `${junk}`).toBeNull();
    }
  });
});
