/**
 * Personnel (Admin) — "Year of Service" on the top Employee Information (summary) card.
 *
 * cc681bd5 introduced the figure on the Employment Information card inside the Employment tab;
 * b75b2a23 moved it onto the TOP summary card (photo / Employee ID / Status / Department / Position /
 * Direct Superior / Company / Group Join Date) so it is visible the moment any profile opens, and removed
 * the Employment-tab ROW that used to carry it.
 *
 * READ THIS BEFORE ADDING A DISPLAY: b75b2a23's "exactly one authoritative display" no longer holds, and
 * 4ea70bb7 is what ended it. The Employment tab's Group Service caption is now the same figure, from the
 * same date, through the same formatter, so the page shows it twice on purpose — one figure, two
 * captions. The invariant that DOES still hold, and that these tests pin, is one CALCULATION: every
 * service string on the page comes from the single fmtServiceYmd over core/leave's
 * serviceYearsMonthsDaysAt (see the "ONE formatter serves all three figures" case below). A third
 * caption is a product question; a second piece of date arithmetic is a defect.
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
 *      on a missing Group Join Date, wires the i-badge tooltip (native title + aria-label) with the
 *      Group Join Date and as-of date, renders the row as a dt/dd pair on the top summary-card grid
 *      immediately after the Group Join Date, and no longer renders the row it used to occupy on the
 *      Employment Information card. (Not a no-duplication guard: as of 4ea70bb7 the Employment DATES
 *      card's Group Service caption prints the identical string — see the note above.)
 *
 * 4ea70bb7 widened the file to the WHOLE of the Employment tab's length-of-service story, because that is
 * now one story: the tab's Group Service and Current Company Service went from whole years-and-months
 * ("0 Years 0 Months" for a July joiner; "1 Years 11 Months") to the same day-precise figure through the
 * same formatter. Added here rather than in a parallel file so the format has exactly one set of
 * expectations:
 *   4. The four production vectors as of 2026-08-17, and the two figures' INDEPENDENCE — an employment
 *      whose Join Date differs from its Group Join Date must render two DIFFERENT strings. Today's shipped
 *      code cannot fail that case: both sides rounded to "0 Years 0 Months".
 *   5. The rename: nav.personnelAdmin / people.list.adminTitle / people.wizard.backLabel /
 *      people.detail.headerGroupJoinDate in all six locales, AND the trap — people.list.title is shared
 *      with the employee-facing /personnel directory, so it must still read the directory's own name and
 *      the admin page must resolve adminTitle instead.
 *   6. employmentInfo.serviceLength is GONE from all six catalogues, not merely unused (the r191 class of
 *      debt: a key nothing resolves is a stale value waiting to be picked up again).
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
    // 4ea70bb7 UPDATED this case. The figure is no longer computed by an IIFE of its own: the same
    // day-precise arithmetic now serves all three service figures on the page through one local
    // fmtServiceYmd(from), so the call reads `from` rather than `emp.hiredOn` and Year of Service is the
    // formatter applied to emp.hiredOn. serviceYearsMonthsAt is no longer imported here — the Employment
    // tab's whole-months formatter was the only caller — but core/leave still exports it for the leave
    // service bands, and the .years/.months equality contract above is what keeps the two agreeing.
    expect(src).toContain("import { serviceYearsMonthsDaysAt } from '@/core/leave';");
    expect(src).toContain('const s = serviceYearsMonthsDaysAt(from, today);');
    expect(src).toContain('const yearOfServiceLabel = fmtServiceYmd(emp.hiredOn);');
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
    // r422 — both dates are drawn DD-MMM-YYYY (lib/date-display.ts); still the Group Join Date and today.
    expect(src).toContain(
      "t('employmentInfo.yearOfServiceTooltip', { groupJoinDate: formatDmy(emp.hiredOn), asOf: formatDmy(today) })",
    );
    expect(src).toContain('title={yearOfServiceTooltip}');
    expect(src).toContain('aria-label={yearOfServiceTooltip}');
  });

  it('renders as a dt/dd pair on the top summary card, immediately after the Group Join Date (b75b2a23)', () => {
    // The summary-card <dl> lists Employee ID … Company, then the Group Join Date, then Year of Service.
    // Pin the label into a <dt> (the grid's term/definition pattern), positioned after that date pair and
    // before the grid's closing </dl>. 4ea70bb7 renamed the anchoring label from headerJoinDate to
    // headerGroupJoinDate — the <dd> beside it has always been emp.hiredOn, the GROUP date.
    expect(src).toContain('<dt className="text-xs text-muted-foreground">{t(\'employmentInfo.yearOfService\')}</dt>');
    const joinDateAt = src.indexOf("t('headerGroupJoinDate')");
    const yearOfServiceAt = src.indexOf("<dt className=\"text-xs text-muted-foreground\">{t('employmentInfo.yearOfService')}</dt>");
    expect(joinDateAt).toBeGreaterThan(-1);
    expect(yearOfServiceAt).toBeGreaterThan(joinDateAt);
    const dlCloseAt = src.indexOf('</dl>', joinDateAt);
    expect(dlCloseAt).toBeGreaterThan(-1);
    expect(yearOfServiceAt).toBeLessThan(dlCloseAt);
  });

  it('the Employment Information card no longer duplicates the row (single authoritative display)', () => {
    // Exactly ONE render of the label in the whole page — and it sits in the summary-card grid pinned
    // above, not inside the Employment Information card (#section-employment-info).
    const renders = src.split("{t('employmentInfo.yearOfService')}").length - 1;
    expect(renders).toBe(1);
    const employmentCardAt = src.indexOf('id="section-employment-info"');
    const summaryGridAt = src.indexOf('<dl className="grid flex-1 grid-cols-2');
    const yearOfServiceAt = src.indexOf("{t('employmentInfo.yearOfService')}");
    expect(employmentCardAt).toBeGreaterThan(-1);
    expect(summaryGridAt).toBeGreaterThan(employmentCardAt); // the summary grid JSX sits after the card const
    expect(yearOfServiceAt).toBeGreaterThan(summaryGridAt);
  });
});

/**
 * 4ea70bb7 — the Employment tab's two length-of-service figures.
 *
 * They were "{years} Years {months} Months" (employmentInfo.serviceLength) off serviceYearsMonthsAt, which
 * told a July joiner they had "0 Years 0 Months" of service and an employee of one year "1 Years 11 Months".
 * Both now go through the SAME day-precise formatter as Year of Service — one calculation, three captions.
 */
