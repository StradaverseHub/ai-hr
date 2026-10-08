/**
 * 639bf4a5 rev 2 (r338) — the CONTRACT between the Locations company listing (./page.tsx), the three
 * dedicated screens it opens (./new, ./[id], ./[id]/edit), the shared form (./location-form.tsx) and the
 * four `*LocationAction` server actions in app/admin/actions.ts: the addresses, the field names the form
 * posts, and the `typed*` keys a refused save echoes them back under.
 *
 * It is the `./clocking/form-fields.ts` module one directory over, for the OTHER half of this screen
 * family, and deliberately the same shape — ONE module read by both sides, so the page cannot echo a key
 * the action never wrote nor the action write one the page never reads (CLAUDE.md §8: a contract between
 * two files is pinned across both).
 *
 * A plain module: no 'use server', no 'use client', no database — safe to import from either side.
 *
 * ⚠️ THE ROUTE DID NOT MOVE, THE LABEL DID. The register is Attendance › **Locations** again (r338
 * reverses r336's move to Organization › Physical Work Location, on the reporter's instruction), but the
 * ADDRESS is untouched: `/admin/work-locations`, declared once in lib/return-to.ts and re-exported by
 * ./clocking/form-fields.ts as LOCATIONS_LIST. Moving the route a second time in two days would churn
 * every bookmark again and need the three `/admin/locations` redirect stubs re-pointed for nothing.
 * `screenKey: 'locations'` did not move either — it is a permission identity stored role configs may
 * name (lib/permissions.ts).
 */
import { CLOCKING_NEW_PAGE, LOCATIONS_LIST, UUID_RE } from './clocking/form-fields';

/** Add — one company's new work location. `?companyId=` names the company; it is the screen's subject. */
export const LOCATION_NEW_PAGE = '/admin/work-locations/new';
/** View — one location, read-only. */
export const locationViewPage = (id: string) => `/admin/work-locations/${id}`;
/** Edit — the same location with its form and its archive control. */
export const locationEditPage = (id: string) => `/admin/work-locations/${id}/edit`;
/** The listing, landed on ONE location's row and highlighted: what a successful Save returns to. */
export const locationRowHref = (id: string) => `${LOCATIONS_LIST}?saved=1&focus=${id}#row-${id}`;

/**
 * …the same thing, onto the listing AS THE OPERATOR LEFT IT. `returnTo` has already been whitelisted by
 * shape (lib/return-to.ts `workLocationsReturnTo`), so this only has to fold the save's own two
 * parameters in: the previous `saved` / `focus` are REPLACED rather than appended, or a second save
 * would carry the first one's row along and highlight a row nobody just touched.
 */
export function locationSavedHref(returnTo: string, locationId: string): string {
  const [path, query = ''] = returnTo.split('?', 2);
  const params = new URLSearchParams(query);
  params.delete('saved');
  params.delete('focus');
  params.set('saved', '1');
  params.set('focus', locationId);
  return `${path}?${params.toString()}#row-${locationId}`;
}

/**
 * r423 (83c0d3c8) — `UNLINKED_CLOCKING_PAGE`, `CLOCKING_NEW_PAGE_FOR`, `clockingPointBase` and
 * `clockingPointHome` STOOD HERE and are GONE. They sent a clocking point "home" to the work location it
 * hung off (r338). Clocking locations are no longer shown under a work location: every one is listed on
 * Attendance › Locations, and every way out of a clocking screen lands there
 * (./clocking/form-fields.ts `CLOCKING_LIST` / `clockingFocusHref`).
 */

/** The four fields the location form posts — every column ADR-0086 left editable. */
export const LOCATION_FIELDS = ['code', 'name', 'country', 'branch'] as const;
export type LocationField = (typeof LOCATION_FIELDS)[number];
/** Every field as a RAW STRING — what the form renders as defaults and what the action reads and echoes. */
export type LocationFormValues = Record<LocationField, string>;

/** The url key a refused save echoes `field` under: `typedCode`, `typedName`, … */
export const typedLocationKey = (field: LocationField): string =>
  `typed${field[0].toUpperCase()}${field.slice(1)}`;

/**
 * What an echoed value must look like to be rendered back into the form. Every one is an untrusted url
 * value; a malformed one is DROPPED (the page then falls back to what is on file, or to blank on the Add
 * page), never rendered and never queried. The caps are sanity limits for a url, not the service's
 * rules — core/location.ts decides what is valid when the operator saves again, so a code over its limit
 * is echoed back in full to be shortened rather than retyped.
 */
const SHAPE: Record<LocationField, (v: string) => boolean> = {
  code: (v) => v.length <= 200,
  name: (v) => v.length <= 300,
  country: (v) => v.length <= 100,
  branch: (v) => v.length <= 300,
};

/** The `typed*` echoes present on the url, each shape-checked; absent or malformed ones are left out. */
export function readTypedLocationValues(
  sp: Record<string, string | string[] | undefined>,
): Partial<LocationFormValues> {
  const out: Partial<LocationFormValues> = {};
  for (const field of LOCATION_FIELDS) {
    const raw = sp[typedLocationKey(field)];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && SHAPE[field](value)) out[field] = value;
  }
  return out;
}

export { CLOCKING_NEW_PAGE, LOCATIONS_LIST, UUID_RE };
