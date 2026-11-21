/**
 * Recruitment slice 17 — the pure waiting-limit rules (packs/recruitment/waiting-model.ts): calendar and working days at Kuala Lumpur
 * day boundaries, the cutoff day used by the set-based reads, threshold levels, the rule validation and the filter. Case 116's
 * arithmetic; the database half is test/recruitment-waiting.test.ts.
 *
 * Expected values are computed here by a separate, deliberately simple loop over JavaScript Date objects (UTC getUTCDay) — never
 * with the module under test — and a few are written out by hand from a calendar.
 */
import { describe, expect, it } from 'vitest';
import {
  HOLIDAY_LOOKBACK_DAYS, WAITING_ARCHIVE_MAX, WAITING_REMIND_MAX, addDays, holidayWindowStart, isWeekend, parseWaitingFilter, ruleCutoffs, validateWaitingRule,
  waitingCutoff, waitingDays, waitingLevel,
} from '../packs/recruitment/service';

/** Independent oracle: walk day by day with Date.UTC and count. */
function oracleDays(entered: string, today: string, kind: 'calendar' | 'working', holidays: Set<string>): number {
  const start = new Date(`${entered}T00:00:00Z`), end = new Date(`${today}T00:00:00Z`);
  let n = 0;
  for (const d = new Date(start); d < end;) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (kind === 'calendar') n++;
    else if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(iso)) n++;
  }
  return n;
}
const shift = (iso: string, days: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

// 2026-08-28 is a Friday; 2026-08-31 (a Monday) is treated as a public holiday in this set; 2026-09-08 is a Tuesday.
const HOLIDAYS = new Set(['2026-08-31', '2026-09-16']);

describe('case 116 — waiting days in calendar and working days', () => {
  it('matches hand-counted values across a weekend and a configured holiday', () => {
    // Calendar: 28 Aug → 8 Sep is eleven days.
    expect(waitingDays('2026-08-28', '2026-09-08', 'calendar', HOLIDAYS)).toBe(11);
    // Working: 31 Aug (holiday) skipped; 29–30 Aug and 5–6 Sep are weekends; counted: 1, 2, 3, 4 Sep, 7, 8 Sep = 6.
    expect(waitingDays('2026-08-28', '2026-09-08', 'working', HOLIDAYS)).toBe(6);
    // Without the holiday the Monday counts: 7.
    expect(waitingDays('2026-08-28', '2026-09-08', 'working', new Set())).toBe(7);
    // The entry day itself never counts; entering today (or a future day) is zero.
    expect(waitingDays('2026-09-08', '2026-09-08', 'working', HOLIDAYS)).toBe(0);
    expect(waitingDays('2026-09-09', '2026-09-08', 'calendar', HOLIDAYS)).toBe(0);
    // Friday → Monday holiday → Tuesday: one working day (Tuesday).
    expect(waitingDays('2026-08-28', '2026-09-01', 'working', HOLIDAYS)).toBe(1);
  });

  it('agrees with the independent day-by-day count for every entry day over two months and every kind', () => {
    const today = '2026-09-17';
    for (let back = 0; back <= 70; back++) {
      const entered = shift(today, -back);
      for (const kind of ['calendar', 'working'] as const) {
        expect(waitingDays(entered, today, kind, HOLIDAYS), `${entered} ${kind}`).toBe(oracleDays(entered, today, kind, HOLIDAYS));
      }
    }
  });

  it('the cutoff day: entered on or before it ⇔ waited at least N days (checked against the oracle, not the module)', () => {
    for (const today of ['2026-09-08', '2026-09-12', '2026-09-13', '2026-09-17', '2026-01-01']) {
      for (const kind of ['calendar', 'working'] as const) {
        for (const n of [1, 2, 3, 5, 10, 21]) {
          const cutoff = waitingCutoff(today, n, kind, HOLIDAYS);
          for (let back = 0; back <= 60; back++) {
            const entered = shift(today, -back);
            expect(entered <= cutoff, `${today} ${kind} ${n} ${entered}`).toBe(oracleDays(entered, today, kind, HOLIDAYS) >= n);
          }
        }
      }
    }
    // Written out: three working days back from Tuesday 8 Sep (holiday Monday 31 Aug): Tue 8, Mon 7, Fri 4 → the day before Fri 4.
    expect(waitingCutoff('2026-09-08', 3, 'working', HOLIDAYS)).toBe('2026-09-03');
    expect(waitingCutoff('2026-09-08', 3, 'calendar', HOLIDAYS)).toBe('2026-09-05');
    expect(() => waitingCutoff('2026-09-08', 0, 'calendar')).toThrow();
  });

  it('cutoffs and levels for a rule', () => {
    expect(ruleCutoffs({ remindDays: 3, archiveDays: 10, dayKind: 'calendar' }, '2026-09-08')).toEqual({ remindOn: '2026-09-05', archiveOn: '2026-08-29' });
    expect(ruleCutoffs({ remindDays: 3, archiveDays: null, dayKind: 'working' }, '2026-09-08', HOLIDAYS)).toEqual({ remindOn: '2026-09-03', archiveOn: null });
    const rule = { remindDays: 3, archiveDays: 10 };
    expect([0, 2, 3, 9, 10, 400].map((d) => waitingLevel(d, rule))).toEqual(['none', 'none', 'waiting', 'waiting', 'suggested', 'suggested']);
    expect(waitingLevel(400, { remindDays: 3, archiveDays: null })).toBe('waiting');
  });

  it('date helpers stay on the calendar (no host time zone) and the holiday window covers the longest limit', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(['2026-09-05', '2026-09-06', '2026-09-07'].map(isWeekend)).toEqual([true, true, false]);
    expect(() => addDays('2026-02-30', 1)).toThrow();
    expect(HOLIDAY_LOOKBACK_DAYS).toBeGreaterThan(Math.ceil(WAITING_ARCHIVE_MAX * 7 / 5) + 60);
    expect(holidayWindowStart('2026-09-08')).toBe(`${new Date(Date.UTC(2026, 8, 8) - HOLIDAY_LOOKBACK_DAYS * 86_400_000).getUTCFullYear()}-01-01`);
  });
});

