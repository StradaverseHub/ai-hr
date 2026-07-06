import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { setLeaveHalfDayFullDeductionAction } from '../../actions';

/**
 * Leave Settings — Application Rules tab (0d147b78 — Leave Settings Reorganization).
 *
 * How leave is APPLIED, at company level. Per-type application rules the ticket names
 * (supporting-document requirements, backdated-leave limits) stay on the Leave Types tab inside
 * `LeaveTypePanel`, because they are configured per leave type and rely on that panel's tri-state
 * markers (`document=1`, `backdating=1`) — moving them would risk silently wiping a column on save.
 * The per-company half-day-deduction toggle re-homes here. No action/service change; `requireAdmin()`
 * guard preserved verbatim.
 */
export default async function LeaveApplicationRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const companies = await listCompanies(s);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="application-rules" />
      <ErrorBanner message={error} />

      {/* Feedback request 31474452: per-company half-day leave-deduction toggle. */}
      <Card>
        <SectionHeader title={t('halfDayDeductionTitle')} count={companies.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('halfDayDeductionHelp')}</p>
        <p className="px-4 pb-1 text-xs text-muted-foreground">{t('halfDayDeductionFrozenNote')}</p>
        <ul className="divide-y divide-border">
          {companies.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <form
                action={setLeaveHalfDayFullDeductionAction}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <input type="hidden" name="companyId" value={c.id} />
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {c.leaveHalfDayFullDeduction ? t('halfDayDeductionOn') : t('halfDayDeductionOff')}
                  </span>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={!!c.leaveHalfDayFullDeduction}
                    className="size-4 rounded"
                  />
                  {t('halfDayDeductionToggleLabel')}
                </label>
                <Button type="submit" variant="outline" size="sm">
                  {t('save')}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
