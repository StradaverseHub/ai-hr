import { redirect } from 'next/navigation';

/**
 * 639bf4a5 (r336) — the shared tail of the three `/admin/locations` REDIRECT STUBS.
 *
 * The register moved to Organization as "Physical Work Location" and took its address with it
 * (`/admin/work-locations`, see app/admin/work-locations/page.tsx). Everything under the old address is
 * a stub now, and every stub forwards its query string: the r265 idiom sends an operator back from a
 * save with `?saved=1&focus=<id>`, and a refusal carries the reason plus every typed value, so a
 * redirect that dropped the query would turn a stale bookmark into a blank page instead of the row the
 * link named.
 *
 * ONE spelling of the new addresses: the stubs read them from
 * app/admin/work-locations/clocking/form-fields.ts, which is also what the screens, the actions and the
 * tests read. A literal here would be a second place to fix on the next move.
 */
type QueryValue = string | string[] | undefined;

export function locationsRedirectTarget(entries: Iterable<[string, QueryValue]>, to: string): string {
  const usp = new URLSearchParams();
  for (const [key, value] of entries) {
    // A legacy page keeps the first value when a bookmark repeats a parameter.
    if (usp.has(key)) continue;
    if (typeof value === 'string') usp.set(key, value);
    else if (Array.isArray(value) && value[0] != null) usp.set(key, value[0]);
  }
  const qs = usp.toString();
  return `${to}${qs ? `?${qs}` : ''}`;
}

export function forward(sp: Record<string, QueryValue>, to: string): never {
  redirect(locationsRedirectTarget(Object.entries(sp), to));
}
