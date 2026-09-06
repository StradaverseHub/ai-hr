import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listDepartments, listJobGrades } from '@/core/read';
import { listBusinessUnits, listCostCenters, listPositions } from '@/core/admin';
import { listLocations } from '@/core/location';
import { listLeaveAdjustmentBatches } from '@/core/leave-adjustment';
import { buildOrgCriteriaSections } from '@/core/org-criteria-form';
import { listAllProfileOptions } from '@/core/profile-options';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { AdjustmentForm } from '@/components/leave/adjustment-form';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { LeaveConfigMap, leaveConfigScreenTitle } from '@/components/leave-config-map';
import {
  applyLeaveAdjustmentAction,
  previewLeaveAdjustmentAction,
  reverseLeaveAdjustmentAction,
} from './actions';

/**
 * Leave Settings — Leave Adjustments (491c499f; rebuilt as a four-step flow by 18103ba4).
 *
 * THE ITEM'S POINT, IN ONE LINE: an adjustment is a TRANSACTION, not configuration. It was living inside a
 * leave type's Entitlement step, which meant an operational task sat in a settings screen and a grant
 * spanning several types had to be repeated per type. This is its own place, and it takes many types at
 * once.
 *
 * 18103ba4 kept all of that and changed the shape: ① Leave Type · ② Employee Selection · ③ Adjustment
 * Details · ④ Review & Process, with Step 2's criteria grouped into expandable sections instead of one
 * long list, and a live matched count where there used to be a static "this will match everyone" warning.
 *
 * SERVER COMPONENT. Everything interactive lives in AdjustmentForm, which is a client component receiving
 * only serialisable props — r124 broke this tab in production by passing a translator closure across that
 * boundary, and test/server-client-boundary.test.ts now catches it. The two server actions are the
 * exception the framework allows (the `countInScopeAction` precedent on the Entitlements page).
 *
 * ⚠️ THE CRITERIA FIELD NAMES BELOW ARE A CONTRACT, not labels. Each `name` must be a member of
 * `ORG_CRITERIA_FIELDS` / `ORG_CRITERIA_RANGE_FIELDS` in core/org-criteria.ts, or the control renders,
 * posts, and narrows nobody — the silent failure that is the whole reason the shared reader exists.
 * test/leave-adjustment-step-flow.test.ts pins the two lists against each other.
 */
