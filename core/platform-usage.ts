/**
 * ADR-0077 slice 10 — the platform usage DASHBOARD's read model.
 *
 * r113 shipped the meter (`scripts/capture-usage.ts` writes one row per tenant × company × day). This
 * is what reads it. The meter answered "what happened"; this answers the two questions Stradaverse
 * actually has: **what are we billing for**, and **is the meter even running**.
 *
 * ── IT RUNS ON THE PLATFORM POOL, NOT THE OWNER CONNECTION ────────────────────────────────────────
 * `usage_snapshot` is cross-tenant by nature, so something has to see across the wall. r113's capture
 * script used the OWNER connection because the platform role did not exist yet (slice 7, r120, created
 * it). It does now, so this reads as `ai_hr_platform`: BYPASSRLS and nothing else — it cannot ALTER the
 * schema, drop a policy, or reach the columns the migrations REVOKE. Using the owner connection for a
 * read-only dashboard would hand a reporting surface the power to rewrite the database.
 *
 * ── THE STALENESS FIELD IS THE POINT ──────────────────────────────────────────────────────────────
 * Every figure here is only as good as the last capture, and **there are no `aihr` timers installed on
 * the host** — the sweep has never run on a schedule. A usage dashboard that renders a confident total
 * over data that stopped updating three weeks ago is worse than no dashboard, because it converts a
 * visible absence into an invisible one. So `daysSinceCapture` is not decoration and callers must
 * render it: usage CANNOT be backfilled, and every un-captured day is permanently unbillable.
 */
import { sql } from 'drizzle-orm';
import { platformDb } from '../db/platform';

/** One tenant's current billable position, as at the most recent capture that exists for it. */
export type TenantUsageRow = {
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  /** The most recent captured_on for this tenant, or null when it has NEVER been metered. */
  lastCapturedOn: string | null;
  /** Whole days between `lastCapturedOn` and `asOf`. null when never captured. */
  daysSinceCapture: number | null;
  companies: number;
  activeEmployments: number;
  activeUsers: number;
  payslipsGenerated: number;
};

export type PlatformUsageSummary = {
  asOf: string;
  tenants: TenantUsageRow[];
  /** Tenants that have never been metered at all — the loudest possible "the sweep is not running". */
  neverCaptured: number;
  /**
   * Days for which NO tenant has a capture, counting back from `asOf` over the window. Each one is
   * revenue that can never be recovered, which is why it is a headline number and not a detail.
   */
  missingDays: number;
  windowDays: number;
};

const MS_PER_DAY = 86_400_000;
const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY));

/**
 * The dashboard read. `asOf` is INJECTED rather than taken from the clock so staleness is testable —
 * the same discipline core/dunning.ts and core/tenant-lifecycle.ts use, and for the same reason: a
 * date-dependent figure that cannot be asserted is a figure nobody checks.
 *
 * Each tenant is summarised at ITS OWN most recent capture, not at a global one. A tenant metered
 * yesterday and one metered last month must not be added together as though both were current — that is
 * the mixed-currency mistake in another costume (r118), and the fix is the same: carry the qualifier
 * next to the number instead of collapsing it.
 */
export async function platformUsageSummary(p: { asOf: string; windowDays?: number }): Promise<PlatformUsageSummary> {
  const windowDays = p.windowDays ?? 30;
  const { db } = platformDb();

  const rows = await db.execute<{
    tenant_id: string;
    tenant_name: string;
    tenant_status: string;
    last_captured_on: string | null;
    companies: number;
    active_employments: number;
    active_users: number;
    payslips_generated: number;
  }>(sql`
    WITH latest AS (
      -- Each tenant's own most recent capture date. A tenant with no rows survives the LEFT JOIN below
      -- with NULLs, which is what makes "never metered" visible rather than absent.
      SELECT tenant_id, max(captured_on)::text AS last_captured_on
        FROM usage_snapshot
       GROUP BY tenant_id
    )
    SELECT t.id::text                                   AS tenant_id,
           t.name                                       AS tenant_name,
           t.status                                     AS tenant_status,
           l.last_captured_on,
           coalesce(count(u.id), 0)::int                AS companies,
           coalesce(sum(u.active_employments), 0)::int  AS active_employments,
           coalesce(sum(u.active_users), 0)::int        AS active_users,
           coalesce(sum(u.payslips_generated), 0)::int  AS payslips_generated
      FROM tenant t
      LEFT JOIN latest l ON l.tenant_id = t.id
      LEFT JOIN usage_snapshot u
             ON u.tenant_id = t.id AND u.captured_on::text = l.last_captured_on
     GROUP BY t.id, t.name, t.status, l.last_captured_on
     ORDER BY t.name
  `);

  const tenants: TenantUsageRow[] = rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    tenantStatus: r.tenant_status,
    lastCapturedOn: r.last_captured_on,
    daysSinceCapture: r.last_captured_on ? daysBetween(r.last_captured_on, p.asOf) : null,
    companies: Number(r.companies),
    activeEmployments: Number(r.active_employments),
    activeUsers: Number(r.active_users),
    payslipsGenerated: Number(r.payslips_generated),
  }));

  const covered = await db.execute<{ captured_on: string }>(sql`
    SELECT DISTINCT captured_on::text AS captured_on
      FROM usage_snapshot
     WHERE captured_on > (${p.asOf}::date - ${windowDays}::int)
       AND captured_on <= ${p.asOf}::date
  `);
  const coveredSet = new Set(covered.map((c) => c.captured_on));

  return {
    asOf: p.asOf,
    tenants,
    neverCaptured: tenants.filter((t) => t.lastCapturedOn == null).length,
    missingDays: countMissingDays(coveredSet, p.asOf, windowDays),
    windowDays,
  };
}

/**
 * Days in the trailing window with no capture at all. Exported so it can be asserted without a
 * database — the arithmetic is the part that would silently under-report, not the query.
 *
 * The window is the `windowDays` days ENDING at `asOf` inclusive, so a fully-metered month reports 0
 * and a meter that has never run reports the whole window.
 */
export function countMissingDays(covered: ReadonlySet<string>, asOf: string, windowDays: number): number {
  let missing = 0;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  for (let i = 0; i < windowDays; i++) {
    const day = new Date(end - i * MS_PER_DAY).toISOString().slice(0, 10);
    if (!covered.has(day)) missing += 1;
  }
  return missing;
}
