-- Basic Salary redesign (7c7c2f80) — security prerequisite, shipped BEFORE any delete UI exists.
--
-- 1) DELETE gap. The compensation policy (latest def 0099) is FOR ALL: Postgres applies its WITH CHECK
--    to INSERT/UPDATE only, so DELETE was gated by USING alone — which passes for a payroll partner and
--    even for THE EMPLOYEE THEMSELVES (the self-read branch). DELETE is granted to ai_hr_app since 0004.
--    Not reachable today (no delete path exists anywhere in the product), but the moment one is added
--    the gap activates. A RESTRICTIVE policy ANDs with the permissive one, so hard DELETE now requires
--    the admin branch specifically. The app itself never issues DELETE — removal is a soft delete
--    (superseded_at) via UPDATE, which the FOR ALL policy's WITH CHECK already restricts to
--    admin / perf-comp partner.
CREATE POLICY compensation_delete_admin ON compensation AS RESTRICTIVE FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
--> statement-breakpoint

-- 2) Closed-period integrity backstop (mirrors 0011's guard_closed_batch pattern). Payslips snapshot the
--    figure but carry NO FK to compensation, so removing a salary record that a CLOSED payroll run relied
--    on would leave the paid amount unexplainable for audit — and regeneration paths recompute from the
--    CURRENT OPEN row, so a removal that reopens an older record would silently repay the OLD salary.
--    Guard: a compensation row whose [valid_from, valid_to) window overlaps a CLOSED batch's pay period
--    (for the same employment, evidenced by a payslip in that batch) can be neither hard-DELETEd nor
--    newly superseded (soft-deleted). Fires row-level so it holds for admins / direct SQL, not just the
--    service layer (which raises the same rule with a friendlier message first).
CREATE OR REPLACE FUNCTION app.guard_comp_closed_period() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Only removal is guarded: DELETE always; UPDATE only when the row is being NEWLY superseded.
  -- Ordinary updates (amount/remarks/date edits, the CLOSE step of a new revision) pass through.
  IF TG_OP = 'UPDATE' AND (NEW.superseded_at IS NULL OR OLD.superseded_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM payslip p
    JOIN payroll_batch b ON b.id = p.batch_id
    WHERE p.employment_id = OLD.employment_id
      AND b.status = 'closed'
      AND daterange(
            to_date(b.pay_period, 'YYYY-MM'),
            (to_date(b.pay_period, 'YYYY-MM') + interval '1 month')::date,
            '[)'
          ) && daterange(OLD.valid_from, OLD.valid_to, '[)')
  ) THEN
    RAISE EXCEPTION 'compensation record % overlaps a closed payroll period and cannot be removed', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER compensation_guard_closed_period
  BEFORE UPDATE OR DELETE ON compensation
  FOR EACH ROW EXECUTE FUNCTION app.guard_comp_closed_period();
