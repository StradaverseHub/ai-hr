import {getTranslations} from 'next-intl/server';
import type {TaxBasisNoticeStrings} from './payroll-tax-basis-notices';

export async function taxBasisNoticeStrings(mode: 'original'|'applied'): Promise<TaxBasisNoticeStrings> {
  const t = await getTranslations('payrollTaxBasis');
  return {description: mode === 'original' ? t('noticeOriginal') : t('noticeApplied'), references: t('noticeReferences'), view: t('noticeView')};
}
