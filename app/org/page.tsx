import { scopedSession } from '@/lib/scope';
import { orgChartData } from '@/core/read';
import { Card, PageHeader } from '@/components/ui';
import { OrgChart } from '@/components/org-chart';

export default async function OrgChartPage() {
  const { s, scopeIds } = await scopedSession();
  const { employees, edges } = await orgChartData(s, scopeIds);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Org chart"
        actions={<span className="text-sm text-muted-foreground">{employees.length} people</span>}
      />

      <Card className="p-5">
        {employees.length === 0 ? (
          <p className="text-sm text-muted-foreground">No employees yet.</p>
        ) : (
          <OrgChart employees={employees} edges={edges} />
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        The connector colour encodes the reporting relationship —{' '}
        <span className="font-medium text-foreground">direct</span> (administrative), functional, project, and{' '}
        <span className="font-medium text-foreground">dotted-line</span>. A person has one direct manager (the
        tree) and may have several cross-cutting lines.
      </p>
    </div>
  );
}
