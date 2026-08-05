/**
 * Personnel (Admin) — Age beside Date of Birth on the Personal Details card (feedback 9d13221c).
 *
 * The card shows a read-only, system-calculated Age ("36 Years") right beside the Date of Birth field,
 * recomputed from the stored DOB against today's date on every render — never stored, never an input,
 * never audited (DOB edits keep their existing audit trail). Covers:
 *   1. completedYearsAt (pure): the reporter's three example vectors pinned exactly; the birthday
 *      boundary (day-before / day-of / day-after); a 29-Feb birthday in common years (increments on
 *      1 Mar); null/blank DOB → null; a future DOB clamps to 0; and the delegation contract with
 *      serviceYearsAt (the two whole-year counters can never disagree).
 *   2. Formatting against the REAL message catalogs via createTranslator: "{years} Years" with ICU
 *      pluralization where the locale needs it, and all 6 locales resolve the new keys with tokens.
 *   3. Source drift guards (the convention of test/personnel-year-of-service.test.ts): the page derives
 *      the label from emp.dateOfBirth via completedYearsAt against `today`, renders it as muted read-only
 *      text (not an input) beside the DOB field, and falls back to the shared Not Available key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
// Deliberately imported from '../core/leave' — its OLD home. 35b7af0a group 3 moved the definitions to the
// client-safe lib/completed-years.ts and re-exported them here, and every existing server caller
// (core/read.ts, core/analytics.ts, the entitlement engine, three other test files) still imports them from
// this door. Keeping this import as it was is what proves the move did not break them.
import { completedYearsAt, serviceYearsAt } from '../core/leave';
import * as ageMath from '../lib/completed-years';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('completedYearsAt (pure)', () => {
  it('is ONE function behind two doors — core/leave re-exports the client-safe definition by identity', () => {
    // 35b7af0a group 3. A re-declared copy would pass every behavioural test in this file today and drift
    // tomorrow, which is the exact failure mode this whole item exists to remove (see the group 1 precedent
    // in test/marital-master-enum.test.ts, which asserts the master lists the same way).
    expect(completedYearsAt).toBe(ageMath.completedYearsAt);
    expect(serviceYearsAt).toBe(ageMath.serviceYearsAt);
  });

  it("pins the reporter's three example vectors exactly (as of 23-Jul-2026)", () => {
    expect(completedYearsAt('1990-01-01', '2026-07-23')).toBe(36);
    expect(completedYearsAt('1990-12-31', '2026-07-23')).toBe(35);
    expect(completedYearsAt('2000-07-15', '2026-07-23')).toBe(26);
  });

  it('increments exactly at the birthday boundary: day-before stays, day-of and day-after are the new age', () => {
    expect(completedYearsAt('2000-07-15', '2026-07-14')).toBe(25);
    expect(completedYearsAt('2000-07-15', '2026-07-15')).toBe(26);
    expect(completedYearsAt('2000-07-15', '2026-07-16')).toBe(26);
  });

  it('a 29-Feb birthday increments on 1 Mar in common years (28-Feb is still the old age)', () => {
    expect(completedYearsAt('2000-02-29', '2026-02-28')).toBe(25);
    expect(completedYearsAt('2000-02-29', '2026-03-01')).toBe(26);
    // In a leap year the birthday exists and the age increments on the day itself.
    expect(completedYearsAt('2000-02-29', '2028-02-28')).toBe(27);
    expect(completedYearsAt('2000-02-29', '2028-02-29')).toBe(28);
  });

  it('null / undefined / blank DOB yields null (the card shows Not Available)', () => {
    expect(completedYearsAt(null, '2026-07-23')).toBeNull();
    expect(completedYearsAt(undefined, '2026-07-23')).toBeNull();
    expect(completedYearsAt('', '2026-07-23')).toBeNull();
  });

  it('a DOB after asOf (bad data entry) clamps to 0, never negative', () => {
    expect(completedYearsAt('2030-01-01', '2026-07-23')).toBe(0);
  });

  it('always equals serviceYearsAt for a present DOB (single source of whole-year calendar math)', () => {
    const vectors = [
      ['1990-01-01', '2026-07-23'],
      ['1990-12-31', '2026-07-23'],
      ['2000-07-15', '2026-07-23'],
      ['2000-02-29', '2026-02-28'],
      ['2000-02-29', '2026-03-01'],
      ['2030-01-01', '2026-07-23'],
    ] as const;
    for (const [dob, asOf] of vectors) {
      expect(completedYearsAt(dob, asOf)).toBe(serviceYearsAt(dob, asOf));
    }
  });
});

describe('Age formatting (real en catalog)', () => {
  const messages = JSON.parse(read('messages/en.json'));
  const t = createTranslator({ locale: 'en', messages, namespace: 'people.detail' });

  it('renders the reporter\'s expected "36 Years" form', () => {
    expect(t('ageYears', { years: 36 })).toBe('36 Years');
    expect(t('ageYears', { years: 35 })).toBe('35 Years');
    expect(t('ageYears', { years: 26 })).toBe('26 Years');
  });

  it('singular via ICU plural', () => {
    expect(t('ageYears', { years: 1 })).toBe('1 Year');
  });

  it('the label key reads Age', () => {
    expect(t('age')).toBe('Age');
  });
});

describe('i18n — every locale carries the Age keys with valid tokens', () => {
  it.each(LOCALES)('locale %s resolves age label, ageYears format and the shared notAvailable fallback', async (locale) => {
    const messages = (await import(`../messages/${locale}.json`)).default;
    const t = createTranslator({ locale, messages, namespace: 'people.detail' });
    expect(t('age').length).toBeGreaterThan(0);
    // The format key substitutes {years} (ICU plural in en/ta; plain in the rest) — a malformed message throws.
    expect(t('ageYears', { years: 36 })).toContain('36');
    // Blank DOB shares the cc681bd5 Not Available key.
    expect(t('employmentInfo.notAvailable').length).toBeGreaterThan(0);
  });
});

/**
 * 35b7af0a GROUP 3 relocated the markup these guards were written against. The Age field is no longer built
 * inline on the Personnel page — the page renders components/birth-date-fields.tsx, which the Create New
 * Employee wizard renders too, so there is now ONE Age implementation instead of a profile-only one. The
 * guards therefore follow the code: what they assert is unchanged (derived via the shared helper against
 * `today`, formatted through the ageYears catalog key, rendered as read-only muted text beside the DOB, and
 * falling back to the shared Not Available key) — only the file they assert it in has moved.
 */
