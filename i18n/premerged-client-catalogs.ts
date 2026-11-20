import type { messagesForLocale as canonicalMessages } from './catalogs';
import type { Locale } from './config';

type Messages = Awaited<ReturnType<typeof canonicalMessages>>;
const bundles = new Map<Locale, Promise<Messages>>();

/** A production browser imports the selected locale with its fallback already merged. */
export function messagesForLocale(locale: Locale): Promise<Messages> {
  const cached = bundles.get(locale);
  if (cached) return cached;

  const requested = import(`./client-assets/${locale}.json`).then(asset => asset.default as Messages)
    .catch(error => {
      bundles.delete(locale);
      throw error;
    });
  bundles.set(locale, requested);
  return requested;
}
