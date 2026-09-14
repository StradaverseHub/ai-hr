-- 870b79e2 (r277) — employment gains ONE nullable column: attendance_rule_id, "the Schedule Group".
--
-- ── WHAT AND WHY ──────────────────────────────────────────────────────────────────────────────────────
-- The reporter asked for a named group that several shifts share, so lateness / early-out / overtime
-- rules are configured once rather than on every shift. That object already exists and has since
-- 88e94371: `attendance_rule` is tenant-wide, carries name + description, holds the whole rule set and is
-- selected by `shift.rule_id`. Only the sidebar's label hid it. What genuinely did NOT exist is the first
-- leg of their Employee → Group → Shift chain: a way to put a PERSON in a group. This column is that leg,
-- and it is the only new storage in the item.
--
-- ── NULLABLE, NO BACKFILL, NO DEFAULT — THE RELEASE-DAY PROMISE IS "NOTHING MOVES" ────────────────────
-- Rule resolution in core/attendance.ts scheduleFor becomes ADDITIVE: employment.attendance_rule_id, else
-- shift.rule_id, else the tenant's is_default ("Standard") rule. Every row ships NULL, so the first
-- branch never fires and every employee resolves exactly the rule they resolve today — no attendance
-- figure, no overtime minute and no payroll number moves on the day this ships. Assigning a group is an
-- explicit administrator action, one employee at a time.
--
-- ── NO CHECK CONSTRAINT, DELIBERATELY (CLAUDE.md §6) ──────────────────────────────────────────────────
-- The rule this column introduces is "an employee may only be put on a shift their group allows". That is
-- enforced in the SERVICES that decide — core/roster.ts assignEmployeeShift / assignShift /
-- assignShiftBulk and core/shift-arrangement.ts assignEmployeeShiftDated — and not in the database,
-- because a NOT VALID check still fires on every UPDATE and would then reject writes from paths that have
-- nothing to do with shifts (erasure sweeps, terminations, the personnel profile). The column stays
-- permissive; the refusal lives where it can name the allowed shifts.
--
-- ── NO GRANT, NO POLICY CHANGE ────────────────────────────────────────────────────────────────────────
-- Nothing is CREATEd here: a column on an existing table inherits `employment`'s grants and its RLS
-- policies, which govern by row and not by column. ON DELETE SET NULL mirrors payroll_policy_id and
-- holiday_group_id on this same table, so deleting a Schedule Group can never raise an FK error — the
-- affected employees simply fall back to their shift's own rule.
--
-- ⚠️ NUMBERING. This is 0464, NOT 0380 as the round's brief allocated. The journal holds 379 ENTRIES but
-- its last idx is 463 (tag 0463_recalc_audit_grade_and_effective_date) — the count and the number have
-- not matched for a long time, and 0380_replacement_leave_config.sql already exists and is applied.
-- A 0380 written now would carry a `when` below drizzle's watermark and be a SILENT SKIP, exit 0.
--
-- Journal entry: idx 464 (see meta/_journal.json).

DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM employment;
  RAISE NOTICE '0464 employment.attendance_rule_id added (nullable, no backfill): all % employments keep a NULL Schedule Group, i.e. every one of them still resolves its attendance rule from shift.rule_id / the tenant Standard rule, exactly as before.', total;
END $$;
--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "attendance_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "employment" ADD CONSTRAINT "employment_attendance_rule_id_attendance_rule_id_fk" FOREIGN KEY ("attendance_rule_id") REFERENCES "public"."attendance_rule"("id") ON DELETE set null ON UPDATE no action;
