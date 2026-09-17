-- r301 (board 83511d3b, "Cancel Approved Leave") — per-leave-type control over an employee cancelling
-- APPROVED leave, and a cancellation that re-runs the ORIGINAL request's approval chain.
--
-- ── 1 · FOUR COLUMNS ON leave_type ───────────────────────────────────────────────────────────────────
--   employee_cancel_approved  may an employee ask to cancel approved leave of this type at all
--   cancel_notice_days        how many calendar days before EACH leave date the request must be made
--                             (0 = today's rule: any date strictly after the tenant-local today)
--   cancel_auto_approve       false = the approvers re-approve (today); true = approved by the system
--   cancel_notify             tell the current approver + HR admins when a cancellation is requested
--
-- EXISTING TYPES KEEP TODAY'S BEHAVIOUR; NEW TYPES START SWITCHED OFF (the reporter's decision, stated in
-- the approved plan). Done WITHOUT an UPDATE: the column is added with DEFAULT true — Postgres records that
-- as the value every EXISTING row reads (a catalogue entry, no row rewrite) — and the default is then moved
-- to false, which changes only rows inserted from now on. An UPDATE of every leave_type row would instead
-- re-check every constraint on the table against every row (CLAUDE.md §6), for no gain.
--
-- WHO WRITES leave_type (listed before adding columns, §6): core/admin.ts createLeaveType (now writes
-- employee_cancel_approved = false explicitly) and updateLeaveType (the new card's tri-state), the MY pack's
-- seedReferenceDataMY (tenant provisioning + db/seed.ts), core/toil.ts ensureReplacementLeaveType,
-- core/admin.ts archive/delete/role writers, core/entitlement-template.ts, scripts/archive-duplicate-
-- replacement-leave-type.ts. Every inserter that names no value gets the new default (OFF), which is what
-- "types created from now on" means; no updater touches these columns except updateLeaveType.
--
-- NO CHECK CONSTRAINT. cancel_notice_days >= 0 is validated in updateLeaveType, the one writer; a NOT VALID
-- check would still fire on every UPDATE of leave_type, including writes that never touch these columns.
-- NOT NULL with a default, like allow_unpaid_leave / allow_negative_balance on the same table.
--
-- ── 2 · leave_cancellation_step — THE CANCELLATION'S OWN COPY OF THE APPROVAL CHAIN ─────────────────
-- A mirror of leave_approval_step (0085, 0467, 0468): one row per LEVEL, written when the cancellation is
-- requested by COPYING the original request's steps (kind, named approver, alternates, order). A copy, not
-- a pointer, for the reason leave_approval_step is itself a snapshot: the chain a cancellation walks must
-- not change under it, and the original request's steps are already decided (approved) — they cannot be
-- walked a second time. A split survivor has no steps of its own; the service traces it back through
-- leave-request.split's splitFromRequestId to the request that does. No rows = a single-level chain,
-- decided exactly as a cancellation is decided today.
--
-- status reuses leave_request_status (pending/approved/rejected/cancelled), as leave_approval_step does.
-- The kind/approver pairing is enforced in the service that writes it (core/leave.ts), not in a CHECK —
-- the same reasoning 0467 gives for leave_approval_step: a check here fires on every decide.
--
-- RLS: the PARENT leave_cancellation_request's policy (tenant + can_see_employment), keyed on
-- subject_employment_id — NOT leave_approval_step's, whose delegation branch would show a delegate the levels
-- of a cancellation they cannot read (the parent has never had one). GRANT to ai_hr_app (§6).
--
-- ⚠️ NUMBERING. 0471, allocated centrally (journal max idx 470 on the base, main@769e6d9a).
--
-- Rollback:
--   DROP TABLE leave_cancellation_step;
--   ALTER TABLE leave_type DROP COLUMN employee_cancel_approved, DROP COLUMN cancel_notice_days,
--     DROP COLUMN cancel_auto_approve, DROP COLUMN cancel_notify;

DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM leave_type;
  RAISE NOTICE '0471 leave_type: all % existing leave types keep employee cancellation of approved leave ON, no notice, re-approval required, no notification; types created from now on start OFF.', total;
END $$;
--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "employee_cancel_approved" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "leave_type" ALTER COLUMN "employee_cancel_approved" SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "cancel_notice_days" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "cancel_auto_approve" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "cancel_notify" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "leave_cancellation_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cancellation_request_id" uuid NOT NULL,
	"subject_employment_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"approver_kind" text NOT NULL,
	"approver_employment_id" uuid,
	"approver_alternates" jsonb,
	"status" "leave_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by_employment_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_cancellation_step" ADD CONSTRAINT "leave_cancellation_step_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_cancellation_step" ADD CONSTRAINT "leave_cancellation_step_cancellation_request_id_fk" FOREIGN KEY ("cancellation_request_id") REFERENCES "public"."leave_cancellation_request"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_cancellation_step" ADD CONSTRAINT "leave_cancellation_step_subject_employment_id_employment_id_fk" FOREIGN KEY ("subject_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_cancellation_step" ADD CONSTRAINT "leave_cancellation_step_approver_employment_id_employment_id_fk" FOREIGN KEY ("approver_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "leave_cancellation_step" ADD CONSTRAINT "leave_cancellation_step_decided_by_employment_id_fk" FOREIGN KEY ("decided_by_employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "leave_cancellation_step_request_idx" ON "leave_cancellation_step" USING btree ("cancellation_request_id", "step_index");
--> statement-breakpoint
ALTER TABLE leave_cancellation_step ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_cancellation_step TO ai_hr_app;
--> statement-breakpoint
-- The PARENT's visibility, exactly (0132 leave_cancellation_request_rls): a step is readable only by someone who
-- can read the cancellation it belongs to. A delegation branch here (as leave_approval_step has) would let a
-- delegate read the levels of a cancellation the parent's policy hides from them (verifier, r301).
CREATE POLICY leave_cancellation_step_rls ON leave_cancellation_step FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(subject_employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(subject_employment_id));
