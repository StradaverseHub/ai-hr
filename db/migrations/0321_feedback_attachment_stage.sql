-- A screenshot could only be attached when the item was FIRST raised, never when pushing back.
--
-- The board's whole loop is a negotiation: raise → plan → push back → re-plan. The reporter can attach an
-- image to the first step and nothing after it, which is backwards — "here is what is still wrong after
-- you shipped it" is exactly the message a screenshot carries best, and it is the one moment they cannot
-- provide one.
--
-- WHY A STAGE COLUMN AND NOT JUST A FILE INPUT. feedback_attachment has no notion of WHEN an image
-- arrived, so an untagged upload on a contest would sit indistinguishably beside the original bug
-- screenshot. On an item that has been round three times that is a pile of images with no indication
-- which round each belongs to — the same failure 0318 just fixed for the plan text itself, reintroduced
-- for the pictures. So the attachment records the revision it accompanies, and the timeline can show each
-- image beside the words it came with.
ALTER TABLE "feedback_attachment"
  -- The plan revision this image was attached ALONGSIDE. NULL = attached when the item was raised, before
  -- any plan existed — which is every row that exists today, and why the column is nullable rather than
  -- backfilled to 0: "no plan yet" and "revision 0" are different facts and only the first is true.
  ADD COLUMN IF NOT EXISTS "plan_revision" integer,
  -- What the reporter was doing when they attached it. Deliberately NOT derivable from plan_revision:
  -- a contest and a post-deploy refute can both answer revision 2, and they are different complaints —
  -- the same distinction feedback_plan_revision.outcome draws for the text.
  --   submitted  — raised with the item (the pre-0321 case)
  --   contested  — attached while pushing back on a plan
  --   refuted    — attached while sending a deployed result back
  ADD COLUMN IF NOT EXISTS "stage" text NOT NULL DEFAULT 'submitted';--> statement-breakpoint

ALTER TABLE "feedback_attachment"
  ADD CONSTRAINT "feedback_attachment_stage_ck"
  CHECK ("stage" IN ('submitted', 'contested', 'refuted'));--> statement-breakpoint

-- An image attached at submission has no plan to answer; one attached while pushing back must name the
-- revision it answers, or the timeline cannot place it. Enforced rather than trusted: the pairing is the
-- entire point of the column, and a NULL revision on a contested row would silently fall out of history.
ALTER TABLE "feedback_attachment"
  ADD CONSTRAINT "feedback_attachment_stage_revision_ck"
  CHECK (("stage" = 'submitted') = ("plan_revision" IS NULL));--> statement-breakpoint

CREATE INDEX "feedback_attachment_stage_idx"
  ON "feedback_attachment" USING btree ("feedback_request_id", "plan_revision");--> statement-breakpoint

COMMENT ON COLUMN "feedback_attachment"."plan_revision" IS
  'The plan revision this image accompanies. NULL only for stage=submitted, i.e. attached before any plan existed.';--> statement-breakpoint
COMMENT ON COLUMN "feedback_attachment"."stage" IS
  'submitted | contested | refuted — what the reporter was doing when they attached it. A contest and a refute can answer the same revision and are different complaints.';
