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

/** Minimal shape this needs — any drizzle handle on an owner-role connection. */
type Executor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Exported so the suite can run the REAL statements against a pre-0318 fixture rather than a paraphrase
 * of them. A backfill verified only by reading it is a backfill nobody has run.
 */
export async function backfillPlanHistory(db: Executor): Promise<{ planted: number; refuted: number; unrecoverable: number }> {
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

  // 2. Relabel a live push-back that was actually a post-deploy refute.
  //
  //    refuteDeployment moves the item to `contested` and writes the refute text into contest_reason, so
  //    step 1 above faithfully recovers the WORDS but calls them 'contested'. That is the wrong label:
  //    "you built the wrong thing" and "you shipped it and it missed" are different complaints, and this
  //    table exists to keep the difference. Matched on the item's own reopened_count (>0 means it has
  //    been through a deploy-and-return cycle) plus a refute event carrying that exact reason.
  await db.execute(sql`
    UPDATE feedback_plan_revision r
       SET outcome = 'refuted'
      FROM feedback_request fr
     WHERE fr.id = r.feedback_request_id
       AND r.outcome = 'contested'
       AND fr.reopened_count > 0
       AND EXISTS (
         SELECT 1 FROM domain_event e
          WHERE e.aggregate_type = 'feedback'
            AND e.event_type = 'feedback.deployment.refuted'
            AND e.aggregate_id = r.feedback_request_id
            AND e.payload->>'reason' = r.outcome_reason
       )
  `);

  // 3. Post-deploy refutes on versions that ARE still present. The reason IS in the event payload, so
  //    these words are genuinely recoverable.
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

  // 4. Report the gap out loud. A backfill that only prints its successes lets a partial history pass
  //    for a complete one — the exact failure this table exists to prevent.
  const [gap] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE fr.plan_revision > 1)                        AS multi_round_items,
      COALESCE(sum(GREATEST(fr.plan_revision - 1, 0)), 0)                 AS unrecoverable_versions
    FROM feedback_request fr
    WHERE fr.plan IS NOT NULL AND btrim(fr.plan) <> ''
  `)) as unknown as { multi_round_items: number; unrecoverable_versions: number }[];

  return {
    planted: Number((planted as { count?: number }).count ?? 0),
    refuted: Number((refuted as { count?: number }).count ?? 0),
    unrecoverable: Number(gap.unrecoverable_versions ?? 0),
  };
}

async function main() {
  // MIGRATION_DATABASE_URL, not the app connection: 0318 lets ai_hr_app append and close but never
  // rewrite, and this script rewrites history wholesale from the surviving columns — owner work.
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required — the plan-history backfill is owner-only.');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  const r = await backfillPlanHistory(db);
  console.log(`▸ plan history: ${r.planted} current plan(s) recorded, ${r.refuted} refute reason(s) recovered.`);
  console.log(
    `▸ plan history: ${r.unrecoverable} earlier plan version(s) predate this table and were NOT reconstructed.`,
  );
  await client.end();
}

// Only when run as a command. Without this guard, importing backfillPlanHistory (which the suite does,
// so it exercises the REAL statements) also fires main(), which has no MIGRATION_DATABASE_URL under
// vitest and kills the worker with process.exit(1).
const invokedDirectly = process.argv[1]?.includes('backfill-plan-history');
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('backfill-plan-history failed:', e);
      process.exit(1);
    });
}
