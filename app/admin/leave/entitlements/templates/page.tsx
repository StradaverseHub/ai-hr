import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireAdmin } from '@/lib/authz';
import { Card, ErrorBanner, PageHeader } from '@/components/ui';
import { EntitlementTablesBlock, loadEntitlementTablesData } from './entitlement-tables-block';
// r212 (8ebf77ae) — the reporter's original ticket: "No eligibility rule reaches you", answered for a
// named employee. Mounted HERE and not in the block, because the block is composed once per leave type on
// the Entitlements page and an employee search is not a per-leave-type control.
import { EligibilityExplainPanel } from './eligibility-explain';
import { LeaveConfigMap } from '@/components/leave-config-map';

/**
 * 6e9a126e RELEASE TWO — ENTITLEMENT TABLES + EMPLOYEE ELIGIBILITY. The reporter's two steps, one screen.
 *
 *     Leave Type  →  Entitlement Template  →  Employee Eligibility
 *
 * Step 1: a named day table with the operator's OWN service ranges, replacing the hardcoded <2y / 2-5y /
 * 5y+ bands and the 292 private copies of the same table inside 41 Benefit Schemes.
 * Step 2: who gets which table, through the SHARED criteria vocabulary (`core/org-criteria.ts`) that the
 * Notice Board and Leave Adjustments already narrow by — not a third matcher.
 *
 * ⚠️ NOTHING OLD IS REMOVED, AND THIS SCREEN DOES NOT PRETEND OTHERWISE. Benefit Schemes and the company /
 * grade entitlement rules are still live and still resolve; a template SUPERSEDES them for the employees a
 * rule matches, and everyone else is unaffected. The clearing is release three and the reporter's own
 * decision. The `intro` copy says exactly that rather than implying a migration has happened.
 *
 * ⚠️ ee6b7c69 — THE TWO CARDS THAT WERE THIS FILE NOW LIVE IN `entitlement-tables-block.tsx`, and this page
 * is one unfiltered mount of them. The other mount is the Entitlement step of each leave type on
 * /admin/leave/entitlements, filtered to that type — which is where day-to-day configuration happens now.
 * This screen survives on purpose: it is the only place every leave type's tables can be read side by side,
 * and the Entitlements page header still links to it. Extracting rather than copying is the whole point —
 * two create forms writing the same effective-dated lineage would drift the first time either was touched,
 * and both would still save.
 *
 * SERVER COMPONENT, and so is r212's explain panel below it — its search, its pickers and its links are a
 * plain GET form, so nothing new crosses a boundary. The only client components on this screen remain the
 * two inside the block, which receive only serialisable props: r123 took a production tab down by handing a
 * translator closure across that boundary and `test/server-client-boundary.test.ts` pins the class.
 */
export default async function EntitlementTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    editTemplate?: string;
    editRule?: string;
    // r212 — the explain panel's four GET parameters, so an answer is addressable and can be sent as a link.
    explainQ?: string;
    explainEmployment?: string;
    explainLeaveType?: string;
    explainAsOf?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.entitlementTemplates');
  const sp = await searchParams;
  const data = await loadEntitlementTablesData(s);

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      {/* a6fe37fc — the area map. ADDITIVE: everything below it is unchanged. */}
      <LeaveConfigMap current="entitlementTables" />
      <ErrorBanner message={sp.error} />

      <Card>
        <div className="space-y-2 p-4 text-sm">
          <p className="text-muted-foreground">{t('intro')}</p>
          <p className="text-muted-foreground">{t('coexistNote')}</p>
          <p className="text-muted-foreground">{t('datedNote')}</p>
          <Link href="/admin/leave/entitlements" className="inline-block text-sm underline">
            {t('backToEntitlements')}
          </Link>
        </div>
      </Card>

      {/* Unfiltered: every leave type side by side. No `leaveTypeId`, so the Leave type column stays and the
          create form keeps its type picker. */}
      <EntitlementTablesBlock data={data} editTemplate={sp.editTemplate} editRule={sp.editRule} />

      {/* r212 — and the question the tables above cannot answer for one person: which of these rules exist,
          which are in force, and what about THIS employee does not match. Below the rules it explains,
          because it is read after them. */}
      <EligibilityExplainPanel s={s} data={data} params={sp} />
    </div>
  );
}
