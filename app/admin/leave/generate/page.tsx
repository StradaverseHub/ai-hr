import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { entitlementYearOptions } from '@/core/leave';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
import { openLeaveYearAction } from '../../actions';

/**
 * Leave Settings — Generate Entitlement (feedback 4b0e76ae).
 *
 * THE ENGINE WAS ALREADY BUILT; THE DOOR WAS NOT. `openLeaveYear` — the sweep that posts a leave year's
 * entitlement for every eligible employment, caps and posts carry-forward and forfeits the rest — has
 * shipped and been correct for a long time. Its ONLY entry point was the Start button inside the Leave Year
 * Configuration block on every leave type's Custom Settings step. The reporter asked for that block to go,
 * and was explicit that generating entitlements must survive. So this page ships in the SAME release: there
 * is no window in which a leave year cannot be opened.
 *
 * DELIBERATELY A PLAIN BUTTON. Item 93249794 grows this same page into the approved five-step wizard (leave
 * type and employee selection, a validation preview over projectExpectedEntitlement, a per-employee error
 * table, a downloadable log). That item is Large, is documented as best built across two releases, and its
 * selection step waits on a still-contested eligibility layer. Gating this removal behind it would gate it
 * on a contested item for months. Pick a year, press Generate, read the counts — that is the floor, not the
 * finished module, and the wizard replaces it in place.
 *
 * THE YEAR LIST IS COMPUTED, NOT READ. `entitlementYearOptions` is the ONE shared range (currentYear − 3 ..
 * currentYear + 6), also feeding the Run Earned Accrual selector on the Entitlements tab. Reading
 * leave_year_config instead — which an earlier draft of 93249794 specified — would render this dropdown
 * permanently empty and permanently unfillable, because this item empties that table AND deletes every
 * writer to it.
 *
 * SERVER COMPONENT, AND IT HOLDS NOTHING INTERACTIVE. The year select and the submit are a plain HTML form
 * posting straight to the server action, so no client component is mounted and nothing unserialisable can
 * cross a boundary (the r123 defect test/server-client-boundary.test.ts exists to catch). Success and
 * failure both come back through the redirect: ?toast= for the counts, ?error= for the banner.
 *
 * PRESSING GENERATE TWICE IS SAFE. openLeaveYear's dedupe set is built from the ledger's existing accrual
 * rows at the year start, never from a configuration table, so a second press reports the employees as
 * already-granted and posts nothing. Clearing leave_year_config cannot cause a double grant for the same
 * reason.
 */
export default async function LeaveGeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;

  const currentYear = new Date().getUTCFullYear();
  const years = entitlementYearOptions(currentYear);

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('generateTitle')} />
        <div className="space-y-4 px-4 py-4">
          <p className="max-w-2xl text-xs text-muted-foreground">{t('generateHelp')}</p>
          <form action={openLeaveYearAction} className="flex flex-wrap items-end gap-3">
            <Field label={t('yearLabel')}>
              <select name="year" defaultValue={String(currentYear)} className={`${inputCls} w-28`}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </Field>
            <button className={btnPrimary}>{t('generateButton')}</button>
          </form>
        </div>
      </Card>
    </div>
  );
}
