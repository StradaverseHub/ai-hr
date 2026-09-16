-- r293 phase 4 — leave_approval_step gains ONE nullable column: approver_alternates, the OTHER approvers
-- who may clear this step. Any-one approval ("Sarah OR Ahmad at level 2").
--
-- ── WHY THE STEP AND NOT THE TEMPLATE, AGAIN ─────────────────────────────────────────────────────────
-- The alternates live inside `leave_approval_template.levels` (jsonb) and needed no schema change there.
-- This is the SNAPSHOT, for the same reason 0467 added approver_employment_id: the chain is materialised
-- onto the request at submission and never re-resolved (ADR-0071 1(g)), which is what lets a template be
-- edited without disturbing leave in flight. A step that went back to the template to ask "who else may
-- clear me?" would undo exactly that — an edit could hand a pending request a new decider, or take one
-- away from somebody who was already looking at it.
--
-- ── WHY ONE ROW PER LEVEL, NOT ONE ROW PER APPROVER ──────────────────────────────────────────────────
-- An any-one level is ONE decision, so it is ONE row. Materialising a row per approver would put several
-- rows on the same step_index, and `decideLeave` advances "the lowest-index pending step" — the siblings
-- would sit pending forever behind an approved one, `stepCount` (core/read.ts) would count a two-approver
-- level as two steps in every leave list, and the escalation sweep's per-(group, step_index) dedup would
-- fire twice for one stall. Keeping the row count equal to the LEVEL count means every existing reader of
-- this table — the approvals inbox, the leave lists, the escalation sweep — is correct with no change.
--
-- ── SHAPE ────────────────────────────────────────────────────────────────────────────────────────────
-- A jsonb array of approvers in the same vocabulary the template stores: a bare kind string, or
-- {kind, employmentId} for a named person. NULL (not '[]') when the level has no alternates, which is
-- every level that exists today and every level an administrator does not deliberately make any-one.
--
-- ── NULLABLE, NO BACKFILL, NO DEFAULT ────────────────────────────────────────────────────────────────
-- Every row already in the table keeps NULL, and a NULL alternates list means "only the approver named on
-- this row" — byte-for-byte today's behaviour. No pending approval changes hands on the day this applies.
--
-- ── NO CHECK CONSTRAINT, NO GRANT, NO POLICY CHANGE (CLAUDE.md §6) ───────────────────────────────────
-- The shape is enforced in the service that writes it (core/leave.ts generateApprovalSteps, from one
-- sanitised level) and re-validated on read by `sanitizeApprovalLevels`, because a NOT VALID check on this
-- table fires on every UPDATE — including decideLeave's own status write. Nothing is CREATEd, so the
-- column inherits leave_approval_step's grants, and its RLS policy governs by ROW
-- (can_see_employment on subject_employment_id), not by column.
--
-- ⚠️ NUMBERING. 0468, allocated from max(idx) = 467 (this branch's own 0467), NOT from entries.length.
--
-- Journal entry: idx 468 (see meta/_journal.json).

DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM leave_approval_step;
  RAISE NOTICE '0468 leave_approval_step.approver_alternates added (nullable, no backfill): all % existing steps keep NULL, i.e. each is still clearable only by the approver named on its own row.', total;
END $$;
--> statement-breakpoint
ALTER TABLE "leave_approval_step" ADD COLUMN "approver_alternates" jsonb;
