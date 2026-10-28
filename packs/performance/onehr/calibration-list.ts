/**
 * WP-B1 (APR-020) — the Calibration destination: the calibration sessions the viewer may ENTER.
 *
 * Authority is not re-implemented here. A row is listed only when performance_onehr_calibration RLS lets the
 * viewer read it AND app.onehr_calibration_access(id) admits them — the same predicate the calibration page's
 * entry policies use (final tier → cycle administrators; other tiers → the company's OneHR administrators,
 * a named reviewer, or the live holder of the session anchor's leader seat — WP-B2). Per-person facts come from app.assessment_calibration_work, the narrow routing
 * projection the workspace and reminders already consume: no bands, notes or names leave it.
 *
 * "To do" is the workspace's own derivation (workspace-model leaderWorkspaceParts + leaderPendingEntries):
 * the people still awaiting this tier's decision in a part that is not yet submitted/locked, excluding the
 * viewer's own entry. It is a count of people, never a judgement.
 */
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { SessionContext } from '../../../db/client';
import { company, onehrCalibration, onehrCycle, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabled } from '../../../core/entitlements';
import { policySchema, type Tier } from './model';
import { assessmentWorkWindowOpen, type CalibrationWorkEntry } from './workspace-model';
import { calibrationToDo, calibrationWindowCells, calibrationWindowState, sortCalibrationSessions, type CalibrationListSession } from './calibration-list-model';
import type { PackTaskItem } from '../../../lib/assigned-work';

export { calibrationListTierOrder, type CalibrationListSession } from './calibration-list-model';


/** Every calibration session the viewer may enter, with the facts the Calibration page shows. Read-only. */
export async function listMyCalibrationSessions(ctx: SessionContext, now = new Date()): Promise<CalibrationListSession[]> {
  return withPerformanceTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ session: onehrCalibration, cycle: reviewCycle, policy: onehrCycle.policy, companyName: company.legalName })
      .from(onehrCalibration)
      .innerJoin(reviewCycle, eq(reviewCycle.id, onehrCalibration.cycleId))
      .innerJoin(onehrCycle, and(eq(onehrCycle.cycleId, onehrCalibration.cycleId), eq(onehrCycle.tenantId, onehrCalibration.tenantId)))
      .leftJoin(company, eq(company.id, onehrCalibration.companyId))
      .where(sql`app.onehr_calibration_access(${onehrCalibration.id}) and coalesce((${onehrCycle.policy}->'modules'->>'calibration')::boolean,true)`)
      .orderBy(desc(reviewCycle.periodEnd), asc(onehrCalibration.name), asc(onehrCalibration.id));
    const out: CalibrationListSession[] = [];
    for (const { session, cycle, policy: raw, companyName } of rows) {
      const policy = policySchema.parse(raw), tier = session.tier as Tier, cycleClosed = cycle.status === 'closed';
      const [work] = await tx.execute<{ entries: CalibrationWorkEntry[] | null }>(sql`select app.assessment_calibration_work(${session.id}::uuid) as entries`);
      const entries = (work?.entries ?? []).filter((entry) => entry.personId !== ctx.personId);
      out.push({
        id: session.id, name: session.name, tier, cycleId: cycle.id, cycleName: cycle.name, cycleClosed,
        companyName: session.companyId ? companyName ?? null : null,
        ...calibrationWindowState(policy, tier, cycleClosed, now),
        people: entries.length,
        toDo: cycleClosed ? 0 : calibrationToDo(policy, tier, session, entries),
        lock: session.lockedAt ? 'locked' : session.performanceLockedAt || session.potentialLockedAt ? 'partial' : 'open',
        href: `/performance/assessment/calibration/${session.id}`,
      });
    }
    // Open windows first; the query's cycle/name order holds within each window state.
    return sortCalibrationSessions(out);
  });
}

/**
 * Sidebar flag: is the viewer a named reviewer (explicitly, or as the live holder of the session anchor's
 * leader seat: app.onehr_calibration_reviewer, WP-B2) on at least one non-final session they may enter?
 *
 * ONE existence query per request. Administrators are not asked here: the sidebar already holds
 * canAdministerOnehr from the session grants and ORs it in. Final-tier sessions are excluded because only
 * cycle administrators enter them, whatever reviewer_user_ids says. Answers false when the performance
 * module is off; an unresolved entitlement snapshot THROWS (service rule, module-catalog-drift) and the
 * root layout's caller turns that into a hidden row.
 */
