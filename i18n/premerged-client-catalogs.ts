import type { AbstractIntlMessages } from 'next-intl';
import type { ClientCatalogueScope } from './client-catalogue';
import type { Locale } from './config';
import { mergeClientCatalogues } from './merge-client-catalogues';

const bundles = new Map<string, Promise<AbstractIntlMessages>>();

/** A production browser imports the selected locale with its fallback already merged. */
export function messagesForClient(locale: Locale, scope: ClientCatalogueScope): Promise<AbstractIntlMessages> {
  const key = scope + ':' + locale;
  const cached = bundles.get(key);
  if (cached) return cached;

  const loadAsset = {
    full: () => import(`./client-assets/${locale}.json`),
    home: () => import(`./client-assets/home/${locale}.json`),
    tp3: () => import(`./client-assets/tp3/${locale}.json`),
    approvals: () => import(`./client-assets/approvals/${locale}.json`),
    'payroll-dashboard': () => import(`./client-assets/payroll-dashboard/${locale}.json`),
    assistant: () => import(`./client-assets/assistant/${locale}.json`),
  }[scope];
  const asset = loadAsset().then(bundle => bundle.default as AbstractIntlMessages);
  const messages = scope === 'full' || scope === 'home'
    ? asset
    : Promise.all([messagesForClient(locale, 'home'), asset])
      .then(([shell, route]) => mergeClientCatalogues(shell, route));
  const requested = messages
    .catch(error => {
      bundles.delete(key);
      throw error;
    });
  bundles.set(key, requested);
  return requested;
}
