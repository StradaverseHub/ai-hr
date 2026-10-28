import { performanceAreaStrip, type PerformanceAreaFacts, type PerformanceAreaStrip } from '@/packs/performance/onehr/tab-model';
import { PerformanceTabNav } from './performance-tab-nav';

/**
 * D-P1-32 PT-X1: THE tab strip of the Performance & Talent area. Give it a strip and the viewer's facts
 * (getPerformanceAreaFacts, or the `facts` of performanceTabAccess); it draws exactly the tabs whose gate
 * passes, from the one registry (packs/performance/onehr/tab-model.ts). Nothing is drawn when no tab passes.
 *
 * No hooks here, so a server page renders it directly and only the gate RESULTS (tab ids and states) reach
 * the client, never the worklist the gates read.
 */
export function PerformanceTabStrip({ strip, facts }: { strip: PerformanceAreaStrip; facts: PerformanceAreaFacts }) {
  const tabs = performanceAreaStrip(facts, strip);
  return tabs.length ? <PerformanceTabNav strip={strip} tabs={tabs} /> : null;
}
