import type { ReactNode } from 'react';
import { requireModule } from './authz';

/**
 * A ROUTE-SEGMENT module guard — the second line, not the first (r292).
 *
 * `layout.tsx` is the only place in the App Router where a guard covers a whole subtree AND every page
 * added to it later. Before r292 there were NO nested layouts in this app at all, so each of the four
 * optional packs relied on per-page `requireModule` calls that only 7 of 198 pages carried.
 *
 * WHAT A SEGMENT LAYOUT COVERS
 *   • every `page.tsx` under the segment, present and future, including a page whose author forgets the
 *     check — which is the failure this exists for;
 *   • the whole nested subtree, because layouts compose;
 *   • the initial GET and the RSC navigation payload alike.
 *
 * WHAT IT DOES NOT COVER, and why the service gate is the load-bearing line
 *   • SERVER ACTIONS. A POST to an action is not a page render and does not pass through any layout in
 *     the segment, so writes are NOT protected here at all;
 *   • ROUTE HANDLERS (`route.ts`) — `app/api/payroll/**`, the payslip PDF, the CSV exports. A handler is
 *     not wrapped by a layout;
 *   • anything reached from OUTSIDE the segment (the dashboard, the approvals inbox, the report runner);
 *   • layouts are cached and may not re-run on every client-side navigation within the segment.
 *
 * So this is the clean redirect, and `core/module-gate.ts` is the control. Deleting a layout here
 * degrades the experience (an error instead of "not on your plan"); deleting the service binding opens a
 * hole. That is the same division ADR-0077 D3 draws and `lib/authz.ts requireModule` already documents,
 * including its deliberate fail-OPEN on an unresolved snapshot — which this inherits unchanged.
 */
export function moduleLayout(code: string) {
  return async function ModuleSegmentLayout({ children }: { children: ReactNode }) {
    await requireModule(code);
    return <>{children}</>;
  };
}
