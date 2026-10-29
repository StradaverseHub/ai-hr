/**
 * M13 (D14) — team availability for a caller-chosen window. COMPOSITION ONLY, over the owners the v1 team card
 * (app/api/mobile/v1/team/route.ts) and the approvals cover (core/mobile-approvals.ts teamCover) already read:
 *
 *   membership  resolveMyTeamScope(ctx, {view:'week', scope:'all'}) — no caller-supplied employee, company,
 *               department or scope ever reaches it (the route reads only `from`/`to`)
 *   leave       myTeamLeaveProjection over exactly those employments and the window
 *
 * DISCLOSURE. Each member carries a name and, per date in the window, approved vs pending and the session. The
 * projection's leave type (id, code, name, colour), times and request id are dropped here and never serialized.
 *
 * Kept free of 'server-only' (core/mobile-command-receipt.ts says why the mobile core stays reachable).
 */
import type { SessionContext } from '../db/client';
import { ModuleNotEnabledError } from './entitlements';
import { MyTeamAuthorizationError, resolveMyTeamScope } from './my-team-scope';
import { myTeamLeaveProjection } from '../packs/leave/service';
import { hasTeamAccess } from '../lib/authz-model';
import { TEAM_DATES_PER_MEMBER_MAX, TEAM_MEMBERS_MAX, type TeamAvailabilityV2, type TeamSession } from '../lib/mobile-api/v2/team';

const SESSION_ORDER: Record<TeamSession, number> = { full_day: 0, AM: 1, PM: 2, hourly: 3 };

/** `from`..`to` inclusive, already validated by the route (calendar dates, at most TEAM_WINDOW_MAX_DAYS). */
export async function teamAvailabilityV2(ctx: SessionContext, w: { from: string; to: string; today: string }): Promise<TeamAvailabilityV2> {
  const off: TeamAvailabilityV2 = { enabled: false, today: w.today, from: w.from, to: w.to, scope: 'my_team', companies: 0, memberCount: 0, truncated: false, items: [] };
  if (!hasTeamAccess(ctx)) return off;
  let scope: Awaited<ReturnType<typeof resolveMyTeamScope>>;
  try { scope = await resolveMyTeamScope(ctx, { view: 'week', scope: 'all' }); }
  catch (e) { if (e instanceof MyTeamAuthorizationError || e instanceof ModuleNotEnabledError) return off; throw e; }
  const members = scope.employees.slice(0, TEAM_MEMBERS_MAX);
  const rows = members.length
    ? await myTeamLeaveProjection({ ...ctx, personId: scope.principal.personId }, { employmentIds: members.map((e) => e.employmentId), from: w.from, to: w.to, today: w.today })
    : [];
  const items = members.map((e) => ({
    employmentId: e.employmentId,
    name: e.name,
    dates: rows.filter((r) => r.employmentId === e.employmentId)
      .flatMap((r) => r.dates.filter((d) => d.date >= w.from && d.date <= w.to).map((d) => ({ date: d.date, status: d.status, session: r.session as TeamSession })))
      .sort((a, b) => a.date.localeCompare(b.date) || SESSION_ORDER[a.session] - SESSION_ORDER[b.session] || a.status.localeCompare(b.status))
      .slice(0, TEAM_DATES_PER_MEMBER_MAX),
  }));
  return { enabled: true, today: w.today, from: w.from, to: w.to, scope: 'my_team', companies: scope.companies.length, memberCount: scope.employees.length, truncated: scope.employees.length > members.length, items };
}
