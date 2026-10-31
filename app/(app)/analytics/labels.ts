/**
 * Localize the analytics dimension bucket keys for the charts. The data layer returns machine codes
 * (enum values + the UNKNOWN_BUCKET / UNASSIGNED_BUCKET sentinels); the page maps each to a translated
 * label before handing plain category strings to the dumb chart primitives.
 */
import type { getTranslations } from 'next-intl/server';
import { UNASSIGNED_BUCKET, UNKNOWN_BUCKET, type DimensionCount } from '@/core/analytics';

type T = Awaited<ReturnType<typeof getTranslations>>;

/** Map a single bucket key → localized label. Falls back to the raw key for free-text values
 *  (locations, cost-centre names, department names) that have no enum translation. */
export function bucketLabel(key: string, t: T, kind: 'gender' | 'marital' | 'nationality' | 'plain'): string {
  if (key === UNKNOWN_BUCKET) return t('bucketUnknown');
  if (key === UNASSIGNED_BUCKET) return t('bucketUnassigned');
  if (kind === 'plain') return key;
  // The data layer can hand us free-text / non-canonical enum values (e.g. 'M', 'Lelaki') that have no
  // translation key. Guard with t.has() so we never render the raw key path (e.g. "analytics.gender_M")
  // on a chart — fall back to the raw human value instead.
  const prefix = kind; // 'gender' | 'marital' | 'nationality'
  const tk = `${prefix}_${key}`;
  return t.has(tk) ? t(tk) : key;
}

/** Localize a DimensionCount[] into category labels + values aligned by index. */
export function localizeDimension(
  rows: DimensionCount[],
  t: T,
  kind: 'gender' | 'marital' | 'nationality' | 'plain',
): { categories: string[]; values: number[] } {
  return {
    categories: rows.map((r) => bucketLabel(r.name, t, kind)),
    values: rows.map((r) => r.count),
  };
}
