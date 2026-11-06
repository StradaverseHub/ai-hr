import { sql } from 'drizzle-orm';
import type { SessionContext } from '../../db/client';
import { withRewardsTenant } from '../../core/module-gate';

type ReviewActivity = {
  id: string; unitId: string; eventType: string; time: string; actorName: string | null;
  subjectId: string | null; subjectName: string | null; reason: string | null;
};

/** The native Group Rewards projection exposes only the allowlisted audit fields. */
export async function rewardReviewActivity(ctx: SessionContext, unitIds: readonly string[], actorId?: string, subjectId?: string) {
  if (!unitIds.length) return [];
  const units = sql`ARRAY[${sql.join(unitIds.map(id => sql`${id}::uuid`), sql`, `)}]`;
  return withRewardsTenant(ctx, tx => tx.execute<ReviewActivity>(sql`
    select id, unit_id as "unitId", event_type as "eventType", occurred_at::text as "time", actor_name as "actorName",
      subject_id as "subjectId", subject_name as "subjectName", reason
    from app.reward_review_activity(${units}, ${actorId ?? null}::uuid, ${subjectId ?? null}::uuid)`));
}
