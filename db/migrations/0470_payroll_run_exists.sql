-- r300 (3fb1a611 Leave Credit) — "has payroll for these months been started ANYWHERE in this tenant?"
--
-- WHY A FUNCTION. HR adds and reverses Leave Credits. On a date with recorded overtime a credit and that day's
-- overtime pay are mutually exclusive, but payroll only honours that at PREFILL time: overtime_amount is a
-- per-batch aggregate, a re-run prefill never zeroes a stale figure, a processed run is not re-prefilled and a
-- closed one cannot be written. The r300 verifier measured all three shapes paying the day twice or not at all.
-- So the service refuses those two actions while ANY payroll run exists for the date's month or the next —
-- draft included, any company in the tenant (overtime follows the company that employed the person on the day,
-- and a transferred employee's old company is not the one on their record).
--
-- payroll_batch RLS (0099) shows a run only to an admin FOR ITS COMPANY, so a company-scoped admin asking under
-- RLS would see "no run" in a sister company and wave the credit through. This SECURITY DEFINER function answers
-- ONE yes/no question for the caller's own tenant and returns nothing else — no ids, statuses or companies.
CREATE OR REPLACE FUNCTION app.payroll_run_exists_for_periods(p_periods text[])
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM payroll_batch b
     WHERE b.tenant_id = app.current_tenant_id()
       AND b.pay_period = ANY (p_periods)
  );
$$;--> statement-breakpoint

-- production's ALTER DEFAULT PRIVILEGES does not cover functions (0433): without this the first call through
-- ai_hr_app throws `permission denied for function`.
GRANT EXECUTE ON FUNCTION app.payroll_run_exists_for_periods(text[]) TO ai_hr_app;
