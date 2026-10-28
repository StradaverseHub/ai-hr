import { notFound } from 'next/navigation';
import type { scopedSession } from '@/lib/scope';
import { performanceAreaTab, performanceTabAccess } from '@/packs/performance/service';
import { WORKSPACE_TAB_SCOPES, type WorkspaceTabScopeId } from '@/packs/performance/onehr/tab-route-model';
import { PerformanceTabStrip } from '@/components/performance-tabs';
import { PerformanceWorkspaceScreen, type WorkspaceQuery } from './workspace-screen';

/**
 * D-P1-32 PT-X2: the body of every employee/leader workspace tab route. The page has already applied
 * requireModule('performance') and scopedSession (its own guard, as every sibling page does); this refuses a
 * crafted URL for a tab the viewer's gate hides (or a locked Career Plan tab) with notFound(), then draws the
 * tab's strip over the EXISTING workspace narrowed to that tab (tab-route-model.ts). Awaited by the page, so
 * notFound() is thrown in the page's render path.
 */
export async function workspaceTabRoute(s:Awaited<ReturnType<typeof scopedSession>>['s'],tab:WorkspaceTabScopeId,query:WorkspaceQuery) {
 const scope=WORKSPACE_TAB_SCOPES[tab];
 const {mayOpen,facts}=await performanceTabAccess(s,scope.tabId);
 if(!mayOpen)notFound();
 const strip=performanceAreaTab(scope.tabId)!.strip;
 return <div className="space-y-3"><div className="mx-auto max-w-[100rem]"><PerformanceTabStrip strip={strip} facts={facts}/></div><PerformanceWorkspaceScreen s={s} query={query} scope={scope}/></div>;
}
