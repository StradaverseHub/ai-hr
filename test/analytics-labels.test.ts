/**
 * Audit #27 — analytics dimension labels must never render a raw i18n key path on a chart.
 *
 * bucketLabel builds dynamic enum keys (gender_<v> / marital_<v> / nationality_<v> / assignment_<v>)
 * from FREE-TEXT DB values. A non-canonical value (e.g. 'M', 'Lelaki') has no translation key, so the
 * old unguarded t(`gender_${v}`) would surface the literal path "analytics.gender_M" on the chart axis.
 * The fix guards the lookup with t.has() and falls back to the raw human value. These pure-function
 * tests pin that requirement (no DB, no next-intl runtime — a fake `t` mirrors what next-intl gives us).
 */
import { describe, expect, it } from 'vitest';
import { bucketLabel } from '../app/analytics/labels';
import { UNASSIGNED_BUCKET, UNKNOWN_BUCKET } from '../core/analytics';

/** A minimal next-intl-shaped translator: a known dictionary, t.has() membership, and a t(key)
 *  that returns the value when present or the namespaced key path when missing (next-intl's behaviour). */
function fakeT(dict: Record<string, string>) {
  const NS = 'analytics';
  const t = ((key: string) => (key in dict ? dict[key] : `${NS}.${key}`)) as unknown as Parameters<
    typeof bucketLabel
  >[1];
  (t as unknown as { has: (k: string) => boolean }).has = (key: string) => key in dict;
  return t;
}

describe('analytics bucketLabel (#27 — no raw key paths for free-text values)', () => {
  const dict = {
    gender_male: 'Male',
    marital_married: 'Married',
    nationality_MY: 'Malaysian',
    assignment_active: 'Active',
    bucketUnknown: 'Unknown',
    bucketUnassigned: 'Unassigned',
  };

  it('returns the raw value (not the key path) for a non-canonical gender like "M"', () => {
    const out = bucketLabel('M', fakeT(dict), 'gender');
    expect(out).toBe('M');
    expect(out).not.toContain('analytics.');
    expect(out).not.toContain('gender_');
  });

  it('returns the raw value for a non-canonical localized marital value like "Lelaki"', () => {
    const out = bucketLabel('Lelaki', fakeT(dict), 'marital');
    expect(out).toBe('Lelaki');
    expect(out).not.toContain('analytics.');
  });

  it('falls back to the raw value for an unknown nationality and assignment code', () => {
    expect(bucketLabel('Foreign', fakeT(dict), 'nationality')).toBe('Foreign');
    expect(bucketLabel('seconded', fakeT(dict), 'assignment')).toBe('seconded');
  });

  it('still translates canonical enum values when the key exists', () => {
    expect(bucketLabel('male', fakeT(dict), 'gender')).toBe('Male');
    expect(bucketLabel('married', fakeT(dict), 'marital')).toBe('Married');
    expect(bucketLabel('MY', fakeT(dict), 'nationality')).toBe('Malaysian');
    expect(bucketLabel('active', fakeT(dict), 'assignment')).toBe('Active');
  });

  it('maps the sentinel buckets to their translated labels', () => {
    expect(bucketLabel(UNKNOWN_BUCKET, fakeT(dict), 'gender')).toBe('Unknown');
    expect(bucketLabel(UNASSIGNED_BUCKET, fakeT(dict), 'assignment')).toBe('Unassigned');
  });

  it('passes plain free-text (department/location names) through verbatim', () => {
    expect(bucketLabel('Engineering', fakeT(dict), 'plain')).toBe('Engineering');
  });
});
