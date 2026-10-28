/**
 * M13 — the route halves of the v2 profile endpoints: which own employment a request names, and the server-translated
 * label resolver the Personnel descriptors and the web's request display take. Core (core/mobile-profile.ts) stays
 * catalogue-free; this module reads the web's catalogues through lib/mobile-api/server-text.ts.
 */
import type { SessionContext } from '@/db/client';
import { myEmployments } from '@/core/read';
import type { PersonnelLabelResolver } from '@/lib/personnel-field-label';
import { MobileBadRequest } from './handler';
import { mobileLocale } from './request';
import { mobileTranslator } from './server-text';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?employmentId=` names the employment; absent ⇒ the caller's first active employment (the app's default, as
 * lib/mobile-api/request.ts mobileEmployment). A malformed id is a 400. A well-formed id that is not the caller's own
 * is NOT refused here: the profile owner refuses it, and the endpoint answers `not_found` (no existence leak).
 * Null when the login has no active employment and named none.
 */
export async function profileEmployment(s: SessionContext, req: Request): Promise<string | null> {
  const all = new URL(req.url).searchParams.getAll('employmentId');
  if (all.length > 1) throw new MobileBadRequest('Repeated employmentId');
  const requested = all[0];
  if (requested !== undefined) {
    if (!UUID.test(requested)) throw new MobileBadRequest('Invalid employmentId');
    return requested.toLowerCase();
  }
  return (await myEmployments(s))[0]?.employmentId ?? null;
}

/** The namespaces the Personnel labels, choices and request lines resolve from. */
const NAMESPACES = ['people', 'essProfile', 'me'] as const;
/**
 * `(key, fallback)` over the web's catalogues in the request's locale: `people.detail.x` reads namespace `people`,
 * key `detail.x`. A missing key falls back to English, then to the descriptor's own English fallback; never a raw key.
 */
export async function profileLabels(req: Request): Promise<PersonnelLabelResolver> {
  const locale = mobileLocale(req);
  const translators = new Map(await Promise.all(NAMESPACES.map(async (ns) => [ns, await mobileTranslator(locale, ns)] as const)));
  return (key, fallback) => {
    const dot = key.indexOf('.');
    const translate = dot > 0 ? translators.get(key.slice(0, dot) as (typeof NAMESPACES)[number]) : undefined;
    return (translate && translate(key.slice(dot + 1))) || fallback;
  };
}
