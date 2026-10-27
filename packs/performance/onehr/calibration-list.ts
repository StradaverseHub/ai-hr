/**
 * WP-B1 (APR-020) — the Calibration destination: the calibration sessions the viewer may ENTER.
 *
 * Authority is not re-implemented here. A row is listed only when performance_onehr_calibration RLS lets the
 * viewer read it AND app.onehr_calibration_access(id) admits them — the same predicate the calibration page's
 * entry policies use (final tier → cycle administrators; other tiers → the company's OneHR administrators or
 * a named reviewer). Per-person facts come from app.assessment_calibration_work, the narrow routing
 * projection the workspace and reminders already consume: no bands, notes or names leave it.
 *
 * "To do" is the workspace's own derivation (workspace-model leaderWorkspaceParts + leaderPendingEntries):
 * the people still awaiting this tier's decision in a part that is not yet submitted/locked, excluding the
 * viewer's own entry. It is a count of people, never a judgement.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { SessionContext } from '../../../db/client';
import { company, onehrCalibration, onehrCycle, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabledOrFalse } from '../../../core/entitlements';
import { policySchema, type Tier } from './model';
import type { CalibrationWorkEntry } from './workspace-model';
import { calibrationToDo, calibrationWindowState, sortCalibrationSessions, type CalibrationListSession } from './calibration-list-model';

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
 * Sidebar flag: is the viewer a named reviewer on at least one non-final session they may enter?
 *
 * ONE existence query per request. Administrators are not asked here: the sidebar already holds
 * canAdministerOnehr from the session grants and ORs it in. Final-tier sessions are excluded because only
 * cycle administrators enter them, whatever reviewer_user_ids says. Fails closed (false) when the
 * performance module is off or the entitlement snapshot did not resolve.
 */
export async function hasCalibrationAssignment(ctx: SessionContext): Promise<boolean> {
  if (!ctx.userId || !isModuleEnabledOrFalse(ctx, 'performance')) return false;
  return withPerformanceTenant(ctx, async (tx) => {
    const [row] = await tx.execute<{ ok: boolean }>(sql`select exists(
      select 1 from performance_onehr_calibration s
      where s.tenant_id = app.current_tenant_id() and s.tier <> 'final'
        and app.current_user_id() = any(s.reviewer_user_ids)
        and app.onehr_calibration_access(s.id)) as ok`);
    return !!row?.ok;
  });
}
