import { getTranslations } from 'next-intl/server';

import { requireAdmin, requireModule } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { LeaveCreditRulesTab } from '../rules-tab';

/** Not exported: Next refuses unknown exports from a page module. */
const PAGE = '/admin/leave-config/leave-credit/rules';

/**
 * 3fb1a611 (r299) — LEAVE CONFIG › LEAVE CREDIT › RULES (`/admin/leave-config/leave-credit/rules`).
 *
 * The second tab of the Leave Credit row: the replacement-leave (TOIL) policy — who can earn a credit, how
 * it is earned and how long it lasts — MOVED off Company rules entirely. The form is `../rules-tab.tsx`; this
 * page guards, gates and carries the three save banners `setToilPolicyAction` returns with (`?saved=`,
 * `?warning=` — the premium-equivalent banking-risk warning — and `?error=`), which moved with the form so a
 * save lands on the screen it was made on.
 *
 * GATED ON `toil`. Without the module the tab shows only the notice: no configuration for an add-on the tenant
 * has not bought (8a494721's lesson — a caption above a live form is not a gate), and setToilPolicy refuses in
 * the service regardless. The eligibility entered in August stays stored and appears here once the module is
 * on. (The settlement sweeps are NOT on this tab and are not gated like this — see the Credits tab.)
 */
export default async function LeaveConfigLeaveCreditRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; warning?: string; company?: string }>;
}) {
  const s = await requireAdmin();
  // The slice-4 courtesy redirect every module entry page carries. The in-page gate below still decides what
  // renders when the entitlement snapshot could not be resolved (requireModule lets that case through).
  await requireModule('toil');
  const t = await getTranslations('admin.leaveCredit');
  const tr = await getTranslations('admin.replacementLeave');
  const header = await leaveConfigPageHeader('leaveCreditRules');
  const { error, saved, warning, company } = await searchParams;

  const moduleOn = isModuleEnabledOrFalse(s, 'toil');
  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id)).map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="space-y-6">
      <PageHeader title={header.title} description={header.description} />
      <LeaveConfigMap current="leaveCreditRules" />

      <ErrorBanner message={error} />
      {saved !== undefined && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {tr('savedBanner')}
        </div>
      )}
      {warning && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {warning}
        </div>
      )}

      {moduleOn ? (
        <LeaveCreditRulesTab s={s} visible={visible} company={company} pageHref={PAGE} />
      ) : (
        <Card className="p-4" data-testid="leave-credit-module-off">
          <h2 className="text-sm font-semibold text-foreground">{t('moduleOffTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('moduleOffBody')}</p>
        </Card>
      )}
    </div>
  );
}
