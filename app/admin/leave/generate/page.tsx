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
import { openLeaveYearAction } from '../../actions';
import { previewLeaveGenerationAction } from './actions';

/**
 * Leave Settings — Generate Entitlement (feedback 4b0e76ae, grown into the five-step module by 93249794).
 *
 * THE ENGINE WAS ALREADY BUILT; THE DOOR WAS NOT. `openLeaveYear` — the sweep that posts a leave year's
 * entitlement for every eligible employment, caps and posts carry-forward and forfeits the rest — has
 * shipped and been correct for a long time. 4b0e76ae gave it a door: a year dropdown and a Generate button,
 * shipped in the same release that deleted the Leave Year Configuration block whose Start button had been
 * its only caller, so there was no window in which a leave year could not be opened.
 *
 * That page said, in as many words, "Item 93249794 grows this same page into the approved five-step
 * wizard … and the wizard replaces it in place." This is that replacement. THE YEAR REMAINS OPENABLE AT
 * EVERY POINT: the Process button still posts to `openLeaveYearAction`, which is still the ONE route from
 * a browser to the grant sweep, and `test/leave-generate-page.test.ts` still guards exactly that. An
 * unscoped post — no leave types picked, no criteria filled — is byte-identical to the old bare button.
 *
 * ⚠️ THE PLAN'S ANCHORS FOR THIS ITEM WERE STALE, and the stale part changed the build. The build notes
 * say "openLeaveYearAction at app/admin/actions.ts:1058 has NO caller — grepped", and that
 * `leave_year_config` supplies the Entitlement Year dropdown. Both were true when the plan was written and
 * neither is true now: 4b0e76ae shipped first, gave the action its one caller, emptied `leave_year_config`
 * (migration 0385) and deleted every writer to it. So the year list is COMPUTED — `entitlementYearOptions`
 * (currentYear − 3 .. currentYear + 6), the same shared range the Run Earned Accrual selector uses.
 * Reading the table as the plan specified would render this dropdown permanently empty and permanently
 * unfillable.
 *
 * SERVER COMPONENT. Everything interactive lives in `GenerateForm`, a client component receiving only
 * serialisable props — r123/r124 broke screens in production by passing a server translator CLOSURE across
 * that boundary, and test/server-client-boundary.test.ts pins the class. The two server actions are the
 * exception the framework allows (the `countInScopeAction` precedent on the Entitlements page).
 *
 * THE CRITERIA SECTIONS ARE THE SHARED ONES. `buildOrgCriteriaSections` is the SAME builder the Leave
 * Adjustments screen calls, over the SAME `core/org-criteria.ts` vocabulary that `resolveOrgCriteriaTargets`
 * resolves. Nothing on this page decides what an axis means, which is the only way two screens can be
 * guaranteed to select the same people from the same words.
 *
 * PRESSING PROCESS TWICE IS SAFE. `openLeaveYear`'s dedupe set is built from the ledger's existing accrual
 * rows at the year start, never from a configuration table, so a second press reports those pairs as
 * `already_open` and posts nothing.
 */
export default async function LeaveGeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  // r127 SHIPPED A SIBLING SCREEN WITH TWO LABEL SETS THAT DO NOT EXIST under `admin.leave`, so every
  // employment-type chip and all eight org-criteria chips rendered through a MISSING_MESSAGE while the
  // route still returned 200. Both label sets ALREADY SHIP, fully translated in all six locales, so this
  // reads them where they live rather than minting a seventh copy: the eight org axes under
  // `admin.profileOptions.category`, the employment types under `people.wizard.employmentType`, and the
  // ~20 axis names under `admin.leave.adjustmentsCriteria` (18103ba4).
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
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('generateTitle')} />
        <div className="space-y-2 px-4 pt-3">
          <p className="max-w-2xl text-xs text-muted-foreground">{t('generateHelp')}</p>
        </div>
        <div className="px-4 pb-4 pt-2">
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

      {/* The request's "Allow HR to download the processing log", and its audit-trail list: who ran what,
          when, over how many employees, with what result. The counts are the ENGINE's own, stored verbatim
          at the moment of the run — not recomputed on read, which would quietly answer a question about
          last March with this morning's configuration. */}
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
                  that a refresh can repeat. */}
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
