import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { orgChartEntry } from '@/core/org-chart-window';
import { personnelImportBrowserKey } from '@/lib/personnel-import-browser-key';
import { OrgChartExplorer } from '@/components/org-chart-explorer';
import { Card, PageHeader } from '@/components/ui';
import { OrgChart } from '@/components/org-chart';

export default async function OrgChartPage() {
  const { s, scopeIds } = await scopedSession();
  const entry = await orgChartEntry(s, scopeIds);
  const count = entry.mode === 'full' ? entry.employees.length : entry.initial.totalPeople;
  const locale = await getLocale();
  const browserKey = personnelImportBrowserKey(s, scopeIds);
  const t = await getTranslations('org');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="org-intro">
        <PageHeader
          title={t('title')}
          actions={
            <span className="text-sm text-muted-foreground">
              {t('peopleCount', { count })}
            </span>
          }
        />
      </div>

      <Card className="p-5" data-tour="org-chart">
        {entry.mode === 'explorer' ? (
          <OrgChartExplorer key={`${browserKey}:${locale}`} initial={entry.initial} browserKey={browserKey} />
        ) : entry.employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <OrgChart employees={entry.employees} edges={entry.edges} />
        )}
      </Card>

      <p className="text-xs text-muted-foreground" data-tour="org-legend">
        {t.rich('legendNote', {
          strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
        })}
      </p>
    </div>
  );
}
