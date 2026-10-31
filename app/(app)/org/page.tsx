import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { orgChartData } from '@/core/read';
import { Card, PageHeader } from '@/components/ui';
import { OrgChart } from '@/components/org-chart';

export default async function OrgChartPage() {
  const { s, scopeIds } = await scopedSession();
  const { employees, edges } = await orgChartData(s, scopeIds);
  const t = await getTranslations('org');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="org-intro">
        <PageHeader
          title={t('title')}
          actions={
            <span className="text-sm text-muted-foreground">
              {t('peopleCount', { count: employees.length })}
            </span>
          }
        />
      </div>

      <Card className="p-5" data-tour="org-chart">
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <OrgChart employees={employees} edges={edges} />
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
