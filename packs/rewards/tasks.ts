/**
 * Rewards work awaiting the viewer, projected into the shared task list (WP-A1).
 *
 * The authority is `pendingRewardReviews` — the queue /approvals already renders as its Rewards card:
 * a unit at an approval stage (bg, gr, ctro, ec) that `app.reward_roles` says is THIS viewer's stage. A
 * BU or PBP member therefore sees nothing while the unit sits at BG; the BG member sees it. This file
 * does not re-decide that; it only supplies what the shared list needs and the queue does not return:
 *
 *   - an owner timestamp (the unit's creation, the queue's own sort key), and
 *   - an unscoped read. `pendingRewardReviews` takes company ids and answers [] for none, but Home and
 *     My tasks ask without a company selection. The companies are taken from the stage-status units the
 *     viewer can read at all (RLS) — a superset of the queue — so the queue still decides every row.
 *
 * The first read doubles as the cheap exit: a viewer who can read no unit at an approval stage (almost
 * everyone, on almost every page) costs one query and never reaches the queue.
 *
 * "Returned to me" work is not a source yet; it is added beside `pendingRewardReviews` below.
 * Payload: id, kind, subject name, owner timestamp and link. No pay, budget, band or recommendation.
 */
import { inArray } from 'drizzle-orm';
import type { SessionContext } from '../../db/client';
import { rewardUnit } from '../../db/schema';
import { withRewardsTenant } from '../../core/module-gate';
import type { PackTaskItem } from '../../lib/assigned-work';
import { pendingRewardReviews } from './service';

const APPROVAL_STAGES = ['bg', 'gr', 'ctro', 'ec'] as const;

/** The rewards pack's task provider (core/approvals-inbox.ts PACK_TASK_SOURCES). */
export async function pendingRewardTasks(ctx: SessionContext, scopeIds: string[] | undefined): Promise<PackTaskItem[]> {
  const readable = await withRewardsTenant(ctx, (tx) => tx
    .select({ id: rewardUnit.id, companyId: rewardUnit.companyId, createdAt: rewardUnit.createdAt })
    .from(rewardUnit).where(inArray(rewardUnit.status, [...APPROVAL_STAGES])));
  if (!readable.length) return [];
  const companyIds = scopeIds ?? [...new Set(readable.map((u) => u.companyId))];
  const createdAt = new Map(readable.map((u) => [u.id, u.createdAt]));
  // A unit that entered the queue between the two reads has no owner time here; it is left to the next
  // read rather than given a guessed age (lib/assigned-work.ts: never a guessed task age).
  return (await pendingRewardReviews(ctx, companyIds)).flatMap((r) => {
    const at = createdAt.get(r.id);
    return at ? [{ id: r.id, kind: 'rewardReview' as const, subjectName: `${r.cycle} · ${r.name}`, createdAt: at.toISOString(), linkPath: `/rewards/${r.id}?view=approvals` }] : [];
  });
}
