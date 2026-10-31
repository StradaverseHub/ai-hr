import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isOnehrOnlyPerformanceAdmin, requireOnehrAdminAccess } from '@/lib/authz';
import { getOnehrCycle, isOnehrAdminCycle } from '@/packs/performance/service';
import { Card, ErrorBanner } from '@/components/ui';
import { adminPageHref, adminPartShown, resolveAdminTab } from '@/packs/performance/onehr/admin-sections';
import { overviewModuleOn } from '@/packs/performance/onehr/overview-model';
import { adminCardRenderer } from '../../../onehr/admin-cards';
import { PerformanceAdminShell } from '../../../onehr/admin-shell';
import { ModuleOverview } from '../../../onehr/module-overview';
import { AdminAllCycles } from '../../../onehr/admin-cycles';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Query = { sub?: string; error?: string; page?: string; size?: string; progressGroup?: string; progressCompany?: string };
const one = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * D-P1-32 PT-X4 — one page of the performance admin area: /performance/<cycle>/<section>/<tab>[?sub=<page>].
 * The registry (packs/performance/onehr/admin-sections.ts) decides what exists; any other section, tab or page is
 * a 404, as is a page that stands for an existing route (it lives at that route, D8) and a cycle that is not
 * OneHR-native. Guarded like /performance/[cycleId]: requireOnehrAdminAccess, the partner only on OneHR-native
 * cycles it administers (ADR-0142), and every service re-checks app.onehr_cycle_admin.
 */
export default async function PerformanceAdminPage({ params, searchParams }: { params: Promise<{ cycleId: string; section: string; tab: string }>; searchParams: Promise<Query> }) {
  const s = await requireOnehrAdminAccess();
  const { cycleId, section, tab } = await params, q = await searchParams;
  const at = resolveAdminTab(section, tab, one(q.sub));
  if (!at || at.page.route || !UUID.test(cycleId)) notFound();
  if (isOnehrOnlyPerformanceAdmin(s) && !await isOnehrAdminCycle(s, cycleId)) notFound();
  const v = await getOnehrCycle(s, cycleId);
  if (!v) notFound();
  const here = adminPageHref(cycleId, at.section.key, at.tab.key, at.page.key), moduleKey = at.section.module;
  const [render, t] = await Promise.all([
    adminCardRenderer(v, { progress: { progressGroup: one(q.progressGroup), progressCompany: one(q.progressCompany) }, returnTo: here }),
    getTranslations('performanceAdmin'),
  ]);
  const shown = at.page.parts.filter((part) => adminPartShown(part, render.state));
  const { extra } = at.page;
  return (
    <PerformanceAdminShell cycleId={cycleId} cycleName={v.cycle.name} section={at.section.key} tab={at.tab.key} page={at.page.key} state={moduleKey ? { on: overviewModuleOn(v.policy, moduleKey), cycle: v.cycle.name } : undefined}>
      <div className="max-w-5xl space-y-6">
        <ErrorBanner message={one(q.error)} />
        {extra === 'overview' && moduleKey && <ModuleOverview cycleId={cycleId} section={at.section.key} module={moduleKey} policy={v.policy} cycleName={v.cycle.name} />}
        {extra === 'allCycles' && <AdminAllCycles basePath={here} query={{ page: one(q.page), size: one(q.size) }} />}
        {extra === 'policyPointer' && (
          <Card className="p-5">
            <p className="text-sm text-muted-foreground">{t('policyPointer')} <Link href={`${adminPageHref(cycleId, 'cycle', 'calendar')}#policy`} className="text-primary hover:underline">{t('sections.cycle')} › {t('tabs.calendar')} →</Link></p>
          </Card>
        )}
        {shown.map((part) => render.part(part))}
        {!extra && !shown.length && <Card className="p-5"><p className="text-sm text-muted-foreground">{t('empty')}</p></Card>}
      </div>
    </PerformanceAdminShell>
  );
}
