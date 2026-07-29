-- The loop asks a question the product cannot receive an answer to.
--
-- WHAT IS BROKEN. `blocked` (0317) means "the plan is agreed, but an input only the REPORTER can supply
-- is missing". Most blocks name another item (`blocked_by_id`) and the board links to it. But when the
-- block is a free-text QUESTION — "which statutory submission channels and file formats do you use?" —
-- `blocked_reason` renders it on the item and there the loop stops: the detail page has a review box for
-- `planned`, a refute box for `deployed`, a restore button for `cancelled`, and NOTHING for `blocked`.
-- The reporter reads the question and has no way to reply. Item 956cec85 has been sitting in exactly that
-- state. It is the same defect class as "approve carries no payload", which once left an item unbuilt for
-- three rounds: a state the product can enter and the user cannot leave.
--
-- WHY A TABLE AND NOT A COLUMN. The obvious fix — an `blocked_answer` column on feedback_request — dies
-- on the same rock that made 0318 necessary. `unblockFeedback` CLEARS `blocked_reason` and `blocked_by_id`
-- on the way out (deliberately: they describe a CURRENT wait, and a stale one keeps rendering "waiting
-- on…" on a queued item). So an answer kept beside them is either cleared with them, or survives as a
-- reply with the question deleted — an answer to nothing. Keeping it only in the `feedback.unblocked`
-- event payload is no better: the build agents read items through scripts/improve/remote.ts, which selects
-- feedback_request COLUMNS and never touches domain_event, so an event-only answer would be invisible to
-- the one reader that has to act on it.
--
-- One row per BLOCK EPISODE, therefore: the question, who it was asked about, when — and the answer plus
-- the moment the episode ended, written once on resolve. Q and A stay together, an item may be blocked
-- more than once without either round overwriting the other, and both live in a table the loop can select.
--
-- Follows feedback_plan_revision (0318) deliberately, down to the RLS shape: append, close ONCE, never
-- delete, never rewrite. That table exists because this project already destroyed a negotiation by
-- overwriting it in place; doing the same thing one layer down would be the same bug in a new coat.
CREATE TABLE IF NOT EXISTS "feedback_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feedback_request_id" uuid NOT NULL,
	-- The question, in the words it was asked in. Copied from feedback_request.blocked_reason at block
	-- time rather than referenced, because that column is cleared on unblock — the copy is the whole point.
	"question" text NOT NULL,
	-- What the item was waiting on, snapshotted. Also cleared from feedback_request on unblock, and
	-- "we were waiting on the rounding decision" is part of reading the episode back.
	"blocked_by_id" uuid,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The reporter's reply, in their own words. NULL on an episode that ended without one — an operator
	-- may unblock because the question stopped mattering, and inventing an answer there would be a lie in
	-- the same place 0318 was told.
	"answer" text,
	"answered_by_user_id" uuid,
	-- When this episode ENDED (the item returned to the build queue). NULL = still waiting.
	--
	-- There is deliberately no separate `answered_at`: an answer is what ends the block, so the two would
	-- be the same instant on every row, and two timestamps that can never legitimately differ are two
	-- chances for the history to contradict itself.
	"resolved_at" timestamp with time zone,
	-- An answer always ends the episode. Without this an answer could be recorded on a still-open block,
	-- and since closure is one-way (see the UPDATE policy below) that row could never then be closed.
	CONSTRAINT "feedback_block_answer_resolves_ck" CHECK ("answer" IS NULL OR "resolved_at" IS NOT NULL),
	-- Whitespace is not an answer, and it is not a question either. The services trim and refuse blanks;
	-- this is the same rule where nothing can route around it.
	CONSTRAINT "feedback_block_question_not_blank_ck" CHECK (btrim("question") <> ''),
	CONSTRAINT "feedback_block_answer_not_blank_ck" CHECK ("answer" IS NULL OR btrim("answer") <> ''),
	-- Someone can only be recorded as the answerer of an answer that exists.
	CONSTRAINT "feedback_block_answered_by_ck" CHECK ("answered_by_user_id" IS NULL OR "answer" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "feedback_block" ADD CONSTRAINT "feedback_block_feedback_request_id_fk"
	FOREIGN KEY ("feedback_request_id") REFERENCES "public"."feedback_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- SET NULL, not cascade: if the blocking item ever went away, the episode and its answer are still the
-- record of what happened here and must not disappear with it.
ALTER TABLE "feedback_block" ADD CONSTRAINT "feedback_block_blocked_by_id_fk"
	FOREIGN KEY ("blocked_by_id") REFERENCES "public"."feedback_request"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "feedback_block" ADD CONSTRAINT "feedback_block_answered_by_user_id_fk"
	FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- At most ONE open episode per item. An item cannot be waiting on two questions at once (blockFeedback
-- only accepts `approved`, so the service already cannot produce it), and the index is what makes that
-- true for the operator SQL path as well — otherwise a re-block would leave two open episodes and the
-- reporter's answer would close an arbitrary one of them.
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_block_open_uq" ON "feedback_block" USING btree ("feedback_request_id") WHERE "resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_block_item_idx" ON "feedback_block" USING btree ("tenant_id","feedback_request_id","asked_at");--> statement-breakpoint

ALTER TABLE feedback_block ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- APPEND-AND-CLOSE-ONCE, and NOT read-only.
--
-- 0318's first cut granted SELECT only, reasoning that "the services write as owner". They do not: the
-- in-app services run as ai_hr_app through withTenant, so a read-only grant would have recorded exactly
-- nothing while appearing to work. THE WHOLE POINT of this migration is a write the REPORTER makes in the
-- app — if the grant is wrong here, the answer box silently does nothing, which is worse than the defect
-- it replaces. The powers granted are exactly:
--   INSERT — a new episode, always born OPEN (resolved_at IS NULL, answer IS NULL). The app cannot
--            fabricate an already-answered block.
--   UPDATE — answer an episode that is still open. USING (resolved_at IS NULL) makes that ONE-WAY: once
--            resolved, the row matches no UPDATE policy again, so a recorded answer cannot be
--            overwritten, blanked, or re-attributed.
-- DELETE goes to nobody and has no policy. Both halves matter: Postgres authorises DELETE from USING
-- alone, so the absent policy is itself the block, and the REVOKE is the belt to that braces.
GRANT SELECT, INSERT, UPDATE ON feedback_block TO ai_hr_app;--> statement-breakpoint
REVOKE DELETE ON feedback_block FROM ai_hr_app;--> statement-breakpoint

CREATE POLICY feedback_block_read ON feedback_block FOR SELECT
	USING (
		tenant_id = app.current_tenant_id()
		AND EXISTS (
			SELECT 1 FROM feedback_request fr
			WHERE fr.id = feedback_block.feedback_request_id
			  AND fr.tenant_id = app.current_tenant_id()
			  AND app.can_see_employment(fr.reporter_employment_id)
		)
	);--> statement-breakpoint

CREATE POLICY feedback_block_append ON feedback_block FOR INSERT
	WITH CHECK (
		tenant_id = app.current_tenant_id()
		AND resolved_at IS NULL          -- born open; an answered episode is only reachable by answering one
		AND answer IS NULL
		AND EXISTS (
			SELECT 1 FROM feedback_request fr
			WHERE fr.id = feedback_block.feedback_request_id
			  AND fr.tenant_id = app.current_tenant_id()
			  AND app.can_see_employment(fr.reporter_employment_id)
		)
	);--> statement-breakpoint

-- The ONE legal edit: end an open episode. WITH CHECK requires resolved_at to be set, so an UPDATE that
-- merely edits an open episode in place — rewording the question, say — matches nothing and is refused.
-- Unlike 0318's plan revisions there is no second legal edit here: nothing about a block changes except
-- its ending.
CREATE POLICY feedback_block_resolve ON feedback_block FOR UPDATE
	USING (tenant_id = app.current_tenant_id() AND resolved_at IS NULL)
	WITH CHECK (tenant_id = app.current_tenant_id() AND resolved_at IS NOT NULL);--> statement-breakpoint

-- RLS is ROW-level: the policy above decides which rows an UPDATE may touch, not which COLUMNS it may
-- change. Nothing there stops a resolve from rewriting the question on its way past — which is precisely
-- how the plan history was destroyed before 0318. This trigger freezes the asked half of the episode, and
-- additionally refuses ANY update to an already-resolved row, so the one-way property holds even for the
-- owner role (the operator CLI and migrations bypass RLS entirely, and they write here too).
CREATE OR REPLACE FUNCTION app.feedback_block_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.resolved_at IS NOT NULL THEN
		RAISE EXCEPTION 'feedback_block is append-only: a resolved block episode cannot be changed';
	END IF;
	IF NEW.question IS DISTINCT FROM OLD.question
		OR NEW.asked_at IS DISTINCT FROM OLD.asked_at
		OR NEW.blocked_by_id IS DISTINCT FROM OLD.blocked_by_id
		OR NEW.feedback_request_id IS DISTINCT FROM OLD.feedback_request_id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
	THEN
		RAISE EXCEPTION 'feedback_block is append-only: only the answer and resolution of an open episode may be set';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER feedback_block_immutable_trg
	BEFORE UPDATE ON feedback_block
	FOR EACH ROW EXECUTE FUNCTION app.feedback_block_immutable();--> statement-breakpoint

-- BACKFILL — the items that are blocked RIGHT NOW.
--
-- Without this, every currently-parked item (956cec85 among them) would have no episode for the reporter's
-- answer to close, and the new answer box would depend on a fallback path on its first and most important
-- day. The question text is `blocked_reason` — the only place it survives — and `asked_at` comes from the
-- feedback.blocked event that parked it, so the trail shows when the wait actually started rather than
-- when this migration ran. Items with no such event fall back to updated_at, which is the closest honest
-- approximation available; nothing is invented where nothing survived.
--
-- `status::text = 'blocked'` AND NOT `status = 'blocked'`, and this is a Postgres constraint rather than a
-- style choice. 0317 added 'blocked' to the feedback_status enum and said so in its own header: a value
-- added to an enum cannot be USED in the transaction that added it (SQLSTATE 55P04). On a server that took
-- 0317 long ago the two are indistinguishable — but drizzle-kit replays the WHOLE chain in ONE transaction
-- when it builds a database from scratch, so there 0317 and this backfill share a transaction and the enum
-- literal is rejected. That is not a test-only concern: it is every fresh deployment. Comparing the
-- column's text never parses a literal into the enum type, so it is safe in both worlds.
INSERT INTO feedback_block (tenant_id, feedback_request_id, question, blocked_by_id, asked_at)
SELECT fr.tenant_id,
       fr.id,
       fr.blocked_reason,
       fr.blocked_by_id,
       COALESCE(
         (SELECT max(de.occurred_at) FROM domain_event de
           WHERE de.aggregate_type = 'feedback'
             AND de.aggregate_id = fr.id
             AND de.event_type = 'feedback.blocked'),
         fr.updated_at
       )
  FROM feedback_request fr
 WHERE fr.status::text = 'blocked'
   AND btrim(COALESCE(fr.blocked_reason, '')) <> ''
ON CONFLICT DO NOTHING;--> statement-breakpoint

COMMENT ON TABLE "feedback_block" IS
	'One row per block episode: the question that parked an approved item, and the reporter''s answer recorded on the same row when it was released. Append-and-close-once — the app may open an episode and resolve it exactly once; the question is frozen by trigger and nothing is deletable. Exists because feedback_request.blocked_reason is cleared on unblock, so an answer stored beside it would outlive its own question.';--> statement-breakpoint

COMMENT ON COLUMN "feedback_block"."answer" IS
	'The reporter''s reply, in their words. NULL where an episode ended without one (an operator unblock with no note) — never a placeholder.';