describe('Employment tab service figures — day-precise and independent (4ea70bb7)', () => {
  const messages = JSON.parse(read('messages/en.json'));
  const t = createTranslator({ locale: 'en', messages, namespace: 'people.detail.employmentInfo' });
  /** What the page does: fmtServiceYmd(from) — null in, null out (the caption falls back to an em dash). */
  const fmt = (from: string | null | undefined, asOf: string): string | null =>
    from ? composeLabel(t, serviceYearsMonthsDaysAt(from, asOf)) : null;

  const ASOF = '2026-08-17'; // the day the production figures below were read off the live database

  it('pins the four production vectors to the day', () => {
    expect(fmt('2016-10-04', ASOF)).toBe('9 Years 10 Months 13 Days'); // A0014 — was "9 Years 10 Months"
    expect(fmt('2019-05-02', ASOF)).toBe('7 Years 3 Months 15 Days'); // A0006
    expect(fmt('2024-09-02', ASOF)).toBe('1 Year 11 Months 15 Days'); // A0007 — was "1 Years 11 Months"
    expect(fmt('2026-07-23', ASOF)).toBe('25 Days'); // 100814 — was "0 Years 0 Months"
  });

  it('the July joiner no longer reads as no service at all', () => {
    // The whole point of the item: the old format rounded a real month of service away to nothing.
    const old = serviceYearsMonthsAt('2026-07-23', ASOF);
    expect(old).toEqual({ years: 0, months: 0 }); // what the tab used to render, verbatim
    expect(fmt('2026-07-23', ASOF)).toBe('25 Days');
  });

  it('Group Service and Current Company Service are computed INDEPENDENTLY from their own dates', () => {
    // employee_code 100814: joined the group 23 Jul, moved to ISEDECOR BINA 11 Aug. The one production row
    // where the two dates differ — and the case the shipped whole-months format could not fail, because it
    // rounded BOTH sides to "0 Years 0 Months".
    const hiredOn = '2026-07-23';
    const joinDate = '2026-08-11';
    const group = fmt(hiredOn, ASOF);
    const current = fmt(joinDate ?? hiredOn, ASOF);
    expect(group).toBe('25 Days');
    expect(current).toBe('6 Days');
    expect(current).not.toBe(group);
    // Under the OLD format the two were indistinguishable — this is the regression the case exists to catch.
    expect(serviceYearsMonthsAt(hiredOn, ASOF)).toEqual(serviceYearsMonthsAt(joinDate, ASOF));
  });

  it('a NULL Join Date still falls back to the Group Join Date (22 of 40 rows carry none)', () => {
    const hiredOn = '2016-10-04';
    const joinDate = null;
    expect(fmt(joinDate ?? hiredOn, ASOF)).toBe(fmt(hiredOn, ASOF));
  });

  it('a missing Group Join Date yields no caption at all (the em-dash fallback)', () => {
    expect(fmt(null, ASOF)).toBeNull();
    expect(fmt(undefined, ASOF)).toBeNull();
  });

  it('the tab and the summary card cannot disagree — same formatter, same date', () => {
    const hiredOn = '2016-10-04';
    expect(fmt(hiredOn, ASOF)).toBe(composeLabel(t, serviceYearsMonthsDaysAt(hiredOn, ASOF)));
  });
});

