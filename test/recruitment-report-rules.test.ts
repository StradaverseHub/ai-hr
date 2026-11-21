/**
 * Recruitment slice 6 pure rules (packs/recruitment/report-model.ts): the report period, its Kuala Lumpur instants, the
 * previous period, weekly/monthly buckets, rates with zero denominators ("—") and whole-day durations. No database.
 * Expected values are written out by hand from the calendar, not derived from the functions under test.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_VALUE, addDays, averageDays, barPercent, bucketKey, daysBetween, fillBuckets, formatDelta, formatNumber, formatPercent, granularity,
  parseReportFilters, periodBuckets, periodChange, periodInstants, previousPeriod, rate, resolvePeriod,
} from '../packs/recruitment/report-model';

describe('report period', () => {
  it('defaults to the last three months ending today', () => {
    expect(resolvePeriod({}, '2026-11-10')).toEqual({ ok: true, period: { from: '2026-08-11', to: '2026-11-10' } });
    // Month-end clamping comes from the HR date owner: 31 May minus three months is 28 Feb (2027 is not a leap year).
    expect(resolvePeriod({}, '2027-05-31')).toEqual({ ok: true, period: { from: '2027-03-01', to: '2027-05-31' } });
    expect(resolvePeriod({ to: '2026-03-31' }, '2026-11-10')).toEqual({ ok: true, period: { from: '2026-01-01', to: '2026-03-31' } });
  });
  it('allows at most 24 months and refuses reversed or malformed periods', () => {
    expect(resolvePeriod({ from: '2024-04-01', to: '2026-03-31' }, '2026-11-10').ok).toBe(true);
    expect(resolvePeriod({ from: '2024-04-01', to: '2026-04-01' }, '2026-11-10')).toEqual({ ok: false, code: 'period_too_long' });
    // 24 calendar months after 29 Feb 2024 is clamped to 28 Feb 2026, so the last allowed day is 27 Feb 2026.
    expect(resolvePeriod({ from: '2024-02-29', to: '2026-02-27' }, '2026-11-10').ok).toBe(true);
    expect(resolvePeriod({ from: '2024-02-29', to: '2026-02-28' }, '2026-11-10')).toEqual({ ok: false, code: 'period_too_long' });
    expect(resolvePeriod({ from: '2026-03-02', to: '2026-03-01' }, '2026-11-10')).toEqual({ ok: false, code: 'period_invalid' });
    expect(resolvePeriod({ from: '2026-02-30', to: '2026-03-01' }, '2026-11-10')).toEqual({ ok: false, code: 'period_invalid' });
    expect(resolvePeriod({ from: '1 March', to: '2026-03-01' }, '2026-11-10')).toEqual({ ok: false, code: 'period_invalid' });
    expect(resolvePeriod({ from: '2026-03-01', to: '2026-03-01' }, '2026-11-10')).toEqual({ ok: true, period: { from: '2026-03-01', to: '2026-03-01' } });
  });
  it('refuses years outside 2000–2100 and anything the calendar helpers cannot shift, as period_invalid (never a throw)', () => {
    for (const [from, to] of [['0099-01-01', '0099-02-01'], ['9999-01-01', '9999-12-31'], ['9998-06', '9998-07'], ['1999-12-31', '2000-01-31'],
      ['2100-12-01', '2101-01-01'], ['2026-03-01', '+02026-03-31']]) {
      expect(resolvePeriod({ from, to }, '2026-11-10'), `${from}..${to}`).toEqual({ ok: false, code: 'period_invalid' });
    }
    // A "today" outside the range (a broken clock) is refused too, not thrown.
    expect(resolvePeriod({}, '9999-12-31')).toEqual({ ok: false, code: 'period_invalid' });
    expect(resolvePeriod({ from: '2000-01-01', to: '2001-12-31' }, '2026-11-10').ok).toBe(true);
    expect(resolvePeriod({ from: '2099-01-01', to: '2100-12-31' }, '2026-11-10').ok).toBe(true);
  });
  it('parses GET filters: ids must be UUIDs, anything else is dropped', () => {
    const id = '7d3f1d2e-1111-4222-8333-944455556666';
    expect(parseReportFilters({ companyId: id, jobId: 'x; drop', departmentId: '', from: '2026-03-01', to: '2026-03-31' }, '2026-11-10'))
      .toEqual({ ok: true, filters: { companyId: id, jobId: null, departmentId: null, period: { from: '2026-03-01', to: '2026-03-31' } } });
    expect(parseReportFilters({ from: '2023-01-01', to: '2026-03-31' }, '2026-11-10')).toEqual({ ok: false, code: 'period_too_long' });
  });
  it('maps the period onto Kuala Lumpur midnights, end exclusive', () => {
    expect(periodInstants({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ fromTs: '2026-03-01T00:00:00+08:00', toTs: '2026-04-01T00:00:00+08:00' });
    expect(periodInstants({ from: '2028-02-28', to: '2028-02-29' }).toTs).toBe('2028-03-01T00:00:00+08:00');
    // 1 Mar 00:00 KL is 28 Feb 16:00 UTC: inside the period although its UTC day is February.
    expect(new Date('2026-03-01T00:00:00+08:00').toISOString()).toBe('2026-02-28T16:00:00.000Z');
  });
  it('compares with the previous period of equal length', () => {
    expect(previousPeriod({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-01-29', to: '2026-02-28' });
    expect(previousPeriod({ from: '2026-03-02', to: '2026-03-08' })).toEqual({ from: '2026-02-23', to: '2026-03-01' });
    expect(periodChange(4, 1)).toEqual({ delta: 3, rate: 3 });
    expect(periodChange(0, 4)).toEqual({ delta: -4, rate: -1 });
    expect(periodChange(2, 0)).toEqual({ delta: 2, rate: null });
  });
  it('does calendar arithmetic independent of the host time zone', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(daysBetween('2026-03-01', '2026-03-20')).toBe(19);
    expect(daysBetween('2026-03-20', '2026-03-01')).toBe(-19);
  });
});

describe('trend buckets', () => {
  it('uses Monday-start weeks for periods up to 13 weeks, calendar months beyond', () => {
    expect(granularity({ from: '2026-01-01', to: '2026-04-01' })).toBe('week'); // 91 days
    expect(granularity({ from: '2026-01-01', to: '2026-04-02' })).toBe('month'); // 92 days
  });
  it('finds the Monday on or before a day, and the first of its month', () => {
    expect(bucketKey('2026-03-01', 'week')).toBe('2026-02-23'); // Sunday
    expect(bucketKey('2026-03-02', 'week')).toBe('2026-03-02'); // Monday
    expect(bucketKey('2026-03-15', 'week')).toBe('2026-03-09'); // Sunday
    expect(bucketKey('2027-01-03', 'week')).toBe('2026-12-28'); // across a year end
    expect(bucketKey('2026-02-28', 'month')).toBe('2026-02-01');
  });
  it('lists every bucket the period touches, clipped to it, and fills empty ones with zero', () => {
    expect(periodBuckets({ from: '2026-03-01', to: '2026-03-17' }, 'week')).toEqual([
      { key: '2026-02-23', from: '2026-03-01', to: '2026-03-01' },
      { key: '2026-03-02', from: '2026-03-02', to: '2026-03-08' },
      { key: '2026-03-09', from: '2026-03-09', to: '2026-03-15' },
      { key: '2026-03-16', from: '2026-03-16', to: '2026-03-17' },
    ]);
    expect(periodBuckets({ from: '2026-01-31', to: '2026-03-01' }, 'month')).toEqual([
      { key: '2026-01-01', from: '2026-01-31', to: '2026-01-31' },
      { key: '2026-02-01', from: '2026-02-01', to: '2026-02-28' },
      { key: '2026-03-01', from: '2026-03-01', to: '2026-03-01' },
    ]);
    expect(fillBuckets({ from: '2026-01-31', to: '2026-03-01' }, new Map([['2026-02-01', 4]]), 'month').map((b) => b.count)).toEqual([0, 4, 0]);
    // 24 months by month: 25 buckets when the period does not start on the 1st.
    expect(periodBuckets({ from: '2024-04-15', to: '2026-04-14' })).toHaveLength(25);
  });
});

describe('rates and durations', () => {
  it('a zero denominator gives null, shown as "—", never 0 or an error', () => {
    expect(rate(3, 4)).toBe(0.75);
    expect(rate(0, 4)).toBe(0);
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
    expect(formatPercent(null, 'en')).toBe(NO_VALUE);
    expect(formatNumber(null, 'en')).toBe(NO_VALUE);
    expect(NO_VALUE).toBe('—');
    expect(formatPercent(0.75, 'en')).toBe('75%');
    expect(formatPercent(1 / 3, 'en')).toBe('33.3%');
    expect(formatPercent(0, 'en')).toBe('0%');
    expect(formatNumber(3.5, 'en')).toBe('3.5');
    expect(formatDelta(3, 'en')).toBe('+3');
    expect(formatDelta(0, 'en')).toBe('0');
  });
  it('averages whole days and rounds to a whole day', () => {
    expect(averageDays(0, 0)).toBeNull();
    expect(averageDays(19, 1)).toBe(19);
    expect(averageDays(19 + 20, 2)).toBe(20); // 19.5 rounds half up
    expect(averageDays(10 + 11 + 11, 3)).toBe(11); // 10.67
  });
  it('sizes CSS bars within 0–100', () => {
    expect(barPercent(1, 3)).toBe(33);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(7, 5)).toBe(100);
  });
});
