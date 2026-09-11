import Link from 'next/link';
import { Card, ErrorBanner, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { MAX_REPORT_LABEL_CHARS } from '@/packs/attendance/service';
import { createClockingLocationAction, updateClockingLocationAction } from '../../actions';
import { type ClockingFormValues } from './form-fields';

/**
 * f9afd1ce rev 2 (r267) — ONE clocking location, on a page of its own, in TWO sections in the reporter's
 * order: Location information (name, report label, address, the optional holiday-calendar link, remarks)
 * then GPS and clocking settings (latitude, longitude, radius). Rendered by ./new/page.tsx and
 * ./[id]/page.tsx; the list (../page.tsx) renders no form any more.
 *
 * A SERVER-RENDERED FORM, no client island: it posts to the SAME two actions the inline rows used to post
 * to (app/admin/actions.ts createClockingLocationAction / updateClockingLocationAction), with the same
 * input names plus `reportLabel`. Nothing here decides what is stored — core/clocking-location.ts does.
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
 * NO PLACEHOLDER FOR THE FUTURE SEARCH AND MAP (owner's decision 2026-09-11; AGENTS 28: no inert
 * control). The section order simply leaves room for them: a search under Location information, a map
 * preview under GPS and clocking settings.
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
  linkableLocations,
  linkNotOffered,
  error,
  cancelHref,
}: {
  /** The page's `getTranslations('admin.locations')`. */
  t: (key: string, values?: Record<string, string | number>) => string;
  mode: 'new' | 'edit';
  clockingLocationId?: string;
  /** The form's defaults: what was typed when a refusal echoed it, else what is on file, else blank. */
  values: ClockingFormValues;
  /** Every LIVE location the caller can see, any company — the link is optional and not company-bound. */
  linkableLocations: { id: string; code: string; name: string; companyName: string | null }[];
  /**
   * A link the picker cannot offer (an archived location) is kept as its own option so a plain Save
   * cannot silently unlink the point. The service still refuses an archived link on save, and says so;
   * the form just never LIES about what is linked.
   */
  linkNotOffered?: { id: string; code: string | null; name: string | null } | null;
  error?: string;
  cancelHref: string;
}) {
  const textareaCls = inputCls.replace('h-9', 'min-h-[4.5rem] py-2');
  return (
    <form
      action={mode === 'edit' ? updateClockingLocationAction : createClockingLocationAction}
      key={clockingLocationId ?? 'new'}
      className="space-y-6"
    >
      {mode === 'edit' && <input type="hidden" name="clockingLocationId" value={clockingLocationId} />}

      <ErrorBanner message={error} />

      {/* SECTION 1 — Location information. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('sectionInfo')} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
          {/* The point keeps its OWN name (the reporter's "HQ — North Gate" / "HQ — South Gate" reading). */}
          <Field label={t('name')} required>
            <input name="name" defaultValue={values.name} required placeholder={t('clockingNamePlaceholder')} className={inputCls} />
          </Field>
          {/* NEW (0461): the short name the Attendance report prints; blank = the name is printed. */}
          <Field label={t('reportLabel')}>
            <input name="reportLabel" defaultValue={values.reportLabel} maxLength={MAX_REPORT_LABEL_CHARS} className={inputCls} />
          </Field>
          <Field label={t('address')} className="sm:col-span-2">
            <textarea name="address" defaultValue={values.address} rows={2} className={textareaCls} />
          </Field>
          {/* f9afd1ce — OPTIONAL, and any company's location: a site shared by five companies cannot be
              required to belong to one company's holiday-calendar record. */}
          <Field label={t('clockingLocationLinkOptional')}>
            <select name="locationId" defaultValue={values.locationId} className={inputCls}>
              <option value="">{t('clockingLocationNone')}</option>
              {linkNotOffered && (
                <option value={linkNotOffered.id}>
                  {linkNotOffered.code ?? '?'} · {linkNotOffered.name ?? '?'} · {t('statusArchived')}
                </option>
              )}
              {linkableLocations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} · {l.name} · {l.companyName}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('remarks')}>
            <input name="remarks" defaultValue={values.remarks} className={inputCls} />
          </Field>
        </div>
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t('reportLabelHint')}</p>
      </Card>

      {/* SECTION 2 — GPS and clocking settings. Plain numeric inputs: the map is its own, later item. */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('sectionGps')} />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
          <Field label={t('lat')} required>
            <input name="lat" type="number" step="any" min={-90} max={90} defaultValue={values.lat} required placeholder="3.1390" className={inputCls} />
          </Field>
          <Field label={t('lng')} required>
            <input name="lng" type="number" step="any" min={-180} max={180} defaultValue={values.lng} required placeholder="101.6869" className={inputCls} />
          </Field>
          {/* 1fff489c — the allowed distance, per site. Required by the form AND by the service; min=1 is
              the DB CHECK, and the 10..5000 advisory is a toast, never a block. Posted as the raw string so
              a blank reaches "Radius is required" rather than becoming NaN. */}
          <Field label={t('radiusMetresLabel')} required>
            <input name="radiusM" type="number" min={1} step={1} defaultValue={values.radiusM} required placeholder="150" className={inputCls} />
          </Field>
        </div>
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t('radiusNote')}</p>
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
