import { sql } from 'drizzle-orm';
import type { SessionContext } from '../../db/client';
import { withRewardsTenant } from '../../core/module-gate';

type ReviewActivity = {
  id: string; unitId: string; eventType: string; time: string; actorName: string | null;
  subjectId: string | null; subjectName: string | null; reason: string | null;
  changes: { field: string; before: string | number | boolean | null | Record<string,string>; after: string | number | boolean | null | Record<string,string> }[];
};

/** The native Group Rewards projection exposes only the allowlisted audit fields. */
export async function rewardReviewActivity(ctx: SessionContext, unitIds: readonly string[], actorId?: string, subjectId?: string) {
  if (!unitIds.length) return [];
  const units = sql`ARRAY[${sql.join(unitIds.map(id => sql`${id}::uuid`), sql`, `)}]`;
  return withRewardsTenant(ctx, tx => tx.execute<ReviewActivity>(sql`
    select a.id, a.unit_id as "unitId", a.event_type as "eventType", a.occurred_at::text as "time", a.actor_name as "actorName",
      a.subject_id as "subjectId", a.subject_name as "subjectName",
      case when a.event_type='reward-unit.recommendation-updated' and c.id is null then null else a.reason end as reason,
      coalesce(c.changes,'[]'::jsonb) as changes
    from app.reward_review_activity(${units}, ${actorId ?? null}::uuid, ${subjectId ?? null}::uuid) with ordinality a
    left join app.reward_review_activity_changes(${units}, ${actorId ?? null}::uuid, ${subjectId ?? null}::uuid) c on c.id=a.id
    order by a.ordinality`));
}
