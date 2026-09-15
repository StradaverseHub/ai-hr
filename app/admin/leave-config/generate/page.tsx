import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { entitlementYearOptions } from '@/core/leave';
import { listLeaveTypes, listCompanies, listDepartments, listJobGrades, listEmployees } from '@/core/read';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listLocations } from '@/core/location';
import { listAllProfileOptions } from '@/core/profile-options';
import { buildOrgCriteriaSections } from '@/core/org-criteria-form';
import { listLeaveGenerationRuns } from '@/packs/leave/service';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { GenerateForm } from '@/components/leave/generate-form';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { openLeaveYearAction } from '../../actions';
import { previewLeaveGenerationAction } from '../../leave/generate/actions';

/**
 * a6fe37fc — GENERATE ENTITLEMENT (`/admin/leave-config/generate`).
 *
 * ⚠️ ROUND 5 (cutover) HAS HAPPENED: this IS the screen. `/admin/leave/generate` is an unguarded redirect
 * stub pointing here, it has left lib/permissions.ts's leaveConfig `routes`, and both menus name this
 * address — the sidebar fly-out row and the area map's `generateEntitlement` entry. The stub is never
 * deleted; the reporter's bookmarks are why it exists.
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
 * A SAVE MADE HERE LANDS HERE. `openLeaveYearAction` redirects to the `GENERATE` module constant
 * (app/admin/_redirects.ts), which was repointed at this address in the same commit that emptied the old
 * page — so the grant counts and any `?error=` arrive on the screen the operator pressed the button on,
 * which is what the Round 3 preview note existed to apologise for. The note is gone with the apology.
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
  const [
    types,
    departments,
    profileOptions,
    grades,
    positions,
    costCenters,
    businessUnits,
    locations,
    runs,
    employments,
  ] = await Promise.all([
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
      /**
       * r287 (ff1c935f) — STEP ③'s "Pick individually" picker, read ONCE for the page.
       *
       * `listEmployees` is the UNPAGINATED picker read (see its header: "Do NOT swap in the paginated
       * `listEmployeesPage`" — a checkbox set that silently drops people past a page boundary is the
       * defect this screen cannot afford). Scoped to the administrator's own companies, exactly as the
       * location list above is.
       *
       * ⚠️ NOT FILTERED TO ACTIVE EMPLOYMENTS, and that is a decision rather than an omission. This list is
       * the SECOND door onto the same population the paste box has always reached, and narrowing one door
       * but not the other is how "two ways in, one list out" stops being true. Whether a selected person
       * actually qualifies is `resolveOrgCriteriaTargets`'s to decide — as at 1 January of the chosen year,
       * identically for both doors — and the live matched count on step ③ reports its answer.
       */
      listEmployees(s, companyIds),
    ]);

  const criteriaSections = buildOrgCriteriaSections(
    { companies, departments, grades, positions, costCenters, businessUnits, locations, profileOptions },
    { crit: tCrit, org: tOrg, employmentType: tEmploymentType },
  );

  const currentYear = new Date().getUTCFullYear();
  const years = entitlementYearOptions(currentYear);
  // 10b59703 — the heading is the submenu ROW ("Generate Entitlement") and the description is this
  // page's own; it used to borrow admin.leave.pageDescription, the Leave types sentence.
  const header = await leaveConfigPageHeader('generateEntitlement');

  /**
   * r281 (09386e29) — RUN EARNED ACCRUAL HAS LEFT THIS PAGE, and the reason is the one thing this screen
   * must never be ambiguous about.
   *
   * r266 moved it here from every leave type's tab 3 on the grounds that it is an execution rather than a
   * setting, and filed it between the wizard and the run log. That put it next to the single operation it
   * must not be confused with: this page CREATES a leave year's entitlement, while earned accrual posts
   * only what has already been earned and is not yet on the ledger. It has a fly-out row and a page of
   * its own now, directly after this one, so the two stay neighbours without one being filed inside the
   * other. Nothing about either tool changed — only the address.
   *
   * THE FOUR READS THAT FED IT LEFT WITH IT: the grant-aware company list and the active grade list are
   * derived on the new page, from the same calls. `grades` and `types` are still read HERE because the
   * criteria builder and the wizard's leave-type picker need them, which is why this is a mount moving
   * rather than a read moving.
   */

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      {/* One page under this row, so the tab row renders nothing; the mount stays so the module's
          "every page renders the map" guard keeps one shape. `current="generateEntitlement"` because
          this IS that screen. */}
      <LeaveConfigMap current="generateEntitlement" />
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
            /* r287 — THREE PLAIN FIELDS, NO FUNCTIONS AND NO PRE-JOINED SENTENCES. r123/r124 took tabs
               down in production by handing a client component a server closure, and
               test/server-client-boundary.test.ts pins that class; the form composes every string it
               shows from this data on its own side of the boundary. */
            employees={employments.map((e) => ({
              id: e.employmentId,
              name: e.name,
              employeeCode: e.employeeCode,
            }))}
          />
        </div>
      </Card>

      {/* r281 (09386e29) — THE RUN EARNED ACCRUAL CARD STOOD HERE, between the wizard and the run log,
          and is DELIBERATELY GONE rather than copied: it has a fly-out row and a page of its own directly
          after this one. ONE PLACE, NOT TWO — leaving a second mount here would be two doors onto one
          operation, and this page is the one screen that operation must never read as part of. No pointer
          is left in its place either, because unlike tab 3 (which kept one, under a row that does not name
          the tool at all) the menu itself now carries the name one row below this page's own. */}

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
