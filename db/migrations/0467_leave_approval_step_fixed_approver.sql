-- r293 phase 3 — leave_approval_step gains ONE nullable column: approver_employment_id, the NAMED person
-- a fixed approval step belongs to.
--
-- ── WHY A MIGRATION AT ALL, WHEN THE TEMPLATE NEEDED NONE ─────────────────────────────────────────────
-- `leave_approval_template.levels` is jsonb, so the new `specific_employee` level carries its employment
-- id inside the existing column and the template needed no schema change (a dynamic level is still
-- written back as a bare string, so every row saved before r293 round-trips byte-identically).
--
-- THE GENERATED STEP IS THE PART THAT HAD NOWHERE TO PUT IT. `leave_approval_step` is the per-request
-- SNAPSHOT — the chain is materialised onto the request at submission and never re-resolved (ADR-0071
-- 1(g)), which is exactly what lets a template be edited without disturbing leave in flight. Its only
-- description of an approver was `approver_kind` text. Every kind before this one resolves a RELATIONSHIP
-- at decision time from that kind alone; a fixed approver cannot, so without this column the snapshot
-- would have to re-read the template to find out who the step is for — and a step that re-reads the
-- template is precisely the in-flight guarantee undone.
--
-- Encoding the id inside `approver_kind` ('specific_employee:<uuid>') was the alternative and is rejected:
-- every switch on that column, every event payload and every index would have had to learn to split a
-- string, and the column would stop being the vocabulary it is named for.
--
-- ── NULLABLE, NO BACKFILL, NO DEFAULT ────────────────────────────────────────────────────────────────
-- Non-null for exactly the fixed-kind steps, which cannot exist before this ships. Every row already in
-- the table keeps NULL and every one of them still routes on `approver_kind` alone, exactly as today —
-- no pending approval moves, no decider changes, no request advances or stalls differently on the day
-- this is applied.
--
-- ── NO CHECK CONSTRAINT, DELIBERATELY (CLAUDE.md §6) ─────────────────────────────────────────────────
-- The rule is "approver_employment_id is set iff approver_kind is a FIXED kind". It is enforced in the
-- service that decides — core/leave.ts generateApprovalSteps writes the pair together from one sanitised
-- level, and lib/leave-approval-kinds.ts sanitizeApprovalLevels drops a fixed level with nobody named so
-- one can never be saved. It is NOT a database check because a NOT VALID check still fires on every
-- UPDATE of this table, and the writers include `decideLeave`'s status/decided_by updates and the
-- delete-and-regenerate path in the leave-cancellation flow: a constraint here would reject writes that
-- have nothing to do with which kind a step is.
--
-- ── NO GRANT, NO POLICY CHANGE ───────────────────────────────────────────────────────────────────────
-- Nothing is CREATEd: a column on an existing table inherits `leave_approval_step`'s grants, and its RLS
-- policy governs by ROW (can_see_employment on subject_employment_id), not by column. ON DELETE no action
-- matches `decided_by_employment_id` on this same table — an employment that is an approver is never hard
-- deleted in this product, and an FK error would be the right outcome if one ever were.
--
-- ⚠️ NUMBERING. This is 0467, allocated from max(idx) = 466, NOT from entries.length = 382. The two have
-- diverged for a long time (see 0464's note); a migration numbered 0383 would carry a `when` below
-- drizzle's watermark and be a SILENT SKIP at exit 0.
--
-- Journal entry: idx 467 (see meta/_journal.json).

DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM leave_approval_step;
  RAISE NOTICE '0467 leave_approval_step.approver_employment_id added (nullable, no backfill): all % existing steps keep NULL, i.e. every one still routes on approver_kind alone exactly as before.', total;
END $$;
--> statement-breakpoint
ALTER TABLE "leave_approval_step" ADD COLUMN "approver_employment_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_approval_step" ADD CONSTRAINT "leave_approval_step_approver_employment_id_employment_id_fk" FOREIGN KEY ("approver_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;
