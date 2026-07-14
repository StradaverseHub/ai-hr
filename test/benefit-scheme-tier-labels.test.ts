/**
 * Benefit-scheme service-band tier labels interpolate the scheme's ACTUAL configured thresholds
 * (feedback 0aa304a1). The three column/field labels admin.benefitScheme.tierUnder / tierMid /
 * tierOver used to carry literal "N1"/"N2" placeholder text, which never reflected the real
 * per-scheme cut-offs (stored per entitlement in serviceBands: n1 = bands[0].toYears,
 * n2 = bands[1].toYears; the open-ended top band has toYears null). They are now parameterised ICU
 * strings that take {n1}/{n2}, so on a standard 2/5 scheme they read "Under 2 years" /
 * "2 to under 5 years" / "5 years and over", and on a custom 3/7 scheme they follow automatically.
 *
 * This is a presentation-only relabel — no entitlement value or matching-engine change — so the
 * guard is a value-level i18n test (createTranslator renders the real strings) plus a 6-locale
 * structural check that the placeholders were removed and the ICU params survive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

const MESSAGES = path.resolve(__dirname, '../messages');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const TIER_KEYS = ['tierUnder', 'tierMid', 'tierOver'] as const;

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8'));

describe('benefit-scheme tier labels — real configured thresholds', () => {
  it('English labels render the actual thresholds for a standard 2/5 scheme', () => {
    const t = createTranslator({ locale: 'en', messages: load('en'), namespace: 'admin.benefitScheme' }) as unknown as (k: string, p?: Record<string, unknown>) => string;
    expect(t('tierUnder', { n1: 2, n2: 5 })).toBe('Under 2 years');
    expect(t('tierMid', { n1: 2, n2: 5 })).toBe('2 to under 5 years');
    expect(t('tierOver', { n1: 2, n2: 5 })).toBe('5 years and over');
  });

  it('English labels follow a custom 3/7 scheme automatically', () => {
    const t = createTranslator({ locale: 'en', messages: load('en'), namespace: 'admin.benefitScheme' }) as unknown as (k: string, p?: Record<string, unknown>) => string;
    expect(t('tierUnder', { n1: 3, n2: 7 })).toBe('Under 3 years');
    expect(t('tierMid', { n1: 3, n2: 7 })).toBe('3 to under 7 years');
    expect(t('tierOver', { n1: 3, n2: 7 })).toBe('7 years and over');
  });

  it('every locale interpolates the thresholds — no literal N1/N2 survives, top band stays open-ended', () => {
    for (const loc of LOCALES) {
      const messages = load(loc);
      const t = createTranslator({ locale: loc, messages, namespace: 'admin.benefitScheme' }) as unknown as (k: string, p?: Record<string, unknown>) => string;
      for (const key of TIER_KEYS) {
        // Raw stored string still carries the ICU placeholders and no leftover "N1"/"N2".
        const raw = ((messages as any).admin.benefitScheme as Dict)[key];
        expect(typeof raw, `${loc}.${key} type`).toBe('string');
        expect(raw as string, `${loc}.${key} still has literal N1`).not.toMatch(/N1/);
        expect(raw as string, `${loc}.${key} still has literal N2`).not.toMatch(/N2/);
      }
      // Rendered output substitutes the real numbers.
      const under = t('tierUnder', { n1: 2, n2: 5 });
      const mid = t('tierMid', { n1: 2, n2: 5 });
      const over = t('tierOver', { n1: 2, n2: 5 });
      expect(under, `${loc} tierUnder shows n1`).toContain('2');
      // tierMid spans both thresholds.
      expect(mid, `${loc} tierMid shows n1`).toContain('2');
      expect(mid, `${loc} tierMid shows n2`).toContain('5');
      // tierOver (open-ended top band) shows only n2, never the null top-band bound.
      expect(over, `${loc} tierOver shows n2`).toContain('5');
      // no unresolved ICU braces leaked through.
      for (const s of [under, mid, over]) {
        expect(s, `${loc} left an unresolved placeholder`).not.toMatch(/[{}]/);
      }
    }
  });
});