describe('Employment tab source guards (4ea70bb7)', () => {
  const src = read('app/admin/personnel/[employmentId]/page.tsx');

  it('both captions resolve through the Y/M/D helper, not through serviceLength', () => {
    expect(src).toContain('const groupServiceLabel = fmtServiceYmd(emp.hiredOn);');
    expect(src).toContain('const currentServiceLabel = fmtServiceYmd(emp.joinDate ?? emp.hiredOn);');
    // No call site left for the whole-months key or the whole-months function anywhere on the page.
    expect(src).not.toContain("t('employmentInfo.serviceLength'");
    expect(src).not.toContain('serviceYearsMonthsAt(');
  });

  it('the two captions still render under their own labels', () => {
    expect(src).toContain("{t('employmentInfo.groupService')}: {groupServiceLabel ?? '—'}");
    expect(src).toContain("{t('employmentInfo.currentCompanyService')}: {currentServiceLabel ?? '—'}");
  });

  it('ONE formatter serves all three figures (no second piece of date arithmetic)', () => {
    expect(src.split('serviceYearsMonthsDaysAt(').length - 1).toBe(1);
    expect(src.split('const fmtServiceYmd =').length - 1).toBe(1);
  });

  it('the summary card labels emp.hiredOn as the GROUP join date', () => {
    expect(src).toContain('{t(\'headerGroupJoinDate\')}</dt>');
    expect(src).not.toContain("t('headerJoinDate')");
  });
});

