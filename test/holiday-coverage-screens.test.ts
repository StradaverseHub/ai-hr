/**
 * 0e276da0 (r269) — the two screens the warning was promised on actually carry it.
 *
 * A SOURCE-SHAPE guard, and it is the right instrument here for the reason test/server-client-boundary
 * documents: this repo's component tests are static scans and core-behaviour tests against the database,
 * so nothing else in the suite proves a page WIRED the read it was built for. The behaviour itself is
 * pinned in test/holiday-calendar-coverage.test.ts; this pins that a future edit cannot quietly drop the
 * sentence off either screen, and that the words exist in all six locales.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const LOCATIONS_PAGE = 'app/admin/locations/page.tsx';
const GROUP_EDIT_PAGE = 'app/admin/holidays/groups/[id]/page.tsx';
const GROUP_LIST_PAGE = 'app/admin/holidays/groups/page.tsx';
const WARNING_COMPONENT = 'components/holiday-coverage-warning.tsx';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
/** Every key the component and the two screens ask for, by hand — a typo here is the bug we are catching. */
const KEYS = [
  'summaryEmpty',
  'summaryMissing',
  'summaryComplete',
  'warnEmptyTitle',
  'warnEmptyBody',
  'warnMissingTitle',
  'warnMissingBody',
  'gapRow',
  'note',
  'okLine',
] as const;

