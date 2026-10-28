import { notFound } from 'next/navigation';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { getPerformanceAreaFactsAndItems, listMyCalibrationSessions, performanceTabState } from '@/packs/performance/service';
import { calibrationSessionsForAxis } from '@/packs/performance/onehr/calibration-list-model';
import { PerformanceTabStrip } from '@/components/performance-tabs';
import { CalibrationList } from '../onehr/calibration-list';
import { talentBoxHref, talentBoxSessionIds } from './talent-box/talent-box-route';

type Query={axis?:string};
/**
 * WP-B1 (APR-020) — Calibration: the sessions this viewer may enter, grouped by tier. Read-only.
 * Access is the session's own (RLS + app.onehr_calibration_access); a viewer with none sees the empty state.
 *
 * D-P1-32 PT-X2: under the Calibration strip. `?axis=performance|potential` is the tab's per-axis list: only
 * the sessions calibrating that axis (a BG Talent Box session is listed on both, read-only, DQ-8), and a 404
 * when that tab is hidden for the viewer. Each row then opens the session with the axis, so its page keeps the
 * tab lit. Without an axis (or with an unknown one) the page is the whole list, as before (D8).
 *
 * PT-TB: a session whose Talent Box the viewer holds (talentBoxSessionIds over the same worklist the strip's gates
 * read, so only while its Talent box tab shows) also links to that session's standalone board.
 */
export default async function PerformanceCalibrationPage({searchParams}:{searchParams:Promise<Query>}) {
  await requireModule('performance');
  const { s } = await scopedSession();
  const { axis: raw } = await searchParams;
  const axis = raw === 'performance' || raw === 'potential' ? raw : undefined;
  const { facts, items } = await getPerformanceAreaFactsAndItems(s);
  if (axis && performanceTabState(facts, `calibration.${axis}`) !== 'open') notFound();
  const sessions = await listMyCalibrationSessions(s);
  const shown = axis ? calibrationSessionsForAxis(sessions, axis).map((session) => ({ ...session, href: `${session.href}?axis=${axis}` })) : sessions;
  const held = performanceTabState(facts, 'calibration.talentBox') === 'open' ? talentBoxSessionIds(items) : new Set<string>();
  const boards = Object.fromEntries(shown.filter((session) => held.has(session.id)).map((session) => [session.id, talentBoxHref(session.id)]));
  return (
    <div className="space-y-3">
      <div className="mx-auto max-w-5xl"><PerformanceTabStrip strip="calibration" facts={facts} /></div>
      <CalibrationList sessions={shown} boards={boards} />
    </div>
  );
}
