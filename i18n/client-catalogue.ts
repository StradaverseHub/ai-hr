import type { AbstractIntlMessages } from 'next-intl';
import { messagesForLocale } from './catalogs';
import type { Locale } from './config';

export type ClientCatalogueScope = 'full' | 'home' | 'tp3' | 'approvals' | 'payroll-dashboard';

// Production browser builds use the selected prebuilt asset. Server rendering and
// development use the canonical catalogue with the same values.
export const messagesForClient: (
  locale: Locale,
  scope: ClientCatalogueScope,
) => Promise<AbstractIntlMessages> = messagesForLocale;