describe('0e276da0 — the calendar-coverage warning is wired to both screens', () => {
  it('the Locations screen reads the coverage and surfaces it beside the calendar picker', () => {
    const src = read(LOCATIONS_PAGE);
    expect(src).toContain("holidayCalendarCoverage");
    expect(src).toContain("from '@/core/holidays'");
    // The warning, for the calendar a location already carries…
    expect(src).toContain('HolidayCoverageWarning');
    expect(src).toContain('calendarWarnings');
    // …and the day count on the picker's own options, at the moment of choosing.
    expect(src).toContain('calendarOptionLabel');
    expect(src.match(/calendarOptionLabel\(cal\.id, cal\.name\)/g) ?? []).toHaveLength(2); // edit row + add form
  });

  it('the calendar’s OWN screen surfaces the same line with nothing attached to it', () => {
    const src = read(GROUP_EDIT_PAGE);
    expect(src).toContain('holidayCalendarCoverage');
    expect(src).toContain('<HolidayCoverageWarning coverage={thisCoverage} showComplete />');
  });

  it('the holiday-group list shows each stand-alone calendar’s coverage', () => {
    const src = read(GROUP_LIST_PAGE);
    expect(src).toContain('holidayCalendarCoverage');
    expect(src).toContain('coverageSummary');
  });

  it('the warning is ONE component, rendered on the server, and it never blocks', () => {
    const src = read(WARNING_COMPONENT);
    // A server component: the pages that host it are server components (test/server-client-boundary).
    expect(src).not.toMatch(/^\s*['"]use client['"]/m);
    // Warn, never refuse: no throw, no redirect, no disabling of the form it sits beside.
    expect(src).not.toContain('throw ');
    expect(src).not.toContain('disabled');
    expect(src).toContain("t('note')");
  });

  it('every message key it asks for exists in all six locales', () => {
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      const ns = dict?.admin?.holidayCoverage;
      expect(ns, `${loc}: admin.holidayCoverage namespace`).toBeTruthy();
      for (const k of KEYS) {
        expect(typeof ns[k], `${loc}: admin.holidayCoverage.${k}`).toBe('string');
        expect(ns[k].length, `${loc}: admin.holidayCoverage.${k} is blank`).toBeGreaterThan(0);
      }
    }
  });

  it('the year reaches ICU as a STRING, so {year} never renders as “2,026”', () => {
    expect(read(WARNING_COMPONENT)).toContain('const year = String(coverage.year);');
  });
});

describe('0e276da0 — the resolver and the s.60D skip are untouched', () => {
  const src = read('core/holidays.ts');

  it('the Custom skip that suppresses the s.60D warning is still there, verbatim', () => {
    expect(src).toContain("if (effCalArchetype === 'custom') return { country: emp.country, state: null, skipCompleteness: true };");
  });

  it('the Custom resolution branch still returns the calendar’s own days and NO gazette', () => {
    expect(src).toContain("if (effCalArchetype === 'custom') {");
    expect(src).toContain('return new Set([...adHocRows.map((h) => h.d), ...chainExtras]);');
  });

  it('the coverage read appends no domain event — it is a pure read', () => {
    const section = src.slice(src.indexOf('0e276da0 (r269) — CALENDAR COVERAGE'));
    expect(section.length).toBeGreaterThan(500);
    expect(section).not.toContain('appendEvent');
    expect(section).not.toContain('.insert(');
    expect(section).not.toContain('.update(');
    expect(section).not.toContain('.delete(');
  });
});

/**
 * §8 "a 200 is not a render check": MISSING_MESSAGE and FORMATTING_ERROR pass tsc, the suite and
 * next build, and only show up on a rendered page. This formats every one of the ten messages through
 * next-intl's OWN translator — the same ICU pipeline getTranslations uses — in all six locales, with
 * the exact argument shapes components/holiday-coverage-warning.tsx passes. A missing key, a malformed
 * plural, or an argument the locale spells differently fails here rather than on the reporter's screen.
 */
describe('0e276da0 — every locale actually FORMATS, with the arguments the screens pass', () => {
  const CALLS: { key: (typeof KEYS)[number]; values?: Record<string, string | number> }[] = [
    { key: 'summaryEmpty' },
    { key: 'summaryMissing', values: { held: 10, missing: 2 } },
    { key: 'summaryComplete', values: { held: 11 } },
    { key: 'warnEmptyTitle' },
    { key: 'warnEmptyBody', values: { name: 'JOHOR OFFICE', gazette: 11, year: '2026' } },
    { key: 'warnMissingTitle', values: { missing: 1 } },
    { key: 'warnMissingBody', values: { name: 'KUALA LUMPUR HQ', held: 11, gazette: 12, year: '2026' } },
    { key: 'gapRow', values: { date: '2026-11-08', name: 'Deepavali' } },
    { key: 'note' },
    { key: 'okLine', values: { name: 'KUALA LUMPUR HQ', gazette: 12, year: '2026' } },
  ];

  for (const loc of LOCALES) {
    it(`${loc}: all ten messages render with no missing key and no leftover ICU`, () => {
      const messages = JSON.parse(read(`messages/${loc}.json`));
      const t = createTranslator({ locale: loc, messages, namespace: 'admin.holidayCoverage' });
      for (const { key, values } of CALLS) {
        const out = t(key as never, values as never);
        expect(out, `${loc}.${key}`).toBeTruthy();
        // next-intl returns the dotted key path when a message is missing or fails to format.
        expect(out, `${loc}.${key} did not resolve`).not.toContain('admin.holidayCoverage');
        expect(out, `${loc}.${key} left ICU unrendered`).not.toMatch(/[{}]/);
        // The plural branch actually fired rather than printing the raw '#'.
        expect(out, `${loc}.${key} left a plural '#'`).not.toContain('#');
      }
      // THE TRAP: ICU formats a NUMBER argument, so a year passed as 2026 renders "2,026". The
      // component passes String(year); this proves the messages read back the plain year.
      expect(t('okLine' as never, { name: 'X', gazette: 12, year: '2026' } as never)).toContain('2026');
      expect(t('okLine' as never, { name: 'X', gazette: 12, year: '2026' } as never)).not.toContain('2,026');
    });
  }
});

describe('0e276da0 verify fix — the sentence can never claim more days than are gazetted', () => {
  it('renders days COVERED, never days supplied', () => {
    // A calendar may tick another state's holiday, so `held` can exceed `gazette`; the sentence must
    // report gazetted-minus-missing, which is bounded by the total by construction.
    const src = read('components/holiday-coverage-warning.tsx');
    expect(src, 'the warning body must not pass raw coverage.held').not.toMatch(
      /warnMissingBody[\s\S]{0,200}held:\s*coverage\.held\b/,
    );
    expect(src, 'it must pass gazetted minus missing').toMatch(
      /held:\s*coverage\.gazette\s*-\s*coverage\.missing\.length/,
    );
  });
});