describe('drift guards (source assertions)', () => {
  const page = read('app/admin/personnel/[employmentId]/page.tsx');
  const src = read('components/birth-date-fields.tsx');

  it('the Personnel page renders the shared group and hands it the tenant-resolved today', () => {
    expect(page).toContain("import { BirthDateFields } from '@/components/birth-date-fields';");
    expect(page).toContain(
      '<BirthDateFields mode="form" inputId="profile-dob-input" dateOfBirth={emp.dateOfBirth} today={today} />',
    );
    // The DOB input keeps its id: components/ic-dob-autofill.tsx writes the MyKad-derived date straight onto
    // that DOM node, so losing the id silently breaks item 354a500d with nothing else going red.
    expect(src).toContain('id: props.inputId');
  });

  it('the group derives the age from the DOB via the shared helper against the passed-in date', () => {
    // The helper moved to a CLIENT-SAFE module so the wizard (a client component) can render the Age at all;
    // core/leave.ts re-exports it, so every server caller is untouched. Reading a clock in here instead of
    // taking `today` would reintroduce the 00:00–08:00 MYT off-by-one this repo has already paid for.
    expect(src).toContain("import { completedYearsAt } from '@/lib/completed-years';");
    expect(src).toContain('completedYearsAt(value, props.today)');
    expect(src).not.toMatch(/new Date\(\)/);
  });

  it('the label formats via the ageYears catalog key, never hand-built English pluralization', () => {
    expect(src).toContain("const ageLabel = years === null ? null : t('ageYears', { years });");
  });

  it('a blank DOB falls back to the shared Not Available key', () => {
    expect(src).toContain("{ageLabel ?? t('employmentInfo.notAvailable')}");
  });

  it('the Age renders as a labelled read-only muted element (not an input) beside the DOB field', () => {
    expect(src).toContain("<Field label={t('age')}");
    const dobIdx = src.indexOf("<Field label={t('birthDate')}");
    const ageIdx = src.indexOf("<Field label={t('age')}");
    expect(dobIdx).toBeGreaterThan(-1);
    expect(ageIdx).toBeGreaterThan(dobIdx);
    // The age cell is a <p>, not an <input> — nothing to type, nothing to save.
    const ageBlock = src.slice(ageIdx, src.indexOf('</Field>', ageIdx));
    expect(ageBlock).toContain('<p className="flex h-9 items-center text-sm text-muted-foreground">');
    expect(ageBlock).not.toContain('<input');
  });

  it('the age is never stored: no draft key, no column, no hidden input carries it', () => {
    // The whole point of recomputing on render. A saved age is wrong the day after it is saved.
    expect(src).not.toContain('type="hidden"');
    expect(src).not.toContain("name: 'age'");
    expect(read('lib/employee-draft-schema.ts')).not.toMatch(/\bage\??:/);
  });
});
