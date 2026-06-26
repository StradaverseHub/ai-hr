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
export function bucketLabel(key: string, t: T, kind: 'gender' | 'marital' | 'nationality' | 'assignment' | 'plain'): string {
  if (key === UNKNOWN_BUCKET) return t('bucketUnknown');
  if (key === UNASSIGNED_BUCKET) return t('bucketUnassigned');
  switch (kind) {
    case 'gender':
      return t(`gender_${key}`);
    case 'marital':
      return t(`marital_${key}`);
    case 'nationality':
      return t(`nationality_${key}`);
    case 'assignment':
      return t(`assignment_${key}`);
    default:
      return key;
  }
}

/** Localize a DimensionCount[] into category labels + values aligned by index. */
export function localizeDimension(
  rows: DimensionCount[],
  t: T,
  kind: 'gender' | 'marital' | 'nationality' | 'assignment' | 'plain',
): { categories: string[]; values: number[] } {
  return {
    categories: rows.map((r) => bucketLabel(r.name, t, kind)),
    values: rows.map((r) => r.count),
  };
}
