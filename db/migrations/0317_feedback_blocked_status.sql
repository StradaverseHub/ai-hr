-- A feedback item can be APPROVED and still not buildable, and until now the board could not say so.
--
-- THE PROBLEM. `approved` means "the reporter agreed to the plan", which the loop reads as "ready to
-- build". But an item is sometimes approved and then found to depend on a question only the reporter
-- can answer — whether to reverse a previously-approved calculation, whether employees with no
-- statutory record should be treated as covered, whether a shared navigation rule should change. Those
-- items sat in `approved` looking identical to work that was simply waiting its turn. The consultant
-- could not tell the two apart, and each build round had to re-derive from memory which approved items
-- were actually blocked — a fact that lived nowhere in the system.
--
-- `blocked` is therefore NOT a synonym for any existing status:
--   open       — nobody has planned it yet
--   contested  — the reporter pushed back; the plan is wrong and will be rewritten
--   blocked    — the plan is agreed, and something OUTSIDE the item has to be settled first
--
-- `blocked_by_id` names WHAT it is waiting on, so the board can link the item to the decision rather
-- than describing the dependency in prose that goes stale. Self-referencing and nullable: an item may
-- be blocked by a decision item, or blocked for a reason recorded only in its plan.
ALTER TYPE "feedback_status" ADD VALUE IF NOT EXISTS 'blocked';--> statement-breakpoint

-- Separate statement, and this is a Postgres constraint rather than a style choice: a value added to an
-- enum cannot be USED in the same transaction that added it. Anything that sets status='blocked' has to
-- run after this migration commits, which is why the backfill lives in a script and not here.
ALTER TABLE "feedback_request"
  ADD COLUMN IF NOT EXISTS "blocked_by_id" uuid REFERENCES "feedback_request"("id"),
  -- Prose for the cases blocked_by_id cannot express: waiting on a customer's own decision, on an
  -- upstream item still building, on information nobody has filed as a feedback item at all.
  ADD COLUMN IF NOT EXISTS "blocked_reason" text;--> statement-breakpoint

COMMENT ON COLUMN "feedback_request"."blocked_reason" IS
  'Why this item is parked, in the reporter''s language. Cleared on unblock — it describes a CURRENT wait, and the history lives in the event stream.';--> statement-breakpoint

COMMENT ON COLUMN "feedback_request"."blocked_by_id" IS
  'The item this one is waiting on — normally a DECISION NEEDED item. Set alongside status=blocked so the board can link them instead of describing the dependency in prose.';