describe('Personnel Management rename (4ea70bb7)', () => {
  const catalogues = Object.fromEntries(
    LOCALES.map((loc) => [loc, JSON.parse(read(`messages/${loc}.json`))]),
  ) as Record<(typeof LOCALES)[number], Record<string, never>>;
  const at = (obj: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

  it.each(LOCALES)('locale %s carries every renamed key with a non-empty value', (loc) => {
    for (const key of [
      'nav.personnelAdmin', // sidebar AND the security-and-permissions list (lib/permissions labelKey)
      'people.list.adminTitle', // the admin list heading — NOT people.list.title
      'people.wizard.backLabel', // Create New Employee → Back link
      'people.detail.backToPersonnelAdmin', // admin profile → Back link (NOT the shared backToPeople)
      'people.import.backLabel', // Import employees → Back link
      'people.detail.headerGroupJoinDate', // summary card, relabelled over the same emp.hiredOn value
    ]) {
      const v = at(catalogues[loc], key);
      expect(typeof v === 'string' && v.length > 0, `${loc} ${key}`).toBe(true);
    }
  });

  it.each(LOCALES)('locale %s keeps the employee-facing directory its OWN name', (loc) => {
    // THE TRAP: people.list.title is rendered by app/personnel/page.tsx (the directory everybody sees), by
    // the Excel export header and by the leave tracker. It must NOT have become "Personnel Management".
    const listTitle = at(catalogues[loc], 'people.list.title');
    const adminTitle = at(catalogues[loc], 'people.list.adminTitle');
    const navPeople = at(catalogues[loc], 'nav.people');
    expect(listTitle).toBe(navPeople); // directory heading and its menu entry, still one name
    expect(listTitle).not.toBe(adminTitle);
    expect(at(catalogues[loc], 'nav.personnelAdmin')).toBe(adminTitle);
  });

  it.each(LOCALES)('locale %s gives ONE name to every back link into /admin/personnel', (loc) => {
    // Three links land on /admin/personnel: the admin profile's, the import screen's and the wizard's.
    // Before this item they read People / People / Back to Personnel while the page they arrive at was
    // headed Personnel — renaming the module without them would have left a link labelled "People"
    // arriving at "Personnel Management". All three now carry the admin module's name.
    const adminTitle = at(catalogues[loc], 'people.list.adminTitle') as string;
    expect(at(catalogues[loc], 'people.detail.backToPersonnelAdmin')).toBe(adminTitle);
    expect(at(catalogues[loc], 'people.import.backLabel')).toBe(adminTitle);
    expect(String(at(catalogues[loc], 'people.wizard.backLabel'))).toContain(adminTitle);
    // …and the shared key keeps naming the EMPLOYEE-facing directory, which was not renamed.
    expect(at(catalogues[loc], 'people.detail.backToPeople')).not.toBe(adminTitle);
  });

  it('the two profiles read DIFFERENT back-link keys for their two different destinations', () => {
    // people.detail is shared by the admin record and the employee-facing profile. The admin one goes to
    // /admin/personnel (Personnel Management); the employee one goes to /personnel (Personnel). A rename
    // in place would have moved both — the people.list.title trap, one namespace down.
    const adminDetail = read('app/admin/personnel/[employmentId]/page.tsx');
    const employeeDetail = read('app/personnel/[employmentId]/page.tsx');
    expect(adminDetail).toContain("{ href: '/admin/personnel', label: t('backToPersonnelAdmin') }");
    expect(adminDetail).not.toContain("t('backToPeople')");
    expect(employeeDetail).toContain("{ href: '/personnel', label: t('backToPeople') }");
    expect(employeeDetail).not.toContain("t('backToPersonnelAdmin')");
    // people.import is admin-only, so its backLabel was renamed in place — no second key.
    expect(read('app/admin/personnel/import/page.tsx')).toContain(
      "back={{ href: '/admin/personnel', label: t('backLabel') }}",
    );
  });

  it('English reads exactly as approved', () => {
    expect(at(catalogues.en, 'nav.personnelAdmin')).toBe('Personnel Management');
    expect(at(catalogues.en, 'people.list.adminTitle')).toBe('Personnel Management');
    expect(at(catalogues.en, 'people.wizard.backLabel')).toBe('Back to Personnel Management');
    expect(at(catalogues.en, 'people.detail.backToPersonnelAdmin')).toBe('Personnel Management');
    expect(at(catalogues.en, 'people.import.backLabel')).toBe('Personnel Management');
    expect(at(catalogues.en, 'people.detail.backToPeople')).toBe('People'); // employee-facing, unchanged
    expect(at(catalogues.en, 'people.detail.headerGroupJoinDate')).toBe('Group Join Date');
    expect(at(catalogues.en, 'people.list.title')).toBe('Personnel');
    expect(at(catalogues.en, 'nav.people')).toBe('Personnel');
  });

  it.each(LOCALES)('locale %s has DELETED the keys nothing resolves any more', (loc) => {
    // Presence is not the same as the value being right (the r191 class of debt): a key with no call site
    // is a stale string waiting to be picked up again. serviceLength said "1 Years 11 Months";
    // headerJoinDate labelled the group date "Join date".
    expect(at(catalogues[loc], 'people.detail.employmentInfo.serviceLength')).toBeUndefined();
    expect(at(catalogues[loc], 'people.detail.headerJoinDate')).toBeUndefined();
  });

  it('the admin list renders adminTitle and the employee directory still renders title', () => {
    const adminList = read('app/admin/personnel/page.tsx');
    const directory = read('app/personnel/page.tsx');
    expect(adminList).toContain("title={t('adminTitle')}");
    expect(adminList).not.toContain("title={t('title')}");
    expect(directory).toContain("title={t('title')}");
    expect(directory).not.toContain("t('adminTitle')");
    // Both still read the SAME namespace — the split is in the key, not in a second catalogue.
    expect(adminList).toContain("getTranslations('people.list')");
    expect(directory).toContain("getTranslations('people.list')");
  });

  it('the sidebar and the security-and-permissions list follow from the one nav key', () => {
    expect(read('components/sidebar.tsx')).toContain("labelKey: 'personnelAdmin'");
    expect(read('lib/permissions.ts')).toContain("labelKey: 'nav.personnelAdmin'");
  });

  it('the Create New Employee wizard back link reads the renamed key', () => {
    const wizard = read('app/admin/personnel/new/page.tsx');
    expect(wizard).toContain("getTranslations('people.wizard')");
    expect(wizard).toContain("back={{ href: '/admin/personnel', label: t('backLabel') }}");
  });
});
