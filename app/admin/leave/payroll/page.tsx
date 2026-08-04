import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies, listLeaveTypes } from '@/core/read';
import { getEncashmentPolicies } from '@/core/leave-encashment';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { setLeaveEncashmentPolicyAction, updateLeaveTypeAction } from '../../actions';

/**
 * Leave Settings — Payroll Related tab (0d147b78 — Leave Settings Reorganization).
 *
 * Leave configuration that feeds payroll: the company-level leave-encashment policy AND (feedback 9d8cf621)
 * the per-leave-type "Payroll impact" controls, relocated here from the Leave Types tab. Each per-type row is
 * a self-contained `<form action={updateLeaveTypeAction}>` carrying exactly hidden id + hidden name (current
 * name, always written) + the `payrollImpact=1` tri-state marker + the editable "Send to payroll module"
 * checkbox; the derived "Affects payroll deduction" checkbox is disabled/informational and never posted.
 * Because the form is self-contained and carries its marker + hidden name, relocating it is safe — no other
 * column is touched on save. `requireAdmin()` guard preserved verbatim.
 */
export default async function LeavePayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const { error } = await searchParams;
  const [companies, encashmentPolicies, leaveTypes] = await Promise.all([
    listCompanies(s),
    getEncashmentPolicies(s),
    listLeaveTypes(s, { includeArchived: true }),
  ]);
  const encashmentByCompany = new Map(encashmentPolicies.map((p) => [p.companyId, p]));

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={error} />

      {/* Feedback 9d8cf621 — per-leave-type Payroll impact, relocated from the Leave Types tab. */}
      <Card>
        <SectionHeader title={t('payrollPerTypeTitle')} count={leaveTypes.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('payrollImpactHelp')}</p>
        <ul className="divide-y divide-border">
          {leaveTypes.length === 0 && (
            <li className="px-4 py-4 text-center text-xs text-muted-foreground">{t('noLeaveTypes')}</li>
          )}
          {leaveTypes.map((lt) => (
            <li key={lt.id} className={`px-4 py-3 ${lt.archivedAt ? 'opacity-60' : ''}`}>
              <form action={updateLeaveTypeAction} className="flex flex-wrap items-center gap-4">
                {/* self-contained: id + current name (always written) + tri-state marker */}
                <input type="hidden" name="id" value={lt.id} />
                <input type="hidden" name="name" value={lt.name} />
                <input type="hidden" name="payrollImpact" value="1" />
                <span className="min-w-[10rem] flex-1 truncate text-sm font-medium text-foreground">
                  {lt.name}
                  <span className="ml-1.5 text-xs text-muted-foreground">{lt.code}</span>
                </span>
                {/* derived, informational, NOT posted — reflects whether the type is paid */}
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={!lt.paid} disabled className="size-3.5 rounded border-border" />
                  {t('affectsPayrollDeductionLabel')}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-foreground">
                  <input
                    type="checkbox"
                    name="sendToPayroll"
                    defaultChecked={lt.sendToPayroll}
                    className="size-3.5 rounded border-border"
                  />
                  {t('sendToPayrollLabel')}
                </label>
                <Button type="submit" size="sm" variant="secondary">
                  {t('save')}
                </Button>
              </form>
            </li>
          ))}
        </ul>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t('affectsPayrollDeductionHelp')}
        </p>
      </Card>

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
