import Link from 'next/link';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { MAX_REPORT_LABEL_CHARS } from '@/packs/attendance/service';
import { createClockingLocationAction, updateClockingLocationAction } from '../../actions';
import { type ClockingFormValues } from './form-fields';
import { resolveMapProvider } from './map-provider';
import { ClockingAddressSearch } from './address-search';
import { ClockingMap } from './clocking-map';

/**
 * f9afd1ce rev 2 (r267) — ONE clocking location, on a page of its own. Rendered by ./new/page.tsx and
 * ./[id]/page.tsx; the list (../page.tsx) renders no form any more.
 *
 * 0fe1ca2e rev 6 (r335) — ONE SECTION, AND THERE IS NO "LOCATION INFORMATION" HEADING ANY MORE.
 *
 * Until this round the form was TWO cards: "Location information" (search, name, report label, address,
 * the read-only link, remarks) and "GPS and clocking settings" (latitude, longitude, radius). The
 * reporter contested that, and the complaint was precise: the address search was already ABOVE Latitude
 * and already filled Address, Latitude and Longitude in (fa2db8cb rev 2, r279 — the functional half was
 * built then and NOTHING about it changes here), but a whole card boundary sat between the search and the
 * two boxes it writes, so the connection was invisible. The fix is the boundary, not the behaviour.
 *
 * (r423 — the order below is SUPERSEDED; see the r423 note at the end of this header.)
 * One card, under the GPS heading, in the reporter's then-approved order:
 *   Find an address → Address → Latitude → Longitude → Clocking radius → Name → Report label →
 *   Clocking location link (only when one exists) → Remarks
 * `admin.locations.sectionInfo` is therefore RETIRED — removed from all six locales, because a heading
 * that no screen renders is a string the next reader has to prove is dead. test/clocking-location-*.ts
 * pin its absence rather than merely stopping mentioning it.
 *
 * TWO CONSEQUENCES, BOTH SAID OUT LOUD IN THE PLAN. Name moves BELOW the coordinates, which reads
 * slightly oddly and the reporter was offered the option of lifting it back. And Address STAYS, directly
 * under the search: their sketch omitted it, but it is the field the search writes and the one the
 * Attendance report prints, so dropping it would have discarded the address just looked up.
 *
 * A SERVER COMPONENT WITH TWO CLIENT ISLANDS INSIDE IT (fa2db8cb rev 2, r279 — see below): it posts to
 * the SAME two actions the inline rows used to post to (app/admin/actions.ts createClockingLocationAction
 * / updateClockingLocationAction), with the same input names plus `reportLabel`. Nothing here decides
 * what is stored — core/clocking-location.ts does.
 *
 * WHERE EVERY WAY OUT LEADS. Save posts; the action sends a success to the list landed on the saved row
 * and a refusal back to THIS page with the reason and everything typed echoed (./form-fields.ts). Cancel
 * is a plain LINK to the list — it posts nothing. The reason a save was refused sits at the top of the
 * form, immediately above the first section's fields, not under the page header.
 *
 * THE KEY IS LOAD-BEARING (the same reason the old create strip carried one): every input is
 * UNCONTROLLED (defaultValue), and the two pages are reached by next/link soft navigation, so React would
 * otherwise reuse this form at the same tree position and never re-apply the defaults.
 *
 * THE SEARCH AND THE MAP, BUILT (fa2db8cb rev 2, r279) — REVERSING the 2026-09-11 decision this header
 * used to record ("no placeholder for the future search and map"). That decision waited on a map
 * provider being chosen; the item was approved three times and blocked twice asking the reporter for a
 * Google key that never came, so rev 2 builds on free, keyless open map data behind a provider seam
 * (./map-provider.ts) that a paid supplier's configuration later replaces without touching this screen.
 * ADR-0070 carries the superseding note. The two guards in test/clocking-location-page.test.ts that
 * pinned their absence were REWRITTEN, not deleted, and now pin what replaced it.
 *
 * ⚠️ THE ISLANDS ARE SEPARATE FILES AND TAKE NO FUNCTIONS. This file still carries no 'use client' and
 * is still rendered by two server components. ./address-search.tsx and ./clocking-map.tsx are the only
 * client code, they receive ONE prop each — the resolved provider descriptor, a plain object of strings,
 * numbers and nulls — and they read their own localised text through `useTranslations`. Nothing
 * callable crosses the boundary: r272 shipped a 500 doing precisely that and it was green on tsc,
 * eslint and thirteen source guards. `t` below is still a function prop, and is still safe for the same
 * reason it always was — both callers are server components, so it crosses no boundary at all.
 *
 * The islands do not own a single posted value. The search WRITES address / lat / lng into the
 * uncontrolled inputs below and the map READS lat / lng / radiusM out of them (./form-bridge.ts), so
 * CLOCKING_FIELDS is unchanged, a refused save still echoes everything typed, and the coordinates stay
 * typeable by hand when the map is slow or unavailable.
 *
 * r423 (83c0d3c8) — THE REPORTER'S ORDER, REVERSING r335's "Name below the coordinates": they asked to
 * create the location first and then tick the companies allowed to use it. Five numbered sections:
 *   01 Location — Location Name → Find an address → Address → State (optional, Malaysian states)
 *   02 GPS and geofencing radius — Latitude → Longitude → Geofencing Radius → the map with its circle
 *   03 Companies allowed to use this location — one tick per company, at least one (the service refuses
 *      none, and refuses unticking a company whose employees are assigned here, with the count)
 *   04 Status — Active / Inactive (the archive stamp; an inactive location is never offered and never
 *      matched at clock-in)
 *   05 Optional — Report label → Remarks (the Attendance report prints the report label), then the
 *      read-only work-location link when one exists (carried through so a Save never silently unlinks)
 * The address search still writes Address / Latitude / Longitude and the map still reads the boxes, so the
 * two islands are unchanged; only where the boxes sit moved.
 *
 * SYNCHRONOUS, taking the page's translator as a prop (the app/payroll/multi-cycle-worksheet idiom):
 * both callers are server components, so a function prop crosses no client boundary, and a sync component
 * is what lets test/clocking-location-page.test.ts render the real page with renderToStaticMarkup.
 */
