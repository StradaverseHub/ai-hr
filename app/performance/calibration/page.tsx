import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listMyCalibrationSessions } from '@/packs/performance/service';
import { CalibrationList } from '../onehr/calibration-list';

/**
 * WP-B1 (APR-020) — Calibration: the sessions this viewer may enter, grouped by tier. Read-only.
 * Access is the session's own (RLS + app.onehr_calibration_access); a viewer with none sees the empty state.
 */
export default async function PerformanceCalibrationPage() {
  await requireModule('performance');
  const { s } = await scopedSession();
  return <CalibrationList sessions={await listMyCalibrationSessions(s)} />;
}