export async function hasCalibrationAssignment(ctx: SessionContext): Promise<boolean> {
  if (!ctx.userId || !isModuleEnabled(ctx, 'performance')) return false;
  return withPerformanceTenant(ctx, async (tx) => {
    const [row] = await tx.execute<{ ok: boolean }>(sql`select exists(
      select 1 from performance_onehr_calibration s
      where s.tenant_id = app.current_tenant_id() and s.tier <> 'final'
        and app.onehr_calibration_reviewer(s.id, app.current_user_id())
        and app.onehr_calibration_access(s.id)) as ok`);
    return !!row?.ok;
  });
}

/** A calibration task before the shared list drops its company (null for a group-wide session). */
export type CalibrationTask = PackTaskItem & { kind: 'calibration'; companyId: string | null };

/**
 * Calibration work awaiting the viewer, for the shared task list (packs/performance/onehr/tasks.ts).
 *
 * A task only where the viewer is a NAMED reviewer (`reviewer_user_ids`, or the live holder of the session
 * anchor's leader seat — app.onehr_calibration_reviewer, WP-B2): an HR administrator or performance
 * partner who can open a session only because they administer the cycle has no calibration task for it —
 * their entry point is the Calibration page. Beyond that, the same gates the Calibration page reads: not the
 * final tier (cycle administrators only), `app.onehr_calibration_access`, the cycle's calibration module, a
 * cycle that is not closed, this tier's window open now, and at least one person still awaiting the tier's
 * decision (`calibrationToDo`, excluding the viewer's own entry).
 *
 * The named-reviewer, tier, cycle and module filters run in SQL, so `app.assessment_calibration_work` is
 * called only for the viewer's own sessions — never once per session in the tenant for an administrator.
 *
 * Owner time: the later of the session's creation and the opening of its currently open window. A reviewer
 * named on a session created months before its window opens has owed nothing until the window opened; a
 * tier with no window (Group) is owed from creation. The time the viewer was added to reviewer_user_ids is not
 * recorded anywhere, so it cannot be used.
 *
 * Payload: id, kind, session name, owner time and link (plus the company for the switcher, dropped by the
 * caller). No band, rating, note, name of a person or count.
 */
export async function pendingCalibrationTasks(ctx: SessionContext, now = new Date()): Promise<CalibrationTask[]> {
  if (!ctx.userId) return [];
  return withPerformanceTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ session: onehrCalibration, policy: onehrCycle.policy })
      .from(onehrCalibration)
      .innerJoin(reviewCycle, eq(reviewCycle.id, onehrCalibration.cycleId))
      .innerJoin(onehrCycle, and(eq(onehrCycle.cycleId, onehrCalibration.cycleId), eq(onehrCycle.tenantId, onehrCalibration.tenantId)))
      .where(and(
        sql`app.onehr_calibration_reviewer(${onehrCalibration.id}, app.current_user_id())`,
        ne(onehrCalibration.tier, 'final'),
        ne(reviewCycle.status, 'closed'),
        sql`coalesce((${onehrCycle.policy}->'modules'->>'calibration')::boolean,true)`,
        sql`app.onehr_calibration_access(${onehrCalibration.id})`,
      ))
      .orderBy(asc(onehrCalibration.createdAt), asc(onehrCalibration.id));
    const out: CalibrationTask[] = [];
    for (const { session, policy: raw } of rows) {
      // This runs from the root layout: a policy the canonical schema rejects yields no task rather than a
      // 500 on every route. The Calibration page still reports the defect.
      const parsed = policySchema.safeParse(raw);
      if (!parsed.success) continue;
      const policy = parsed.data, tier = session.tier as Tier;
      if (calibrationWindowState(policy, tier, false, now).window !== 'open') continue;
      const [work] = await tx.execute<{ entries: CalibrationWorkEntry[] | null }>(sql`select app.assessment_calibration_work(${session.id}::uuid) as entries`);
      const entries = (work?.entries ?? []).filter((entry) => entry.personId !== ctx.personId);
      if (calibrationToDo(policy, tier, session, entries) <= 0) continue;
      const opened = calibrationWindowCells(policy, tier)
        .filter((cell) => assessmentWorkWindowOpen(policy, cell, now))
        .map((cell) => policy.windows[cell]?.opensAt)
        .filter((at): at is string => !!at)
        .map((at) => Date.parse(at))
        .sort((x, y) => x - y)[0];
      const since = opened !== undefined && opened > session.createdAt.getTime() ? new Date(opened) : session.createdAt;
      out.push({
        id: session.id, kind: 'calibration', subjectName: session.name, createdAt: since.toISOString(),
        linkPath: `/performance/assessment/calibration/${session.id}`, companyId: session.companyId,
      });
    }
    return out;
  });
}
