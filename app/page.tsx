import {notFound,redirect} from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { MODULE_CATALOG } from '@/packs/catalog';
import { Card } from '@/components/ui';
import { EmployeeTodayPage } from '@/components/today/employee/today-page';
import { AdminTodayPage, ManagerTodayPage } from '@/components/today/admin/today-pages';
import { todayLayoutFor } from '@/lib/today/admin';
import { retiredWorkspaceRedirect } from '@/lib/today/workspace';
import { assignedApprovalHref, parseAssignedApprovalFocus } from '@/lib/assigned-approval-focus';

// a00c4f64 — no `searchParams` any more. The four params this page read (?abs / ?view / ?cal / ?focus)
// belonged to the Leave Calendar, which moved to /leave/tracker and still reads all four there.
//
// r292 REINSTATES `searchParams` for ONE param, and does not undo a00c4f64: the four calendar params are
// still gone and still read at /leave/tracker. `?moduleUnavailable=<code>` is the destination half of
// `lib/authz.ts requireModule`, which has redirected here since ADR-0077 slice 4 — carrying the module
// code precisely "so the destination can explain WHICH module" — while this page read the param nowhere
// and said nothing. r292 takes the count of routes that can perform that redirect from 7 to ~90, so a
// silent bounce to the dashboard stops being a rare curiosity and becomes the normal experience of
// declining a module. The code is resolved against MODULE_CATALOG and DISCARDED if unknown: nothing from
// the query string is ever rendered, only a catalogue name that was compiled into the build.
export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ moduleUnavailable?: string | string[];employmentId?:string|string[];workspace?:string|string[];needs?:string|string[];recommend?:string|string[] }>;
}) {
  const homeQuery = await searchParams;
  // The old dashboard is retired (owner decision, 12 Nov 2026): its two addresses, `?workspace=dashboard` (the earlier
  // administrator dashboard) and `?workspace=team` (the team workbench), redirect to `/`, which draws the person's own
  // Today below. The redirect keeps only the parameters this page reads (lib/today/workspace.ts).
  const retired = retiredWorkspaceRedirect(homeQuery);
  if (retired) redirect(retired);
  const scoped = await scopedSession();
  // An ambiguous employment choice is refused before anything renders, exactly as before.
  if (!isAdmin(scoped.s) && Array.isArray(homeQuery?.employmentId)) notFound();
  // r292's "module unavailable" explanation is about the redirect that brought the person here, so it leads the
  // page, above Today, once.
  const rawUnavailable = homeQuery?.moduleUnavailable;
  const unavailableCode = Array.isArray(rawUnavailable) ? rawUnavailable[0] : rawUnavailable;
  const unavailableModule = MODULE_CATALOG.find((m) => m.code === unavailableCode && !m.isCore) ?? null;
  const tModule = await getTranslations('moduleUnavailable');
  const notice = unavailableModule && (
    <Card role="status" className="border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/40">
      <h2 className="text-sm font-semibold">{tModule('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{tModule('body', { module: unavailableModule.name })}</p>
    </Card>
  );
  // Today by audience (owner decisions, 11 and 12 Nov 2026): an HR administrator gets Admin Today, a manager Manager
  // Today, and everyone else, payroll and performance partners included, Employee Today.
  const layout = todayLayoutFor(scoped.s.roles, isAdmin(scoped.s));
  const ownEmploymentId = typeof homeQuery?.employmentId === 'string' ? homeQuery.employmentId : undefined;
  const recommend = typeof homeQuery?.recommend === 'string' ? homeQuery.recommend : undefined;
  if (layout === 'manager') {
    return <ManagerTodayPage session={scoped.s} scopeIds={scoped.scopeIds} allCompanies={scoped.scopeIds.length >= scoped.allowedCount} notice={notice} employmentId={ownEmploymentId} recommend={recommend} />;
  }
  // `?recommend=<leave request>` (the leave recommendation link): Manager Today opens it in place; an administrator's
  // Today groups decisions and a partner's Today lists none, so it opens the request's own review on /approvals, where
  // the recommendation is drawn beside it and the person's own queue is checked again.
  if ((layout === 'administrator' || layout === 'other') && recommend) {
    const focus = (() => { try { return parseAssignedApprovalFocus('leave', recommend); } catch { return null; } })();
    if (focus) redirect(assignedApprovalHref(focus));
  }
  if (layout === 'administrator') {
    return <AdminTodayPage session={scoped.s} scopeIds={scoped.scopeIds} allCompanies={scoped.scopeIds.length >= scoped.allowedCount} notice={notice} all={homeQuery?.needs === 'all'} employmentId={ownEmploymentId} />;
  }
  return <EmployeeTodayPage session={scoped.s} scopeIds={scoped.scopeIds} employmentId={ownEmploymentId} notice={notice} />;
}
