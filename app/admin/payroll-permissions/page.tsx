import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listPayrollPermissionGrants } from '@/core/payroll-permissions-admin';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { PAYROLL_PERMISSION_DEFAULTS, PAYROLL_PERMISSION_KEYS } from '@/lib/payroll-permissions';
import { setPayrollPermissionAction, deletePayrollPermissionAction } from './actions';

const ROLES = ['employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner'] as const;

/**
 * Granular payroll permissions admin (feedback 9bc442bc, reporter expected_function: "configurable per
 * company/tenant"). Shows the four permission keys' code defaults and lets an admin add per-company or
 * tenant-wide overrides that the kernel resolver honours (company override > tenant override > default).
 */
export default async function PayrollPermissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.payrollPermissions');
  const { error } = await searchParams;
  const [grants, companies] = await Promise.all([
    listPayrollPermissionGrants(s),
    listCompanies(s).then((rows) => rows.filter((c) => !c.archivedAt)),
  ]);
  const companyName = (id: string | null) => (id ? companies.find((c) => c.id === id)?.name ?? id : t('tenantWide'));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('defaultsTitle')} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colKey')}</th>
                <th className="px-4 py-2 font-medium">{t('colDefaultRoles')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {PAYROLL_PERMISSION_KEYS.map((k) => (
                <tr key={k}>
                  <td className="px-4 py-2.5 font-mono text-xs">{k}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{PAYROLL_PERMISSION_DEFAULTS[k].join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs text-muted-foreground">{t('defaultsHint')}</p>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('overridesTitle')} count={grants.length} />
        {grants.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('overridesEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colScope')}</th>
                  <th className="px-4 py-2 font-medium">{t('colKey')}</th>
                  <th className="px-4 py-2 font-medium">{t('colRole')}</th>
                  <th className="px-4 py-2 font-medium">{t('colAllowed')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grants.map((g) => (
                  <tr key={g.id}>
                    <td className="px-4 py-2.5">{companyName(g.companyId)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{g.permissionKey}</td>
                    <td className="px-4 py-2.5">{g.role}</td>
                    <td className="px-4 py-2.5">{g.allowed ? t('allow') : t('deny')}</td>
                    <td className="px-4 py-2.5 text-right">
                      <form action={deletePayrollPermissionAction}>
                        <input type="hidden" name="id" value={g.id} />
                        <Button type="submit" size="sm" variant="secondary">
                          {t('remove')}
                        </Button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader title={t('addTitle')} />
        <form action={setPayrollPermissionAction} className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">{t('colScope')}</span>
            <select name="companyId" className={inputCls} defaultValue="">
              <option value="">{t('tenantWide')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">{t('colKey')}</span>
            <select name="permissionKey" className={inputCls} defaultValue={PAYROLL_PERMISSION_KEYS[0]}>
              {PAYROLL_PERMISSION_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">{t('colRole')}</span>
            <select name="role" className={inputCls} defaultValue="hr_admin">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-foreground">{t('colAllowed')}</span>
            <select name="allowed" className={inputCls} defaultValue="true">
              <option value="true">{t('allow')}</option>
              <option value="false">{t('deny')}</option>
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit">{t('addButton')}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