export default async function LeaveAdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  // r127 SHIPPED THIS SCREEN WITH TWO LABEL SETS THAT DO NOT EXIST under `admin.leave`, so every
  // employment-type chip and all eight org-criteria chips rendered through a MISSING_MESSAGE. The page
  // still returned 200, which is exactly why a bare status-code check did not catch it — the same class
  // of defect as r123, found the same way, by grepping the dev log after a real render.
  //
  // Both label sets ALREADY SHIP, fully translated in all six locales, so this reads them where they live
  // rather than minting a seventh copy: the eight org axes under `admin.profileOptions.category` (which is
  // what ORG_ASSIGNMENT_CRITERIA's own header says `labelKey` indexes), and the employment types under
  // `people.wizard.employmentType`, the same vocabulary the hiring wizard writes them with.
  //
  // 18103ba4 added `admin.leave.adjustmentsCriteria` for the ~20 new axes. Its VALUES were copied from the
  // already-translated keys for the same words (people.detail.employmentInfo.*, people.employeeStatus.*,
  // analytics.filterCostCentre, …) rather than re-invented, for exactly the r127 reason.
  const tOrg = await getTranslations('admin.profileOptions.category');
  const tEmploymentType = await getTranslations('people.wizard.employmentType');
  const tCrit = await getTranslations('admin.leave.adjustmentsCriteria');
  const { error } = await searchParams;

  const companies = await listCompanies(s);
  const companyIds = companies.map((c) => c.id);
  const [types, departments, batches, profileOptions, grades, positions, costCenters, businessUnits, locations] =
    await Promise.all([
      listLeaveTypes(s, { includeArchived: false }),
      listDepartments(s),
      listLeaveAdjustmentBatches(s, { limit: 20 }),
      listAllProfileOptions(s),
      listJobGrades(s),
      listPositions(s),
      listCostCenters(s),
      listBusinessUnits(s),
      // The only list keyed by company rather than tenant. Empty scope ⇒ no locations, which is honest:
      // an administrator who can see no company can narrow by no site either.
      companyIds.length ? listLocations(s, companyIds) : Promise.resolve([]),
    ]);

  /**
   * The criteria builder — THE SHARED ONE, not a copy.
   *
   * 93249794 moved these four sections out of this file into `core/org-criteria-form.ts` verbatim, because
   * the Generate Entitlement screen asks the identical question and copying the list would have reproduced
   * the duplicate-maintenance defect one layer above the resolver: two pickers, one of which quietly stops
   * offering an axis the other has. Everything this screen offered before, it offers now, from one list.
   */
  const criteriaSections = buildOrgCriteriaSections(
    { companies, departments, grades, positions, costCenters, businessUnits, locations, profileOptions },
    { crit: tCrit, org: tOrg, employmentType: tEmploymentType },
  );

  return (
    <div className="space-y-6">
      <PageHeader title={await leaveConfigScreenTitle('adjustments')} description={t('pageDescription')} />
      {/* a6fe37fc — the area map. ADDITIVE: everything below it is unchanged. */}
      <LeaveConfigMap current="adjustments" />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('adjustmentsTitle')} />
        <div className="space-y-2 px-4 pt-3">
          <p className="text-xs text-muted-foreground">{t('adjustmentsHelp')}</p>
        </div>
        <div className="px-4 pb-4 pt-2">
          {/* The flow's own chrome (step names, buttons, warnings) is read INSIDE AdjustmentForm with
              useTranslations — a client component may translate, it just may not be handed a translator
              (r124). What it cannot read for itself is the criteria vocabulary, whose labels are paired
              with catalogue rows only this server component can query, so those arrive as plain data. */}
          <AdjustmentForm
            action={applyLeaveAdjustmentAction}
            previewAction={previewLeaveAdjustmentAction}
            today={todayInKualaLumpur()}
            leaveTypes={types.map((x) => ({ value: x.id, label: x.name }))}
            criteriaSections={criteriaSections}
          />
        </div>
      </Card>

      {/* The plan's explicit requirement: "a grant applied to many employees at once needs a way to see
          what it did afterwards ... so a mistake can be found and reversed as a unit rather than employee
          by employee." TARGETED and WRITTEN are shown separately because they differ whenever a frozen
          encashment snapshot was skipped, and a silent difference is what makes a bulk write untrustworthy. */}
      <Card>
        <SectionHeader title={t('adjustmentsRecentTitle')} count={batches.length} />
        <ul className="divide-y divide-border">
          {batches.length === 0 && (
            <li className="px-4 py-4 text-center text-xs text-muted-foreground">{t('adjustmentsRecentNone')}</li>
          )}
          {batches.map((batch) => (
            <li key={batch.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">{batch.reason}</span>
                <span className="text-xs text-muted-foreground">
                  {t('adjustmentsRecentLine', {
                    days: batch.days,
                    written: batch.writtenCount,
                    targeted: batch.targetedCount,
                    date: batch.effectiveOn,
                  })}
                </span>
              </div>
              {batch.reversedAt ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('adjustmentsReversed')}
                </span>
              ) : (
                <form action={reverseLeaveAdjustmentAction}>
                  <input type="hidden" name="batchId" value={batch.id} />
                  {/* Reversal is irreversible in the sense that matters: it writes compensating rows and
                      marks the batch, and a second attempt is refused. So it asks first. */}
                  <ConfirmSubmit
                    variant="outline"
                    title={t('adjustmentsReverse')}
                    description={t('adjustmentsReverseConfirm')}
                  >
                    {t('adjustmentsReverse')}
                  </ConfirmSubmit>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
