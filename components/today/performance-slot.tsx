import {Suspense} from 'react';
import type {SessionContext} from '@/db/client';
import {PerformanceHomeSlot} from '@/components/performance-home/performance-home';
import {PanelBoundary} from './employee/panel-boundary';

/** The Performance block on every Today (WP-A2): the person's own review steps, and the performance work assigned to
 * them (reviews, assessments, career plans, calibration). It reads its own facts and draws nothing when there is
 * nothing to show; it sits in its own Suspense and error boundary, so it never holds back or breaks the rest of Today.
 * Every Home mounted it before Today replaced them; Employee, Administrator and Manager Today mount it here. An async
 * server component, so the streamed page resolves its boundary with the rest of the page. */
export async function TodayPerformance({session,scopeIds}:{session:SessionContext;scopeIds:readonly string[]|undefined}){
 return <PanelBoundary fallback={null}>
  <Suspense fallback={null}><div data-today-performance className="min-w-0"><PerformanceHomeSlot session={session} scopeIds={scopeIds?[...scopeIds]:undefined}/></div></Suspense>
 </PanelBoundary>;
}
