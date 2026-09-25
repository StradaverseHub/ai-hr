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

/**
 * The Locations register — the screen this family hangs off.
 *
 * 639bf4a5 (r336): these addresses moved from `/admin/locations` to `/admin/work-locations` when the
 * register left Attendance for Organization. rev 2 (r338) moves the row BACK to Attendance and renames
 * the function to "Locations" — and deliberately does NOT move the route a second time: the reporter
 * asked to rename the function, not the address, and a second move in two days would churn every
 * bookmark again and need the three `/admin/locations` redirect stubs re-pointed for nothing.
 *
 * ONE SPELLING. `/admin/work-locations` is declared in lib/return-to.ts (where the shape-whitelist that
 * guards every return-to has to know it anyway) and re-exported here under the name the screens, the
 * server actions and the three redirect stubs have always read it by.
 */
export { WORK_LOCATIONS_LIST as LOCATIONS_LIST } from '@/lib/return-to';
export const CLOCKING_NEW_PAGE = '/admin/work-locations/clocking/new';
export const clockingEditPage = (id: string) => `/admin/work-locations/clocking/${id}`;
/**
 * 639bf4a5 rev 2 (r338) — `clockingRowHref` STOOD HERE and is gone. It sent every way out of a clocking
 * point's screen to `<the register>?focus=<id>#row-<id>`, which was right while the register rendered the
 * clocking rows. It is a COMPANY LISTING now and renders none, so that anchor would have been dead: the
 * operator would have landed on a table of companies with nothing highlighted and no sign of what they
 * just saved. A point now goes home to the LOCATION it hangs off — `clockingPointBase` /
 * `clockingPointHome` in ../location-fields.ts, which is the "site and its points in one place" half of
 * the item — or, for a point linked to nothing, to the screen that holds those.
 */

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
