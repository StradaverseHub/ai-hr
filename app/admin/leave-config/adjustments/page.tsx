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
import Link from 'next/link';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { LEAVE_CONFIG_RECORDS_HREF, LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import {
  applyLeaveAdjustmentAction,
  previewLeaveAdjustmentAction,
  reverseLeaveAdjustmentAction,
} from '../../leave/adjustments/actions';

/**
 * a6fe37fc — ADJUSTMENTS (`/admin/leave-config/adjustments`).
 *
 * ⚠️ ROUND 5 (cutover) HAS HAPPENED: this IS the screen. `/admin/leave/adjustments` is an unguarded
 * redirect stub pointing here, it has left lib/permissions.ts's leaveConfig `routes`, and both menus name
 * this address — the sidebar fly-out row and the area map's `adjustments` entry. The stub is never
 * deleted; the reporter's bookmarks are why it exists.
 *
 * ⚠️ THE FOUR-STEP FLOW IS NOT RE-IMPLEMENTED (IA §2.3). `AdjustmentForm` is the SAME client component
 * the old page mounts (① Leave Type · ② Employee Selection · ③ Adjustment Details · ④ Review & Process),
 * driven by the SAME three server actions. The criteria sections come from the SHARED
 * `buildOrgCriteriaSections`, which 93249794 extracted precisely so that this screen and Generate
 * Entitlement cannot start offering different axes.
 *
 * BOTH OF THIS SCREEN'S FUNCTIONS ARE ON IA §3.2's TABLE and both are here — F42, the flow; F43, the
 * recent batches and reversing one as a unit. (The old page was re-read against the table rather than
 * trusted to it: r258 found §3.1 two functions short, and §3.2's Generate and Entitlement-tables rows
 * turned out to be short too — see F49/F50 on those two pages. This screen's two rows are complete.)
 *
 * ⚠️ THE CRITERIA FIELD NAMES ARE A CONTRACT, not labels. Each `name` must be a member of the two field
 * lists core/org-criteria.ts exports, or the control renders, posts and narrows nobody. Nothing on this
 * page re-declares either list — that is the whole reason the shared builder is mounted rather than
 * copied, and test/leave-config-round3.test.ts asserts the absence by name. (The identifiers themselves
 * are deliberately not spelled out here: a source-scanning guard does not strip comments, and prose
 * explaining a rule that trips the guard enforcing it is a guard people delete — rule 27.)
 *
 * A SAVE MADE HERE LANDS HERE. The three actions redirect to the `ADJUSTMENTS` module constant
 * (app/admin/_redirects.ts), repointed at this address in the same commit that emptied the old page, so
 * the toast carrying the two counts arrives on the screen the operator processed the batch on.
 *
 * SERVER COMPONENT. Everything interactive lives in `AdjustmentForm`, which receives only serialisable
 * props — r124 broke this tab in production by passing a translator closure across that boundary, and
 * test/server-client-boundary.test.ts now catches it.
 */
export default async function LeaveConfigAdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const tRecords = await getTranslations('admin.leaveConfigRecords');
  // r127's lesson, applied verbatim: all three label sets ALREADY SHIP in six locales, so they are read
  // where they live — the eight org axes under `admin.profileOptions.category`, the employment types
  // under `people.wizard.employmentType`, the ~20 axis names under `admin.leave.adjustmentsCriteria`.
  // Minting a copy is how a screen renders entirely through MISSING_MESSAGE behind a green 200.
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

  const criteriaSections = buildOrgCriteriaSections(
    { companies, departments, grades, positions, costCenters, businessUnits, locations, profileOptions },
    { crit: tCrit, org: tOrg, employmentType: tEmploymentType },
  );

  // 10b59703 — the heading is the submenu ROW ("Leave Adjustments") and the description is this row's
  // own; it used to borrow admin.leave.pageDescription, the Leave types sentence.
  const header = await leaveConfigPageHeader('adjustments');

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      {/* 10b59703 — this row's tab row: Adjust balances · Import leave data (7f69bd71 took the Balance
          record off it). `current="adjustments"` because this IS that tab. */}
      <LeaveConfigMap current="adjustments" />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('adjustmentsTitle')} />
        <div className="space-y-2 px-4 pt-3">
          <p className="text-xs text-muted-foreground">{t('adjustmentsHelp')}</p>
        </div>
        <div className="px-4 pb-4 pt-2">
          {/* F42 — the flow, MOUNTED. Its own chrome (step names, buttons, warnings) is read INSIDE
              AdjustmentForm with useTranslations; what it cannot read for itself is the criteria
              vocabulary, whose labels are paired with catalogue rows only a server component can query,
              so those arrive as plain data. */}
          <AdjustmentForm
            action={applyLeaveAdjustmentAction}
            previewAction={previewLeaveAdjustmentAction}
            today={todayInKualaLumpur()}
            leaveTypes={types.map((x) => ({ value: x.id, label: x.name }))}
            criteriaSections={criteriaSections}
          />
        </div>
      </Card>

      {/* F43 — "a grant applied to many employees at once needs a way to see what it did afterwards … so a
          mistake can be found and reversed as a unit rather than employee by employee." TARGETED and
          WRITTEN are shown separately because they differ whenever a frozen encashment snapshot was
          skipped, and a silent difference is what makes a bulk write untrustworthy. */}
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

      {/* 7f69bd71 — THE ONLY WAY TO THE RESET RECORDS SUB-SCREEN. One small link, below the recent
          adjustments, to the page that holds the Configuration record and the Balance record as
          sub-tabs. Both are records of REMOVALS — rows a reset took out — which is the adjustments
          domain, so the link lives here and only here (not on Import, not on Entitlements). The
          Leave Adjustments row stays lit on the sub-screen (ownedSubpaths, packs/leave/index.ts). */}
      <p className="text-xs text-muted-foreground">
        <Link href={LEAVE_CONFIG_RECORDS_HREF} className="underline hover:text-foreground">
          {tRecords('footLink')}
        </Link>
      </p>
    </div>
  );
}
