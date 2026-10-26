import { redirect } from 'next/navigation';
import type { SessionContext } from '../db/client';
import { getSession } from './session';
import { isModuleEnabled } from '@/core/entitlements';
import {isAdmin,hasTeamAccess,canManagePayroll,canManagePerfComp,canAdminOnehr} from './authz-model';
export {isAdmin,hasTeamAccess,isGroupAdmin,isOperator,hasGrantFor,canManagePayroll,canManagePerfComp,isPayrollPartner,withEffectiveGrants,isPerfCompPartner,canAdminOnehr,isOnehrOnlyPerformanceAdmin} from './authz-model';

/** Page-level team gate; scopedSession and the model enforce fresh company/report/module scope. */
export async function requireTeamAccess(s?: SessionContext): Promise<SessionContext> {
  const session = s ?? await getSession();
  if (!hasTeamAccess(session)) redirect('/');
  return session;
}

/**
 * Resolve the session, redirecting away from a module the tenant has not bought (ADR-0077 slice 4).
 *
 * A COURTESY, NOT A CONTROL. The service call inside the page still refuses on its own — D3 puts
 * enforcement at the service boundary, and this guard exists so the customer gets "not on your plan"
 * with a way back instead of an error screen. Deleting it would degrade the experience, not open a hole.
 *
 * The redirect carries the module code so the destination can explain WHICH module, rather than
 * bouncing the user to a dashboard with no account of what just happened.
 *
 * Fails OPEN for the same reason nav does (see lib/nav-entitlements.ts): when the session carries no
 * snapshot — a migration-lag deploy, a revoked grant, a connection blip — this lets the page through to
 * the service call, which refuses properly and names the real fault. Redirecting on an unresolved
 * snapshot would tell a paying customer their module had been removed during an infrastructure
 * incident.
 */
export async function requireModule(code: string): Promise<SessionContext> {
  const s = await getSession();
  const ctx = s as SessionContext & { entitlements?: unknown };
  if (ctx.entitlements == null) return s; // unresolved — let the service layer speak
  let enabled = true;
  try {
    enabled = isModuleEnabled(ctx as never, code);
  } catch {
    return s; // malformed context — same reasoning; the service call reports the real error
  }
  if (!enabled) redirect(`/?moduleUnavailable=${encodeURIComponent(code)}`);
  return s;
}

/** Resolve the session, redirecting non-admins away from admin-only routes. */
export async function requireAdmin(): Promise<SessionContext> {
  const s = await getSession();
  if (!isAdmin(s)) redirect('/');
  return s;
}

/** Resolve the session, redirecting anyone without payroll access (admin or payroll partner) away. */
export async function requirePayrollAccess(): Promise<SessionContext> {
  const s = await getSession();
  if (!canManagePayroll(s)) redirect('/');
  return s;
}

/** Resolve the session, redirecting anyone without perf+comp access away. */
export async function requirePerfCompAccess(): Promise<SessionContext> {
  const s = await getSession();
  if (!canManagePerfComp(s)) redirect('/');
  return s;
}

/**
 * ADR-0142 — the performance-administration screens that also serve OneHR-native cycles. Admits the
 * perf-comp set PLUS the OneHR performance partner; a page that admits through this guard must still send
 * a partner-only session away from anything generic (notFound for a non-OneHR cycle). The OneHR services
 * re-check app.onehr_cycle_admin on every read, and RLS is the backstop.
 */
export async function requireOnehrAdminAccess(): Promise<SessionContext> {
  const s = await getSession();
  if (!canAdminOnehr(s)) redirect('/');
  return s;
}
