import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { HalfDayCompanyPicker } from '@/components/leave/half-day-company-picker';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { setLeaveHalfDayFullDeductionCompaniesAction } from '../../actions';

/**
 * r281 (a73d1e14) — SPECIAL SETTING (`/admin/leave-config/special-setting`), holding Half Day Deduction.
 *
 * ⚠️ THE ROW IS THE CATEGORY, THE PAGE IS THE SETTING, AND THE RAIL IS WHY. The reporter's sketch has
 * three levels: Leave Config, then Special Setting, then Half Day Deduction underneath it. A nav child
 * (`NavChildDescriptor`, packs/registry.ts) carries href/labelKey/icon and no `children`, so a row cannot
 * hold a row. Rather than refuse the shape, Special Setting is the ROW and Half Day Deduction is the page
 * it opens — same destination, same grouping, one click instead of two. A SECOND special setting later
 * becomes a second item in the map group and the tab strip appears by itself, with the row's name
 * unchanged. The plan says this to the reporter in those words and offers reject-and-say-so.
 *
 * ⚠️ NOTHING ABOUT HALF DAY DEDUCTION CHANGED — not the control, not the validation, not the stored
 * value, not who may set it. The card is the SAME `HalfDayCompanyPicker` inside the SAME form posting the
 * SAME `setLeaveHalfDayFullDeductionCompaniesAction`, against the same `company.leave_half_day_full_
 * deduction` column. No migration, no service change, no permission change: this screen and the one it
 * came from both sit on the `leaveConfig` key behind `requireAdmin`.
 *
 * ⚠️ THE PICKER IS SCOPED TO `adminOnly`, WHICH IS NARROWER THAN THE PAGE'S COMPANY LIST, and this is the
 * one thing a re-home can silently get wrong. The company UPDATE policy is admin-for-company
 * (`app.is_admin_for`, migration 0016's WITH CHECK), so a company-scoped hr_admin can SEE companies it
 * cannot write. Offering exactly the companies the write can reach keeps the screen and the database in
 * agreement, and `core.setLeaveHalfDayFullDeductionCompanies` resolves the same set server-side so a
 * hand-crafted post cannot widen it either. This is the old card's scope, character for character — a
 * different one here would be a different control.
 *
 * ⚠️ AN EMPTY SELECTION IS A MEANINGFUL ANSWER, not a missing one. The post states the WHOLE set
 * (`getAll('companyIds')`) and the action turns off every company not posted, so "applies nowhere" is a
 * choice an administrator can make. That is why there is no master switch and no guard rejecting empty.
 * `selected` is the CURRENT state, so the first render reproduces today's configuration exactly.
 *
 * A SAVE MADE HERE LANDS HERE: the action returns through the `SPECIAL_SETTING` module constant
 * (app/admin/_redirects.ts), repointed in the same commit that took the card off its old screen — so a
 * save, and any `?error=`, arrive on the screen the change was made on.
 *
 * SERVER COMPONENT. The picker is the client island and receives ONLY serialisable props — an option
 * array and a list of ids. No `t` and no closure crosses the boundary: r123 took the Entitlements tab
 * down in production doing exactly that with THIS picker, which is why the wrapper component exists at
 * all, and test/server-client-boundary.test.ts pins the class.
 */
export default async function LeaveConfigSpecialSettingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const header = await leaveConfigPageHeader('specialSetting');
  const { error } = await searchParams;

  const halfDayCompanies = await listCompanies(s, { adminOnly: true });
  const halfDayEnabledCompanyIds = halfDayCompanies.filter((c) => c.leaveHalfDayFullDeduction).map((c) => c.id);

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      {/* One page under this row today, so the tab row renders nothing; the mount stays so the strip
          appears by itself on the day a second special setting joins the group.
          `current="specialSetting"` because this IS that screen. */}
      <LeaveConfigMap current="specialSetting" />
      <ErrorBanner message={error} />

      {/* ── F4 / F26 · Half-day full deduction ─────────────────────────────────────────────────────────
          Company-wide, and drawn ONCE. Before Company rules absorbed it, this same card was composed on
          the Leave types page and handed into every leave type's Condition step — which is why the badge
          below says "applies to every leave type": it is one company decision wearing twenty-five
          costumes. Nothing about that is changed by giving it a heading of its own. */}
      <Card>
        <SectionHeader title={t('halfDayDeductionTitle')} />
        <div className="space-y-2 px-4 py-3">
          <span className="inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('conditionStep.halfDayCompanyWideBadge')}
          </span>
          <p className="text-xs text-muted-foreground">{t('halfDayDeductionHelp')}</p>
          <p className="text-xs text-muted-foreground">{t('halfDayDeductionFrozenNote')}</p>
          <form action={setLeaveHalfDayFullDeductionCompaniesAction} className="space-y-2">
            {/* `selected` is the CURRENT state, so first render reproduces today's configuration exactly
                and saving an unrelated form cannot silently rewrite it. The post states the WHOLE set
                (`getAll('companyIds')`), and an empty selection is a meaningful answer — "applies
                nowhere" — which is why there is no master switch and no guard rejecting it. */}
            <HalfDayCompanyPicker
              companies={halfDayCompanies.map((c) => ({ value: c.id, label: c.name }))}
              selected={halfDayEnabledCompanyIds}
            />
            <p className="text-xs text-muted-foreground">{t('halfDayDeductionEmptyNote')}</p>
            <Button type="submit" variant="outline" size="sm">
              {t('save')}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
