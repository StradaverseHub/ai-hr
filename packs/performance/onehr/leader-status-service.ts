/**
 * WP-A3 (APR-022 (4)) — leader status data for the home cards. Data only: no screen, no card.
 *
 * One read, app.onehr_leader_status (0666), decides everything under the viewer's own login: the highest live
 * seat (BG CEO, then group chief, then BU CEO, then HOD), its people in the cycle, and their states and counts.
 * Authority is the seat itself: a viewer with no live seat, or an HOD while the cycle runs, gets null, never a
 * refusal that would tell them more. The projection carries counts, states, Malaysia calendar dates, aggregate
 * band counts and company/department labels only, never a per-person band; the schema below is strict, so a
 * field the database adds is refused here rather than passed on to a card.
 *
 * Running cycle: per seat, as the source's dashboard ("where your BU / the group / your group is"); there is no
 * distribution-versus-target comparison, as the source has none. Between cycles (closed): per component, people
 * with a final result released to the viewer and still waiting, and aggregate band counts over the released
 * people only; a BU CEO and an HOD are release-gated (release 1). A group chief gets no tally, as in the source.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext } from '../../../db/client';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabled } from '../../../core/entitlements';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative();
const axisState = z.enum(['locked', 'ready', 'waiting']);
const rowState = z.enum(['locked', 'ready', 'calibrating']);

const buUnit = z.object({
  companyId: z.uuid(), label: z.string(), people: count, departments: count,
  /** Both BU-tier axes locked, one of them, or neither. */
  state: z.enum(['locked', 'part', 'open']),
  /** Year-End: performance then potential. Mid-Year: one 'departmentReviews' axis (no BU calibration). */
  axes: z.array(z.object({ axis: z.enum(['performance', 'potential', 'departmentReviews']), state: axisState, lockedOn: isoDate.nullable(), in: count, of: count }).strict()),
  /** One per department review (a distinct live HOD), fewest in first, then by name. */
  depts: z.array(z.object({ name: z.string().nullable(), performanceInOn: isoDate.nullable(), potentialInOn: isoDate.nullable() }).strict()),
}).strict();
const statusRow = z.object({ label: z.string().nullable(), people: count, state: rowState, lockedOn: isoDate.nullable(), in: count, of: count });
/** Aggregate counts per band over people released to the viewer only; never a person. Null where the source shows no tally for that component. */
const bandCounts = z.array(z.object({ band: z.string(), n: count }).strict()).nullable();
const tallyCounts = z.object({ released: count, waiting: count, bands: bandCounts }).strict();

const running = { mode: z.literal('running'), cycleId: z.uuid(), midYear: z.boolean() };
export const leaderStatusSchema = z.union([
  z.object({ seat: z.literal('bu'), ...running, units: z.array(buUnit) }).strict(),
  /** BG CEO: one row per business unit. In/of: department reviews in on both axes (Mid-Year as well). */
  z.object({ seat: z.literal('bg'), ...running, ready: count, locked: count, total: count, rows: z.array(statusRow.extend({ companyId: z.uuid() }).strict()) }).strict(),
  /** Group chief: one row per batch. In/of: confirmed line-manager bands (Year-End) or department reviews in (Mid-Year). */
  z.object({ seat: z.literal('group'), ...running, ready: count, locked: count, total: count, rows: z.array(statusRow.strict()) }).strict(),
  /** Group chief between cycles: no tally, as in the source; only how many people they led. */
  z.object({ seat: z.literal('group'), mode: z.literal('record'), cycleId: z.uuid(), midYear: z.boolean(), gated: z.literal(false), people: count }).strict(),
  z.object({
    seat: z.enum(['bu', 'bg', 'hod']), mode: z.literal('record'), cycleId: z.uuid(), midYear: z.boolean(),
    /**
     * BU CEO and HOD: only people released to leaders count as released, and only they add to band counts; BG CEO:
     * nothing waits. Bands: performance for every seat; potential (Low, Mid, High) and talent status (non-zero
     * only, Super Star first) for a BU CEO only.
     */
    gated: z.boolean(), people: count,
    performance: tallyCounts, potential: tallyCounts, talent: tallyCounts,
    /** BU CEO only: department reviews in on performance. */
    departmentReviews: z.object({ in: count, of: count }).strict().nullable(),
  }).strict(),
]);
export type LeaderStatus = z.infer<typeof leaderStatusSchema>;
export type LeaderStatusSeat = LeaderStatus['seat'];

const uuid = z.uuid();

/**
 * Where the viewer's highest seat stands in one OneHR cycle; null when they hold no live seat (or only an HOD
 * assignment while the cycle runs), or the cycle is not theirs to read. Without a cycle id: the newest running
 * cycle the viewer leads anyone in, else the newest cycle they led.
 */
export async function getLeaderStatus(ctx: SessionContext, cycleId?: string): Promise<LeaderStatus | null> {
  if (cycleId !== undefined) uuid.parse(cycleId);
  if (!ctx.userId || !isModuleEnabled(ctx, 'performance')) return null;
  return withPerformanceTenant(ctx, async (tx) => {
    let wanted = cycleId ?? null;
    if (!wanted) {
      const cycles = await tx.execute<{ cycle_id: string; status: string }>(sql`select cycle_id, status from app.onehr_led_cycles()`);
      wanted = (cycles.find((c) => c.status === 'open' || c.status === 'calibration') ?? cycles[0])?.cycle_id ?? null;
    }
    if (!wanted) return null;
    const [row] = await tx.execute<{ status: unknown }>(sql`select app.onehr_leader_status(${wanted}::uuid) as status`);
    return row?.status == null ? null : leaderStatusSchema.parse(row.status);
  });
}
