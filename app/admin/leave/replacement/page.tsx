import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';

/**
 * Leave Settings — Replacement Leave tab (feedback 645e67c4).
 *
 * A PLACEHOLDER, DELIBERATELY. The item's description asks for a full central replacement-leave module
 * that manages entitlement generation; its expected_behavior says plainly that "no functional components,
 * forms, or business logic are required at this stage" and that the page "may display a simple
 * placeholder". expected_behavior is the narrower and more explicit statement, so it wins — this file
 * models no data and calls no service. Do not "finish" it without a ticket that says what it should do.
 *
 * IT IS NOT THE HOME OF REPLACEMENT LEAVE TODAY, and the copy says so rather than implying an empty
 * feature. Replacement leave already works: `toil_accrual` (db/schema.ts:3267) is the source of truth for
 * the no-double-pay rule and expiry, the REPLACEMENT leave type is live on the employee surfaces
 * (app/leave/page.tsx, components/planned-absences-grid.tsx, components/leave-type-panel.tsx), and the
 * TOIL policy screen is registered separately as `toilPolicy` (lib/permissions.ts). A page that looked
 * merely unbuilt would read as "replacement leave does not exist yet", which is false and would send an
 * admin looking for a feature they already have.
 *
 * GUARDED, THOUGH IT HOLDS NOTHING. `requireAdmin()` is what registers the route with
 * test/function-access.test.ts (its GUARD_RE scan) and what keeps a non-HR role out. An empty page is not
 * a reason to skip the guard — the guard is what makes adding content later safe by default.
 */
export default async function LeaveReplacementPage() {
  await requireAdmin();
  const t = await getTranslations('admin.leave');

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="replacement" />

      <Card>
        <SectionHeader title={t('replacementModuleTitle')} />
        <div className="space-y-2 px-4 py-4">
          <p className="text-sm text-muted-foreground">{t('replacementModuleUnderDevelopment')}</p>
          <p className="text-xs text-muted-foreground">{t('replacementModuleExistingNote')}</p>
        </div>
      </Card>
    </div>
  );
}
