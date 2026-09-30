/**
 * Request parsing shared by the mobile route handlers (ADR-0088 §1–§2).
 */
import type { SessionContext } from '@/db/client';
import { myEmployments } from '@/core/read';
import { defaultLocale, locales, type Locale } from '@/i18n/config';
import { MobileBadRequest } from './handler';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The display locale for figures that core localises (leave type names). `?locale=` wins, then the first
 * supported language in Accept-Language, then English. Never an error: a phone set to French gets English.
 */
export function mobileLocale(req: Request): Locale {
  const isLocale = (v: string): v is Locale => (locales as readonly string[]).includes(v);
  const q = new URL(req.url).searchParams.get('locale');
  if (q && isLocale(q)) return q;
  for (const part of (req.headers.get('accept-language') ?? '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if (isLocale(tag)) return tag;
  }
  return defaultLocale;
}

/**
 * Which of the caller's OWN active employments this request is about (the employment picker, ADR-0088
 * §1). No `?employmentId=` ⇒ the first active employment, the same one the web's /me acts on. An id that
 * is not one of the caller's active employments is a 400 — and never reaches a core read with it, so the
 * refusal does not rest on RLS alone. Null when the login has no active employment.
 */
export async function mobileEmployment(s: SessionContext, req: Request): Promise<string | null> {
  const requested = new URL(req.url).searchParams.get('employmentId');
  const mine = await myEmployments(s);
  if (requested === null) return mine[0]?.employmentId ?? null;
  if (!UUID.test(requested) || !mine.some((e) => e.employmentId === requested)) {
    throw new MobileBadRequest('employmentId is not one of the caller’s active employments');
  }
  return requested;
}
