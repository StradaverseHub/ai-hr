import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { getEncashmentPolicies } from '@/core/leave-encashment';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { LeaveTabs } from '@/components/leave-tabs';
import { setLeaveEncashmentPolicyAction } from '../../actions';

/**
 * Leave Settings — Payroll Related tab (0d147b78 — Leave Settings Reorganization).
 *
 * Leave configuration that feeds payroll, at company level: the leave-encashment policy. The per-type
 * "Payroll impact" / "Send to payroll module" controls the ticket names stay on the Leave Types tab
 * inside `LeaveTypePanel` (tri-state marker `payrollImpact=1`) — they are per-leave-type, and moving
 * them would risk wiping the send-to-payroll column on save. No action/service change; `requireAdmin()`
 * guard preserved verbatim.
 */
export default async function LeavePayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [companies, encashmentPolicies] = await Promise.all([
    listCompanies(s),
    getEncashmentPolicies(s),
  ]);
  const encashmentByCompany = new Map(encashmentPolicies.map((p) => [p.companyId, p]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <LeaveTabs active="payroll" />
      <ErrorBanner message={error} />

      {/* ADR-0069: Leave Encashment Policy — one row per company. Eligible leave (Annual only) and the
          rounding rule are fixed text (per the request), not editable controls. */}
      <Card data-tour="leave-encashment">
        <SectionHeader title={t('encashmentSectionTitle')} count={companies.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('encashmentHelp')}</p>
        <ul className="divide-y divide-border">
          {companies.map((c) => {
            const pol = encashmentByCompany.get(c.id);
            return (
              <li key={c.id} className="px-4 py-3">
                <form action={setLeaveEncashmentPolicyAction} className="flex flex-wrap items-center gap-4">
                  <input type="hidden" name="companyId" value={c.id} />
                  <span className="min-w-[10rem] flex-1 truncate text-sm font-medium text-foreground">
                    {c.name}
                  </span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" name="enabled" defaultChecked={pol?.enabled ?? false} className="size-3.5" />
                    {t('encashmentEnabled')}
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" name="autoFreeze" defaultChecked={pol?.autoFreeze ?? true} className="size-3.5" />
                    {t('encashmentAutoFreeze')}
                  </label>
                  <Button type="submit" size="sm" variant="secondary">
                    {t('encashmentSave')}
                  </Button>
                </form>
              </li>
            );
          })}
        </ul>
        <div className="grid gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <p>{t('encashmentEligibleTypesFixed')}</p>
          <p>{t('encashmentRoundingFixed')}</p>
        </div>
      </Card>
    </div>
  );
}
