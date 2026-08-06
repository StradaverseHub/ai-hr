-- Let the PLAN carry a picture, not just prose.
--
-- WHY. The board's attachment flow is one-directional and it is measurable: of 151 attachments on
-- production, 143 are IMAGES. The reporter speaks in screenshots. We answer with ~6,000 characters of
-- plain text that the board renders RAW (no Markdown, by design — see the feedback-plan skill). They
-- approve a paragraph and receive a screen, and when the screen is not what they pictured the item comes
-- back: e7eb5d83 returned from `deployed` as "the whole thing is crap, can you delete everything and
-- based on my request to rebuild again?".
--
-- Every stage this table allows is REPORTER-side — submitted / contested / refuted are all things done TO
-- a plan. There has never been a stage for the answer. `plan` is that stage: a mockup of the proposed
-- screen, attached to the revision it illustrates, visible before the reporter decides.
--
-- ONLY THE STAGE LIST CHANGES, AND THAT IS WORTH SAYING OUT LOUD. The obvious second edit — teaching
-- feedback_attachment_stage_revision_ck about the new value — is NOT needed and would be a regression to
-- write. That constraint reads:
--
--     CHECK (("stage" = 'submitted') = ("plan_revision" IS NULL))
--
-- which already says "everything that is not `submitted` must name a revision". stage='plan' with a
-- revision satisfies it (false = false); stage='plan' without one is rejected (false = true). 0321 wrote
-- it as an equivalence rather than an enumeration, so it generalised to a stage that did not exist yet.
-- Re-stating it as an IN-list would narrow it and would need editing again for the next stage.
--
-- The pinning matters as much as the picture: a mockup MUST name the revision it illustrates, or a
-- re-planned item shows the reporter a drawing of a plan that no longer exists. The check above is what
-- makes that unforgeable rather than a convention.
--
-- No GRANT: nothing is created, and feedback_attachment's grants already cover ai_hr_app.
-- No backfill: every existing row keeps the stage it has.

ALTER TABLE "feedback_attachment"
  DROP CONSTRAINT IF EXISTS "feedback_attachment_stage_ck";--> statement-breakpoint

ALTER TABLE "feedback_attachment"
  ADD CONSTRAINT "feedback_attachment_stage_ck"
  CHECK ("stage" IN ('submitted', 'contested', 'refuted', 'plan'));--> statement-breakpoint

COMMENT ON COLUMN "feedback_attachment"."stage" IS
  'submitted | contested | refuted | plan — who attached it and why. The first three are the REPORTER answering us (raised with the item, pushing back on a plan, or refuting a deployed result); `plan` is US answering THEM with a mockup of the screen a plan proposes. Everything except submitted must name the plan_revision it belongs to.';
