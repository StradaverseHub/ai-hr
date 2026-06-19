-- Wave 2C (ADR-0024) — RLS + closed-period immutability for the pay_period parent.
-- Mirrors the payroll_batch grants/policies (0010 + 0013) and the closed-batch immutability
-- triggers (0011), one level up: the statutory month becomes a first-class, governed entity.

GRANT SELECT, INSERT, UPDATE, DELETE ON pay_period TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE pay_period ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Read: admins, OR a principal who can see a payslip in any child run of the period (so the
-- employee self-service portal can resolve its own period). Writes: admin-only.
-- (Same shape as payroll_batch_rls, joined through the child runs.)
CREATE POLICY pay_period_rls ON pay_period FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR EXISTS (
        SELECT 1
        FROM payroll_batch b
        JOIN payslip ps ON ps.batch_id = b.id
        WHERE b.pay_period_id = pay_period.id
          AND app.can_see_employment(ps.employment_id)
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- Closed-period immutability (ADR-0001 financial-record integrity): once a pay_period is 'closed'
-- it can be neither updated nor deleted — enforced by a trigger so it holds even for admins / direct
-- SQL, exactly like the closed-batch guard (0011). Individual closed runs stay protected by 0011.
CREATE OR REPLACE FUNCTION app.guard_closed_pay_period() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'pay period % is closed and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pay_period_immutable_when_closed
  BEFORE UPDATE OR DELETE ON pay_period
  FOR EACH ROW EXECUTE FUNCTION app.guard_closed_pay_period();
