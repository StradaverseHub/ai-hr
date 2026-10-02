import { getTranslations } from 'next-intl/server';

/** Country-pack refusal codes never become raw payroll banners. Existing unrelated errors retain
 * their established handling; this boundary consumes the stable error name without importing a pack. */
export async function payrollTaxSchemeErrorMessage(error: unknown): Promise<string> {
  if(error instanceof Error && error.name==='TaxSelectionError'&&'code' in error){
    const t=await getTranslations('payroll.process');
    if(['confirmation_required','invalid_scheme','not_resident','citizenship_unknown'].includes(String(error.code)))return t(`taxSelection_${String(error.code)}`);
  }
  if (error instanceof Error && error.name === 'TaxSchemeDeclarationError') {
    const t = await getTranslations('payroll.process');
    if('code' in error&&['missing_declaration','declaration_revoked','declaration_outside_period','not_resident','citizenship_unknown','overlap'].includes(String(error.code))){
      return t(`taxScheme_${String(error.code)}`);
    }
    return t('taxSchemeDeclarationRequired');
  }
  return (error as Error).message;
}
