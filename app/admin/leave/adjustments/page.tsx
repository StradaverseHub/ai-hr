import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listLeaveTypes, listCompanies, listDepartments } from '@/core/read';
import { listLeaveAdjustmentBatches } from '@/core/leave-adjustment';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { listAllProfileOptions } from '@/core/profile-options';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { AdjustmentForm } from '@/components/leave/adjustment-form';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { applyLeaveAdjustmentAction, reverseLeaveAdjustmentAction } from './actions';

/**
 * Leave Settings — Leave Adjustments (491c499f).
 *
 * THE ITEM'S POINT, IN ONE LINE: an adjustment is a TRANSACTION, not configuration. It was living inside a
 * leave type's Entitlement step, which meant an operational task sat in a settings screen and a grant
 * spanning several types had to be repeated per type. This is its own place, and it takes many types at
 * once.
 *
 * ⚠️ IT MUST EXIST BEFORE 38f1fd40 REMOVES THE OLD STEP. Both plans say so in the same order: removing the
 * old card first leaves a window with no way to make an adjustment at all (the 241817ef lesson — convert
 * first, remove second). The old festive-grant card is deliberately UNTOUCHED by this item.
 *
 * SERVER COMPONENT. Everything interactive lives in AdjustmentForm, which is a client component receiving
 * only serialisable props — r124 broke this tab in production by passing a translator closure across that
 * boundary, and test/server-client-boundary.test.ts now catches it.
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
  const tOrg = await getTranslations('admin.profileOptions.category');
  const tEmploymentType = await getTranslations('people.wizard.employmentType');
  const { error } = await searchParams;

  const [types, companies, departments, batches, profileOptions] = await Promise.all([
    listLeaveTypes(s, { includeArchived: false }),
    listCompanies(s),
    listDepartments(s),
    listLeaveAdjustmentBatches(s, { limit: 20 }),
    listAllProfileOptions(s),
  ]);

  // The eight org axes come from the same profile-option catalogue the leave-type Condition step reads, so
  // both screens offer the same vocabulary rather than two lists that drift.
  const orgOptions = ORG_ASSIGNMENT_CRITERIA.map((c) => ({
    key: c.key as string,
    labelKey: c.labelKey,
    // ProfileOptionRow carries value + label; the eligibility engine matches on the stored VALUE, so that
    // is what the criteria post — showing the label while posting the value is the whole point.
    options: (profileOptions[c.category] ?? [])
      .filter((o) => o.isActive)
      .map((o) => ({ value: o.value, label: o.label })),
  }));

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      <Card>
        <SectionHeader title={t('adjustmentsTitle')} />
        <div className="space-y-2 px-4 pt-3">
          <p className="text-xs text-muted-foreground">{t('adjustmentsHelp')}</p>
        </div>
        <div className="px-4 pb-4 pt-2">
          <AdjustmentForm
            action={applyLeaveAdjustmentAction}
            today={todayInKualaLumpur()}
            leaveTypes={types.map((x) => ({ value: x.id, label: x.name }))}
            companies={companies.map((c) => ({ value: c.id, label: c.name }))}
            departments={departments.map((d) => ({ value: d.id, label: d.name }))}
            employmentTypes={['full_time', 'part_time', 'contract', 'intern'].map((v) => ({
              value: v,
              label: tEmploymentType(v),
            }))}
            orgCriteria={orgOptions.map((o) => ({ ...o, label: tOrg(o.labelKey) }))}
            labels={{
              stepTypes: t('adjustmentsStepTypes'),
              stepWho: t('adjustmentsStepWho'),
              stepWhat: t('adjustmentsStepWhat'),
              byCriteria: t('adjustmentsByCriteria'),
              byIndividual: t('adjustmentsByIndividual'),
              days: t('adjustmentsDays'),
              daysHelp: t('adjustmentsDaysHelp'),
              effectiveOn: t('adjustmentsEffectiveOn'),
              reason: t('adjustmentsReason'),
              reasonHelp: t('adjustmentsReasonHelp'),
              employmentIds: t('adjustmentsEmploymentIds'),
              employmentIdsHelp: t('adjustmentsEmploymentIdsHelp'),
              everyoneWarning: t('adjustmentsEveryoneWarning'),
              submit: t('adjustmentsSubmit'),
            }}
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
