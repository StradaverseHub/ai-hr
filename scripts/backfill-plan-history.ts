/**
 * Seed feedback_plan_revision from what survived (0318).
 *
 * WHAT CAN BE RECOVERED, and nothing beyond it:
 *
 *   the CURRENT plan     — still in feedback_request.plan. Written as the item's latest revision.
 *   the CURRENT push-back — still in feedback_request.contest_reason when the item sits contested.
 *   post-deploy refutes  — feedback.deployment.refuted events DID carry `reason` in their payload,
 *                          so those words are recoverable even though the plan they answered is not.
 *
 * WHAT CANNOT, and is not faked:
 *
 *   every EARLIER plan text — overwritten in place on each re-plan.
 *   every earlier contest reason — cleared on each re-plan, and feedback.plan.contested recorded only
 *                          `{revision, decidedBy}`, never the words.
 *
 * On production that is ~29 items carrying roughly 40 vanished plan versions, one of them six rounds
 * deep. Those revisions are left ABSENT rather than reconstructed: the read compares the number of
 * history rows against plan_revision, so a gap shows up in the UI as "earlier versions were not kept"
 * instead of masquerading as the whole story. Writing a placeholder row would turn a known unknown into
 * a plausible lie, which is worse than the gap.
 *
 * Idempotent (ON CONFLICT DO NOTHING against the (item, revision) unique). Safe to run every deploy.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  // MIGRATION_DATABASE_URL, not the app connection: 0318 REVOKEs INSERT/UPDATE/DELETE on this table
  // from ai_hr_app on purpose — a history the app can rewrite is not a history. Only the owner role
  // writes it, here and in the services.
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required — feedback_plan_revision is owner-writable only.');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  // 1. The current plan becomes the item's latest revision. Its outcome is derived from where the item
  //    actually sits — an approved item's live plan was approved, a contested one's was contested — so
  //    the backfilled history agrees with the item's own status rather than asserting a separate one.
  const planted = await db.execute(sql`
    INSERT INTO feedback_plan_revision
      (tenant_id, feedback_request_id, revision, plan, plan_model, drafted_at, approved_at, outcome, outcome_reason, outcome_at)
    SELECT
      fr.tenant_id,
      fr.id,
      GREATEST(fr.plan_revision, 1),
      fr.plan,
      fr.plan_model,
      COALESCE(fr.decided_at, fr.updated_at, fr.created_at),
      -- Approval is a stamp, not an ending: an item past review was approved, and its plan stays the
      -- live one so a later refute still has somewhere to land.
      CASE
        WHEN fr.status IN ('approved', 'blocked', 'building', 'done', 'deployed') THEN fr.decided_at
        ELSE NULL
      END,
      CASE WHEN fr.status = 'contested' THEN 'contested' ELSE NULL END,
      CASE WHEN fr.status = 'contested' THEN fr.contest_reason ELSE NULL END,
      CASE WHEN fr.status = 'contested' THEN COALESCE(fr.decided_at, fr.updated_at) ELSE NULL END
    FROM feedback_request fr
    WHERE fr.plan IS NOT NULL AND btrim(fr.plan) <> ''
    ON CONFLICT (feedback_request_id, revision) DO NOTHING
  `);

  // 2. Post-deploy refutes. The reason IS in the event payload, so these words are genuinely recoverable.
  //    They are attached to the revision named in the payload — which may not exist as a row, in which
  //    case the UPDATE simply matches nothing. That is correct: we know what was said but not what it
  //    answered, and guessing an attachment point would misattribute the complaint to the wrong plan.
  const refuted = await db.execute(sql`
    UPDATE feedback_plan_revision r
       SET outcome = 'refuted',
           outcome_reason = e.payload->>'reason',
           outcome_at = e.occurred_at
      FROM domain_event e
     WHERE e.aggregate_type = 'feedback'
       AND e.event_type = 'feedback.deployment.refuted'
       AND e.aggregate_id = r.feedback_request_id
       AND r.revision = (e.payload->>'revision')::int
       AND r.outcome IS NULL
       AND e.payload->>'reason' IS NOT NULL
  `);

  // 3. Report the gap out loud. A backfill that only prints its successes lets a partial history pass
  //    for a complete one — the exact failure this table exists to prevent.
  const [gap] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE fr.plan_revision > 1)                        AS multi_round_items,
      COALESCE(sum(GREATEST(fr.plan_revision - 1, 0)), 0)                 AS unrecoverable_versions
    FROM feedback_request fr
    WHERE fr.plan IS NOT NULL AND btrim(fr.plan) <> ''
  `)) as unknown as { multi_round_items: number; unrecoverable_versions: number }[];

  console.log(`▸ plan history: ${planted.count ?? 0} current plans recorded, ${refuted.count ?? 0} refute reasons recovered.`);
  console.log(
    `▸ plan history: ${gap.multi_round_items} item(s) went more than one round; ` +
      `${gap.unrecoverable_versions} earlier plan version(s) predate this table and were NOT reconstructed.`,
  );
  await client.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('backfill-plan-history failed:', e);
    process.exit(1);
  });
