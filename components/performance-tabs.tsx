import { performanceAreaStrip, type PerformanceAreaFacts, type PerformanceAreaStrip, type PerformanceCalibrationHint, type PerformanceTabId } from '@/packs/performance/onehr/tab-model';
import { PerformanceTabNav } from './performance-tab-nav';

/**
 * D-P1-32 PT-X1: THE tab strip of the Performance & Talent area. Give it a strip and the viewer's facts
 * (getPerformanceAreaFacts, or the `facts` of performanceTabAccess); it draws exactly the tabs whose gate
 * passes, from the one registry (packs/performance/onehr/tab-model.ts). Nothing is drawn when no tab passes.
 *
 * A calibration session page passes `hint` (the session's axis, or 'talent_box' for a Talent Box view) so the
 * right Calibration tab stays lit on its per-session route.
 *
 * A page that knows a per-session target for a drawn tab passes it in `targets` (the standalone Talent Box: the BG
 * session's read-only per-axis lists, DQ-8, and its own session's board). Only the link changes: whether the tab
 * is drawn, its label and whether it is lit still come from the registry.
 *
 * No hooks here, so a server page renders it directly and only the gate RESULTS (tab ids and states) reach
 * the client, never the worklist the gates read.
 */
export function PerformanceTabStrip({ strip, facts, hint, targets }: { strip: PerformanceAreaStrip; facts: PerformanceAreaFacts; hint?: PerformanceCalibrationHint; targets?: Partial<Record<PerformanceTabId, string>> }) {
  const tabs = performanceAreaStrip(facts, strip);
  return tabs.length ? <PerformanceTabNav strip={strip} tabs={tabs} hint={hint} targets={targets} /> : null;
}