describe('case 115 — thresholds are validated', () => {
  it('accepts the documented ranges and refuses the rest by field', () => {
    expect(validateWaitingRule({ remindDays: '1', archiveDays: '', dayKind: 'calendar' })).toEqual({ ok: true, value: { remindDays: 1, archiveDays: null, dayKind: 'calendar' } });
    expect(validateWaitingRule({ remindDays: String(WAITING_REMIND_MAX), archiveDays: String(WAITING_ARCHIVE_MAX), dayKind: 'working' }))
      .toEqual({ ok: true, value: { remindDays: 365, archiveDays: 730, dayKind: 'working' } });
    expect(validateWaitingRule({ remindDays: '', dayKind: '' })).toEqual({ ok: false, code: 'missing_fields', fields: ['remindDays', 'dayKind'] });
    const bad = (input: Record<string, unknown>) => { const v = validateWaitingRule(input); return v.ok ? 'ok' : `${v.code}:${v.fields.join(',')}`; };
    expect(bad({ remindDays: '0', dayKind: 'calendar' })).toBe('invalid_input:remindDays');
    expect(bad({ remindDays: '366', dayKind: 'calendar' })).toBe('invalid_input:remindDays');
    expect(bad({ remindDays: '2.5', dayKind: 'calendar' })).toBe('invalid_input:remindDays');
    expect(bad({ remindDays: '-3', dayKind: 'calendar' })).toBe('invalid_input:remindDays');
    expect(bad({ remindDays: '5', archiveDays: '5', dayKind: 'calendar' })).toBe('invalid_input:archiveDays');
    expect(bad({ remindDays: '5', archiveDays: '4', dayKind: 'calendar' })).toBe('invalid_input:archiveDays');
    expect(bad({ remindDays: '5', archiveDays: '731', dayKind: 'calendar' })).toBe('invalid_input:archiveDays');
    expect(bad({ remindDays: '5', archiveDays: 'ten', dayKind: 'calendar' })).toBe('invalid_input:archiveDays');
    expect(bad({ remindDays: '5', dayKind: 'fortnights' })).toBe('invalid_input:dayKind');
    expect(['waiting', 'suggested', 'all', '', undefined, 7].map(parseWaitingFilter)).toEqual(['waiting', 'suggested', null, null, null, null]);
  });
});
