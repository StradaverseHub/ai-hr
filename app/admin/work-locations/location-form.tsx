import Link from 'next/link';
import { Card, ErrorBanner, Field, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { createLocationAction, updateLocationAction } from '../actions';
import { LOCATION_FIELDS, type LocationFormValues } from './location-fields';

/**
 * 639bf4a5 rev 2 (r338) — ONE work location, on a screen of its own. Rendered by ./new/page.tsx (Add) and
 * ./[id]/edit/page.tsx (Edit); the register (../page.tsx) is a COMPANY LISTING now and renders no form
 * at all, above it or below it, which is the half of the item the reporter asked for by name.
 *
 * It replaces the two inline forms the register used to carry per company — an edit strip on every row
 * and a create strip at the foot of every card. Nothing about what is STORED changed: this posts the
 * same two server actions with the same field names, and core/location.ts still decides what is valid.
 *
 * THE FOUR FIELDS ARE EVERY COLUMN ADR-0086 LEFT EDITABLE (./location-fields.ts LOCATION_FIELDS):
 * code, name, country, branch.
 *
 * ⚠️ AND THE STATE FIELD DOES NOT COME BACK. `location.state` was the top rung of the public-holiday
 * precedence until r332 removed the location join from both readers in core/holidays.ts; a control whose
 * stored value changes nothing is worse than a dead column, because an operator would set a State
 * expecting holidays to follow. The column stays in db/schema.ts as the record of what a site supplied
 * before the r328 carry; it is simply not editable and not advertised. Neither is a holiday CALENDAR —
 * migration 0484 dropped `location.holiday_group_id`; the calendar is picked on the PERSON.
 *
 * ⚠️ `state` IS NOT POSTED AS NULL EITHER, on the edit path. `updateLocation` reads an ABSENT `state` as
 * "keep" and a null one as "clear", so a form that posted an empty box would wipe the stored value on the
 * first unrelated rename. Not rendering the field is what keeps it.
 *
 * A SERVER COMPONENT, no client island: four boxes, a select and two links. Save posts; the action sends
 * a success to the listing landed on the saved row and a refusal back to THIS screen with the reason and
 * everything typed echoed (./location-fields.ts). Cancel is a plain LINK — it posts nothing.
 *
 * THE KEY IS LOAD-BEARING, for the reason ../clocking/clocking-form.tsx's is: every input is
 * UNCONTROLLED (defaultValue) and these screens are reached by next/link soft navigation, so React would
 * otherwise reuse this form at the same tree position and never re-apply the defaults.
 *
 * `returnTo` IS POSTED AND IS UNTRUSTED. It is whitelisted BY SHAPE in the action, through
 * lib/return-to.ts `workLocationsReturnTo` — a value that is not a path under /admin/work-locations falls
 * back to the listing, so there is no open-redirect shape that can survive it.
 */
export function LocationForm({
  t,
  mode,
  companyId,
  locationId,
  values,
  branchOptions,
  error,
  cancelHref,
  returnTo,
}: {
  t: (key: string, values?: Record<string, string | number>) => string;
  mode: 'new' | 'edit';
  /** Add: the company the new location belongs to. Edit: absent — the company cannot be changed here. */
  companyId?: string;
  locationId?: string;
  values: LocationFormValues;
  branchOptions: { id: string; value: string; label: string }[];
  error?: string;
  cancelHref: string;
  returnTo: string;
}) {
  return (
    <Card key={locationId ?? 'new'}>
      <SectionHeader title={t('sectionSite')} />
      <form
        action={mode === 'edit' ? updateLocationAction : createLocationAction}
        className="space-y-4 p-4"
      >
        <ErrorBanner message={error} />
        {mode === 'edit' ? (
          <input type="hidden" name="locationId" value={locationId} />
        ) : (
          <input type="hidden" name="companyId" value={companyId} />
        )}
        <input type="hidden" name="returnTo" value={returnTo} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('code')}>
            <input
              name="code"
              defaultValue={values.code}
              required
              placeholder={t('codePlaceholder')}
              className={`${inputCls} uppercase`}
            />
          </Field>
          <Field label={t('name')}>
            <input
              name="name"
              defaultValue={values.name}
              required
              placeholder={t('namePlaceholder')}
              className={inputCls}
            />
          </Field>
          <Field label={t('country')}>
            <input name="country" defaultValue={values.country} required className={`${inputCls} uppercase`} />
          </Field>
          {/* 1fff489c — the Branch this location serves, from the tenant's ACTIVE profile_option 'branch'
              catalogue (the same list the Employment tab writes employment.org_branch from). A LEGACY
              value recorded before the catalogue tightened is rendered as its own option so a plain Save
              cannot silently blank it — the same tolerance core/location.ts applies server-side. */}
          <Field label={t('branch')}>
            <select name="branch" defaultValue={values.branch} className={inputCls}>
              <option value="">{t('branchNone')}</option>
              {values.branch !== '' && !branchOptions.some((o) => o.value === values.branch) && (
                <option value={values.branch}>{values.branch}</option>
              )}
              {branchOptions.map((o) => (
                <option key={o.id} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">{t('branchHint')}</p>

        <div className="flex flex-wrap items-center gap-2">
          <button className={btnPrimary}>{t('save')}</button>
          <Link href={cancelHref} className={btnGhost}>
            {t('cancel')}
          </Link>
        </div>
      </form>
    </Card>
  );
}

/** Every field blank — what the Add screen starts from before a refusal echoes anything back. */
export const BLANK_LOCATION: LocationFormValues = Object.fromEntries(
  LOCATION_FIELDS.map((f) => [f, f === 'country' ? 'MY' : '']),
) as LocationFormValues;
