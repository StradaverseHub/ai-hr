import type {Locale} from './config';
import en from '../messages/en.json';
import aiCentreEn from '../messages/ai-centre/en.json';

type Dict = Record<string, unknown>;

/** Deep-merge a (partial) locale catalog over the English base so any missing or blank key falls
 *  back to English rather than rendering the raw key. Catalogs are nested string maps, never arrays. */
function withFallback(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = withFallback(b as Dict, v as Dict);
    } else if (v != null && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

// Catalogs are static for the lifetime of a build. Cache only the merged messages,
// while each request independently resolves its explicit locale or cookie.
const englishMessages = withFallback(en as Dict, aiCentreEn as Dict) as typeof en;
const englishCatalog = Promise.resolve(englishMessages);
const catalogs = new Map<Locale, Promise<typeof en>>([['en', englishCatalog]]);

export function messagesForLocale(locale: Locale): Promise<typeof en> {
  const cached = catalogs.get(locale);
  if (cached) return cached;

  const loading = Promise.all([
    import(`../messages/${locale}.json`).then(module => module.default as Dict),
    import(`../messages/ai-centre/${locale}.json`).then(module => module.default as Dict),
  ]).then(([messages, aiCentre]) =>
    withFallback(englishMessages, withFallback(messages, aiCentre)) as typeof en,
  ).catch(error => {
    catalogs.delete(locale);
    throw error;
  });
  catalogs.set(locale, loading);
  return loading;
}
