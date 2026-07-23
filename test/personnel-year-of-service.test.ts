/**
 * Personnel (Admin) — "Year of Service" on the Employee Information card (feedback cc681bd5).
 *
 * The card shows a read-only, day-precise service duration computed from the Group Join Date (hired_on —
 * the date that stays fixed through internal transfers; join_date is deliberately ignored) to today,
 * recomputed on every render. Covers:
 *   1. serviceYearsMonthsDaysAt (pure): the reporter's three example vectors pinned exactly; month-end
 *      day-borrowing (31 Jan → 1 Mar); leap-year 29-Feb anchors; same-day = 0 days; asOf-before-hire
 *      clamps; and the .years/.months consistency contract with serviceYearsMonthsAt (leave bands).
 *   2. Formatting drop-rules against the REAL message catalogs via createTranslator: leading zero units
 *      drop (8 Months 15 Days / 25 Days), inner zeros stay (10 Years 0 Months 5 Days), singular via ICU
 *      plural (1 Month 19 Days), and all 6 locales resolve every new key with its tokens.
 *   3. Source drift guards (the convention of test/approvals-calendar-deeplink.test.ts): the page builds
 *      the label with exactly the drop-rule conditions mirrored in check 2, falls back to Not Available
 *      on a missing Group Join Date, and wires the i-badge tooltip (native title + aria-label) with the
 *      Group Join Date and as-of date.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { serviceYearsMonthsAt, serviceYearsMonthsDaysAt } from '../core/leave';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('serviceYearsMonthsDaysAt (pure)', () => {
  it("pins the reporter's three example vectors exactly", () => {
    expect(serviceYearsMonthsDaysAt('2020-01-01', '2025-04-13')).toEqual({ years: 5, months: 3, days: 12 });
    expect(serviceYearsMonthsDaysAt('2024-05-15', '2026-07-20')).toEqual({ years: 2, months: 2, days: 5 });
    expect(serviceYearsMonthsDaysAt('2026-06-01', '2026-07-20')).toEqual({ years: 0, months: 1, days: 19 });
  });

  it('borrows through month-end: a 31 Jan hire anchors at 28/29 Feb', () => {
    // 31 Jan + 1 month clamps to 28 Feb (2025 is a common year) → 1 Mar is 1 month 1 day.
    expect(serviceYearsMonthsDaysAt('2025-01-31', '2025-03-01')).toEqual({ years: 0, months: 1, days: 1 });
    // Leap year: the clamp lands on 29 Feb instead.
    expect(serviceYearsMonthsDaysAt('2024-01-31', '2024-03-01')).toEqual({ years: 0, months: 1, days: 1 });
    // Before the borrow point the days count from the un-advanced hire date.
    expect(serviceYearsMonthsDaysAt('2025-01-31', '2025-02-28')).toEqual({ years: 0, months: 0, days: 28 });
  });

  it('handles a 29 Feb (leap year) hire anchor in common years', () => {
    expect(serviceYearsMonthsDaysAt('2024-02-29', '2025-02-28')).toEqual({ years: 0, months: 11, days: 30 });
    expect(serviceYearsMonthsDaysAt('2024-02-29', '2025-03-01')).toEqual({ years: 1, months: 0, days: 1 });
    expect(serviceYearsMonthsDaysAt('2024-02-29', '2028-02-29')).toEqual({ years: 4, months: 0, days: 0 });
  });

  it('same-day service is exactly zero', () => {
    expect(serviceYearsMonthsDaysAt('2026-07-20', '2026-07-20')).toEqual({ years: 0, months: 0, days: 0 });
  });

  it('clamps to all zeros when asOf precedes the hire date', () => {
    expect(serviceYearsMonthsDaysAt('2026-06-01', '2026-01-01')).toEqual({ years: 0, months: 0, days: 0 });
  });

  it('.years/.months always equal serviceYearsMonthsAt (leave service bands can never disagree)', () => {
    const vectors = [
      ['2020-01-01', '2025-04-13'],
      ['2024-05-15', '2026-07-20'],
      ['2026-06-01', '2026-07-20'],
      ['2025-01-31', '2025-03-01'],
      ['2024-02-29', '2025-02-28'],
      ['2018-01-01', '2026-07-01'],
      ['2026-03-31', '2026-03-30'],
    ] as const;
    for (const [from, asOf] of vectors) {
      const ymd = serviceYearsMonthsDaysAt(from, asOf);
      const ym = serviceYearsMonthsAt(from, asOf);
      expect({ years: ymd.years, months: ymd.months }).toEqual(ym);
      expect(ymd.days).toBeGreaterThanOrEqual(0);
    }
  });
});

/** Mirrors the page's smart-format composition exactly — the drift guards below pin the page to these
 *  same conditions, so the two cannot silently diverge. */
