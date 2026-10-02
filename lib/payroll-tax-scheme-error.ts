import { getTranslations } from 'next-intl/server';

/** Country-pack refusal codes never become raw payroll banners. Existing unrelated errors retain
 * their established handling; this boundary consumes the stable error name without importing a pack. */
export async function payrollTaxSchemeErrorMessage(error: unknown): Promise<string> {
  if (error instanceof Error && error.name === 'TaxSchemeDeclarationError') {
    const t = await getTranslations('payroll.process');
    return t('taxSchemeDeclarationRequired');
  }
  return (error as Error).message;
}
