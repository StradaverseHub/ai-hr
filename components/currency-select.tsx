'use client';

import { useTranslations } from 'next-intl';
import { Combobox } from './ui/combobox';
import { CURRENCY_OPTIONS } from '@/lib/currencies';

/**
 * 297ae65a — the searchable salary Currency select (ISO 4217, lib/currencies.ts master). A thin wrapper
 * around the shared Combobox so the Basic Salary add + edit forms and the company default-currency picker
 * all offer the identical catalog with identical labels ("MYR – Malaysian Ringgit"). Form-compatible: the
 * Combobox posts a hidden <input name={name}> carrying the selected ISO code; the services re-validate
 * against the same master server-side. Labels come from the shared `currencySelect` i18n namespace so the
 * component works on any screen; currency NAMES themselves are English-only master data (see
 * lib/currencies.ts), like the country master.
 */
export function CurrencySelect({ name, value }: { name: string; value: string | null | undefined }) {
  const t = useTranslations('currencySelect');
  return (
    <Combobox
      name={name}
      value={value}
      options={[...CURRENCY_OPTIONS]}
      placeholder={t('placeholder')}
      searchPlaceholder={t('searchPlaceholder')}
      noResultsLabel={t('noResults')}
      legacySuffix={t('legacySuffix')}
    />
  );
}
