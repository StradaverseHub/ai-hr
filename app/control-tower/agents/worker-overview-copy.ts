import { createTranslator } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { isLocale } from '@/i18n/config';
import messages from './worker-overview-messages.json';

export async function getWorkerOverviewCopy() {
  const locale = await getLocale();
  return createTranslator({ locale, messages: messages[isLocale(locale) ? locale : 'en'] });
}
