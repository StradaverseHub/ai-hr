-- Closed-payroll immutability (ADR-0001 financial-record integrity).
-- Once a payroll_batch is 'closed', neither the batch nor its payslips may be
-- updated or deleted — enforced by triggers so it holds even for admins / direct SQL,
-- not just the application layer.

CREATE OR REPLACE FUNCTION app.guard_closed_batch() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'payroll batch % is closed and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.guard_closed_payslip() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = OLD.batch_id AND b.status = 'closed') THEN
    RAISE EXCEPTION 'payslip % is immutable: payroll batch % is closed', OLD.id, OLD.batch_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER batch_immutable_when_closed
  BEFORE UPDATE OR DELETE ON payroll_batch
  FOR EACH ROW EXECUTE FUNCTION app.guard_closed_batch();
--> statement-breakpoint
CREATE TRIGGER payslip_immutable_when_closed
  BEFORE UPDATE OR DELETE ON payslip
  FOR EACH ROW EXECUTE FUNCTION app.guard_closed_payslip();
