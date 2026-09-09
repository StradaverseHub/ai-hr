import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { entitlementYearOptions } from '@/core/leave';
import { listLeaveTypes, listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listLocations } from '@/core/location';
import { listAllProfileOptions } from '@/core/profile-options';
import { buildOrgCriteriaSections } from '@/core/org-criteria-form';
import { listLeaveGenerationRuns } from '@/packs/leave/service';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { GenerateForm } from '@/components/leave/generate-form';
import { LeaveConfigMap, leaveConfigScreenTitle } from '@/components/leave-config-map';
import { openLeaveYearAction } from '../../actions';
import { previewLeaveGenerationAction } from '../../leave/generate/actions';
import { LeaveConfigPreviewNote } from '../preview-note';

/**
 * a6fe37fc ROUND 3 — GENERATE ENTITLEMENT at its new address (`/admin/leave-config/generate`).
 *
 * ⚠️ IT REPLACES NOTHING YET. `/admin/leave/generate` is untouched, still registered and still what the
 * menu links to; Round 5 empties that page and repoints its address here.
 *
 * ⚠️ THE FIVE-STEP WIZARD IS NOT RE-IMPLEMENTED (IA §2.3). `GenerateForm` is the SAME client component
 * the old page mounts, driven by the SAME two server actions — `openLeaveYearAction`, which is still the
 * ONE route from a browser to the grant sweep, and `previewLeaveGenerationAction`. The criteria sections
 * come from `buildOrgCriteriaSections`, the SAME builder the Adjustments screen calls over the SAME
 * `core/org-criteria.ts` vocabulary: nothing on this page decides what an axis means, which is the only
 * way two screens can be guaranteed to select the same people from the same words.
 *
 * ⚠️ TWO THINGS THE OLD PAGE DOES THAT A NAIVE COPY LOSES, and one of them IA §3.2 never wrote down:
 *   · F41 is the wizard. It is the row the table has.
 *   · **F50 — the generation-run log and its per-run CSV download** ("Allow HR to download the processing
 *     log", 93249794). It is a whole second Card and the audit trail of every sweep ever run: who ran
 *     what, over how many employees, with what result. §3.2's F41 row names only the wizard, so a
 *     table-keyed anti-drop guard could not have seen this go — the same shape of omission as F47/F48 on
 *     the leave type screen. It is carried here and §3.2 now lists it as F50.
 *   · the counts are the ENGINE's own, stored verbatim at the moment of the run and NOT recomputed on
 *     read — recomputing would quietly answer a question about last March with this morning's
 *     configuration.
 *
 * THE YEAR LIST IS COMPUTED, NOT READ. `entitlementYearOptions` (currentYear − 3 … currentYear + 6);
 * `leave_year_config` was emptied by migration 0385 and every writer to it deleted, so reading it would
 * render this dropdown permanently empty and permanently unfillable (the stale-anchor trap 4b0e76ae hit).
 *
 * A SAVE MADE HERE LANDS ON THE OLD SCREEN — see `../preview-note.tsx`. `openLeaveYearAction` redirects
 * to the `GENERATE` module constant, which still names `/admin/leave/generate` until Round 5.
 *
 * SERVER COMPONENT. Everything interactive lives in `GenerateForm`, which receives only serialisable
 * props — r123/r124 broke screens in production by passing a server translator CLOSURE across that
 * boundary, and test/server-client-boundary.test.ts pins the class.
 */
export default async function LeaveConfigGeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  // r127 SHIPPED A SIBLING SCREEN WITH TWO LABEL SETS THAT DO NOT EXIST under `admin.leave`, so every
  // employment-type chip and all eight org-criteria chips rendered through a MISSING_MESSAGE while the
  // route still returned 200. All three label sets ALREADY SHIP, fully translated in six locales, so this
  // reads them where they live rather than minting a copy — exactly as the old page does.
  const tOrg = await getTranslations('admin.profileOptions.category');
  const tEmploymentType = await getTranslations('people.wizard.employmentType');
  const tCrit = await getTranslations('admin.leave.adjustmentsCriteria');
  const { error } = await searchParams;

  const companies = await listCompanies(s);
  const companyIds = companies.map((c) => c.id);
  const [types, departments, profileOptions, grades, positions, costCenters, businessUnits, locations, runs] =
    await Promise.all([
      listLeaveTypes(s, { includeArchived: false }),
      listDepartments(s),
      listAllProfileOptions(s),
      listJobGrades(s),
      listPositions(s),
      listCostCenters(s),
      listBusinessUnits(s),
      // The only list keyed by company rather than tenant. Empty scope ⇒ no locations, which is honest: an
      // administrator who can see no company can narrow by no site either.
      companyIds.length ? listLocations(s, companyIds) : Promise.resolve([]),
      listLeaveGenerationRuns(s, { limit: 10 }),
    ]);

  const criteriaSections = buildOrgCriteriaSections(
    { companies, departments, grades, positions, costCenters, businessUnits, locations, profileOptions },
    { crit: tCrit, org: tOrg, employmentType: tEmploymentType },
  );

  const currentYear = new Date().getUTCFullYear();
  const years = entitlementYearOptions(currentYear);

  return (
    <div className="space-y-6">
      <PageHeader
        title={await leaveConfigScreenTitle('generateEntitlement')}
        description={t('pageDescription')}
      />
      {/* `current="generateEntitlement"` because this IS that screen — the map names screens, not
          addresses, and Round 5 repoints the entry here. */}
      <LeaveConfigMap current="generateEntitlement" />
      <LeaveConfigPreviewNote />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('generateTitle')} />
        <div className="space-y-2 px-4 pt-3">
          <p className="max-w-2xl text-xs text-muted-foreground">{t('generateHelp')}</p>
        </div>
        <div className="px-4 pb-4 pt-2">
          {/* F41 — the five-step wizard, MOUNTED, not re-implemented. An unscoped post (no leave types
              picked, no criteria filled) is byte-identical to the bare Generate button 4b0e76ae shipped. */}
          <GenerateForm
            action={openLeaveYearAction}
            previewAction={previewLeaveGenerationAction}
            years={years}
            defaultYear={currentYear}
            leaveTypes={types.map((x) => ({ value: x.id, label: x.name }))}
            criteriaSections={criteriaSections}
          />
        </div>
      </Card>

      {/* F50 — the processing log the request asked for, and its audit-trail list. Absent from IA §3.2's
          F41 row; see this file's header. */}
      <Card>
        <SectionHeader title={t('generateRunsTitle')} count={runs.length} />
        <ul className="divide-y divide-border">
          {runs.length === 0 && (
            <li className="px-4 py-4 text-center text-xs text-muted-foreground">{t('generateRunsNone')}</li>
          )}
          {runs.map((run) => (
            <li key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {t('generateRunsHeading', { year: run.leaveYear })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('generateRunsLine', {
                    selected: run.employeesSelected,
                    passed: run.employeesPassed,
                    failed: run.employeesFailed,
                    granted: run.granted,
                    forfeits: run.forfeits,
                  })}
                </span>
              </div>
              {/* A plain link, not a form: downloading is a read, appends no event and must not be a POST
                  that a refresh can repeat. THE ADDRESS IS THE OLD ONE ON PURPOSE — the `/export` route
                  handler moves with the screen in Round 5 (IA §3.2), and this round adds and removes
                  nothing, so pointing at a handler that does not exist yet would break the download. */}
              <a
                href={`/admin/leave/generate/export?run=${run.id}`}
                className="shrink-0 text-xs font-medium text-primary underline underline-offset-2"
              >
                {t('generateRunsDownload')}
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
