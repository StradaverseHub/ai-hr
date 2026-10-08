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

/**
 * r423 (83c0d3c8) — ATTENDANCE › LOCATIONS IS THE CLOCKING LOCATION LIST, at this existing address (it held
 * only the "points linked to no location" until now). `LOCATIONS_LIST` above keeps its name and its value
 * for the WORK LOCATIONS listing (menu row "Work Locations", same address since r336) because every work
 * location screen and action reads it by that name; the clocking screens read CLOCKING_LIST.
 *
 * View is a READ-ONLY page of its own and Edit is the form (the plan's View / Edit / Deactivate), so the
 * edit form moved from `/clocking/<id>` to `/clocking/<id>/edit`. The `/admin/locations/clocking/<id>`
 * redirect stub reads clockingEditPage and so follows it.
 */
export const CLOCKING_LIST = '/admin/work-locations/clocking';
export const CLOCKING_NEW_PAGE = '/admin/work-locations/clocking/new';
export const clockingViewPage = (id: string) => `/admin/work-locations/clocking/${id}`;
export const clockingEditPage = (id: string) => `/admin/work-locations/clocking/${id}/edit`;
/**
 * The list, landed on one location's row and highlighted: what Back and Cancel return to (nothing saved).
 *
 * r428 (83c0d3c8 contest) — an optional second argument carries the COMPANY this screen was opened from
 * (the company-first redesign's step 2), so Back lands on that company's view rather than the bare list.
 * Only a VALID uuid is accepted here — the two callers (the View and Edit pages) re-validate it against
 * the location's own `companies` before passing it in, because this function itself does not query.
 */
export const clockingFocusHref = (id: string, companyId?: string) =>
  `${CLOCKING_LIST}?${companyId ? `company=${companyId}&` : ''}focus=${id}#row-${id}`;
/**
 * 639bf4a5 rev 2 (r338) removed an earlier `clockingRowHref`, because the register it pointed at had
 * stopped rendering clocking rows. r423's `clockingFocusHref` is its successor, for the list that renders
 * nothing else (a Save lands there too, with `saved=1`, built in app/admin/actions.ts clockingSaved).
 */

/** `[id]`, `?focus=` and a posted `clockingLocationId` all address a uuid column: shape-checked before use. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single-valued fields the form posts — the seven a site held before r267, the report label, and r423's
 * state and status. The COMPANIES are a multi-value field (one `companyIds` entry per tick) and are echoed
 * separately under `typedCompanyIds`, comma-joined (COMPANY_FIELD / readTypedCompanyIds below).
 */
export const CLOCKING_FIELDS = ['name', 'reportLabel', 'address', 'locationId', 'remarks', 'lat', 'lng', 'radiusM', 'state', 'status'] as const;
/** r423 — the multi-value companies field, and the url key a refusal echoes it under. */
export const COMPANY_FIELD = 'companyIds';
export const TYPED_COMPANY_IDS = 'typedCompanyIds';
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
  state: (v) => v.length <= 100,
  status: (v) => v === 'active' || v === 'inactive',
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

/** r423 — the echoed company ticks: comma-joined uuids; anything malformed is dropped. Null when absent. */
export function readTypedCompanyIds(sp: Record<string, string | string[] | undefined>): string[] | null {
  const raw = sp[TYPED_COMPANY_IDS];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  return value.split(',').filter((v) => UUID_RE.test(v));
}
