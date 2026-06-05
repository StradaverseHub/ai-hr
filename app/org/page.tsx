import Link from 'next/link';
import { getSession } from '@/lib/session';
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
        className="inline-flex flex-col rounded-lg border border-zinc-200 bg-white px-4 py-2.5 transition-colors hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-indigo-500"
      >
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{e.name}</span>
        <span className="text-xs text-zinc-500">
          {e.department ?? '—'}
          {reports.length > 0 && ` · ${reports.length} report${reports.length === 1 ? '' : 's'}`}
        </span>
      </Link>
      {reports.length > 0 && (
        <ul className="ml-5 mt-2 space-y-2 border-l border-zinc-200 pl-5 dark:border-zinc-800">
          {reports.map((r) => (
            <OrgNode key={r} id={r} empById={empById} childrenByMgr={childrenByMgr} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function OrgChartPage() {
  const s = await getSession();
  const { employees, edges } = await orgChartData(s);

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
        <span className="text-sm text-zinc-500">administrative reporting</span>
      </div>

      <Card className="p-6">
        {roots.length === 0 ? (
          <p className="text-sm text-zinc-500">No employees yet.</p>
        ) : (
          <ul className="space-y-2">
            {roots.map((r) => (
              <OrgNode key={r.employmentId} id={r.employmentId} empById={empById} childrenByMgr={childrenByMgr} />
            ))}
          </ul>
        )}
      </Card>

      <p className="text-xs text-zinc-500">
        Shows the <span className="font-medium">administrative</span> reporting line. Functional, project, and
        dotted-line relationships are visible on each person&rsquo;s detail page.
      </p>
    </div>
  );
}
