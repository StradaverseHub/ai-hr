import Link from 'next/link';
import { scopedSession } from '@/lib/scope';
import { orgChartData } from '@/core/read';
import { Card } from '@/components/ui';

type Emp = { employmentId: string; name: string; department: string | null };

function OrgNode({
  id,
  empById,
  childrenByMgr,
}: {
  id: string;
  empById: Map<string, Emp>;
  childrenByMgr: Map<string, string[]>;
}) {
  const e = empById.get(id);
  if (!e) return null;
  const reports = childrenByMgr.get(id) ?? [];
  return (
    <li>
      <Link
        href={`/people/${e.employmentId}`}
        className="inline-flex flex-col rounded-lg border border-border bg-card px-4 py-2.5 transition-colors hover:border-primary"
      >
        <span className="text-sm font-medium text-foreground">{e.name}</span>
        <span className="text-xs text-muted-foreground">
          {e.department ?? '—'}
          {reports.length > 0 && ` · ${reports.length} report${reports.length === 1 ? '' : 's'}`}
        </span>
      </Link>
      {reports.length > 0 && (
        <ul className="ml-5 mt-2 space-y-2 border-l border-border pl-5">
          {reports.map((r) => (
            <OrgNode key={r} id={r} empById={empById} childrenByMgr={childrenByMgr} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function OrgChartPage() {
  const { s, scopeIds } = await scopedSession();
  const { employees, edges } = await orgChartData(s, scopeIds);

  const empById = new Map<string, Emp>(employees.map((e) => [e.employmentId, e]));
  const childrenByMgr = new Map<string, string[]>();
  const hasManager = new Set<string>();
  for (const edge of edges) {
    if (!empById.has(edge.manager) || !empById.has(edge.subordinate)) continue;
    if (!childrenByMgr.has(edge.manager)) childrenByMgr.set(edge.manager, []);
    childrenByMgr.get(edge.manager)!.push(edge.subordinate);
    hasManager.add(edge.subordinate);
  }
  const roots = employees.filter((e) => !hasManager.has(e.employmentId));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Org chart</h1>
        <span className="text-sm text-muted-foreground">administrative reporting</span>
      </div>

      <Card className="p-6">
        {roots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No employees yet.</p>
        ) : (
          <ul className="space-y-2">
            {roots.map((r) => (
              <OrgNode key={r.employmentId} id={r.employmentId} empById={empById} childrenByMgr={childrenByMgr} />
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Shows the <span className="font-medium">administrative</span> reporting line. Functional, project, and
        dotted-line relationships are visible on each person&rsquo;s detail page.
      </p>
    </div>
  );
}
