-- Item 2108c01f (completion) — give the pay_period immutability guard a controlled unlock escape hatch,
-- mirroring what migration 0173 did for the payroll_batch guard (app.unlock_batch).
--
-- Background: closeBatch cascades the parent pay_period to 'closed' once all its runs are closed. The
-- guard_closed_pay_period trigger (migration 0067) then blocks ANY update/delete on a closed period with no
-- escape. unlockClosedBatch (Closed->Processed) must reopen that period to allow a correction re-run — but the
-- period update was being rejected ("pay period is closed and immutable"), so the whole reopen rolled back.
-- This makes the reopen feature non-functional the moment PAYROLL_UNLOCK_ENABLED=true.
--
-- Fix: honour a transaction-local GUC app.unlock_pay_period holding the id of the period being deliberately
-- reopened (set via set_config(..., true) in core/payroll.ts unlockClosedBatch, cleared at COMMIT). Everything
-- else stays immutable. Idempotent: CREATE OR REPLACE only redefines the function; the trigger is unchanged.
CREATE OR REPLACE FUNCTION app.guard_closed_pay_period() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    IF TG_OP = 'UPDATE' AND current_setting('app.unlock_pay_period', true) = OLD.id::text THEN
      RETURN NEW; -- controlled unlock (see core/payroll.ts unlockClosedBatch)
    END IF;
    RAISE EXCEPTION 'pay period % is closed and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