export function ClockingLocationForm({
  t,
  mode,
  clockingLocationId,
  values,
  companyIds,
  companies,
  stateOptions,
  linkableLocations,
  linkNotOffered,
  assignedCount,
  error,
  cancelHref,
  returnCompany,
}: {
  /** The page's `getTranslations('admin.locations')`. */
  t: (key: string, values?: Record<string, string | number>) => string;
  mode: 'new' | 'edit';
  clockingLocationId?: string;
  /** The form's defaults: what was typed when a refusal echoed it, else what is on file, else blank. */
  values: ClockingFormValues;
  /** r423 — the ticked companies (what was typed, else what is on file, else none). */
  companyIds: string[];
  /** r423 — every company the caller may open a location to (a group administrator: all of them). */
  companies: { id: string; name: string }[];
  /** r423 — the states of those companies' countries, for the optional State select. */
  stateOptions: string[];
  /** Every LIVE location the caller can see, any company — only used to caption an existing link. */
  linkableLocations: { id: string; code: string; name: string; companyName: string | null }[];
  /**
   * A link the picker cannot offer (an archived location) is kept as its own option so a plain Save
   * cannot silently unlink the point. The form just never LIES about what is linked.
   */
  linkNotOffered?: { id: string; code: string | null; name: string | null } | null;
  /** r423 — employees assigned today (edit only), said beside Status. */
  assignedCount?: number;
  error?: string;
  cancelHref: string;
  /**
   * r428 (83c0d3c8 contest) — the company this screen was opened FROM (step 2 of the company-first
   * redesign), already re-validated by the page against the location's own companies (new) or the
   * caller's administered companies (edit). Carried as a hidden field so Save lands back on that
   * company's view rather than the bare list; absent on a New opened from the top-level company list.
   */
  returnCompany?: string;
}) {
  const textareaCls = inputCls.replace('h-9', 'min-h-[4.5rem] py-2');
  // The seam, read ONCE per render on the server. With no map variables set this is the free, keyless
  // OpenStreetMap provider, and it reports no satellite. It never throws when a key is absent.
  const mapProvider = resolveMapProvider(process.env);
  /** The linked work location's caption, or null when there is no link. An ARCHIVED link is still named. */
  const linkedLabel: string | null = (() => {
    const id = (values.locationId ?? '').trim();
    if (!id) return null;
    if (linkNotOffered?.id === id) {
      return `${linkNotOffered.code ?? '?'} · ${linkNotOffered.name ?? '?'} · ${t('statusArchived')}`;
    }
    const hit = linkableLocations.find((l) => l.id === id);
    return hit ? `${hit.code} · ${hit.name} · ${hit.companyName ?? ''}`.trim() : null;
  })();
  const ticked = new Set(companyIds);
  const status = values.status === 'inactive' ? 'inactive' : 'active';
  // A state on file that is no longer in the vocabulary is still SHOWN (and posted back) rather than
  // silently blanked; the service judges it on save.
  const states = values.state && !stateOptions.includes(values.state) ? [values.state, ...stateOptions] : stateOptions;
  return (
    <form
      action={mode === 'edit' ? updateClockingLocationAction : createClockingLocationAction}
      key={clockingLocationId ?? 'new'}
      className="space-y-6"
    >
      {mode === 'edit' && <input type="hidden" name="clockingLocationId" value={clockingLocationId} />}
      {returnCompany && <input type="hidden" name="returnCompany" value={returnCompany} />}

      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        {/* 01 · LOCATION — the name first, then where it is. */}
        <SectionHeader title={t('sectionLocation')} />
        <div className="grid grid-cols-1 gap-4 p-4">
          <Field label={t('locationName')} required>
            <input name="name" defaultValue={values.name} required maxLength={300} placeholder={t('clockingNamePlaceholder')} className={inputCls} />
          </Field>
        </div>
        {/* The search, and then the boxes it writes. On a button press only — the free geocoder's usage
            policy forbids search-as-you-type. */}
        <ClockingAddressSearch provider={mapProvider} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('address')} className="sm:col-span-2">
            <textarea name="address" defaultValue={values.address} rows={2} maxLength={1000} className={textareaCls} />
          </Field>
          {/* r423 — display and filtering only; it never changes public holidays. */}
          <Field label={t('stateOptional')}>
            <select name="state" defaultValue={values.state} className={inputCls}>
              <option value="">{t('stateNone')}</option>
              {states.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* 02 · GPS AND GEOFENCING RADIUS — the three boxes, then the picture of them. */}
        <div className="border-t border-border">
          <SectionHeader title={t('sectionGps')} />
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('lat')} required>
            <input name="lat" type="number" step="any" min={-90} max={90} defaultValue={values.lat} required placeholder="3.1390" className={inputCls} />
          </Field>
          <Field label={t('lng')} required>
            <input name="lng" type="number" step="any" min={-180} max={180} defaultValue={values.lng} required placeholder="101.6869" className={inputCls} />
          </Field>
          {/* 1fff489c — the allowed distance, per site. Required by the form AND by the service; min=1 is
              the DB CHECK, and the 10..5000 advisory is a toast, never a block. */}
          <Field label={t('radiusMetresLabel')} required>
            <input name="radiusM" type="number" min={1} step={1} defaultValue={values.radiusM} required placeholder="150" className={inputCls} />
          </Field>
        </div>
        <p className="px-4 pb-3 text-xs text-muted-foreground">{t('radiusNote')}</p>
        <ClockingMap provider={mapProvider} />
      </Card>

      {/* 03 · COMPANIES — at least one. Plain checkboxes posting one `companyIds` entry per tick. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('sectionCompanies')} />
        <fieldset className="p-4">
          <legend className="sr-only">{t('sectionCompanies')}</legend>
          {companies.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noCompanies')}</p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              {companies.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="companyIds" value={c.id} defaultChecked={ticked.has(c.id)} className="h-4 w-4" />
                  {c.name}
                </label>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t('companiesHint')}</p>
        </fieldset>
      </Card>

      {/* 04 · STATUS — the archive stamp, said as the two words the list uses. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('sectionStatus')} />
        <fieldset className="p-4">
          <legend className="sr-only">{t('sectionStatus')}</legend>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="status" value="active" defaultChecked={status === 'active'} className="h-4 w-4" />
              {t('statusActive')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="status" value="inactive" defaultChecked={status === 'inactive'} className="h-4 w-4" />
              {t('statusInactive')}
            </label>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('inactiveNote')}</p>
          {mode === 'edit' && assignedCount != null && assignedCount > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">{t('assignedEmployees', { count: assignedCount })}</p>
          ) : null}
        </fieldset>
      </Card>

      {/* 05 · OPTIONAL — the report label (the Attendance report prints it) and remarks. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('sectionOptional')} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          <Field label={t('reportLabel')}>
            <input name="reportLabel" defaultValue={values.reportLabel} maxLength={MAX_REPORT_LABEL_CHARS} placeholder={t('reportLabelPlaceholder')} className={inputCls} />
          </Field>
          <Field label={t('remarks')}>
            <input name="remarks" defaultValue={values.remarks} maxLength={1000} className={inputCls} />
          </Field>
          {/*
            * 0fe1ca2e — the optional link to a work `location` is not a control. When one EXISTS it is
            * shown read-only and carried through the post, because the service writes `locationId`
            * unconditionally and an absent field would silently unlink the row. None is rendered when
            * there is no link, which is every production row.
            */}
          {linkedLabel && (
            <Field label={t('clockingLocationLinkOptional')}>
              <input type="hidden" name="locationId" value={values.locationId} />
              <p className="flex h-9 items-center text-sm text-muted-foreground">{linkedLabel}</p>
            </Field>
          )}
        </div>
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t('reportLabelHint')}</p>
      </Card>

      <div className="flex items-center gap-3">
        <button className={btnPrimary}>{t('save')}</button>
        {/* Cancel is a LINK to the list — never a second form; nothing is posted. */}
        <Link href={cancelHref} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          {t('cancel')}
        </Link>
      </div>
    </form>
  );
}
