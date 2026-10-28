/**
 * WP-C (APR-022) — the head-of-department (HOD) department view. Read-only.
 *
 * Authority is not re-implemented here. Both reads are the SECURITY DEFINER projections of 0664:
 * app.onehr_department_cycles() offers the cycles in which the caller's live employment is named HOD on a
 * participating person's live performance_hod_assignment, and app.onehr_department_view(cycle) returns only
 * the declared display columns for those people. A cycle id from the URL is never sent to the database: it is
 * matched against the offered cycles, and an unknown one falls back to the default (open cycles first).
 */
import { sql } from 'drizzle-orm';
import type { SessionContext } from '../../../db/client';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabled } from '../../../core/entitlements';
import { pmBands, type PMBand } from './model';
import { departmentForest, pickDepartmentCycle, type DepartmentCycle, type DepartmentOrderedRow } from './department-view-model';

export type DepartmentView = { cycles: DepartmentCycle[]; cycle: DepartmentCycle; rows: DepartmentOrderedRow[] };

type CycleRow = { cycle_id: string; cycle_name: string; period_end: string; people: number; finalized: number };
type ViewRow = {
  employment_id: string; parent_employment_id: string | null; full_name: string; department_name: string | null; job_title: string | null;
  direct: boolean; finalized: boolean; overall_band: string | null; overall_score: string | number | null; mechanism: string | null;
};

const band = (v: string | null): PMBand | null => (v && (pmBands as readonly string[]).includes(v) ? (v as PMBand) : null);

/** The view for one cycle, or null when the viewer heads nobody in any open or calibrating cycle. */
export async function getDepartmentView(ctx: SessionContext, wantedCycleId?: string): Promise<DepartmentView | null> {
  return withPerformanceTenant(ctx, async (tx) => {
    const cycles: DepartmentCycle[] = (await tx.execute<CycleRow>(sql`select cycle_id, cycle_name, period_end::text as period_end, people, finalized from app.onehr_department_cycles()`))
      .map((c) => ({ id: c.cycle_id, name: c.cycle_name, periodEnd: c.period_end, people: Number(c.people), finalized: Number(c.finalized) }));
    const cycle = pickDepartmentCycle(cycles, wantedCycleId);
    if (!cycle) return null;
    const rows = await tx.execute<ViewRow>(sql`select * from app.onehr_department_view(${cycle.id}::uuid)`);
    return {
      cycles, cycle,
      rows: departmentForest(rows.map((r) => ({
        employmentId: r.employment_id, parentEmploymentId: r.parent_employment_id, fullName: r.full_name,
        department: r.department_name, jobTitle: r.job_title, direct: r.direct, finalized: r.finalized,
        overallBand: r.finalized ? band(r.overall_band) : null,
        overallScore: r.finalized && r.overall_score != null ? Number(r.overall_score) : null,
        mechanism: r.finalized && (r.mechanism === 'A' || r.mechanism === 'B') ? r.mechanism : null,
      }))),
    };
  });
}

/**
 * Link flag: does the viewer head at least one participating person in an open or calibrating cycle?
 * One existence query. False when the performance module is off.
 */
export async function hasDepartmentView(ctx: SessionContext): Promise<boolean> {
  if (!ctx.userId || !isModuleEnabled(ctx, 'performance')) return false;
  return withPerformanceTenant(ctx, async (tx) => {
    const [row] = await tx.execute<{ ok: boolean }>(sql`select exists(select 1 from app.onehr_department_cycles()) as ok`);
    return !!row?.ok;
  });
}
