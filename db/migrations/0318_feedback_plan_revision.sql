-- The negotiation between reporter and agent was being destroyed as it happened.
--
-- WHAT WAS LOST. `feedback_request` holds ONE `plan` column and ONE `contest_reason`. Every re-plan
-- overwrote the plan and cleared the push-back that caused it, and the `feedback.plan.drafted` /
-- `feedback.plan.contested` events recorded only `{revision, model}` — never the text. So on any item
-- that went round more than once, the earlier plan and the reporter's objection to it were gone, and
-- nobody could answer the obvious question: "I asked for X, you proposed Y, I said no — why does the
-- current plan say Z?" On production that is 29 items and roughly 40 vanished plan versions today,
-- including one item that went six rounds.
--
-- One row per plan version. The OUTCOME is recorded on the revision it ended, not on a separate row,
-- because "plan v2 was contested with these words" is one fact and splitting it across two rows invites
-- them to disagree. A revision with a NULL outcome is the live one.
CREATE TABLE "feedback_plan_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feedback_request_id" uuid NOT NULL,
	-- Mirrors feedback_request.plan_revision at the moment this version was drafted, so the two can be
	-- reconciled and a gap (a version that predates this table) is visible rather than silently absent.
	"revision" integer NOT NULL,
	"plan" text NOT NULL,
	"plan_model" text,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- When the reporter approved this version. SEPARATE from `outcome` on purpose: approval does not END
	-- a plan version, it is the go-ahead to build it, and the version stays live until something actually
	-- replaces it. Folding approval into `outcome` left a shipped-then-refuted plan with nowhere to record
	-- the refutation — the version was already closed as `approved`, and the reporter's post-deploy words
	-- had nothing to attach to.
	"approved_at" timestamp with time zone,
	-- How this version ENDED. NULL = it is still the current plan (whether or not it has been approved).
	--   contested  — the reporter pushed back before it was built; outcome_reason carries their words
	--   refuted    — shipped, then judged below standard after deployment (ADR-0051)
	--   superseded — replaced by a newer plan without an explicit push-back (an operator re-plan)
	"outcome" text,
	-- The reporter's own words. NULL for `superseded`, which carries no message — a silent operator
	-- re-plan has no reporter input to record.
	"outcome_reason" text,
	"outcome_at" timestamp with time zone,
	CONSTRAINT "feedback_plan_revision_outcome_ck" CHECK (
		"outcome" IS NULL OR "outcome" IN ('contested', 'refuted', 'superseded')
	),
	-- An outcome and its timestamp travel together; either both or neither.
	CONSTRAINT "feedback_plan_revision_outcome_at_ck" CHECK (
		("outcome" IS NULL) = ("outcome_at" IS NULL)
	)
);--> statement-breakpoint

ALTER TABLE "feedback_plan_revision" ADD CONSTRAINT "feedback_plan_revision_feedback_request_id_fk"
	FOREIGN KEY ("feedback_request_id") REFERENCES "public"."feedback_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One row per (item, revision). Makes the backfill and every future write idempotent, and makes a
-- duplicate revision a loud error rather than two competing versions of the same history.
CREATE UNIQUE INDEX "feedback_plan_revision_uq" ON "feedback_plan_revision" USING btree ("feedback_request_id","revision");--> statement-breakpoint
CREATE INDEX "feedback_plan_revision_item_idx" ON "feedback_plan_revision" USING btree ("tenant_id","feedback_request_id","revision");--> statement-breakpoint

ALTER TABLE feedback_plan_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- APPEND-AND-CLOSE-ONCE, not read-only.
--
-- The in-app services (approve / contest / re-plan) run as ai_hr_app through withTenant, so a SELECT-only
-- grant would simply stop the reporter's own actions from ever being recorded — the history would only
-- capture what the operator CLI did. But a history the app can freely rewrite is not a history either.
--
-- So the app gets exactly two powers, and no more:
--   INSERT — a new revision, always born LIVE (outcome IS NULL). It cannot fabricate a closed one.
--   UPDATE — close a revision that is still open. USING (outcome IS NULL) makes that ONE-WAY: once a
--            row carries an outcome it matches no UPDATE policy again, so a recorded objection cannot be
--            overwritten, blanked, or re-labelled. This is the property that failed before.
-- DELETE is granted to nobody and has no policy. (Both matter: Postgres authorises DELETE from USING
-- alone, so an absent policy is itself the block, and the REVOKE is the belt to that braces.)
GRANT SELECT, INSERT, UPDATE ON feedback_plan_revision TO ai_hr_app;--> statement-breakpoint
REVOKE DELETE ON feedback_plan_revision FROM ai_hr_app;--> statement-breakpoint

CREATE POLICY feedback_plan_revision_read ON feedback_plan_revision FOR SELECT
	USING (
		tenant_id = app.current_tenant_id()
		AND EXISTS (
			SELECT 1 FROM feedback_request fr
			WHERE fr.id = feedback_plan_revision.feedback_request_id
			  AND fr.tenant_id = app.current_tenant_id()
			  AND app.can_see_employment(fr.reporter_employment_id)
		)
	);--> statement-breakpoint

CREATE POLICY feedback_plan_revision_append ON feedback_plan_revision FOR INSERT
	WITH CHECK (
		tenant_id = app.current_tenant_id()
		AND outcome IS NULL           -- born live; a closed revision can only be reached by closing it
		AND EXISTS (
			SELECT 1 FROM feedback_request fr
			WHERE fr.id = feedback_plan_revision.feedback_request_id
			  AND fr.tenant_id = app.current_tenant_id()
			  AND app.can_see_employment(fr.reporter_employment_id)
		)
	);--> statement-breakpoint

-- Two legal edits to a LIVE revision, and nothing else: stamp its approval, or close it. USING pins both
-- to `outcome IS NULL`, so a closed revision matches no UPDATE policy ever again — a recorded objection
-- cannot be softened, blanked or re-labelled. WITH CHECK deliberately does NOT require an outcome, since
-- approving leaves the version live.
CREATE POLICY feedback_plan_revision_close ON feedback_plan_revision FOR UPDATE
	USING (tenant_id = app.current_tenant_id() AND outcome IS NULL)
	WITH CHECK (tenant_id = app.current_tenant_id());--> statement-breakpoint

-- RLS is row-level, so the UPDATE policy above cannot stop a close from ALSO rewriting the plan text on
-- its way past. This trigger freezes everything that is not the outcome: what was proposed, when, and
-- which item it belongs to are settled at insert and never move again.
CREATE OR REPLACE FUNCTION app.feedback_plan_revision_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.plan IS DISTINCT FROM OLD.plan
		OR NEW.revision IS DISTINCT FROM OLD.revision
		OR NEW.feedback_request_id IS DISTINCT FROM OLD.feedback_request_id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.plan_model IS DISTINCT FROM OLD.plan_model
		OR NEW.drafted_at IS DISTINCT FROM OLD.drafted_at
		OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
	THEN
		RAISE EXCEPTION 'feedback_plan_revision is append-only: only the outcome of a live revision may be set';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER feedback_plan_revision_immutable_trg
	BEFORE UPDATE ON feedback_plan_revision
	FOR EACH ROW EXECUTE FUNCTION app.feedback_plan_revision_immutable();--> statement-breakpoint

COMMENT ON TABLE "feedback_plan_revision" IS
	'One row per plan version, with the reporter''s response recorded on the version it answered. Append-and-close-once: the app may add a live revision and close it exactly once; the plan text is frozen by trigger and nothing is deletable.';
