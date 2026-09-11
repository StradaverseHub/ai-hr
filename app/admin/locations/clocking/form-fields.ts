/**
 * f9afd1ce rev 2 (r267) — the CONTRACT between the clocking-location page (./new/page.tsx and
 * ./[id]/page.tsx), its form (./clocking-form.tsx) and the two server actions in app/admin/actions.ts:
 * the field names the form posts, the `typed*` keys a refused save echoes them back under, and the
 * addresses each outcome lands on. ONE module, read by both sides, so the page cannot echo a key the
 * action never wrote or the action write one the page never reads (CLAUDE.md §8: a contract between two
 * files is pinned across both — test/clocking-location-page.test.ts reads this file).
 *
 * A plain module: no 'use server', no 'use client', no database — safe to import from either side.
 */

/** The Locations list — the one screen every way out of the page leads to. */
export const LOCATIONS_LIST = '/admin/locations';
export const CLOCKING_NEW_PAGE = '/admin/locations/clocking/new';
export const clockingEditPage = (id: string) => `/admin/locations/clocking/${id}`;
/** The list, landed on ONE site's row and highlighted: what Back, Cancel and a successful Save return to. */
export const clockingRowHref = (id: string) => `${LOCATIONS_LIST}?focus=${id}#row-${id}`;

/** `[id]`, `?focus=` and a posted `clockingLocationId` all address a uuid column: shape-checked before use. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The eight fields the form posts — the seven a site held before r267 plus the report label. */
export const CLOCKING_FIELDS = ['name', 'reportLabel', 'address', 'locationId', 'remarks', 'lat', 'lng', 'radiusM'] as const;
export type ClockingField = (typeof CLOCKING_FIELDS)[number];
/** Every field as a RAW STRING — what the form renders as defaults and what the action reads and echoes. */
export type ClockingFormValues = Record<ClockingField, string>;

/** The url key a refused save echoes `field` under: `typedName`, `typedReportLabel`, … */
export const typedKey = (field: ClockingField): string => `typed${field[0].toUpperCase()}${field.slice(1)}`;

/**
 * What an echoed value must look like to be rendered back into the form. Every one is an untrusted url
 * value; a malformed one is DROPPED (the page then falls back to what is on file, or to blank on the
 * new page), never rendered and never queried. The caps are sanity limits for a url, not the service's
 * rules — the service decides what is valid when the operator saves again (a report label over its
 * limit is echoed back in full so it can be shortened rather than retyped).
 */
const SHAPE: Record<ClockingField, (v: string) => boolean> = {
  name: (v) => v.length <= 300,
  reportLabel: (v) => v.length <= 300,
  address: (v) => v.length <= 1000,
  remarks: (v) => v.length <= 1000,
  locationId: (v) => v === '' || UUID_RE.test(v),
  lat: (v) => v === '' || (v.length <= 40 && Number.isFinite(Number(v))),
  lng: (v) => v === '' || (v.length <= 40 && Number.isFinite(Number(v))),
  radiusM: (v) => v === '' || /^\d{1,9}$/.test(v),
};

/** The `typed*` echoes present on the url, each shape-checked; absent or malformed ones are left out. */
export function readTypedClockingValues(sp: Record<string, string | string[] | undefined>): Partial<ClockingFormValues> {
  const out: Partial<ClockingFormValues> = {};
  for (const field of CLOCKING_FIELDS) {
    const raw = sp[typedKey(field)];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && SHAPE[field](value)) out[field] = value;
  }
  return out;
}
