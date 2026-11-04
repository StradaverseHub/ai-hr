import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { agentBuildList } from '@/core/agent-build-list';
import { ASSESSMENT_WINDOWS, parseBoundedInt, parseWindow } from '@/core/process-assessment';
import { AiCentreGroupTabs } from '@/components/ai-centre/centre-tabs';
import { Card, PageHeader, btnGhost, inputCls, pageWideCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { RankedBuildList } from './build-list';

/** AI Centre restructure (owner decision 29, 4 November 2026) — Administration › Build list: the ranked list of agent
 * capabilities to build next, from the former Opportunities page, with its complete export (./export/route.ts).
 *
 * Group administrators only. requireAdmin opens the page (the AI management pages' guard, listed in lib/permissions.ts);
 * a company HR administrator holds no tenant-wide authority, so they are sent to Workers before anything is read, as the
 * Provider page sends them to Setup; and the read owner (core/agent-build-list.ts) refuses anyone else again. Nothing here
 * calls a model or changes anything: no capability can execute from this view. */
export default async function BuildListPage({ searchParams }: { searchParams: Promise<{ days?: string; backlogPage?: string }> }) {
  const session = await requireAdmin();
  if (!isGroupAdmin(session)) redirect('/control-tower/agents/features');
  const sp = await searchParams;
  const window = parseWindow(sp.days);
  const [tc, t, view] = await Promise.all([getTranslations('aiCentre'), getTranslations('processAssessment'), agentBuildList(session, window)]);
  return (
    <div className={pageWideCls}>
      <AiCentreGroupTabs group="administration" active="buildList" payroll={false} groupAdmin />
      <PageHeader title={tc('titles.buildList')} description={tc('descriptions.buildList')} />
      <Card className="p-4">
        <form method="get" className="flex flex-wrap items-end gap-2" data-build-list-window>
          <label className="flex flex-col gap-1.5 text-xs">
            <span className="font-medium text-muted-foreground">{t('window')}</span>
            <select name="days" defaultValue={String(window)} className={cn(inputCls, 'min-w-40 pointer-coarse:min-h-11')}>
              {ASSESSMENT_WINDOWS.map(d => <option key={d} value={d}>{t('windowDays', { days: d })}</option>)}
            </select>
          </label>
          <button type="submit" className={cn(btnGhost, 'pointer-coarse:min-h-11')}>{t('apply')}</button>
        </form>
      </Card>
      {await RankedBuildList({ view, page: parseBoundedInt(sp.backlogPage, 1, 10000) ?? 1 })}
    </div>
  );
}
