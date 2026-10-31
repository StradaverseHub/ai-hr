import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { getPerformanceHome } from '@/packs/performance/service';
import { PerformanceAreaHome } from '@/components/performance-home/area-home';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * D-P1-32 PT-X3 — the Performance & Talent home ("Dashboard" tab). Every signed-in person reaches it while the
 * Performance module is on; each card reads only the viewer's own facts under their own session (released results
 * only, aggregate leader counts, no other person's band). Someone with nothing in Performance sees the empty cards,
 * never a refusal that would say more. `?unit=` picks one of a multi-unit BU CEO's units on the leader card; any
 * other value is ignored.
 */
export default async function PerformanceHomePage({ searchParams }: { searchParams: Promise<{ unit?: string | string[] }> }) {
  await requireModule('performance');
  const { s, scopeIds } = await scopedSession();
  const q = await searchParams;
  const unit = typeof q.unit === 'string' && UUID.test(q.unit) ? q.unit : undefined;
  const view = await getPerformanceHome(s, scopeIds);
  return (
    <div className="mx-auto max-w-6xl">
      <PerformanceAreaHome view={view} unit={unit} />
    </div>
  );
}