function composeLabel(
  t: (key: string, values: { count: number }) => string,
  s: { years: number; months: number; days: number },
): string {
  const parts: string[] = [];
  if (s.years > 0) parts.push(t('yearsUnit', { count: s.years }));
  if (s.years > 0 || s.months > 0) parts.push(t('monthsUnit', { count: s.months }));
  parts.push(t('daysUnit', { count: s.days }));
  return parts.join(' ');
}

describe('Year of Service smart formatting (real en catalog)', () => {
  const messages = JSON.parse(read('messages/en.json'));
  const t = createTranslator({ locale: 'en', messages, namespace: 'people.detail.employmentInfo' });

  it('full three-unit form', () => {
    expect(composeLabel(t, { years: 5, months: 3, days: 12 })).toBe('5 Years 3 Months 12 Days');
  });
  it('INNER zeros stay', () => {
    expect(composeLabel(t, { years: 10, months: 0, days: 5 })).toBe('10 Years 0 Months 5 Days');
  });
  it('leading zero years drops', () => {
    expect(composeLabel(t, { years: 0, months: 8, days: 15 })).toBe('8 Months 15 Days');
  });
  it('leading zero years AND months drop to days only', () => {
    expect(composeLabel(t, { years: 0, months: 0, days: 25 })).toBe('25 Days');
  });
  it('singular units via ICU plural (the reporter example "1 Month 19 Days")', () => {
    expect(composeLabel(t, { years: 0, months: 1, days: 19 })).toBe('1 Month 19 Days');
    expect(composeLabel(t, { years: 1, months: 1, days: 1 })).toBe('1 Year 1 Month 1 Day');
  });
  it('a same-day hire shows 0 Days (never blank)', () => {
    expect(composeLabel(t, { years: 0, months: 0, days: 0 })).toBe('0 Days');
  });
});

describe('i18n — every locale carries the Year of Service keys with valid tokens', () => {
  it.each(LOCALES)('locale %s resolves label, units, notAvailable and tooltip', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'people.detail.employmentInfo' });
    expect(t('yearOfService').length).toBeGreaterThan(0);
    expect(t('notAvailable').length).toBeGreaterThan(0);
    // Unit keys substitute {count} (ICU plural in en/ta; plain in the rest) — a malformed message throws.
    const label = composeLabel(t, { years: 5, months: 3, days: 12 });
    expect(label).toContain('5');
    expect(label).toContain('3');
    expect(label).toContain('12');
    const tip = t('yearOfServiceTooltip', { groupJoinDate: '2020-01-01', asOf: '2025-04-13' });
    expect(tip).toContain('2020-01-01');
    expect(tip).toContain('2025-04-13');
  });
});

describe('drift guards (source assertions)', () => {
  const src = read('app/admin/personnel/[employmentId]/page.tsx');

  it('the page computes the figure from the Group Join Date via serviceYearsMonthsDaysAt', () => {
    expect(src).toContain("import { serviceYearsMonthsAt, serviceYearsMonthsDaysAt } from '@/core/leave';");
    expect(src).toContain('const s = serviceYearsMonthsDaysAt(emp.hiredOn, today);');
  });

  it('the page applies exactly the drop-rule conditions composeLabel mirrors', () => {
    expect(src).toContain("if (s.years > 0) parts.push(t('employmentInfo.yearsUnit', { count: s.years }));");
    expect(src).toContain(
      "if (s.years > 0 || s.months > 0) parts.push(t('employmentInfo.monthsUnit', { count: s.months }));",
    );
    expect(src).toContain("parts.push(t('employmentInfo.daysUnit', { count: s.days }));");
    expect(src).toContain("parts.join(' ')");
  });

  it('a missing Group Join Date falls back to Not Available', () => {
    expect(src).toContain("{yearOfServiceLabel ?? t('employmentInfo.notAvailable')}");
  });

  it('the i-badge tooltip carries the Group Join Date and the as-of date (native title + aria-label)', () => {
    expect(src).toContain("t('employmentInfo.yearOfServiceTooltip', { groupJoinDate: emp.hiredOn, asOf: today })");
    expect(src).toContain('title={yearOfServiceTooltip}');
    expect(src).toContain('aria-label={yearOfServiceTooltip}');
  });

  it('the row renders the Year of Service label on the Employee Information card', () => {
    expect(src).toContain("{t('employmentInfo.yearOfService')}");
  });
});
