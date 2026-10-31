import { notFound } from 'next/navigation';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { getDepartmentView } from '@/packs/performance/service';
import { DepartmentViewScreen } from '../onehr/department-view';

/**
 * WP-C (APR-022) — the HOD department view. Read-only. The population is app.onehr_department_view (0664):
 * people whose live head-of-department assignment names the viewer. A viewer who heads nobody in an open or
 * calibrating cycle gets a 404, as the source refuses the page when its tab would not show.
 */
export default async function PerformanceDepartmentPage({ searchParams }: { searchParams: Promise<{ cycle?: string | string[] }> }) {
  await requireModule('performance');
  const { s } = await scopedSession();
  const { cycle } = await searchParams;
  const view = await getDepartmentView(s, typeof cycle === 'string' ? cycle : undefined);
  if (!view) notFound();
  return <DepartmentViewScreen cycles={view.cycles} cycle={view.cycle} rows={view.rows} />;
}
